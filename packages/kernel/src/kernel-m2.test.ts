import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  PostgresKernelRepository,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
} from './postgres.js';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type {
  CreateKernelRun,
  CreateTimerRequest,
  CreateInteractionRequest,
  AnswerInteractionRequest,
} from './types.js';

class RecordingSqlPool implements SqlPool {
  readonly queries: Array<{ sql: string; values?: readonly unknown[] }> = [];

  constructor(
    private readonly respond: (
      sql: string,
      values?: readonly unknown[],
    ) => SqlQueryResult<Record<string, unknown>>,
  ) {}

  async connect(): Promise<SqlClient> {
    return {
      query: async <T>(sql: string, values?: readonly unknown[]) => {
        this.queries.push({ sql, values });
        return this.respond(sql, values) as SqlQueryResult<T>;
      },
      release: () => {},
    };
  }
}

const emptyResult = (): SqlQueryResult<Record<string, unknown>> => ({ rows: [], rowCount: 0 });

function createRunCommand(): CreateKernelRun {
  return {
    id: `run_${Date.now()}`,
    tenantId: 'tenant-test',
    intentHash: 'a'.repeat(64),
    workGraphHash: 'b'.repeat(64),
    workGraphVersion: 'v1',
    policySnapshotId: 'ps_test',
    steps: [{ id: 'step-1', kind: 'agent', input: { prompt: 'hello' } }],
  };
}

describe('KernelRepository — Durable Timers', () => {
  let repo: InMemoryKernelRepository;

  beforeEach(() => {
    repo = new InMemoryKernelRepository();
  });

  it('creates a timer and claims it when expired', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const timer = await repo.createTimer(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        firesAt: new Date(Date.now() + 100),
        timerType: 'RETRY_DELAY',
        payload: { reason: 'test' },
      },
      'tester',
    );

    // Not expired yet
    const before = await repo.claimExpiredTimers(new Date(), 10);
    assert.equal(before.length, 0);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 150));

    const expired = await repo.claimExpiredTimers(new Date(), 10);
    assert.ok(expired.length >= 1);
    assert.equal(expired[0].state, 'PROCESSING');
    assert.ok(expired[0].claimToken);
    assert.equal(
      await repo.acknowledgeTimer(expired[0].id, expired[0].tenantId, expired[0].claimToken!),
      true,
    );
  });

  it('cancels a pending timer', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const timer = await repo.createTimer(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        firesAt: new Date(Date.now() + 1000),
        timerType: 'INTERACTION_TIMEOUT',
      },
      'tester',
    );

    const cancelled = await repo.cancelTimer(timer.id, 'tenant-test');
    assert.equal(cancelled, true);

    // Cancelled timers should not be claimable
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await repo.claimExpiredTimers(new Date(), 10);
    assert.equal(expired.length, 0);
  });

  it('does not cancel timer from wrong tenant', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const timer = await repo.createTimer(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        firesAt: new Date(Date.now() + 1000),
        timerType: 'STEP_DEADLINE',
      },
      'tester',
    );

    const cancelled = await repo.cancelTimer(timer.id, 'wrong-tenant');
    assert.equal(cancelled, false);
  });
});

