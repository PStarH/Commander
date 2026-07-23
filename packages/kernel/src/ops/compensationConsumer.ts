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
  claimOutboxByTopic(
    topic: string,
    limit: number,
    now?: Date,
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<CompensationOutboxMessage[]>;
  markOutboxPublished(messageId: string, claimToken: string, tenantId?: string): Promise<boolean>;
  /** Release a failed claim immediately with exponential backoff + recorded
   *  error, instead of waiting for the 60s claim expiry. Messages whose
   *  attempts reach max_attempts are moved to the DLQ by sweepOutboxDlq
   *  (scheduled every kernel-ops timer cycle) — no infinite retry. */
  retryOutbox(
    messageId: string,
    claimToken: string,
    error: { code: string; message: string },
    now?: Date,
    tenantId?: string,
  ): Promise<boolean>;
}

export interface CompensationOutboxMessage {
  id: string;
  /** Authoritative tenant from the outbox row — never trust payload.tenantId alone. */
  tenantId: string;
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
    workloadBinding?: {
      tenantId: string;
      runId: string;
      stepId: string;
      workloadId?: string;
    };
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
  /** Durable registry generation for lease / broker affinity. Defaults to 1. */
  workerGeneration?: number;
  /** Register-time claim secret — required for worker LOGIN outbox claim RPC. */
  claimSecret?: string;
  /**
   * Fallback fencing epoch used only when a message's payload does not carry
   * one (e.g. explicit compensationAction messages, not kernel-reclaim ones).
   * Kernel-reclaim messages always carry the originating lease's fencingEpoch
   * in payload.compensationPayload.fencingEpoch and that value always wins —
   * this option must never be used to invent an epoch for those.
   */
  fencingEpoch?: number;
  /** Optional adapter registry — unregistered `compensate.*` actions are retried, not executed. */
  registry?: { resolve(action: string): unknown };
  onAdapterUnregistered?: (input: {
    tenantId: string;
    runId: string;
    stepId: string;
    compensationAction: string;
    messageId: string;
  }) => Promise<void>;
}

export interface CompensationConsumeResult {
  consumed: number;
  succeeded: number;
  failed: number;
  replayed: number;
}

/** Payload shape expected on each compensation outbox message. */
interface CompensationPayload {
  tenantId?: string;
  runId?: string;
  stepId?: string;
  originalEffectId?: string;
  compensationAction?: string;
  compensationPayload?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Kernel reclaim shape: list of completed forward effect ids. */
  effectIds?: string[];
  fencingEpoch?: number;
  type?: string;
}

/** Topic emitted by reclaim when a run enters COMPENSATING (appendEvent). */
export const KERNEL_COMPENSATION_TOPIC = 'commander.kernel.compensation.requested';
/** Legacy / seed topic used by older tests and synthetic drains. */
export const LEGACY_COMPENSATION_TOPIC = 'commander.compensation';
const DEFAULT_TOPIC = KERNEL_COMPENSATION_TOPIC;

/**
 * Map kernel reclaim outbox payloads (effectIds + event envelope) onto the
 * consumer's compensationAction shape. Explicit compensationAction wins.
 */
