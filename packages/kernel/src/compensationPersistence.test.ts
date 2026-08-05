import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelRepository } from './repository.js';
import type {
  ClaimedCompensationRequest,
  CompensationAuthorizationRecord,
  KernelEffect,
  RequestCompensationInput,
} from './types.js';
import type { KernelEvidenceRecord } from './evidenceRepository.js';
import { canonicalCompensationHash } from './ops/compensationAuthority.js';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import { KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL } from './evidenceSchema.js';
import {
  KERNEL_COMPENSATION_PERSISTENCE_SQL,
  KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
} from './compensationSchema.js';
import { KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS } from './migrations.js';

const TENANT = 'tenant-compensation';

describe('compensation terminal evidence schema', () => {
  it('keeps the published persistence migration immutable and adds a forward closure', () => {
    assert.deepEqual(
      KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS.map(({ id }) => id),
      [
        '2026-07-29.1.governed_compensation_persistence',
        '2026-08-05.2.compensation_terminal_closure',
      ],
    );
    assert.equal(
      KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS[0]?.checksum,
      '9eb068023ff22fa9a9c59c87d2cccb3b4ebbf3320d629aa9ad6b02fe6ef1e654',
    );
    assert.equal(
      KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS[1]?.sql,
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
    );
  });

  it('persists signed evidence before finalization and synchronizes escalation truth', () => {
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /CREATE OR REPLACE FUNCTION public\.finalize_compensation\(p_input jsonb\)[\s\S]*commander_insert_reconcile_evidence_v1[\s\S]*apply_task3_compensation_mutation/i,
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /p_disposition='ESCALATED'[\s\S]*reconcile_disposition='ESCALATED'[\s\S]*reconcile_escalated_at/i,
    );
    assert.match(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL, /TERMINAL_EVIDENCE_REQUIRED/i);
    assert.match(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /v_request\.compensation_effect_id<>p_input->>'effectId'[\s\S]*v_effect\.id IS NULL[\s\S]*p_disposition<>'ESCALATED'/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /claim_compensation_request_pre_terminal_closure[\s\S]*v_original_run_id[\s\S]*state IN \('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','COMPENSATING'\)/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /apply_task3_compensation_mutation_pre_terminal_closure[\s\S]*v_event_id[\s\S]*'compensation\.completed'/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /p_disposition='CONFIRMED_NOT_APPLIED'[\s\S]*state='FAILED'[\s\S]*state='COMPENSATING'/i,
    );
    for (const eventType of [
      'run.compensating',
      'run.compensated',
      'run.succeeded',
      'run.failed',
      'step.succeeded',
      'step.failed',
    ]) {
      assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, new RegExp(`'${eventType}'`));
    }
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /state='COMPENSATED',version=version\+1/i,
    );
    assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, /state='SUCCEEDED',version=version\+1/i);
    assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, /state='FAILED',version=version\+1/i);
    assert.doesNotMatch(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /pre_terminal_closure|COMPENSATION_TERMINAL_EVENT_CONTEXT_MISSING/i,
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /CREATE OR REPLACE FUNCTION public\.(?:finalize_compensation|park_compensation_unknown)/i,
      'the forward closure must preserve evidence-aware functions already installed on upgrades',
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
  if (!admitted.admitted) throw new Error('forward effect admission failed');
  const completed = await repository.completeEffectWithEvidence(
    effectId,
    TENANT,
    claimed.lease,
    response,
    'execution-worker',
    terminalEvidenceFor({ ...admitted.effect, state: 'COMPLETED' }, 'effect.completed'),
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

function terminalEvidenceFor(
  effect: KernelEffect,
  auditEventType = 'compensation.completed',
  projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' = 'COMPLETED',
): KernelEvidenceRecord {
  const bundleId = `evidence_${effect.id}`;
  const contentHash = 'e'.repeat(64);
  const signature = {
    algorithm: 'Ed25519' as const,
    keyId: 'compensation-test-key',
    signedAt: '2026-08-05T00:00:00.000Z',
    value: 'compensation-test-signature',
  };
  return {
    tenantId: effect.tenantId,
    runId: effect.runId,
    bundleId,
    actionDigest: effect.actionDigest,
    body: {
      bodyVersion: 'commander.evidence-body/v1',
      bundleId,
      actionDigest: effect.actionDigest,
      contentHash,
      terminalDisposition: projectedState === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED',
      scope: { tenantId: effect.tenantId, runId: effect.runId, effectId: effect.id },
      effects: [{ effectId: effect.id, state: projectedState }],
      auditEvents: [{ type: auditEventType }],
      signature,
    },
    contentHash,
    signature,
    createdAt: '2026-08-05T00:00:00.000Z',
    anchoredAt: '2026-08-05T00:00:01.000Z',
    retentionUntil: '2027-08-05T00:00:00.000Z',
  };
}

async function claimedCompensation(
  harness: Harness,
  suffix: string,
  claimOptions: { leaseTtlMs?: number; now?: Date } = {},
) {
  const original = await completedForwardEffect(harness, suffix);
  const originalRunBeforeClaim = await harness.repository.getRun(original.runId, TENANT);
  if (!originalRunBeforeClaim) throw new Error('original run missing before compensation claim');
  const authorization = authorizationFor(original);
  await harness.repository.createCompensationAuthorization(authorization);
  const requested = await harness.repository.requestCompensation({
    tenantId: TENANT,
    authorizationId: authorization.id,
    actor: 'action-gateway',
  });
  assert.equal(requested.accepted, true, JSON.stringify(requested));
  if (!requested.accepted) throw new Error('compensation request rejected');
  const compensationRunBeforeClaim = await harness.repository.getRun(
    requested.request.compensationRunId,
    TENANT,
  );
  if (!compensationRunBeforeClaim) throw new Error('compensation run missing before claim');

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
    ...claimOptions,
  });
  if (!claimed?.request.compensationEffectId) throw new Error('compensation claim rejected');
  const compensationEffectId = claimed.request.compensationEffectId;
  const admissionInput = {
    id: compensationEffectId,
    runId: claimed.request.compensationRunId,
    stepId: claimed.request.compensationStepId,
    tenantId: TENANT,
    type: claimed.authorization.compensationEffectType,
    idempotencyKey: `cmp:${claimed.request.originalEffectId}:${claimed.request.adapterVersion}`,
    policyDecisionId: claimed.authorization.policyDecisionId,
    policySnapshotId: claimed.authorization.policySnapshotId,
    actionDigest: claimed.authorization.actionDigest,
    request: {
      originalEffectId: claimed.request.originalEffectId,
      forwardResponse: claimed.forwardResponse,
      compensationPatch: claimed.authorization.compensationPatch,
    },
    lease: claimed.lease,
    requestId: claimed.request.id,
    requestClaimToken: claimed.request.claimToken!,
    outboxMessageId: claimed.outboxMessageId,
    outboxClaimToken: claimed.outboxClaimToken,
    actor: 'compensation-worker',
  };
  return {
    admissionInput,
    claimed,
    compensationEffectId,
    original,
    originalRunVersionBeforeClaim: originalRunBeforeClaim.version,
    compensationRunVersionBeforeClaim: compensationRunBeforeClaim.version,
  };
}

