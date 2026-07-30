import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consumeCompensationBatch, type CompensationOutboxPort } from '@commander/kernel';
import {
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from '../../../kernel/src/ops/compensationAuthority.js';

const WORKER_ID = 'compensation:chaos-pod';

type ClaimedCompensationWork = Awaited<
  ReturnType<CompensationOutboxPort['claimCompensationWork']>
>[number];

function authorityInput(): GovernedCompensationAuthorizationInput {
  return {
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-chaos',
    requestId: 'request-chaos',
    tenantId: 'tenant-chaos',
    originalRunId: 'run-forward',
    originalEffectId: 'effect-forward',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-compensation',
    compensationStepId: 'step-compensation',
    compensationEffectId: 'effect-compensation-stable',
    compensationEffectType: 'compensate.github.pull-request.create',
    compensationRequest: {
      originalEffectId: 'effect-forward',
      destination: 'github://octo/repo/pulls',
      forwardResponse: { prNumber: 42 },
      compensationPatch: {},
    },
    idempotencyKey: 'cmp:effect-forward:1.0.0',
    forwardReceipt: { prNumber: 42, state: 'open' },
    adapterVersion: '1.0.0',
    policyDecisionId: 'decision-chaos',
    policySnapshotId: 'policy-chaos',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2099-07-29T11:00:00.000Z',
    approvalBinding: null,
  };
}

function workForGeneration(workerGeneration: number): ClaimedCompensationWork {
  const authorization = sealGovernedCompensationAuthorization(authorityInput());
  return {
    messageId: 'outbox-compensation-stable',
    tenantId: authorization.tenantId,
    claimToken: `outbox-claim-generation-${workerGeneration}`,
    authorization,
    lease: {
      workerId: WORKER_ID,
      workerGeneration,
      token: `step-lease-generation-${workerGeneration}`,
      fencingEpoch: workerGeneration,
    },
  };
}

describe('L4-02 operations chaos - compensation worker kill/restart', () => {
  it('reclaims with a new generation and replays one stable effect without a second remote write', async () => {
    const claims: Array<{ workerId: string; workerGeneration: number; claimSecret: string }> = [];
    let completeCalls = 0;
    const port: CompensationOutboxPort = {
      async claimCompensationWork(input) {
        claims.push(input);
        return [workForGeneration(input.workerGeneration)];
      },
      async completeCompensationWork() {
        completeCalls += 1;
        if (completeCalls === 1) {
          throw Object.assign(new Error('worker died after remote commit'), {
            code: 'DB_CONNECTION_LOST',
          });
        }
        return { applied: true, disposition: 'COMPLETED' };
      },
      async handoffCompensationUnknown() {
        throw new Error('known committed response must not be handed off');
      },
      async escalateCompensationWork() {
        throw new Error('valid governed work must not be escalated');
      },
    };

    let remoteWrites = 0;
    let remotelyCommitted = false;
    const admittedEffectIds: string[] = [];
    const broker = {
      async admit(input: { effectId: string }) {
        admittedEffectIds.push(input.effectId);
        return {
          admitted: true,
          effectId: input.effectId,
          replayed: remotelyCommitted,
        };
      },
      async executeAdmitted(input: { effectId: string }) {
        const replayed = remotelyCommitted;
        if (!remotelyCommitted) {
          remoteWrites += 1;
          remotelyCommitted = true;
        }
        return {
          effectId: input.effectId,
          replayed,
          response: { prNumber: 42, state: 'closed' },
        };
      },
    };
    const registry = {
      resolve: (effectType: string) =>
        effectType === 'compensate.github.pull-request.create'
          ? { descriptor: { adapterVersion: '1.0.0' } }
          : null,
    };

    await assert.rejects(
      () =>
        consumeCompensationBatch(port, broker, async () => 'token-generation-4', {
          workerId: WORKER_ID,
          workerGeneration: 4,
          claimSecret: 'secret-generation-4',
          registry,
        }),
      { code: 'DB_CONNECTION_LOST' },
    );

    const replay = await consumeCompensationBatch(port, broker, async () => 'token-generation-5', {
      workerId: WORKER_ID,
      workerGeneration: 5,
      claimSecret: 'secret-generation-5',
      registry,
    });

    assert.equal(replay.succeeded, 1);
    assert.equal(remoteWrites, 1);
    assert.equal(completeCalls, 2);
    assert.deepEqual(admittedEffectIds, [
      'effect-compensation-stable',
      'effect-compensation-stable',
    ]);
    assert.deepEqual(claims, [
      {
        workerId: WORKER_ID,
        workerGeneration: 4,
        claimSecret: 'secret-generation-4',
        topic: 'commander.kernel.compensation.requested',
        limit: 50,
      },
      {
        workerId: WORKER_ID,
        workerGeneration: 5,
        claimSecret: 'secret-generation-5',
        topic: 'commander.kernel.compensation.requested',
        limit: 50,
      },
    ]);
  });
});