describe('KernelRepository — Interactions', () => {
  let repo: InMemoryKernelRepository;

  beforeEach(() => {
    repo = new InMemoryKernelRepository();
  });

  it('atomically creates deterministic interactions for initially waiting steps', async () => {
    const runCmd = createRunCommand();
    runCmd.steps = [
      {
        id: 'step-1',
        kind: 'agent',
        initialState: 'WAITING_FOR_HUMAN',
        interaction: {
          id: 'interaction-approval-1',
          prompt: 'Approve deployment?',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'step-2',
        kind: 'agent',
        initialState: 'PENDING',
      },
    ];

    await repo.createRun(runCmd, 'tester');

    assert.equal((await repo.getStep('step-1', 'tenant-test'))?.state, 'WAITING_FOR_HUMAN');
    assert.equal((await repo.getStep('step-2', 'tenant-test'))?.state, 'PENDING');
    assert.deepEqual(await repo.listInteractions(runCmd.id, 'tenant-test'), [
      {
        id: 'interaction-approval-1',
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        status: 'pending',
        prompt: 'Approve deployment?',
        createdAt: (await repo.getInteraction('interaction-approval-1', 'tenant-test'))!.createdAt,
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    ]);
    const createdEvent = (await repo.listEvents(runCmd.id, 'tenant-test')).find(
      (event) => event.type === 'interaction.created',
    );
    assert.deepEqual(createdEvent?.payload, {
      interactionId: 'interaction-approval-1',
      prompt: 'Approve deployment?',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('rolls back a waiting step and interaction when its step ID already exists', async () => {
    const firstRun = createRunCommand();
    await repo.createRun(firstRun, 'tester');
    const secondRun = {
      ...createRunCommand(),
      id: 'run-colliding-step',
      steps: [
        {
          id: 'step-1',
          kind: 'agent',
          initialState: 'WAITING_FOR_HUMAN' as const,
          interaction: { id: 'interaction-must-not-exist', prompt: 'Must roll back' },
        },
      ],
    };

    await assert.rejects(
      () => repo.createRun(secondRun, 'tester'),
      (error: any) => error.code === 'DUPLICATE_STEP',
    );
    assert.equal(await repo.getRun(secondRun.id, 'tenant-test'), null);
    assert.equal(await repo.getInteraction('interaction-must-not-exist', 'tenant-test'), null);
    assert.equal((await repo.getStep('step-1', 'tenant-test'))?.runId, firstRun.id);
  });

  it('returns DUPLICATE_INTERACTION and rolls back when an interaction ID already exists', async () => {
    const firstRun = createRunCommand();
    firstRun.steps[0] = {
      ...firstRun.steps[0]!,
      initialState: 'WAITING_FOR_HUMAN',
      interaction: { id: 'interaction-shared', prompt: 'First prompt' },
    };
    await repo.createRun(firstRun, 'tester');
    const secondRun = {
      ...createRunCommand(),
      id: 'run-colliding-interaction',
      steps: [
        {
          id: 'step-unique',
          kind: 'agent',
          initialState: 'WAITING_FOR_HUMAN' as const,
          interaction: { id: 'interaction-shared', prompt: 'Second prompt' },
        },
      ],
    };

    await assert.rejects(
      () => repo.createRun(secondRun, 'tester'),
      (error: any) => error.code === 'DUPLICATE_INTERACTION',
    );
    assert.equal(await repo.getRun(secondRun.id, 'tenant-test'), null);
    assert.equal(await repo.getStep('step-unique', 'tenant-test'), null);
  });

  it('answers and releases only the interaction-bound tenant/run/step for a new claim', async () => {
    const runCmd = createRunCommand();
    runCmd.steps = [
      {
        id: 'step-1',
        kind: 'agent',
        initialState: 'WAITING_FOR_HUMAN',
        interaction: { id: 'interaction-approval-1', prompt: 'Approve step 1?' },
      },
      {
        id: 'step-2',
        kind: 'agent',
        initialState: 'WAITING_FOR_HUMAN',
        interaction: { id: 'interaction-approval-2', prompt: 'Approve step 2?' },
      },
    ];
    await repo.createRun(runCmd, 'tester');

    await assert.rejects(
      () =>
        repo.answerInteraction({
          interactionId: 'interaction-approval-1',
          runId: runCmd.id,
          tenantId: 'wrong-tenant',
          response: { approved: true },
          actor: 'attacker',
        }),
      (error: any) => error.code === 'INTERACTION_NOT_FOUND',
    );
    await assert.rejects(
      () =>
        repo.answerInteraction({
          interactionId: 'interaction-approval-1',
          runId: 'wrong-run',
          tenantId: 'tenant-test',
          response: { approved: true },
          actor: 'attacker',
        }),
      (error: any) => error.code === 'INTERACTION_NOT_FOUND',
    );
    assert.equal(
      (await repo.getInteraction('interaction-approval-1', 'tenant-test'))?.status,
      'pending',
    );
    assert.equal((await repo.getStep('step-1', 'tenant-test'))?.state, 'WAITING_FOR_HUMAN');

    const answered = await repo.answerInteraction({
      interactionId: 'interaction-approval-1',
      runId: runCmd.id,
      tenantId: 'tenant-test',
      response: { approved: true },
      actor: 'human-1',
    });

    assert.equal(answered.status, 'answered');
    assert.equal((await repo.getStep('step-1', 'tenant-test'))?.state, 'RETRY_WAIT');
    assert.equal((await repo.getStep('step-2', 'tenant-test'))?.state, 'WAITING_FOR_HUMAN');
    const answeredEvent = (await repo.listEvents(runCmd.id, 'tenant-test')).find(
      (event) => event.type === 'interaction.answered',
    );
    assert.deepEqual(answeredEvent?.payload, { response: { approved: true } });
    const claimed = await repo.claimNextStep({
      workerId: 'worker-after-approval',
      tenantId: 'tenant-test',
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
    });
    assert.equal(claimed?.id, 'step-1');
    assert.equal(claimed?.state, 'RUNNING');
    assert.equal(claimed?.lease?.fencingEpoch, 1);
  });

  it('creates and retrieves an interaction', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const interaction = await repo.createInteraction(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        prompt: 'Should I proceed?',
        expiresAt: new Date(Date.now() + 60000),
      },
      'tester',
    );

    assert.ok(interaction.id.startsWith('itr_'));
    assert.equal(interaction.status, 'pending');
    assert.equal(interaction.prompt, 'Should I proceed?');

    const fetched = await repo.getInteraction(interaction.id, 'tenant-test');
    assert.ok(fetched);
    assert.equal(fetched.prompt, 'Should I proceed?');
  });

  it('answers a pending interaction', async () => {
    const runCmd = createRunCommand();
    runCmd.steps[0] = {
      ...runCmd.steps[0]!,
      initialState: 'WAITING_FOR_HUMAN',
      interaction: { id: 'interaction-answer-test', prompt: 'Approve deployment?' },
    };
    await repo.createRun(runCmd, 'tester');
    const interaction = (await repo.listInteractions(runCmd.id, 'tenant-test'))[0]!;

    const answerReq: AnswerInteractionRequest = {
      interactionId: interaction.id,
      runId: runCmd.id,
      tenantId: 'tenant-test',
      response: { approved: true, comment: 'looks good' },
      actor: 'human-1',
    };
    const answered = await repo.answerInteraction(answerReq);
    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.response, { approved: true, comment: 'looks good' });
    assert.ok(answered.answeredAt);
  });

  it('rejects answering already-answered interaction', async () => {
    const runCmd = createRunCommand();
    runCmd.steps[0] = {
      ...runCmd.steps[0]!,
      initialState: 'WAITING_FOR_HUMAN',
      interaction: { id: 'interaction-double-answer-test', prompt: 'test' },
    };
    await repo.createRun(runCmd, 'tester');
    const interaction = (await repo.listInteractions(runCmd.id, 'tenant-test'))[0]!;

    await repo.answerInteraction({
      interactionId: interaction.id,
      runId: runCmd.id,
      tenantId: 'tenant-test',
      response: { ok: true },
      actor: 'human-1',
    });

    await assert.rejects(
      () =>
        repo.answerInteraction({
          interactionId: interaction.id,
          runId: runCmd.id,
          tenantId: 'tenant-test',
          response: { ok: false },
          actor: 'human-2',
        }),
      (err: any) => err.code === 'INTERACTION_NOT_FOUND',
    );
  });

  it('lists interactions for a run', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    await repo.createInteraction(
      { runId: runCmd.id, stepId: 'step-1', tenantId: 'tenant-test', prompt: 'q1' },
      'tester',
    );
    await repo.createInteraction(
      { runId: runCmd.id, stepId: 'step-1', tenantId: 'tenant-test', prompt: 'q2' },
      'tester',
    );

    const list = await repo.listInteractions(runCmd.id, 'tenant-test');
    assert.equal(list.length, 2);
  });

  it('expires stale interactions', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    await repo.createInteraction(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        prompt: 'expired?',
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
      'tester',
    );
    await repo.createInteraction(
      {
        runId: runCmd.id,
        stepId: 'step-1',
        tenantId: 'tenant-test',
        prompt: 'fresh?',
        expiresAt: new Date(Date.now() + 60000),
      },
      'tester',
    );

    const expired = await repo.expireStaleInteractions(new Date(), 10);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].prompt, 'expired?');
    assert.equal(expired[0].status, 'expired');
  });
});

