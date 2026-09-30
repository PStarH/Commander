import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalBootstrapJson } from './canonicalBootstrap.js';

/** SHA-256 of the literal committed classifier artifact, never catalog-discovered. */
export const AUTHORITY_CLASSIFIER_MANIFEST_SHA256 =
  'e2d15e6403cc363e050bfe092de8e28197c86b7980f1fe83e0f079fb20a7d008';

const categories = new Set([
  'app-context',
  'tenant-authority-issuer',
  'app-product-shared',
  'runtime-daemon',
  'owner-lifecycle',
  'private-helper',
  'structural-trigger',
]);

export type AuthorityClassifierCategory =
  | 'app-context'
  | 'tenant-authority-issuer'
  | 'app-product-shared'
  | 'runtime-daemon'
  | 'owner-lifecycle'
  | 'private-helper'
  | 'structural-trigger';

export interface AuthorityClassifierTriggerBinding {
  relation: string;
  events: readonly string[];
  columns: readonly string[];
}

export interface AuthorityClassifierRow {
  signature: string;
  category: AuthorityClassifierCategory;
  owner: string;
  executableRoles: readonly string[];
  allowedSessionUsers: readonly string[];
  allowedRelations: readonly string[];
  appResolverRequired: boolean;
  triggerBinding: AuthorityClassifierTriggerBinding | null;
}

export interface AuthorityClassifierPolicy {
  relation: string;
  role: string;
  name: string;
  command: string;
}

export interface AuthorityClassifierManifestV1 {
  version: 'authority_classifier_manifest/v1';
  rows: readonly AuthorityClassifierRow[];
  policies: readonly AuthorityClassifierPolicy[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function isExactStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('*')) &&
    new Set(value).size === value.length
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`AUTHORITY_CLASSIFIER_MANIFEST_INVALID: ${message}`);
}

function verifyRow(value: unknown): AuthorityClassifierRow {
  assert(isRecord(value), 'row must be an object');
  assert(
    hasExactKeys(value, [
      'signature',
      'category',
      'owner',
      'executableRoles',
      'allowedSessionUsers',
      'allowedRelations',
      'appResolverRequired',
      'triggerBinding',
    ]),
    'row keys must exactly match the v1 contract',
  );
  assert(
    typeof value.signature === 'string' &&
      value.signature.length > 0 &&
      !value.signature.includes('*'),
    'row signature must be exact',
  );
  assert(
    typeof value.category === 'string' && categories.has(value.category),
    'row category is not recognized',
  );
  assert(
    typeof value.owner === 'string' && value.owner.length > 0 && !value.owner.includes('*'),
    'row owner must be exact',
  );
  assert(
    isExactStringList(value.executableRoles),
    'row executableRoles must be an exact string list',
  );
  assert(
    isExactStringList(value.allowedSessionUsers),
    'row allowedSessionUsers must be an exact string list',
  );
  assert(
    isExactStringList(value.allowedRelations),
    'row allowedRelations must be an exact string list',
  );
  assert(typeof value.appResolverRequired === 'boolean', 'row appResolverRequired must be boolean');

  if (value.triggerBinding !== null) {
    assert(isRecord(value.triggerBinding), 'row triggerBinding must be null or an object');
    assert(
      hasExactKeys(value.triggerBinding, ['relation', 'events', 'columns']),
      'triggerBinding keys must exactly match the v1 contract',
    );
    assert(
      typeof value.triggerBinding.relation === 'string' &&
        value.triggerBinding.relation.length > 0 &&
        !value.triggerBinding.relation.includes('*'),
      'trigger relation must be exact',
    );
    assert(
      isExactStringList(value.triggerBinding.events),
      'trigger events must be an exact string list',
    );
    assert(
      isExactStringList(value.triggerBinding.columns),
      'trigger columns must be an exact string list',
    );
  }

  return value as unknown as AuthorityClassifierRow;
}

function verifyPolicy(value: unknown): AuthorityClassifierPolicy {
  assert(isRecord(value), 'policy must be an object');
  assert(
    hasExactKeys(value, ['relation', 'role', 'name', 'command']),
    'policy keys must exactly match the v1 contract',
  );
  for (const field of ['relation', 'role', 'name', 'command'] as const) {
    assert(
      typeof value[field] === 'string' && value[field].length > 0 && !value[field].includes('*'),
      `policy ${field} must be exact`,
    );
  }
  return value as unknown as AuthorityClassifierPolicy;
}

