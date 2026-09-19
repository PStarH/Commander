/**
 * RCH-07 / IP-01 regression — tenant-aware singleton factories must key their
 * on-disk storage by the caller's verified tenant.
 *
 * Before the fix every tenant's IntentLog / ModelPerformanceStore /
 * DeadLetterQueue / FileChangeTracker resolved to one shared directory
 * (`.commander_intent`, `.commander_samples`, `.commander_dlq`,
 * `.commander_changes`): the in-memory instances were partitioned by
 * `createTenantAwareSingleton`, but the factories ignored the tenant, so reads
 * and writes crossed the tenant boundary on disk.
 *
 * The whole file runs inside a throwaway temp directory (no real user data) and
 * resets the singletons between cases.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

import { runWithTenant } from '../../src/runtime/tenantContext';
import { IntentLog, getIntentLog, resetIntentLog } from '../../src/runtime/intentLog';
import {
  ModelPerformanceStore,
  getModelPerformanceStore,
  resetModelPerformanceStore,
} from '../../src/runtime/modelPerformanceStore';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import {
  getDeadLetterQueue,
  resetDeadLetterQueue,
} from '../../src/runtime/deadLetterQueueSingleton';
import {
  FileChangeTracker,
  getFileChangeTracker,
  resetFileChangeTracker,
} from '../../src/runtime/fileChangeTracker';

const ORIGINAL_CWD = process.cwd();
let workDir: string;

/** Recursively collect every file with the given basename under `root`. */
function listFilesNamed(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) out.push(full);
    }
  };
  walk(root);
  return out;
}

function resetAllSingletons(): void {
  resetIntentLog();
  resetModelPerformanceStore();
  resetDeadLetterQueue();
  resetFileChangeTracker();
}

function makeTempDir(): string {
  // realpath: on macOS `/var` is a symlink to `/private/var`, and `process.cwd()`
  // reports the resolved path. Comparing against the unresolved mkdtemp path
  // would make every `startsWith(workDir)` assertion fail.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commander-tenant-partition-')));
}

before(() => {
  workDir = makeTempDir();
  process.chdir(workDir);
});

after(() => {
  resetAllSingletons();
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Drop cached instances, then start every case from an empty temp cwd so no
  // on-disk state leaks between cases.
  resetAllSingletons();
  fs.rmSync(workDir, { recursive: true, force: true });
  workDir = makeTempDir();
  process.chdir(workDir);
});