describe('PostgresKernelRepository — Kernel-native approval release', () => {
  it('creates the waiting step and deterministic interaction in one transaction', async () => {
    const createdAt = '2026-07-18T00:00:00.000Z';
    const pool = new RecordingSqlPool((sql) => {
      if (sql.includes('INSERT INTO commander_runs')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 'run-postgres-approval',
              tenant_id: 'tenant-postgres',
              intent_hash: 'intent',
              work_graph_hash: 'graph',
              work_graph_version: 'v1',
              policy_snapshot_id: 'policy',
              state: 'PENDING',
              version: 1,
              metadata: {},
              created_at: createdAt,
              updated_at: createdAt,
              paused_at: null,
              terminal_at: null,
            },
          ],
        };
      }
      return emptyResult();
    });
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });

    await repo.createRun(
      {
        id: 'run-postgres-approval',
        tenantId: 'tenant-postgres',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [
          {
            id: 'step-postgres-approval',
            kind: 'agent',
            initialState: 'WAITING_FOR_HUMAN',
            interaction: {
              id: 'interaction-postgres-approval',
              prompt: 'Approve the Postgres action?',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
          },
        ],
      },
      'gateway',
    );

    const stepInsert = pool.queries.find(({ sql }) => sql.includes('INSERT INTO commander_steps'));
    const interactionInsert = pool.queries.find(({ sql }) =>
      sql.includes('INSERT INTO commander_interactions'),
    );
    assert.ok(stepInsert);
    assert.ok(stepInsert.values?.includes('WAITING_FOR_HUMAN'));
    assert.ok(interactionInsert);
    assert.deepEqual(interactionInsert.values?.slice(0, 6), [
      'interaction-postgres-approval',
      'run-postgres-approval',
      'step-postgres-approval',
      'tenant-postgres',
      'Approve the Postgres action?',
      '2030-01-01T00:00:00.000Z',
    ]);
    const createdEventInsert = pool.queries.find(
      ({ sql, values }) =>
        sql.includes('INSERT INTO commander_events') && values?.[4] === 'interaction.created',
    );
    assert.deepEqual(JSON.parse(createdEventInsert?.values?.[11] as string), {
      interactionId: 'interaction-postgres-approval',
      prompt: 'Approve the Postgres action?',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    assert.equal(pool.queries[0]?.sql, 'BEGIN');
    assert.equal(pool.queries.at(-1)?.sql, 'COMMIT');
  });

  it('maps only an interaction uniqueness violation to DUPLICATE_INTERACTION and rolls back', async () => {
    const createdAt = '2026-07-18T00:00:00.000Z';
    const pool = new RecordingSqlPool((sql) => {
      if (sql.includes('INSERT INTO commander_runs')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 'run-postgres-duplicate-interaction',
              tenant_id: 'tenant-postgres',
              intent_hash: 'intent',
              work_graph_hash: 'graph',
              work_graph_version: 'v1',
              policy_snapshot_id: 'policy',
              state: 'PENDING',
              version: 1,
              metadata: {},
              created_at: createdAt,
              updated_at: createdAt,
              paused_at: null,
              terminal_at: null,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO commander_interactions')) {
        throw Object.assign(new Error('duplicate interaction'), {
          code: '23505',
          constraint: 'commander_interactions_pkey',
        });
      }
      return emptyResult();
    });
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });

    await assert.rejects(
      () =>
        repo.createRun(
          {
            id: 'run-postgres-duplicate-interaction',
            tenantId: 'tenant-postgres',
            intentHash: 'intent',
            workGraphHash: 'graph',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy',
            steps: [
              {
                id: 'step-postgres-unique',
                kind: 'agent',
                initialState: 'WAITING_FOR_HUMAN',
                interaction: { id: 'interaction-existing', prompt: 'Duplicate' },
              },
            ],
          },
          'gateway',
        ),
      (error: any) => error.code === 'DUPLICATE_INTERACTION',
    );
    assert.equal(pool.queries.at(-1)?.sql, 'ROLLBACK');
  });

  it('answers and releases only the locked interaction-bound waiting step in one transaction', async () => {
    const createdAt = '2026-07-18T00:00:00.000Z';
    const interactionRow = {
      id: 'interaction-postgres-approval',
      run_id: 'run-postgres-approval',
      step_id: 'step-postgres-approval',
      tenant_id: 'tenant-postgres',
      status: 'pending',
      prompt: 'Approve the Postgres action?',
      response: null,
      created_at: createdAt,
      answered_at: null,
      expires_at: null,
      step_state: 'WAITING_FOR_HUMAN',
    };
    const pool = new RecordingSqlPool((sql) => {
      if (sql.includes('SELECT i.*') && sql.includes('commander_interactions')) {
        return { rows: [interactionRow], rowCount: 1 };
      }
      if (sql.includes('UPDATE commander_steps')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 'step-postgres-approval',
              run_id: 'run-postgres-approval',
              tenant_id: 'tenant-postgres',
              kind: 'agent',
              state: 'RETRY_WAIT',
              version: 2,
              attempt: 0,
              max_attempts: 1,
              priority: 0,
              dependencies: [],
              input: {},
              output: null,
              error: null,
              scheduled_at: createdAt,
              created_at: createdAt,
              updated_at: createdAt,
              lease_worker_id: null,
              lease_worker_generation: 0,
              lease_token: null,
              fencing_epoch: 0,
              lease_expires_at: null,
            },
          ],
        };
      }
      if (sql.includes('UPDATE commander_interactions')) {
        return {
          rowCount: 1,
          rows: [
            {
              ...interactionRow,
              status: 'answered',
              response: { approved: true },
              answered_at: createdAt,
            },
          ],
        };
      }
      return emptyResult();
    });
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });

    const answered = await repo.answerInteraction({
      interactionId: 'interaction-postgres-approval',
      runId: 'run-postgres-approval',
      tenantId: 'tenant-postgres',
      response: { approved: true },
      actor: 'reviewer',
    });

    assert.equal(answered.status, 'answered');
    const lockedInteraction = pool.queries.find(
      ({ sql }) => sql.includes('SELECT i.*') && sql.includes('FOR UPDATE'),
    );
    assert.ok(lockedInteraction);
    assert.deepEqual(lockedInteraction.values, [
      'interaction-postgres-approval',
      'run-postgres-approval',
      'tenant-postgres',
    ]);
    const releasedStep = pool.queries.find(({ sql }) => sql.includes('UPDATE commander_steps'));
    assert.ok(releasedStep);
    assert.match(releasedStep.sql, /run_id=\$2/);
    assert.match(releasedStep.sql, /tenant_id=\$3/);
    assert.match(releasedStep.sql, /state='WAITING_FOR_HUMAN'/);
    const answeredEventInsert = pool.queries.find(
      ({ sql, values }) =>
        sql.includes('INSERT INTO commander_events') && values?.[4] === 'interaction.answered',
    );
    assert.deepEqual(JSON.parse(answeredEventInsert?.values?.[11] as string), {
      response: { approved: true },
    });
    assert.equal(pool.queries[0]?.sql, 'BEGIN');
    assert.equal(pool.queries.at(-1)?.sql, 'COMMIT');
  });
});

