/**
 * PostgreSQL PITR + streaming-replication failover drill — WP90-4.
 *
 * This test starts independent temporary Postgres clusters on ports 15433/15434
 * using the PostgreSQL 17 binaries installed at /Library/PostgreSQL/17/bin.
 * It does NOT touch the existing 15432 e2e instance used by WP90-3.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import { runKernelMigrations } from './migrations.js';

const PG_BIN = '/Library/PostgreSQL/17/bin';

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readLog(pgdata: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(join(pgdata, 'log'), 'utf-8');
  } catch {
    return '<no log>';
  }
}

async function initPostgres(pgdata: string, port: number, archiveDir: string, extraConfig?: string): Promise<void> {
  await runCommand(join(PG_BIN, 'initdb'), ['-D', pgdata, '--auth=trust', '--username=postgres']);
  await runCommand('mkdir', ['-p', archiveDir]);
  const config = [
    `port = ${port}`,
    `listen_addresses = '127.0.0.1'`,
    `wal_level = replica`,
    `archive_mode = on`,
    `archive_command = 'cp %p "${archiveDir}"/%f'`,
    `max_wal_size = 1GB`,
    `max_connections = 100`,
    ...(extraConfig ? [extraConfig] : []),
  ].join('\n');
  await runCommand('sh', ['-c', `cat > "${join(pgdata, 'postgresql.conf')}" <<'EOF'\n${config}\nEOF`]);
  // Allow local TCP trust for normal and replication connections so the drill
  // can connect via 127.0.0.1 and the standby can stream from the primary.
  await runCommand('sh', ['-c', `cat >> "${join(pgdata, 'pg_hba.conf')}" <<'EOF'\nhost all all 127.0.0.1/32 trust\nhost replication all 127.0.0.1/32 trust\nEOF`]);
  await runCommand(join(PG_BIN, 'pg_ctl'), ['-D', pgdata, '-l', join(pgdata, 'log'), 'start', '-w']);
}

async function startPostgres(pgdata: string): Promise<void> {
  // A restored PITR directory already contains a PG_VERSION; do not re-initdb it.
  if (!(await pathExists(join(pgdata, 'PG_VERSION')))) {
    throw new Error(`Cannot start ${pgdata}: it does not look like a PostgreSQL data directory`);
  }
  try {
    await runCommand(join(PG_BIN, 'pg_ctl'), ['-D', pgdata, '-l', join(pgdata, 'log'), 'start', '-w']);
  } catch (error) {
    console.error(`PostgreSQL log for ${pgdata}:\n${await readLog(pgdata)}`);
    throw error;
  }
}

async function stopPostgres(pgdata: string): Promise<void> {
  try {
    await runCommand(join(PG_BIN, 'pg_ctl'), ['-D', pgdata, 'stop', '-m', 'fast']);
  } catch { /* may already be stopped */ }
}