async function admittedCompensation(harness: Harness, suffix: string) {
  const { admissionInput, claimed, compensationEffectId, original } = await claimedCompensation(
    harness,
    suffix,
  );
  assert.deepEqual(
    await harness.repository.admitCompensationEffect({
      ...admissionInput,
      runId: original.runId,
      stepId: original.stepId,
    }),
    { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' },
  );
  const admitted = await harness.repository.admitCompensationEffect(admissionInput);
  if (!admitted.admitted) throw new Error(`compensation admission rejected: ${admitted.reason}`);
  return { admitted: admitted.effect, claimed, compensationEffectId, original };
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

    it('keeps governed compensation steps out of the ordinary worker queue', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, `queue-isolation-${kind}`);
        const authorization = authorizationFor(original);
        await harness.repository.createCompensationAuthorization(authorization);
        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        const claimSecret = harness.seedWorker('ordinary-tool-worker', [TENANT], 1, {
          claimSecret: 'ordinary-tool-secret',
          capabilities: ['tool'],
        });
        for (const capabilities of [['effect.compensate'], undefined] as const) {
          const claimed = await harness.repository.claimNextStep({
            workerId: 'ordinary-tool-worker',
            workerGeneration: 1,
            claimSecret,
            leaseTtlMs: 60_000,
            ...(capabilities ? { capabilities: [...capabilities] } : {}),
          });
          assert.equal(claimed, null);
        }
      } finally {
        harness.close();
      }
    });

    it('derives the durable approval binding from the answered interaction', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, `approval-binding-${kind}`);
        const approvalInteractionId = `approval-${kind}`;
        const approvalExpiresAt = new Date(Date.now() + 60_000);
        await harness.repository.createInteraction(
          {
            id: approvalInteractionId,
            runId: original.runId,
            stepId: original.stepId,
            tenantId: TENANT,
            prompt: 'Approve compensation',
            expiresAt: approvalExpiresAt,
          },
          'action-gateway',
        );
        const authorization = {
          ...authorizationFor(original),
          decision: 'require_approval' as const,
          approvalInteractionId,
        };
        await harness.repository.createCompensationAuthorization(authorization);
        await harness.repository.answerInteraction({
          interactionId: approvalInteractionId,
          runId: original.runId,
          tenantId: TENANT,
          response: {
            approved: true,
            approvedBy: 'principal-approver',
            authorizationId: authorization.id,
            actionDigest: authorization.actionDigest,
            policyDecisionId: authorization.policyDecisionId,
            policySnapshotId: authorization.policySnapshotId,
          },
          actor: 'principal-approver',
          releaseStep: false,
        });
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
        const claimed = await harness.repository.claimCompensationRequest({
          requestId: requested.request.id,
          outboxMessageId: messages[0]!.id,
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
        });
        assert.deepEqual(claimed?.authorization.approvalBinding, {
          approvalId: approvalInteractionId,
          approverPrincipalId: 'principal-approver',
          actionDigest: authorization.actionDigest,
          policySnapshotId: authorization.policySnapshotId,
          expiresAt: approvalExpiresAt.toISOString(),
        });
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
        assert.equal(
          await harness.repository.getEffect(claimed.request.compensationEffectId, TENANT),
          null,
        );
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

    it('finalizes successful durable compensation with terminal states and event', async () => {
      const harness = await createHarness(kind);
      try {
        const { admitted, claimed, compensationEffectId, original } = await admittedCompensation(
          harness,
          `successful-finalization-${kind}`,
        );
        const response = { compensated: true };
        const evidence = terminalEvidenceFor({ ...admitted, state: 'COMPLETED' });
        assert.equal(
          (
            await harness.repository.completeEffectWithEvidence(
              compensationEffectId,
              TENANT,
              claimed.lease,
              response,
              'compensation-worker',
              evidence,
            )
          )?.state,
          'COMPLETED',
        );

        assert.deepEqual(
          await harness.repository.finalizeCompensation({
            workerId: 'compensation-worker',
            workerGeneration: 1,
            claimSecret: 'compensation-secret',
            tenantId: TENANT,
            requestId: claimed.request.id,
            effectId: compensationEffectId,
            disposition: 'COMPLETED',
            actor: 'compensation-worker',
            outboxMessageId: claimed.outboxMessageId,
            outboxClaimToken: claimed.outboxClaimToken,
            response,
            evidence,
          }),
          { applied: true, disposition: 'COMPLETED', replayed: false },
        );
        assert.equal(
          (await harness.repository.getRun(claimed.request.compensationRunId, TENANT))?.state,
          'SUCCEEDED',
        );
        assert.equal(
          (await harness.repository.getRun(original.runId, TENANT))?.state,
          'COMPENSATED',
        );
        assert.equal(
          (await harness.repository.listEvents(claimed.request.compensationRunId, TENANT)).some(
            (event) => event.type === 'compensation.completed',
          ),
          true,
        );
      } finally {
        harness.close();
      }
    });

    it('fails both runs and replays after SQLite worker fencing when compensation is confirmed not applied', async () => {
      const harness = await createHarness(kind);
      try {
        const { admitted, claimed, compensationEffectId, original } = await admittedCompensation(
          harness,
          `confirmed-not-applied-${kind}`,
        );
        assert.ok(
          await harness.repository.markEffectCompletionUnknown({
            effectId: compensationEffectId,
            tenantId: TENANT,
            reason: 'transport result unknown',
            lease: claimed.lease,
            actor: 'compensation-worker',
          }),
        );
        const response = { status: 'not_applied' };
        const evidence = terminalEvidenceFor(
          { ...admitted, state: 'CONFIRMED_NOT_APPLIED' },
          'effect.confirmed_not_applied',
          'CONFIRMED_NOT_APPLIED',
        );
        const input = {
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
          tenantId: TENANT,
          requestId: claimed.request.id,
          effectId: compensationEffectId,
          disposition: 'CONFIRMED_NOT_APPLIED' as const,
          actor: 'compensation-worker',
          outboxMessageId: claimed.outboxMessageId,
          outboxClaimToken: claimed.outboxClaimToken,
          response,
          evidence,
        };

        assert.deepEqual(await harness.repository.finalizeCompensation(input), {
          applied: true,
          disposition: 'CONFIRMED_NOT_APPLIED',
          replayed: false,
        });
        assert.equal(
          (await harness.repository.getRun(claimed.request.compensationRunId, TENANT))?.state,
          'FAILED',
        );
        assert.equal((await harness.repository.getRun(original.runId, TENANT))?.state, 'FAILED');
        if (kind === 'sqlite') {
          harness.seedWorker('compensation-worker', [TENANT], 2, {
            claimSecret: 'rotated-compensation-secret',
            capabilities: ['effect.compensate'],
            identitySubject: 'db:commander_adapter_ops',
          });
        }
        assert.deepEqual(await harness.repository.finalizeCompensation(input), {
          applied: true,
          disposition: 'CONFIRMED_NOT_APPLIED',
          replayed: true,
        });
      } finally {
        harness.close();
      }
    });

    it('rejects compensation admission after the durable claim expires', async () => {
      const harness = await createHarness(kind);
      try {
        const { admissionInput } = await claimedCompensation(harness, `expired-admission-${kind}`, {
          leaseTtlMs: 1,
          now: new Date(Date.now() - 1_000),
        });
        const result = await harness.repository.admitCompensationEffect(admissionInput);
        assert.equal(result.admitted, false, JSON.stringify(result));
      } finally {
        harness.close();
      }
    });
  });
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`${kind} compensation transition history`, () => {
    it('versions both runs and emits run.compensating when a request is first claimed', async () => {
      const harness = await createHarness(kind);
      try {
        const {
          claimed,
          original,
          originalRunVersionBeforeClaim,
          compensationRunVersionBeforeClaim,
        } = await claimedCompensation(harness, 'claim-transition-history');
        const compensationRun = await harness.repository.getRun(
          claimed.request.compensationRunId,
          TENANT,
        );
        const originalRun = await harness.repository.getRun(original.runId, TENANT);
        assert.equal(compensationRun?.version, compensationRunVersionBeforeClaim + 1);
        assert.equal(originalRun?.version, originalRunVersionBeforeClaim + 1);

        const compensationEvents = await harness.repository.listEvents(
          claimed.request.compensationRunId,
          TENANT,
        );
        const originalEvents = await harness.repository.listEvents(original.runId, TENANT);
        assert.equal(
          compensationEvents.some(
            (event) =>
              event.aggregateType === 'run' &&
              event.aggregateId === claimed.request.compensationRunId &&
              event.sequence === compensationRun?.version &&
              event.type === 'run.compensating',
          ),
          true,
        );
        assert.equal(
          originalEvents.some(
            (event) =>
              event.aggregateType === 'run' &&
              event.aggregateId === original.runId &&
              event.sequence === originalRun?.version &&
              event.type === 'run.compensating',
          ),
          true,
        );
      } finally {
        harness.close();
      }
    });

    for (const disposition of ['COMPLETED', 'CONFIRMED_NOT_APPLIED'] as const) {
      it(`increments terminal aggregate versions and emits canonical events for ${disposition}`, async () => {
        const harness = await createHarness(kind);
        try {
          const { admitted, claimed, compensationEffectId, original } = await admittedCompensation(
            harness,
            `terminal-transition-history-${disposition}`,
          );
          if (disposition === 'COMPLETED') {
            const response = { compensated: true };
            const evidence = terminalEvidenceFor({ ...admitted, state: 'COMPLETED' });
            assert.ok(
              await harness.repository.completeEffectWithEvidence(
                compensationEffectId,
                TENANT,
                claimed.lease,
                response,
                'compensation-worker',
                evidence,
              ),
            );
            const beforeRun = await harness.repository.getRun(
              claimed.request.compensationRunId,
              TENANT,
            );
            const beforeOriginal = await harness.repository.getRun(original.runId, TENANT);
            const beforeStep = await harness.repository.getStep(
              claimed.request.compensationStepId,
              TENANT,
            );
            assert.deepEqual(
              await harness.repository.finalizeCompensation({
                workerId: 'compensation-worker',
                workerGeneration: 1,
                claimSecret: 'compensation-secret',
                tenantId: TENANT,
                requestId: claimed.request.id,
                effectId: compensationEffectId,
                disposition,
                actor: 'compensation-worker',
                outboxMessageId: claimed.outboxMessageId,
                outboxClaimToken: claimed.outboxClaimToken,
                response,
                evidence,
              }),
              { applied: true, disposition, replayed: false },
            );
            await assertTerminalTransitionHistory(
              harness,
              claimed,
              original.runId,
              beforeRun!.version,
              beforeOriginal!.version,
              beforeStep!.version,
              'SUCCEEDED',
              'COMPENSATED',
              'step.succeeded',
              'run.succeeded',
              'run.compensated',
            );
            return;
          }

          assert.ok(
            await harness.repository.markEffectCompletionUnknown({
              effectId: compensationEffectId,
              tenantId: TENANT,
              reason: 'transport result unknown',
              lease: claimed.lease,
              actor: 'compensation-worker',
            }),
          );
          const response = { status: 'not_applied' };
          const evidence = terminalEvidenceFor(
            { ...admitted, state: 'CONFIRMED_NOT_APPLIED' },
            'effect.confirmed_not_applied',
            'CONFIRMED_NOT_APPLIED',
          );
          const beforeRun = await harness.repository.getRun(
            claimed.request.compensationRunId,
            TENANT,
          );
          const beforeOriginal = await harness.repository.getRun(original.runId, TENANT);
          const beforeStep = await harness.repository.getStep(
            claimed.request.compensationStepId,
            TENANT,
          );
          assert.deepEqual(
            await harness.repository.finalizeCompensation({
              workerId: 'compensation-worker',
              workerGeneration: 1,
              claimSecret: 'compensation-secret',
              tenantId: TENANT,
              requestId: claimed.request.id,
              effectId: compensationEffectId,
              disposition,
              actor: 'compensation-worker',
              outboxMessageId: claimed.outboxMessageId,
              outboxClaimToken: claimed.outboxClaimToken,
              response,
              evidence,
            }),
            { applied: true, disposition, replayed: false },
          );
          await assertTerminalTransitionHistory(
            harness,
            claimed,
            original.runId,
            beforeRun!.version,
            beforeOriginal!.version,
            beforeStep!.version,
            'FAILED',
            'FAILED',
            'step.failed',
            'run.failed',
            'run.failed',
          );
        } finally {
          harness.close();
        }
      });
    }
  });
}

