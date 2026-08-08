import type { EffectEnvelope } from '@commander/contracts';
import {
  canonicalCompensationHash,
  validateGovernedCompensationAuthorization,
  type CompensationAuthorizationErrorCode,
  type GovernedCompensationAuthorization,
} from './compensationAuthority.js';
import type {
  ClaimedCompensationRequest,
  CompensationAuthorizationRecord,
  CompensationMutationResult,
  FinalizeCompensationInput,
  KernelCompensationRequest,
  ParkCompensationUnknownInput,
} from '../types.js';
import type { KernelEvidenceRecord } from '../evidenceRepository.js';

export const KERNEL_COMPENSATION_TOPIC = 'commander.kernel.compensation.requested';
export const LEGACY_COMPENSATION_TOPIC = 'commander.compensation';

export interface CompensationClaimAuth {
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
}

export interface LegacyClaimedCompensationWork {
  messageId: string;
  tenantId: string;
  claimToken: string;
  authorization: GovernedCompensationAuthorization;
  lease: {
    workerId: string;
    workerGeneration: number;
    token: string;
    fencingEpoch: number;
  };
}

export type ClaimedCompensationWork = LegacyClaimedCompensationWork | ClaimedCompensationRequest;

export type CompensationWorkDispositionResult =
  | {
      applied: true;
      disposition: 'COMPLETED' | 'HANDOFF_UNKNOWN' | 'ESCALATED';
      replayed?: boolean;
    }
  | { applied: false; reason: string };

interface CompensationWorkMutationAuth extends CompensationClaimAuth {
  tenantId: string;
  messageId: string;
  outboxClaimToken: string;
  compensationEffectId: string;
}

export interface CompensationOutboxPort {
  claimCompensationWork(
    input: CompensationClaimAuth & { topic: typeof KERNEL_COMPENSATION_TOPIC; limit: number },
  ): Promise<ClaimedCompensationWork[]>;
  completeCompensationWork(
    input: CompensationWorkMutationAuth & { response: Record<string, unknown> },
  ): Promise<CompensationWorkDispositionResult>;
  handoffCompensationUnknown(
    input: CompensationWorkMutationAuth & { error: { code: string; message: string } },
  ): Promise<CompensationWorkDispositionResult>;
  escalateCompensationWork(
    input: CompensationWorkMutationAuth & { reason: string },
  ): Promise<CompensationWorkDispositionResult>;
  parkCompensationUnknown(input: ParkCompensationUnknownInput): Promise<CompensationMutationResult>;
  finalizeCompensation(input: FinalizeCompensationInput): Promise<CompensationMutationResult>;
}

export interface CompensationEffectBroker {
  admit(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: ClaimedCompensationWork['lease'];
    actor: string;
    workloadBinding: {
      tenantId: string;
      runId: string;
      stepId: string;
      workloadId: string;
    };
    compensationClaim?: {
      requestId: string;
      requestClaimToken: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    };
  }): Promise<{ admitted: boolean; effectId: string; replayed: boolean; reason?: string }>;
  executeAdmitted(input: { effectId: string; timeoutMs?: number }): Promise<{
    effectId: string;
    replayed: boolean;
    response?: Record<string, unknown>;
  }>;
}

export type CompensationTokenContext =
  | GovernedCompensationAuthorization
  | {
      authorization: ClaimedCompensationRequest['authorization'];
      request: KernelCompensationRequest;
      forwardResponse: Record<string, unknown>;
    };

export interface CompensationTokenProvider {
  (authorization: CompensationTokenContext): Promise<string | null>;
}

export interface CompensationConsumerOptions extends CompensationClaimAuth {
  topic?: typeof KERNEL_COMPENSATION_TOPIC;
  limit?: number;
  timeoutMs?: number;
  registry: {
    resolve(action: string): { descriptor?: { adapterVersion?: string } } | null;
  };
  terminalEvidence?: (input: {
    tenantId: string;
    runId: string;
    effectId: string;
    projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN';
    response: Record<string, unknown>;
    eventType: string;
    disposition: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'ESCALATED';
    claimToken: string;
  }) => Promise<KernelEvidenceRecord>;
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
  handedOff: number;
  escalated: number;
  replayed: number;
}

