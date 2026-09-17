#!/usr/bin/env tsx
/**
 * audit-report.ts — Automated Audit Report Generator for Commander
 *
 * Collects operability metrics from the kernel and produces a JSON audit
 * report with HMAC signature (using IntegrityLayer from securityPrimitives).
 *
 * Modes:
 *   - Production: connects to PostgreSQL via DATABASE_URL (uses psql)
 *   - Test:       uses InMemoryKernelRepository, only when --test is passed
 *                 EXPLICITLY. A missing DATABASE_URL is never interpreted as
 *                 "run in test mode" — it is a configuration error.
 *
 * A test-mode report is a fixture artifact. It is labelled
 * executionMode=test / evidenceLevel=simulated / measurementStatus=SIMULATED
 * and its overall `status` is NOT_EVALUATED: it can never carry production
 * PASS semantics, whatever the fixture checks happen to produce (that result
 * is reported separately as `fixtureChecksPassed`).
 *
 * Metrics collected:
 *   - Run count by state (PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED, PAUSED, ...)
 *   - Step count by state (PENDING, RUNNING, SUCCEEDED, FAILED, ...)
 *   - DLQ entries (depth + oldest entry)
 *   - Outbox backlog (unpublished messages)
 *   - WAL size (PostgreSQL pg_wal directory, estimated in test mode)
 *   - Active workers (count + heartbeat health)
 *   - Tenant count (unique tenants with runs)
 *   - Event log size, per-aggregate sequence contiguity, and cryptographic
 *     chain integrity. These are two DIFFERENT claims and are reported
 *     separately; see `eventSequenceContiguity` below.
 *
 * Exit codes:
 *   0 — All metrics within acceptable bounds
 *   1 — One or more CRITICAL metrics failed, or the configuration/connection
 *       was unusable (AUDIT_DATABASE_REQUIRED, AUDIT_DATABASE_UNREACHABLE)
 *
 * Usage:
 *   # Production (PostgreSQL):
 *   DATABASE_URL=postgresql://user:pass@host:5432/db \
 *   npx tsx scripts/audit-report.ts
 *
 *   # Testing (InMemoryKernelRepository):
 *   npx tsx scripts/audit-report.ts --test
 *
 *   # JSON output to stdout:
 *   npx tsx scripts/audit-report.ts --json
 *
 *   # Help:
 *   npx tsx scripts/audit-report.ts --help
 *
 * Environment variables:
 *   DATABASE_URL               — PostgreSQL connection string (production mode)
 *   AUDIT_DLQ_DEPTH_THRESHOLD   — DLQ depth failure threshold (default 100)
 *   AUDIT_WORKER_STALE_MS       — Worker heartbeat staleness threshold in ms (default 60000)
 *   COMMANDER_INTEGRITY_KEY     — HMAC signing key for persisted reports (default: dev key)
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntegrityLayer } from '../packages/core/src/security/securityPrimitives';
import { InMemoryKernelRepository } from '../packages/kernel/src/testing/inMemoryRepository';

// ============================================================================
// Thresholds
// ============================================================================
const DLQ_DEPTH_THRESHOLD = parseInt(process.env.AUDIT_DLQ_DEPTH_THRESHOLD ?? '100', 10);
const WORKER_STALE_MS = parseInt(process.env.AUDIT_WORKER_STALE_MS ?? '60000', 10);
const SQL_TIMEOUT_MS = 30_000;

/**
 * Stable, secret-free error codes. Anything an operator sees is one of these
 * plus a masked context value — never a raw DSN or a driver dump.
 */
export const AUDIT_ERROR_CODES = {
  databaseRequired: 'AUDIT_DATABASE_REQUIRED',
  databaseUnreachable: 'AUDIT_DATABASE_UNREACHABLE',
  inMemoryUnavailable: 'AUDIT_IN_MEMORY_UNAVAILABLE',
  outputNotWritable: 'AUDIT_OUTPUT_NOT_WRITABLE',
  outputExists: 'AUDIT_OUTPUT_EXISTS',
} as const;

// ============================================================================
// CLI flags
// ============================================================================

export interface CliFlags {
  json: boolean;
  test: boolean;
  help: boolean;
  output?: string;
}

