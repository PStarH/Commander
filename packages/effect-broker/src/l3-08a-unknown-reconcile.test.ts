/**
 * L3-08a — UNKNOWN reconcile minimal loop (TDD).
 *
 * After COMPLETION_UNKNOWN, query remote outcome and advance the ledger
 * without re-invoking the external write executor.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  type EffectKernelPort,
  type EffectOutcomeQuerier,
  type EffectRemoteOutcome,
} from './index.js';

const grantBase = {
  jti: 'jti-1',
  tenantId: 'tenant',
  runId: 'run',
  stepId: 'step',
  effectTypes: ['ticket.create'],
  issuedAt: new Date(Date.now() - 1_000).toISOString(),
  notBefore: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  issuer: 'commander-worker',
  audience: 'commander.effect-broker',
  keyId: 'k1',
  nonce: 'n1',
};

function makeTokens() {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'k1',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { k1: issuer.publicKey },
  });
  return { issuer, tokens };
}

/** Minimal ledger double that supports UNKNOWN → reconcile. */
function makeLedgerKernel() {
  const effects = new Map<
    string,
    {
      id: string;
      state: string;
      type: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
      response?: Record<string, unknown>;
      runId: string;
      stepId: string;
      tenantId: string;
    }
  >();
  const byKey = new Map<string, string>();

  const kernel: EffectKernelPort = {
    admitEffect: async (input) => {
      const key = `${input.tenantId}:${input.idempotencyKey}`;
      const priorId = byKey.get(key);
      if (priorId) {
        const prior = effects.get(priorId)!;
        return { admitted: true, replayed: true, effect: { ...prior } };
      }
      const effect = {
        id: input.id,
        state: 'ADMITTED',
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        request: input.request,
        runId: input.runId,
        stepId: input.stepId,
        tenantId: input.tenantId,
      };
      effects.set(effect.id, effect);
      byKey.set(key, effect.id);
      return { admitted: true, replayed: false, effect: { ...effect } };
    },
    completeEffect: async (effectId, tenantId, _lease, response) => {
      const effect = effects.get(effectId);
      if (!effect || effect.tenantId !== tenantId || effect.state !== 'ADMITTED') return null;
      effect.state = 'COMPLETED';
      effect.response = response;
      return { ...effect };
    },
    markEffectCompletionUnknown: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'ADMITTED') return null;
      effect.state = 'COMPLETION_UNKNOWN';
      effect.response = { reason: input.reason };
      return { ...effect };
    },
    getEffect: async (effectId, tenantId) => {
      const effect = effects.get(effectId);
      if (!effect || effect.tenantId !== tenantId) return null;
      return { ...effect };
    },
    reconcileEffect: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'COMPLETION_UNKNOWN') {
        return null;
      }
      effect.state = input.state;
      effect.response = input.response;
      return { ...effect };
    },
  };

  return { kernel, effects };
}

