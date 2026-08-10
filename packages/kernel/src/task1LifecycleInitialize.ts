import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { PoolClient } from 'pg';
import {
  TASK1_DATABASE_ROLES,
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  createOriginBinding,
  createPrebootstrapSnapshots,
  verifyDatabasePeerBinding,
  verifyPersistedOriginBinding,
  type BootstrapIdentityV1,
  type BootstrapIdentitiesV1,
  type DatabasePeerBindingInputV1,
  type DatabasePeerBindingV1,
  type PrebootstrapInventoryV1,
} from './canonicalBootstrap.js';
import {
  applyTask1CatalogHardening,
  collectTask1LockedCatalogInventory,
  collectTask1PrebootstrapInventory,
  verifyTask1LockedCatalogState,
  type Task1CatalogBootstrapContext,
  type Task1LockedCatalogStateVerification,
} from './task1Catalog.js';
import { observeTask1DatabasePeers } from './task1DatabasePeer.js';
import type { Task1OwnerPreparedRequest } from './task1LifecycleOwnerCommand.js';
import { KERNEL_TASK1_BASELINE_MIGRATIONS, KERNEL_TASK1_CLOSURE_MIGRATIONS } from './migrations.js';
import type { SqlClient } from './postgres.js';

const ROLE_URL_ENV = {
  'adapter-ops': 'COMMANDER_ADAPTER_OPS_DATABASE_URL',
  app: 'COMMANDER_APP_DATABASE_URL',
  owner: 'COMMANDER_OWNER_DATABASE_URL',
  scheduler: 'COMMANDER_SCHEDULER_DATABASE_URL',
  'tenant-authority': 'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
  worker: 'COMMANDER_WORKER_DATABASE_URL',
} as const;

const ROLE_LOGIN = {
  'adapter-ops': 'commander_adapter_ops',
  app: 'commander_app',
  owner: 'commander_owner',
  scheduler: 'commander_scheduler',
  'tenant-authority': 'commander_tenant_authority',
  worker: 'commander_worker',
} as const;

interface Task1PeerObservation {
  input?: DatabasePeerBindingInputV1;
  binding: DatabasePeerBindingV1;
}

type BaselineManifestKind = 'historical' | 'hardened';

export interface Task1LifecycleInitializerDependencies {
  collectInventory?: typeof collectTask1PrebootstrapInventory;
  collectLockedInventory?: typeof collectTask1LockedCatalogInventory;
  verifyLockedCatalogState?: typeof verifyTask1LockedCatalogState;
  applyCatalogHardening?: typeof applyTask1CatalogHardening;
  verifyCatalogBaseline?: (input: {
    classification: 'fresh' | 'legacy';
    snapshots: ReturnType<typeof createPrebootstrapSnapshots>;
  }) => void;
  loadBootstrapContext?: (env: NodeJS.ProcessEnv) => Promise<Task1CatalogBootstrapContext>;
  observeCandidatePeers?: (
    client: SqlClient,
    env: NodeJS.ProcessEnv,
  ) => Promise<Task1PeerObservation>;
  observePeers?: (env: NodeJS.ProcessEnv) => Promise<Task1PeerObservation>;
  proofKeySha256?: (env: NodeJS.ProcessEnv) => string;
  applyRoleCredentials?: (client: SqlClient, env: NodeJS.ProcessEnv) => Promise<void>;
  instantiateManifestSha256?: (
    kind: BaselineManifestKind,
    identities: BootstrapIdentitiesV1 | null,
  ) => string;
  createInstallationUuid?: () => string;
}

interface PinnedManifest {
  source: string;
  sourceSha256: string;
  sha256: string;
}

interface Task1LifecycleCatalogTransaction {
  origin: Parameters<typeof collectTask1LockedCatalogInventory>[1];
  databasePeerBinding: DatabasePeerBindingV1;
  collectInventory?: typeof collectTask1LockedCatalogInventory;
  verifyState?: (input: Task1LockedCatalogStateVerification) => void;
  applyHardening?: typeof applyTask1CatalogHardening;
}

export interface PinnedTask1LifecycleManifests {
  historical: PinnedManifest;
  hardened: PinnedManifest;
  lifecycle: PinnedManifest;
}

const HISTORICAL_SOURCE_SHA256 = 'fe469fca7e019141634f427e2097f46c2060f671bcbf45d3adc3c9fc25217d83';
const HARDENED_SOURCE_SHA256 = '8dc2dd31166b1ec1a361f90513d4628e5516f6303949a6b87b0fdd0bff2566a6';
const LIFECYCLE_MANIFEST_SHA256 =
  '1ab71770a5fc7b175abbbc1704e028ca1f867154ea781535fe363d13d3b55cbf';

