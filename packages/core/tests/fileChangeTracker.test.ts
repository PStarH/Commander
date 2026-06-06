import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FileChangeTracker,
  computeUnifiedDiff,
  getFileChangeTracker,
  resetFileChangeTracker,
} from '../src/runtime/fileChangeTracker';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fct-test-'));
}

describe('FileChangeTracker', () => {
  let dir: string;
  let tracker: FileChangeTracker;

  beforeEach(() => {
    dir = makeTempDir();
    tracker = new FileChangeTracker(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('recordChange — basic', () => {
    it('records a modify operation and returns an ID', async () => {
      const id = await tracker.recordChange({
        runId: 'run-1',
        agentId: 'agent-1',
        toolName: 'file_write',
        stepNumber: 1,
        operation: 'modify',
        filePath: '/tmp/test.txt',
        beforeContent: 'old',
        afterContent: 'new',
      });
      assert.match(id, /^chg_/);
    });

    it('persists record to NDJSON', async () => {
      await tracker.recordChange({
        runId: 'run-1',
        agentId: 'agent-1',
        toolName: 'file_write',
        stepNumber: 1,
        operation: 'create',
        filePath: '/tmp/test.txt',
        afterContent: 'hello world',
      });
      await tracker.flush();
      const ndjsonPath = path.join(dir, 'changes.ndjson');
      assert.ok(fs.existsSync(ndjsonPath));
      const lines = fs.readFileSync(ndjsonPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.equal(record.runId, 'run-1');
      assert.equal(record.operation, 'create');
      assert.equal(record.path, '/tmp/test.txt');
    });

    it('computes SHA-256 content hash for non-delete operations', async () => {
      const id = await tracker.recordChange({
        runId: 'run-1',
        agentId: 'agent-1',
        toolName: 'file_write',
        stepNumber: 1,
        operation: 'create',
        filePath: '/tmp/test.txt',
        afterContent: 'hello',
      });
      await tracker.flush();
      const records = tracker.query({ runId: 'run-1' });
      assert.equal(records[0].id, id);
      assert.match(records[0].contentHash, /^[a-f0-9]{64}$/);
    });

    it('leaves contentHash empty for delete operations', async () => {
      await tracker.recordChange({
        runId: 'run-1',
        agentId: 'agent-1',
        toolName: 'shell_execute',
        stepNumber: 1,
        operation: 'delete',
        filePath: '/tmp/gone.txt',
        beforeContent: 'goodbye',
      });
      await tracker.flush();
      const records = tracker.query({ runId: 'run-1' });
      assert.equal(records[0].contentHash, '');
      assert.equal(records[0].sizeBytes, 0);
    });
  });

  describe('query — filtering', () => {
    beforeEach(async () => {
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/a.txt', afterContent: 'A',
      });
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a2', toolName: 'file_edit', stepNumber: 2,
        operation: 'modify', filePath: '/tmp/a.txt', beforeContent: 'A', afterContent: 'AB',
      });
      await tracker.recordChange({
        runId: 'run-2', agentId: 'a1', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/b.txt', afterContent: 'B',
      });
      await tracker.flush();
    });

    it('filters by runId', () => {
      const r1 = tracker.query({ runId: 'run-1' });
      assert.equal(r1.length, 2);
      assert.ok(r1.every(r => r.runId === 'run-1'));
    });

    it('filters by agentId', () => {
      const r = tracker.query({ agentId: 'a1' });
      assert.equal(r.length, 2);
      assert.ok(r.every(rec => rec.agentId === 'a1'));
    });

    it('filters by operation', () => {
      const r = tracker.query({ operation: 'create' });
      assert.equal(r.length, 2);
      assert.ok(r.every(rec => rec.operation === 'create'));
    });

    it('filters by path', () => {
      const r = tracker.query({ path: '/tmp/b.txt' });
      assert.equal(r.length, 1);
      assert.equal(r[0].path, '/tmp/b.txt');
    });

    it('combines multiple filters with AND', () => {
      const r = tracker.query({ runId: 'run-1', agentId: 'a1' });
      assert.equal(r.length, 1);
      assert.equal(r[0].agentId, 'a1');
      assert.equal(r[0].runId, 'run-1');
    });

    it('respects limit', () => {
      const r = tracker.query({ limit: 1 });
      assert.equal(r.length, 1);
    });
  });

  describe('summarize', () => {
    it('computes per-run summary', async () => {
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/a.txt', afterContent: 'A',
      });
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_write', stepNumber: 2,
        operation: 'create', filePath: '/tmp/b.txt', afterContent: 'BB',
      });
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_edit', stepNumber: 3,
        operation: 'modify', filePath: '/tmp/a.txt', beforeContent: 'A', afterContent: 'AA',
      });
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'shell_execute', stepNumber: 4,
        operation: 'delete', filePath: '/tmp/c.txt', beforeContent: 'CCC',
      });
      await tracker.flush();
      const summary = tracker.summarize('run-1');
      assert.equal(summary.totalChanges, 4);
      assert.equal(summary.filesCreated, 2);
      assert.equal(summary.filesModified, 1);
      assert.equal(summary.filesDeleted, 1);
      assert.equal(summary.filesRenamed, 0);
      assert.equal(summary.uniquePaths.length, 3);
      assert.ok(summary.firstChangeAt);
      assert.ok(summary.lastChangeAt);
    });
  });

  describe('snapshots and restore', () => {
    it('stores a snapshot for modify operations and can restore it', async () => {
      const targetFile = path.join(dir, 'restore-target.txt');
      const originalContent = 'original content';
      fs.writeFileSync(targetFile, originalContent);

      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_write', stepNumber: 1,
        operation: 'modify', filePath: targetFile, beforeContent: originalContent, afterContent: 'new content',
      });
      fs.writeFileSync(targetFile, 'new content');
      await tracker.flush();

      const records = tracker.query({ runId: 'run-1' });
      assert.ok(records[0].snapshotPath);
      const result = tracker.restoreFromSnapshot(records[0].id);
      assert.deepEqual(result, { restored: true, path: targetFile });
      assert.equal(fs.readFileSync(targetFile, 'utf-8'), originalContent);
    });

    it('returns record_not_found for unknown IDs', () => {
      const result = tracker.restoreFromSnapshot('chg_does_not_exist');
      assert.equal(result.restored, false);
      assert.equal(result.reason, 'record_not_found');
    });

    it('returns no_snapshot when record has no snapshot', async () => {
      await tracker.recordChange({
        runId: 'run-1', agentId: 'a1', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/no-snap.txt', afterContent: 'x',
      });
      await tracker.flush();
      const records = tracker.query({ runId: 'run-1' });
      const result = tracker.restoreFromSnapshot(records[0].id);
      assert.equal(result.restored, false);
      assert.equal(result.reason, 'no_snapshot');
    });
  });

  describe('tenant isolation', () => {
    it('isolates storage by tenantId', async () => {
      const tenantA = new FileChangeTracker(dir, 'tenant-A');
      const tenantB = new FileChangeTracker(dir, 'tenant-B');
      await tenantA.recordChange({
        runId: 'r', agentId: 'a', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/x.txt', afterContent: 'a',
      });
      await tenantB.recordChange({
        runId: 'r', agentId: 'a', toolName: 'file_write', stepNumber: 1,
        operation: 'create', filePath: '/tmp/x.txt', afterContent: 'b',
      });
      await tenantA.flush();
      await tenantB.flush();

      assert.ok(fs.existsSync(path.join(dir, 'tenant_tenant-A', 'changes.ndjson')));
      assert.ok(fs.existsSync(path.join(dir, 'tenant_tenant-B', 'changes.ndjson')));
      assert.equal(tenantA.query().length, 1);
      assert.equal(tenantB.query().length, 1);
    });
  });

  describe('file rotation', () => {
    it('rotates NDJSON when it exceeds max size', async () => {
      const tinyTracker = new FileChangeTracker(dir, undefined, {
        maxFileBytes: 200,
        maxRotatedFiles: 2,
      });
      for (let i = 0; i < 10; i++) {
        await tinyTracker.recordChange({
          runId: 'r', agentId: 'a', toolName: 'file_write', stepNumber: i,
          operation: 'create', filePath: `/tmp/f${i}.txt`, afterContent: 'x'.repeat(50),
        });
      }
      await tinyTracker.flush();
      const entries = fs.readdirSync(dir).filter(f => f.startsWith('changes.ndjson'));
      assert.ok(entries.length > 1, `Expected rotation, found: ${entries.join(', ')}`);
    });
  });

  describe('singleton', () => {
    it('getFileChangeTracker returns same instance after reset', () => {
      const a = getFileChangeTracker();
      resetFileChangeTracker();
      const b = getFileChangeTracker();
      assert.notEqual(a, b);
    });
  });
});

describe('computeUnifiedDiff', () => {
  it('returns null for identical strings', () => {
    assert.equal(computeUnifiedDiff('hello', 'hello'), null);
  });

  it('returns null for both empty', () => {
    assert.equal(computeUnifiedDiff('', ''), null);
  });

  it('marks added lines with +', () => {
    const d = computeUnifiedDiff('', 'new line');
    assert.ok(d);
    assert.ok(d!.includes('+ new line'));
  });

  it('marks removed lines with -', () => {
    const d = computeUnifiedDiff('old line', '');
    assert.ok(d);
    assert.ok(d!.includes('- old line'));
  });

  it('reports added and removed counts in summary', () => {
    const d = computeUnifiedDiff('a\nb\nc', 'a\nB\nc\nd');
    assert.ok(d);
    assert.ok(d!.includes('2 added, 1 removed'));
  });

  it('respects maxLines', () => {
    const before = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const after = Array.from({ length: 100 }, (_, i) => `CHANGED${i}`).join('\n');
    const d = computeUnifiedDiff(before, after, 3, 10);
    assert.ok(d);
    const lineCount = d!.split('\n').length;
    assert.ok(lineCount < 30, `Expected short diff, got ${lineCount} lines`);
  });
});
