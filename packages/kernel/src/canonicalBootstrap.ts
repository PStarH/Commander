import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const TASK1_DATABASE_ROLES = [
  'adapter-ops',
  'app',
  'owner',
  'scheduler',
  'tenant-authority',
  'worker',
] as const;

export type Task1DatabaseRole = (typeof TASK1_DATABASE_ROLES)[number];

export interface DatabasePeerBindingInputRoleV1 {
  role: Task1DatabaseRole;
  host: string;
  port: number;
}

export interface DatabasePeerBindingInputV1 {
  format: 'database_peer_binding_input/v1';
  roles: DatabasePeerBindingInputRoleV1[];
  expectedServerSpkiSha256: string;
  ca: { mountIdentity: string; path: string; publicBytesSha256: string };
}

export interface DatabasePeerBindingRoleV1 extends DatabasePeerBindingInputRoleV1 {
  tlsServerSans: { dns: string[]; ip: string[] };
  serverSpkiSha256: string;
  databaseOid: string;
  databaseName: string;
}

export interface DatabasePeerBindingV1 {
  format: 'database_peer_binding_v1';
  roles: DatabasePeerBindingRoleV1[];
}

export interface BootstrapIdentityV1 {
  oid: string;
  name: string;
  superuser: boolean;
  commanderNamed: boolean;
}

export interface BootstrapIdentitiesV1 {
  format: 'bootstrap_identities/v1';
  envelope: 'E1' | 'E2';
  authority: BootstrapIdentityV1;
  bootstrapSuperuser: BootstrapIdentityV1;
}

export interface PrebootstrapInventoryV1 extends Record<string, unknown> {
  format: 'prebootstrap_inventory/v1';
  postgresVersion: string;
  catalogVersion: string;
  databaseIdentity: { oid: string; name: string };
  ledger: Array<Record<string, unknown>> | null;
  namespaces: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  functions: Array<Record<string, unknown>>;
  types: Array<Record<string, unknown>>;
  extensions: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  triggers: Array<Record<string, unknown>>;
  productSources: string[];
  productHasRows: Array<{ relation: unknown; hasRows: boolean }>;
  roles: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  roleSettings: Array<Record<string, unknown>>;
  databaseAcl: Array<Record<string, unknown>>;
  schemaAcls: Array<Record<string, unknown>>;
  defaultAcls: Array<Record<string, unknown>>;
  bootstrapIdentities: BootstrapIdentitiesV1 | null;
}

export interface PrebootstrapSnapshotsV1 {
  format: 'prebootstrap_snapshots/v1';
  s0: PrebootstrapInventoryV1;
  s0Sha256: string;
  s1: PrebootstrapInventoryV1;
  s1Sha256: string;
  comparisonKind: 'fresh-byte-equal' | 'legacy-except-product-has-rows';
}

export interface OriginBindingV1 {
  format: 'origin_binding/v1';
  prebootstrapSnapshotsSha256: string;
  bootstrapIdentities: BootstrapIdentitiesV1 | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const PREBOOTSTRAP_KEYS = [
  'format',
  'postgresVersion',
  'catalogVersion',
  'databaseIdentity',
  'ledger',
  'namespaces',
  'relations',
  'functions',
  'types',
  'extensions',
  'policies',
  'triggers',
  'productSources',
  'productHasRows',
  'roles',
  'memberships',
  'roleSettings',
  'databaseAcl',
  'schemaAcls',
  'defaultAcls',
  'bootstrapIdentities',
] as const;

function invalid(suffix = ''): never {
  throw new Error(`COMMANDER_CANONICAL_JSON_INVALID${suffix}`);
}

function assertUnicodeScalar(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalid('_UNICODE');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid('_UNICODE');
    }
  }
}

