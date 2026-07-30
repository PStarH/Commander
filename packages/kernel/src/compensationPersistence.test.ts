import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelRepository } from './repository.js';
import type {
  CompensationAuthorizationRecord,
  KernelEffect,
  RequestCompensationInput,
} from './types.js';
import { canonicalCompensationHash } from './ops/compensationAuthority.js';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import { KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL } from './evidenceSchema.js';
import { KERNEL_COMPENSATION_PERSISTENCE_SQL } from './compensationSchema.js';

const TENANT = 'tenant-compensation';

describe('compensation terminal evidence schema', () => {
  it('persists signed evidence before finalization and synchronizes escalation truth', () => {
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /CREATE OR REPLACE FUNCTION public\.finalize_compensation\(p_input jsonb\)[\s\S]*commander_insert_reconcile_evidence_v1[\s\S]*apply_task3_compensation_mutation/i,
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /p_disposition='ESCALATED'[\s\S]*reconcile_disposition='ESCALATED'[\s\S]*reconcile_escalated_at/i,
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /TERMINAL_EVIDENCE_REQUIRED/i,
    );
    assert.match(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /v_request\.compensation_effect_id<>p_input->>'effectId'[\s\S]*v_effect\.id IS NULL[\s\S]*p_disposition<>'ESCALATED'/i,
    );
  });
});

interface Harness {
  repository: KernelRepository;
  seedWorker(
    id: string,
    tenantIds: string[],
    generation: number,
    options?: {
      claimSecret?: string;
      capabilities?: string[];
      identitySubject?: string;
      registeredAt?: Date;
      lastHeartbeatAt?: Date;
    },
  ): string;
  close(): void;
}

async function createHarness(kind: 'memory' | 'sqlite'): Promise<Harness> {
  if (kind === 'memory') {
    const repository = new InMemoryKernelRepository({ schedulerMode: false });
    return {
      repository,
      seedWorker: repository.seedTestWorker.bind(repository),
      close: () => {},
    };
  }
  const repository = new SqliteKernelRepository({
    path: ':memory:',
    allowMemory: true,
    schedulerMode: false,
  });
  await repository.initialize();
  return {
    repository,
    seedWorker: repository.seedTestWorker.bind(repository),
    close: () => repository.close(),
  };
}

