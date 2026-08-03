#!/usr/bin/env tsx
/**
 * Disaster Recovery: Backup and Restore Verification (honest semantics).
 *
 * Restores to an independent PostgreSQL instance (different port/DSN).
 * Sentinel runs A (before cutoff) and B (after cutoff) prove point-in-time scope.
 * Without independent restore → honestyLevel DRAFT, overall never PASS on full drill.
 *
 * Usage:
 *   tsx scripts/dr-backup-verify.ts --backup
 *   tsx scripts/dr-backup-verify.ts --restore --backup-path /tmp/dr-backup
 *   tsx scripts/dr-backup-verify.ts --full --backup-path /tmp/dr-backup
 *
 * Environment:
 *   DATABASE_URL: Source PostgreSQL connection string (required)
 *   COMMANDER_DR_RESTORE_PORT: Port for restored PG instance (default: 5433)
 *   COMMANDER_DR_BACKUP_DIR: Base directory for backups (default: ./dr-backups)
 *   RST_DATABASE_URL: Explicit restored DSN (overrides port rewrite)
 *   COMMANDER_DATABASE_TLS_CA_FILE: CA file used for verified PostgreSQL TLS
 *   COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: non-secret CA mount identity
 *   COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: pinned server key digest
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash, createPublicKey, type JsonWebKeyInput } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  verifyRunExists,
  verifyRunMissing,
  type DrilledRun,
} from '../packages/kernel/src/disasterRecovery.js';
import { createDrillRun } from '../packages/kernel/src/drillWorkload.js';
import { verifyEvidenceReceipt, type EvidenceVerificationResult } from './verify-evidence.js';
import {
  canonicalEvidenceJson,
  type EvidenceBundle,
  type EvidenceJwks,
  type EvidenceSignature,
} from '../packages/effect-broker/src/index.js';

export interface DsnParts {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type HonestyLevel = 'PROVEN' | 'ENFORCED' | 'DRAFT';

export interface DrillReport {
  drillId: string;
  honestyLevel: HonestyLevel;
  gitSha: string;
  startedAt: string;
  completedAt: string;
  topology: 'compose-cell' | 'helm-demo' | 'kind' | 'local-drill';
  images: Record<string, string>;
  sourceDsn: Pick<DsnParts, 'host' | 'port' | 'database'>;
  restoredDsn: Pick<DsnParts, 'host' | 'port' | 'database'> | null;
  sentinel: {
    runA: DrilledRun | null;
    runB: DrilledRun | null;
  };
  cutoffAt: string | null;
  backup: {
    path: string;
    sizeBytes: number;
    durationMs: number;
    method: string;
  };
  restore: {
    durationMs: number;
    pgVersion: string;
    schemaValid: boolean;
    independent: boolean;
  };
  validation: {
    runsTableExists: boolean;
    stepsTableExists: boolean;
    eventsTableExists: boolean;
    effects: boolean;
    interactions: boolean;
    killSwitches: boolean;
    outboxTableExists: boolean;
    timersTableExists: boolean;
    evidenceReceiptsRestored: boolean;
    evidenceAnchorsRestored: boolean;
    identityOutcomeAccountingPreserved: boolean;
    evidenceReceiptCount: number;
    anchoredEvidenceReceiptCount: number;
    evidenceReceiptsVerified: number;
    evidenceReceiptVerificationFailures: number;
    retainedJwksSha256: string | null;
    retainedJwksKeyIds: string[];
    rowCount: { runs: number; steps: number; events: number };
  };
  rpo: { targetMs: number; actualMs: number; passed: boolean; mode: 'measured' | 'draft' };
  rto: { targetMs: number; actualMs: number; passed: boolean };
  overall: 'PASS' | 'FAIL' | 'DRAFT';
  failures: string[];
}

const RPO_TARGET_MS = 5 * 60 * 1000;
const RTO_TARGET_MS = 60 * 60 * 1000;

export function parseDatabaseUrl(url: string): DsnParts {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, '') || 'commander',
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
  };
}

export function buildRestoreDatabaseUrl(sourceUrl: string, restorePort: string): string {
  const parsed = new URL(sourceUrl);
  parsed.port = restorePort;
  const dbName = `${parsed.pathname.replace(/^\//, '') || 'commander'}_dr`;
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function requireDrTlsValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function assertVerifiedTlsDatabaseUrl(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.searchParams.getAll('sslmode').length !== 1 ||
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(`${name} must require sslmode=verify-full`);
  }
}

export function assertDrTlsConfiguration(
  databaseUrl: string,
  restoreDatabaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertVerifiedTlsDatabaseUrl('DATABASE_URL', databaseUrl);
  assertVerifiedTlsDatabaseUrl('RST_DATABASE_URL', restoreDatabaseUrl);
  requireDrTlsValue(environment, 'COMMANDER_DATABASE_TLS_CA_FILE');
  requireDrTlsValue(environment, 'COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY');
  const expectedSpki = requireDrTlsValue(
    environment,
    'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
  );
  if (!/^[a-f0-9]{64}$/.test(expectedSpki)) {
    throw new Error('COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256_INVALID');
  }
}

export function buildDrPostgresEnv(
  dsn: DsnParts,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const caFile = requireDrTlsValue(environment, 'COMMANDER_DATABASE_TLS_CA_FILE');
  return {
    ...environment,
    PGHOST: dsn.host,
    PGPORT: String(dsn.port),
    PGUSER: dsn.user,
    PGPASSWORD: dsn.password,
    PGDATABASE: dsn.database,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: caFile,
  };
}

export function assertDistinctRestoreTarget(source: DsnParts, restore: DsnParts): void {
  const same =
    source.host === restore.host &&
    source.port === restore.port &&
    source.database === restore.database;
  if (same) {
    throw new Error('restore DSN must be distinct from source (distinct restore target required)');
  }
}

export function refuseSourceDestructiveRestore(source: DsnParts, restore: DsnParts): string | null {
  try {
    assertDistinctRestoreTarget(source, restore);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function computeRpoMs(cutoffAt: Date, lastCommittedAt: Date): number {
  return Math.max(0, cutoffAt.getTime() - lastCommittedAt.getTime());
}

export function queryRunCommittedAt(
  dsn: DsnParts,
  runId: string,
  runPsqlFn: (dsn: DsnParts, sql: string) => string,
): Date {
  const raw = runPsqlFn(
    dsn,
    `SELECT EXTRACT(EPOCH FROM created_at AT TIME ZONE 'UTC') * 1000 FROM commander_runs WHERE id = '${runId}'`,
  );
  const ms = Number.parseFloat(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`run committed timestamp missing for ${runId}`);
  }
  return new Date(ms);
}

export function resolveHonestyLevel(opts: {
  independentRestore: boolean;
  sentinelVerified: boolean;
}): HonestyLevel {
  if (!opts.independentRestore) return 'DRAFT';
  if (!opts.sentinelVerified) return 'DRAFT';
  return 'ENFORCED';
}

export function sanitizeError(err: unknown, secrets: string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret) msg = msg.split(secret).join('[redacted]');
  }
  msg = msg.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[redacted-dsn]');
  msg = msg.replace(/PGPASSWORD=\S+/gi, 'PGPASSWORD=[redacted]');
  return msg;
}

export function assertRegularArtifact(path: string, info: { isFile(): boolean }): void {
  if (!info.isFile()) throw new Error(`backup artifact is not a regular file: ${path}`);
}

export function restoreBackupDirectory(
  mode: 'full' | 'backup' | 'restore',
  path: string,
  drillId: string,
): string {
  return mode === 'restore' ? path : join(path, drillId);
}

export function restoredValidationFailures(validation: DrillReport['validation']): string[] {
  const required: Array<[keyof DrillReport['validation'], string]> = [
    ['runsTableExists', 'restored runs table missing'],
    ['stepsTableExists', 'restored steps table missing'],
    ['eventsTableExists', 'restored events table missing'],
    ['effects', 'restored effects table missing'],
    ['interactions', 'restored interactions table missing'],
    ['killSwitches', 'restored kill-switch table missing'],
    ['outboxTableExists', 'restored outbox table missing'],
    ['timersTableExists', 'restored timers table missing'],
    ['evidenceReceiptsRestored', 'restored evidence receipts missing'],
    ['evidenceAnchorsRestored', 'restored evidence anchors incomplete'],
    [
      'identityOutcomeAccountingPreserved',
      'restored evidence identity/outcome accounting incomplete',
    ],
  ];
  return required.filter(([key]) => validation[key] !== true).map(([, message]) => message);
}

export function createFreshRestoreDatabase(_dsn: DsnParts, createDatabase: () => void): void {
  try {
    createDatabase();
  } catch (err) {
    throw new Error(`failed to create a fresh restore database: ${sanitizeError(err)}`);
  }
}

export function restoreIntoFreshTarget(steps: {
  createDatabase(): void;
  countUserObjects(): number;
  restore(): void;
}): void {
  steps.createDatabase();
  assertEmptyRestoreTarget(steps.countUserObjects());
  steps.restore();
}

export function assertEmptyRestoreTarget(userObjectCount: number): void {
  if (!Number.isSafeInteger(userObjectCount)) {
    throw new Error('restore target emptiness could not be verified');
  }
  if (userObjectCount !== 0) {
    throw new Error(`restore target is not empty: ${userObjectCount} user objects found`);
  }
}

export function resolveDrillOverall(opts: {
  mode: 'full' | 'restore';
  independentRestore: boolean;
  restoreFailures: readonly string[];
  validationFailures: readonly string[];
  sentinelVerified: boolean;
  rpoPassed: boolean;
  rtoPassed: boolean;
}): DrillReport['overall'] {
  if (
    !opts.independentRestore ||
    opts.restoreFailures.length > 0 ||
    opts.validationFailures.length > 0
  ) {
    return 'FAIL';
  }
  if (!opts.rtoPassed) return 'FAIL';
  if (opts.mode === 'restore') return 'DRAFT';
  if (!opts.sentinelVerified || !opts.rpoPassed) return 'FAIL';
  return 'PASS';
}

export interface RetainedJwksArtifact {
  jwks: EvidenceJwks;
  sha256: string;
  keyIds: string[];
}

export function validateRetainedJwks(value: unknown, bytes: Uint8Array): RetainedJwksArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('retained JWKS must be an object');
  }
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('retained JWKS keys are required');
  const keyIds = new Set<string>();
  for (const key of keys) {
    if (!key || typeof key !== 'object' || Array.isArray(key))
      throw new Error('retained JWKS key is invalid');
    const candidate = key as Record<string, unknown>;
    if (candidate.d !== undefined)
      throw new Error('retained JWKS must not contain private key material');
    if (
      candidate.kty !== 'OKP' ||
      candidate.crv !== 'Ed25519' ||
      candidate.alg !== 'EdDSA' ||
      candidate.use !== 'sig'
    ) {
      throw new Error('retained JWKS key parameters are invalid');
    }
    if (typeof candidate.kid !== 'string' || !candidate.kid || keyIds.has(candidate.kid)) {
      throw new Error('retained JWKS key ids must be unique');
    }
    if (typeof candidate.x !== 'string' || !candidate.x)
      throw new Error('retained JWKS public key is missing');
    try {
      createPublicKey({ key: candidate, format: 'jwk' } as JsonWebKeyInput);
    } catch {
      throw new Error('retained JWKS public key is invalid');
    }
    keyIds.add(candidate.kid);
  }
  return {
    jwks: { keys: keys as EvidenceJwks['keys'] },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    keyIds: [...keyIds].sort(),
  };
}

export interface RestoredReceiptForVerification {
  body: EvidenceBundle;
  signature: EvidenceSignature;
  actionDigest?: string;
  contentHash?: string;
}

export interface RestoredReceiptCursor {
  createdAt: string;
  tenantId: string;
  bundleId: string;
}

export interface RestoredReceiptPage {
  receipts: RestoredReceiptForVerification[];
  cursor: RestoredReceiptCursor | null;
}

export interface RestoredReceiptVerification {
  verified: number;
  failed: number;
  failures: string[];
}

export function verifyRestoredReceipts(
  receipts: readonly RestoredReceiptForVerification[],
  jwks: EvidenceJwks,
): RestoredReceiptVerification {
  let verified = 0;
  const failures: string[] = [];
  for (const receipt of receipts) {
    if (
      !receipt.body.signature ||
      canonicalEvidenceJson(receipt.body.signature) !== canonicalEvidenceJson(receipt.signature)
    ) {
      failures.push('EVIDENCE_SIGNATURE_BINDING_MISMATCH');
      continue;
    }
    if (receipt.actionDigest !== undefined && receipt.actionDigest !== receipt.body.actionDigest) {
      failures.push('EVIDENCE_ACTION_DIGEST_MISMATCH');
      continue;
    }
    if (receipt.contentHash !== undefined && receipt.contentHash !== receipt.body.contentHash) {
      failures.push('EVIDENCE_CONTENT_HASH_MISMATCH');
      continue;
    }
    if (!jwks.keys.some((key) => key.kid === receipt.signature.keyId)) {
      failures.push('EVIDENCE_KEY_ID_NOT_RETAINED');
      continue;
    }
    const result: EvidenceVerificationResult = verifyEvidenceReceipt(
      { ...receipt.body, signature: receipt.signature },
      jwks,
    );
    if (result.ok) verified += 1;
    else failures.push(result.reason ?? 'EVIDENCE_SIGNATURE_INVALID');
  }
  return { verified, failed: receipts.length - verified, failures };
}

export function verifyRestoredReceiptPages(
  queryPage: (cursor: RestoredReceiptCursor | null) => RestoredReceiptPage,
  jwks: EvidenceJwks,
  options: { pageSize?: number; maxFailureReasons?: number } = {},
): RestoredReceiptVerification {
  const pageSize = options.pageSize ?? 2;
  const maxFailureReasons = options.maxFailureReasons ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('restored receipt page size must be a positive integer');
  }
  if (!Number.isSafeInteger(maxFailureReasons) || maxFailureReasons < 0) {
    throw new Error('restored receipt failure reason limit must be a non-negative integer');
  }

  let cursor: RestoredReceiptCursor | null = null;
  let verified = 0;
  let failed = 0;
  const failures: string[] = [];
  for (;;) {
    const page = queryPage(cursor);
    const result = verifyRestoredReceipts(page.receipts, jwks);
    verified += result.verified;
    failed += result.failed;
    const remainingFailureReasons = maxFailureReasons - failures.length;
    if (remainingFailureReasons > 0) {
      failures.push(...result.failures.slice(0, remainingFailureReasons));
    }
    if (page.receipts.length < pageSize) return { verified, failed, failures };
    if (!page.cursor) {
      throw new Error('restored receipt page cursor missing before final page');
    }
    cursor = page.cursor;
  }
}

export async function readRetainedJwks(path: string): Promise<RetainedJwksArtifact> {
  const info = await stat(path);
  assertRegularArtifact(path, info);
  const bytes = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`retained JWKS is not valid JSON: ${path}`);
  }
  return validateRetainedJwks(value, bytes);
}

export function parseRestoredReceiptRows(raw: string): RestoredReceiptForVerification[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    throw new Error('restored evidence receipt query returned invalid JSON');
  }
  if (!Array.isArray(value))
    throw new Error('restored evidence receipt query returned a non-array');
  return parseRestoredReceiptRowValues(value);
}

function parseRestoredReceiptRowValues(value: unknown[]): RestoredReceiptForVerification[] {
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`restored evidence receipt row ${index} is invalid`);
    }
    const candidate = row as Record<string, unknown>;
    if (
      !candidate.body ||
      typeof candidate.body !== 'object' ||
      !candidate.signature ||
      typeof candidate.signature !== 'object'
    ) {
      throw new Error(`restored evidence receipt row ${index} is incomplete`);
    }
    return {
      body: candidate.body as EvidenceBundle,
      signature: candidate.signature as EvidenceSignature,
      actionDigest: typeof candidate.actionDigest === 'string' ? candidate.actionDigest : undefined,
      contentHash: typeof candidate.contentHash === 'string' ? candidate.contentHash : undefined,
    };
  });
}

function parseRestoredReceiptPage(raw: string): RestoredReceiptPage {
  let value: unknown;
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    throw new Error('restored evidence receipt query returned invalid JSON');
  }
  if (!Array.isArray(value))
    throw new Error('restored evidence receipt query returned a non-array');
  const receipts = parseRestoredReceiptRowValues(value);
  if (value.length === 0) return { receipts, cursor: null };
  const last = value[value.length - 1] as Record<string, unknown>;
  if (
    typeof last.createdAt !== 'string' ||
    typeof last.tenantId !== 'string' ||
    typeof last.bundleId !== 'string'
  ) {
    throw new Error('restored evidence receipt page cursor is invalid');
  }
  return {
    receipts,
    cursor: {
      createdAt: last.createdAt,
      tenantId: last.tenantId,
      bundleId: last.bundleId,
    },
  };
}

export function assessRestoredEvidence(
  dsn: DsnParts,
  runPsqlFn: (dsn: DsnParts, sql: string) => string,
): Pick<
  DrillReport['validation'],
  | 'evidenceReceiptsRestored'
  | 'evidenceAnchorsRestored'
  | 'identityOutcomeAccountingPreserved'
  | 'evidenceReceiptCount'
  | 'anchoredEvidenceReceiptCount'
> {
  const empty = {
    evidenceReceiptsRestored: false,
    evidenceAnchorsRestored: false,
    identityOutcomeAccountingPreserved: false,
    evidenceReceiptCount: 0,
    anchoredEvidenceReceiptCount: 0,
  };
  try {
    const exists = runPsqlFn(
      dsn,
      "SELECT to_regclass('public.commander_evidence_receipts') IS NOT NULL",
    );
    if (exists !== 't') return empty;
    const evidenceReceiptCount = Number.parseInt(
      runPsqlFn(dsn, 'SELECT COUNT(*) FROM public.commander_evidence_receipts'),
      10,
    );
    const anchoredEvidenceReceiptCount = Number.parseInt(
      runPsqlFn(
        dsn,
        'SELECT COUNT(*) FROM public.commander_evidence_receipts WHERE anchored_at IS NOT NULL',
      ),
      10,
    );
    const identityOutcomeCount = Number.parseInt(
      runPsqlFn(
        dsn,
        `SELECT COUNT(*)
           FROM public.commander_evidence_receipts AS receipt
          WHERE receipt.action_digest ~ '^[a-f0-9]{64}$'
            AND receipt.content_hash ~ '^[a-f0-9]{64}$'
            AND pg_catalog.jsonb_typeof(receipt.signature) = 'object'
            AND pg_catalog.jsonb_typeof(receipt.body) = 'object'
            AND receipt.body ? 'scope'
            AND receipt.body ? 'terminalDisposition'`,
      ),
      10,
    );
    if (
      !Number.isSafeInteger(evidenceReceiptCount) ||
      !Number.isSafeInteger(anchoredEvidenceReceiptCount) ||
      !Number.isSafeInteger(identityOutcomeCount) ||
      evidenceReceiptCount <= 0
    ) {
      return empty;
    }
    return {
      evidenceReceiptsRestored: true,
      evidenceAnchorsRestored: anchoredEvidenceReceiptCount === evidenceReceiptCount,
      identityOutcomeAccountingPreserved: identityOutcomeCount === evidenceReceiptCount,
      evidenceReceiptCount,
      anchoredEvidenceReceiptCount,
    };
  } catch {
    return empty;
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function queryRestoredReceiptPage(
  dsn: DsnParts,
  runPsqlFn: (dsn: DsnParts, sql: string) => string,
  cursor: RestoredReceiptCursor | null,
): RestoredReceiptPage {
  // Keep each psql result comfortably below execFileSync's default maxBuffer.
  // Evidence records are bounded by the sink, so a two-row page is bounded too.
  const pageSize = 2;
  const afterCursor = cursor
    ? `WHERE (created_at, tenant_id, bundle_id) > (
         ${sqlLiteral(cursor.createdAt)}::timestamptz,
         ${sqlLiteral(cursor.tenantId)},
         ${sqlLiteral(cursor.bundleId)}
       )`
    : '';
  const raw = runPsqlFn(
    dsn,
    `SELECT COALESCE(
       json_agg(
         json_build_object(
           'body', body,
           'signature', signature,
           'actionDigest', action_digest,
           'contentHash', content_hash,
           'createdAt', created_at,
           'tenantId', tenant_id,
           'bundleId', bundle_id
         ) ORDER BY created_at, tenant_id, bundle_id
       ), '[]'::json
     )::text
       FROM (
         SELECT body, signature, action_digest, content_hash, created_at, tenant_id, bundle_id
           FROM public.commander_evidence_receipts
           ${afterCursor}
          ORDER BY created_at, tenant_id, bundle_id
          LIMIT ${pageSize}
       ) AS receipt_page`,
  );
  return parseRestoredReceiptPage(raw);
}

function runPsql(dsn: DsnParts, sql: string): string {
  return execFileSync('psql', ['-t', '-A', '-c', sql], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: buildDrPostgresEnv(dsn),
  }).trim();
}

function tableExists(dsn: DsnParts, table: string): boolean {
  try {
    return runPsql(dsn, `SELECT to_regclass('public.${table}') IS NOT NULL;`) === 't';
  } catch {
    return false;
  }
}

function countRows(dsn: DsnParts, table: string): number {
  try {
    return Number.parseInt(runPsql(dsn, `SELECT COUNT(*) FROM public.${table};`), 10) || 0;
  } catch {
    return 0;
  }
}

function countRestoreTargetUserObjects(dsn: DsnParts): number {
  const raw = runPsql(
    dsn,
    `SELECT COUNT(*)
       FROM (
         SELECT n.oid
           FROM pg_catalog.pg_namespace AS n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
            AND n.nspname !~ '^pg_(toast|temp)'
         UNION ALL
         SELECT c.oid
           FROM pg_catalog.pg_class AS c
           JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname !~ '^pg_(toast|temp)'
         UNION ALL
         SELECT p.oid
           FROM pg_catalog.pg_proc AS p
           JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname !~ '^pg_(toast|temp)'
       ) AS user_objects`,
  );
  const count = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(count)) {
    throw new Error('restore target emptiness could not be verified');
  }
  return count;
}

function resolveGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes('--full')
    ? 'full'
    : args.includes('--backup')
      ? 'backup'
      : args.includes('--restore')
        ? 'restore'
        : 'full';
  const backupPathFlag = args.indexOf('--backup-path');
  const backupPathArg =
    (backupPathFlag >= 0 ? args[backupPathFlag + 1] : undefined) ??
    process.env.COMMANDER_DR_BACKUP_DIR ??
    './dr-backups';
  const backupPath = resolve(backupPathArg);
  const jwksPathFlag = args.indexOf('--jwks-path');
  const retainedJwksSource = resolve(
    (jwksPathFlag >= 0 ? args[jwksPathFlag + 1] : undefined) ?? join(backupPath, 'jwks.json'),
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sourceDsn = parseDatabaseUrl(dbUrl);
  const restorePort = process.env.COMMANDER_DR_RESTORE_PORT ?? '5433';
  const restoreDbUrl = process.env.RST_DATABASE_URL ?? buildRestoreDatabaseUrl(dbUrl, restorePort);
  assertDrTlsConfiguration(dbUrl, restoreDbUrl);
  const restoredDsn = parseDatabaseUrl(restoreDbUrl);
  const redactSecrets = [sourceDsn.password, restoredDsn.password, dbUrl, restoreDbUrl].filter(
    Boolean,
  );

  const drillId = `drill_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const drillBackupPath = restoreBackupDirectory(mode, backupPath, drillId);
  const retainedJwksDestination = join(drillBackupPath, 'jwks.json');
  const failures: string[] = [];
  const incidentStart = new Date();

  console.log(`[DR Drill ${drillId}] Starting ${mode} drill`);
  const startedAt = incidentStart;

  let independentRestore = false;
  let sentinelVerified = false;
  let runA: DrilledRun | null = null;
  let runB: DrilledRun | null = null;
  let cutoffAt: string | null = null;
  let lastCommittedAt: Date | null = null;
  let backupCompletedAt: Date | null = null;
  let retainedJwksArtifact: RetainedJwksArtifact | null = null;

  const report: DrillReport = {
    drillId,
    honestyLevel: 'DRAFT',
    gitSha: resolveGitSha(),
    startedAt: startedAt.toISOString(),
    completedAt: '',
    topology: 'local-drill',
    images: {
      api: process.env.COMMANDER_DR_IMAGE_API ?? 'unknown',
      worker: process.env.COMMANDER_DR_IMAGE_WORKER ?? 'unknown',
      kernelOps: process.env.COMMANDER_DR_IMAGE_KERNEL_OPS ?? 'unknown',
      adapterOps: process.env.COMMANDER_DR_IMAGE_ADAPTER_OPS ?? 'unknown',
    },
    sourceDsn: { host: sourceDsn.host, port: sourceDsn.port, database: sourceDsn.database },
    restoredDsn: null,
    sentinel: { runA: null, runB: null },
    cutoffAt: null,
    backup: { path: drillBackupPath, sizeBytes: 0, durationMs: 0, method: 'pg_dump' },
    restore: { durationMs: 0, pgVersion: '', schemaValid: false, independent: false },
    validation: {
      runsTableExists: false,
      stepsTableExists: false,
      eventsTableExists: false,
      effects: false,
      interactions: false,
      killSwitches: false,
      outboxTableExists: false,
      timersTableExists: false,
      evidenceReceiptsRestored: false,
      evidenceAnchorsRestored: false,
      identityOutcomeAccountingPreserved: false,
      evidenceReceiptCount: 0,
      anchoredEvidenceReceiptCount: 0,
      evidenceReceiptsVerified: 0,
      evidenceReceiptVerificationFailures: 0,
      retainedJwksSha256: null,
      retainedJwksKeyIds: [],
      rowCount: { runs: 0, steps: 0, events: 0 },
    },
    rpo: { targetMs: RPO_TARGET_MS, actualMs: 0, passed: false, mode: 'draft' },
    rto: { targetMs: RTO_TARGET_MS, actualMs: 0, passed: false },
    overall: 'DRAFT',
    failures,
  };

  const restoreRefusal = refuseSourceDestructiveRestore(sourceDsn, restoredDsn);
  if (restoreRefusal && (mode === 'full' || mode === 'restore')) {
    failures.push(restoreRefusal);
    report.failures = failures;
    report.honestyLevel = 'DRAFT';
    report.overall = 'FAIL';
    report.completedAt = new Date().toISOString();
    return finish(report);
  }

  try {
    if (mode === 'full' || mode === 'backup') {
      console.log('[1/6] Sentinel runA (before cutoff)...');
      runA = await createDrillRun(dbUrl);
      report.sentinel.runA = runA;
      lastCommittedAt = queryRunCommittedAt(sourceDsn, runA.id, runPsql);

      cutoffAt = runPsql(sourceDsn, "SELECT (now() AT TIME ZONE 'UTC')::timestamptz::text");
      report.cutoffAt = cutoffAt;

      console.log('[2/6] Creating backup...');
      await mkdir(drillBackupPath, { recursive: true });
      const backupStart = Date.now();
      const dumpFile = join(drillBackupPath, 'dump.dump');
      execFileSync('pg_dump', ['--format=custom', `--file=${dumpFile}`], {
        env: buildDrPostgresEnv(sourceDsn),
        stdio: 'pipe',
        timeout: 10 * 60 * 1000,
      });
      report.backup.durationMs = Date.now() - backupStart;
      backupCompletedAt = new Date();
      const stats = await stat(dumpFile).catch(() => null);
      if (!stats) throw new Error(`backup artifact missing: ${dumpFile}`);
      assertRegularArtifact(dumpFile, stats);
      report.backup.sizeBytes = stats.size;
      console.log(`  Backup completed in ${report.backup.durationMs}ms`);

      console.log('[3/6] Sentinel runB (after cutoff — must be absent after restore)...');
      runB = await createDrillRun(dbUrl);
      report.sentinel.runB = runB;
    }

    if (mode === 'backup') {
      report.honestyLevel = 'DRAFT';
      report.overall = 'DRAFT';
      report.completedAt = new Date().toISOString();
      return finish(report);
    }

    const dumpFile = join(drillBackupPath, 'dump.dump');
    const dumpStats = await stat(dumpFile).catch(() => null);
    if (!dumpStats) throw new Error(`backup artifact missing: ${dumpFile}`);
    assertRegularArtifact(dumpFile, dumpStats);
    report.backup.sizeBytes = dumpStats.size;

    console.log('[3.5/6] Validating retained public JWKS artifact...');
    if (mode === 'full' || mode === 'restore') {
      retainedJwksArtifact = await readRetainedJwks(retainedJwksSource);
      if (mode === 'full' && resolve(retainedJwksSource) !== resolve(retainedJwksDestination)) {
        await mkdir(drillBackupPath, { recursive: true });
        await copyFile(retainedJwksSource, retainedJwksDestination);
        retainedJwksArtifact = await readRetainedJwks(retainedJwksDestination);
      }
      report.validation.retainedJwksSha256 = retainedJwksArtifact.sha256;
      report.validation.retainedJwksKeyIds = retainedJwksArtifact.keyIds;
    }

    console.log('[4/6] Restoring to independent target...');
    const restoreStart = Date.now();

    assertDistinctRestoreTarget(sourceDsn, restoredDsn);
    try {
      restoreIntoFreshTarget({
        createDatabase: () => {
          createFreshRestoreDatabase(restoredDsn, () => {
            execFileSync('createdb', [restoredDsn.database], {
              env: { ...buildDrPostgresEnv(restoredDsn), PGDATABASE: 'postgres' },
              stdio: 'pipe',
            });
          });
        },
        countUserObjects: () => countRestoreTargetUserObjects(restoredDsn),
        restore: () => {
          execFileSync('pg_restore', ['--no-owner', '--no-acl', dumpFile], {
            env: buildDrPostgresEnv(restoredDsn),
            stdio: 'pipe',
            timeout: 5 * 60 * 1000,
          });
        },
      });
      independentRestore = true;
      report.restore.independent = true;
      report.restoredDsn = {
        host: restoredDsn.host,
        port: restoredDsn.port,
        database: restoredDsn.database,
      };
      report.restore.pgVersion = execSync('psql --version', { encoding: 'utf-8' }).trim();
    } catch (err) {
      failures.push(`Restore to independent DSN failed: ${sanitizeError(err, redactSecrets)}`);
      report.restore.independent = false;
    }
    report.restore.durationMs = Date.now() - restoreStart;

    console.log('[5/6] Validating restored data (RST only, never source)...');
    if (independentRestore) {
      report.validation.runsTableExists = tableExists(restoredDsn, 'commander_runs');
      report.validation.stepsTableExists = tableExists(restoredDsn, 'commander_steps');
      report.validation.eventsTableExists = tableExists(restoredDsn, 'commander_events');
      report.validation.outboxTableExists = tableExists(restoredDsn, 'commander_outbox');
      report.validation.timersTableExists = tableExists(restoredDsn, 'commander_timers');
      report.validation.effects = tableExists(restoredDsn, 'commander_effects');
      report.validation.interactions = tableExists(restoredDsn, 'commander_interactions');
      report.validation.killSwitches = tableExists(restoredDsn, 'commander_kill_switches');
      Object.assign(report.validation, assessRestoredEvidence(restoredDsn, runPsql));
      if (retainedJwksArtifact && report.validation.evidenceReceiptsRestored) {
        try {
          const verification = verifyRestoredReceiptPages(
            (cursor) => queryRestoredReceiptPage(restoredDsn, runPsql, cursor),
            retainedJwksArtifact.jwks,
          );
          report.validation.evidenceReceiptsVerified = verification.verified;
          report.validation.evidenceReceiptVerificationFailures = verification.failed;
          for (const reason of verification.failures)
            failures.push(`restored evidence receipt verification failed: ${reason}`);
        } catch (err) {
          failures.push(
            `restored evidence receipt verification failed: ${sanitizeError(err, redactSecrets)}`,
          );
        }
      }
      report.validation.rowCount.runs = countRows(restoredDsn, 'commander_runs');
      report.validation.rowCount.steps = countRows(restoredDsn, 'commander_steps');
      report.validation.rowCount.events = countRows(restoredDsn, 'commander_events');

      if (runA && runB) {
        const aExists = await verifyRunExists(restoreDbUrl, runA);
        const bMissing = await verifyRunMissing(restoreDbUrl, runB);
        sentinelVerified = aExists && bMissing;
        if (!aExists) failures.push('sentinel runA missing after restore');
        if (!bMissing) failures.push('sentinel runB present after restore (should be absent)');
      }
    } else {
      failures.push('Skipped RST validation — no independent restore');
    }

    const schemaFailures = restoredValidationFailures(report.validation);
    const validationFailures = [...schemaFailures];
    if (!retainedJwksArtifact) validationFailures.push('retained JWKS artifact missing');
    if (report.validation.evidenceReceiptsRestored) {
      if (report.validation.evidenceReceiptVerificationFailures > 0) {
        validationFailures.push('restored evidence receipt signatures invalid');
      }
      if (report.validation.evidenceReceiptsVerified !== report.validation.evidenceReceiptCount) {
        validationFailures.push('restored evidence receipt verification incomplete');
      }
    }
    report.restore.schemaValid = schemaFailures.length === 0;
    failures.push(...validationFailures);

    console.log('[6/6] Assessing RPO/RTO...');
    if (backupCompletedAt && lastCommittedAt && independentRestore) {
      const rpoMs = computeRpoMs(backupCompletedAt, lastCommittedAt);
      report.rpo.actualMs = rpoMs;
      report.rpo.mode = 'measured';
      report.rpo.passed = rpoMs <= RPO_TARGET_MS;
      if (!report.rpo.passed) failures.push(`RPO exceeded: ${rpoMs}ms > ${RPO_TARGET_MS}ms`);
    } else {
      report.rpo.mode = 'draft';
      report.rpo.passed = false;
      if (mode !== 'restore')
        failures.push('RPO not measured — missing cutoff or independent restore');
    }

    const completedAt = new Date();
    report.rto.actualMs = completedAt.getTime() - incidentStart.getTime();
    report.rto.passed = report.rto.actualMs <= RTO_TARGET_MS;
    if (!report.rto.passed)
      failures.push(`RTO exceeded: ${report.rto.actualMs}ms > ${RTO_TARGET_MS}ms`);

    report.honestyLevel = resolveHonestyLevel({
      independentRestore,
      sentinelVerified,
    });

    report.overall = resolveDrillOverall({
      mode: mode === 'restore' ? 'restore' : 'full',
      independentRestore,
      restoreFailures: independentRestore ? [] : ['independent restore failed'],
      validationFailures,
      sentinelVerified,
      rpoPassed: report.rpo.passed,
      rtoPassed: report.rto.passed,
    });
    report.completedAt = completedAt.toISOString();

    console.log(`\n[DR Drill ${drillId}] ${report.overall} honesty=${report.honestyLevel}`);
    console.log(
      `  RPO: ${report.rpo.actualMs}ms mode=${report.rpo.mode} — ${report.rpo.passed ? 'PASS' : 'FAIL'}`,
    );
    console.log(`  RTO: ${report.rto.actualMs}ms — ${report.rto.passed ? 'PASS' : 'FAIL'}`);
    if (failures.length > 0) {
      console.log('  Failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } catch (err) {
    failures.push(`Drill error: ${sanitizeError(err, redactSecrets)}`);
    report.overall = 'FAIL';
    report.honestyLevel = 'DRAFT';
    report.completedAt = new Date().toISOString();
  }

  return finish(report);
}

async function finish(report: DrillReport): Promise<void> {
  const reportPath = join(report.backup.path, 'drill-report.json');
  try {
    await mkdir(report.backup.path, { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);
  } catch (err) {
    console.error(`Failed to persist DR report: ${sanitizeError(err)}`);
    process.exitCode = 1;
    return;
  }
  if (report.overall === 'FAIL') process.exitCode = 1;
  if (report.overall === 'DRAFT') process.exitCode = 2;
}

function buildRedactSecrets(): string[] {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return [];
  const secrets = [dbUrl];
  try {
    const sourceDsn = parseDatabaseUrl(dbUrl);
    secrets.push(sourceDsn.password);
    const restorePort = process.env.COMMANDER_DR_RESTORE_PORT ?? '5433';
    const restoreDbUrl =
      process.env.RST_DATABASE_URL ?? buildRestoreDatabaseUrl(dbUrl, restorePort);
    secrets.push(restoreDbUrl);
    secrets.push(parseDatabaseUrl(restoreDbUrl).password);
  } catch {
    /* ignore malformed DSN */
  }
  return secrets.filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('DR drill failed:', sanitizeError(err, buildRedactSecrets()));
    process.exit(1);
  });
}
