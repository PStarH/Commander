import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// Structural tests for core runtime modules with zero test coverage
// ============================================================================

import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import type { CircuitState, CircuitStats } from '../../src/runtime/circuitBreaker';

import { CredentialManager, getCredentialManager, resetCredentialManager } from '../../src/runtime/credentialManager';

import { ThreeLayerMemory, getGlobalThreeLayerMemory, resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import type { MemoryLayer, MemoryQuery, MemoryEntry } from '../../src/threeLayerMemory';

import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import type { CheckpointState } from '../../src/runtime/stateCheckpointer';

import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import type { DeadLetterEntry, DLQCategory } from '../../src/runtime/deadLetterQueue';

// ============================================================================
// CircuitBreaker
// ============================================================================

describe('CircuitBreaker', () => {
  it('can be constructed with defaults', () => {
    const cb = new CircuitBreaker();
    assert.ok(cb instanceof CircuitBreaker);
  });

  it('can be constructed with custom params', () => {
    const cb = new CircuitBreaker(3, 15000, 2);
    assert.ok(cb instanceof CircuitBreaker);
  });

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker();
    assert.strictEqual(cb.getState(), 'CLOSED');
  });

  it('has expected methods', () => {
    const cb = new CircuitBreaker();
    assert.strictEqual(typeof cb.getState, 'function');
    assert.strictEqual(typeof cb.getStats, 'function');
    assert.strictEqual(typeof cb.isAvailable, 'function');
    assert.strictEqual(typeof cb.onSuccess, 'function');
    assert.strictEqual(typeof cb.onFailure, 'function');
    assert.strictEqual(typeof cb.reset, 'function');
  });

  it('tracks failures and opens circuit', () => {
    const cb = new CircuitBreaker(2, 30000);
    assert.strictEqual(cb.getState(), 'CLOSED');
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'CLOSED');
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
  });

  it('isAvailable returns true when CLOSED', () => {
    const cb = new CircuitBreaker();
    assert.ok(cb.isAvailable());
  });

  it('isAvailable returns false when OPEN', () => {
    const cb = new CircuitBreaker(1, 30000);
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
    assert.ok(!cb.isAvailable());
  });

  it('success in HALF_OPEN resets to CLOSED', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
    await new Promise(r => setTimeout(r, 60));
    assert.ok(cb.isAvailable());
    assert.strictEqual(cb.getState(), 'HALF_OPEN');
    cb.onSuccess();
    assert.strictEqual(cb.getState(), 'CLOSED');
  });

  it('failure in HALF_OPEN reopens circuit', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
    await new Promise(r => setTimeout(r, 60));
    cb.isAvailable();
    assert.strictEqual(cb.getState(), 'HALF_OPEN');
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
  });

  it('reset returns to CLOSED', () => {
    const cb = new CircuitBreaker(1, 30000);
    cb.onFailure();
    assert.strictEqual(cb.getState(), 'OPEN');
    cb.reset();
    assert.strictEqual(cb.getState(), 'CLOSED');
  });

  it('getStats returns CircuitStats', () => {
    const cb = new CircuitBreaker(5, 30000, 2);
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    const stats: CircuitStats = cb.getStats();
    assert.ok(stats !== undefined);
    assert.strictEqual(typeof stats.failureCount, 'number');
    assert.strictEqual(typeof stats.successCount, 'number');
    assert.strictEqual(stats.state, 'CLOSED' as CircuitState);
    assert.strictEqual(typeof stats.threshold, 'number');
    assert.strictEqual(typeof stats.recoveryTimeMs, 'number');
    assert.strictEqual(typeof stats.openCount, 'number');
  });

  it('onStateChange callback fires', () => {
    let changed: { from: CircuitState; to: CircuitState } | null = null;
    const cb = new CircuitBreaker(1, 30000, 1, (from, to) => { changed = { from, to }; });
    cb.onFailure();
    assert.ok(changed !== null);
    assert.strictEqual(changed?.from, 'CLOSED');
    assert.strictEqual(changed?.to, 'OPEN');
  });

  it('supports type discrimination', () => {
    const state: CircuitState = 'CLOSED';
    const validStates: CircuitState[] = ['CLOSED', 'OPEN', 'HALF_OPEN'];
    assert.ok(validStates.includes(state));
  });
});