async function completedForwardEffect(harness: Harness, suffix: string): Promise<KernelEffect> {
  const { repository, seedWorker } = harness;
  const now = new Date();
  seedWorker('reconcile-worker', [TENANT], 1, {
    capabilities: ['effect.reconcile'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  seedWorker('compensation-worker', [TENANT], 1, {
    claimSecret: 'compensation-secret',
    capabilities: ['effect.compensate'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  const executionSecret = seedWorker('execution-worker', [TENANT], 1, {
    capabilities: ['agent', 'tool'],
  });
  const runId = `forward-run-${suffix}`;
  const stepId = `forward-step-${suffix}`;
  const effectId = `forward-effect-${suffix}`;
  await repository.createRun(
    {
      id: runId,
      tenantId: TENANT,
      intentHash: `intent-${suffix}`,
      workGraphHash: `graph-${suffix}`,
      workGraphVersion: 'v1',
      policySnapshotId: 'forward-policy-v1',
      steps: [{ id: stepId, kind: 'tool' }],
    },
    'test',
  );
  const claimed = await repository.claimNextStep({
    workerId: 'execution-worker',
    workerGeneration: 1,
    claimSecret: executionSecret,
    leaseTtlMs: 60_000,
    tenantId: TENANT,
    capabilities: ['agent', 'tool'],
  });
  assert.ok(claimed?.lease);
  const admitted = await repository.admitEffect({
    id: effectId,
    runId,
    stepId,
    tenantId: TENANT,
    type: 'http.post',
    idempotencyKey: `forward-idempotency-${suffix}`,
    policyDecisionId: 'forward-decision-v1',
    policySnapshotId: 'forward-policy-v1',
    actionDigest: 'f'.repeat(64),
    request: { destination: 'https://example.test/resource', body: { suffix } },
    lease: claimed.lease,
    actor: 'execution-worker',
  });
  assert.equal(admitted.admitted, true);
  const response = { remoteId: `remote-${suffix}`, status: 'created' };
  const completed = await repository.completeEffect(
    effectId,
    TENANT,
    claimed.lease,
    response,
    'execution-worker',
  );
  assert.ok(completed);
  await repository.completeStep({
    stepId,
    tenantId: TENANT,
    expectedVersion: claimed.version,
    lease: claimed.lease,
    output: response,
    actor: 'execution-worker',
  });
  return completed;
}

function authorizationFor(effect: KernelEffect): CompensationAuthorizationRecord {
  const compensationPatch = { remoteId: effect.response!.remoteId };
  return {
    id: `authorization-${effect.id}`,
    tenantId: TENANT,
    originalRunId: effect.runId,
    originalEffectId: effect.id,
    compensationEffectType: 'compensate.http.post',
    adapterVersion: 'adapter-v1',
    compensationPatch,
    forwardReceiptHash: canonicalCompensationHash(effect.response!),
    policyDecisionId: 'compensation-decision-v1',
    policySnapshotId: 'compensation-policy-v1',
    decision: 'allow',
    actionDigest: canonicalCompensationHash({
      type: 'compensate.http.post',
      originalEffectId: effect.id,
      adapterVersion: 'adapter-v1',
      forwardResponse: effect.response!,
      compensationPatch,
    }),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`separate compensation authority (${kind})`, () => {
    it('requires a persisted authorization reference and rejects the retired rich payload', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, 'retired-payload');
        const legacyPayload = {
          tenantId: TENANT,
          originalRunId: original.runId,
          originalEffectId: original.id,
          forwardReceipt: original.response!,
          adapterVersion: 'adapter-v1',
          compensationEffectType: 'compensate.http.post',
          compensationPatch: { remoteId: original.response!.remoteId },
          policyDecisionId: 'compensation-decision-v1',
          policySnapshotId: 'compensation-policy-v1',
          actionDigest: 'caller-controlled',
          decisionEffect: 'allow',
          authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          approvalBinding: null,
          actor: 'caller',
        };

        const result = await harness.repository.requestCompensation(
          legacyPayload as unknown as RequestCompensationInput,
        );
        assert.equal(result.accepted, false);
        assert.equal(result.accepted ? null : result.reason, 'AUTHORIZATION_NOT_FOUND');
      } finally {
        harness.close();
      }
    });

    it('persists authorization before request and replays only the immutable reference', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, 'canonical-reference');
        const authorization = authorizationFor(original);
        const created = await harness.repository.createCompensationAuthorization(authorization);
        assert.equal(created.replayed, false);

        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;
        assert.equal(requested.request.authorizationId, authorization.id);
        assert.equal(requested.request.originalEffectId, original.id);

        const replay = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(replay.accepted && replay.replayed, true);
        assert.equal(
          await harness.repository.getCompensationAuthorization(authorization.id, 'tenant-other'),
          null,
        );
      } finally {
        harness.close();
      }
    });

    it('atomically escalates a rejected claim before an effect is admitted', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, `pre-admission-${kind}`);
        const authorization = authorizationFor(original);
        await harness.repository.createCompensationAuthorization(authorization);
        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;

        const messages = await harness.repository.claimOutboxByTopic(
          'commander.kernel.compensation.requested',
          1,
          new Date(),
          {
            workerId: 'compensation-worker',
            workerGeneration: 1,
            claimSecret: 'compensation-secret',
          },
        );
        assert.equal(messages.length, 1);
        const claimed = await harness.repository.claimCompensationRequest({
          requestId: requested.request.id,
          outboxMessageId: messages[0]!.id,
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
        });
        assert.ok(claimed?.request.compensationEffectId);

        const result = await harness.repository.finalizeCompensation({
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
          tenantId: TENANT,
          requestId: claimed.request.id,
          effectId: claimed.request.compensationEffectId,
          disposition: 'ESCALATED',
          actor: 'compensation-worker',
          outboxMessageId: claimed.outboxMessageId,
          outboxClaimToken: claimed.outboxClaimToken,
          response: { reason: 'COMPENSATION_ADAPTER_UNREGISTERED' },
        });

        assert.deepEqual(result, { applied: true, disposition: 'ESCALATED', replayed: false });
        assert.equal(await harness.repository.getEffect(claimed.request.compensationEffectId, TENANT), null);
        assert.equal(
          (await harness.repository.getStep(claimed.request.compensationStepId, TENANT))?.state,
          'WAITING_FOR_HUMAN',
        );
        assert.equal(
          (await harness.repository.getRun(claimed.request.compensationRunId, TENANT))?.state,
          'COMPENSATING',
        );
        assert.equal(
          (
            await harness.repository.claimOutboxByTopic(
              'commander.kernel.compensation.requested',
              1,
              new Date('9999-12-31T23:59:59.999Z'),
              {
                workerId: 'compensation-worker',
                workerGeneration: 1,
                claimSecret: 'compensation-secret',
              },
            )
          ).length,
          0,
        );
      } finally {
        harness.close();
      }
    });

  });
}
