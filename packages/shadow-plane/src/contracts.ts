import { canonicalBytes } from './canonical.js';

export const SHADOW_MANIFEST_SCHEMA = 'commander.shadow-manifest/v1' as const;
export const SHADOW_OBSERVATION_SCHEMA = 'commander.shadow-observation/v1' as const;
export const SHADOW_WORKFLOW = 'kubernetes.deployment.rollback' as const;

export const SHADOW_PRODUCTION_DECISIONS = [
  'allow',
  'deny',
  'require_approval',
  'unknown',
] as const;
export type ShadowProductionDecision = (typeof SHADOW_PRODUCTION_DECISIONS)[number];

export const SHADOW_PRODUCTION_REASON_CODES = [
  'REGISTERED_ADAPTER_POLICY',
  'UNREGISTERED_EFFECT_TYPE',
  'UNREGISTERED_DESTINATION',
] as const;
export type ShadowProductionReasonCode = (typeof SHADOW_PRODUCTION_REASON_CODES)[number];

export type ShadowContractErrorCode =
  | 'SHADOW_INVALID_VALUE'
  | 'SHADOW_UNKNOWN_FIELD'
  | 'SHADOW_MISSING_FIELD'
  | 'SHADOW_INVALID_IDENTIFIER'
  | 'SHADOW_INVALID_SCHEMA'
  | 'SHADOW_UNSUPPORTED_WORKFLOW'
  | 'SHADOW_INVALID_DECISION'
  | 'SHADOW_INVALID_REASON_CODE'
  | 'SHADOW_INVALID_TIMESTAMP'
  | 'SHADOW_INVALID_DIGEST'
  | 'SHADOW_INVALID_SIGNATURE'
  | 'SHADOW_RECORD_LIMIT'
  | 'SHADOW_INDEX_SEQUENCE'
  | 'SHADOW_DUPLICATE_OBSERVATION'
  | 'SHADOW_SIZE_LIMIT';

export class ShadowContractError extends Error {
  constructor(
    public readonly code: ShadowContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ShadowContractError';
  }
}

export interface ShadowManifestRecordV1 {
  index: number;
  observationId: string;
  digest: string;
}

export interface ShadowManifestV1 {
  schema: typeof SHADOW_MANIFEST_SCHEMA;
  campaignId: string;
  tenantId: string;
  producerId: string;
  policyId: string;
  policyDigest: string;
  batchId: string;
  closesAt: string;
  records: ShadowManifestRecordV1[];
  keyId: string;
  signature: string;
}

export interface ShadowObservationV1 {
  schema: typeof SHADOW_OBSERVATION_SCHEMA;
  campaignId: string;
  tenantId: string;
  producerId: string;
  batchId: string;
  index: number;
  observationId: string;
  occurredAt: string;
  workflow: typeof SHADOW_WORKFLOW;
  effectType: string | null;
  tool: string | null;
  destination: string | null;
  productionDecision: ShadowProductionDecision;
  productionReasonCode?: ShadowProductionReasonCode;
}

const MANIFEST_KEYS = [
  'schema',
  'campaignId',
  'tenantId',
  'producerId',
  'policyId',
  'policyDigest',
  'batchId',
  'closesAt',
  'records',
  'keyId',
  'signature',
] as const;
const OBSERVATION_REQUIRED_KEYS = [
  'schema',
  'campaignId',
  'tenantId',
  'producerId',
  'batchId',
  'index',
  'observationId',
  'occurredAt',
  'workflow',
  'effectType',
  'tool',
  'destination',
  'productionDecision',
] as const;
const OBSERVATION_KEYS = [...OBSERVATION_REQUIRED_KEYS, 'productionReasonCode'] as const;
const RECORD_KEYS = ['index', 'observationId', 'digest'] as const;
const IDENTIFIER = /^[\x21-\x7e]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]+$/;

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShadowContractError('SHADOW_INVALID_VALUE', 'expected an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ShadowContractError('SHADOW_UNKNOWN_FIELD', `field '${key}' is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ShadowContractError('SHADOW_MISSING_FIELD', `field '${key}' is required`);
    }
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ShadowContractError(
      'SHADOW_INVALID_IDENTIFIER',
      `field '${field}' must be 1-128 printable ASCII characters`,
    );
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : identifier(value, field);
}

function indexValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ShadowContractError(
      'SHADOW_INVALID_VALUE',
      `field '${field}' must be a non-negative integer`,
    );
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ShadowContractError(
      'SHADOW_INVALID_TIMESTAMP',
      `field '${field}' must be an RFC 3339 UTC timestamp`,
    );
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new ShadowContractError(
      'SHADOW_INVALID_TIMESTAMP',
      `field '${field}' must be a canonical RFC 3339 UTC timestamp`,
    );
  }
  return value;
}

function digestValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new ShadowContractError(
      'SHADOW_INVALID_DIGEST',
      `field '${field}' must be lowercase SHA-256 hex`,
    );
  }
  return value;
}

function assertSize(value: unknown, maximum: number): void {
  let length: number;
  try {
    length = canonicalBytes(value).length;
  } catch {
    throw new ShadowContractError('SHADOW_INVALID_VALUE', 'value is not canonical JSON');
  }
  if (length > maximum) {
    throw new ShadowContractError('SHADOW_SIZE_LIMIT', `canonical value exceeds ${maximum} bytes`);
  }
}

