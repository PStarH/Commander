/**
 * LogPersistence shutdown-drain regression.
 *
 * `flush()` commits at most 500 queued entries per call. `stop()` used to call
 * it exactly once and then close the database, so a backlog larger than one
 * batch was silently lost on shutdown while the process looked like it had
 * persisted everything.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { LogPersistence } from '../../src/observability/logPersistence';

const nodeRequire = createRequire(import.meta.url);

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'log-persistence-'));
  tempDirs.push(dir);
  return join(dir, 'app-logs.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('LogPersistence.stop drain', () => {
  it('drains more than one flush batch before closing the database', () => {
    const dbPath = tempDbPath();
    const lp = new LogPersistence(dbPath);
    lp.start();
    assert.equal(lp.getStats().active, true, 'SQLite persistence must be available for this test');

    const total = 501;
    for (let i = 0; i < total; i++) {
      lp.enqueue({
        timestamp: new Date().toISOString(),
        level: 'info',
        component: 'test',
        message: `entry-${i}`,
      });
    }
    assert.equal(lp.getStats().queueLength, total);

    lp.stop();

    const stats = lp.getStats();
    assert.equal(stats.queueLength, 0);
    assert.equal(stats.totalWritten, total);
    assert.equal(stats.totalDropped, 0);

    const Database = nodeRequire('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM app_logs').get() as { n: number };
      assert.equal(row.n, total);
    } finally {
      db.close();
    }
  });
});