describe('L3-08a UNKNOWN reconcile', () => {
  it('reconciles COMPLETION_UNKNOWN → COMPLETED via queryOutcome without re-invoke', async () => {
    const { issuer, tokens } = makeTokens();
    const { kernel, effects } = makeLedgerKernel();
    let invokeCount = 0;
    const remoteByIdem = new Map<string, Record<string, unknown>>();

    const querier: EffectOutcomeQuerier = {
      async queryOutcome(input): Promise<EffectRemoteOutcome> {
        const hit = remoteByIdem.get(input.idempotencyKey);
        if (!hit) return { status: 'UNKNOWN' };
        return { status: 'COMPLETED', response: hit };
      },
    };

    const audit: Array<{ type: string; details: Record<string, unknown> }> = [];
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      {
        execute: async (input) => {
          invokeCount += 1;
          const ticket = { ticketId: 'T-100', title: input.request.title };
          remoteByIdem.set(String(input.request.idempotencyKey ?? 'missing'), ticket);
          // Simulate: remote committed but kernel complete fails (crash window).
          return ticket;
        },
      },
      {
        append: async (event) => {
          audit.push({ type: event.type, details: event.details });
        },
      },
    );

    // Force completeEffect to fail after first execute so broker marks UNKNOWN.
    let completeCalls = 0;
    const originalComplete = kernel.completeEffect.bind(kernel);
    kernel.completeEffect = async (effectId, tenantId, lease, response, actor) => {
      completeCalls += 1;
      if (completeCalls === 1) return null;
      return originalComplete(effectId, tenantId, lease, response, actor);
    };

    const request = { title: 'Refund', idempotencyKey: 'idem-ticket-1' };
    const grant = {
      ...grantBase,
      effectTypes: ['ticket.create'],
      requestHash: canonicalRequestHash(request),
    };
    await assert.rejects(
      () =>
        broker.execute({
          effectId: 'eff-1',
          token: issuer.issue(grant),
          type: 'ticket.create',
          request,
          idempotencyKey: 'idem-ticket-1',
          lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
          actor: 'w1',
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === 'COMPLETION_UNCONFIRMED',
    );
    assert.equal(invokeCount, 1);
    assert.equal(effects.get('eff-1')?.state, 'COMPLETION_UNKNOWN');

    // Chaos: remote already has the ticket. Reconcile must NOT call executor again.
    const result = await broker.reconcileUnknown({
      effectId: 'eff-1',
      tenantId: 'tenant',
      actor: 'reconciler',
      querier,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.invokedExecutor, false);
    assert.equal(invokeCount, 1, 'reconcile must never re-invoke the write executor');
    assert.equal(effects.get('eff-1')?.state, 'COMPLETED');
    assert.equal((effects.get('eff-1')?.response as { ticketId?: string })?.ticketId, 'T-100');
    assert.ok(audit.some((e) => e.type === 'effect.reconciled'));
  });

  it('escalates when queryOutcome is still UNKNOWN', async () => {
    const { tokens } = makeTokens();
    const { kernel, effects } = makeLedgerKernel();
    effects.set('eff-esc', {
      id: 'eff-esc',
      state: 'COMPLETION_UNKNOWN',
      type: 'ticket.create',
      idempotencyKey: 'idem-esc',
      request: { title: 'x' },
      runId: 'run',
      stepId: 'step',
      tenantId: 'tenant',
    });

    const audit: string[] = [];
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      { execute: async () => ({}) },
      {
        append: async (event) => {
          audit.push(event.type);
        },
      },
    );

    const result = await broker.reconcileUnknown({
      effectId: 'eff-esc',
      tenantId: 'tenant',
      actor: 'reconciler',
      querier: {
        async queryOutcome() {
          return { status: 'UNKNOWN' };
        },
      },
    });
    assert.equal(result.status, 'ESCALATED');
    assert.equal(result.invokedExecutor, false);
    assert.equal(effects.get('eff-esc')?.state, 'COMPLETION_UNKNOWN');
    assert.ok(audit.includes('effect.reconcile_escalated'));
  });

  it('rejects reconcile when effect is not COMPLETION_UNKNOWN', async () => {
    const { tokens } = makeTokens();
    const { kernel, effects } = makeLedgerKernel();
    effects.set('eff-done', {
      id: 'eff-done',
      state: 'COMPLETED',
      type: 'ticket.create',
      idempotencyKey: 'idem-done',
      request: {},
      response: { ok: true },
      runId: 'run',
      stepId: 'step',
      tenantId: 'tenant',
    });

    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      { execute: async () => ({}) },
      { append: async () => undefined },
    );

    await assert.rejects(
      () =>
        broker.reconcileUnknown({
          effectId: 'eff-done',
          tenantId: 'tenant',
          actor: 'reconciler',
          querier: {
            async queryOutcome() {
              return { status: 'COMPLETED', response: {} };
            },
          },
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === 'EFFECT_NOT_UNKNOWN',
    );
  });
});