function pinnedManifest(path: string, expectedSha256: string): PinnedManifest {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').trimEnd();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
  if (
    canonicalBootstrapJson(parsed) !== source ||
    canonicalBootstrapSha256(parsed) !== expectedSha256
  ) {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
  return { source, sourceSha256: expectedSha256, sha256: expectedSha256 };
}

export const PINNED_TASK1_LIFECYCLE_MANIFESTS: PinnedTask1LifecycleManifests = Object.freeze({
  historical: pinnedManifest(
    '../src/task1HistoricalBaselineManifestSource.v1.json',
    HISTORICAL_SOURCE_SHA256,
  ),
  hardened: pinnedManifest(
    '../src/task1HardenedBaselineManifestSource.v1.json',
    HARDENED_SOURCE_SHA256,
  ),
  lifecycle: pinnedManifest(
    '../src/task1LifecyclePostconditionManifest.v1.json',
    LIFECYCLE_MANIFEST_SHA256,
  ),
});

export function assertPinnedTask1LifecycleManifests(
  manifests: PinnedTask1LifecycleManifests = PINNED_TASK1_LIFECYCLE_MANIFESTS,
): void {
  const expected = [
    [manifests.historical, HISTORICAL_SOURCE_SHA256],
    [manifests.hardened, HARDENED_SOURCE_SHA256],
    [manifests.lifecycle, LIFECYCLE_MANIFEST_SHA256],
  ] as const;
  for (const [manifest, sha256] of expected) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.source);
    } catch {
      throw new Error('MIGRATION_LEDGER_TAMPERED');
    }
    if (
      manifest.sourceSha256 !== sha256 ||
      manifest.sha256 !== sha256 ||
      canonicalBootstrapJson(parsed) !== manifest.source ||
      canonicalBootstrapSha256(parsed) !== sha256
    )
      throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
}

export function planTask1LifecycleInitialization(input: {
  command: Task1OwnerPreparedRequest['command'];
  comparisonKind: 'fresh-byte-equal' | 'legacy-except-product-has-rows';
  configurationSha256?: string;
  existing: {
    state: 'fresh_pending' | 'legacy_pending';
    pendingConfigurationSha256: string | null;
  } | null;
}): { action: 'initialize' | 'retry'; state: 'fresh_pending' | 'legacy_pending' } {
  if (input.existing) {
    const expectedState =
      input.command === 'install_enforce'
        ? 'fresh_pending'
        : input.command === 'expand'
          ? 'legacy_pending'
          : null;
    if (
      expectedState !== input.existing.state ||
      input.configurationSha256 === undefined ||
      input.configurationSha256 !== input.existing.pendingConfigurationSha256
    )
      throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
    return { action: 'retry', state: input.existing.state };
  }
  if (input.command === 'install_enforce' && input.comparisonKind === 'fresh-byte-equal') {
    return { action: 'initialize', state: 'fresh_pending' };
  }
  if (input.command === 'expand' && input.comparisonKind === 'legacy-except-product-has-rows') {
    return { action: 'initialize', state: 'legacy_pending' };
  }
  throw new Error('TENANT_CUTOVER_STATE_INVALID');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`TASK1_LIFECYCLE_${name}_REQUIRED`);
  return value;
}

function lifecycleRolePasswords(
  env: NodeJS.ProcessEnv,
): Record<(typeof TASK1_DATABASE_ROLES)[number], string> {
  const passwords = Object.fromEntries(
    TASK1_DATABASE_ROLES.map((role) => {
      let url: URL;
      let username: string;
      let password: string;
      try {
        url = new URL(required(env, ROLE_URL_ENV[role]));
        username = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
      } catch {
        throw new Error('TASK1_LIFECYCLE_ROLE_CREDENTIAL_INVALID');
      }
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        username !== ROLE_LOGIN[role] ||
        !password ||
        password.includes('\0')
      ) {
        throw new Error('TASK1_LIFECYCLE_ROLE_CREDENTIAL_INVALID');
      }
      return [role, password];
    }),
  ) as Record<(typeof TASK1_DATABASE_ROLES)[number], string>;
  const inherited = [passwords.app, passwords.owner, passwords.scheduler, passwords.worker];
  if (
    passwords['adapter-ops'] === passwords['tenant-authority'] ||
    inherited.includes(passwords['adapter-ops']) ||
    inherited.includes(passwords['tenant-authority'])
  ) {
    throw new Error('TASK1_LIFECYCLE_ROLE_CREDENTIAL_INVALID');
  }
  return passwords;
}

export async function applyTask1LifecycleRoleCredentials(
  client: SqlClient,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const passwords = lifecycleRolePasswords(env);
  await client.query("SELECT pg_catalog.set_config('commander.adapter_ops_password', $1, true)", [
    passwords['adapter-ops'],
  ]);
  await client.query(
    "SELECT pg_catalog.set_config('commander.tenant_authority_password', $1, true)",
    [passwords['tenant-authority']],
  );
  await client.query(`
    DO $task1_roles$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commander_adapter_ops'
      ) THEN
        CREATE ROLE commander_adapter_ops;
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER ROLE commander_adapter_ops LOGIN NOINHERIT CONNECTION LIMIT -1 PASSWORD %L',
        pg_catalog.current_setting('commander.adapter_ops_password')
      );

      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commander_tenant_authority'
      ) THEN
        CREATE ROLE commander_tenant_authority;
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER ROLE commander_tenant_authority LOGIN NOINHERIT CONNECTION LIMIT -1 PASSWORD %L',
        pg_catalog.current_setting('commander.tenant_authority_password')
      );
    END
    $task1_roles$
  `);
}