export function parseFlags(argv: string[]): CliFlags {
  const outputIndex = argv.findIndex((arg) => arg === '--output' || arg.startsWith('--output='));
  let output: string | undefined;
  if (outputIndex >= 0) {
    const arg = argv[outputIndex]!;
    const value = arg.startsWith('--output=')
      ? arg.slice('--output='.length)
      : argv[outputIndex + 1];
    if (value !== undefined && value.length > 0 && !value.startsWith('-')) {
      output = value.trim() || undefined;
    }
  }
  return {
    json: argv.includes('--json'),
    test: argv.includes('--test') || argv.includes('--in-memory'),
    help: argv.includes('--help') || argv.includes('-h'),
    output,
  };
}

function printHelp(): void {
  console.log(`
Commander Audit Report Generator

USAGE:
  npx tsx scripts/audit-report.ts [OPTIONS]

OPTIONS:
  --json            Output the JSON report to stdout instead of writing a file
  --test            Use InMemoryKernelRepository instead of PostgreSQL
                    (explicit opt-in; produces a SIMULATED, non-production artifact)
  --output <path>   Write the report to <path> instead of the default location
  --help, -h        Show this help message

MODES:
  Production  Requires DATABASE_URL. Connects to PostgreSQL and collects real
              metrics. A missing DATABASE_URL is an error, never a silent
              fallback to the in-memory repository.
  Testing     Only with --test. The report is labelled simulated and its
              overall status is NOT_EVALUATED.

ENVIRONMENT:
  DATABASE_URL                PostgreSQL connection string (required in production)
  AUDIT_DLQ_DEPTH_THRESHOLD   DLQ depth failure threshold (default 100)
  AUDIT_WORKER_STALE_MS       Worker heartbeat staleness threshold in ms (default: 60000)
  COMMANDER_INTEGRITY_KEY     HMAC signing key for reports (default: dev key)

OUTPUT:
  Default: .internal/audits/audit-<ISO timestamp>.json
  (An existing file is never overwritten.)

EXIT CODES:
  0  All metrics within acceptable bounds (production) / fixture checks passed (--test)
  1  One or more CRITICAL metrics failed, or the audit could not be measured
`);
}

// ============================================================================
// Types
// ============================================================================

type RunState =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PAUSED'
  | 'COMPENSATING'
  | 'COMPENSATED';

type StepState =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_FOR_HUMAN'
  | 'RETRY_WAIT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SKIPPED';

/**
 * Per-aggregate sequence contiguity.
 *
 * This is NOT cryptographic integrity. It only proves that the `sequence`
 * column has no holes per aggregate. A tampered `payload` on an otherwise
 * contiguous sequence still reports CONTIGUOUS. The two claims are therefore
 * reported as separate fields and must not be conflated.
 */
export type SequenceContiguity = 'CONTIGUOUS' | 'GAPS_DETECTED' | 'UNKNOWN';

/**
 * Cryptographic chain verification outcome for the event log.
 *
 * `commander_events` has no prev-hash / entry-hash columns in the current
 * schema, so there is nothing to verify. NOT_VERIFIED means exactly that —
 * it is an absence of evidence, never a statement that the log is intact.
 */
export type CryptographicChainIntegrity = 'VERIFIED' | 'NOT_VERIFIED' | 'EMPTY';

interface AuditMetrics {
  /** Run counts grouped by state */
  runsByState: Record<string, number>;
  /** Step counts grouped by state */
  stepsByState: Record<string, number>;
  /** Dead-letter queue depth */
  dlqDepth: number;
  /** Oldest DLQ entry timestamp (ISO 8601), or null if empty */
  dlqOldestEntry: string | null;
  /** Outbox messages not yet published */
  outboxPending: number;
  /** Total event log entries */
  eventLogSize: number;
  /** Whether the event log sequence numbers are contiguous per aggregate */
  eventSequenceContiguity: SequenceContiguity;
  /** Whether a cryptographic chain over the event log was actually verified */
  cryptographicChainIntegrity: CryptographicChainIntegrity;
  /** Number of registered active workers */
  workerCount: number;
  /** Whether all active workers have recent heartbeats */
  workerHeartbeatsHealthy: boolean;
  /** Number of workers with stale heartbeats */
  staleWorkerCount: number;
  /** Pending human interactions awaiting response */
  interactionPending: number;
  /** PostgreSQL WAL size in MB (estimated in test mode) */
  walSizeMb: number;
  /** Number of unique tenants with runs */
  tenantCount: number;
}

export type AuditStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