function mutationAuth(
  work: LegacyClaimedCompensationWork,
  options: CompensationConsumerOptions,
): CompensationWorkMutationAuth {
  return {
    workerId: options.workerId,
    workerGeneration: options.workerGeneration,
    claimSecret: options.claimSecret,
    tenantId: work.tenantId,
    messageId: work.messageId,
    outboxClaimToken: work.claimToken,
    compensationEffectId: work.authorization.compensationEffectId,
  };
}

function isDurableClaim(work: ClaimedCompensationWork): work is ClaimedCompensationRequest {
  return 'request' in work;
}

function durableExecution(work: ClaimedCompensationRequest) {
  const { authorization, request, forwardResponse } = work;
  const effectId = request.compensationEffectId;
  if (!effectId) throw mutationRejected('CLAIM_EFFECT_ID_MISSING');
  return {
    authorization,
    effectId,
    runId: request.compensationRunId,
    stepId: request.compensationStepId,
    requestPayload: {
      originalEffectId: request.originalEffectId,
      forwardResponse,
      compensationPatch: authorization.compensationPatch,
    },
    idempotencyKey: `cmp:${request.originalEffectId}:${request.adapterVersion}`,
  };
}

function validateDurableClaim(work: ClaimedCompensationRequest): boolean {
  const { authorization, request, forwardResponse } = work;
  return (
    authorization.id === request.authorizationId &&
    authorization.tenantId === request.tenantId &&
    authorization.originalRunId === request.originalRunId &&
    authorization.originalEffectId === request.originalEffectId &&
    authorization.adapterVersion === request.adapterVersion &&
    authorization.compensationEffectType === request.compensationEffectType &&
    authorization.decision !== 'deny' &&
    Date.parse(authorization.expiresAt) > Date.now() &&
    canonicalCompensationHash(forwardResponse) === authorization.forwardReceiptHash &&
    canonicalCompensationHash({
      type: authorization.compensationEffectType,
      originalEffectId: authorization.originalEffectId,
      adapterVersion: authorization.adapterVersion,
      forwardResponse,
      compensationPatch: authorization.compensationPatch,
    }) === authorization.actionDigest
  );
}

function mutationRejected(reason: string): Error & { code: string } {
  return Object.assign(new Error(`compensation mutation rejected: ${reason}`), {
    code: `COMPENSATION_${reason}`,
  });
}

function requireDisposition(
  result: CompensationWorkDispositionResult | CompensationMutationResult,
  disposition: 'COMPLETED' | 'HANDOFF_UNKNOWN' | 'COMPLETION_UNKNOWN' | 'ESCALATED',
): void {
  if (!result.applied) throw mutationRejected(result.reason);
  if (result.disposition !== disposition) {
    throw Object.assign(new Error('compensation mutation returned an invalid disposition'), {
      code: 'COMPENSATION_DISPOSITION_INVALID',
    });
  }
}

function uncertaintyCode(error: unknown): 'COMPLETION_UNKNOWN' | 'COMPLETION_UNCONFIRMED' | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return error.code === 'COMPLETION_UNKNOWN' || error.code === 'COMPLETION_UNCONFIRMED'
    ? error.code
    : null;
}

function assertClaimBinding(
  work: ClaimedCompensationWork,
  options: CompensationConsumerOptions,
): void {
  const tenantId = isDurableClaim(work) ? work.request.tenantId : work.tenantId;
  const authorizationTenantId = isDurableClaim(work)
    ? work.authorization.tenantId
    : work.authorization.tenantId;
  const claimToken = isDurableClaim(work) ? work.outboxClaimToken : work.claimToken;
  if (
    tenantId !== authorizationTenantId ||
    !claimToken ||
    work.lease.workerId !== options.workerId ||
    work.lease.workerGeneration !== options.workerGeneration ||
    !work.lease.token ||
    !Number.isSafeInteger(work.lease.fencingEpoch) ||
    work.lease.fencingEpoch < 0
  ) {
    throw Object.assign(new Error('governed compensation claim binding is invalid'), {
      code: 'COMPENSATION_WORKER_FENCED',
    });
  }
}