export function normalizeCompensationPayload(
  raw: Record<string, unknown>,
): CompensationPayload | null {
  const base = raw as CompensationPayload;
  if (base.compensationAction && base.tenantId && base.runId && base.stepId) {
    return base;
  }
  const effectIds = Array.isArray(base.effectIds)
    ? base.effectIds.filter((id): id is string => typeof id === 'string')
    : [];
  const isKernelRequest =
    base.type === 'kernel.compensation.requested' || effectIds.length > 0;
  if (!isKernelRequest || !base.tenantId || !base.runId || !base.stepId) {
    return null;
  }
  return {
    tenantId: base.tenantId,
    runId: base.runId,
    stepId: base.stepId,
    compensationAction: 'compensate.rollback',
    compensationPayload: {
      effectIds,
      fencingEpoch: base.fencingEpoch,
      originalType: base.type,
    },
    idempotencyKey: base.idempotencyKey,
  };
}

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
  const workerGeneration = options.workerGeneration ?? 1;

  const messages = await outbox.claimOutboxByTopic(topic, limit, undefined, {
    workerId: options.workerId,
    workerGeneration,
    claimSecret: options.claimSecret ?? '',
  });
  let succeeded = 0;
  let failed = 0;
  let replayed = 0;

  for (const message of messages) {
    if (!message.claimToken) { failed++; continue; }
    const payload = normalizeCompensationPayload(message.payload);
    if (!payload?.tenantId || !payload.runId || !payload.stepId || !payload.compensationAction) {
      // Malformed — retry/DLQ (never silent-ack; audit must see the failure).
      try {
        await outbox.retryOutbox(message.id, message.claimToken, {
          code: 'COMPENSATION_PAYLOAD_MALFORMED',
          message: 'compensation outbox payload missing tenantId/runId/stepId/action',
        }, undefined, message.tenantId);
      } catch { /* claim may have expired */ }
      failed++;
      continue;
    }
    // Outbox row tenant_id is authoritative — never trust a spoofed payload.tenantId.
    if (payload.tenantId !== message.tenantId) {
      try {
        await outbox.retryOutbox(message.id, message.claimToken, {
          code: 'COMPENSATION_TENANT_MISMATCH',
          message: 'compensation payload.tenantId diverged from outbox tenant_id',
        }, undefined, message.tenantId);
      } catch { /* claim may have expired */ }
      failed++;
      continue;
    }

    const compensationAction = payload.compensationAction;
    if (
      compensationAction.startsWith('compensate.') &&
      options.registry &&
      !options.registry.resolve(compensationAction)
    ) {
      try {
        await outbox.retryOutbox(message.id, message.claimToken, {
          code: 'COMPENSATION_ADAPTER_UNREGISTERED',
          message: `No adapter registered for ${compensationAction}`,
        }, undefined, message.tenantId);
      } catch { /* claim may have expired */ }
      await options.onAdapterUnregistered?.({
        tenantId: message.tenantId,
        runId: payload.runId!,
        stepId: payload.stepId!,
        compensationAction,
        messageId: message.id,
      });
      failed++;
      continue;
    }

    const effectId = `cmp_${randomUUID()}`;
    const idempotencyKey = payload.idempotencyKey ?? `cmp:${message.id}`;

    // Fail-closed: never invent a fencing epoch. Prefer the epoch the reclaim
    // daemon stamped on the outbox payload from the actual failed lease; only
    // fall back to the caller-supplied default for non-reclaim (explicit
    // compensationAction) messages that have no such lease to derive from.
    const payloadFencingEpoch = payload.compensationPayload?.fencingEpoch;
    const fencingEpoch =
      typeof payloadFencingEpoch === 'number' && Number.isFinite(payloadFencingEpoch)
        ? payloadFencingEpoch
        : options.fencingEpoch;
    if (typeof fencingEpoch !== 'number' || !Number.isFinite(fencingEpoch)) {
      try {
        await outbox.retryOutbox(message.id, message.claimToken, {
          code: 'COMPENSATION_FENCING_EPOCH_MISSING',
          message: 'no fencingEpoch on payload and no caller-supplied default',
        }, undefined, message.tenantId);
      } catch { /* claim may have expired */ }
      failed++;
      continue;
    }

    try {
      const token = await tokenProvider({
        tenantId: message.tenantId,
        runId: payload.runId,
        stepId: payload.stepId,
        action: payload.compensationAction,
        payload: payload.compensationPayload ?? {},
      });
      if (!token) {
        // Token provider refused — record and back off (DLQ once max_attempts).
        await outbox.retryOutbox(
          message.id,
          message.claimToken!,
          { code: 'COMPENSATION_TOKEN_REFUSED', message: 'token provider returned null' },
          undefined,
          message.tenantId,
        );
        failed++;
        continue;
      }

      const compensationRequest = payload.compensationPayload ?? {};
      const admission = await broker.admit({
        effectId,
        token,
        type: payload.compensationAction,
        request: compensationRequest,
        idempotencyKey,
        lease: {
          workerId: options.workerId,
          workerGeneration,
          token: `cmp-lease:${message.id}`,
          fencingEpoch,
        },
        actor: `compensation-consumer:${options.workerId}`,
        workloadBinding: {
          tenantId: message.tenantId,
          runId: payload.runId!,
          stepId: payload.stepId!,
          workloadId: options.workerId,
        },
      });
      if (!admission.admitted) {
        await outbox.retryOutbox(
          message.id,
          message.claimToken!,
          { code: 'COMPENSATION_ADMIT_REJECTED', message: admission.reason ?? 'unknown' },
          undefined,
          message.tenantId,
        );
        failed++;
        continue;
      }
      if (admission.replayed) replayed++;

      const result = await broker.executeAdmitted({ effectId, timeoutMs });
      // Ack the outbox message only after the effect committed in the kernel.
      const acked = await outbox.markOutboxPublished(
        message.id,
        message.claimToken!,
        message.tenantId,
      );
      if (acked) succeeded++;
      else failed++;
      // Reference result so unused-var lint stays quiet; the audit trail lives
      // in the kernel effect ledger (commander_effects) and AuditSink.
      void result;
    } catch (error) {
      // Executor threw or completion unconfirmed — record + back off; the
      // sweeper moves the message to DLQ once attempts >= max_attempts.
      try {
        await outbox.retryOutbox(
          message.id,
          message.claimToken!,
          {
            code: 'COMPENSATION_EXECUTE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
          undefined,
          message.tenantId,
        );
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