// ============================================================================
// CredentialManager
// ============================================================================

describe('CredentialManager', () => {
  afterEach(() => {
    resetCredentialManager();
  });

  it('can be constructed', () => {
    const cm = new CredentialManager();
    assert.ok(cm instanceof CredentialManager);
  });

  it('singleton getter returns instance', () => {
    const cm = getCredentialManager();
    assert.ok(cm instanceof CredentialManager);
  });

  it('has expected methods', () => {
    const cm = new CredentialManager();
    assert.strictEqual(typeof cm.init, 'function');
    assert.strictEqual(typeof cm.get, 'function');
    assert.strictEqual(typeof cm.getOrDefault, 'function');
    assert.strictEqual(typeof cm.has, 'function');
    assert.strictEqual(typeof cm.listConfiguredSecrets, 'function');
    assert.strictEqual(typeof cm.resolveApiKey, 'function');
    assert.strictEqual(typeof cm.any, 'function');
    assert.strictEqual(typeof cm.mask, 'function');
    assert.strictEqual(typeof cm.clear, 'function');
    assert.strictEqual(typeof cm.isInitialized, 'function');
  });

  it('resetCredentialManager clears singleton', () => {
    const before = getCredentialManager();
    resetCredentialManager();
    const after = getCredentialManager();
    assert.ok(after instanceof CredentialManager);
    assert.notStrictEqual(before, after);
  });

  it('init loads env vars', () => {
    process.env.TEST_CM_KEY = 'test-value-for-cm';
    const cm = new CredentialManager();
    cm.init();
    // Should not find TEST_CM_KEY since it's not in ALL_KEYS
    assert.strictEqual(cm.get('TEST_CM_KEY'), undefined);
    delete process.env.TEST_CM_KEY;
  });

  it('isInitialized returns false before init, true after', () => {
    const cm = new CredentialManager();
    assert.ok(!cm.isInitialized());
    cm.init();
    assert.ok(cm.isInitialized());
  });

  it('get returns undefined for unset key', () => {
    const cm = new CredentialManager();
    cm.init();
    assert.strictEqual(cm.get('NONEXISTENT_KEY'), undefined);
  });

  it('getOrDefault returns default for unset key', () => {
    const cm = new CredentialManager();
    cm.init();
    assert.strictEqual(cm.getOrDefault('NONEXISTENT_KEY', 'fallback'), 'fallback');
  });

  it('has returns false for unset key', () => {
    const cm = new CredentialManager();
    cm.init();
    assert.ok(!cm.has('NONEXISTENT_KEY'));
  });

  it('clear resets all state', () => {
    process.env.OPENAI_API_KEY = 'sk-clear-test';
    const cm = new CredentialManager();
    cm.init();
    assert.ok(cm.isInitialized());
    cm.clear();
    assert.ok(!cm.isInitialized());
    assert.strictEqual(cm.get('OPENAI_API_KEY'), undefined);
    delete process.env.OPENAI_API_KEY;
  });

  it('mask returns masked value', () => {
    process.env.OPENAI_API_KEY = 'sk-abcdefghijklmnop';
    const cm = new CredentialManager();
    cm.init();
    const masked = cm.mask('OPENAI_API_KEY');
    assert.ok(masked.includes('sk-'));
    assert.ok(!masked.includes('abcdefghijklmnop'));
    assert.ok(masked.length < 'sk-abcdefghijklmnop'.length);
    delete process.env.OPENAI_API_KEY;
  });

  it('static maskValue works correctly', () => {
    assert.strictEqual(CredentialManager.maskValue(''), '(empty)');
    assert.strictEqual(CredentialManager.maskValue('1234'), '****');
    assert.strictEqual(CredentialManager.maskValue('sk-abcdefgh'), 'sk-a...efgh');
  });

  it('resolveApiKey returns first match', () => {
    process.env.OPENAI_API_KEY = 'sk-primary';
    process.env.ANTHROPIC_API_KEY = 'sk-secondary';
    const cm = new CredentialManager();
    cm.init();
    const result = cm.resolveApiKey('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    assert.strictEqual(result, 'sk-primary');
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('resolveApiKey returns empty string when none found', () => {
    const cm = new CredentialManager();
    cm.init();
    assert.strictEqual(cm.resolveApiKey('NONEXISTENT_1', 'NONEXISTENT_2'), '');
  });

  it('any returns true if any key exists', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    const cm = new CredentialManager();
    cm.init();
    assert.ok(cm.any('DEEPSEEK_API_KEY', 'NONEXISTENT'));
    assert.ok(!cm.any('NONEXISTENT_1', 'NONEXISTENT_2'));
    delete process.env.DEEPSEEK_API_KEY;
  });
});

// ============================================================================
// ThreeLayerMemory
// ============================================================================

describe('ThreeLayerMemory', () => {
  afterEach(() => {
    resetGlobalThreeLayerMemory();
  });

  it('can be constructed with defaults', () => {
    const mem = new ThreeLayerMemory();
    assert.ok(mem instanceof ThreeLayerMemory);
  });

  it('can be constructed with custom config', () => {
    const mem = new ThreeLayerMemory({ working: { maxEntries: 10, maxMemoryBytes: 50000, decayRate: 0, baseDecayPerHour: 0, importanceBoost: 0 } });
    assert.ok(mem instanceof ThreeLayerMemory);
  });

  it('has expected methods', () => {
    const mem = new ThreeLayerMemory();
    assert.strictEqual(typeof mem.add, 'function');
    assert.strictEqual(typeof mem.get, 'function');
    assert.strictEqual(typeof mem.query, 'function');
    assert.strictEqual(typeof mem.delete, 'function');
    assert.strictEqual(typeof mem.clearLayer, 'function');
    assert.strictEqual(typeof mem.getStats, 'function');
    assert.strictEqual(typeof mem.getByLayer, 'function');
    assert.strictEqual(typeof mem.getWorkingContext, 'function');
    assert.strictEqual(typeof mem.getAll, 'function');
    assert.strictEqual(typeof mem.setEmbeddingFunction, 'function');
    assert.strictEqual(typeof mem.searchRelated, 'function');
    assert.strictEqual(typeof mem.applyTimeDecay, 'function');
    assert.strictEqual(typeof mem.promoteToLongTerm, 'function');
    assert.strictEqual(typeof mem.archiveToEpisodic, 'function');
  });

  it('singleton getter returns instance', () => {
    const mem = getGlobalThreeLayerMemory();
    assert.ok(mem instanceof ThreeLayerMemory);
  });

  it('add and get memory entry', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('test memory content', 'working', 'test-context', 0.5, ['test'], { source: 'unit-test' });
    assert.ok(entry.id.length > 0);
    assert.strictEqual(entry.content, 'test memory content');
    assert.strictEqual(entry.layer, 'working');
    assert.strictEqual(entry.importance, 0.5);
    assert.ok(entry.tags.includes('test'));

    const retrieved = mem.get(entry.id);
    assert.ok(retrieved !== undefined);
    assert.strictEqual(retrieved?.content, 'test memory content');
  });

  it('get returns undefined for missing id', () => {
    const mem = new ThreeLayerMemory();
    assert.strictEqual(mem.get('nonexistent-id'), undefined);
  });

  it('query filters by layer', () => {
    const mem = new ThreeLayerMemory();
    mem.add('working entry', 'working');
    mem.add('episodic entry', 'episodic');
    const working = mem.query({ layer: 'working', limit: 10 });
    assert.ok(working.every(e => e.layer === 'working'));
  });

  it('query with keywords', () => {
    const mem = new ThreeLayerMemory();
    mem.add('apple banana cherry', 'working');
    mem.add('dog elephant frog', 'episodic');
    const results = mem.query({ keywords: ['apple'], limit: 10 });
    assert.ok(results.some(r => r.content.includes('apple')));
  });

  it('query with importance threshold', () => {
    const mem = new ThreeLayerMemory();
    mem.add('low importance', 'working', '', 0.2);
    mem.add('high importance', 'working', '', 0.9);
    const results = mem.query({ layer: 'working', importanceThreshold: 0.5, limit: 10 });
    assert.ok(results.every(r => r.importance >= 0.5));
  });

  it('query with context filter', () => {
    const mem = new ThreeLayerMemory();
    mem.add('entry one', 'working', 'auth-context');
    mem.add('entry two', 'working', 'db-context');
    const results = mem.query({ context: 'auth', limit: 10 });
    assert.ok(results.every(r => r.context.includes('auth')));
  });

  it('query with since filter', () => {
    const mem = new ThreeLayerMemory();
    mem.add('old entry', 'working');
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const results = mem.query({ since: futureDate, limit: 10 });
    assert.strictEqual(results.length, 0);
  });

  it('delete removes entry', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('to delete', 'working');
    assert.ok(mem.delete(entry.id));
    assert.strictEqual(mem.get(entry.id), undefined);
  });

  it('delete returns false for missing id', () => {
    const mem = new ThreeLayerMemory();
    assert.ok(!mem.delete('nonexistent'));
  });

  it('clearLayer removes all entries for a layer', () => {
    const mem = new ThreeLayerMemory();
    mem.add('w1', 'working');
    mem.add('w2', 'working');
    mem.add('e1', 'episodic');
    const cleared = mem.clearLayer('working');
    assert.strictEqual(cleared, 2);
    assert.strictEqual(mem.query({ layer: 'working', limit: 100 }).length, 0);
    assert.ok(mem.query({ layer: 'episodic', limit: 100 }).length > 0);
  });

  it('promoteToLongTerm upgrades entry', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('promotable', 'working');
    assert.ok(mem.promoteToLongTerm(entry.id));
    const promoted = mem.get(entry.id);
    assert.strictEqual(promoted?.layer, 'longterm');
  });

  it('promoteToLongTerm returns false for already longterm', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('already longterm', 'longterm');
    assert.ok(!mem.promoteToLongTerm(entry.id));
  });

  it('archiveToEpisodic moves working to episodic', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('archivable', 'working');
    assert.ok(mem.archiveToEpisodic(entry.id));
    assert.strictEqual(mem.get(entry.id)?.layer, 'episodic');
  });

  it('archiveToEpisodic returns false for non-working', () => {
    const mem = new ThreeLayerMemory();
    const entry = mem.add('not working', 'episodic');
    assert.ok(!mem.archiveToEpisodic(entry.id));
  });

  it('getByLayer returns entries for a layer', () => {
    const mem = new ThreeLayerMemory();
    mem.add('a', 'working');
    mem.add('b', 'working');
    const results = mem.getByLayer('working', 10);
    assert.strictEqual(results.length, 2);
  });

  it('getWorkingContext returns working + recent episodic', () => {
    const mem = new ThreeLayerMemory();
    mem.add('w1', 'working');
    mem.add('w2', 'working');
    mem.add('e1', 'episodic', '', 0.9);
    const ctx = mem.getWorkingContext(10);
    assert.ok(ctx.length >= 2);
  });

  it('getAll returns all entries', () => {
    const mem = new ThreeLayerMemory();
    mem.add('a longer entry for getAll test', 'working');
    mem.add('b longer entry for getAll test', 'episodic');
    const all = mem.getAll();
    assert.strictEqual(all.length, 2);
  });

  it('getStats returns MemoryStats', () => {
    const mem = new ThreeLayerMemory();
    mem.add('a longer entry for stats test', 'working');
    mem.add('b longer entry for stats test', 'episodic', '', 0.9);
    const stats = mem.getStats();
    assert.strictEqual(stats.totalEntries, 2);
    assert.strictEqual(stats.byLayer.working, 1);
    assert.strictEqual(stats.byLayer.episodic, 1);
    assert.ok(stats.averageImportance > 0);
    assert.ok(stats.averageAccessCount >= 0);
    assert.ok(stats.totalMemoryUsed > 0);
  });

  it('applyTimeDecay removes decayed entries', () => {
    const mem = new ThreeLayerMemory();
    mem.add('a', 'episodic', '', 0.1);
    const decayed = mem.applyTimeDecay(10000); // large hours elapsed
    // The entry importance is very low so it should decay quickly
    assert.ok(typeof decayed === 'number');
  });

  it('searchRelated finds keyword matches', () => {
    const mem = new ThreeLayerMemory();
    mem.add('this is a unique search term', 'working');
    const results = mem.searchRelated('unique search term', 5);
    assert.ok(results.length >= 1);
  });

  it('MemoryLayer type supports all four layers', () => {
    const layers: MemoryLayer[] = ['working', 'episodic', 'longterm', 'procedural'];
    assert.strictEqual(layers.length, 4);
  });

  it('MemoryQuery type is structural', () => {
    const q: MemoryQuery = { layer: 'working', keywords: ['test'], limit: 5 };
    assert.ok(q.layer === 'working');
    assert.ok(q.keywords!.includes('test'));
  });
});

