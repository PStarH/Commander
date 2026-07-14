#!/usr/bin/env tsx
/**
 * audit-report.ts — Automated Audit Report Generator for Commander
 *
 * Collects operability metrics from the kernel and produces a JSON audit
 * report with HMAC signature (using IntegrityLayer from securityPrimitives).
 * The report is written to docs/audits/audit-{YYYY-MM-DD}.json.
 *
 * Modes:
 *   - Production: connects to PostgreSQL via DATABASE_URL (uses psql)
 *   - Testing:    uses InMemoryKernelRepository (when DATABASE_URL is not set
 *                 or --test flag is passed)
 *
 * Metrics collected:
 *   - Run count by state (PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED, PAUSED, ...)
 *   - Step count by state (PENDING, RUNNING, SUCCEEDED, FAILED, ...)
 *   - DLQ entries (depth + oldest entry)
 *   - Outbox backlog (unpublished messages)
 *   - WAL size (PostgreSQL pg_wal directory, estimated in test mode)
 *   - Active workers (count + heartbeat health)
 *   - Tenant count (unique tenants with runs)
 *   - Event log size + hash-chain integrity
 *
 * Exit codes:
 *   0 — All metrics within acceptable bounds
 *   1 — One or more CRITICAL metrics failed:
 *        * Hash chain broken (event sequence gaps detected)
 *        * DLQ depth exceeds threshold (default 100)
 *        * No active workers / all heartbeats stale (production mode only)
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IntegrityLayer } from '../packages/core/src/security/securityPrimitives';
import { InMemoryKernelRepository } from '../packages/kernel/src/testing/inMemoryRepository';

// ============================================================================
// Thresholds
// ============================================================================
const DLQ_DEPTH_THRESHOLD = parseInt(process.env.AUDIT_DLQ_DEPTH_THRESHOLD ?? '100', 10);
const WORKER_STALE_MS = parseInt(process.env.AUDIT_WORKER_STALE_MS ?? '60000', 10);
const SQL_TIMEOUT_MS = 30_000;

// ============================================================================
// CLI flags
// ============================================================================

interface CliFlags {
  json: boolean;
  test: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return {
    json: argv.includes('--json'),
    test: argv.includes('--test') || argv.includes('--in-memory'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function printHelp(): void {
  console.log(`
Commander Audit Report Generator

USAGE:
  npx tsx scripts/audit-report.ts [OPTIONS]

OPTIONS:
  --json     Output the JSON report to stdout instead of writing to a file
  --test     Use InMemoryKernelRepository instead of PostgreSQL (testing mode)
  --help, -h Show this help message

MODES:
  Production  Set DATABASE_URL to connect to PostgreSQL and collect real metrics.
  Testing     Without DATABASE_URL (or with --test), uses InMemoryKernelRepository.

ENVIRONMENT:
  DATABASE_URL                PostgreSQL connection string (production mode)
  AUDIT_DLQ_DEPTH_THRESHOLD   DLQ depth failure threshold (default: 100)
  AUDIT_WORKER_STALE_MS       Worker heartbeat staleness threshold in ms (default: 60000)
  COMMANDER_INTEGRITY_KEY     HMAC signing key for reports (default: dev key)

OUTPUT:
  docs/audits/audit-{YYYY-MM-DD}.json  (unless --json is used)

EXIT CODES:
  0  All metrics within acceptable bounds
  1  One or more CRITICAL metrics failed
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
  /** Whether the event log hash chain is intact (no sequence gaps) */
  hashChainIntact: boolean;
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

interface AuditReport {
  /** ISO timestamp of report generation */
  timestamp: string;
  /** Data source: "postgresql" or "in-memory" */
  source: string;
  /** Masked database URL for traceability (production mode only) */
  databaseUrlMasked: string;
  /** Thresholds used for evaluation */
  thresholds: {
    dlqDepth: number;
    workerStaleMs: number;
  };
  /** Collected metrics */
  metrics: AuditMetrics;
  /** Overall pass/fail status */
  status: 'PASS' | 'FAIL';
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

const REPO_ROOT = resolve(__dirname, '..');

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

  // ── Hash chain integrity ───────────────────────────────────────────────────
  // Verifies that event sequences are contiguous per aggregate (no gaps).
  // Returns 1 if intact (no gaps), 0 if broken.
  const hashChainResult = queryScalar(
    dbUrl,
    `SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
     FROM (
       SELECT aggregate_type, aggregate_id,
              MAX(sequence) - MIN(sequence) + 1 AS expected,
              COUNT(*) AS actual
       FROM commander_events
       GROUP BY aggregate_type, aggregate_id
     ) t
     WHERE expected <> actual`,
  );
  const hashChainIntact = hashChainResult !== '0';

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
    hashChainIntact,
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

