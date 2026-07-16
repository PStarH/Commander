/**
 * WS2 Compensation Consumer — drains `commander.compensation` outbox messages
 * and executes each as a unified EffectEnvelope through the EffectBroker.
 *
 * Why a separate consumer (vs. the generic OutboxPublisher):
 *   - Compensation effects MUST go through EffectBroker.admit().execute() so
 *     they share the same audit ledger, idempotency, and capability checks
 *     as forward effects (WS2 §8.3: "补偿不得走特权通道").
 *   - The generic publisher hands payloads to an EventPublisher (Kafka/etc.);
 *     compensation needs actual side-effect execution, not event publication.
 *
 * The consumer is fail-closed: if no token provider or EffectBroker is wired,
 * it rejects the message (leaving it for retry / DLQ) rather than executing
 * without authorization.
 */

import { randomUUID } from 'node:crypto';
import type { EffectEnvelope } from '@commander/contracts';

/** Outbox port scoped to a single topic (WS2 adds claimOutboxByTopic). */
export interface CompensationOutboxPort {
  claimOutboxByTopic(topic: string, limit: number, now?: Date): Promise<CompensationOutboxMessage[]>;
  markOutboxPublished(messageId: string, claimToken: string): Promise<boolean>;
  /** Release a failed claim immediately with exponential backoff + recorded
   *  error, instead of waiting for the 60s claim expiry. Messages whose
   *  attempts reach max_attempts are moved to the DLQ by sweepOutboxDlq
   *  (scheduled every kernel-ops timer cycle) — no infinite retry. */
  retryOutbox(messageId: string, claimToken: string, error: { code: string; message: string }, now?: Date): Promise<boolean>;
}

export interface CompensationOutboxMessage {
  id: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  claimToken?: string;
  attempts: number;
}

/** Minimal EffectBroker surface the consumer depends on. */
export interface CompensationEffectBroker {
  admit(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
  }): Promise<{ admitted: boolean; effectId: string; replayed: boolean; reason?: string }>;
  executeAdmitted(input: { effectId: string; timeoutMs?: number }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }>;
}

/**
 * Mints a short-lived compensation capability token for a single effect.
 * In production this calls the Gateway; the port keeps the consumer decoupled
 * from HTTP. Returns null if the token cannot be minted (consumer then leaves
 * the message for retry).
 */
export interface CompensationTokenProvider {
  (input: {
    tenantId: string;
    runId: string;
    stepId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<string | null>;
}

export interface CompensationConsumerOptions {
  /** Outbox topic to drain. Defaults to `commander.compensation`. */
  topic?: string;
  /** Max messages per poll. Defaults to 50. */
  limit?: number;
  /** Per-effect execution timeout. Defaults to 30000ms. */
  timeoutMs?: number;
  /** Worker identity for the lease field. */
  workerId: string;
  /** Fencing epoch for the lease. Defaults to 1. */
  fencingEpoch?: number;
}

export interface CompensationConsumeResult {
  consumed: number;
  succeeded: number;
  failed: number;
  replayed: number;
}

/** Payload shape expected on each `commander.compensation` outbox message. */
interface CompensationPayload {
  tenantId?: string;
  runId?: string;
  stepId?: string;
  originalEffectId?: string;
  compensationAction?: string;
  compensationPayload?: Record<string, unknown>;
  idempotencyKey?: string;
}

const DEFAULT_TOPIC = 'commander.compensation';

/**
 * Claim and execute one batch of compensation effects. Returns counts so a
 * caller can poll in a loop. Failures leave the message claimed-but-unacked
 * so the outbox retry/DLQ machinery (attempts++, backoff, DLQ sweep) handles
 * them — the consumer never silently swallows a compensation failure.
 */
export async function consumeCompensationBatch(
  outbox: CompensationOutboxPort,
  broker: CompensationEffectBroker,
  tokenProvider: CompensationTokenProvider,
  options: CompensationConsumerOptions,
): Promise<CompensationConsumeResult> {
  const topic = options.topic ?? DEFAULT_TOPIC;
  const limit = options.limit ?? 50;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fencingEpoch = options.fencingEpoch ?? 1;

  const messages = await outbox.claimOutboxByTopic(topic, limit);
  let succeeded = 0;
  let failed = 0;
  let replayed = 0;

  for (const message of messages) {
    if (!message.claimToken) { failed++; continue; }
    const payload = message.payload as CompensationPayload;
    if (!payload.tenantId || !payload.runId || !payload.stepId || !payload.compensationAction) {
      // Malformed compensation message — ack it so it doesn't loop forever;
      // the audit gap is visible via the missing effect row.
      await outbox.markOutboxPublished(message.id, message.claimToken);
      failed++;
      continue;
    }

    const effectId = `cmp_${randomUUID()}`;
    const idempotencyKey = payload.idempotencyKey ?? `cmp:${message.id}`;

    try {
      const token = await tokenProvider({
        tenantId: payload.tenantId,
        runId: payload.runId,
        stepId: payload.stepId,
        action: payload.compensationAction,
        payload: payload.compensationPayload ?? {},
      });
      if (!token) {
        // Token provider refused — record and back off (DLQ once max_attempts).
        await outbox.retryOutbox(message.id, message.claimToken!, { code: 'COMPENSATION_TOKEN_REFUSED', message: 'token provider returned null' });
        failed++;
        continue;
      }

      const admission = await broker.admit({
        effectId,
        token,
        type: payload.compensationAction,
        request: payload.compensationPayload ?? {},
        idempotencyKey,
        lease: { workerId: options.workerId, token: `cmp-lease:${message.id}`, fencingEpoch },
        actor: `compensation-consumer:${options.workerId}`,
      });
      if (!admission.admitted) {
        await outbox.retryOutbox(message.id, message.claimToken!, { code: 'COMPENSATION_ADMIT_REJECTED', message: admission.reason ?? 'unknown' });
        failed++;
        continue;
      }
      if (admission.replayed) replayed++;

      const result = await broker.executeAdmitted({ effectId, timeoutMs });
      // Ack the outbox message only after the effect committed in the kernel.
      const acked = await outbox.markOutboxPublished(message.id, message.claimToken!);
      if (acked) succeeded++;
      else failed++;
      // Reference result so unused-var lint stays quiet; the audit trail lives
      // in the kernel effect ledger (commander_effects) and AuditSink.
      void result;
    } catch (error) {
      // Executor threw or completion unconfirmed — record + back off; the
      // sweeper moves the message to DLQ once attempts >= max_attempts.
      try {
        await outbox.retryOutbox(message.id, message.claimToken!, { code: 'COMPENSATION_EXECUTE_FAILED', message: error instanceof Error ? error.message : String(error) });
      } catch { /* claim may have expired; sweeper backoff still applies */ }
      failed++;
    }
  }

  return { consumed: messages.length, succeeded, failed, replayed };
}

/**
 * Helper to construct an EffectEnvelope from a compensation outbox payload.
 * Exported so tests and the token provider can share the exact envelope shape.
 */
export function envelopeFromCompensationPayload(payload: CompensationPayload): EffectEnvelope {
  return {
    effect_id: `cmp_${randomUUID()}`,
    tenant_id: payload.tenantId ?? '',
    run_id: payload.runId ?? '',
    step_id: payload.stepId ?? '',
    action: payload.compensationAction ?? '',
    payload: payload.compensationPayload ?? {},
    idempotency_key: payload.idempotencyKey ?? '',
    status: 'admitted',
  };
}
