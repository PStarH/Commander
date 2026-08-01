import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompensationOutboxPort } from '@commander/kernel';
import { CompensationDaemon } from './compensationDaemon.js';
import { canonicalCompensationHash } from '../../kernel/src/ops/compensationAuthority.js';

const WORKER = {
  workerId: 'compensation:pod-a',
  workerGeneration: 3,
  claimSecret: 'claim-secret-pod-a',
} as const;

type ClaimedCompensationWork = Awaited<
  ReturnType<CompensationOutboxPort['claimCompensationWork']>
>[number];

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function emptyPort(
  claim?: CompensationOutboxPort['claimCompensationWork'],
): CompensationOutboxPort {
  return {
    claimCompensationWork: claim ?? (async () => []),
    completeCompensationWork: async () => ({ applied: true, disposition: 'COMPLETED' }),
    handoffCompensationUnknown: async () => ({ applied: true, disposition: 'HANDOFF_UNKNOWN' }),
    escalateCompensationWork: async () => ({ applied: true, disposition: 'ESCALATED' }),
  };
}

function daemonFor(input: {
  repository?: CompensationOutboxPort;
  heartbeat?: () => Promise<void>;
  drain?: () => Promise<void>;
  onFatalInvariant?: (reason: string) => Promise<void>;
}) {
  return new CompensationDaemon({
    ...WORKER,
    repository: input.repository ?? emptyPort(),
    registry: { resolve: () => ({}) } as never,
    broker: {} as never,
    tokenProvider: async () => 'token',
    pollIntervalMs: 60_000,
    batchSize: 10,
    heartbeat: input.heartbeat,
    drain: input.drain,
    onFatalInvariant: input.onFatalInvariant,
  });
}

describe('CompensationDaemon', () => {
  it('passes the broker-signed receipt into durable COMPLETED finalization', async () => {
    const forwardResponse = { remoteId: 'remote-a' };
    const compensationPatch = { remoteId: 'remote-a' };
    const actionDigest = canonicalCompensationHash({
      type: 'compensate.http.post',
      originalEffectId: 'effect-forward',
      adapterVersion: 'adapter-v1',
      forwardResponse,
      compensationPatch,
    });
    const authorization = {
      id: 'authorization-a',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationEffectType: 'compensate.http.post',
      adapterVersion: 'adapter-v1',
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      policyDecisionId: 'decision-a',
      policySnapshotId: 'snapshot-a',
      decision: 'allow' as const,
      actionDigest,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const request = {
      id: 'request-a',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      adapterVersion: 'adapter-v1',
      compensationEffectType: 'compensate.http.post',
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      authorizationId: 'authorization-a',
      reconcilePolicy: {
        maxAttempts: 3,
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      },
      state: 'CLAIMED' as const,
      compensationEffectId: 'effect-compensation',
    };
    const evidence = {
      tenantId: 'tenant-a',
      runId: 'run-compensation',
      bundleId: 'evidence_effect-compensation',
      actionDigest,
      body: {},
      contentHash: 'c'.repeat(64),
      signature: {
        algorithm: 'Ed25519' as const,
        keyId: 'test-key',
        signedAt: '2026-07-30T00:00:00.000Z',
        value: 'signature',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
      anchoredAt: '2026-07-30T00:00:00.000Z',
      retentionUntil: '2027-07-30T00:00:00.000Z',
    };
    let finalized: Record<string, unknown> | undefined;
    const repository = {
      ...emptyPort(async () => [{
        request,
        authorization,
        forwardResponse,
        lease: { ...WORKER, token: 'claim-a', fencingEpoch: 4 },
        outboxMessageId: 'outbox-a',
        outboxClaimToken: 'claim-a',
      }]),
      getEvidence: async () => evidence,
      listEffectsForRun: async () => [],
      listEvents: async () => [],
      finalizeCompensation: async (input: Record<string, unknown>) => {
        finalized = input;
        return { applied: true as const, disposition: 'COMPLETED' as const, replayed: false };
      },
    };
    const daemon = new CompensationDaemon({
      ...WORKER,
      repository: repository as never,
      evidenceRepository: repository as never,
      registry: { resolve: () => ({ descriptor: { adapterVersion: 'adapter-v1' } }) } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'effect-compensation', replayed: false }),
        executeAdmitted: async () => ({
          effectId: 'effect-compensation',
          replayed: false,
          response: { restored: true },
        }),
      } as never,
      tokenProvider: async () => 'token',
      evidenceSigner: {
        sign: async () => evidence.signature,
        verify: () => true,
      },
      pollIntervalMs: 60_000,
    });

    assert.equal((await daemon.tick()).succeeded, 1);
    assert.deepEqual(finalized?.evidence, evidence);
  });

  it('heartbeats only after a real governed zero-claim tick', async () => {
    let claimInput: unknown;
    let heartbeats = 0;
    const daemon = daemonFor({
      repository: emptyPort(async (input) => {
        claimInput = input;
        return [];
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
    });

    assert.deepEqual(await daemon.tick(), {
      consumed: 0,
      succeeded: 0,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(claimInput, {
      ...WORKER,
      topic: 'commander.kernel.compensation.requested',
      limit: 10,
    });
    assert.equal(heartbeats, 1);
    assert.ok(daemon.getHealth().lastSucceededAt);
  });

  it('does not heartbeat and invokes safe-stop on a fatal claim failure', async () => {
    const failure = Object.assign(new Error('claim authority unavailable'), {
      code: 'COMPENSATION_CLAIM_UNAVAILABLE',
    });
    let heartbeats = 0;
    const safeStops: string[] = [];
    const daemon = daemonFor({
      repository: emptyPort(async () => {
        throw failure;
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
      onFatalInvariant: async (reason) => {
        safeStops.push(reason);
      },
    });

    await assert.rejects(() => daemon.tick(), failure);
    assert.equal(heartbeats, 0);
    assert.deepEqual(safeStops, ['COMPENSATION_CLAIM_UNAVAILABLE']);
    assert.equal(daemon.getHealth().lastSucceededAt, undefined);
    assert.equal(daemon.getHealth().lastErrorCode, 'COMPENSATION_CLAIM_UNAVAILABLE');
  });

  it('starts one immediate tick, skips overlap, then drains', async () => {
    let releaseClaim: ((work: ClaimedCompensationWork[]) => void) | undefined;
    const claimed = new Promise<ClaimedCompensationWork[]>((resolve) => {
      releaseClaim = resolve;
    });
    let claimCalls = 0;
    let heartbeats = 0;
    let drains = 0;
    const daemon = daemonFor({
      repository: emptyPort(async () => {
        claimCalls += 1;
        return claimed;
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
      drain: async () => {
        drains += 1;
      },
    });

    daemon.start();
    await waitFor(() => claimCalls === 1);
    assert.equal(daemon.getHealth().inFlight, true);
    assert.deepEqual(await daemon.tick(), {
      consumed: 0,
      succeeded: 0,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.equal(daemon.getHealth().skippedOverlappingTicks, 1);

    const stopping = daemon.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drains, 0);
    releaseClaim?.([]);
    await stopping;
    assert.equal(heartbeats, 1);
    assert.equal(drains, 1);
    assert.equal(daemon.getHealth().running, false);
  });
});