async function waitForPostgres(port: number, pgdata?: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await runCommand(join(PG_BIN, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-c', 'SELECT 1']);
      if (stdout.includes('1')) return;
    } catch (e) { lastError = e as Error; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pgdata) {
    console.error(`PostgreSQL log for ${pgdata}:\n${await readLog(pgdata)}`);
  }
  throw new Error(`Postgres on port ${port} did not become ready: ${lastError?.message}`);
}

async function createDatabase(port: number, name: string): Promise<void> {
  try {
    await runCommand(join(PG_BIN, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', name]);
  } catch (e) {
    if (!String(e).includes('already exists')) throw e;
  }
}

async function takeBaseBackup(port: number, backupDir: string): Promise<void> {
  await runCommand(join(PG_BIN, 'pg_basebackup'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-D', backupDir, '-Fp', '-Xs', '-P']);
}

async function restorePITR(backupDir: string, targetPgdata: string, archiveDir: string, targetTime: string): Promise<void> {
  await rm(targetPgdata, { recursive: true, force: true });
  await runCommand('cp', ['-r', backupDir, targetPgdata]);
  await runCommand('sh', ['-c', `cat > "${join(targetPgdata, 'recovery.signal')}" <<'EOF'\nEOF`]);
  const confPath = join(targetPgdata, 'postgresql.conf');
  const recoveryConf = [
    `recovery_target_time = '${targetTime}'`,
    'recovery_target_inclusive = true',
    `restore_command = 'cp "${archiveDir}/%f" %p'`,
  ].join('\n');
  await runCommand('sh', ['-c', `cat >> "${confPath}" <<'EOF'\n${recoveryConf}\nEOF`]);
}

async function queryLsn(port: number, query: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand(join(PG_BIN, 'psql'), [
      '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-tAc', query,
    ]);
    const lsn = stdout.trim();
    return lsn && lsn !== 'NULL' ? lsn : null;
  } catch {
    return null;
  }
}

async function waitForReplicationCatchup(primaryPort: number, standbyPort: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const primaryLsn = await queryLsn(primaryPort, 'SELECT pg_current_wal_lsn()');
      const standbyLsn = await queryLsn(standbyPort, 'SELECT pg_last_wal_replay_lsn()');
      if (primaryLsn && standbyLsn && standbyLsn >= primaryLsn) return;
    } catch (e) { lastError = e as Error; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Standby on port ${standbyPort} did not catch up: ${lastError?.message}`);
}

function createRunCommand(tenantId: string) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update('[]').digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'pitr-drill-policy',
    steps: [{ id: `${runId}-step-0`, kind: 'agent', maxAttempts: 3, priority: 0 }],
  };
}

describe('Postgres PITR and failover drill', { skip: !process.env.COMMANDER_ENABLE_PITR_DRILL }, () => {
  it('PITR restores kernel data to a target time', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'commander-pitr-'));
    const pgdata = join(baseDir, 'primary');
    const backupDir = join(baseDir, 'basebackup');
    const archiveDir = join(baseDir, 'archive');
    const port = 15433;
    const dbName = 'commander_pitr';
    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/${dbName}`;

    let pool: Pool | undefined;
    let restoredPool: Pool | undefined;

    try {
      await initPostgres(pgdata, port, archiveDir);
      await waitForPostgres(port, pgdata);
      await createDatabase(port, dbName);

      pool = new Pool({ connectionString: databaseUrl });
      await runKernelMigrations(pool);
      const repo = new PostgresKernelRepository(pool);

      const tenantId = `tenant-pitr-${Date.now()}`;
      const runA = createRunCommand(tenantId);
      await repo.createRun(runA, 'pitr-drill');
      assert.ok(await repo.getRun(runA.id, tenantId), 'runA must exist before backup');

      await takeBaseBackup(port, backupDir);

      // Ensure the WAL covering the backup is archived so PITR can recover to
      // a point after the backup's consistent point.
      await pool.query('SELECT pg_switch_wal()');
      await new Promise((r) => setTimeout(r, 1_000));

      // Use an explicit +00 timezone offset so PostgreSQL does not interpret
      // the target in the server's local timezone (e.g. Asia/Shanghai).
      const targetTime = new Date().toISOString().replace('T', ' ').replace('Z', '+00');

      const runB = createRunCommand(tenantId);
      await repo.createRun(runB, 'pitr-drill');
      assert.ok(await repo.getRun(runB.id, tenantId), 'runB must exist after backup');

      await pool.end();
      pool = undefined;

      await stopPostgres(pgdata);
      await restorePITR(backupDir, pgdata, archiveDir, targetTime);
      await startPostgres(pgdata);
      await waitForPostgres(port, pgdata);

      restoredPool = new Pool({ connectionString: databaseUrl });
      const restoredRepo = new PostgresKernelRepository(restoredPool);
      assert.ok(await restoredRepo.getRun(runA.id, tenantId), 'PITR must restore runA');
      assert.equal(await restoredRepo.getRun(runB.id, tenantId), null, 'PITR must not restore runB');
      await restoredPool.end();
      restoredPool = undefined;
    } finally {
      await pool?.end().catch(() => {});
      await restoredPool?.end().catch(() => {});
      await stopPostgres(pgdata).catch(() => {});
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('failover to streaming replica keeps kernel data available', async () => {
    const primaryData = await mkdtemp(join(tmpdir(), 'commander-failover-primary-'));
    const standbyData = await mkdtemp(join(tmpdir(), 'commander-failover-standby-'));
    const primaryArchive = join(tmpdir(), `commander-failover-archive-${randomUUID().slice(0, 8)}`);
    const primaryPort = 15433;
    const standbyPort = 15434;
    const dbName = 'commander_failover';
    const primaryUrl = `postgres://postgres@127.0.0.1:${primaryPort}/${dbName}`;
    const standbyUrl = `postgres://postgres@127.0.0.1:${standbyPort}/${dbName}`;

    let primaryPool: Pool | undefined;
    let standbyPoolBefore: Pool | undefined;
    let promotedPool: Pool | undefined;

    try {
      await initPostgres(primaryData, primaryPort, primaryArchive, 'max_wal_senders = 10\nmax_replication_slots = 10');
      await waitForPostgres(primaryPort, primaryData);
      await createDatabase(primaryPort, dbName);

      primaryPool = new Pool({ connectionString: primaryUrl, max: 2 });
      await primaryPool.query("CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator'");
      await primaryPool.query("SELECT pg_create_physical_replication_slot('failover_slot')");

      await runCommand(join(PG_BIN, 'pg_basebackup'), [
        '-h', '127.0.0.1', '-p', String(primaryPort), '-U', 'replicator', '-D', standbyData,
        '-Fp', '-Xs', '-P', '-R', '-S', 'failover_slot',
      ]);

      await runCommand('sh', ['-c', `cat >> "${join(standbyData, 'postgresql.conf')}" <<'EOF'\nport = ${standbyPort}\nhot_standby = on\nEOF`]);
      await runCommand(join(PG_BIN, 'pg_ctl'), ['-D', standbyData, '-l', join(standbyData, 'log'), 'start', '-w']);
      await waitForPostgres(standbyPort, standbyData);

      await runKernelMigrations(primaryPool);
      const primaryRepo = new PostgresKernelRepository(primaryPool);
      const tenantId = `tenant-failover-${Date.now()}`;
      const run = createRunCommand(tenantId);
      await primaryRepo.createRun(run, 'failover-drill');

      await waitForReplicationCatchup(primaryPort, standbyPort);

      standbyPoolBefore = new Pool({ connectionString: standbyUrl, max: 2 });
      const standbyRepoBefore = new PostgresKernelRepository(standbyPoolBefore);
      assert.ok(await standbyRepoBefore.getRun(run.id, tenantId), 'standby must replicate run before failover');
      await standbyPoolBefore.end();
      standbyPoolBefore = undefined;

      await primaryPool.end();
      primaryPool = undefined;

      await stopPostgres(primaryData);
      await runCommand(join(PG_BIN, 'pg_ctl'), ['-D', standbyData, 'promote', '-w']);
      await waitForPostgres(standbyPort, standbyData);

      promotedPool = new Pool({ connectionString: standbyUrl, max: 2 });
      const promotedRepo = new PostgresKernelRepository(promotedPool);
      assert.ok(await promotedRepo.getRun(run.id, tenantId), 'promoted standby must still serve run');
      await promotedPool.end();
      promotedPool = undefined;
    } finally {
      await primaryPool?.end().catch(() => {});
      await standbyPoolBefore?.end().catch(() => {});
      await promotedPool?.end().catch(() => {});
      await stopPostgres(primaryData).catch(() => {});
      await stopPostgres(standbyData).catch(() => {});
      await rm(primaryData, { recursive: true, force: true });
      await rm(standbyData, { recursive: true, force: true });
      await rm(primaryArchive, { recursive: true, force: true }).catch(() => {});
    }
  });
});
