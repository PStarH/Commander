/**
 * Unit tests for the WS2 compensation consumer (§8).
 *
 * Proves the two audit findings are closed:
 *   1. Failures call retryOutbox (error recorded + immediate backoff) instead
 *      of silently waiting for claim expiry.
 *   2. Retries are bounded: once attempts reach maxAttempts the message stops
 *      being served (mirroring sweepOutboxDlq's move-to-DLQ, which runs every
 *      kernel-ops timer cycle) — no infinite poison-message loop.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consumeCompensationBatch } from './compensationConsumer.js';
import type { CompensationOutboxMessage, CompensationOutboxPort } from './compensationConsumer.js';

const PAYLOAD = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  stepId: 'step-1',
  compensationAction: 'crm.compensate',
  compensationPayload: { undo: true },
};

/** Fake outbox mirroring kernel semantics: claim bumps attempts, retryOutbox
 *  records the error, and messages at maxAttempts are no longer served
 *  (the sweeper would have moved them to the DLQ). */
function makeOutbox(maxAttempts = 3) {
  const message: CompensationOutboxMessage & { errors: Array<{ code: string; message: string }>; acked: boolean } = {
    id: 'msg-1', topic: 'commander.compensation', key: 'run-1', payload: PAYLOAD,
    attempts: 0, claimToken: undefined, errors: [], acked: false,
  };
  const port: CompensationOutboxPort = {
    async claimOutboxByTopic(_topic, _limit) {
      if (message.acked || message.attempts >= maxAttempts) return [];
      message.attempts++;
      message.claimToken = `claim-${message.attempts}`;
      return [{ ...message }];
    },
    async markOutboxPublished(id, claimToken) {
      if (id !== message.id || claimToken !== message.claimToken) return false;
      message.acked = true;
      return true;
    },
    async retryOutbox(id, claimToken, error) {
      if (id !== message.id || claimToken !== message.claimToken) return false;
      message.errors.push(error);
      message.claimToken = undefined;
      return true;
    },
  };
  return { port, message };
}

const okBroker = {
  admit: async () => ({ admitted: true, effectId: 'e1', replayed: false }),
  executeAdmitted: async () => ({ effectId: 'e1', replayed: false, response: { ok: true } }),
};

describe('WS2 §8 compensation consumer', () => {
  it('acks the message only after admit→execute succeeds', async () => {
    const { port, message } = makeOutbox();
    const result = await consumeCompensationBatch(port, okBroker, async () => 'token', { workerId: 'w1' });
    assert.equal(result.succeeded, 1);
    assert.equal(message.acked, true);
    assert.equal(message.errors.length, 0);
  });

  it('records the error via retryOutbox when the token provider refuses', async () => {
    const { port, message } = makeOutbox();
    const result = await consumeCompensationBatch(port, okBroker, async () => null, { workerId: 'w1' });
    assert.equal(result.failed, 1);
    assert.equal(message.acked, false);
    assert.equal(message.errors[0]?.code, 'COMPENSATION_TOKEN_REFUSED');
  });

  it('records the error via retryOutbox when admit rejects', async () => {
    const { port, message } = makeOutbox();
    const rejectBroker = { ...okBroker, admit: async () => ({ admitted: false, effectId: '', replayed: false, reason: 'POLICY_DENIED' }) };
    await consumeCompensationBatch(port, rejectBroker, async () => 'token', { workerId: 'w1' });
    assert.equal(message.errors[0]?.code, 'COMPENSATION_ADMIT_REJECTED');
    assert.equal(message.errors[0]?.message, 'POLICY_DENIED');
  });

  it('bounds poison-message retries at maxAttempts (no infinite loop)', async () => {
    const maxAttempts = 3;
    const { port, message } = makeOutbox(maxAttempts);
    const throwBroker = { ...okBroker, executeAdmitted: async () => { throw new Error('connector down'); } };
    // Drain far more rounds than maxAttempts; the message must stop being served.
    for (let round = 0; round < maxAttempts * 3; round++) {
      await consumeCompensationBatch(port, throwBroker, async () => 'token', { workerId: 'w1' });
    }
    assert.equal(message.attempts, maxAttempts, 'attempts must stop at maxAttempts');
    assert.equal(message.errors.length, maxAttempts);
    assert.ok(message.errors.every((e) => e.code === 'COMPENSATION_EXECUTE_FAILED'));
    assert.equal(message.acked, false);
  });
});