interface AuditReport {
  /** Report schema version. Consumers must reject unknown versions. */
  schemaVersion: 2;
  /** ISO timestamp of report generation */
  timestamp: string;
  /** Data source: "postgresql" or "in-memory" */
  source: string;
  /** Whether this artifact came from a real database or the in-memory fixture */
  executionMode: 'production' | 'test';
  /** Evidence level of the measurements in this artifact */
  evidenceLevel: 'live' | 'simulated';
  /** Whether the numbers were actually measured against a real system */
  measurementStatus: 'MEASURED' | 'SIMULATED';
  /**
   * What this report's integrity claim actually covers. SEQUENCE_ONLY means
   * only per-aggregate sequence contiguity was checked; no cryptographic chain
   * was verified.
   */
  integrityClaim: 'SEQUENCE_ONLY' | 'NONE';
  /** Masked database URL for traceability (production mode only) */
  databaseUrlMasked: string;
  /** Thresholds used for evaluation */
  thresholds: {
    dlqDepth: number;
    workerStaleMs: number;
  };
  /** Collected metrics */
  metrics: AuditMetrics;
  /**
   * Overall status. NOT_EVALUATED means this artifact is not a production
   * audit verdict (e.g. it was produced with --test).
   */
  status: AuditStatus;
  /**
   * Test mode only: the outcome of the fixture checks. Never a production
   * verdict, and never conflated with `status`.
   */
  fixtureChecksPassed?: boolean;
  /** List of critical failures (empty if PASS) */
  failures: string[];
  /** List of non-critical warnings */
  warnings: string[];
  /** HMAC signature (computed via IntegrityLayer.sign()) */
  _sig: string;
  /** Signature timestamp (Unix epoch ms) */
  _ts: number;
}

// ============================================================================
// Database helpers (psql via execSync — same pattern as dr-backup-verify.ts)
// ============================================================================

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse a scalar SQL result as a non-negative integer.
 * Returns undefined for empty, non-numeric, negative, or non-finite input so
 * that callers cannot mistake "not measured" for a measured zero.
 */
export function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Execute a SQL query against the database and return the raw output.
 * Uses psql with -t (tuples only) -A (unaligned) -F (field separator).
 */
