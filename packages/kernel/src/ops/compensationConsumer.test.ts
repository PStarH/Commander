import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  consumeCompensationBatch,
  type ClaimedCompensationWork,
  type CompensationOutboxPort,
} from './compensationConsumer.js';
import {
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from './compensationAuthority.js';

const WORKER = {
  workerId: 'compensation:pod-a',
  workerGeneration: 4,
  claimSecret: 'claim-secret-pod-a',
} as const;

function authorityInput(): GovernedCompensationAuthorizationInput {
  return {
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-1',
    requestId: 'request-1',
    tenantId: 'tenant-a',
    originalRunId: 'run-original',
    originalEffectId: 'effect-original',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-compensation',
    compensationStepId: 'step-compensation',
    compensationEffectId: 'effect-compensation',
    compensationEffectType: 'compensate.kubernetes.deployment.rollback',
    compensationRequest: {
      originalEffectId: 'effect-original',
      destination: 'k8s://cluster-a/default/deployments/api',
      forwardResponse: { originalRevision: '7' },
      compensationPatch: { targetRevision: '7', reason: 'rollback' },
    },
    idempotencyKey: 'cmp:effect-original:1.0.0',
    forwardReceipt: { originalRevision: '7' },
    adapterVersion: '1.0.0',
    policyDecisionId: 'decision-1',
    policySnapshotId: 'policy-42',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2099-07-29T11:00:00.000Z',
    approvalBinding: null,
  };
}

function claimed(
  authorization: GovernedCompensationAuthorization = sealGovernedCompensationAuthorization(
    authorityInput(),
  ),
): ClaimedCompensationWork {
  return {
    messageId: 'outbox-1',
    tenantId: authorization.tenantId,
    claimToken: 'outbox-claim-1',
    authorization,
    lease: {
      workerId: WORKER.workerId,
      workerGeneration: WORKER.workerGeneration,
      token: 'step-lease-1',
      fencingEpoch: 12,
    },
  };
}

function makePort(items: ClaimedCompensationWork[] = [claimed()]) {
  const calls: Array<{ method: string; input: unknown }> = [];
  let served = false;
  const port: CompensationOutboxPort = {
    async claimCompensationWork(input) {
      calls.push({ method: 'claim', input });
      if (served) return [];
      served = true;
      return items;
    },
    async completeCompensationWork(input) {
      calls.push({ method: 'complete', input });
      return { applied: true, disposition: 'COMPLETED' };
    },
    async handoffCompensationUnknown(input) {
      calls.push({ method: 'handoff', input });
      return { applied: true, disposition: 'HANDOFF_UNKNOWN' };
    },
    async escalateCompensationWork(input) {
      calls.push({ method: 'escalate', input });
      return { applied: true, disposition: 'ESCALATED' };
    },
  };
  return {
    port,
    calls,
    resetClaim: () => {
      served = false;
    },
  };
}

const registry = {
  resolve: (effectType: string) =>
    effectType === 'compensate.kubernetes.deployment.rollback'
      ? { descriptor: { adapterVersion: '1.0.0' } }
      : null,
};

describe('governed compensation consumer', () => {
  it('uses persisted authorization, effect identity, and a real claimed step lease', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    let tokenInput: unknown;
    let admitInput: unknown;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit(input) {
          admitInput = input;
          return {
            admitted: true,
            effectId: work.authorization.compensationEffectId,
            replayed: false,
          };
        },
        async executeAdmitted() {
          return {
            effectId: work.authorization.compensationEffectId,
            replayed: false,
            response: { status: 'rolled-back' },
          };
        },
      },
      async (input) => {
        tokenInput = input;
        return 'governed-token';
      },
      { ...WORKER, registry, limit: 10 },
    );

    assert.deepEqual(result, {
      consumed: 1,
      succeeded: 1,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.equal(tokenInput, work.authorization);
    assert.deepEqual(admitInput, {
      effectId: work.authorization.compensationEffectId,
      token: 'governed-token',
      type: work.authorization.compensationEffectType,
      request: work.authorization.compensationRequest,
      idempotencyKey: work.authorization.idempotencyKey,
      lease: work.lease,
      actor: WORKER.workerId,
      workloadBinding: {
        tenantId: work.authorization.tenantId,
        runId: work.authorization.compensationRunId,
        stepId: work.authorization.compensationStepId,
        workloadId: WORKER.workerId,
      },
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'complete'],
    );
    assert.deepEqual(calls[1]?.input, {
      ...WORKER,
      tenantId: work.tenantId,
      messageId: work.messageId,
      outboxClaimToken: work.claimToken,
      compensationEffectId: work.authorization.compensationEffectId,
      response: { status: 'rolled-back' },
    });
  });

  it('atomically hands off completion uncertainty and never retries the write', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    let executeCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          return {
            admitted: true,
            effectId: work.authorization.compensationEffectId,
            replayed: false,
          };
        },
        async executeAdmitted() {
          executeCalls += 1;
          throw Object.assign(new Error('response lost'), { code: 'COMPLETION_UNKNOWN' });
        },
      },
      async () => 'token',
      { ...WORKER, registry },
    );

    assert.equal(executeCalls, 1);
    assert.deepEqual(result, {
      consumed: 1,
      succeeded: 0,
      handedOff: 1,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'handoff'],
    );
    assert.deepEqual(calls[1]?.input, {
      ...WORKER,
      tenantId: work.tenantId,
      messageId: work.messageId,
      outboxClaimToken: work.claimToken,
      compensationEffectId: work.authorization.compensationEffectId,
      error: { code: 'COMPLETION_UNKNOWN', message: 'Compensation completion is uncertain' },
    });
  });

  it('escalates mutated authorization before token issuance or adapter invocation', async () => {
    const valid = claimed();
    const mutated = claimed({
      ...valid.authorization,
      compensationRequest: {
        ...valid.authorization.compensationRequest,
        compensationPatch: { targetRevision: '8', reason: 'caller mutation' },
      },
    });
    const { port, calls } = makePort([mutated]);
    let tokenCalls = 0;
    let brokerCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          brokerCalls += 1;
          throw new Error('must not admit');
        },
        async executeAdmitted() {
          brokerCalls += 1;
          throw new Error('must not execute');
        },
      },
      async () => {
        tokenCalls += 1;
        return 'token';
      },
      { ...WORKER, registry },
    );

    assert.equal(tokenCalls, 0);
    assert.equal(brokerCalls, 0);
    assert.equal(result.escalated, 1);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'escalate'],
    );
    assert.equal(
      (calls[1]?.input as { reason: string }).reason,
      'COMPENSATION_REQUEST_HASH_MISMATCH',
    );
  });

  it('escalates adapter-version drift before token issuance or adapter invocation', async () => {
    const { port, calls } = makePort();
    let tokenCalls = 0;
    let brokerCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          brokerCalls += 1;
          throw new Error('must not admit');
        },
        async executeAdmitted() {
          brokerCalls += 1;
          throw new Error('must not execute');
        },
      },
      async () => {
        tokenCalls += 1;
        return 'token';
      },
      {
        ...WORKER,
        registry: {
          resolve: () => ({ descriptor: { adapterVersion: '2.0.0' } }),
        },
      },
    );

    assert.equal(tokenCalls, 0);
    assert.equal(brokerCalls, 0);
    assert.equal(result.escalated, 1);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'escalate'],
    );
    assert.equal(
      (calls[1]?.input as { reason: string }).reason,
      'COMPENSATION_ADAPTER_VERSION_MISMATCH',
    );
  });

  it('fails the tick without a second mutation when atomic completion loses its claim', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    port.completeCompensationWork = async (input) => {
      calls.push({ method: 'complete', input });
      return { applied: false, reason: 'CLAIM_NOT_OWNED' };
    };

    await assert.rejects(
      () =>
        consumeCompensationBatch(
          port,
          {
            async admit() {
              return {
                admitted: true,
                effectId: work.authorization.compensationEffectId,
                replayed: false,
              };
            },
            async executeAdmitted() {
              return {
                effectId: work.authorization.compensationEffectId,
                replayed: false,
                response: {},
              };
            },
          },
          async () => 'token',
          { ...WORKER, registry },
        ),
      { code: 'COMPENSATION_CLAIM_NOT_OWNED' },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'complete'],
    );
  });

  it('allows only one of two concurrent workers to own and execute a claim', async () => {
    const work = claimed();
    let available = true;
    let executeCalls = 0;
    const port = makePort([]).port;
    port.claimCompensationWork = async (input) => {
      if (!available || input.workerId !== WORKER.workerId) return [];
      available = false;
      return [work];
    };
    const broker = {
      async admit() {
        return {
          admitted: true,
          effectId: work.authorization.compensationEffectId,
          replayed: false,
        };
      },
      async executeAdmitted() {
        executeCalls += 1;
        return { effectId: work.authorization.compensationEffectId, replayed: false, response: {} };
      },
    };

    const [owner, other] = await Promise.all([
      consumeCompensationBatch(port, broker, async () => 'token', { ...WORKER, registry }),
      consumeCompensationBatch(port, broker, async () => 'token', {
        workerId: 'compensation:pod-b',
        workerGeneration: 9,
        claimSecret: 'claim-secret-pod-b',
        registry,
      }),
    ]);

    assert.equal(owner.consumed + other.consumed, 1);
    assert.equal(executeCalls, 1);
  });

  it('replays the same durable effect after a post-commit finalize crash without a second remote write', async () => {
    const work = claimed();
    const { port, resetClaim } = makePort([work]);
    let finalizeCalls = 0;
    port.completeCompensationWork = async () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1)
        throw Object.assign(new Error('database disconnected'), { code: 'DB_LOST' });
      return { applied: true, disposition: 'COMPLETED' };
    };
    let remoteWrites = 0;
    let committed = false;
    const broker = {
      async admit() {
        return {
          admitted: true,
          effectId: work.authorization.compensationEffectId,
          replayed: committed,
        };
      },
      async executeAdmitted() {
        if (!committed) {
          remoteWrites += 1;
          committed = true;
        }
        return {
          effectId: work.authorization.compensationEffectId,
          replayed: committed,
          response: { status: 'rolled-back' },
        };
      },
    };

    await assert.rejects(
      () => consumeCompensationBatch(port, broker, async () => 'token', { ...WORKER, registry }),
      { code: 'DB_LOST' },
    );
    resetClaim();
    const replay = await consumeCompensationBatch(port, broker, async () => 'token', {
      ...WORKER,
      registry,
    });

    assert.equal(replay.succeeded, 1);
    assert.equal(remoteWrites, 1);
    assert.equal(finalizeCalls, 2);
  });
});
