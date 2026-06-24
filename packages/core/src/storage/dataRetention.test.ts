import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DataRetentionJanitor,
  DEFAULT_RETENTION_TABLE,
  resetDataRetentionJanitor,
} from './dataRetention';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeOldFile(rootDir: string, relPath: string, ageMs: number, content = 'x'): string {
  const abs = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(abs, mtime, mtime);
  return abs;
}

function writeFreshFile(rootDir: string, relPath: string, content = 'x'): string {
  return writeOldFile(rootDir, relPath, 1_000, content);
}

describe('DataRetentionJanitor', () => {
  let tmp: string;

  beforeEach(() => {
    resetDataRetentionJanitor();
    tmp = makeTmpDir('commander-dretention-');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      console.warn('[Catch]', err);
      /* tmp may have already been removed */
    }
  });

  // ── Default rules + happy path ────────────────────────────────────────

  it('uses the default retention table when none supplied', () => {
    expect(DEFAULT_RETENTION_TABLE.length).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION_TABLE.find((r) => r.name === 'audit-chain')?.policy).toBe('preserve');
  });

  it('deletes files past retentionMs', async () => {
    writeOldFile(tmp, 'traces/foo.ndjson', 365 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp });
    const r = await j.run();
    expect(r.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmp, 'traces/foo.ndjson'))).toBe(false);
  });

  it('does not delete files within retentionMs (no-op)', async () => {
    writeOldFile(tmp, 'traces/fresh.ndjson', 60 * 60 * 1000); // 1h old, far inside 90d
    const j = new DataRetentionJanitor({ rootDir: tmp });
    const r = await j.run();
    expect(r.deletedFiles).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'traces/fresh.ndjson'))).toBe(true);
  });

  // ── Protected stores ──────────────────────────────────────────────────

  it('never deletes audit-chain files', async () => {
    writeOldFile(tmp, 'audit-chain-0.ndjson', 999 * 24 * 60 * 60 * 1000);
    writeOldFile(tmp, 'audit-chain-3.ndjson', 999 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp, dryRun: false });
    const r = await j.run();
    expect(fs.existsSync(path.join(tmp, 'audit-chain-0.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'audit-chain-3.ndjson'))).toBe(true);
    expect(r.preservedFiles).toBeGreaterThanOrEqual(2);
    // audit-chain must not be tagged as deleted in result.byStore
    expect(r.byStore['audit-chain']?.deleted ?? 0).toBe(0);
  });

  it('overrides cannot sidestep audit-chain protection', async () => {
    writeOldFile(tmp, 'audit-chain-0.ndjson', 999 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({
      rootDir: tmp,
      overrides: {
        'audit-chain': { policy: 'delete', retentionMs: 60 * 1000 },
      },
    });
    const r = await j.run();
    expect(fs.existsSync(path.join(tmp, 'audit-chain-0.ndjson'))).toBe(true);
    expect(r.preservedFiles).toBeGreaterThanOrEqual(1);
  });

  it('never deletes conversations.db or its WAl/SHM/journal files', async () => {
    writeOldFile(tmp, 'conversations.db', 999 * 24 * 60 * 60 * 1000);
    writeOldFile(tmp, 'conversations.db-journal', 999 * 24 * 60 * 60 * 1000);
    writeOldFile(tmp, 'conversations.db-wal', 999 * 24 * 60 * 60 * 1000);
    writeOldFile(tmp, 'conversations.db-shm', 999 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp });
    await j.run();
    expect(fs.existsSync(path.join(tmp, 'conversations.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'conversations.db-journal'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'conversations.db-wal'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'conversations.db-shm'))).toBe(true);
  });

  // ── Per-store override happy path ────────────────────────────────────

  it('override changes retention for that store', async () => {
    writeOldFile(tmp, 'traces/foo.ndjson', 30 * 24 * 60 * 60 * 1000); // 30d old
    // Default would *keep* this (it's within 90d); override drops to 7d.
    const j = new DataRetentionJanitor({
      rootDir: tmp,
      overrides: { 'execution-traces': { retentionMs: 7 * 24 * 60 * 60 * 1000 } },
    });
    const r = await j.run();
    expect(r.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmp, 'traces/foo.ndjson'))).toBe(false);
  });

  // ── Tmp cbor ──────────────────────────────────────────────────────────

  it('*.tmp.cbor are deleted after 1 day', async () => {
    writeOldFile(tmp, 'ota-report.tmp.cbor', 2 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp });
    const r = await j.run();
    expect(r.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(!fs.existsSync(path.join(tmp, 'ota-report.tmp.cbor'))).toBe(true);
  });

  // ── Dry-run mode ──────────────────────────────────────────────────────

  it('dry-run reports what would be deleted without removing', async () => {
    const p = writeOldFile(tmp, 'traces/foo.ndjson', 365 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp, dryRun: true });
    const r = await j.run();
    expect(r.deletedFiles).toBe(1);
    expect(r.dryRun).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  // ── Concurrent invocations are no-ops ────────────────────────────────

  it('a second run() while another is in flight returns a no-op result without throwing', async () => {
    writeOldFile(tmp, 'traces/foo.ndjson', 365 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp });
    const first = j.run();
    // Fire a second run while first is still pending.
    const second = await j.run();
    await first;
    expect(second.deletedFiles).toBe(0);
    expect(second.scannedFiles).toBe(0);
  });

  // ── maxDeletesPerRun cap ─────────────────────────────────────────────

  it('respects maxDeletesPerRun', async () => {
    for (let i = 0; i < 5; i++) writeOldFile(tmp, `traces/x${i}.ndjson`, 365 * 24 * 60 * 60 * 1000);
    const j = new DataRetentionJanitor({ rootDir: tmp, maxDeletesPerRun: 2 });
    const r = await j.run();
    expect(r.deletedFiles).toBe(2);
    expect(r.skippedFiles).toBe(3);
    // Re-run with no cap; previously-skipped now deleted.
    const j2 = new DataRetentionJanitor({ rootDir: tmp });
    const r2 = await j2.run();
    expect(r2.deletedFiles).toBe(3);
  });

  // ── Schedule & stopSchedule ───────────────────────────────────────────

  it('schedule() returns a janitor that can be stopped', async () => {
    const j = new DataRetentionJanitor({ rootDir: tmp });
    j.schedule(60_000, false);
    expect(j.isScheduled()).toBe(true);
    j.stopSchedule();
    expect(j.isScheduled()).toBe(false);
  });
});