  // ── Hash chain integrity ───────────────────────────────────────────────────
  // Check for sequence gaps per aggregate
  const aggregateSequences: Record<string, number[]> = {};
  for (const event of snapshot.events) {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    if (!aggregateSequences[key]) aggregateSequences[key] = [];
    aggregateSequences[key].push(event.sequence);
  }
  let hashChainIntact = true;
  for (const sequences of Object.values(aggregateSequences)) {
    sequences.sort((a, b) => a - b);
    for (let i = 1; i < sequences.length; i++) {
      if (sequences[i] !== sequences[i - 1] + 1) {
        hashChainIntact = false;
        break;
      }
    }
    if (!hashChainIntact) break;
  }

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
    hashChainIntact,
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
 * Generate the timestamp-based filename for the audit report.
 * Format: audit-{YYYY-MM-DD}.json
 */
function generateReportFilename(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `audit-${yyyy}-${mm}-${dd}.json`;
}

/**
 * Evaluate metrics and produce pass/fail status with failure reasons.
 */
function evaluate(
  metrics: AuditMetrics,
  isTestMode: boolean,
): {
  status: 'PASS' | 'FAIL';
  failures: string[];
  warnings: string[];
} {
  const failures: string[] = [];
  const warnings: string[] = [];

  // Critical: Hash chain broken
  if (!metrics.hashChainIntact) {
    failures.push(
      'CRITICAL: Event log hash-chain integrity check FAILED — sequence gaps detected in commander_events',
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
 */
function buildReport(
  source: string,
  dbUrlMasked: string,
  metrics: AuditMetrics,
  isTestMode: boolean,
): AuditReport {
  const { status, failures, warnings } = evaluate(metrics, isTestMode);
  const timestamp = new Date().toISOString();

  const reportData: Omit<AuditReport, '_sig' | '_ts'> = {
    timestamp,
    source,
    databaseUrlMasked: dbUrlMasked,
    thresholds: {
      dlqDepth: DLQ_DEPTH_THRESHOLD,
      workerStaleMs: WORKER_STALE_MS,
    },
    metrics,
    status,
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
  if (report.databaseUrlMasked) {
    console.log(`  Database:      ${report.databaseUrlMasked}`);
  }
  console.log(`  Status:        ${report.status === 'PASS' ? 'PASS' : 'FAIL'}`);
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
  console.log(`    Hash chain integrity:   ${m.hashChainIntact ? 'INTACT' : 'BROKEN'}`);
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
    console.log(`  Report file: docs/audits/${reportFilename}`);
  }
  console.log(`  Signature:   ${report._sig.slice(0, 16)}...`);
  console.log(border);
  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const dbUrl = process.env.DATABASE_URL;
  const isTestMode = flags.test || !dbUrl;

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
      console.error('');
      console.error('ERROR: Failed to collect audit metrics from InMemoryKernelRepository.');
      console.error(`  ${(err as Error).message}`);
      console.error('');
      process.exit(1);
    }
  } else {
    source = 'postgresql';
    dbUrlMasked = maskDbUrl(dbUrl!);
    try {
      metrics = collectMetricsFromPostgres(dbUrl!);
    } catch (err) {
      console.error('');
      console.error('ERROR: Failed to collect audit metrics from database.');
      console.error(`  ${(err as Error).message}`);
      console.error('');
      console.error('Tip: Use --test flag to run with InMemoryKernelRepository instead.');
      console.error('');
      process.exit(1);
    }
  }

  // ── Build and sign report ───────────────────────────────────────────────────
  const report = buildReport(source, dbUrlMasked, metrics, isTestMode);

  // ── Output ───────────────────────────────────────────────────────────────────
  if (flags.json) {
    // JSON output to stdout
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Write report to docs/audits/ and print human-readable summary
    const auditsDir = join(REPO_ROOT, 'docs', 'audits');
    mkdirSync(auditsDir, { recursive: true });

    const reportFilename = generateReportFilename();
    const reportPath = join(auditsDir, reportFilename);
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

    printSummary(report, reportFilename);

    if (report.status === 'FAIL') {
      console.error(`Audit FAILED — ${report.failures.length} critical issue(s) found.`);
      console.error(`Report written to: ${reportPath}`);
      process.exit(1);
    }

    console.log(`Audit PASSED — report written to: ${reportPath}`);
  }

  // ── Exit code ──────────────────────────────────────────────────────────────────
  process.exit(report.status === 'FAIL' ? 1 : 0);
}

main();
