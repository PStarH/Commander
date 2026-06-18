import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileChangeTracker, OutputTruncator } from '../src/runtime/fileChangeTracker';
import { OutputTruncator as OT } from '../src/runtime/outputTruncator';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fct-integ-'));
}

describe('FileChangeTracker + OutputTruncator integration', () => {
  let dir: string;
  let tracker: FileChangeTracker;
  let truncator: OT;

  beforeEach(() => {
    dir = makeTempDir();
    tracker = new FileChangeTracker(dir);
    truncator = new OT({ maxBytes: 1024, headLines: 5, tailLines: 5 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('truncates large tool output before recording the change', async () => {
    const filePath = path.join(dir, 'big-output.txt');
    const hugeOutput = Array.from({ length: 500 }, (_, i) => `output line ${i}`).join('\n');
    fs.writeFileSync(filePath, hugeOutput);

    const result = truncator.truncate(hugeOutput);
    assert.equal(result.truncated, true);
    assert.ok(result.elidedBytes > 0);

    await tracker.recordChange({
      runId: 'run-integ-1',
      agentId: 'agent-1',
      toolName: 'file_write',
      stepNumber: 1,
      operation: 'create',
      filePath,
      afterContent: result.content,
    });
    await tracker.flush();

    const records = tracker.query({ runId: 'run-integ-1' });
    assert.equal(records.length, 1);
    assert.equal(records[0].sizeBytes, Buffer.byteLength(result.content, 'utf-8'));
    assert.ok(records[0].sizeBytes < Buffer.byteLength(hugeOutput, 'utf-8'));
  });

  it('passes small output through unchanged and records full content', async () => {
    const filePath = path.join(dir, 'small.txt');
    const small = 'tiny content\n';
    fs.writeFileSync(filePath, small);

    const result = truncator.truncate(small);
    assert.equal(result.truncated, false);

    await tracker.recordChange({
      runId: 'run-integ-2',
      agentId: 'agent-1',
      toolName: 'file_write',
      stepNumber: 1,
      operation: 'create',
      filePath,
      afterContent: result.content,
    });
    await tracker.flush();

    const records = tracker.query({ runId: 'run-integ-2' });
    assert.equal(records[0].sizeBytes, Buffer.byteLength(small, 'utf-8'));
  });

  it('preserves restore snapshots across many sequential changes', async () => {
    const filePath = path.join(dir, 'evolving.txt');
    fs.writeFileSync(filePath, 'v1');

    for (let i = 2; i <= 5; i++) {
      const before = fs.readFileSync(filePath, 'utf-8');
      const after = `v${i}`;
      fs.writeFileSync(filePath, after);
      await tracker.recordChange({
        runId: 'run-integ-3',
        agentId: 'agent-1',
        toolName: 'file_edit',
        stepNumber: i - 1,
        operation: 'modify',
        filePath,
        beforeContent: before,
        afterContent: after,
      });
    }
    await tracker.flush();

    const records = tracker.getRunChanges('run-integ-3');
    assert.equal(records.length, 4);
    for (const r of records) {
      assert.ok(r.snapshotPath, 'every change should have a snapshot');
    }

    fs.writeFileSync(filePath, 'v5-modified');
    const first = records[0];
    const restore = tracker.restoreFromSnapshot(first.id);
    assert.equal(restore.restored, true);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'v1');
  });

  it('summarize covers all operations correctly with truncated outputs', async () => {
    const hugeOutput = 'x'.repeat(5000);

    for (let i = 0; i < 3; i++) {
      const filePath = path.join(dir, `f${i}.txt`);
      fs.writeFileSync(filePath, `initial ${i}`);
      const before = `initial ${i}`;
      const after = truncator.truncate(hugeOutput).content;
      fs.writeFileSync(filePath, after);

      await tracker.recordChange({
        runId: 'run-integ-4',
        agentId: 'agent-1',
        toolName: 'file_write',
        stepNumber: i + 1,
        operation: i === 0 ? 'create' : 'modify',
        filePath,
        beforeContent: before,
        afterContent: after,
      });
    }
    await tracker.flush();

    const summary = tracker.summarize('run-integ-4');
    assert.equal(summary.totalChanges, 3);
    assert.equal(summary.filesCreated, 1);
    assert.equal(summary.filesModified, 2);
    assert.equal(summary.uniquePaths.length, 3);
    assert.ok(summary.totalBytesAdded > 0);
  });
});
