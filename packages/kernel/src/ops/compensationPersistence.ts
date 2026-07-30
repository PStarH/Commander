import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from './compensationAuthority.js';
import type { KernelEffect, KernelRunState } from '../types.js';
import type { CompensationApprovalBinding, CompensationDecisionEffect } from './compensationAuthority.js';

/** Legacy test-fixture input. Production authority uses CompensationAuthorizationRecord. */
export interface LegacyGovernedCompensationInput {
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  forwardReceipt: Record<string, unknown>;
  adapterVersion: string;
  compensationEffectType: string;
  compensationPatch: Record<string, unknown>;
  policyDecisionId: string;
  policySnapshotId: string;
  actionDigest: string;
  decisionEffect: CompensationDecisionEffect;
  authorizationExpiresAt: string;
  approvalBinding: CompensationApprovalBinding | null;
  actor: string;
}

export type CompensationRequestEscalationReason =
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_BINDING_INVALID'
  | 'AUTHORIZATION_EXPIRED'
  | 'FORWARD_RECEIPT_MISMATCH'
  | 'ACTION_DIGEST_MISMATCH';

export interface GovernedCompensationIdentifiers {
  authorizationId: string;
  requestId: string;
  compensationRunId: string;
  compensationStepId: string;
  compensationEffectId: string;
  idempotencyKey: string;
}

export type PreparedCompensationRequest = {
  authorization: GovernedCompensationAuthorization;
  identifiers: GovernedCompensationIdentifiers;
  escalationReason: CompensationRequestEscalationReason | null;
};

function stableId(prefix: string, value: unknown, length: number): string {
  return `${prefix}_${canonicalCompensationHash(value).slice(0, length)}`;
}

export function governedCompensationIdentifiers(input: Pick<
  LegacyGovernedCompensationInput,
  'tenantId' | 'originalRunId' | 'originalEffectId' | 'adapterVersion'
>): GovernedCompensationIdentifiers {
  const identity = {
    protocol: 'commander.compensation/v1',
    tenantId: input.tenantId,
    originalRunId: input.originalRunId,
    originalEffectId: input.originalEffectId,
    adapterVersion: input.adapterVersion,
  };
  const idempotencyKey = `cmp:${input.originalEffectId}:${input.adapterVersion}`;
  const authorizationId = stableId('authorization', identity, 40);
  const requestId = stableId('request', { ...identity, authorizationId }, 40);
  const compensationRunId = stableId('run', { ...identity, purpose: 'compensation-run' }, 40);
  const compensationStepId = stableId('step', { compensationRunId, kind: 'tool' }, 32);
  const compensationEffectId = stableId('effect', { compensationRunId, idempotencyKey }, 40);
  return {
    authorizationId,
    requestId,
    compensationRunId,
    compensationStepId,
    compensationEffectId,
    idempotencyKey,
  };
}

export function governedCompensationAuthorizationInput(input: {
  request: LegacyGovernedCompensationInput;
  originalRunStateAtRequest: KernelRunState;
  originalEffect: Pick<KernelEffect, 'request' | 'response'>;
}): GovernedCompensationAuthorizationInput {
  const identifiers = governedCompensationIdentifiers(input.request);
  return {
    schema: 'commander.compensation/v1',
    authorizationId: identifiers.authorizationId,
    requestId: identifiers.requestId,
    tenantId: input.request.tenantId,
    originalRunId: input.request.originalRunId,
    originalEffectId: input.request.originalEffectId,
    originalRunStateAtRequest: input.originalRunStateAtRequest,
    compensationRunId: identifiers.compensationRunId,
    compensationStepId: identifiers.compensationStepId,
    compensationEffectId: identifiers.compensationEffectId,
    compensationEffectType: input.request.compensationEffectType,
    compensationRequest: {
      originalEffectId: input.request.originalEffectId,
      destination: input.originalEffect.request.destination,
      forwardResponse: input.request.forwardReceipt,
      compensationPatch: input.request.compensationPatch,
    },
    idempotencyKey: identifiers.idempotencyKey,
    forwardReceipt: input.request.forwardReceipt,
    adapterVersion: input.request.adapterVersion,
    policyDecisionId: input.request.policyDecisionId,
    policySnapshotId: input.request.policySnapshotId,
    decisionEffect: input.request.decisionEffect,
    authorizationExpiresAt: input.request.authorizationExpiresAt,
    approvalBinding: input.request.approvalBinding,
  };
}

export function prepareCompensationRequest(input: {
  request: LegacyGovernedCompensationInput;
  originalRunStateAtRequest: KernelRunState;
  originalEffect: Pick<KernelEffect, 'request' | 'response'>;
  now?: Date;
}): PreparedCompensationRequest {
  const identifiers = governedCompensationIdentifiers(input.request);
  const authorization = sealGovernedCompensationAuthorization(
    governedCompensationAuthorizationInput(input),
  );
  const now = input.now ?? new Date();
  const authorizationExpiresAt = Date.parse(input.request.authorizationExpiresAt);
  const approvalExpiresAt = input.request.approvalBinding
    ? Date.parse(input.request.approvalBinding.expiresAt)
    : null;
  let escalationReason: CompensationRequestEscalationReason | null = null;
  if (
    canonicalCompensationHash(input.request.forwardReceipt) !==
    canonicalCompensationHash(input.originalEffect.response ?? {})
  ) {
    escalationReason = 'FORWARD_RECEIPT_MISMATCH';
  } else if (input.request.decisionEffect === 'deny') {
    escalationReason = 'POLICY_DENIED';
  } else if (!Number.isFinite(authorizationExpiresAt) || authorizationExpiresAt <= now.getTime()) {
    escalationReason = 'AUTHORIZATION_EXPIRED';
  } else if (
    input.request.decisionEffect === 'require_approval' &&
    input.request.approvalBinding === null
  ) {
    escalationReason = 'APPROVAL_REQUIRED';
  } else if (
    (input.request.decisionEffect === 'allow' && input.request.approvalBinding !== null) ||
    (input.request.approvalBinding !== null &&
      (input.request.approvalBinding.actionDigest !== input.request.actionDigest ||
        input.request.approvalBinding.policySnapshotId !== input.request.policySnapshotId ||
        approvalExpiresAt === null ||
        !Number.isFinite(approvalExpiresAt) ||
        approvalExpiresAt <= now.getTime()))
  ) {
    escalationReason = 'APPROVAL_BINDING_INVALID';
  } else if (input.request.actionDigest !== authorization.actionDigest) {
    escalationReason = 'ACTION_DIGEST_MISMATCH';
  }
  return { authorization, identifiers, escalationReason };
}
