import type { EffectEnvelope, EffectEnvelopeStatus } from './effects.js';
import { EFFECT_CONTRACT_VERSION, type VersionedContract } from './versioned.js';

export { EFFECT_CONTRACT_VERSION };

/** Durable ledger row states — kernel commander_effects.state 唯一持久化四态。 */
export const EFFECT_DURABLE_STATES = [
  'ADMITTED',
  'COMPLETION_UNKNOWN',
  'COMPLETED',
  'FAILED',
] as const;

export type EffectDurableStatus = (typeof EFFECT_DURABLE_STATES)[number];

/** Broker/kernel 事件观察态 — 不作为 durable row 终态写入。 */
export type EffectObservationStatus = 'EXECUTING' | 'REJECTED' | 'REPLAYED';

export interface EffectPayloadV2 {
  id: string;
  tenantId: string;
  runId: string;
  stepId: string;
  kind: string;
  action: string;
  status: EffectDurableStatus;
  adapterId: string;
  adapterVersion: string;
  requestDigest: string;
  policyDecisionId: string;
  idempotencyKey: string;
  compensatesEffectId?: string;
  responseDigest?: string;
  responseSummary?: Record<string, unknown>;
  fencingEpoch: number;
  createdAt: string;
  completedAt?: string;
}

export type EffectContractV2 = VersionedContract<'effect', typeof EFFECT_CONTRACT_VERSION, EffectPayloadV2>;

export function wrapEffectV2(payload: EffectPayloadV2): EffectContractV2 {
  return { kind: 'effect', schemaVersion: EFFECT_CONTRACT_VERSION, payload };
}

const ENVELOPE_TO_DURABLE: Partial<Record<EffectEnvelopeStatus, EffectDurableStatus>> = {
  admitted: 'ADMITTED',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

/** snake_case transport view → canonical EffectContractV2。 */
export function toEffectContractV2(
  envelope: EffectEnvelope,
  extras: {
    adapterId: string;
    adapterVersion: string;
    requestDigest: string;
    policyDecisionId: string;
    fencingEpoch: number;
    createdAt: string;
    completedAt?: string;
    compensatesEffectId?: string;
    responseDigest?: string;
    responseSummary?: Record<string, unknown>;
  },
): EffectContractV2 {
  const durable = ENVELOPE_TO_DURABLE[envelope.status];
  if (!durable) {
    throw new Error(`EffectEnvelope status '${envelope.status}' is not a durable state`);
  }
  return wrapEffectV2({
    id: envelope.effect_id,
    tenantId: envelope.tenant_id,
    runId: envelope.run_id,
    stepId: envelope.step_id,
    kind: envelope.action,
    action: envelope.action,
    status: durable,
    adapterId: extras.adapterId,
    adapterVersion: extras.adapterVersion,
    requestDigest: extras.requestDigest,
    policyDecisionId: extras.policyDecisionId,
    idempotencyKey: envelope.idempotency_key,
    compensatesEffectId: extras.compensatesEffectId,
    responseDigest: extras.responseDigest,
    responseSummary: extras.responseSummary,
    fencingEpoch: extras.fencingEpoch,
    createdAt: extras.createdAt,
    completedAt: extras.completedAt,
  });
}

/** canonical → snake_case transport view（观察态由调用方指定）。 */
export function fromEffectContractV2(
  contract: EffectContractV2,
  observationStatus: EffectEnvelopeStatus = 'admitted',
): EffectEnvelope {
  const p = contract.payload;
  return {
    effect_id: p.id,
    tenant_id: p.tenantId,
    run_id: p.runId,
    step_id: p.stepId,
    action: p.action,
    payload: {},
    idempotency_key: p.idempotencyKey,
    status: observationStatus,
  };
}