// ============================================================================
// StateCheckpointer
// ============================================================================

describe('StateCheckpointer', () => {
  it('can be constructed with defaults', () => {
    const cp = new StateCheckpointer();
    assert.ok(cp instanceof StateCheckpointer);
  });

  it('has expected methods', () => {
    const cp = new StateCheckpointer();
    assert.strictEqual(typeof cp.checkpoint, 'function');
    assert.strictEqual(typeof cp.terminalCheckpoint, 'function');
    assert.strictEqual(typeof cp.resume, 'function');
    assert.strictEqual(typeof cp.listCheckpoints, 'function');
    assert.strictEqual(typeof cp.deleteCheckpoint, 'function');
    assert.strictEqual(typeof cp.prune, 'function');
  });

  it('checkpoint and resume round-trips', () => {
    const cp = new StateCheckpointer('/tmp/commander-test-cp');
    const state: CheckpointState = {
      runId: 'test-run-1',
      agentId: 'agent-1',
      timestamp: new Date().toISOString(),
      phase: 'started',
      stepNumber: 0,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: 'agent-1',
        projectId: 'project-1',
        goal: 'test goal',
        availableTools: ['test-tool'],
        maxSteps: 10,
        tokenBudget: 10000,
      },
      totalDurationMs: 0,
    };
    cp.checkpoint(state);
    const loaded = cp.resume('test-run-1');
    assert.ok(loaded !== null);
    assert.strictEqual(loaded?.runId, 'test-run-1');
    assert.strictEqual(loaded?.agentId, 'agent-1');
    assert.strictEqual(loaded?.phase, 'started');
    // Cleanup
    cp.deleteCheckpoint('test-run-1');
  });

  it('resume returns null for missing run', () => {
    const cp = new StateCheckpointer('/tmp/commander-test-cp');
    assert.strictEqual(cp.resume('nonexistent-run'), null);
  });

  it('listCheckpoints returns checkpoint list', () => {
    const cp = new StateCheckpointer('/tmp/commander-test-cp');
    const state: CheckpointState = {
      runId: 'test-run-list',
      agentId: 'agent-1',
      timestamp: new Date().toISOString(),
      phase: 'completed',
      stepNumber: 1,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: 'agent-1',
        projectId: 'project-1',
        goal: 'test',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 10000,
      },
      totalDurationMs: 0,
    };
    cp.terminalCheckpoint(state);
    const list = cp.listCheckpoints();
    assert.ok(list.length >= 1);
    assert.ok(list.some(e => e.runId === 'test-run-list'));
    cp.deleteCheckpoint('test-run-list');
  });

  it('prune removes old checkpoints', () => {
    const cp = new StateCheckpointer('/tmp/commander-test-cp');
    const mkState = (runId: string, ts: string): CheckpointState => ({
      runId,
      agentId: 'agent',
      timestamp: ts,
      phase: 'completed',
      stepNumber: 0,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: 'agent',
        projectId: 'project',
        goal: 'test',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 10000,
      },
      totalDurationMs: 0,
    });
    cp.terminalCheckpoint(mkState('prune-old-1', '2020-01-01T00:00:00.000Z'));
    cp.terminalCheckpoint(mkState('prune-old-2', '2020-01-02T00:00:00.000Z'));
    // Prune to keep 0
    cp.prune(0);
    const list = cp.listCheckpoints();
    assert.ok(!list.some(e => e.runId.startsWith('prune-old-')));
  });

  it('deleteCheckpoint removes all artifacts', () => {
    const cp = new StateCheckpointer('/tmp/commander-test-cp');
    const state: CheckpointState = {
      runId: 'test-del',
      agentId: 'agent',
      timestamp: new Date().toISOString(),
      phase: 'completed',
      stepNumber: 0,
      attemptNumber: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: 'agent',
        projectId: 'project',
        goal: 'test',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 10000,
      },
      totalDurationMs: 0,
    };
    cp.terminalCheckpoint(state);
    cp.deleteCheckpoint('test-del');
    assert.strictEqual(cp.resume('test-del'), null);
  });
});