function proofKeySha256(env: NodeJS.ProcessEnv): string {
  try {
    const certificate = new X509Certificate(
      readFileSync(required(env, 'COMMANDER_TENANT_AUTHORITY_PROOF_PUBLIC_CERT_FILE')),
    );
    return createHash('sha256')
      .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
  } catch {
    throw new Error('TASK1_LIFECYCLE_PROOF_CERTIFICATE_INVALID');
  }
}

export async function loadTask1BootstrapContext(
  client: PoolClient,
): Promise<Task1CatalogBootstrapContext> {
  const result = await client.query<{
    authority_oid: string;
    authority_name: string;
    authority_superuser: boolean;
    bootstrap_oid: string;
    bootstrap_name: string;
    bootstrap_superuser: boolean;
  }>(`
    SELECT authority.oid::text AS authority_oid,
           authority.rolname::text AS authority_name,
           authority.rolsuper AS authority_superuser,
           bootstrap.oid::text AS bootstrap_oid,
           bootstrap.rolname::text AS bootstrap_name,
           bootstrap.rolsuper AS bootstrap_superuser
      FROM pg_catalog.pg_roles AS authority
      JOIN pg_catalog.pg_roles AS bootstrap ON bootstrap.oid = 10
     WHERE authority.rolname = session_user
  `);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) throw new Error('MIGRATION_LEDGER_TAMPERED');
  const identity = (oid: string, name: string, superuser: boolean): BootstrapIdentityV1 => ({
    oid,
    name,
    superuser,
    commanderNamed: name === 'commander' || name.startsWith('commander_'),
  });
  return {
    sessionUser: row.authority_name,
    authority: identity(row.authority_oid, row.authority_name, row.authority_superuser),
    bootstrapSuperuser: identity(row.bootstrap_oid, row.bootstrap_name, row.bootstrap_superuser),
  };
}

export function resolveTask1BootstrapAuthorityUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL?.trim();
  if (explicit) return explicit;
  if (env.COMMANDER_BUNDLED_POSTGRES_BOOTSTRAP !== '1') {
    throw new Error('TASK1_LIFECYCLE_COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL_REQUIRED');
  }
  const user = env.COMMANDER_BUNDLED_POSTGRES_USER?.trim();
  const password = env.COMMANDER_BUNDLED_POSTGRES_PASSWORD;
  let owner: URL;
  try {
    owner = new URL(required(env, 'COMMANDER_OWNER_DATABASE_URL'));
  } catch {
    throw new Error('TASK1_LIFECYCLE_BOOTSTRAP_AUTHORITY_INVALID');
  }
  if (
    !user ||
    !/^[a-z_][a-z0-9_]*$/.test(user) ||
    user === 'commander' ||
    user.startsWith('commander_') ||
    !password ||
    !['postgres:', 'postgresql:'].includes(owner.protocol) ||
    decodeURIComponent(owner.username) !== 'commander_owner' ||
    !owner.hostname ||
    !owner.pathname.slice(1) ||
    owner.searchParams.size !== 1 ||
    owner.searchParams.get('sslmode') !== 'verify-full' ||
    owner.hash
  ) {
    throw new Error('TASK1_LIFECYCLE_BOOTSTRAP_AUTHORITY_INVALID');
  }
  owner.username = user;
  owner.password = password;
  return owner.toString();
}

async function loadBootstrapContext(env: NodeJS.ProcessEnv): Promise<Task1CatalogBootstrapContext> {
  const pool = createVerifiedPostgresPool(
    {
      connectionString: resolveTask1BootstrapAuthorityUrl(env),
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 1_500,
    },
    env,
  );
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    return await loadTask1BootstrapContext(client);
  } finally {
    client?.release();
    await pool.end();
  }
}

function peerCertificate(client: SqlClient): X509Certificate {
  const stream = (
    client as PoolClient & {
      connection?: {
        stream?: { encrypted?: boolean; getPeerCertificate?(detailed?: boolean): { raw?: Buffer } };
      };
    }
  ).connection?.stream;
  const raw = stream?.getPeerCertificate?.(true).raw;
  if (stream?.encrypted !== true || !raw?.length) {
    throw new Error('TASK1_DATABASE_PEER_TLS_SOCKET_REQUIRED');
  }
  try {
    return new X509Certificate(raw);
  } catch {
    throw new Error('TASK1_DATABASE_PEER_CERTIFICATE_INVALID');
  }
}