async function escalate(
  outbox: CompensationOutboxPort,
  work: ClaimedCompensationWork,
  options: CompensationConsumerOptions,
  reason:
    | CompensationAuthorizationErrorCode
    | 'COMPENSATION_ADAPTER_UNREGISTERED'
    | 'COMPENSATION_ADAPTER_VERSION_MISMATCH'
    | 'COMPENSATION_TOKEN_REFUSED'
    | 'COMPENSATION_ADMIT_REJECTED',
): Promise<void> {
  if (isDurableClaim(work)) {
    const effectId = work.request.compensationEffectId;
    if (!effectId) throw mutationRejected('CLAIM_EFFECT_ID_MISSING');
    const response = { reason };
    const finalized = await outbox.finalizeCompensation({
      workerId: options.workerId,
      workerGeneration: options.workerGeneration,
      claimSecret: options.claimSecret,
      tenantId: work.request.tenantId,
      requestId: work.request.id,
      effectId,
      disposition: 'ESCALATED',
      actor: options.workerId,
      outboxMessageId: work.outboxMessageId,
      outboxClaimToken: work.outboxClaimToken,
      response,
    });
    if (!finalized.applied) throw mutationRejected(finalized.reason);
    return;
  }
  requireDisposition(
    await outbox.escalateCompensationWork({
      ...mutationAuth(work, options),
      reason,
    }),
    'ESCALATED',
  );
}