describe('tenant storage partitioning', () => {
  it('IntentLog: two tenants resolve to different base directories', () => {
    const a = getIntentLog('tenant-a');
    const b = getIntentLog('tenant-b');

    assert.notEqual(a.getBaseDir(), b.getBaseDir());
    assert.ok(a.getBaseDir().startsWith(workDir), `expected ${a.getBaseDir()} under ${workDir}`);
    assert.ok(b.getBaseDir().startsWith(workDir), `expected ${b.getBaseDir()} under ${workDir}`);
  });

  it('IntentLog: a write by tenant A is not observable by tenant B', async () => {
    const runId = 'run-intent-a';
    await getIntentLog('tenant-a').write({
      schemaVersion: 1,
      runId,
      agentId: 'agent-a',
      tenantId: 'tenant-a',
      capturedAt: new Date().toISOString(),
    });
    await getIntentLog('tenant-a').flush();

    assert.ok(getIntentLog('tenant-a').readIntent(runId), 'tenant A must read its own record');
    assert.equal(getIntentLog('tenant-b').readIntent(runId), null);
  });

  it('ModelPerformanceStore: two tenants resolve to different base directories', () => {
    const a = getModelPerformanceStore('tenant-a');
    const b = getModelPerformanceStore('tenant-b');

    assert.notEqual(a.getBaseDir(), b.getBaseDir());
    assert.ok(
      path.resolve(a.getBaseDir()).startsWith(workDir),
      `expected ${a.getBaseDir()} under ${workDir}`,
    );
    assert.ok(
      path.resolve(b.getBaseDir()).startsWith(workDir),
      `expected ${b.getBaseDir()} under ${workDir}`,
    );
  });

  it('ModelPerformanceStore: a write by tenant A is not observable by tenant B', () => {
    const a = getModelPerformanceStore('tenant-a');
    a.record({
      modelId: 'model-a',
      taskType: 'code',
      success: true,
      durationMs: 1000,
      tokensUsed: 5000,
      timestamp: Date.now(),
    });
    a.flush();

    assert.equal(getModelPerformanceStore('tenant-a').size, 1);
    assert.equal(getModelPerformanceStore('tenant-b').size, 0);
  });

  it('DeadLetterQueue: a write by tenant A is not observable by tenant B', async () => {
    const a = getDeadLetterQueue('tenant-a');
    const b = getDeadLetterQueue('tenant-b');

    a.enqueue({
      category: 'execution',
      runId: 'run-dlq-a',
      operationName: 'op-a',
      errorMessage: 'tenant A failure',
    });
    await a.flush('execution');

    const aEntries = await a.readEntries('execution');
    assert.equal(aEntries.length, 1);
    assert.equal(aEntries[0].operationName, 'op-a');

    const bEntries = await b.readEntries('execution');
    assert.equal(bEntries.length, 0, 'tenant B must not see tenant A dead letters');
  });

  it('DeadLetterQueue: two tenants persist to distinct on-disk files', async () => {
    const a = getDeadLetterQueue('tenant-a');
    const b = getDeadLetterQueue('tenant-b');

    a.enqueue({
      category: 'execution',
      runId: 'run-dlq-a',
      operationName: 'op-a',
      errorMessage: 'tenant A failure',
    });
    b.enqueue({
      category: 'execution',
      runId: 'run-dlq-b',
      operationName: 'op-b',
      errorMessage: 'tenant B failure',
    });
    await a.flush('execution');
    await b.flush('execution');

    const files = listFilesNamed(workDir, 'execution.ndjson');
    assert.equal(files.length, 2, `expected two tenant files, got ${files.join(', ')}`);
    const contents = files.map((f) => fs.readFileSync(f, 'utf-8'));
    assert.equal(
      contents.filter((c) => c.includes('op-a')).length,
      1,
      'tenant A entry must live in exactly one file',
    );
    assert.equal(
      contents.filter((c) => c.includes('op-b')).length,
      1,
      'tenant B entry must live in exactly one file',
    );
  });

  it('FileChangeTracker: two tenants resolve to different base directories', () => {
    const a = getFileChangeTracker('tenant-a');
    const b = getFileChangeTracker('tenant-b');

    assert.notEqual(a.getBaseDir(), b.getBaseDir());
    assert.ok(a.getBaseDir().startsWith(workDir), `expected ${a.getBaseDir()} under ${workDir}`);
    assert.ok(b.getBaseDir().startsWith(workDir), `expected ${b.getBaseDir()} under ${workDir}`);
  });

  it('FileChangeTracker: a write by tenant A is not observable by tenant B', async () => {
    const a = getFileChangeTracker('tenant-a');
    await a.recordChange({
      runId: 'run-changes-a',
      agentId: 'agent-a',
      toolName: 'file_write',
      stepNumber: 1,
      operation: 'create',
      filePath: path.join(workDir, 'a.txt'),
      beforeContent: '',
      afterContent: 'tenant A content',
    });
    await a.flush();

    const aRecords = await a.readAllRecordsAsync();
    assert.equal(aRecords.length, 1);
    assert.equal(aRecords[0].runId, 'run-changes-a');

    const bRecords = await getFileChangeTracker('tenant-b').readAllRecordsAsync();
    assert.equal(bRecords.length, 0, 'tenant B must not see tenant A file changes');
  });

  it('runWithTenant binds the async-context tenant for FileChangeTracker', () => {
    const a = runWithTenant('tenant-als-a', () => getFileChangeTracker());
    const b = runWithTenant('tenant-als-b', () => getFileChangeTracker());

    assert.notEqual(a.getBaseDir(), b.getBaseDir());
    assert.ok(a.getBaseDir().includes('tenant-als-a'));
    assert.ok(b.getBaseDir().includes('tenant-als-b'));
  });

  it('runWithTenant binds the async-context tenant for ModelPerformanceStore', () => {
    const a = runWithTenant('tenant-als-a', () => getModelPerformanceStore());
    const b = runWithTenant('tenant-als-b', () => getModelPerformanceStore());

    assert.notEqual(a.getBaseDir(), b.getBaseDir());
    assert.ok(a.getBaseDir().includes('tenant-als-a'));
    assert.ok(b.getBaseDir().includes('tenant-als-b'));
  });

  it('the implicit default tenant keeps the legacy single-tenant directories', () => {
    // No tenant context and no explicit tenant id => single-tenant layout.
    assert.equal(getIntentLog().getBaseDir(), path.join(workDir, '.commander_intent'));
    assert.equal(getFileChangeTracker().getBaseDir(), path.join(workDir, '.commander_changes'));
    assert.equal(getModelPerformanceStore().getBaseDir(), '.commander_samples');
  });

  it('explicit single-tenant construction still works', async () => {
    const intentDir = path.join(workDir, 'explicit-intent');
    const intentLog = new IntentLog(intentDir);
    assert.equal(intentLog.getBaseDir(), intentDir);
    await intentLog.write({
      schemaVersion: 1,
      runId: 'run-explicit',
      capturedAt: new Date().toISOString(),
    });
    await intentLog.flush();
    assert.ok(intentLog.readIntent('run-explicit'));

    const samplesDir = path.join(workDir, 'explicit-samples');
    const store = new ModelPerformanceStore({ baseDir: samplesDir, flushIntervalMs: 0 });
    assert.equal(store.getBaseDir(), samplesDir);
    store.record({
      modelId: 'explicit-model',
      taskType: 'code',
      success: true,
      durationMs: 1,
      tokensUsed: 1,
      timestamp: Date.now(),
    });
    store.flush();
    assert.equal(store.getAll().length, 1);
    store.dispose();

    const dlqDir = path.join(workDir, 'explicit-dlq');
    const dlq = new DeadLetterQueue(dlqDir);
    dlq.enqueue({
      category: 'execution',
      runId: 'run-explicit-dlq',
      operationName: 'op-explicit',
      errorMessage: 'explicit failure',
    });
    await dlq.flush('execution');
    assert.equal((await dlq.readEntries('execution')).length, 1);

    const changesDir = path.join(workDir, 'explicit-changes');
    const tracker = new FileChangeTracker(changesDir);
    assert.equal(tracker.getBaseDir(), changesDir);
    await tracker.recordChange({
      runId: 'run-explicit-changes',
      agentId: 'agent-explicit',
      toolName: 'file_write',
      stepNumber: 1,
      operation: 'create',
      filePath: path.join(workDir, 'explicit.txt'),
      beforeContent: '',
      afterContent: 'explicit content',
    });
    await tracker.flush();
    assert.equal((await tracker.readAllRecordsAsync()).length, 1);
  });
});
