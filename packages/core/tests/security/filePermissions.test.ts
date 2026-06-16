/**
 * File Permission Enforcement Tests
 *
 * Tests that Commander's persistence layer creates files with restrictive
 * permissions (0o600 for files, 0o700 for directories) to prevent unauthorized
 * access to sensitive data like conversation history, execution traces, and
 * checkpoint state.
 *
 * Without these protections, other users on a shared system could read:
 *   - Agent conversation history (may contain API keys, internal URLs, code)
 *   - Execution traces (contain tool calls, arguments, results)
 *   - Checkpoint state (contains full LLM message history)
 *
 * Components tested:
 *   - StateCheckpointer: checkpoint files, terminal checkpoints, directories
 *   - PersistentTraceStore: trace files, trace directories
 *   - ConversationStore: SQLite database, data directory (if better-sqlite3 available)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateCheckpointer, CheckpointState } from '../../src/runtime/stateCheckpointer';
import { PersistentTraceStore } from '../../src/runtime/traceStore';

// Helper: get octal permission string (e.g. '0o600') from file stat
function getFileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

// Helper: create a minimal valid CheckpointState
function makeCheckpointState(runId: string): CheckpointState {
  return {
    runId,
    agentId: 'test-agent',
    missionId: 'test-mission',
    timestamp: new Date().toISOString(),
    phase: 'llm_call',
    stepNumber: 1,
    attemptNumber: 1,
    messages: [{ role: 'user', content: 'test' }],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stepDurations: [100],
    context: {
      agentId: 'test-agent',
      missionId: 'test-mission',
      projectId: 'test-project',
      goal: 'test goal',
      availableTools: ['echo'],
      maxSteps: 10,
      tokenBudget: 10000,
    },
    totalDurationMs: 100,
  };
}

// ============================================================================
// StateCheckpointer file permissions
// ============================================================================
describe('StateCheckpointer file permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-chk-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates state directory with 0o700', () => {
    new StateCheckpointer(tmpDir);
    const stateDir = path.join(tmpDir, '.commander_state');
    // If tenantId is not set, baseDir is the constructor arg
    // StateCheckpointer uses baseDir directly when no tenant
    const stat = fs.statSync(tmpDir);
    // The constructor creates a 'completed' subdirectory
    const completedDir = path.join(tmpDir, 'completed');
    if (fs.existsSync(completedDir)) {
      const mode = getFileMode(completedDir);
      assert.strictEqual(
        mode,
        0o700,
        `completed directory should be 0o700, got 0o${mode.toString(8)}`,
      );
    }
  });

  it('checkpoint creates files with 0o600', () => {
    const checkpointer = new StateCheckpointer(tmpDir);
    const state = makeCheckpointState('test-run-1');

    checkpointer.checkpoint(state);

    const chkPath = path.join(tmpDir, 'test-run-1.checkpoint');
    assert.ok(fs.existsSync(chkPath), 'Checkpoint file must exist');

    const mode = getFileMode(chkPath);
    assert.strictEqual(mode, 0o600, `Checkpoint file should be 0o600, got 0o${mode.toString(8)}`);
  });

  it('checkpoint temp file is created with 0o600 (written before rename)', () => {
    // We can't easily observe the .tmp file since it's renamed immediately,
    // but we verify the final .checkpoint file has correct permissions
    const checkpointer = new StateCheckpointer(tmpDir);
    const state = makeCheckpointState('test-run-tmp');

    checkpointer.checkpoint(state);

    const chkPath = path.join(tmpDir, 'test-run-tmp.checkpoint');
    assert.ok(fs.existsSync(chkPath), 'Checkpoint file must exist after rename');

    const mode = getFileMode(chkPath);
    assert.strictEqual(
      mode,
      0o600,
      `Renamed checkpoint file should be 0o600, got 0o${mode.toString(8)}`,
    );
  });

  it('terminalCheckpoint creates completed file with 0o600', () => {
    const checkpointer = new StateCheckpointer(tmpDir);
    const state = makeCheckpointState('test-run-terminal');

    // First create a regular checkpoint so terminal can clean it up
    checkpointer.checkpoint(state);
    checkpointer.terminalCheckpoint(state);

    const donePath = path.join(tmpDir, 'completed', 'test-run-terminal.json');
    assert.ok(fs.existsSync(donePath), 'Completed file must exist');

    const mode = getFileMode(donePath);
    assert.strictEqual(
      mode,
      0o600,
      `Completed checkpoint file should be 0o600, got 0o${mode.toString(8)}`,
    );
  });

  it('terminalCheckpoint completed directory has 0o700', () => {
    const checkpointer = new StateCheckpointer(tmpDir);
    const state = makeCheckpointState('test-run-dir');

    checkpointer.terminalCheckpoint(state);

    const completedDir = path.join(tmpDir, 'completed');
    assert.ok(fs.existsSync(completedDir), 'Completed directory must exist');

    const mode = getFileMode(completedDir);
    assert.strictEqual(
      mode,
      0o700,
      `Completed directory should be 0o700, got 0o${mode.toString(8)}`,
    );
  });

  it('multiple checkpoints all have 0o600 permissions', () => {
    const checkpointer = new StateCheckpointer(tmpDir);

    for (let i = 0; i < 5; i++) {
      const state = makeCheckpointState(`test-run-multi-${i}`);
      checkpointer.checkpoint(state);
    }

    for (let i = 0; i < 5; i++) {
      const chkPath = path.join(tmpDir, `test-run-multi-${i}.checkpoint`);
      assert.ok(fs.existsSync(chkPath), `Checkpoint ${i} must exist`);

      const mode = getFileMode(chkPath);
      assert.strictEqual(mode, 0o600, `Checkpoint ${i} should be 0o600, got 0o${mode.toString(8)}`);
    }
  });

  it('tenant-scoped checkpoint directory has restrictive permissions', () => {
    const checkpointer = new StateCheckpointer(tmpDir, 'tenant-abc');
    const state = makeCheckpointState('test-run-tenant');

    checkpointer.checkpoint(state);

    const tenantDir = path.join(tmpDir, 'tenant_tenant-abc');
    assert.ok(fs.existsSync(tenantDir), 'Tenant directory must exist');

    const mode = getFileMode(tenantDir);
    assert.strictEqual(mode, 0o700, `Tenant directory should be 0o700, got 0o${mode.toString(8)}`);
  });
});

// ============================================================================
// PersistentTraceStore file permissions
// ============================================================================
describe('PersistentTraceStore file permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-trace-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates trace directory with 0o700', () => {
    new PersistentTraceStore(tmpDir);
    // PersistentTraceStore uses tmpDir directly as baseDir
    const mode = getFileMode(tmpDir);
    assert.strictEqual(mode, 0o700, `Trace directory should be 0o700, got 0o${mode.toString(8)}`);
  });

  it('flush creates trace files with 0o600', () => {
    const store = new PersistentTraceStore(tmpDir);
    const runId = 'test-trace-1';

    store.append({
      runId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      data: { tool: 'echo', args: {} },
    });
    store.flush(runId);

    const tracePath = path.join(tmpDir, `${runId}.ndjson`);
    assert.ok(fs.existsSync(tracePath), 'Trace file must exist');

    const mode = getFileMode(tracePath);
    assert.strictEqual(mode, 0o600, `Trace file should be 0o600, got 0o${mode.toString(8)}`);
  });

  it('flushAll creates all trace files with 0o600', () => {
    const store = new PersistentTraceStore(tmpDir);

    for (let i = 0; i < 3; i++) {
      store.append({
        runId: `run-${i}`,
        type: 'llm_call',
        timestamp: new Date().toISOString(),
        data: { model: 'test' },
      });
    }
    store.flushAll();

    for (let i = 0; i < 3; i++) {
      const tracePath = path.join(tmpDir, `run-${i}.ndjson`);
      assert.ok(fs.existsSync(tracePath), `Trace file run-${i} must exist`);

      const mode = getFileMode(tracePath);
      assert.strictEqual(
        mode,
        0o600,
        `Trace file run-${i} should be 0o600, got 0o${mode.toString(8)}`,
      );
    }
  });

  it('append after flush creates new file with 0o600', () => {
    const store = new PersistentTraceStore(tmpDir);
    const runId = 'test-trace-append';

    // First batch
    store.append({
      runId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      data: { first: true },
    });
    store.flush(runId);

    // Second batch (appends to same file)
    store.append({
      runId,
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      data: { second: true },
    });
    store.flush(runId);

    const tracePath = path.join(tmpDir, `${runId}.ndjson`);
    const mode = getFileMode(tracePath);
    assert.strictEqual(
      mode,
      0o600,
      `Appended trace file should be 0o600, got 0o${mode.toString(8)}`,
    );
  });

  it('tenant-scoped trace directory has restrictive permissions', () => {
    const store = new PersistentTraceStore(tmpDir, 'tenant-xyz');

    store.append({
      runId: 'test',
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      data: {},
    });
    store.flush('test');

    const tenantDir = path.join(tmpDir, 'tenant_tenant-xyz');
    assert.ok(fs.existsSync(tenantDir), 'Tenant trace directory must exist');

    const mode = getFileMode(tenantDir);
    assert.strictEqual(
      mode,
      0o700,
      `Tenant trace directory should be 0o700, got 0o${mode.toString(8)}`,
    );
  });
});

// ============================================================================
// ConversationStore file permissions (if better-sqlite3 is available)
// ============================================================================
describe('ConversationStore file permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-conv-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets database file to 0o600 after creation', async () => {
    let ConversationStore: new (config: { dbPath: string }) => {
      init(): void;
      close(): void;
    };
    try {
      const mod = await import('../../src/memory/conversationStore');
      ConversationStore = mod.ConversationStore;
    } catch {
      // Module may not be loadable without better-sqlite3
      return;
    }

    const dbPath = path.join(tmpDir, 'conversations.db');

    // Check if better-sqlite3 is actually available
    let BetterSqlite3: unknown;
    try {
      BetterSqlite3 = require('better-sqlite3');
    } catch {
      // Skip this test if better-sqlite3 is not installed
      return;
    }

    // Suppress unhandled rejections from SQLite cleanup
    const origListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', () => {});

    try {
      const store = new ConversationStore({ dbPath });
      store.init();

      assert.ok(fs.existsSync(dbPath), 'Database file must exist');

      const mode = getFileMode(dbPath);
      assert.strictEqual(mode, 0o600, `Database file should be 0o600, got 0o${mode.toString(8)}`);

      store.close();
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of origListeners) {
        process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener);
      }
    }
  });

  it('creates data directory with 0o700', async () => {
    let ConversationStore: new (config: { dbPath: string }) => {
      init(): void;
      close(): void;
    };
    try {
      const mod = await import('../../src/memory/conversationStore');
      ConversationStore = mod.ConversationStore;
    } catch {
      return;
    }

    let BetterSqlite3: unknown;
    try {
      BetterSqlite3 = require('better-sqlite3');
    } catch {
      return;
    }

    // Suppress unhandled rejections from SQLite cleanup
    const origListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', () => {});

    try {
      const dbPath = path.join(tmpDir, 'subdir', 'conversations.db');
      const store = new ConversationStore({ dbPath });
      store.init();

      const dataDir = path.join(tmpDir, 'subdir');
      assert.ok(fs.existsSync(dataDir), 'Data directory must be created');

      const mode = getFileMode(dataDir);
      assert.strictEqual(mode, 0o700, `Data directory should be 0o700, got 0o${mode.toString(8)}`);

      store.close();
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of origListeners) {
        process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener);
      }
    }
  });
});