function querySql(dbUrl: string, sql: string, fieldSep = '|'): string {
  try {
    return execSync(`psql "${dbUrl}" -t -A -F '${fieldSep}' -c "${sql}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SQL_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(`SQL query failed: ${msg.split('\n')[0]}`);
  }
}

/**
 * Execute a scalar SQL query and return the single value.
 */
function queryScalar(dbUrl: string, sql: string): string {
  const out = querySql(dbUrl, sql).trim();
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[0].trim() : '';
}

/**
 * Execute a GROUP BY query and parse results into a Record.
 * Expects two columns: key and count, separated by the field separator.
 */
function queryCounts(dbUrl: string, sql: string): Record<string, number> {
  const out = querySql(dbUrl, sql).trim();
  const result: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = parseInt(trimmed.slice(sep + 1).trim(), 10);
    if (key) result[key] = isNaN(val) ? 0 : val;
  }
  return result;
}

/**
 * Mask a database URL for logging (hide credentials).
 */
function maskDbUrl(dbUrl: string): string {
  return dbUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

// ============================================================================
// Sanitization (project security rule: strip control chars from DB values)
// ============================================================================

const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeText(value: string): string {
  return value.replace(CONTROL_CHAR_PATTERN, '').trim();
}

// ============================================================================
// HMAC signing (uses IntegrityLayer from securityPrimitives)
// ============================================================================

/**
 * Sign a report payload using IntegrityLayer.sign().
 * The IntegrityLayer computes HMAC-SHA256 over canonical JSON (sorted keys)
 * of the report data concatenated with the timestamp.
 *
 * Returns the report data with _sig and _ts fields added.
 */
function signReport(reportData: Omit<AuditReport, '_sig' | '_ts'>): AuditReport {
  const integrity = new IntegrityLayer(process.env.COMMANDER_INTEGRITY_KEY);
  const signed = integrity.sign(reportData as Record<string, unknown>);
  return {
    ...(signed.data as Record<string, unknown>),
    _sig: signed._sig,
    _ts: signed._ts,
  } as AuditReport;
}

// ============================================================================
// Metric collection — PostgreSQL (production)
// ============================================================================

/**
 * Collect all audit metrics from the kernel PostgreSQL database.
 */
function collectMetricsFromPostgres(dbUrl: string): AuditMetrics {
  // ── Runs by state ─────────────────────────────────────────────────────────
  const runsByState = queryCounts(
    dbUrl,
    'SELECT state, COUNT(*) FROM commander_runs GROUP BY state ORDER BY state',
  );

  // ── Steps by state ─────────────────────────────────────────────────────────
  const stepsByState = queryCounts(
    dbUrl,
    'SELECT state, COUNT(*) FROM commander_steps GROUP BY state ORDER BY state',
  );

  // ── DLQ depth ──────────────────────────────────────────────────────────────
  const dlqDepth = parseInt(queryScalar(dbUrl, 'SELECT COUNT(*) FROM commander_outbox_dlq'), 10);

  // ── DLQ oldest entry ────────────────────────────────────────────────────────
  const dlqOldestRaw = queryScalar(
    dbUrl,
    'SELECT MIN(original_created_at) FROM commander_outbox_dlq',
  );
  const dlqOldestEntry = !dlqOldestRaw || dlqOldestRaw === '' ? null : sanitizeText(dlqOldestRaw);

  // ── Outbox pending ──────────────────────────────────────────────────────────
  const outboxPending = parseInt(
    queryScalar(dbUrl, 'SELECT COUNT(*) FROM commander_outbox WHERE published_at IS NULL'),
    10,
  );

  // ── Event log size ──────────────────────────────────────────────────────────
  const eventLogSize = parseInt(queryScalar(dbUrl, 'SELECT COUNT(*) FROM commander_events'), 10);

  // ── Event log: sequence contiguity (NOT cryptographic integrity) ───────────
  // commander_events is uniquely keyed by (aggregate_type, aggregate_id,
  // sequence); tenant_id is functionally determined by that key, so the GROUP
  // BY below matches the real unique key and does not need a tenant column.
  // A query failure or an unparseable count is UNKNOWN — never "intact".
  let eventSequenceContiguity: SequenceContiguity = 'UNKNOWN';
  try {
    const gapCount = parseNonNegativeInt(
      queryScalar(
        dbUrl,
        `SELECT COUNT(*) FROM (
           SELECT aggregate_type, aggregate_id,
                  MAX(sequence) - MIN(sequence) + 1 AS expected,
                  COUNT(*) AS actual
           FROM commander_events
           GROUP BY aggregate_type, aggregate_id
         ) t
         WHERE expected <> actual`,
      ),
    );
    if (gapCount !== undefined) {
      eventSequenceContiguity = gapCount === 0 ? 'CONTIGUOUS' : 'GAPS_DETECTED';
    }
  } catch {
    eventSequenceContiguity = 'UNKNOWN';
  }

  // ── Event log: cryptographic chain integrity ───────────────────────────────
  // commander_events has no prev-hash / entry-hash / signature columns, so
  // there is no chain in this store to verify. Report the capability gap
  // honestly rather than deriving an integrity claim from sequence numbers.
  const cryptographicChainIntegrity: CryptographicChainIntegrity =
    eventLogSize === 0 ? 'EMPTY' : 'NOT_VERIFIED';

  // ── WAL size ────────────────────────────────────────────────────────────────
  // Query pg_wal directory size via pg_walfile_name + pg_ls_dir, or use
  // pg_stat_wal if available. Fall back to 0 if not queryable.
  let walSizeMb = 0;
  try {
    const walSizeBytes = queryScalar(dbUrl, `SELECT COALESCE(sum(size), 0) FROM pg_ls_waldir()`);
    walSizeMb = Math.round(parseInt(walSizeBytes, 10) / (1024 * 1024));
  } catch {
    // pg_ls_waldir may not be available on all PG versions/configurations
    walSizeMb = 0;
  }

  // ── Tenant count ────────────────────────────────────────────────────────────
  const tenantCount = parseInt(
    queryScalar(dbUrl, 'SELECT COUNT(DISTINCT tenant_id) FROM commander_runs'),
    10,
  );

  // ── Worker count ────────────────────────────────────────────────────────────
  const workerCount = parseInt(
    queryScalar(dbUrl, "SELECT COUNT(*) FROM commander_workers WHERE status = 'ACTIVE'"),
    10,
  );

  // ── Worker heartbeat health ─────────────────────────────────────────────────
  const healthyWorkerCount = parseInt(
    queryScalar(
      dbUrl,
      `SELECT COUNT(*) FROM commander_workers
       WHERE status = 'ACTIVE'
         AND last_heartbeat_at > now() - interval '${Math.floor(WORKER_STALE_MS / 1000)} seconds'`,
    ),
    10,
  );
  const staleWorkerCount = workerCount - healthyWorkerCount;
  const workerHeartbeatsHealthy = workerCount === 0 ? false : staleWorkerCount === 0;

  // ── Interaction pending ─────────────────────────────────────────────────────
  const interactionPending = parseInt(
    queryScalar(dbUrl, "SELECT COUNT(*) FROM commander_interactions WHERE status = 'pending'"),
    10,
  );

  return {
    runsByState,
    stepsByState,
    dlqDepth: isNaN(dlqDepth) ? 0 : dlqDepth,
    dlqOldestEntry,
    outboxPending: isNaN(outboxPending) ? 0 : outboxPending,
    eventLogSize: isNaN(eventLogSize) ? 0 : eventLogSize,
    eventSequenceContiguity,
    cryptographicChainIntegrity,
    workerCount: isNaN(workerCount) ? 0 : workerCount,
    workerHeartbeatsHealthy,
    staleWorkerCount: isNaN(staleWorkerCount) ? 0 : staleWorkerCount,
    interactionPending: isNaN(interactionPending) ? 0 : interactionPending,
    walSizeMb: isNaN(walSizeMb) ? 0 : walSizeMb,
    tenantCount: isNaN(tenantCount) ? 0 : tenantCount,
  };
}

// ============================================================================
// Metric collection — InMemoryKernelRepository (testing)
// ============================================================================

/**
 * Collect audit metrics from an InMemoryKernelRepository instance.
 *
 * This mode is used when DATABASE_URL is not set (or --test flag is passed).
 * It creates a fresh InMemoryKernelRepository, collects metrics from its
 * internal state via the snapshot() method and listDlqEntries(), and returns
 * them. In test mode, worker metrics are zero (the InMemoryKernelRepository
 * does not track workers — that is the WorkerRegistry's responsibility).
 *
 * For integration tests that need to verify the audit script with real data,
 * populate the InMemoryKernelRepository before calling this function.
 */
async function collectMetricsFromInMemory(repo?: InMemoryKernelRepository): Promise<AuditMetrics> {
  const repository = repo ?? new InMemoryKernelRepository();
  await repository.initialize();

  // Access internal state via the snapshot() method (returns cloned data)
  const snapshot = repository.snapshot();

  // ── Runs by state ─────────────────────────────────────────────────────────
  const runsByState: Record<string, number> = {};
  const tenantIds = new Set<string>();
  for (const run of snapshot.runs.values()) {
    runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;
    tenantIds.add(run.tenantId);
  }

  // ── Steps by state ─────────────────────────────────────────────────────────
  const stepsByState: Record<string, number> = {};
  for (const step of snapshot.steps.values()) {
    stepsByState[step.state] = (stepsByState[step.state] ?? 0) + 1;
  }

  // ── DLQ entries ────────────────────────────────────────────────────────────
  const dlqEntries = await repository.listDlqEntries(100000);
  const dlqDepth = dlqEntries.length;
  const dlqOldestEntry = dlqDepth > 0 ? dlqEntries.map((e) => e.originalCreatedAt).sort()[0] : null;

  // ── Outbox pending ──────────────────────────────────────────────────────────
  let outboxPending = 0;
  for (const msg of snapshot.outbox.values()) {
    if (!msg.publishedAt) outboxPending++;
  }

  // ── Event log size ──────────────────────────────────────────────────────────
  const eventLogSize = snapshot.events.length;

  // ── Event log sequence contiguity (NOT cryptographic integrity) ────────────
  const aggregateSequences: Record<string, number[]> = {};
  for (const event of snapshot.events) {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    if (!aggregateSequences[key]) aggregateSequences[key] = [];
    aggregateSequences[key].push(event.sequence);
  }
  let sequencesContiguous = true;
  for (const sequences of Object.values(aggregateSequences)) {
    sequences.sort((a, b) => a - b);
    for (let i = 1; i < sequences.length; i++) {
      if (sequences[i] !== sequences[i - 1]! + 1) {
        sequencesContiguous = false;
        break;
      }
    }
    if (!sequencesContiguous) break;
  }
  const eventSequenceContiguity: SequenceContiguity = sequencesContiguous
    ? 'CONTIGUOUS'
    : 'GAPS_DETECTED';
  const cryptographicChainIntegrity: CryptographicChainIntegrity =
    eventLogSize === 0 ? 'EMPTY' : 'NOT_VERIFIED';

  // ── WAL size (estimated from event count — ~2KB per event) ──────────────────
  const walSizeMb = Math.round((eventLogSize * 2048) / (1024 * 1024));

  // ── Tenant count ────────────────────────────────────────────────────────────
  const tenantCount = tenantIds.size;

  // ── Workers (not tracked by InMemoryKernelRepository) ───────────────────────
  const workerCount = 0;
  const workerHeartbeatsHealthy = false;
  const staleWorkerCount = 0;

  // ── Interaction pending (not exposed via snapshot; default 0) ───────────────
  const interactionPending = 0;

  return {
    runsByState,
    stepsByState,
    dlqDepth,
    dlqOldestEntry,
    outboxPending,
    eventLogSize,
    eventSequenceContiguity,
    cryptographicChainIntegrity,
    workerCount,
    workerHeartbeatsHealthy,
    staleWorkerCount,
    interactionPending,
    walSizeMb,
    tenantCount,
  };
}

// ============================================================================
// Report generation
// ============================================================================

/**
 * Generate a unique, collision-free report filename.
 * Format: audit-{ISO-8601-with-dashes}.json
 * The previous date-only name silently overwrote same-day history.
 */
function generateReportFilename(now: Date = new Date()): string {
  return `audit-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

/**
 * Evaluate metrics and produce a pass/fail status with failure reasons.
 *
 * Fail-closed: an unmeasurable integrity claim is a failure, not a warning.
 * Sequence contiguity and cryptographic integrity are separate claims and are
 * evaluated separately.
 */
export function evaluate(
  metrics: AuditMetrics,
  isTestMode: boolean,
): {
  status: 'PASS' | 'FAIL';
  failures: string[];
  warnings: string[];
} {
  const failures: string[] = [];
  const warnings: string[] = [];

  // Critical: sequence gaps in the event log
  if (metrics.eventSequenceContiguity === 'GAPS_DETECTED') {
    failures.push(
      'CRITICAL: Event log sequence contiguity FAILED — sequence gaps detected in commander_events',
    );
  }
  if (metrics.eventSequenceContiguity === 'UNKNOWN') {
    failures.push(
      'CRITICAL: Event log sequence contiguity could not be measured (UNKNOWN) — treated as failure',
    );
  }

  // Critical: no verifiable cryptographic chain. This is a capability gap, not
  // a finding of tampering, but it must never be reported as intact.
  if (metrics.cryptographicChainIntegrity === 'NOT_VERIFIED') {
    failures.push(
      'CRITICAL: Event log cryptographic chain integrity is NOT_VERIFIED — commander_events has no verifiable hash chain in this schema',
    );
  }

  // Critical: DLQ depth exceeds threshold
  if (metrics.dlqDepth > DLQ_DEPTH_THRESHOLD) {
    failures.push(
      `CRITICAL: DLQ depth ${metrics.dlqDepth} exceeds threshold ${DLQ_DEPTH_THRESHOLD}`,
    );
  }

  // Critical: No active workers (production mode only — test mode has no workers)
  if (!isTestMode) {
    if (metrics.workerCount === 0) {
      failures.push('CRITICAL: No active workers registered in commander_workers');
    } else if (!metrics.workerHeartbeatsHealthy) {
      failures.push(
        `CRITICAL: ${metrics.staleWorkerCount} of ${metrics.workerCount} active workers have stale heartbeats (>${WORKER_STALE_MS}ms)`,
      );
    }
  }

  // Non-critical warnings
  if (metrics.eventSequenceContiguity === 'CONTIGUOUS') {
    warnings.push(
      'INFO: sequence numbers are contiguous per aggregate; this is not cryptographic integrity',
    );
  }
  if (metrics.outboxPending > 0) {
    warnings.push(`WARNING: ${metrics.outboxPending} outbox messages pending publication`);
  }
  if (metrics.interactionPending > 0) {
    warnings.push(`WARNING: ${metrics.interactionPending} human interactions pending response`);
  }
  const stuckRuns = (metrics.runsByState['RUNNING'] ?? 0) + (metrics.runsByState['PAUSED'] ?? 0);
  if (stuckRuns > 0) {
    warnings.push(`WARNING: ${stuckRuns} runs in RUNNING/PAUSED state (potential stuck workflows)`);
  }
  if (metrics.walSizeMb > 500) {
    warnings.push(
      `WARNING: WAL size ${metrics.walSizeMb}MB exceeds 500MB threshold — consider increasing checkpoint frequency`,
    );
  }

  return {
    status: failures.length > 0 ? 'FAIL' : 'PASS',
    failures,
    warnings,
  };
}

/**
 * Build and HMAC-sign the final audit report using IntegrityLayer.
 *
 * In test mode the overall status is always NOT_EVALUATED: a fixture run is
 * not a production verdict. The fixture outcome is reported separately as
 * `fixtureChecksPassed`, and the signature covers every one of these labels so
 * a test artifact cannot be re-labelled as a production pass.
 */
export function buildReport(
  source: string,
  dbUrlMasked: string,
  metrics: AuditMetrics,
  isTestMode: boolean,
): AuditReport {
  const { status: fixtureStatus, failures, warnings } = evaluate(metrics, isTestMode);
  const timestamp = new Date().toISOString();

  const reportData: Omit<AuditReport, '_sig' | '_ts'> = {
    schemaVersion: 2,
    timestamp,
    source,
    executionMode: isTestMode ? 'test' : 'production',
    evidenceLevel: isTestMode ? 'simulated' : 'live',
    measurementStatus: isTestMode ? 'SIMULATED' : 'MEASURED',
    integrityClaim: 'SEQUENCE_ONLY',
    databaseUrlMasked: dbUrlMasked,
    thresholds: {
      dlqDepth: DLQ_DEPTH_THRESHOLD,
      workerStaleMs: WORKER_STALE_MS,
    },
    metrics,
    status: isTestMode ? 'NOT_EVALUATED' : fixtureStatus,
    ...(isTestMode ? { fixtureChecksPassed: fixtureStatus === 'PASS' } : {}),
    failures,
    warnings,
  };

  return signReport(reportData);
}

// ============================================================================
// Human-readable summary
// ============================================================================

function printSummary(report: AuditReport, reportFilename: string | null): void {
  const m = report.metrics;
  const border = '='.repeat(72);
  const thin = '-'.repeat(72);

  console.log('');
  console.log(border);
  console.log('  Commander Audit Report');
  console.log(border);
  console.log(`  Timestamp:     ${report.timestamp}`);
  console.log(`  Source:        ${report.source}`);
  console.log(`  Execution:     ${report.executionMode} (evidence: ${report.evidenceLevel})`);
  console.log(`  Measurement:   ${report.measurementStatus}`);
  console.log(`  Integrity:     ${report.integrityClaim}`);
  if (report.databaseUrlMasked) {
    console.log(`  Database:      ${report.databaseUrlMasked}`);
  }
  console.log(`  Status:        ${report.status}`);
  if (report.status === 'NOT_EVALUATED') {
    console.log(
      `  Fixture checks: ${report.fixtureChecksPassed ? 'passed' : 'failed'} (NOT a production verdict)`,
    );
  }
  console.log(thin);

  // Runs by state
  console.log('  Runs by state:');
  const runStates: RunState[] = [
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'PAUSED',
  ];
  for (const state of runStates) {
    const count = m.runsByState[state] ?? 0;
    console.log(`    ${state.padEnd(14)} ${String(count).padStart(8)}`);
  }

  // Steps by state
  console.log(thin);
  console.log('  Steps by state:');
  const stepStates: StepState[] = [
    'PENDING',
    'RUNNING',
    'WAITING_FOR_HUMAN',
    'RETRY_WAIT',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'SKIPPED',
  ];
  for (const state of stepStates) {
    const count = m.stepsByState[state] ?? 0;
    if (count > 0) {
      console.log(`    ${state.padEnd(20)} ${String(count).padStart(8)}`);
    }
  }

  // Infrastructure metrics
  console.log(thin);
  console.log('  Infrastructure:');
  console.log(
    `    DLQ depth:              ${String(m.dlqDepth).padStart(8)}  ${m.dlqDepth > DLQ_DEPTH_THRESHOLD ? 'EXCEEDS THRESHOLD' : 'OK'}`,
  );
  console.log(`    DLQ oldest entry:       ${m.dlqOldestEntry ?? 'N/A'}`);
  console.log(`    Outbox pending:         ${String(m.outboxPending).padStart(8)}`);
  console.log(`    Interaction pending:    ${String(m.interactionPending).padStart(8)}`);
  console.log(`    WAL size (MB):          ${String(m.walSizeMb).padStart(8)}`);
  console.log(`    Tenant count:           ${String(m.tenantCount).padStart(8)}`);
  console.log(thin);

  // Event log
  console.log('  Event log:');
  console.log(`    Size:                   ${String(m.eventLogSize).padStart(8)}`);
  console.log(
    `    Sequence contiguity:    ${m.eventSequenceContiguity} (not cryptographic integrity)`,
  );
  console.log(`    Cryptographic chain:    ${m.cryptographicChainIntegrity}`);
  console.log(thin);

  // Workers
  console.log('  Workers:');
  console.log(`    Active count:           ${String(m.workerCount).padStart(8)}`);
  console.log(`    Stale heartbeats:       ${String(m.staleWorkerCount).padStart(8)}`);
  console.log(`    Heartbeat health:       ${m.workerHeartbeatsHealthy ? 'HEALTHY' : 'UNHEALTHY'}`);
  console.log(thin);

  // Failures
  if (report.failures.length > 0) {
    console.log('  Failures:');
    for (const f of report.failures) {
      console.log(`    X ${f}`);
    }
    console.log(thin);
  }

  // Warnings
  if (report.warnings.length > 0) {
    console.log('  Warnings:');
    for (const w of report.warnings) {
      console.log(`    ! ${w}`);
    }
    console.log(thin);
  }

  if (reportFilename) {
    console.log(`  Report file: ${reportFilename}`);
  }
  console.log(`  Signature:   ${report._sig.slice(0, 16)}...`);
  console.log(border);
  console.log('');
}

// ============================================================================
// Main
// ============================================================================

/** Default output directory: a controlled internal path, not the public docs tree. */
export const DEFAULT_AUDIT_OUTPUT_DIR = join(REPO_ROOT, '.internal', 'audits');

/**
 * Atomically write a report: temp file with owner-only permissions, then
 * rename. Never overwrites an existing report.
 */
export function writeReportAtomic(reportPath: string, body: string): void {
  if (existsSync(reportPath)) {
    throw new Error(AUDIT_ERROR_CODES.outputExists);
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  const tmpPath = `${reportPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, body, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, reportPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  const dbUrl = process.env.DATABASE_URL?.trim();
  // --test is an explicit opt-in. A missing DATABASE_URL is a configuration
  // error, never an implicit switch to the in-memory fixture.
  const isTestMode = flags.test;

  if (!isTestMode && !dbUrl) {
    console.error(
      `${AUDIT_ERROR_CODES.databaseRequired}: DATABASE_URL is not set. ` +
        'Refusing to fall back to the in-memory fixture for a production audit. ' +
        'Pass --test explicitly if a fixture run is what you want.',
    );
    process.exitCode = 1;
    return;
  }

  // ── Collect metrics ────────────────────────────────────────────────────────
  let metrics: AuditMetrics;
  let source: string;
  let dbUrlMasked: string;

  if (isTestMode) {
    source = 'in-memory';
    dbUrlMasked = '';
    try {
      metrics = await collectMetricsFromInMemory();
    } catch (err) {
      console.error(`${AUDIT_ERROR_CODES.inMemoryUnavailable}: ${(err as Error).name}`);
      process.exitCode = 1;
      return;
    }
  } else {
    source = 'postgresql';
    dbUrlMasked = maskDbUrl(dbUrl!);
    try {
      metrics = collectMetricsFromPostgres(dbUrl!);
    } catch {
      console.error(
        `${AUDIT_ERROR_CODES.databaseUnreachable}: could not collect audit metrics from ${dbUrlMasked}.`,
      );
      console.error('No report was produced. Use --test for an in-memory fixture run.');
      process.exitCode = 1;
      return;
    }
  }

  // ── Build and sign report ───────────────────────────────────────────────────
  const report = buildReport(source, dbUrlMasked, metrics, isTestMode);

  // ── Output ───────────────────────────────────────────────────────────────────
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const reportPath = flags.output
      ? resolve(flags.output)
      : join(DEFAULT_AUDIT_OUTPUT_DIR, generateReportFilename());
    try {
      writeReportAtomic(reportPath, JSON.stringify(report, null, 2) + '\n');
    } catch (err) {
      const code = (err as Error).message;
      console.error(
        code === AUDIT_ERROR_CODES.outputExists
          ? `${AUDIT_ERROR_CODES.outputExists}: ${reportPath} already exists; refusing to overwrite.`
          : `${AUDIT_ERROR_CODES.outputNotWritable}: ${reportPath}`,
      );
      process.exitCode = 1;
      return;
    }

    printSummary(report, reportPath);

    if (report.status === 'FAIL') {
      console.error(`Audit FAILED — ${report.failures.length} critical issue(s) found.`);
      console.error(`Report written to: ${reportPath}`);
      process.exitCode = 1;
      return;
    }
    if (report.status === 'NOT_EVALUATED') {
      console.log(
        `Audit NOT_EVALUATED (fixture checks ${report.fixtureChecksPassed ? 'passed' : 'failed'}) — report written to: ${reportPath}`,
      );
    } else {
      console.log(`Audit PASSED — report written to: ${reportPath}`);
    }
  }

  // ── Exit code ────────────────────────────────────────────────────────────────
  if (report.status === 'FAIL') {
    process.exitCode = 1;
  } else if (report.status === 'NOT_EVALUATED' && report.fixtureChecksPassed !== true) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