async function assertTerminalTransitionHistory(
  harness: Harness,
  claimed: ClaimedCompensationRequest,
  originalRunId: string,
  previousCompensationRunVersion: number,
  previousOriginalRunVersion: number,
  previousStepVersion: number,
  compensationRunState: 'SUCCEEDED' | 'FAILED',
  originalRunState: 'COMPENSATED' | 'FAILED',
  stepEventType: 'step.succeeded' | 'step.failed',
  compensationRunEventType: 'run.succeeded' | 'run.failed',
  originalRunEventType: 'run.compensated' | 'run.failed',
): Promise<void> {
  const compensationRun = await harness.repository.getRun(
    claimed.request.compensationRunId,
    TENANT,
  );
  const originalRun = await harness.repository.getRun(originalRunId, TENANT);
  const step = await harness.repository.getStep(claimed.request.compensationStepId, TENANT);
  assert.equal(compensationRun?.state, compensationRunState);
  assert.equal(compensationRun?.version, previousCompensationRunVersion + 1);
  assert.equal(originalRun?.state, originalRunState);
  assert.equal(originalRun?.version, previousOriginalRunVersion + 1);
  assert.equal(step?.version, previousStepVersion + 1);

  const compensationEvents = await harness.repository.listEvents(
    claimed.request.compensationRunId,
    TENANT,
  );
  const originalEvents = await harness.repository.listEvents(originalRunId, TENANT);
  assert.equal(
    compensationEvents.some(
      (event) =>
        event.aggregateType === 'step' &&
        event.aggregateId === claimed.request.compensationStepId &&
        event.sequence === step?.version &&
        event.type === stepEventType,
    ),
    true,
  );
  assert.equal(
    compensationEvents.some(
      (event) =>
        event.aggregateType === 'run' &&
        event.aggregateId === claimed.request.compensationRunId &&
        event.sequence === compensationRun?.version &&
        event.type === compensationRunEventType,
    ),
    true,
  );
  assert.equal(
    originalEvents.some(
      (event) =>
        event.aggregateType === 'run' &&
        event.aggregateId === originalRunId &&
        event.sequence === originalRun?.version &&
        event.type === originalRunEventType,
    ),
    true,
  );
}
