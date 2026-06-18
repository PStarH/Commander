import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry';

describe('CompensationRegistry', () => {
  it('registers and retrieves pending actions', () => {
    const registry = new CompensationRegistry();
    expect(registry.getPendingCount()).toBe(0);

    registry.recordAction({
      actionId: 'a1',
      toolName: 'file_write',
      args: { path: '/tmp/test.txt' },
      description: 'write test file',
      tags: ['file'],
    });

    expect(registry.getPendingCount()).toBe(1);
  });

  it('compensates a single action via handler', async () => {
    const registry = new CompensationRegistry();
    let compensated = false;

    registry.register('file_write', async (action) => {
      compensated = true;
      expect(action.toolName).toBe('file_write');
      return { success: true };
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'file_write',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(true);
    expect(compensated).toBe(true);
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(1);
  });

  it('returns success for unknown actionId', async () => {
    const registry = new CompensationRegistry();
    const result = await registry.compensate('nonexistent');
    expect(result.success).toBe(true);
  });

  it('returns success when no handler registered', async () => {
    const registry = new CompensationRegistry();
    registry.recordAction({
      actionId: 'a1',
      toolName: 'unknown_tool',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(true);
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(1);
  });

  it('catches handler errors gracefully', async () => {
    const registry = new CompensationRegistry();
    registry.register('failing_tool', async () => {
      throw new Error('handler crashed');
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'failing_tool',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(registry.getPendingCount()).toBe(1); // still pending
  });

  it('compensates all actions in reverse order', async () => {
    const registry = new CompensationRegistry();
    const order: string[] = [];

    registry.register('tool', async (action) => {
      order.push(action.actionId);
      return { success: true };
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'tool',
      args: {},
      description: 'first',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a2',
      toolName: 'tool',
      args: {},
      description: 'second',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a3',
      toolName: 'tool',
      args: {},
      description: 'third',
      tags: [],
    });

    const result = await registry.compensateAll();
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(order).toEqual(['a3', 'a2', 'a1']); // LIFO
    expect(registry.getPendingCount()).toBe(0);
  });

  it('clears all state', () => {
    const registry = new CompensationRegistry();
    registry.recordAction({
      actionId: 'a1',
      toolName: 't',
      args: {},
      description: 'test',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a2',
      toolName: 't',
      args: {},
      description: 'test',
      tags: [],
    });

    expect(registry.getPendingCount()).toBe(2);
    registry.clear();
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(0);
  });

  it('compensateAll returns partial failure counts', async () => {
    const registry = new CompensationRegistry();
    let callCount = 0;

    registry.register('tool', async () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return { success: true };
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'tool',
      args: {},
      description: 'ok',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a2',
      toolName: 'tool',
      args: {},
      description: 'fail',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a3',
      toolName: 'tool',
      args: {},
      description: 'ok',
      tags: [],
    });

    const result = await registry.compensateAll();
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
  });
});

describe('CompensationRegistry — GAP-M2.1 snapshot-based rollback', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-snapshot-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const restoreFromSnapshotHandler = async (action: {
    actionId: string;
    args: Record<string, unknown>;
  }) => {
    const filePath = action.args.filePath ?? action.args.path;
    if (typeof filePath !== 'string') return { success: true };
    const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
    try {
      if (!fs.existsSync(snapshotPath)) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { success: true };
      }
      const original = fs.readFileSync(snapshotPath, 'utf-8');
      fs.writeFileSync(filePath, original, 'utf-8');
      fs.unlinkSync(snapshotPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  };

  const takeSnapshot = (filePath: string, actionId: string): void => {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.atr-snapshot.${actionId}`);
    }
  };

  it('file_write to a NEW file is removed on compensate', async () => {
    const registry = new CompensationRegistry();
    registry.register('file_write', restoreFromSnapshotHandler);
    const filePath = path.join(tmpDir, 'new.txt');
    expect(fs.existsSync(filePath)).toBe(false);
    const actionId = 'a-new';
    takeSnapshot(filePath, actionId);
    fs.writeFileSync(filePath, 'agent content');
    registry.recordAction({
      actionId,
      toolName: 'file_write',
      args: { path: filePath },
      description: 'write',
      tags: [],
    });
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await registry.compensate(actionId);
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('file_write to an EXISTING file is restored to original on compensate', async () => {
    const registry = new CompensationRegistry();
    registry.register('file_write', restoreFromSnapshotHandler);
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original content');
    const actionId = 'a-existing';
    takeSnapshot(filePath, actionId);
    fs.writeFileSync(filePath, 'agent overwrote');
    registry.recordAction({
      actionId,
      toolName: 'file_write',
      args: { path: filePath },
      description: 'overwrite',
      tags: [],
    });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('agent overwrote');

    const result = await registry.compensate(actionId);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original content');
    expect(fs.existsSync(`${filePath}.atr-snapshot.${actionId}`)).toBe(false);
  });

  it('compensateAll rolls back 3 file_writes in reverse order', async () => {
    const registry = new CompensationRegistry();
    registry.register('file_write', restoreFromSnapshotHandler);

    const files = [
      { name: 'f1.txt', original: 'orig1', overwritten: 'agent1' },
      { name: 'f2.txt', original: null, overwritten: 'agent2' },
      { name: 'f3.txt', original: 'orig3', overwritten: 'agent3' },
    ];

    for (const f of files) {
      const fp = path.join(tmpDir, f.name);
      if (f.original) fs.writeFileSync(fp, f.original);
    }
    for (const f of files) {
      const fp = path.join(tmpDir, f.name);
      const actionId = `act-${f.name}`;
      takeSnapshot(fp, actionId);
      fs.writeFileSync(fp, f.overwritten);
      registry.recordAction({
        actionId,
        toolName: 'file_write',
        args: { path: fp },
        description: f.name,
        tags: [],
      });
    }

    const result = await registry.compensateAll();
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);

    expect(fs.readFileSync(path.join(tmpDir, 'f1.txt'), 'utf-8')).toBe('orig1');
    expect(fs.existsSync(path.join(tmpDir, 'f2.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'f3.txt'), 'utf-8')).toBe('orig3');
  });

  it('compensateAll survives partial failure (1 of 3 handlers throws)', async () => {
    const registry = new CompensationRegistry();
    registry.register('file_write', restoreFromSnapshotHandler);
    const fp1 = path.join(tmpDir, 'a.txt');
    const fp2 = path.join(tmpDir, 'b.txt');
    const fp3 = path.join(tmpDir, 'c.txt');
    fs.writeFileSync(fp1, 'A');
    fs.writeFileSync(fp2, 'B');
    fs.writeFileSync(fp3, 'C');
    for (const [fp, id] of [
      [fp1, 'x1'],
      [fp2, 'x2'],
      [fp3, 'x3'],
    ] as const) {
      takeSnapshot(fp, id);
      fs.writeFileSync(fp, 'X');
      registry.recordAction({
        actionId: id,
        toolName: 'file_write',
        args: { path: fp },
        description: '',
        tags: [],
      });
    }
    const snapshotB = `${fp2}.atr-snapshot.x2`;
    fs.chmodSync(snapshotB, 0o000);
    const result = await registry.compensateAll();
    expect(result.succeeded + result.failed).toBe(3);
    expect(fs.readFileSync(fp1, 'utf-8')).toBe('A');
    expect(fs.readFileSync(fp3, 'utf-8')).toBe('C');
    fs.chmodSync(snapshotB, 0o600);
  });

  describe('assessReversibility', () => {
    it('returns fully_reversible for read-only tools', () => {
      const registry = new CompensationRegistry();
      expect(registry.assessReversibility('file_read')).toBe('fully_reversible');
      expect(registry.assessReversibility('web_search')).toBe('fully_reversible');
      expect(registry.assessReversibility('web_fetch')).toBe('fully_reversible');
      expect(registry.assessReversibility('memory_recall')).toBe('fully_reversible');
      expect(registry.assessReversibility('memory_list')).toBe('fully_reversible');
    });

    it('returns non_reversible for mutating tools', () => {
      const registry = new CompensationRegistry();
      expect(registry.assessReversibility('file_write')).toBe('non_reversible');
      expect(registry.assessReversibility('file_edit')).toBe('non_reversible');
      expect(registry.assessReversibility('shell_execute')).toBe('non_reversible');
      expect(registry.assessReversibility('python_execute')).toBe('non_reversible');
      expect(registry.assessReversibility('git_push')).toBe('non_reversible');
      expect(registry.assessReversibility('git_commit')).toBe('non_reversible');
    });

    it('returns partially_reversible for unknown tools', () => {
      const registry = new CompensationRegistry();
      expect(registry.assessReversibility('unknown_tool')).toBe('partially_reversible');
      expect(registry.assessReversibility('slack_send')).toBe('partially_reversible');
    });
  });
});