export function verifyAuthorityClassifierManifest(value: unknown): AuthorityClassifierManifestV1 {
  assert(isRecord(value), 'manifest must be an object');
  assert(
    hasExactKeys(value, ['version', 'rows', 'policies']),
    'manifest keys must exactly match the v1 contract',
  );
  assert(value.version === 'authority_classifier_manifest/v1', 'manifest version is not v1');
  assert(Array.isArray(value.rows) && value.rows.length > 0, 'manifest rows must be non-empty');
  assert(Array.isArray(value.policies), 'manifest policies must be an array');

  const rows = value.rows.map(verifyRow);
  const policies = value.policies.map(verifyPolicy);
  assert(
    new Set(rows.map((row) => row.signature)).size === rows.length,
    'manifest has duplicate signatures',
  );
  assert(
    new Set(
      policies.map(
        (policy) => `${policy.relation}:${policy.role}:${policy.name}:${policy.command}`,
      ),
    ).size === policies.length,
    'manifest has duplicate policies',
  );
  return { version: value.version, rows, policies };
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function sameTriggerBinding(
  left: AuthorityClassifierTriggerBinding | null,
  right: AuthorityClassifierTriggerBinding | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.relation === right.relation &&
      sameStringList(left.events, right.events) &&
      sameStringList(left.columns, right.columns))
  );
}

function catalogMismatch(kind: string): never {
  throw new Error(`AUTHORITY_CLASSIFIER_CATALOG_MISMATCH: ${kind}`);
}

/** Compare a catalog-proof observation to the immutable expected artifact. */
export function verifyAuthorityClassifierCatalog(
  expected: AuthorityClassifierManifestV1,
  observedValue: unknown,
): AuthorityClassifierManifestV1 {
  const observed = verifyAuthorityClassifierManifest(observedValue);
  const expectedRows = new Map(expected.rows.map((row) => [row.signature, row]));
  const observedRows = new Map(observed.rows.map((row) => [row.signature, row]));

  for (const signature of expectedRows.keys()) {
    if (!observedRows.has(signature)) catalogMismatch('missing');
  }
  for (const signature of observedRows.keys()) {
    if (!expectedRows.has(signature)) catalogMismatch('extra');
  }
  for (const [signature, expectedRow] of expectedRows) {
    const observedRow = observedRows.get(signature)!;
    if (observedRow.category !== expectedRow.category) catalogMismatch('category');
    if (!sameStringList(observedRow.allowedRelations, expectedRow.allowedRelations))
      catalogMismatch('dependency');
    if (
      !sameStringList(observedRow.executableRoles, expectedRow.executableRoles) ||
      !sameStringList(observedRow.allowedSessionUsers, expectedRow.allowedSessionUsers)
    ) {
      catalogMismatch('grant');
    }
    if (
      observedRow.owner !== expectedRow.owner ||
      observedRow.appResolverRequired !== expectedRow.appResolverRequired
    ) {
      catalogMismatch('row');
    }
    if (!sameTriggerBinding(observedRow.triggerBinding, expectedRow.triggerBinding))
      catalogMismatch('trigger');
  }

  const policyKey = (policy: AuthorityClassifierPolicy) => `${policy.relation}:${policy.name}`;
  const expectedPolicies = new Map(expected.policies.map((policy) => [policyKey(policy), policy]));
  const observedPolicies = new Map(observed.policies.map((policy) => [policyKey(policy), policy]));
  if (expectedPolicies.size !== observedPolicies.size) catalogMismatch('policy');
  for (const [key, expectedPolicy] of expectedPolicies) {
    const observedPolicy = observedPolicies.get(key);
    if (
      !observedPolicy ||
      observedPolicy.role !== expectedPolicy.role ||
      observedPolicy.command !== expectedPolicy.command
    ) {
      catalogMismatch('policy');
    }
  }
  return observed;
}

export function exportAuthorityClassifierManifest(
  manifest: AuthorityClassifierManifestV1 = AUTHORITY_CLASSIFIER_MANIFEST_V1,
): string {
  return canonicalBootstrapJson({
    version: manifest.version,
    rows: [...manifest.rows].sort((a, b) => a.signature.localeCompare(b.signature)),
    policies: [...manifest.policies].sort((a, b) =>
      `${a.relation}:${a.role}:${a.name}:${a.command}`.localeCompare(
        `${b.relation}:${b.role}:${b.name}:${b.command}`,
      ),
    ),
  });
}

export function authorityClassifierManifestSha256(
  manifest: AuthorityClassifierManifestV1 = AUTHORITY_CLASSIFIER_MANIFEST_V1,
): string {
  return createHash('sha256').update(exportAuthorityClassifierManifest(manifest)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The package publishes src alongside dist; this resolves to the same committed artifact in both.
const rawManifest = readFileSync(
  new URL('../src/authorityClassifierManifest.v1.json', import.meta.url),
  'utf8',
);
export const AUTHORITY_CLASSIFIER_MANIFEST_V1 = deepFreeze(
  verifyAuthorityClassifierManifest(JSON.parse(rawManifest)),
);

if (
  authorityClassifierManifestSha256(AUTHORITY_CLASSIFIER_MANIFEST_V1) !==
  AUTHORITY_CLASSIFIER_MANIFEST_SHA256
) {
  throw new Error('AUTHORITY_CLASSIFIER_MANIFEST_CHECKSUM_MISMATCH');
}