function assertCanonicalValue(value: unknown, active: Set<object>): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertUnicodeScalar(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid();
    return;
  }
  if (typeof value !== 'object') invalid();
  if (active.has(value)) throw new Error('COMMANDER_CANONICAL_JSON_CYCLE');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertCanonicalValue(item, active);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalid();
      assertUnicodeScalar(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
      assertCanonicalValue(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

export function canonicalBootstrapJson(value: unknown): string {
  assertCanonicalValue(value, new Set());
  return encodeCanonicalValue(value);
}

function encodeCanonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonicalValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonicalValue(record[key])}`)
    .join(',')}}`;
}

export function canonicalBootstrapSha256(value: unknown): string {
  return createHash('sha256').update(canonicalBootstrapJson(value), 'utf8').digest('hex');
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  errorCode: string,
): void {
  const actual = Object.keys(value).sort(byteCompare);
  const expected = [...keys].sort(byteCompare);
  if (canonicalBootstrapJson(actual) !== canonicalBootstrapJson(expected))
    throw new Error(errorCode);
}

function normalizedIp(value: string): string {
  const version = isIP(value);
  if (version === 0) throw new Error('DATABASE_PEER_BINDING_INVALID_IP_SAN');
  if (version === 4)
    return value
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  const hostname = new URL(`https://[${value}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

function normalizedDns(value: string): string {
  const wildcard = value.startsWith('*.');
  const source = wildcard ? value.slice(2) : value;
  const withoutRootDot = source.endsWith('.') ? source.slice(0, -1) : source;
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.includes('*') || ascii.split('.').some((label) => !label)) {
    throw new Error('DATABASE_PEER_BINDING_INVALID_DNS_SAN');
  }
  return wildcard ? `*.${ascii}` : ascii;
}

function normalizedHost(value: string): string {
  const withoutBrackets = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return isIP(withoutBrackets) ? normalizedIp(withoutBrackets) : normalizedDns(value);
}

function uniqueSorted(values: readonly string[], normalize: (value: string) => string): string[] {
  return [...new Set(values.map(normalize))].sort(byteCompare);
}

function assertRoleSet(roles: readonly { role: string }[]): void {
  const actual = roles.map(({ role }) => role).sort(byteCompare);
  if (canonicalBootstrapJson(actual) !== canonicalBootstrapJson(TASK1_DATABASE_ROLES)) {
    throw new Error('DATABASE_PEER_BINDING_INVALID_ROLE_SET');
  }
}

function normalizePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('DATABASE_PEER_BINDING_INVALID_PORT');
  }
  return value;
}

function normalizeSha256(value: string, errorCode: string): string {
  if (!SHA256.test(value)) throw new Error(errorCode);
  return value;
}

function normalizePath(value: string): string {
  if (
    !value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('DATABASE_PEER_BINDING_INVALID_CA_PATH');
  }
  return value;
}

export function createDatabasePeerBindingInput(input: {
  roles: readonly DatabasePeerBindingInputRoleV1[];
  expectedServerSpkiSha256: string;
  ca: { mountIdentity: string; path: string; publicBytesSha256: string };
}): DatabasePeerBindingInputV1 {
  assertRoleSet(input.roles);
  if (!input.ca.mountIdentity) throw new Error('DATABASE_PEER_BINDING_INVALID_CA_IDENTITY');
  return {
    format: 'database_peer_binding_input/v1',
    roles: input.roles
      .map(({ role, host, port }) => ({
        role,
        host: normalizedHost(host),
        port: normalizePort(port),
      }))
      .sort((left, right) => byteCompare(left.role, right.role)),
    expectedServerSpkiSha256: normalizeSha256(
      input.expectedServerSpkiSha256,
      'DATABASE_PEER_BINDING_INVALID_EXPECTED_SPKI',
    ),
    ca: {
      mountIdentity: input.ca.mountIdentity,
      path: normalizePath(input.ca.path),
      publicBytesSha256: normalizeSha256(
        input.ca.publicBytesSha256,
        'DATABASE_PEER_BINDING_INVALID_CA_SHA256',
      ),
    },
  };
}

export function createDatabasePeerBinding(input: {
  format?: 'database_peer_binding_v1';
  roles: readonly DatabasePeerBindingRoleV1[];
}): DatabasePeerBindingV1 {
  assertRoleSet(input.roles);
  const roles = input.roles
    .map((entry): DatabasePeerBindingRoleV1 => {
      if (!POSITIVE_DECIMAL.test(entry.databaseOid) || !entry.databaseName) {
        throw new Error('DATABASE_PEER_BINDING_INVALID_DATABASE_IDENTITY');
      }
      return {
        role: entry.role,
        host: normalizedHost(entry.host),
        port: normalizePort(entry.port),
        tlsServerSans: {
          dns: uniqueSorted(entry.tlsServerSans.dns, normalizedDns),
          ip: uniqueSorted(entry.tlsServerSans.ip, normalizedIp),
        },
        serverSpkiSha256: normalizeSha256(
          entry.serverSpkiSha256,
          'DATABASE_PEER_BINDING_INVALID_OBSERVED_SPKI',
        ),
        databaseOid: entry.databaseOid,
        databaseName: entry.databaseName,
      };
    })
    .sort((left, right) => byteCompare(left.role, right.role));
  return { format: 'database_peer_binding_v1', roles };
}

function dnsSanCovers(host: string, san: string): boolean {
  if (!san.startsWith('*.')) return host === san;
  const suffix = san.slice(1);
  return (
    host.endsWith(suffix) &&
    host.slice(0, -suffix.length).length > 0 &&
    !host.slice(0, -suffix.length).includes('.')
  );
}

export function verifyDatabasePeerBinding(
  declaredValue: DatabasePeerBindingInputV1,
  observedValue: DatabasePeerBindingV1,
): DatabasePeerBindingV1 {
  const declared = createDatabasePeerBindingInput(declaredValue);
  const observed = createDatabasePeerBinding(observedValue);
  const databaseIdentities = new Set(
    observed.roles.map(
      ({ databaseOid, databaseName, serverSpkiSha256 }) =>
        `${databaseOid}\0${databaseName}\0${serverSpkiSha256}`,
    ),
  );
  if (databaseIdentities.size !== 1)
    throw new Error('DATABASE_PEER_BINDING_INVALID_COMMON_IDENTITY');
  for (const entry of observed.roles) {
    const expected = declared.roles.find(({ role }) => role === entry.role)!;
    const covered = isIP(entry.host)
      ? entry.tlsServerSans.ip.includes(entry.host)
      : entry.tlsServerSans.dns.some((san) => dnsSanCovers(entry.host, san));
    if (
      expected.host !== entry.host ||
      expected.port !== entry.port ||
      !covered ||
      entry.serverSpkiSha256 !== declared.expectedServerSpkiSha256
    ) {
      throw new Error('DATABASE_PEER_BINDING_INVALID');
    }
  }
  return observed;
}

function verifyBootstrapIdentity(value: unknown): BootstrapIdentityV1 {
  const identity = record(value, 'PREBOOTSTRAP_BOOTSTRAP_IDENTITY_INVALID');
  exactKeys(
    identity,
    ['oid', 'name', 'superuser', 'commanderNamed'],
    'PREBOOTSTRAP_BOOTSTRAP_IDENTITY_INVALID',
  );
  if (
    !POSITIVE_DECIMAL.test(String(identity.oid)) ||
    typeof identity.name !== 'string' ||
    !identity.name ||
    typeof identity.superuser !== 'boolean' ||
    typeof identity.commanderNamed !== 'boolean'
  ) {
    throw new Error('PREBOOTSTRAP_BOOTSTRAP_IDENTITY_INVALID');
  }
  return identity as unknown as BootstrapIdentityV1;
}

function verifyBootstrapIdentities(value: unknown): BootstrapIdentitiesV1 | null {
  if (value === null) return null;
  const identities = record(value, 'PREBOOTSTRAP_BOOTSTRAP_IDENTITIES_INVALID');
  exactKeys(
    identities,
    ['format', 'envelope', 'authority', 'bootstrapSuperuser'],
    'PREBOOTSTRAP_BOOTSTRAP_IDENTITIES_INVALID',
  );
  if (
    identities.format !== 'bootstrap_identities/v1' ||
    (identities.envelope !== 'E1' && identities.envelope !== 'E2')
  ) {
    throw new Error('PREBOOTSTRAP_BOOTSTRAP_IDENTITIES_INVALID');
  }
  return {
    format: 'bootstrap_identities/v1',
    envelope: identities.envelope,
    authority: verifyBootstrapIdentity(identities.authority),
    bootstrapSuperuser: verifyBootstrapIdentity(identities.bootstrapSuperuser),
  };
}

function verifyInventory(value: unknown): PrebootstrapInventoryV1 {
  const inventory = record(value, 'PREBOOTSTRAP_INVENTORY_INVALID');
  exactKeys(inventory, PREBOOTSTRAP_KEYS, 'PREBOOTSTRAP_INVENTORY_INVALID');
  if (
    inventory.format !== 'prebootstrap_inventory/v1' ||
    !Array.isArray(inventory.productHasRows)
  ) {
    throw new Error('PREBOOTSTRAP_INVENTORY_INVALID');
  }
  for (const key of PREBOOTSTRAP_KEYS) {
    if (
      [
        'format',
        'postgresVersion',
        'catalogVersion',
        'databaseIdentity',
        'ledger',
        'bootstrapIdentities',
      ].includes(key)
    )
      continue;
    if (!Array.isArray(inventory[key])) throw new Error('PREBOOTSTRAP_INVENTORY_INVALID');
  }
  const productHasRows = inventory.productHasRows.map((item) => {
    const entry = record(item, 'PREBOOTSTRAP_INVENTORY_INVALID');
    exactKeys(entry, ['relation', 'hasRows'], 'PREBOOTSTRAP_INVENTORY_INVALID');
    if (typeof entry.hasRows !== 'boolean') throw new Error('PREBOOTSTRAP_INVENTORY_INVALID');
    return { relation: entry.relation, hasRows: entry.hasRows };
  });
  return {
    ...inventory,
    format: 'prebootstrap_inventory/v1',
    productHasRows,
    bootstrapIdentities: verifyBootstrapIdentities(inventory.bootstrapIdentities),
  } as PrebootstrapInventoryV1;
}

function withoutProductRows(inventory: PrebootstrapInventoryV1): Record<string, unknown> {
  const { productHasRows: _productHasRows, ...stable } = inventory;
  return stable;
}

export function createPrebootstrapSnapshots(
  s0Value: unknown,
  s1Value: unknown,
): PrebootstrapSnapshotsV1 {
  const s0 = verifyInventory(s0Value);
  const s1 = verifyInventory(s1Value);
  const byteEqual = canonicalBootstrapJson(s0) === canonicalBootstrapJson(s1);
  const fresh =
    byteEqual &&
    s0.bootstrapIdentities !== null &&
    s0.productHasRows.every(({ hasRows }) => !hasRows);
  const legacyEqual =
    canonicalBootstrapJson(withoutProductRows(s0)) ===
    canonicalBootstrapJson(withoutProductRows(s1));
  const legacy = legacyEqual && s0.bootstrapIdentities === null && s1.bootstrapIdentities === null;
  if (!fresh && !legacy) throw new Error('PREBOOTSTRAP_INVENTORY_CHANGED');
  return {
    format: 'prebootstrap_snapshots/v1',
    s0,
    s0Sha256: canonicalBootstrapSha256(s0),
    s1,
    s1Sha256: canonicalBootstrapSha256(s1),
    comparisonKind: fresh ? 'fresh-byte-equal' : 'legacy-except-product-has-rows',
  };
}

export function createOriginBinding(snapshots: PrebootstrapSnapshotsV1): OriginBindingV1 {
  if (
    snapshots.s0Sha256 !== canonicalBootstrapSha256(snapshots.s0) ||
    snapshots.s1Sha256 !== canonicalBootstrapSha256(snapshots.s1)
  ) {
    throw new Error('ORIGIN_BINDING_INVALID_SNAPSHOT_DIGEST');
  }
  const identities = snapshots.s0.bootstrapIdentities;
  if (
    canonicalBootstrapJson(identities) !== canonicalBootstrapJson(snapshots.s1.bootstrapIdentities)
  ) {
    throw new Error('ORIGIN_BINDING_INVALID_BOOTSTRAP_IDENTITIES');
  }
  return {
    format: 'origin_binding/v1',
    prebootstrapSnapshotsSha256: canonicalBootstrapSha256(snapshots),
    bootstrapIdentities: identities,
  };
}

/** Validates persisted origin evidence only; it never collects or reclassifies a live catalog. */
export function verifyPersistedOriginBinding(
  snapshotsValue: unknown,
  originValue: unknown,
): { snapshots: PrebootstrapSnapshotsV1; origin: OriginBindingV1 } {
  const snapshots = record(snapshotsValue, 'ORIGIN_BINDING_INVALID_SNAPSHOTS');
  exactKeys(
    snapshots,
    ['format', 's0', 's0Sha256', 's1', 's1Sha256', 'comparisonKind'],
    'ORIGIN_BINDING_INVALID_SNAPSHOTS',
  );
  if (
    snapshots.format !== 'prebootstrap_snapshots/v1' ||
    (snapshots.comparisonKind !== 'fresh-byte-equal' &&
      snapshots.comparisonKind !== 'legacy-except-product-has-rows')
  ) {
    throw new Error('ORIGIN_BINDING_INVALID_SNAPSHOTS');
  }
  const s0 = verifyInventory(snapshots.s0);
  const s1 = verifyInventory(snapshots.s1);
  const comparisonKind = snapshots.comparisonKind as PrebootstrapSnapshotsV1['comparisonKind'];
  const persisted: PrebootstrapSnapshotsV1 = {
    format: 'prebootstrap_snapshots/v1' as const,
    s0,
    s0Sha256: String(snapshots.s0Sha256),
    s1,
    s1Sha256: String(snapshots.s1Sha256),
    comparisonKind,
  };
  if (
    persisted.s0Sha256 !== canonicalBootstrapSha256(s0) ||
    persisted.s1Sha256 !== canonicalBootstrapSha256(s1)
  ) {
    throw new Error('ORIGIN_BINDING_INVALID_SNAPSHOT_DIGEST');
  }
  const freshMatches =
    canonicalBootstrapJson(s0) === canonicalBootstrapJson(s1) &&
    s0.bootstrapIdentities !== null &&
    s0.productHasRows.every(({ hasRows }) => !hasRows);
  const legacyMatches =
    canonicalBootstrapJson(withoutProductRows(s0)) ===
      canonicalBootstrapJson(withoutProductRows(s1)) &&
    s0.bootstrapIdentities === null &&
    s1.bootstrapIdentities === null;
  if (
    (comparisonKind === 'fresh-byte-equal' && !freshMatches) ||
    (comparisonKind === 'legacy-except-product-has-rows' && !legacyMatches)
  ) {
    throw new Error('ORIGIN_BINDING_INVALID_SNAPSHOT_COMPARISON');
  }
  const origin = record(originValue, 'ORIGIN_BINDING_INVALID');
  exactKeys(
    origin,
    ['format', 'prebootstrapSnapshotsSha256', 'bootstrapIdentities'],
    'ORIGIN_BINDING_INVALID',
  );
  if (
    origin.format !== 'origin_binding/v1' ||
    String(origin.prebootstrapSnapshotsSha256) !== canonicalBootstrapSha256(persisted) ||
    canonicalBootstrapJson(origin.bootstrapIdentities) !==
      canonicalBootstrapJson(s0.bootstrapIdentities) ||
    canonicalBootstrapJson(s0.bootstrapIdentities) !==
      canonicalBootstrapJson(s1.bootstrapIdentities)
  ) {
    throw new Error('ORIGIN_BINDING_INVALID');
  }
  return {
    snapshots: persisted,
    origin: {
      format: 'origin_binding/v1',
      prebootstrapSnapshotsSha256: String(origin.prebootstrapSnapshotsSha256),
      bootstrapIdentities: s0.bootstrapIdentities,
    },
  };
}
