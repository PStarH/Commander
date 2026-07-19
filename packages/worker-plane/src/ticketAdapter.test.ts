/**
 * L3-08a — InMemoryTicketAdapter + EffectBroker.reconcileUnknown chaos path.
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
} from '@commander/effect-broker';
import { InMemoryTicketAdapter } from './ticketAdapter.js';

const grantBase = {
  jti: 'jti-ticket',
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

describe('L3-08a InMemoryTicketAdapter chaos', () => {
  it('compensates a created ticket by idempotency key without deleting its audit identity', async () => {
    const tickets = new InMemoryTicketAdapter();
    const created = await tickets.create({
      tenantId: 'tenant',
      idempotencyKey: 'idem-reversible-1',
      title: 'Reversible ticket',
    });
    assert.equal(created.status, 'open');

    const compensated = await tickets.compensate({
      tenantId: 'tenant',
      idempotencyKey: 'idem-reversible-1',
    });
    assert.equal(compensated.ticketId, created.ticketId);
    assert.equal(compensated.status, 'closed');

    const outcome = await tickets.queryOutcome({
      effectId: 'effect-create',
      idempotencyKey: 'idem-reversible-1',
      type: 'demo.ticket.create',
      request: {},
      tenantId: 'tenant',
    });
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.response?.status, 'closed');
  });

  it('timeout-after-remote-commit reconciles COMPLETED without second create', async () => {
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

    const tickets = new InMemoryTicketAdapter();
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
          return { admitted: true, replayed: true, effect: { ...effects.get(priorId)! } };
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
      completeEffect: async () => null, // always fail ledger confirm → UNKNOWN
      markEffectCompletionUnknown: async (input) => {
        const effect = effects.get(input.effectId);
        if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'ADMITTED') return null;
        effect.state = 'COMPLETION_UNKNOWN';
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
          const record = await tickets.create({
            tenantId: input.executionContext!.tenantId,
            idempotencyKey: String(input.request.idempotencyKey ?? ''),
            title: String(input.request.title ?? ''),
          });
          return { ticketId: record.ticketId, title: record.title, status: record.status };
        },
      },
      { append: async () => undefined },
      { localWorkerId: 'w1' },
    );

    const request = { title: 'Seat change', idempotencyKey: 'idem-seat-1' };
    await assert.rejects(
      () =>
        broker.execute({
          effectId: 'eff-ticket',
          token: issuer.issue({ ...grantBase, requestHash: canonicalRequestHash(request) }),
          type: 'ticket.create',
          request,
          idempotencyKey: 'idem-seat-1',
          lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1 },
          actor: 'w1',
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === 'COMPLETION_UNCONFIRMED',
    );
    assert.equal(tickets.createInvocations, 1);
    assert.equal(effects.get('eff-ticket')?.state, 'COMPLETION_UNKNOWN');

    const reconciled = await broker.reconcileUnknown({
      effectId: 'eff-ticket',
      tenantId: 'tenant',
      actor: 'reconciler',
      querier: tickets,
    });
    assert.equal(reconciled.status, 'COMPLETED');
    assert.equal(reconciled.invokedExecutor, false);
    assert.equal(tickets.createInvocations, 1, 'chaos: no second remote write');
    assert.equal(effects.get('eff-ticket')?.state, 'COMPLETED');
  });
});