export function parseShadowManifest(value: unknown): ShadowManifestV1 {
  assertSize(value, 2 * 1024 * 1024);
  const input = objectValue(value);
  exactKeys(input, MANIFEST_KEYS);
  if (input.schema !== SHADOW_MANIFEST_SCHEMA) {
    throw new ShadowContractError(
      'SHADOW_INVALID_SCHEMA',
      `schema must be '${SHADOW_MANIFEST_SCHEMA}'`,
    );
  }
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 10_000) {
    throw new ShadowContractError('SHADOW_RECORD_LIMIT', 'manifest must declare 1-10000 records');
  }
  const seen = new Set<string>();
  const records = input.records.map((rawRecord, position): ShadowManifestRecordV1 => {
    const record = objectValue(rawRecord);
    exactKeys(record, RECORD_KEYS);
    const index = indexValue(record.index, 'records.index');
    if (index !== position) {
      throw new ShadowContractError(
        'SHADOW_INDEX_SEQUENCE',
        'record indexes must be unique and contiguous from zero',
      );
    }
    const observationId = identifier(record.observationId, 'records.observationId');
    if (seen.has(observationId)) {
      throw new ShadowContractError(
        'SHADOW_DUPLICATE_OBSERVATION',
        `duplicate observation '${observationId}'`,
      );
    }
    seen.add(observationId);
    return { index, observationId, digest: digestValue(record.digest, 'records.digest') };
  });
  if (
    typeof input.signature !== 'string' ||
    !SIGNATURE.test(input.signature) ||
    Buffer.from(input.signature, 'base64url').length !== 64 ||
    Buffer.from(input.signature, 'base64url').toString('base64url') !== input.signature
  ) {
    throw new ShadowContractError(
      'SHADOW_INVALID_SIGNATURE',
      'signature must be unpadded base64url',
    );
  }
  return {
    schema: SHADOW_MANIFEST_SCHEMA,
    campaignId: identifier(input.campaignId, 'campaignId'),
    tenantId: identifier(input.tenantId, 'tenantId'),
    producerId: identifier(input.producerId, 'producerId'),
    policyId: identifier(input.policyId, 'policyId'),
    policyDigest: digestValue(input.policyDigest, 'policyDigest'),
    batchId: identifier(input.batchId, 'batchId'),
    closesAt: timestamp(input.closesAt, 'closesAt'),
    records,
    keyId: identifier(input.keyId, 'keyId'),
    signature: input.signature,
  };
}

export function parseShadowObservation(value: unknown): ShadowObservationV1 {
  assertSize(value, 16 * 1024);
  const input = objectValue(value);
  exactKeys(input, OBSERVATION_KEYS, OBSERVATION_REQUIRED_KEYS);
  if (input.schema !== SHADOW_OBSERVATION_SCHEMA) {
    throw new ShadowContractError(
      'SHADOW_INVALID_SCHEMA',
      `schema must be '${SHADOW_OBSERVATION_SCHEMA}'`,
    );
  }
  if (input.workflow !== SHADOW_WORKFLOW) {
    throw new ShadowContractError(
      'SHADOW_UNSUPPORTED_WORKFLOW',
      `workflow must be '${SHADOW_WORKFLOW}'`,
    );
  }
  if (!SHADOW_PRODUCTION_DECISIONS.includes(input.productionDecision as ShadowProductionDecision)) {
    throw new ShadowContractError('SHADOW_INVALID_DECISION', 'productionDecision is not supported');
  }
  const reason = input.productionReasonCode;
  if (
    reason !== undefined &&
    !SHADOW_PRODUCTION_REASON_CODES.includes(reason as ShadowProductionReasonCode)
  ) {
    throw new ShadowContractError(
      'SHADOW_INVALID_REASON_CODE',
      'productionReasonCode is not supported',
    );
  }
  return {
    schema: SHADOW_OBSERVATION_SCHEMA,
    campaignId: identifier(input.campaignId, 'campaignId'),
    tenantId: identifier(input.tenantId, 'tenantId'),
    producerId: identifier(input.producerId, 'producerId'),
    batchId: identifier(input.batchId, 'batchId'),
    index: indexValue(input.index, 'index'),
    observationId: identifier(input.observationId, 'observationId'),
    occurredAt: timestamp(input.occurredAt, 'occurredAt'),
    workflow: SHADOW_WORKFLOW,
    effectType: nullableIdentifier(input.effectType, 'effectType'),
    tool: nullableIdentifier(input.tool, 'tool'),
    destination: nullableIdentifier(input.destination, 'destination'),
    productionDecision: input.productionDecision as ShadowProductionDecision,
    ...(reason === undefined ? {} : { productionReasonCode: reason as ShadowProductionReasonCode }),
  };
}

export function parseShadowObservationBinding(
  value: unknown,
): Pick<
  ShadowObservationV1,
  'tenantId' | 'campaignId' | 'producerId' | 'batchId' | 'index' | 'observationId'
> {
  assertSize(value, 16 * 1024);
  const input = objectValue(value);
  return {
    tenantId: identifier(input.tenantId, 'tenantId'),
    campaignId: identifier(input.campaignId, 'campaignId'),
    producerId: identifier(input.producerId, 'producerId'),
    batchId: identifier(input.batchId, 'batchId'),
    index: indexValue(input.index, 'index'),
    observationId: identifier(input.observationId, 'observationId'),
  };
}
