import { createHash } from 'node:crypto';

export type CompensationDecisionEffect = 'allow' | 'deny' | 'require_approval';

export interface CompensationApprovalBinding {
  approvalId: string;
  approverPrincipalId: string;
  actionDigest: string;
  policySnapshotId: string;
  expiresAt: string;
}

export interface GovernedCompensationAuthorizationInput {
  schema: 'commander.compensation/v1';
  authorizationId: string;
  requestId: string;
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  originalRunStateAtRequest: string;
  compensationRunId: string;
  compensationStepId: string;
  compensationEffectId: string;
  compensationEffectType: string;
  compensationRequest: Record<string, unknown>;
  idempotencyKey: string;
  forwardReceipt: Record<string, unknown>;
  adapterVersion: string;
  policyDecisionId: string;
  policySnapshotId: string;
  decisionEffect: CompensationDecisionEffect;
  authorizationExpiresAt: string;
  approvalBinding: CompensationApprovalBinding | null;
}

export interface GovernedCompensationAuthorization extends GovernedCompensationAuthorizationInput {
  forwardReceiptHash: string;
  requestHash: string;
  actionDigest: string;
}

export type CompensationAuthorizationErrorCode =
  | 'COMPENSATION_AUTHORIZATION_MALFORMED'
  | 'COMPENSATION_AUTHORIZATION_UNKNOWN_FIELD'
  | 'COMPENSATION_ORIGINAL_EFFECT_MISMATCH'
  | 'COMPENSATION_FORWARD_RECEIPT_HASH_MISMATCH'
  | 'COMPENSATION_REQUEST_HASH_MISMATCH'
  | 'COMPENSATION_POLICY_DENIED'
  | 'COMPENSATION_APPROVAL_REQUIRED'
  | 'COMPENSATION_APPROVAL_UNEXPECTED'
  | 'COMPENSATION_APPROVAL_BINDING_INVALID'
  | 'COMPENSATION_AUTHORIZATION_EXPIRED'
  | 'COMPENSATION_ACTION_DIGEST_MISMATCH';

export type CompensationAuthorizationValidation =
  | { valid: true; authorization: GovernedCompensationAuthorization }
  | { valid: false; code: CompensationAuthorizationErrorCode };

const AUTHORIZATION_KEYS = new Set([
  'schema',
  'authorizationId',
  'requestId',
  'tenantId',
  'originalRunId',
  'originalEffectId',
  'originalRunStateAtRequest',
  'compensationRunId',
  'compensationStepId',
  'compensationEffectId',
  'compensationEffectType',
  'compensationRequest',
  'idempotencyKey',
  'forwardReceipt',
  'forwardReceiptHash',
  'adapterVersion',
  'policyDecisionId',
  'policySnapshotId',
  'actionDigest',
  'decisionEffect',
  'authorizationExpiresAt',
  'approvalBinding',
]);

const INPUT_KEYS = new Set(
  [...AUTHORIZATION_KEYS].filter(
    (key) => !['forwardReceiptHash', 'requestHash', 'actionDigest'].includes(key),
  ),
);
AUTHORIZATION_KEYS.add('requestHash');

const APPROVAL_KEYS = new Set([
  'approvalId',
  'approverPrincipalId',
  'actionDigest',
  'policySnapshotId',
  'expiresAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteIsoTime(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('governed compensation value must be canonical JSON');
}

export function canonicalCompensationHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestProjection(
  input: GovernedCompensationAuthorizationInput & {
    forwardReceiptHash: string;
    requestHash: string;
  },
): Record<string, unknown> {
  const approvalBinding = input.approvalBinding
    ? {
        approvalId: input.approvalBinding.approvalId,
        approverPrincipalId: input.approvalBinding.approverPrincipalId,
        policySnapshotId: input.approvalBinding.policySnapshotId,
        expiresAt: input.approvalBinding.expiresAt,
      }
    : null;
  return {
    protocol: input.schema,
    canonicalization: 'jcs-v1',
    authorizationId: input.authorizationId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    originalRunId: input.originalRunId,
    originalEffectId: input.originalEffectId,
    originalRunStateAtRequest: input.originalRunStateAtRequest,
    compensationRunId: input.compensationRunId,
    compensationStepId: input.compensationStepId,
    compensationEffectId: input.compensationEffectId,
    compensationEffectType: input.compensationEffectType,
    idempotencyKey: input.idempotencyKey,
    forwardReceiptHash: input.forwardReceiptHash,
    requestHash: input.requestHash,
    adapterVersion: input.adapterVersion,
    policyDecisionId: input.policyDecisionId,
    policySnapshotId: input.policySnapshotId,
    decisionEffect: input.decisionEffect,
    authorizationExpiresAt: input.authorizationExpiresAt,
    approvalBinding,
  };
}

export function sealGovernedCompensationAuthorization(
  input: GovernedCompensationAuthorizationInput,
): GovernedCompensationAuthorization {
  if (!hasExactKeys(input as unknown as Record<string, unknown>, INPUT_KEYS)) {
    throw new TypeError('governed compensation input fields are not canonical');
  }
  const forwardReceiptHash = canonicalCompensationHash(input.forwardReceipt);
  const requestHash = canonicalCompensationHash(input.compensationRequest);
  const actionDigest = canonicalCompensationHash(
    digestProjection({ ...input, forwardReceiptHash, requestHash }),
  );
  return {
    ...input,
    approvalBinding: input.approvalBinding ? { ...input.approvalBinding, actionDigest } : null,
    forwardReceiptHash,
    requestHash,
    actionDigest,
  };
}

function malformedAuthorization(value: Record<string, unknown>): boolean {
  const stringFields = [
    'authorizationId',
    'requestId',
    'tenantId',
    'originalRunId',
    'originalEffectId',
    'originalRunStateAtRequest',
    'compensationRunId',
    'compensationStepId',
    'compensationEffectId',
    'compensationEffectType',
    'idempotencyKey',
    'adapterVersion',
    'policyDecisionId',
    'policySnapshotId',
    'forwardReceiptHash',
    'requestHash',
    'actionDigest',
  ];
  return (
    value.schema !== 'commander.compensation/v1' ||
    stringFields.some((field) => !nonEmptyString(value[field])) ||
    !isRecord(value.compensationRequest) ||
    !isRecord(value.forwardReceipt) ||
    !['allow', 'deny', 'require_approval'].includes(String(value.decisionEffect)) ||
    !finiteIsoTime(value.authorizationExpiresAt)
  );
}

function validApprovalShape(value: unknown): value is CompensationApprovalBinding {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS)) return false;
  return (
    nonEmptyString(value.approvalId) &&
    nonEmptyString(value.approverPrincipalId) &&
    nonEmptyString(value.actionDigest) &&
    nonEmptyString(value.policySnapshotId) &&
    finiteIsoTime(value.expiresAt)
  );
}

