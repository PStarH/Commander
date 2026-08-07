/** Privacy-safe, opt-in offline decision record for governed actions. */

export type ActionLearningRemoteOutcomeV1 = 'applied' | 'not_applied' | 'unknown' | 'escalated';
export type ActionLearningReconciliationPathV1 =
  'none' | 'query' | 'compensation' | 'human_escalation';
export type ActionLearningPolicyOutcomeV1 = 'allow' | 'deny' | 'require_approval';
export type ActionLearningApprovalOutcomeV1 = 'not_required' | 'approved' | 'rejected' | 'expired';
export type ActionLearningDeletionStatusV1 = 'active' | 'deletion_requested' | 'deleted';

export interface ActionLearningConsentV1 {
  tenantScopeHash: string;
  consentId: string;
  purpose: 'model-training';
  trainingOptIn: true;
  grantedAt: string;
  retentionExpiresAt: string;
  withdrawnAt?: string;
}

export interface ActionLearningRecordV1 {
  schemaVersion: 'commander.action-learning/v1';
  recordId: string;
  createdAt: string;
  actionClass: string;
  sourceRuntime: string;
  modelFamily: string;
  toolClass: string;
  resourceScopeClass: string;
  policyOutcome: ActionLearningPolicyOutcomeV1;
  approvalOutcome: ActionLearningApprovalOutcomeV1;
  actionDigest: string;
  policySnapshotId: string;
  contractVersion: string;
  remoteOutcome: ActionLearningRemoteOutcomeV1;
  reconciliationPath: ActionLearningReconciliationPathV1;
  retryCount: number;
  compensationCount: number;
  operatorInterventionMinutes: number;
  recoveryLatencyMs: number;
  evidenceVerified: boolean;
  consent: ActionLearningConsentV1;
  deletionStatus: ActionLearningDeletionStatusV1;
}

type UnknownRecord = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set([
  'prompt',
  'prompts',
  'args',
  'arguments',
  'rawargs',
  'response',
  'responses',
  'rawresponse',
  'credential',
  'credentials',
  'token',
  'tokens',
  'secret',
  'secrets',
  'pii',
  'customerdata',
  'customerpayload',
  'internalurl',
  'internalurls',
]);

const RECORD_KEYS = new Set([
  'schemaVersion',
  'recordId',
  'createdAt',
  'actionClass',
  'sourceRuntime',
  'modelFamily',
  'toolClass',
  'resourceScopeClass',
  'policyOutcome',
  'approvalOutcome',
  'actionDigest',
  'policySnapshotId',
  'contractVersion',
  'remoteOutcome',
  'reconciliationPath',
  'retryCount',
  'compensationCount',
  'operatorInterventionMinutes',
  'recoveryLatencyMs',
  'evidenceVerified',
  'consent',
  'deletionStatus',
]);

const CONSENT_KEYS = new Set([
  'tenantScopeHash',
  'consentId',
  'purpose',
  'trainingOptIn',
  'grantedAt',
  'retentionExpiresAt',
  'withdrawnAt',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, reason: string): never {
  throw new Error(`ACTION_LEARNING_INVALID_RECORD ${path}: ${reason}`);
}

function normalizedKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function scanForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) invalid(`${path}.${key}`, 'forbidden field');
    scanForbiddenKeys(nested, `${path}.${key}`);
  }
}

function readString(record: UnknownRecord, key: string, maxLength = 256): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    invalid(key, 'must be a non-empty bounded string');
  }
  return value;
}

function readIsoTimestamp(record: UnknownRecord, key: string): string {
  const value = readString(record, key, 64);
  if (Number.isNaN(Date.parse(value))) invalid(key, 'must be an ISO timestamp');
  return value;
}

function readEnum<T extends string>(record: UnknownRecord, key: string, values: readonly T[]): T {
  const value = record[key];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    invalid(key, 'contains an unsupported value');
  }
  return value as T;
}

function readCounter(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(key, 'must be a non-negative finite number');
  }
  return value;
}

