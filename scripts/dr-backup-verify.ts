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
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyRunExists, verifyRunMissing, type DrilledRun } from '../packages/kernel/src/disasterRecovery.js';
import { createDrillRun } from '../packages/kernel/src/drillWorkload.js';

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

export function queryRunCommittedAt(dsn: DsnParts, runId: string, runPsqlFn: (dsn: DsnParts, sql: string) => string): Date {
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
  cellProcessesVerified?: boolean;
}): HonestyLevel {
  if (!opts.independentRestore) return 'DRAFT';
  if (!opts.sentinelVerified) return 'DRAFT';
  if (opts.cellProcessesVerified) return 'PROVEN';
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

function pgEnv(dsn: DsnParts): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: dsn.host,
    PGPORT: String(dsn.port),
    PGUSER: dsn.user,
    PGPASSWORD: dsn.password,
    PGDATABASE: dsn.database,
  };
}

function runPsql(dsn: DsnParts, sql: string): string {
  return execFileSync('psql', ['-t', '-A', '-c', sql], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: pgEnv(dsn),
  }).trim();
}

function tableExists(dsn: DsnParts, table: string): boolean {
  try {
    return runPsql(dsn, `SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = '${table}');`) === 't';
  } catch {
    return false;
  }
}

function countRows(dsn: DsnParts, table: string): number {
  try {
    return Number.parseInt(runPsql(dsn, `SELECT COUNT(*) FROM ${table};`), 10) || 0;
  } catch {
    return 0;
  }
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
  const backupPathArg =
    args[args.indexOf('--backup-path') + 1] ??
    process.env.COMMANDER_DR_BACKUP_DIR ??
    './dr-backups';
  const backupPath = resolve(backupPathArg);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sourceDsn = parseDatabaseUrl(dbUrl);
  const restorePort = process.env.COMMANDER_DR_RESTORE_PORT ?? '5433';
  const restoreDbUrl =
    process.env.RST_DATABASE_URL ?? buildRestoreDatabaseUrl(dbUrl, restorePort);
  const restoredDsn = parseDatabaseUrl(restoreDbUrl);
  const redactSecrets = [sourceDsn.password, restoredDsn.password, dbUrl, restoreDbUrl].filter(Boolean);

  const drillId = `drill_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const drillBackupPath = join(backupPath, drillId);
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
    report.overall = 'DRAFT';
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
        env: pgEnv(sourceDsn),
        stdio: 'pipe',
        timeout: 10 * 60 * 1000,
      });
      report.backup.durationMs = Date.now() - backupStart;
      backupCompletedAt = new Date();
      const stats = await stat(dumpFile).catch(() => null);
      if (stats) report.backup.sizeBytes = stats.size;
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

    console.log('[4/6] Restoring to independent target...');
    const restoreStart = Date.now();
    const dumpFile = join(drillBackupPath, 'dump.dump');

    assertDistinctRestoreTarget(sourceDsn, restoredDsn);
    try {
      execFileSync('createdb', [restoredDsn.database], {
        env: { ...pgEnv(restoredDsn), PGDATABASE: 'postgres' },
        stdio: 'pipe',
      });
    } catch {
      // database may already exist on retry
    }

    try {
      execFileSync('pg_restore', ['--no-owner', '--no-acl', dumpFile], {
        env: pgEnv(restoredDsn),
        stdio: 'pipe',
        timeout: 5 * 60 * 1000,
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
      report.restore.schemaValid =
        report.validation.runsTableExists &&
        report.validation.stepsTableExists &&
        report.validation.effects &&
        report.validation.interactions;

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
      failures.push('RPO not measured — missing cutoff or independent restore');
    }

    const completedAt = new Date();
    report.rto.actualMs = completedAt.getTime() - incidentStart.getTime();
    report.rto.passed = report.rto.actualMs <= RTO_TARGET_MS;
    if (!report.rto.passed) failures.push(`RTO exceeded: ${report.rto.actualMs}ms > ${RTO_TARGET_MS}ms`);

    const cellProcessesVerified = process.env.COMMANDER_DR_CELL_VERIFY === '1';
    report.honestyLevel = resolveHonestyLevel({
      independentRestore,
      sentinelVerified,
      cellProcessesVerified,
    });

    if (report.honestyLevel === 'DRAFT') {
      report.overall = 'DRAFT';
    } else {
      report.overall = failures.length === 0 ? 'PASS' : 'FAIL';
    }
    report.completedAt = completedAt.toISOString();

    console.log(`\n[DR Drill ${drillId}] ${report.overall} honesty=${report.honestyLevel}`);
    console.log(`  RPO: ${report.rpo.actualMs}ms mode=${report.rpo.mode} — ${report.rpo.passed ? 'PASS' : 'FAIL'}`);
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

function finish(report: DrillReport): void {
  const reportPath = join(report.backup.path, 'drill-report.json');
  mkdir(report.backup.path, { recursive: true })
    .then(() => writeFile(reportPath, JSON.stringify(report, null, 2)))
    .then(() => console.log(`\nReport saved to: ${reportPath}`))
    .catch(() => {})
    .finally(() => {
      if (report.overall === 'FAIL') process.exit(1);
      if (report.overall === 'DRAFT') process.exit(2);
    });
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
  } catch { /* ignore malformed DSN */ }
  return secrets.filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('DR drill failed:', sanitizeError(err, buildRedactSecrets()));
    process.exit(1);
  });
}