function certificateSans(certificate: X509Certificate): { dns: string[]; ip: string[] } {
  const dns: string[] = [];
  const ip: string[] = [];
  for (const entry of certificate.subjectAltName?.split(', ') ?? []) {
    if (entry.startsWith('DNS:')) dns.push(entry.slice(4));
    else if (entry.startsWith('IP Address:')) ip.push(entry.slice('IP Address:'.length));
  }
  if (dns.length === 0 && ip.length === 0) {
    throw new Error('TASK1_DATABASE_PEER_CERTIFICATE_SAN_REQUIRED');
  }
  return { dns, ip };
}

function roleUrls(env: NodeJS.ProcessEnv): Record<(typeof TASK1_DATABASE_ROLES)[number], URL> {
  return Object.fromEntries(
    TASK1_DATABASE_ROLES.map((role) => {
      let url: URL;
      try {
        url = new URL(required(env, ROLE_URL_ENV[role]));
      } catch {
        throw new Error('TASK1_DATABASE_PEER_ROLE_URL_INVALID');
      }
      if (
        (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
        decodeURIComponent(url.username) !== ROLE_LOGIN[role] ||
        !url.password ||
        !url.hostname ||
        !url.pathname.slice(1)
      )
        throw new Error('TASK1_DATABASE_PEER_ROLE_URL_INVALID');
      return [role, url];
    }),
  ) as Record<(typeof TASK1_DATABASE_ROLES)[number], URL>;
}

/** Builds the immutable peer candidate from the already-authenticated owner socket only. */
async function observeCandidatePeers(
  client: SqlClient,
  env: NodeJS.ProcessEnv,
): Promise<Task1PeerObservation> {
  const urls = roleUrls(env);
  const caPath = required(env, 'COMMANDER_DATABASE_TLS_CA_FILE');
  const input = createDatabasePeerBindingInput({
    roles: TASK1_DATABASE_ROLES.map((role) => ({
      role,
      host: urls[role].hostname,
      port: Number(urls[role].port || '5432'),
    })),
    expectedServerSpkiSha256: required(env, 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256'),
    ca: {
      mountIdentity: required(env, 'COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY'),
      path: caPath,
      publicBytesSha256: createHash('sha256').update(readFileSync(caPath)).digest('hex'),
    },
  });
  const identity = await client.query<{
    current_user: string;
    session_user: string;
    database_oid: string;
    database_name: string;
  }>(`
    SELECT current_user::text AS current_user,
           session_user::text AS session_user,
           database.oid::text AS database_oid,
           pg_catalog.current_database()::text AS database_name
      FROM pg_catalog.pg_database AS database
     WHERE database.datname = pg_catalog.current_database()
  `);
  const row = identity.rows[0];
  if (
    identity.rowCount !== 1 ||
    row?.current_user !== ROLE_LOGIN.owner ||
    row.session_user !== ROLE_LOGIN.owner ||
    !/^[1-9][0-9]*$/.test(row.database_oid) ||
    row.database_name !== decodeURIComponent(urls.owner.pathname.slice(1))
  )
    throw new Error('TASK1_DATABASE_PEER_ROLE_IDENTITY_INVALID');
  const certificate = peerCertificate(client);
  const sans = certificateSans(certificate);
  const spki = createHash('sha256')
    .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
  const binding = createDatabasePeerBinding({
    roles: TASK1_DATABASE_ROLES.map((role) => ({
      role,
      host: isIP(urls[role].hostname) ? urls[role].hostname : urls[role].hostname.toLowerCase(),
      port: Number(urls[role].port || '5432'),
      tlsServerSans: sans,
      serverSpkiSha256: spki,
      databaseOid: row.database_oid,
      databaseName: row.database_name,
    })),
  });
  verifyDatabasePeerBinding(input, binding);
  return { input, binding };
}

function parsedPinnedSource(kind: BaselineManifestKind): Record<string, unknown> {
  const source = PINNED_TASK1_LIFECYCLE_MANIFESTS[kind].source;
  return JSON.parse(source) as Record<string, unknown>;
}

export function instantiateTask1BaselineManifestSha256(
  kind: BaselineManifestKind,
  identities: BootstrapIdentitiesV1 | null,
): string {
  const source = parsedPinnedSource(kind);
  const classification = identities?.envelope ?? 'legacy';
  const branches = source.branches as Record<string, Record<string, unknown>>;
  const branch = branches[classification];
  if (!branch || branch.classification !== classification) {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
  if (identities === null) {
    if (branch.bootstrapIdentities !== null) throw new Error('MIGRATION_LEDGER_TAMPERED');
  } else {
    const placeholders = branch.bootstrapIdentityPlaceholders;
    if (
      canonicalBootstrapJson(placeholders) !==
      canonicalBootstrapJson([
        'authority.oid',
        'authority.name',
        'bootstrapSuperuser.oid',
        'bootstrapSuperuser.name',
      ])
    )
      throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
  return canonicalBootstrapSha256({
    format: `${kind}_baseline_manifest/v1`,
    classification,
    bootstrapIdentities: identities,
  });
}

function assertExactLegacyLedger(inventory: PrebootstrapInventoryV1): void {
  if (inventory.ledger === null) throw new Error('MIGRATION_LEDGER_TAMPERED');
  const expected = KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => ({
    id,
    checksum,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const actual = inventory.ledger
    .map((row) => ({ id: String(row.id), checksum: String(row.checksum) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalBootstrapJson(actual) !== canonicalBootstrapJson(expected)) {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
}

function assertPreparedPeerInput(
  prepared: Task1OwnerPreparedRequest,
  observed: DatabasePeerBindingInputV1 | undefined,
): void {
  const declared = prepared.configuration.databasePeerBindingInput;
  if (
    declared !== undefined &&
    observed !== undefined &&
    canonicalBootstrapJson(declared) !== canonicalBootstrapJson(observed)
  ) {
    throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
  }
}

async function exactLedgerRows(
  client: SqlClient,
): Promise<Array<{ id: string; checksum: string }>> {
  const result = await client.query<{ id: string; checksum: string }>(`
    SELECT id, checksum
      FROM public.commander_kernel_migrations
     ORDER BY id COLLATE "C", checksum COLLATE "C"
  `);
  return result.rows.map(({ id, checksum }) => ({ id, checksum }));
}

function assertExactLedgerRows(rows: Array<{ id: string; checksum: string }>): void {
  const expected = KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => ({
    id,
    checksum,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const actual = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalBootstrapJson(actual) !== canonicalBootstrapJson(expected)) {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
}

async function collectReadOnlySnapshot(
  client: SqlClient,
  context: Task1CatalogBootstrapContext | null,
  collectInventory: typeof collectTask1PrebootstrapInventory,
): Promise<PrebootstrapInventoryV1> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshot = await collectInventory(client, context, { transaction: 'caller' });
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function assertExactPendingLedgerRows(rows: Array<{ id: string; checksum: string }>): void {
  const lifecycle = KERNEL_TASK1_CLOSURE_MIGRATIONS[0]!;
  const expected = [...KERNEL_TASK1_BASELINE_MIGRATIONS, lifecycle]
    .map(({ id, checksum }) => ({ id, checksum }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actual = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalBootstrapJson(actual) !== canonicalBootstrapJson(expected)) {
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
}

async function applyHistoricalBaseline(
  client: SqlClient,
  classification: 'fresh' | 'legacy',
): Promise<void> {
  if (classification === 'fresh') {
    await client.query(`
        CREATE TABLE public.commander_kernel_migrations (
          id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
        )
      `);
  }
  await client.query('LOCK TABLE public.commander_kernel_migrations IN ACCESS EXCLUSIVE MODE');
  if (classification === 'legacy') {
    assertExactLedgerRows(await exactLedgerRows(client));
  } else {
    for (const migration of KERNEL_TASK1_BASELINE_MIGRATIONS) {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO public.commander_kernel_migrations (id, checksum) VALUES ($1,$2)',
        [migration.id, migration.checksum],
      );
    }
    assertExactLedgerRows(await exactLedgerRows(client));
  }
}

async function applyLifecycleDescriptor(client: SqlClient): Promise<void> {
  const lifecycle = KERNEL_TASK1_CLOSURE_MIGRATIONS[0]!;
  const existing = await client.query<{ checksum: string }>(
    'SELECT checksum FROM public.commander_kernel_migrations WHERE id=$1',
    [lifecycle.id],
  );
  if (existing.rows[0]?.checksum !== undefined) {
    if (existing.rows[0].checksum !== lifecycle.checksum) {
      throw new Error('MIGRATION_LEDGER_TAMPERED');
    }
    throw new Error('MIGRATION_LEDGER_TAMPERED');
  }
  await client.query(lifecycle.sql);
  await client.query(
    'INSERT INTO public.commander_kernel_migrations (id, checksum) VALUES ($1,$2)',
    [lifecycle.id, lifecycle.checksum],
  );
}

/** Descriptor installation and initial state insertion must commit or roll back together. */
export async function runTask1LifecycleDescriptorStateTransaction(
  client: SqlClient,
  insertState: () => Promise<void>,
  classification: 'fresh' | 'legacy' = 'fresh',
  applyRoleCredentials?: () => Promise<void>,
  catalog?: Task1LifecycleCatalogTransaction,
): Promise<void> {
  assertPinnedTask1LifecycleManifests();
  if (!catalog) throw new Error('TASK1_LIFECYCLE_CATALOG_TRANSACTION_REQUIRED');
  const collectInventory = catalog.collectInventory ?? collectTask1LockedCatalogInventory;
  const verifyState = catalog.verifyState ?? verifyTask1LockedCatalogState;
  const applyHardening = catalog.applyHardening ?? applyTask1CatalogHardening;
  const manifestFor = (stage: Task1LockedCatalogStateVerification['stage']): string =>
    stage === 'historical'
      ? PINNED_TASK1_LIFECYCLE_MANIFESTS.historical.source
      : stage === 'hardened'
        ? PINNED_TASK1_LIFECYCLE_MANIFESTS.hardened.source
        : PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle.source;
  await client.query('BEGIN');
  try {
    await applyHistoricalBaseline(client, classification);
    await applyRoleCredentials?.();
    const state1 = await collectInventory(client, catalog.origin);
    verifyState({
      stage: 'historical',
      ...catalog.origin,
      databasePeerBinding: catalog.databasePeerBinding,
      manifestSourceJcs: manifestFor('historical'),
      observed: state1,
    });
    await applyHardening(client);
    const state2 = await collectInventory(client, catalog.origin);
    verifyState({
      stage: 'hardened',
      ...catalog.origin,
      databasePeerBinding: catalog.databasePeerBinding,
      manifestSourceJcs: manifestFor('hardened'),
      observed: state2,
      previous: state1,
    });
    await applyLifecycleDescriptor(client);
    const state3 = await collectInventory(client, catalog.origin);
    verifyState({
      stage: 'lifecycle',
      ...catalog.origin,
      databasePeerBinding: catalog.databasePeerBinding,
      manifestSourceJcs: manifestFor('lifecycle'),
      observed: state3,
      previous: state2,
    });
    await insertState();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function initializeTask1LifecycleBoundary(input: {
  client: SqlClient;
  prepared: Task1OwnerPreparedRequest;
  env?: NodeJS.ProcessEnv;
  dependencies?: Task1LifecycleInitializerDependencies;
}): Promise<void> {
  const env = input.env ?? process.env;
  const dependencies = input.dependencies ?? {};
  const collectInventory = dependencies.collectInventory ?? collectTask1PrebootstrapInventory;
  const verifyCatalogBaseline =
    dependencies.verifyCatalogBaseline ??
    ((value) => {
      if (value.classification === 'legacy') assertExactLegacyLedger(value.snapshots.s0);
    });
  const loadContext = dependencies.loadBootstrapContext ?? loadBootstrapContext;
  const observeCandidate = dependencies.observeCandidatePeers ?? observeCandidatePeers;
  const observePeers = dependencies.observePeers ?? ((value) => observeTask1DatabasePeers(value));
  const readProofKeySha256 = dependencies.proofKeySha256 ?? proofKeySha256;
  const applyRoleCredentials =
    dependencies.applyRoleCredentials ?? applyTask1LifecycleRoleCredentials;
  const instantiateManifest =
    dependencies.instantiateManifestSha256 ?? instantiateTask1BaselineManifestSha256;
  const createInstallationUuid = dependencies.createInstallationUuid ?? randomUUID;
  assertPinnedTask1LifecycleManifests();
  if (
    canonicalBootstrapSha256(input.prepared.configuration) !== input.prepared.configurationSha256 ||
    canonicalBootstrapJson(input.prepared.configuration) !==
      canonicalBootstrapJson({
        ...input.prepared.businessConfiguration,
        operationAuditNonce: input.prepared.configuration.operationAuditNonce,
      })
  )
    throw new Error('TENANT_CUTOVER_STATE_INVALID');

  const existing = await input.client.query<{
    state_table: string | null;
    operation_table: string | null;
    proof_table: string | null;
  }>(`
    SELECT pg_catalog.to_regclass('public.commander_tenant_cutover_state')::text AS state_table,
           pg_catalog.to_regclass('public.commander_tenant_cutover_operations')::text AS operation_table,
           pg_catalog.to_regclass('public.commander_tenant_cutover_rollout_proofs')::text AS proof_table
  `);
  const tables = existing.rows[0];
  if (!tables) throw new Error('TENANT_CUTOVER_STATE_INVALID');
  const tableCount = [tables.state_table, tables.operation_table, tables.proof_table].filter(
    Boolean,
  ).length;
  if (tableCount !== 0 && tableCount !== 3) throw new Error('TENANT_CUTOVER_STATE_INVALID');
  if (tableCount === 3) {
    const state = await input.client.query<{
      state: 'fresh_pending' | 'legacy_pending' | 'expanded' | 'enforced';
      state_version: string;
      pending_configuration_sha256: string | null;
      platform_kind: 'compose' | 'helm' | null;
      platform_binding_sha256: string | null;
      prebootstrap_snapshots_jcs: string;
      prebootstrap_snapshots_sha256: string;
      bootstrap_identities_jcs: string | null;
      origin_binding_jcs: string;
      origin_binding_sha256: string;
      database_peer_binding_jcs: string;
      database_peer_binding_sha256: string;
      proof_key_sha256: string;
      historical_baseline_manifest_source_sha256: string;
      historical_baseline_manifest_sha256: string;
      hardened_baseline_manifest_source_sha256: string;
      hardened_baseline_manifest_sha256: string;
      lifecycle_postcondition_manifest_sha256: string;
      current_configuration_sha256: string | null;
      current_runtime_operation_version: string | null;
      recorded_expand_operation_version: string | null;
    }>(`
      SELECT state::text, state_version::text, pending_configuration_sha256,
             platform_kind, platform_binding_sha256,
             prebootstrap_snapshots_jcs, prebootstrap_snapshots_sha256,
             bootstrap_identities_jcs, origin_binding_jcs, origin_binding_sha256,
             database_peer_binding_jcs, database_peer_binding_sha256, proof_key_sha256,
             historical_baseline_manifest_source_sha256, historical_baseline_manifest_sha256,
             hardened_baseline_manifest_source_sha256, hardened_baseline_manifest_sha256,
             lifecycle_postcondition_manifest_sha256, current_configuration_sha256,
             current_runtime_operation_version::text, recorded_expand_operation_version::text
        FROM public.commander_tenant_cutover_state
       WHERE singleton = true
    `);
    const row = state.rows[0];
    if (state.rowCount !== 1 || !row) throw new Error('MIGRATION_LEDGER_TAMPERED');
    if (row.state === 'fresh_pending' || row.state === 'legacy_pending') {
      planTask1LifecycleInitialization({
        command: input.prepared.command,
        comparisonKind: 'fresh-byte-equal',
        configurationSha256: input.prepared.configurationSha256,
        existing: {
          state: row.state,
          pendingConfigurationSha256: row.pending_configuration_sha256,
        },
      });
      if (
        row.platform_kind !== input.prepared.platformBinding.kind ||
        row.platform_binding_sha256 !== canonicalBootstrapSha256(input.prepared.platformBinding)
      )
        throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
      if (
        row.state_version !== '0' ||
        row.current_configuration_sha256 !== null ||
        row.current_runtime_operation_version !== null ||
        row.recorded_expand_operation_version !== null
      )
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      const operation = await input.client.query<{ operation_count: string }>(`
        SELECT count(*)::text AS operation_count
          FROM public.commander_tenant_cutover_operations
         WHERE installation_uuid = (
           SELECT installation_uuid
             FROM public.commander_tenant_cutover_state
            WHERE singleton = true
         )
      `);
      if (operation.rowCount !== 1 || operation.rows[0]?.operation_count !== '0') {
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      }
      assertExactPendingLedgerRows(await exactLedgerRows(input.client));
      let snapshots: unknown;
      let origin: unknown;
      let persistedPeer: unknown;
      try {
        snapshots = JSON.parse(row.prebootstrap_snapshots_jcs);
        origin = JSON.parse(row.origin_binding_jcs);
        persistedPeer = JSON.parse(row.database_peer_binding_jcs);
      } catch {
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      }
      if (
        canonicalBootstrapJson(snapshots) !== row.prebootstrap_snapshots_jcs ||
        canonicalBootstrapSha256(snapshots) !== row.prebootstrap_snapshots_sha256 ||
        canonicalBootstrapJson(origin) !== row.origin_binding_jcs ||
        canonicalBootstrapSha256(origin) !== row.origin_binding_sha256 ||
        canonicalBootstrapJson(persistedPeer) !== row.database_peer_binding_jcs ||
        canonicalBootstrapSha256(persistedPeer) !== row.database_peer_binding_sha256
      )
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      const persisted = verifyPersistedOriginBinding(snapshots, origin);
      const identities = persisted.origin.bootstrapIdentities;
      if (
        (identities === null ? null : canonicalBootstrapJson(identities)) !==
          row.bootstrap_identities_jcs ||
        row.historical_baseline_manifest_source_sha256 !==
          PINNED_TASK1_LIFECYCLE_MANIFESTS.historical.sourceSha256 ||
        row.hardened_baseline_manifest_source_sha256 !==
          PINNED_TASK1_LIFECYCLE_MANIFESTS.hardened.sourceSha256 ||
        row.lifecycle_postcondition_manifest_sha256 !==
          PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle.sourceSha256 ||
        row.historical_baseline_manifest_sha256 !== instantiateManifest('historical', identities) ||
        row.hardened_baseline_manifest_sha256 !== instantiateManifest('hardened', identities) ||
        row.proof_key_sha256 !== readProofKeySha256(env)
      )
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      if (row.state === 'fresh_pending') {
        if (identities === null) throw new Error('MIGRATION_LEDGER_TAMPERED');
        const context = await loadContext(env);
        if (
          canonicalBootstrapJson(context.authority) !==
            canonicalBootstrapJson(identities.authority) ||
          canonicalBootstrapJson(context.bootstrapSuperuser) !==
            canonicalBootstrapJson(identities.bootstrapSuperuser)
        )
          throw new Error('TENANT_CUTOVER_ORIGIN_TAMPERED');
      } else if (identities !== null) {
        throw new Error('MIGRATION_LEDGER_TAMPERED');
      }
      const candidate = await observeCandidate(input.client, env);
      assertPreparedPeerInput(input.prepared, candidate.input);
      const observed = await observePeers(env);
      if (
        candidate.input &&
        observed.input &&
        canonicalBootstrapJson(candidate.input) !== canonicalBootstrapJson(observed.input)
      )
        throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
      verifyDatabasePeerBinding(candidate.input ?? observed.input!, candidate.binding);
      verifyDatabasePeerBinding(candidate.input ?? observed.input!, observed.binding);
      if (
        canonicalBootstrapJson(candidate.binding) !== row.database_peer_binding_jcs ||
        canonicalBootstrapJson(observed.binding) !== row.database_peer_binding_jcs
      )
        throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
    }
    return;
  }

  const fresh = input.prepared.command === 'install_enforce';
  const context = fresh ? await loadContext(env) : null;
  const candidate = await observeCandidate(input.client, env);
  assertPreparedPeerInput(input.prepared, candidate.input);
  const s0 = await collectReadOnlySnapshot(input.client, context, collectInventory);
  const s1 = await collectReadOnlySnapshot(input.client, context, collectInventory);
  const snapshots = createPrebootstrapSnapshots(s0, s1);
  const initialization = planTask1LifecycleInitialization({
    command: input.prepared.command,
    comparisonKind: snapshots.comparisonKind,
    configurationSha256: input.prepared.configurationSha256,
    existing: null,
  });
  const origin = createOriginBinding(snapshots);
  const prebootstrapSnapshotsJcs = canonicalBootstrapJson(snapshots);
  const originBindingJcs = canonicalBootstrapJson(origin);
  const peerBindingJcs = canonicalBootstrapJson(candidate.binding);
  const classification = fresh ? snapshots.s0.bootstrapIdentities!.envelope : 'legacy';
  verifyCatalogBaseline({ classification: fresh ? 'fresh' : 'legacy', snapshots });
  const identities = snapshots.s0.bootstrapIdentities;
  const historicalManifestSha256 = instantiateManifest('historical', identities);
  const hardenedManifestSha256 = instantiateManifest('hardened', identities);
  const selectedProofKeySha256 = readProofKeySha256(env);
  let catalogOrigin: Parameters<typeof collectTask1LockedCatalogInventory>[1];
  if (classification === 'legacy') {
    catalogOrigin = { classification, bootstrapIdentities: null };
  } else {
    if (identities === null) throw new Error('MIGRATION_LEDGER_TAMPERED');
    catalogOrigin = { classification, bootstrapIdentities: identities };
  }
  await runTask1LifecycleDescriptorStateTransaction(
    input.client,
    async () => {
      await input.client.query(
        `INSERT INTO public.commander_tenant_cutover_state
         (singleton, installation_uuid, state, state_version, platform_kind,
          platform_binding_sha256, prebootstrap_snapshots_jcs, prebootstrap_snapshots_sha256,
          bootstrap_identities_jcs, origin_binding_jcs, origin_binding_sha256,
          database_peer_binding_jcs, database_peer_binding_sha256, proof_key_sha256,
          historical_baseline_manifest_source_sha256, historical_baseline_manifest_sha256,
          hardened_baseline_manifest_source_sha256, hardened_baseline_manifest_sha256,
          lifecycle_postcondition_manifest_sha256, pending_configuration_sha256,
          current_configuration_sha256, current_runtime_operation_version,
          recorded_expand_operation_version)
         VALUES
         (true,$1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NULL,NULL,NULL)`,
        [
          createInstallationUuid(),
          initialization.state,
          input.prepared.platformBinding.kind,
          canonicalBootstrapSha256(input.prepared.platformBinding),
          prebootstrapSnapshotsJcs,
          canonicalBootstrapSha256(snapshots),
          identities === null ? null : canonicalBootstrapJson(identities),
          originBindingJcs,
          canonicalBootstrapSha256(origin),
          peerBindingJcs,
          canonicalBootstrapSha256(candidate.binding),
          selectedProofKeySha256,
          PINNED_TASK1_LIFECYCLE_MANIFESTS.historical.sourceSha256,
          historicalManifestSha256,
          PINNED_TASK1_LIFECYCLE_MANIFESTS.hardened.sourceSha256,
          hardenedManifestSha256,
          PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle.sourceSha256,
          input.prepared.configurationSha256,
        ],
      );
    },
    fresh ? 'fresh' : 'legacy',
    () => applyRoleCredentials(input.client, env),
    {
      origin: catalogOrigin,
      databasePeerBinding: candidate.binding,
      collectInventory: dependencies.collectLockedInventory,
      verifyState: dependencies.verifyLockedCatalogState,
      applyHardening: dependencies.applyCatalogHardening,
    },
  );

  const observed = await observePeers(env);
  if (
    candidate.input &&
    observed.input &&
    canonicalBootstrapJson(candidate.input) !== canonicalBootstrapJson(observed.input)
  )
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
  verifyDatabasePeerBinding(candidate.input ?? observed.input!, candidate.binding);
  verifyDatabasePeerBinding(candidate.input ?? observed.input!, observed.binding);
  if (canonicalBootstrapJson(candidate.binding) !== canonicalBootstrapJson(observed.binding)) {
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
  }
}