function assertAllowedKeys(
  record: UnknownRecord,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'unknown field');
  }
}

export function validateActionLearningRecordV1(input: unknown): ActionLearningRecordV1 {
  scanForbiddenKeys(input, '$');
  if (!isRecord(input)) invalid('$', 'must be an object');
  assertAllowedKeys(input, RECORD_KEYS, '$');

  const consent = input.consent;
  if (!isRecord(consent)) invalid('consent', 'must be an object');
  assertAllowedKeys(consent, CONSENT_KEYS, '$.consent');

  const trainingOptIn = consent.trainingOptIn;
  if (trainingOptIn !== true) invalid('consent.trainingOptIn', 'must be true');
  if (typeof input.evidenceVerified !== 'boolean') {
    invalid('evidenceVerified', 'must be a boolean');
  }
  const withdrawnAt = consent.withdrawnAt;
  if (
    withdrawnAt !== undefined &&
    (typeof withdrawnAt !== 'string' || Number.isNaN(Date.parse(withdrawnAt)))
  ) {
    invalid('consent.withdrawnAt', 'must be an ISO timestamp');
  }

  return {
    schemaVersion: readEnum(input, 'schemaVersion', ['commander.action-learning/v1'] as const),
    recordId: readString(input, 'recordId'),
    createdAt: readIsoTimestamp(input, 'createdAt'),
    actionClass: readString(input, 'actionClass'),
    sourceRuntime: readString(input, 'sourceRuntime'),
    modelFamily: readString(input, 'modelFamily'),
    toolClass: readString(input, 'toolClass'),
    resourceScopeClass: readString(input, 'resourceScopeClass'),
    policyOutcome: readEnum(input, 'policyOutcome', ['allow', 'deny', 'require_approval'] as const),
    approvalOutcome: readEnum(input, 'approvalOutcome', [
      'not_required',
      'approved',
      'rejected',
      'expired',
    ] as const),
    actionDigest: readString(input, 'actionDigest'),
    policySnapshotId: readString(input, 'policySnapshotId'),
    contractVersion: readString(input, 'contractVersion'),
    remoteOutcome: readEnum(input, 'remoteOutcome', [
      'applied',
      'not_applied',
      'unknown',
      'escalated',
    ] as const),
    reconciliationPath: readEnum(input, 'reconciliationPath', [
      'none',
      'query',
      'compensation',
      'human_escalation',
    ] as const),
    retryCount: readCounter(input, 'retryCount'),
    compensationCount: readCounter(input, 'compensationCount'),
    operatorInterventionMinutes: readCounter(input, 'operatorInterventionMinutes'),
    recoveryLatencyMs: readCounter(input, 'recoveryLatencyMs'),
    evidenceVerified: input.evidenceVerified,
    consent: {
      tenantScopeHash: readString(consent, 'tenantScopeHash'),
      consentId: readString(consent, 'consentId'),
      purpose: readEnum(consent, 'purpose', ['model-training'] as const),
      trainingOptIn,
      grantedAt: readIsoTimestamp(consent, 'grantedAt'),
      retentionExpiresAt: readIsoTimestamp(consent, 'retentionExpiresAt'),
      ...(withdrawnAt === undefined ? {} : { withdrawnAt }),
    },
    deletionStatus: readEnum(input, 'deletionStatus', [
      'active',
      'deletion_requested',
      'deleted',
    ] as const),
  };
}

export function isActionLearningRecordExportable(
  record: ActionLearningRecordV1,
  now = new Date(),
): boolean {
  const expiresAt = Date.parse(record.consent.retentionExpiresAt);
  return (
    record.consent.purpose === 'model-training' &&
    record.consent.trainingOptIn === true &&
    record.consent.withdrawnAt === undefined &&
    record.deletionStatus === 'active' &&
    record.evidenceVerified &&
    !Number.isNaN(expiresAt) &&
    expiresAt > now.getTime()
  );
}