export function validateGovernedCompensationAuthorization(
  value: unknown,
  now = new Date(),
): CompensationAuthorizationValidation {
  if (!isRecord(value)) {
    return { valid: false, code: 'COMPENSATION_AUTHORIZATION_MALFORMED' };
  }
  if (!hasExactKeys(value, AUTHORIZATION_KEYS)) {
    return { valid: false, code: 'COMPENSATION_AUTHORIZATION_UNKNOWN_FIELD' };
  }
  if (malformedAuthorization(value)) {
    return { valid: false, code: 'COMPENSATION_AUTHORIZATION_MALFORMED' };
  }
  const authorization = value as unknown as GovernedCompensationAuthorization;
  if (authorization.compensationRequest.originalEffectId !== authorization.originalEffectId) {
    return { valid: false, code: 'COMPENSATION_ORIGINAL_EFFECT_MISMATCH' };
  }
  if (
    canonicalCompensationHash(authorization.forwardReceipt) !== authorization.forwardReceiptHash
  ) {
    return { valid: false, code: 'COMPENSATION_FORWARD_RECEIPT_HASH_MISMATCH' };
  }
  if (canonicalCompensationHash(authorization.compensationRequest) !== authorization.requestHash) {
    return { valid: false, code: 'COMPENSATION_REQUEST_HASH_MISMATCH' };
  }
  if (authorization.decisionEffect === 'deny') {
    return { valid: false, code: 'COMPENSATION_POLICY_DENIED' };
  }
  if (Date.parse(authorization.authorizationExpiresAt) <= now.getTime()) {
    return { valid: false, code: 'COMPENSATION_AUTHORIZATION_EXPIRED' };
  }
  if (authorization.decisionEffect === 'allow' && authorization.approvalBinding !== null) {
    return { valid: false, code: 'COMPENSATION_APPROVAL_UNEXPECTED' };
  }
  if (authorization.decisionEffect === 'require_approval') {
    if (authorization.approvalBinding === null) {
      return { valid: false, code: 'COMPENSATION_APPROVAL_REQUIRED' };
    }
    if (
      !validApprovalShape(authorization.approvalBinding) ||
      authorization.approvalBinding.policySnapshotId !== authorization.policySnapshotId ||
      authorization.approvalBinding.actionDigest !== authorization.actionDigest ||
      Date.parse(authorization.approvalBinding.expiresAt) <= now.getTime()
    ) {
      return { valid: false, code: 'COMPENSATION_APPROVAL_BINDING_INVALID' };
    }
  } else if (
    authorization.approvalBinding !== null &&
    !validApprovalShape(authorization.approvalBinding)
  ) {
    return { valid: false, code: 'COMPENSATION_APPROVAL_BINDING_INVALID' };
  }
  const expectedDigest = canonicalCompensationHash(
    digestProjection({
      ...authorization,
      forwardReceiptHash: authorization.forwardReceiptHash,
      requestHash: authorization.requestHash,
    }),
  );
  if (expectedDigest !== authorization.actionDigest) {
    return { valid: false, code: 'COMPENSATION_ACTION_DIGEST_MISMATCH' };
  }
  return { valid: true, authorization };
}

export function compensationGrantExpiresAt(
  authorization: Pick<GovernedCompensationAuthorization, 'authorizationExpiresAt'>,
  now: Date,
  capabilityTtlMs: number,
): string {
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs <= 0) {
    throw new TypeError('capabilityTtlMs must be a positive integer');
  }
  const authorizationExpiry = Date.parse(authorization.authorizationExpiresAt);
  if (!Number.isFinite(authorizationExpiry)) {
    throw new TypeError('authorizationExpiresAt must be a finite ISO timestamp');
  }
  return new Date(Math.min(authorizationExpiry, now.getTime() + capabilityTtlMs)).toISOString();
}
