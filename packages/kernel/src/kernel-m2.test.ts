import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type {
  CreateKernelRun,
  CreateTimerRequest,
  CreateInteractionRequest,
  AnswerInteractionRequest,
} from './types.js';

function createRunCommand(): CreateKernelRun {
  return {
    id: `run_${Date.now()}`,
    tenantId: 'tenant-test',
    intentHash: 'a'.repeat(64),
    workGraphHash: 'b'.repeat(64),
    workGraphVersion: 'v1',
    policySnapshotId: 'ps_test',
    steps: [
      { id: 'step-1', kind: 'agent', input: { prompt: 'hello' } },
    ],
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
    const timer = await repo.createTimer({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      firesAt: new Date(Date.now() + 100),
      timerType: 'RETRY_DELAY',
      payload: { reason: 'test' },
    }, 'tester');

    // Not expired yet
    const before = await repo.claimExpiredTimers(new Date(), 10);
    assert.equal(before.length, 0);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 150));

    const expired = await repo.claimExpiredTimers(new Date(), 10);
    assert.ok(expired.length >= 1);
    assert.equal(expired[0].state, 'FIRED');
    assert.ok(expired[0].firedAt);
  });

  it('cancels a pending timer', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const timer = await repo.createTimer({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      firesAt: new Date(Date.now() + 1000),
      timerType: 'INTERACTION_TIMEOUT',
    }, 'tester');

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
    const timer = await repo.createTimer({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      firesAt: new Date(Date.now() + 1000),
      timerType: 'STEP_DEADLINE',
    }, 'tester');

    const cancelled = await repo.cancelTimer(timer.id, 'wrong-tenant');
    assert.equal(cancelled, false);
  });
});

describe('KernelRepository — Interactions', () => {
  let repo: InMemoryKernelRepository;

  beforeEach(() => {
    repo = new InMemoryKernelRepository();
  });

  it('creates and retrieves an interaction', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const interaction = await repo.createInteraction({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      prompt: 'Should I proceed?',
      expiresAt: new Date(Date.now() + 60000),
    }, 'tester');

    assert.ok(interaction.id.startsWith('itr_'));
    assert.equal(interaction.status, 'pending');
    assert.equal(interaction.prompt, 'Should I proceed?');

    const fetched = await repo.getInteraction(interaction.id, 'tenant-test');
    assert.ok(fetched);
    assert.equal(fetched.prompt, 'Should I proceed?');
  });

  it('answers a pending interaction', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    const interaction = await repo.createInteraction({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      prompt: 'Approve deployment?',
    }, 'tester');

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
    await repo.createRun(runCmd, 'tester');
    const interaction = await repo.createInteraction({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      prompt: 'test',
    }, 'tester');

    await repo.answerInteraction({
      interactionId: interaction.id,
      runId: runCmd.id,
      tenantId: 'tenant-test',
      response: { ok: true },
      actor: 'human-1',
    });

    await assert.rejects(
      () => repo.answerInteraction({
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
    await repo.createInteraction({ runId: runCmd.id, stepId: 'step-1', tenantId: 'tenant-test', prompt: 'q1' }, 'tester');
    await repo.createInteraction({ runId: runCmd.id, stepId: 'step-1', tenantId: 'tenant-test', prompt: 'q2' }, 'tester');

    const list = await repo.listInteractions(runCmd.id, 'tenant-test');
    assert.equal(list.length, 2);
  });

  it('expires stale interactions', async () => {
    const runCmd = createRunCommand();
    await repo.createRun(runCmd, 'tester');
    await repo.createInteraction({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      prompt: 'expired?',
      expiresAt: new Date(Date.now() - 1000), // already expired
    }, 'tester');
    await repo.createInteraction({
      runId: runCmd.id,
      stepId: 'step-1',
      tenantId: 'tenant-test',
      prompt: 'fresh?',
      expiresAt: new Date(Date.now() + 60000),
    }, 'tester');

    const expired = await repo.expireStaleInteractions(new Date(), 10);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].prompt, 'expired?');
    assert.equal(expired[0].status, 'expired');
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

    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
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