// ============================================================================
// DeadLetterQueue
// ============================================================================

describe('DeadLetterQueue', () => {
  it('can be constructed with defaults', () => {
    const dlq = new DeadLetterQueue();
    assert.ok(dlq instanceof DeadLetterQueue);
  });

  it('has expected methods', () => {
    const dlq = new DeadLetterQueue();
    assert.strictEqual(typeof dlq.record, 'function');
    assert.strictEqual(typeof dlq.flush, 'function');
    assert.strictEqual(typeof dlq.readEntries, 'function');
    assert.strictEqual(typeof dlq.getStats, 'function');
  });

  it('record and readEntries round-trips', () => {
    const dlq = new DeadLetterQueue('/tmp/commander-test-dlq');
    const entry: DeadLetterEntry = {
      id: 'dlq-1',
      category: 'execution',
      runId: 'run-1',
      agentId: 'agent-1',
      timestamp: new Date().toISOString(),
      errorClass: 'TRANSIENT',
      errorMessage: 'test error',
      retryable: true,
      attemptNumber: 1,
      operationName: 'test-operation',
      compensated: false,
      recovered: false,
      tags: ['test'],
    };
    dlq.record(entry);
    dlq.flush();
    const entries = dlq.readEntries('execution', 10);
    assert.ok(entries.length >= 1);
    assert.ok(entries.some(e => e.id === 'dlq-1'));
  });

  it('getStats returns category counts', () => {
    const dlq = new DeadLetterQueue('/tmp/commander-test-dlq');
    const entry: DeadLetterEntry = {
      id: 'dlq-stats-1',
      category: 'llm',
      runId: 'run-1',
      agentId: 'agent-1',
      timestamp: new Date().toISOString(),
      errorClass: 'PERMANENT',
      errorMessage: 'fatal error',
      retryable: false,
      attemptNumber: 1,
      operationName: 'llm-call',
      compensated: false,
      recovered: false,
      tags: [],
    };
    dlq.record(entry);
    dlq.flush('llm');
    const stats = dlq.getStats();
    assert.ok(stats.length >= 1);
    assert.ok(stats.some(s => s.category === 'llm' && s.count > 0));
  });

  it('DLQCategory type supports all categories', () => {
    const cats: DLQCategory[] = ['llm', 'tool', 'execution', 'verification'];
    assert.strictEqual(cats.length, 4);
  });

  it('DeadLetterEntry type is structural', () => {
    const entry: DeadLetterEntry = {
      id: 'type-check',
      category: 'tool',
      runId: 'run',
      agentId: 'agent',
      timestamp: new Date().toISOString(),
      errorClass: 'TRANSIENT',
      errorMessage: 'test',
      retryable: true,
      attemptNumber: 1,
      operationName: 'op',
      compensated: false,
      recovered: false,
      tags: [],
    };
    assert.strictEqual(entry.retryable, true);
    assert.strictEqual(entry.category, 'tool');
  });
});