export async function consumeCompensationBatch(
  outbox: CompensationOutboxPort,
  broker: CompensationEffectBroker,
  tokenProvider: CompensationTokenProvider,
  options: CompensationConsumerOptions,
): Promise<CompensationConsumeResult> {
  const works = await outbox.claimCompensationWork({
    workerId: options.workerId,
    workerGeneration: options.workerGeneration,
    claimSecret: options.claimSecret,
    topic: options.topic ?? KERNEL_COMPENSATION_TOPIC,
    limit: options.limit ?? 50,
  });
  const result: CompensationConsumeResult = {
    consumed: works.length,
    succeeded: 0,
    handedOff: 0,
    escalated: 0,
    replayed: 0,
  };

  for (const work of works) {
    assertClaimBinding(work, options);
    let authorization: GovernedCompensationAuthorization | CompensationAuthorizationRecord;
    let effectId: string;
    let runId: string;
    let stepId: string;
    let requestPayload: Record<string, unknown>;
    let idempotencyKey: string;
    if (isDurableClaim(work)) {
      if (!validateDurableClaim(work)) {
        await escalate(outbox, work, options, 'COMPENSATION_ACTION_DIGEST_MISMATCH');
        result.escalated += 1;
        continue;
      }
      const projected = durableExecution(work);
      authorization = projected.authorization;
      effectId = projected.effectId;
      runId = projected.runId;
      stepId = projected.stepId;
      requestPayload = projected.requestPayload;
      idempotencyKey = projected.idempotencyKey;
    } else {
      const validation = validateGovernedCompensationAuthorization(work.authorization);
      if (!validation.valid) {
        await escalate(outbox, work, options, validation.code);
        result.escalated += 1;
        continue;
      }
      authorization = validation.authorization;
      effectId = authorization.compensationEffectId;
      runId = authorization.compensationRunId;
      stepId = authorization.compensationStepId;
      requestPayload = authorization.compensationRequest;
      idempotencyKey = authorization.idempotencyKey;
    }
    const adapter = options.registry.resolve(authorization.compensationEffectType);
    if (!adapter) {
      await options.onAdapterUnregistered?.({
        tenantId: authorization.tenantId,
        runId,
        stepId,
        compensationAction: authorization.compensationEffectType,
        messageId: isDurableClaim(work) ? work.outboxMessageId : work.messageId,
      });
      await escalate(outbox, work, options, 'COMPENSATION_ADAPTER_UNREGISTERED');
      result.escalated += 1;
      continue;
    }
    if (adapter.descriptor?.adapterVersion !== authorization.adapterVersion) {
      await escalate(outbox, work, options, 'COMPENSATION_ADAPTER_VERSION_MISMATCH');
      result.escalated += 1;
      continue;
    }

    const token = await tokenProvider(
      isDurableClaim(work)
        ? {
            authorization: work.authorization,
            request: work.request,
            forwardResponse: work.forwardResponse,
          }
        : (authorization as GovernedCompensationAuthorization),
    );
    if (!token) {
      await escalate(outbox, work, options, 'COMPENSATION_TOKEN_REFUSED');
      result.escalated += 1;
      continue;
    }
    const admission = await broker.admit({
      effectId,
      token,
      type: authorization.compensationEffectType,
      request: requestPayload,
      idempotencyKey,
      lease: work.lease,
      actor: options.workerId,
      workloadBinding: {
        tenantId: authorization.tenantId,
        runId,
        stepId,
        workloadId: options.workerId,
      },
      ...(isDurableClaim(work)
        ? {
            compensationClaim: {
              requestId: work.request.id,
              requestClaimToken: work.request.claimToken ?? '',
              outboxMessageId: work.outboxMessageId,
              outboxClaimToken: work.outboxClaimToken,
            },
          }
        : {}),
    });
    if (!admission.admitted || admission.effectId !== effectId) {
      await escalate(outbox, work, options, 'COMPENSATION_ADMIT_REJECTED');
      result.escalated += 1;
      continue;
    }
    if (admission.replayed) result.replayed += 1;

    let execution: Awaited<ReturnType<CompensationEffectBroker['executeAdmitted']>>;
    try {
      execution = await broker.executeAdmitted({
        effectId,
        timeoutMs: options.timeoutMs ?? 30_000,
      });
    } catch (error) {
      const code = uncertaintyCode(error);
      if (!code) throw error;
      requireDisposition(
        isDurableClaim(work)
          ? await outbox.parkCompensationUnknown({
              workerId: options.workerId,
              workerGeneration: options.workerGeneration,
              claimSecret: options.claimSecret,
              tenantId: work.request.tenantId,
              requestId: work.request.id,
              effectId,
              actor: options.workerId,
              outboxMessageId: work.outboxMessageId,
              outboxClaimToken: work.outboxClaimToken,
              error: { code, message: 'Compensation completion is uncertain' },
            })
          : await outbox.handoffCompensationUnknown({
              ...mutationAuth(work, options),
              error: { code, message: 'Compensation completion is uncertain' },
            }),
        isDurableClaim(work) ? 'COMPLETION_UNKNOWN' : 'HANDOFF_UNKNOWN',
      );
      result.handedOff += 1;
      continue;
    }

    if (execution.effectId !== effectId || !execution.response) {
      throw Object.assign(new Error('compensation execution receipt is invalid'), {
        code: 'COMPENSATION_EXECUTION_RECEIPT_INVALID',
      });
    }
    if (execution.replayed) result.replayed += 1;
    requireDisposition(
      isDurableClaim(work)
        ? await outbox.finalizeCompensation({
            workerId: options.workerId,
            workerGeneration: options.workerGeneration,
            claimSecret: options.claimSecret,
            tenantId: work.request.tenantId,
            requestId: work.request.id,
            effectId,
            disposition: 'COMPLETED',
            actor: options.workerId,
            outboxMessageId: work.outboxMessageId,
            outboxClaimToken: work.outboxClaimToken,
            response: execution.response,
            evidence: await options.terminalEvidence?.({
              tenantId: work.request.tenantId,
              runId: work.request.compensationRunId,
              effectId,
              projectedState: 'COMPLETED',
              response: execution.response,
              eventType: 'compensation.completed',
              disposition: 'COMPLETED',
              claimToken: work.outboxClaimToken,
            }),
          })
        : await outbox.completeCompensationWork({
            ...mutationAuth(work, options),
            response: execution.response,
          }),
      'COMPLETED',
    );
    result.succeeded += 1;
  }

  return result;
}

export function normalizeCompensationPayload(
  raw: Record<string, unknown>,
): GovernedCompensationAuthorization | null {
  const validation = validateGovernedCompensationAuthorization(raw);
  return validation.valid ? validation.authorization : null;
}

export function envelopeFromCompensationPayload(
  authorization: GovernedCompensationAuthorization,
): EffectEnvelope {
  return {
    effect_id: authorization.compensationEffectId,
    tenant_id: authorization.tenantId,
    run_id: authorization.compensationRunId,
    step_id: authorization.compensationStepId,
    action: authorization.compensationEffectType,
    payload: authorization.compensationRequest,
    idempotency_key: authorization.idempotencyKey,
    status: 'admitted',
  };
}