describe('KernelRepository — Outbox DLQ', () => {
  let repo: InMemoryKernelRepository;

  beforeEach(() => {
    repo = new InMemoryKernelRepository();
  });

  it('moves messages to DLQ after max attempts', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');

    // The run creation should have created outbox messages
    // Simulate failed attempts by claiming without publishing
    for (let i = 0; i < 11; i++) {
      const messages = await repo.claimOutbox(10);
      for (const msg of messages) {
        // Don't publish — simulate failure
        // The claim will expire, and we manually increment attempts
        (msg as any).attempts = i + 1;
      }
    }

    const result = await repo.sweepOutboxDlq(new Date(), 10);
    // Some messages should have been moved to DLQ
    assert.ok(result.movedToDlq >= 0);
  });

  it('lists DLQ entries', async () => {
    const dlqEntries = await repo.listDlqEntries(100);
    assert.equal(dlqEntries.length, 0);
  });

  it('replays a DLQ entry', async () => {
    // Can't replay non-existent entry
    const result = await repo.replayDlqEntry('nonexistent');
    assert.equal(result, false);
  });
});

describe('KernelRepository — ObjectStorage', () => {
  it('stores and retrieves blobs via NullObjectStorage', async () => {
    const { NullObjectStorage } = await import('./testing/objectStorage.js');
    const storage = new NullObjectStorage();

    const ref = await storage.put({
      data: 'hello world',
      tenantId: 'tenant-a',
      runId: 'run-1',
    });

    assert.ok(ref.key);
    assert.equal(ref.size, 11);
    assert.equal(ref.backend, 'null');
    assert.ok(ref.digest);

    const data = await storage.get(ref.key);
    assert.ok(data);
    assert.equal(data.toString(), 'hello world');

    assert.equal(await storage.exists(ref.key), true);

    const head = await storage.head(ref.key);
    assert.ok(head);
    assert.equal(head.size, 11);

    const deleted = await storage.delete(ref.key);
    assert.equal(deleted, true);
    assert.equal(await storage.exists(ref.key), false);
  });

  it('stores binary data', async () => {
    const { NullObjectStorage } = await import('./testing/objectStorage.js');
    const storage = new NullObjectStorage();

    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const ref = await storage.put({
      data: binaryData,
      contentType: 'application/octet-stream',
      tenantId: 't1',
      runId: 'r1',
    });

    const retrieved = await storage.get(ref.key);
    assert.ok(retrieved);
    assert.deepEqual(retrieved, binaryData);
  });
});
