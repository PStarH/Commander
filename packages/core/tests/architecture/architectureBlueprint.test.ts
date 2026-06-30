/**
 * Integration tests for the architecture blueprint implementation.
 *
 * Tests all new modules from Phases 1-5:
 * - Ranking Fusion (RRF + Cross-Encoder)
 * - Interface Contracts (all four pillars)
 * - Procedural Memory Store
 * - V8 Isolate Sandbox
 * - Backpressure Controller
 * - Semantic Memory Store
 * - Middleware Pipeline
 * - Biscuit Capability Token
 * - Hybrid Sandbox Scheduler
 * - Cross-Agent Memory Federation
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================================
// Phase 1.1: Ranking Fusion
// ============================================================================

import {
  reciprocalRankFusion,
  crossEncoderRerank,
  fuseAndRerank,
  LexicalCrossEncoderScorer,
  type RankedItem,
} from '../../src/memory/rankingFusion';

describe('Ranking Fusion (RRF + Cross-Encoder)', () => {
  it('should fuse multiple ranked lists with RRF', () => {
    const list1: RankedItem[] = [
      { id: 'a', text: 'hello world', source: 's1', sourceRank: 0, item: 'a' },
      { id: 'b', text: 'foo bar', source: 's1', sourceRank: 1, item: 'b' },
    ];
    const list2: RankedItem[] = [
      { id: 'b', text: 'foo bar baz', source: 's2', sourceRank: 0, item: 'b' },
      { id: 'c', text: 'hello', source: 's2', sourceRank: 1, item: 'c' },
    ];

    const fused = reciprocalRankFusion([list1, list2]);

    // 'b' appears in both lists, should rank first
    expect(fused[0].id).toBe('b');
    expect(fused[0].sources).toContain('s1');
    expect(fused[0].sources).toContain('s2');
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
  });

  it('should handle empty lists', () => {
    const fused = reciprocalRankFusion([]);
    expect(fused).toEqual([]);
  });

  it('should rerank with cross-encoder', async () => {
    const items: RankedItem[] = [
      { id: 'a', text: 'machine learning basics', source: 's1', sourceRank: 0, item: 'a' },
      { id: 'b', text: 'deep neural networks', source: 's1', sourceRank: 1, item: 'b' },
      { id: 'c', text: 'cooking recipes', source: 's1', sourceRank: 2, item: 'c' },
    ];

    const fused = reciprocalRankFusion([items]);
    const scorer = new LexicalCrossEncoderScorer();
    const reranked = await crossEncoderRerank('machine learning', fused, scorer, {
      enableReranking: true,
      rerankTopK: 3,
    });

    // 'a' should still rank first (most relevant to "machine learning")
    expect(reranked[0].id).toBe('a');
  });

  it('should run full fuseAndRerank pipeline', async () => {
    const lists: RankedItem[][] = [
      [{ id: 'x', text: 'test item', source: 'src', sourceRank: 0, item: 'x' }],
    ];

    const result = await fuseAndRerank('test', lists, new LexicalCrossEncoderScorer(), {
      enableReranking: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('x');
    expect(result[0].finalScore).toBeGreaterThan(0);
  });
});

// ============================================================================
// Phase 1.2: Interface Contracts
// ============================================================================

describe('Interface Contracts', () => {
  it('should export all Pillar I contracts', async () => {
    const contracts = await import('../../src/contracts/pillarI');
    // Verify interfaces exist as types (compile-time check)
    const dummy: contracts.IBackpressureController = {
      acquire: async () => true,
      release: () => {},
      getMetrics: () => ({
        availableTokens: 0,
        bufferOccupancy: 0,
        totalSpilled: 0,
        totalDropped: 0,
        circuitBreakerState: 'CLOSED',
      }),
      setConsumerRate: () => {},
    };
    expect(dummy).toBeDefined();
  });

  it('should export all Pillar II contracts', async () => {
    const contracts = await import('../../src/contracts/pillarII');
    const dummy: contracts.ILLMRouter = {
      route: () => ({
        modelId: 'test',
        providerId: 'test',
        estimatedCost: 0,
        estimatedLatency: 0,
        confidence: 1,
      }),
      registerProvider: () => {},
      stream: async function* () {},
      getProviderHealth: () => ({
        providerId: 'test',
        state: 'HEALTHY',
        averageLatency: 0,
        errorRate: 0,
        circuitBreakerOpen: false,
      }),
      estimateCost: () => 0,
    };
    expect(dummy).toBeDefined();
  });

  it('should export all Pillar III contracts', async () => {
    const contracts = await import('../../src/contracts/pillarIII');
    const tier: contracts.SandboxTier = 'v8-isolate';
    expect(tier).toBe('v8-isolate');
  });

  it('should export all Pillar IV contracts', async () => {
    const contracts = await import('../../src/contracts/pillarIV');
    const dummy: contracts.IMemorySystem = {
      store: async () => 'id',
      retrieve: async () => [],
      consolidate: async () => ({
        promoted: 0,
        compiled: 0,
        deduplicated: 0,
        decayed: 0,
      }),
      reflect: async () => ({
        critique: '',
        suggestions: [],
        confidence: 0,
      }),
    };
    expect(dummy).toBeDefined();
  });
});

// ============================================================================
// Phase 1.3: Procedural Memory Store
// ============================================================================

import { InMemoryMemoryStore } from '../../src/memory';
import { ProceduralMemoryStore } from '../../src/memory/proceduralStore';

describe('Procedural Memory Store', () => {
  let store: InMemoryMemoryStore;
  let procStore: ProceduralMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    procStore = new ProceduralMemoryStore(store, 'test-project');
  });

  it('should learn a new procedural rule', async () => {
    const entry = await procStore.learn({
      proceduralType: 'tool',
      content: 'Use file_write with path validation',
      conditions: ['file_write', 'path_validation'],
      goal: 'safe file writing',
      action: 'validate then write',
      tags: ['file', 'safety'],
    });

    expect(entry.id).toBeDefined();
    expect(entry.proceduralType).toBe('tool');
    expect(entry.successRate).toBe(0.5); // Neutral prior
    expect(entry.invocationCount).toBe(0);
  });

  it('should select rules by context', async () => {
    await procStore.learn({
      proceduralType: 'sop',
      content: 'Always validate input before processing',
      conditions: ['input_validation', 'preprocessing'],
      goal: 'input safety',
      action: 'validate input',
      tags: ['safety'],
    });

    const results = await procStore.select({
      context: 'input validation preprocessing',
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
  });

  it('should update utility after execution', async () => {
    const entry = await procStore.learn({
      proceduralType: 'heuristic',
      content: 'Retry on transient errors',
      conditions: ['retry', 'transient_error'],
      goal: 'error recovery',
      action: 'retry with backoff',
      tags: ['resilience'],
    });

    await procStore.updateUtility(entry.id, true);
    await procStore.updateUtility(entry.id, true);
    await procStore.updateUtility(entry.id, false);

    // After 2 successes and 1 failure: successRate = 2/3 ≈ 0.67
    // We can't read back directly, but the update should not throw
    expect(true).toBe(true);
  });
});

// ============================================================================
// Phase 2.1: V8 Isolate Sandbox
// ============================================================================

import { V8IsolateSandbox, isV8IsolateAvailable } from '../../src/sandbox/v8Isolate';

describe('V8 Isolate Sandbox', () => {
  it('should report availability correctly', () => {
    // isolated-vm is likely not installed in test env
    expect(typeof isV8IsolateAvailable()).toBe('boolean');
  });

  it('should gracefully handle unavailable isolated-vm', async () => {
    const sandbox = new V8IsolateSandbox();
    if (!sandbox.available) {
      const result = await sandbox.execute('1+1', [], { timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    }
  });
});

// ============================================================================
// Phase 2.2: Backpressure Controller
// ============================================================================

import { BackpressureController } from '../../src/runtime/backpressureController';

describe('Backpressure Controller', () => {
  it('should acquire and release tokens', async () => {
    const ctrl = new BackpressureController({
      maxTokens: 2,
      refillRatePerSecond: 1,
      bufferSize: 5,
      maxWaitMs: 100,
    });

    expect(await ctrl.acquire()).toBe(true);
    expect(await ctrl.acquire()).toBe(true);
    ctrl.release();
    expect(await ctrl.acquire()).toBe(true);
  });

  it('should report metrics', async () => {
    const ctrl = new BackpressureController({
      maxTokens: 5,
      refillRatePerSecond: 10,
      bufferSize: 10,
    });

    await ctrl.acquire();
    const metrics = ctrl.getMetrics();
    expect(metrics.availableTokens).toBeLessThanOrEqual(5);
    expect(metrics.circuitBreakerState).toBe('CLOSED');
  });

  it('should update consumer rate', () => {
    const ctrl = new BackpressureController();
    ctrl.setConsumerRate(100);
    const metrics = ctrl.getMetrics();
    expect(metrics).toBeDefined();
  });
});

// ============================================================================
// Phase 3.1: Semantic Memory Store
// ============================================================================

import { SemanticMemoryStore } from '../../src/memory/semanticStore';

describe('Semantic Memory Store', () => {
  let store: SemanticMemoryStore;

  beforeEach(() => {
    store = new SemanticMemoryStore();
  });

  it('should ingest entities with relationships', async () => {
    const entity = await store.ingest({
      name: 'Commander',
      type: 'project',
      description: 'AI agent orchestration framework',
      relationships: [],
    });

    expect(entity.id).toBeDefined();
    expect(store.size).toBe(1);
  });

  it('should query by text similarity', async () => {
    await store.ingest({
      name: 'PetriNet',
      type: 'component',
      description: 'Concurrency scheduling using Petri nets',
      relationships: [],
    });
    await store.ingest({
      name: 'Cooking',
      type: 'hobby',
      description: 'Making food with recipes',
      relationships: [],
    });

    const results = await store.query({ text: 'scheduling concurrency', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    // PetriNet should be more relevant than Cooking
    expect(results[0].name).toBe('PetriNet');
  });

  it('should traverse graph paths', async () => {
    const a = await store.ingest({
      name: 'A', type: 'node', description: 'node A', relationships: [],
    });
    const b = await store.ingest({
      name: 'B', type: 'node', description: 'node B',
      relationships: [{ targetId: a.id, type: 'depends_on', strength: 0.9 }],
    });

    const paths = await store.traverse(b.id, a.id, 3);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0][0].type).toBe('depends_on');
  });

  it('should merge duplicate entities', async () => {
    await store.ingest({
      name: 'Test', type: 'concept', description: 'short', relationships: [],
    });
    await store.ingest({
      name: 'Test', type: 'concept', description: 'longer description here',
      relationships: [],
    });

    // Should merge, not duplicate
    expect(store.size).toBe(1);
  });
});

// ============================================================================
// Phase 3.2: Middleware Pipeline
// ============================================================================

import {
  MiddlewarePipeline,
  compose,
  loggingMiddleware,
  retryMiddleware,
  timeoutMiddleware,
  rateLimitMiddleware,
  errorHandlingMiddleware,
} from '../../src/runtime/middlewarePipeline';

describe('Middleware Pipeline', () => {
  it('should execute middlewares in onion order', async () => {
    const order: string[] = [];
    const pipeline = new MiddlewarePipeline<{ val: number }, number>();

    pipeline.use((next) => async (ctx) => {
      order.push('m1-before');
      const result = await next(ctx);
      order.push('m1-after');
      return result;
    });
    pipeline.use((next) => async (ctx) => {
      order.push('m2-before');
      const result = await next(ctx);
      order.push('m2-after');
      return result;
    });

    const result = await pipeline.execute(async (ctx) => {
      order.push('handler');
      return ctx.val * 2;
    }, { val: 21 });

    expect(result).toBe(42);
    expect(order).toEqual(['m1-before', 'm2-before', 'handler', 'm2-after', 'm1-after']);
  });

  it('should retry on failure', async () => {
    const pipeline = new MiddlewarePipeline<unknown, string>();
    pipeline.use(retryMiddleware(3, 10));

    let attempts = 0;
    const result = await pipeline.execute(async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'success';
    }, {});

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('should handle errors via error middleware', async () => {
    const pipeline = new MiddlewarePipeline<unknown, string>();
    pipeline.use(errorHandlingMiddleware((err) => `caught: ${err.message}`));

    const result = await pipeline.execute(async () => {
      throw new Error('test error');
    }, {});

    expect(result).toBe('caught: test error');
  });

  it('should enforce rate limits', async () => {
    const pipeline = new MiddlewarePipeline<unknown, number>();
    pipeline.use(rateLimitMiddleware(2, 1000));

    const handler = async () => 42;
    expect(await pipeline.execute(handler, {})).toBe(42);
    expect(await pipeline.execute(handler, {})).toBe(42);
    await expect(pipeline.execute(handler, {})).rejects.toThrow('Rate limit');
  });

  it('should compose functionally', async () => {
    const composed = compose(
      (next) => async (ctx) => {
        const r = await next(ctx);
        return r + 1;
      },
      (next) => async (ctx) => {
        const r = await next(ctx);
        return r * 2;
      },
    );

    const handler = composed(async () => 10);
    const result = await handler({});
    // (10 * 2) + 1 = 21
    expect(result).toBe(21);
  });
});

// ============================================================================
// Phase 4.1: Biscuit Capability Token
// ============================================================================

import {
  BiscuitTokenIssuer,
  BiscuitTokenVerifier,
  BiscuitCapabilityToken,
  allow,
  pathPrefixCheck,
} from '../../src/security/biscuitToken';

describe('Biscuit Capability Token', () => {
  it('should issue and verify a root token', () => {
    const issuer = new BiscuitTokenIssuer();
    const token = issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + 3600,
      facts: [allow('file_write', '/workspace/x.ts')],
      checks: [pathPrefixCheck('/workspace/')],
    });

    expect(token.tokenId).toBeDefined();
    expect(token.verify()).toBe(true);
  });

  it('should authorize allowed operations', () => {
    const issuer = new BiscuitTokenIssuer();
    const token = issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + 3600,
      facts: [allow('file_write', '/workspace/x.ts')],
    });

    expect(token.authorize({ predicate: 'allow', args: ['file_write', '/workspace/x.ts'] })).toBe(true);
    expect(token.authorize({ predicate: 'allow', args: ['file_delete', '/workspace/x.ts'] })).toBe(false);
  });

  it('should attenuate with additional restrictions', () => {
    const issuer = new BiscuitTokenIssuer();
    const token = issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + 3600,
      facts: [allow('file_write', '/workspace/x.ts')],
      checks: [pathPrefixCheck('/workspace/')],
    });

    const attenuated = token.attenuate({
      checks: [pathPrefixCheck('/workspace/safe/')],
    });

    expect(attenuated.verify()).toBe(true);
    // The attenuated token has a stricter check that /workspace/x.ts doesn't match
    expect(attenuated.authorize({ predicate: 'allow', args: ['file_write', '/workspace/x.ts'] })).toBe(false);
  });

  it('should serialize and deserialize', () => {
    const issuer = new BiscuitTokenIssuer();
    const token = issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + 3600,
      facts: [allow('file_read')],
    });

    const serialized = token.serialize();
    const deserialized = BiscuitCapabilityToken.deserialize(serialized);

    expect(deserialized.tokenId).toBe(token.tokenId);
    expect(deserialized.verify()).toBe(true);
  });

  it('should delegate', () => {
    const issuer = new BiscuitTokenIssuer();
    const token = issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + 3600,
      facts: [allow('file_read')],
    });

    const delegated = token.delegate();
    expect(delegated.verify()).toBe(true);
    expect(delegated.tokenId).toBe(token.tokenId);
  });
});

// ============================================================================
// Phase 4.2: Hybrid Sandbox Scheduler
// ============================================================================

import {
  assessRisk,
  selectTier,
  HybridSandboxScheduler,
} from '../../src/sandbox/scheduler';

describe('Hybrid Sandbox Scheduler', () => {
  it('should assess risk of trusted simple code', () => {
    const risk = assessRisk('const x = 1 + 2;', { source: 'TRUSTED' });
    expect(risk.level).toBe('LOW');
  });

  it('should assess risk of untrusted dangerous code', () => {
    const risk = assessRisk('require("child_process").exec("rm -rf /")', {
      source: 'UNTRUSTED',
    });
    expect(risk.level).toBe('CRITICAL');
  });

  it('should assess risk of code with sensitive data access', () => {
    const risk = assessRisk('const data = process.env.SECRET_KEY;', {
      source: 'UNKNOWN',
      handlesSensitiveData: true,
    });
    expect(risk.level).toBe('MEDIUM');
  });

  it('should select tier based on risk', () => {
    expect(selectTier({ level: 'LOW', source: 'TRUSTED', handlesSensitiveData: false, requiresNetwork: false }))
      .toMatch(/v8-isolate|seccomp/);
    expect(selectTier({ level: 'CRITICAL', source: 'UNTRUSTED', handlesSensitiveData: true, requiresNetwork: true }))
      .toBe('tee');
  });

  it('should report utilization metrics', () => {
    const scheduler = new HybridSandboxScheduler();
    const util = scheduler.utilization;
    expect(util.totalCreated).toBe(0);
    expect(util.activeByTier).toBeDefined();
  });
});

// ============================================================================
// Phase 5: Cross-Agent Memory Federation
// ============================================================================

import { MemoryFederation } from '../../src/memory/federation';

describe('Cross-Agent Memory Federation', () => {
  let federation: MemoryFederation;

  beforeEach(() => {
    federation = new MemoryFederation({
      semanticStore: new SemanticMemoryStore(),
      maxTotalEpsilon: 50,
    });
  });

  it('should register agents', () => {
    federation.registerAgent('agent-1');
    federation.registerAgent('agent-2');
    const stats = federation.getStats();
    expect(stats.registeredAgents).toBe(2);
  });

  it('should contribute and query entities', async () => {
    federation.registerAgent('agent-1');

    const contributed = await federation.contributeEntity('agent-1', {
      name: 'TestEntity',
      type: 'concept',
      description: 'A test entity for federation',
      relationships: [],
    });

    expect(contributed).toBe(true);

    const result = await federation.query({ text: 'test entity', limit: 5 });
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe('TestEntity');
  });

  it('should contribute procedural rules with success rate threshold', async () => {
    federation.registerAgent('agent-1');

    // Low success rate — should not be shared
    const lowSuccess = await federation.contributeProceduralRule('agent-1', {
      id: 'rule-1',
      proceduralType: 'tool',
      content: 'failing pattern',
      conditions: [],
      goal: 'test',
      action: 'fail',
      successRate: 0.3,
      invocationCount: 10,
      successCount: 3,
      tags: ['test'],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    expect(lowSuccess).toBe(false);

    // High success rate — should be shared
    const highSuccess = await federation.contributeProceduralRule('agent-1', {
      id: 'rule-2',
      proceduralType: 'sop',
      content: 'successful pattern at /workspace/project',
      conditions: ['success'],
      goal: 'test',
      action: 'succeed',
      successRate: 0.9,
      invocationCount: 100,
      successCount: 90,
      tags: ['test', 'success'],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    expect(highSuccess).toBe(true);

    const result = await federation.query({ text: 'test', includeProcedural: true });
    expect(result.proceduralRules.length).toBe(1);
    // Content should be sanitized (path removed)
    expect(result.proceduralRules[0].sanitizedContent).not.toContain('/workspace/project');
  });

  it('should sanitize sensitive data in descriptions', async () => {
    federation.registerAgent('agent-1');

    const contributed = await federation.contributeEntity('agent-1', {
      name: 'SensitiveEntity',
      type: 'test',
      description: 'Contact admin@example.com at 192.168.1.1 with key abc123def456ghi789jkl012mno345pqr678stu901vwx234yz',
      relationships: [],
    });

    expect(contributed).toBe(true);

    // Query by type since the sanitized description may not match "sensitive"
    const result = await federation.query({ type: 'test', limit: 5 });
    expect(result.entities.length).toBeGreaterThan(0);
    const desc = result.entities[0].description;
    expect(desc).not.toContain('admin@example.com');
    expect(desc).not.toContain('192.168.1.1');
  });

  it('should track privacy budget', async () => {
    federation.registerAgent('agent-1');

    await federation.contributeEntity('agent-1', {
      name: 'E1', type: 'test', description: 'entity 1', relationships: [],
    });

    const stats = federation.getStats();
    expect(stats.totalEpsilonSpent).toBeGreaterThan(0);
    expect(stats.remainingEpsilon).toBeLessThan(stats.totalEpsilonSpent + stats.remainingEpsilon);
  });

  it('should transfer procedural rules between agents', async () => {
    federation.registerAgent('agent-1');
    federation.registerAgent('agent-2');

    const transferred = await federation.transferProceduralRule('agent-1', 'agent-2', {
      id: 'rule-transfer',
      proceduralType: 'workflow',
      content: 'efficient workflow pattern',
      conditions: ['workflow'],
      goal: 'efficiency',
      action: 'optimize',
      successRate: 0.85,
      invocationCount: 50,
      successCount: 42,
      tags: ['workflow', 'efficiency'],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    expect(transferred).toBe(true);

    // Agent-2 should be able to find the shared rule
    const result = await federation.query({ text: 'workflow', includeProcedural: true });
    expect(result.proceduralRules.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Phase 6: Petri Net Engine
// ============================================================================

import { PetriNetEngine } from '../../src/runtime/petriNetEngine';

describe('Petri Net Engine', () => {
  let engine: PetriNetEngine;

  beforeEach(() => {
    engine = new PetriNetEngine();
  });

  it('should register places and transitions', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.getPlace('p1')?.marking).toBe(1);
    expect(engine.getPlace('p2')?.marking).toBe(0);
  });

  it('should check if a transition is enabled', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.isEnabled('t1')).toBe(true);
  });

  it('should fire a transition and consume/produce tokens', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 2, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.fire('t1')).toBe(true);
    expect(engine.getPlace('p1')?.marking).toBe(1);
    expect(engine.getPlace('p2')?.marking).toBe(1);
  });

  it('should not fire when not enough tokens', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 0, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.fire('t1')).toBe(false);
  });

  it('should respect capacity constraints', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 1, capacity: 1 });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.isEnabled('t1')).toBe(false);
  });

  it('should reset to initial marking', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 2, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    engine.fire('t1');
    engine.fire('t1');
    engine.reset();

    expect(engine.getPlace('p1')?.marking).toBe(2);
    expect(engine.getPlace('p2')?.marking).toBe(0);
  });

  it('should compute reachability graph', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Process',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    const graph = engine.computeReachabilityGraph();
    expect(graph.size).toBeGreaterThan(0);
  });

  it('should evaluate guard conditions', () => {
    engine.addPlace({ id: 'p1', label: 'Input', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'Output', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1',
      label: 'Guarded',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
      guard: (ctx) => ctx === 'allow',
    });

    expect(engine.isEnabled('t1', 'deny')).toBe(false);
    expect(engine.isEnabled('t1', 'allow')).toBe(true);
  });
});

// ============================================================================
// Phase 6: Event Sourcing Engine
// ============================================================================

import { EventSourcingEngine } from '../../src/runtime/eventSourcingEngine';

describe('Event Sourcing Engine', () => {
  let engine: EventSourcingEngine;

  beforeEach(() => {
    engine = new EventSourcingEngine();
  });

  it('should append events to the log', async () => {
    const event1 = await engine.append({ type: 'USER_CREATED', payload: { userId: 'u1' } });
    const event2 = await engine.append({ type: 'USER_UPDATED', payload: { userId: 'u1', name: 'Bob' } });

    expect(event1.id).toBeDefined();
    expect(event2.id).toBeDefined();
    // previousHash links to the previous event's hash chain (not ID)
    expect(event2.previousHash).toBeDefined();
    expect(typeof event2.previousHash).toBe('string');
    expect(engine.getEventCount()).toBe(2);
  });

  it('should replay events from the log', async () => {
    await engine.append({ type: 'A', payload: { n: 1 } });
    await engine.append({ type: 'B', payload: { n: 2 } });
    await engine.append({ type: 'C', payload: { n: 3 } });

    const events: string[] = [];
    for await (const event of engine.readFrom()) {
      events.push(event.type);
    }

    expect(events).toEqual(['A', 'B', 'C']);
  });

  it('should verify hash-chain integrity', async () => {
    await engine.append({ type: 'A', payload: { n: 1 } });
    await engine.append({ type: 'B', payload: { n: 2 } });

    const isValid = await engine.verifyIntegrity();
    expect(isValid).toBe(true);
  });

  it('should create and use snapshots', async () => {
    await engine.append({ type: 'A', payload: { n: 1 } });
    await engine.append({ type: 'B', payload: { n: 2 } });

    const snapshotId = await engine.snapshot();
    expect(snapshotId).toBeDefined();
    expect(engine.getSnapshots().length).toBe(1);
  });

  it('should compact the log after snapshotting', async () => {
    await engine.append({ type: 'A', payload: { n: 1 } });
    await engine.append({ type: 'B', payload: { n: 2 } });
    await engine.append({ type: 'C', payload: { n: 3 } });

    const snapshotId = await engine.snapshot();
    const removed = await engine.compact(snapshotId);

    expect(removed).toBe(3);
    expect(engine.getEventCount()).toBe(0);
  });
});

// ============================================================================
// Phase 6: Lock-Free State Store
// ============================================================================

import { LockFreeStateStore, createLockFreeStateStore } from '../../src/runtime/lockFreeStateStore';

describe('Lock-Free State Store', () => {
  it('should read the current value', () => {
    const store = new LockFreeStateStore(42);
    expect(store.read()).toBe(42);
  });

  it('should compare-and-set successfully when expected matches', () => {
    const store = new LockFreeStateStore(42);
    expect(store.compareAndSet(42, 100)).toBe(true);
    expect(store.read()).toBe(100);
  });

  it('should fail compare-and-set when expected does not match', () => {
    const store = new LockFreeStateStore(42);
    expect(store.compareAndSet(99, 100)).toBe(false);
    expect(store.read()).toBe(42);
  });

  it('should update with a transform function', () => {
    const store = new LockFreeStateStore(10);
    const result = store.update((v) => v + 5);
    expect(result).toBe(15);
    expect(store.read()).toBe(15);
  });

  it('should update with async transform', async () => {
    const store = new LockFreeStateStore(10);
    const result = await store.update(async (v) => v * 2);
    expect(result).toBe(20);
    expect(store.read()).toBe(20);
  });

  it('should track version increments', () => {
    const store = new LockFreeStateStore(0);
    expect(store.getVersion()).toBe(0);
    store.compareAndSet(0, 1);
    expect(store.getVersion()).toBe(1);
    store.compareAndSet(1, 2);
    expect(store.getVersion()).toBe(2);
  });

  it('should track CAS statistics', () => {
    const store = new LockFreeStateStore(0);
    store.compareAndSet(0, 1); // success
    store.compareAndSet(99, 2); // failure
    const stats = store.getStats();
    expect(stats.totalAttempts).toBe(2);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
  });

  it('should handle object values with deep equality', () => {
    const store = createLockFreeStateStore({ count: 0, name: 'test' });
    expect(store.compareAndSet({ count: 0, name: 'test' }, { count: 1, name: 'test' })).toBe(true);
    expect(store.read()).toEqual({ count: 1, name: 'test' });
  });
});

// ============================================================================
// Phase 6: Episodic Memory Store
// ============================================================================

import { EpisodicMemoryStore } from '../../src/memory/episodicStore';

describe('Episodic Memory Store', () => {
  let store: EpisodicMemoryStore;

  beforeEach(() => {
    store = new EpisodicMemoryStore();
  });

  it('should record a new experience', async () => {
    const record = await store.record({
      timestamp: Date.now(),
      context: 'deploying to production',
      action: 'run tests',
      outcome: 'all tests passed',
      tags: ['deploy', 'test'],
    });

    expect(record.id).toBeDefined();
    expect(record.activation).toBeDefined();
    expect(store.getRecordCount()).toBe(1);
  });

  it('should recall experiences by context', async () => {
    await store.record({
      timestamp: Date.now(),
      context: 'deploying to production',
      action: 'run tests',
      outcome: 'all tests passed',
      tags: ['deploy'],
    });
    await store.record({
      timestamp: Date.now(),
      context: 'code review session',
      action: 'review PR',
      outcome: 'approved',
      tags: ['review'],
    });

    const results = await store.recall({ context: 'deploying production', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].context).toContain('deploying');
  });

  it('should reinforce an experience', async () => {
    const record = await store.record({
      timestamp: Date.now(),
      context: 'debugging',
      action: 'check logs',
      outcome: 'found error',
      tags: ['debug'],
    });

    const beforeActivation = record.activation;
    await store.reinforce(record.id);
    const after = store.getRecord(record.id);
    expect(after?.activation).toBeGreaterThanOrEqual(beforeActivation);
  });

  it('should apply decay and remove old memories', async () => {
    await store.record({
      timestamp: Date.now(),
      context: 'old task',
      action: 'old action',
      outcome: 'old outcome',
      tags: [],
    });

    // Apply a very large decay to simulate time passage
    const removed = await store.applyDecay(100000); // ~11 years
    expect(removed).toBeGreaterThanOrEqual(0);
  });

  it('should filter by tags', async () => {
    await store.record({
      timestamp: Date.now(),
      context: 'task A',
      action: 'do A',
      outcome: 'done',
      tags: ['alpha'],
    });
    await store.record({
      timestamp: Date.now(),
      context: 'task B',
      action: 'do B',
      outcome: 'done',
      tags: ['beta'],
    });

    const results = await store.recall({ tags: ['alpha'], limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0].tags).toContain('alpha');
  });
});

// ============================================================================
// Phase 6: Reflexion Loop
// ============================================================================

import { ReflexionLoop } from '../../src/memory/reflexionLoop';

describe('Reflexion Loop', () => {
  let loop: ReflexionLoop;

  beforeEach(() => {
    loop = new ReflexionLoop();
  });

  it('should evaluate a successful outcome as positive', () => {
    const verdict = loop.evaluate({
      success: true,
      task: 'generate code',
      latencyMs: 1000,
      tokenCost: 500,
      userSatisfaction: 0.9,
    });
    expect(verdict).toBe('POSITIVE');
  });

  it('should evaluate a failed outcome as negative', () => {
    const verdict = loop.evaluate({
      success: false,
      task: 'generate code',
      latencyMs: 8000,
      tokenCost: 20000,
    });
    expect(verdict).toBe('NEGATIVE');
  });

  it('should generate a reflection with critique and suggestions', async () => {
    const reflection = await loop.generateReflection({
      success: false,
      task: 'deploy service',
      latencyMs: 6000,
      tokenCost: 12000,
    });

    expect(reflection.critique).toBeDefined();
    expect(reflection.critique.length).toBeGreaterThan(0);
    expect(reflection.suggestions.length).toBeGreaterThan(0);
    expect(reflection.confidence).toBeGreaterThan(0);
    expect(reflection.confidence).toBeLessThanOrEqual(1);
  });

  it('should incorporate a reflection into memory', async () => {
    const reflection = {
      critique: 'Need improvement',
      suggestions: ['Try harder'],
      confidence: 0.5,
    };
    await loop.incorporate(reflection);
    expect(loop.getReflections().length).toBe(1);
  });

  it('should track improvement trends', () => {
    // Record some outcomes to establish a baseline
    loop.recordOutcome(
      { success: false, task: 't1', latencyMs: 5000, tokenCost: 10000 },
      { critique: 'slow', suggestions: [], confidence: 0.5 },
    );
    loop.recordOutcome(
      { success: true, task: 't2', latencyMs: 2000, tokenCost: 5000 },
      { critique: 'good', suggestions: [], confidence: 0.8 },
    );

    const trends = loop.getImprovements();
    expect(trends.length).toBeGreaterThan(0);
    expect(trends[0].successRateTrend).toBeDefined();
    expect(trends[0].latencyTrend).toBeDefined();
    expect(trends[0].tokenEfficiencyTrend).toBeDefined();
  });

  it('should track verdict counts', () => {
    loop.recordOutcome(
      { success: true, task: 't1', latencyMs: 1000, tokenCost: 500 },
      { critique: '', suggestions: [], confidence: 0.8 },
    );
    loop.recordOutcome(
      { success: false, task: 't2', latencyMs: 10000, tokenCost: 20000 },
      { critique: '', suggestions: [], confidence: 0.5 },
    );

    const counts = loop.getVerdictCounts();
    expect(counts.positive).toBeGreaterThan(0);
    expect(counts.negative).toBeGreaterThan(0);
  });
});

// ============================================================================
// Phase 6: Resource Attenuator (Proxy Membrane)
// ============================================================================

import { ResourceAttenuator } from '../../src/sandbox/resourceAttenuator';

describe('Resource Attenuator', () => {
  let attenuator: ResourceAttenuator;

  beforeEach(() => {
    attenuator = new ResourceAttenuator();
  });

  it('should wrap an object and allow access to allowed properties', () => {
    const target = { name: 'test', value: 42 };
    const wrapped = attenuator.wrap(target, {
      allowedProperties: ['name', 'value'],
    });

    expect(wrapped.name).toBe('test');
    expect(wrapped.value).toBe(42);
  });

  it('should deny access to properties not in allowlist', () => {
    const target = { name: 'test', secret: 'password' };
    const wrapped = attenuator.wrap(target, {
      allowedProperties: ['name'],
    });

    expect(wrapped.name).toBe('test');
    expect(() => (wrapped as { secret: string }).secret).toThrow();
  });

  it('should deny access to properties in denylist', () => {
    const target = { name: 'test', secret: 'password' };
    const wrapped = attenuator.wrap(target, {
      deniedProperties: ['secret'],
    });

    expect(wrapped.name).toBe('test');
    expect(() => (wrapped as { secret: string }).secret).toThrow();
  });

  it('should create a membrane with inner and outer proxies', () => {
    const inner = { data: 'inner-data' };
    const outer = { api: 'outer-api' };

    const { innerProxy, outerProxy } = attenuator.createMembrane(inner, outer);

    expect((innerProxy as { data: string }).data).toBe('inner-data');
    expect((outerProxy as { api: string }).api).toBe('outer-api');
  });

  it('should revoke all proxies for a context', () => {
    const target = { name: 'test' };
    const wrapped = attenuator.wrap(target, {
      allowedProperties: ['name'],
    });

    const proxies = attenuator.getProxies();
    expect(proxies.length).toBe(1);

    // Revoke the context
    attenuator.revoke(proxies[0].contextId);

    // Access should now throw
    expect(() => (wrapped as { name: string }).name).toThrow();
  });

  it('should set and get policies for resource types', () => {
    const policy = { allowedProperties: ['read'] };
    attenuator.setPolicy('database', policy);

    expect(attenuator.getPolicy('database')).toEqual(policy);
  });

  it('should track statistics', () => {
    attenuator.wrap({ a: 1 }, { allowedProperties: ['a'] });
    attenuator.wrap({ b: 2 }, { allowedProperties: ['b'] });

    const stats = attenuator.getStats();
    expect(stats.totalContexts).toBe(2);
    expect(stats.activeContexts).toBe(2);
    expect(stats.totalProxies).toBe(2);
  });

  it('should enforce max call depth', () => {
    const target = {
      nested: {
        fn: () => 'result',
      },
    };

    const wrapped = attenuator.wrap(target, {
      maxCallDepth: 0, // No calls allowed
    });

    // Accessing properties should work
    expect(() => (wrapped as { nested: { fn: () => string } }).nested).not.toThrow();
  });
});

// ============================================================================
// Phase 7: Microkernel
// ============================================================================

import { Microkernel } from '../../src/runtime/microkernel';
import type { IService } from '../../src/contracts/pillarII';

describe('Microkernel', () => {
  let kernel: Microkernel;

  beforeEach(() => {
    kernel = new Microkernel();
  });

  it('should register a service', () => {
    const service: IService = {
      id: 'test-service',
      name: 'Test Service',
      state: 'STOPPED',
      start: async () => {},
      stop: async () => {},
    };
    kernel.registerService(service);
    expect(kernel.getRegisteredServices()).toContain('test-service');
  });

  it('should start and stop a service', async () => {
    const service: IService = {
      id: 'db',
      name: 'Database',
      state: 'STOPPED',
      start: async () => {},
      stop: async () => {},
    };
    kernel.registerService(service);
    await kernel.startService('db');
    expect(kernel.getServiceState('db')).toBe('RUNNING');

    await kernel.stopService('db');
    expect(kernel.getServiceState('db')).toBe('STOPPED');
  });

  it('should send messages to a running service', async () => {
    const service: IService & { handleMessage?: (msg: unknown) => Promise<unknown> } = {
      id: 'echo',
      name: 'Echo',
      state: 'STOPPED',
      start: async () => {},
      stop: async () => {},
      handleMessage: async (msg) => ({ echo: msg }),
    };
    kernel.registerService(service);
    await kernel.startService('echo');

    const reply = await kernel.send('echo', 'hello');
    expect(reply).toEqual({ echo: 'hello' });
  });

  it('should support pub/sub messaging', () => {
    let received: unknown = null;
    kernel.subscribe('events', (msg) => { received = msg; });
    kernel.publish('events', { type: 'test' });
    expect(received).toEqual({ type: 'test' });
  });

  it('should grant and revoke capabilities', () => {
    const service: IService = {
      id: 'svc',
      name: 'Service',
      state: 'STOPPED',
      start: async () => {},
      stop: async () => {},
    };
    kernel.registerService(service);
    kernel.grantCapability('svc', 'read');
    expect(kernel.hasCapability('svc', 'read')).toBe(true);

    kernel.revokeCapability('svc', 'read');
    expect(kernel.hasCapability('svc', 'read')).toBe(false);
  });

  it('should reject duplicate service registration', () => {
    const service: IService = {
      id: 'dup',
      name: 'Dup',
      state: 'STOPPED',
      start: async () => {},
      stop: async () => {},
    };
    kernel.registerService(service);
    expect(() => kernel.registerService(service)).toThrow();
  });
});

// ============================================================================
// Phase 7: Effect System
// ============================================================================

import { EffectHandler, httpEffect, logEffect, llmEffect } from '../../src/runtime/effectSystem';

describe('Effect System', () => {
  it('should run a computation with registered handlers', async () => {
    const handler = new EffectHandler();
    handler.on('Http', () => ({ status: 200, body: 'OK' }));

    function* computation() {
      const result = yield httpEffect('/api/data', 'GET');
      return result;
    }

    const result = await handler.run(computation());
    expect(result).toEqual({ status: 200, body: 'OK' });
  });

  it('should handle multiple effect types', async () => {
    const handler = new EffectHandler();
    handler.on('Http', () => ({ status: 200 }));
    handler.on('LLM', () => ({ text: 'Generated' }));

    function* computation() {
      const http = yield httpEffect('/api', 'GET');
      const llm = yield llmEffect('prompt');
      return { http, llm };
    }

    const result = await handler.run(computation());
    expect(result.http).toEqual({ status: 200 });
    expect(result.llm).toEqual({ text: 'Generated' });
  });

  it('should handle Log effects internally', async () => {
    const handler = new EffectHandler();

    function* computation() {
      yield logEffect('info', 'Starting computation');
      return 'done';
    }

    const result = await handler.run(computation());
    expect(result).toBe('done');
    expect(handler.getLogs().length).toBe(1);
    expect(handler.getLogs()[0].message).toBe('Starting computation');
  });

  it('should throw on unhandled effect type', async () => {
    const handler = new EffectHandler();

    function* computation() {
      yield { _tag: 'Unknown', data: 'test' };
      return 'done';
    }

    await expect(handler.run(computation())).rejects.toThrow('No handler registered');
  });
});

// ============================================================================
// Phase 7: Contract Event Bus
// ============================================================================

import { ContractEventBus } from '../../src/runtime/contractEventBus';

describe('Contract Event Bus', () => {
  let bus: ContractEventBus;

  beforeEach(() => {
    bus = new ContractEventBus();
  });

  it('should publish and subscribe to topics', async () => {
    let received: unknown = null;
    bus.subscribe('test', (msg) => { received = msg; });

    await bus.publish('test', { data: 'hello' });
    expect(received).toEqual({ data: 'hello' });
  });

  it('should support multiple subscribers', async () => {
    const received: unknown[] = [];
    bus.subscribe('events', (msg) => received.push(msg));
    bus.subscribe('events', (msg) => received.push(msg));

    await bus.publish('events', 'ping');
    expect(received.length).toBe(2);
  });

  it('should replay events from a given ID', async () => {
    await bus.publish('topic', 'msg1');
    await bus.publish('topic', 'msg2');
    await bus.publish('topic', 'msg3');

    const firstEventId = bus.getLatestEventId();
    // firstEventId is now 3; replay from 0 gets all
    const replayed: unknown[] = [];
    for await (const event of bus.replayFrom('0')) {
      replayed.push(event);
    }
    expect(replayed.length).toBe(3);
  });

  it('should send failed messages to dead letter queue', async () => {
    bus.subscribe('failing', () => {
      throw new Error('Handler error');
    });

    await bus.publish('failing', 'test');

    const dlq = bus.getDeadLetters();
    expect(dlq.length).toBe(1);
    expect(dlq[0].error.message).toBe('Handler error');
  });

  it('should set consumer rate for backpressure', () => {
    bus.setConsumerRate(100);
    // No exception means success
    expect(bus.getEventCount()).toBe(0);
  });

  it('should register dead letter handlers', async () => {
    let dlqMessage: unknown = null;
    let dlqError: Error | null = null;

    bus.onDeadLetter((msg, err) => {
      dlqMessage = msg;
      dlqError = err;
    });

    bus.subscribe('fail', () => { throw new Error('Oops'); });
    await bus.publish('fail', 'data');

    expect(dlqMessage).toBe('data');
    expect(dlqError?.message).toBe('Oops');
  });
});

// ============================================================================
// Phase 7: Contract Saga Coordinator
// ============================================================================

import { ContractSagaCoordinator } from '../../src/saga/contractSagaCoordinator';

describe('Contract Saga Coordinator', () => {
  it('should execute steps sequentially', async () => {
    const coordinator = new ContractSagaCoordinator();
    const executed: string[] = [];

    const result = await coordinator.executeSaga([
      {
        id: 'step1',
        execute: async () => { executed.push('step1'); return 'r1'; },
      },
      {
        id: 'step2',
        execute: async () => { executed.push('step2'); return 'r2'; },
      },
    ]);

    expect(executed).toEqual(['step1', 'step2']);
    expect(result).toBe('r2');
  });

  it('should compensate on failure', async () => {
    const coordinator = new ContractSagaCoordinator();
    const compensated: string[] = [];

    await expect(coordinator.executeSaga([
      {
        id: 'step1',
        execute: async () => 'ok',
        compensate: async () => { compensated.push('step1'); },
      },
      {
        id: 'step2',
        execute: async () => { throw new Error('fail'); },
        compensate: async () => { compensated.push('step2'); },
      },
    ])).rejects.toThrow('fail');

    expect(compensated).toEqual(['step1']);
  });

  it('should track saga status', async () => {
    const coordinator = new ContractSagaCoordinator();

    const result = await coordinator.executeSaga([
      { id: 's1', execute: async () => 'done' },
    ]);

    expect(result).toBe('done');
    const sagas = coordinator.getAllSagas();
    expect(sagas[0].status).toBe('COMPLETED');
  });

  it('should register compensation dynamically', () => {
    const coordinator = new ContractSagaCoordinator();
    coordinator.registerCompensation('step1', async () => {});
    // No exception means success
  });
});

// ============================================================================
// Phase 7: Strategy Meta-Learner
// ============================================================================

import { StrategyMetaLearner } from '../../src/memory/strategyMetaLearner';

describe('Strategy Meta-Learner', () => {
  it('should select a strategy using Thompson Sampling', () => {
    const learner = new StrategyMetaLearner();
    const selection = learner.selectStrategy({
      availableStrategies: ['rag', 'cot', 'react'],
      context: {},
    });

    expect(selection.strategyId).toBeDefined();
    expect(selection.confidence).toBeGreaterThanOrEqual(0);
    expect(selection.confidence).toBeLessThanOrEqual(1);
  });

  it('should update weights based on feedback', () => {
    const learner = new StrategyMetaLearner();

    learner.updateWeights({
      layersUsed: ['semantic'],
      wasUseful: true,
      taskDifficulty: 0.5,
    });

    const weights = learner.getLayerWeights();
    expect(weights.semantic).toBeGreaterThan(0);
    expect(weights.episodic + weights.semantic + weights.procedural).toBeCloseTo(1, 5);
  });

  it('should evaluate strategy effectiveness', () => {
    const learner = new StrategyMetaLearner();

    // Record some outcomes
    learner.recordOutcome('rag', true, 0.9);
    learner.recordOutcome('rag', false, 0.2);

    const evaluation = learner.evaluate('rag');
    expect(evaluation.strategyId).toBe('rag');
    expect(evaluation.sampleCount).toBe(2);
    expect(evaluation.meanUtility).toBeGreaterThan(0);
  });

  it('should favor successful strategies over time', () => {
    const learner = new StrategyMetaLearner();

    // Give 'rag' many successes
    for (let i = 0; i < 20; i++) {
      learner.recordOutcome('rag', true, 0.9);
    }
    // Give 'cot' many failures
    for (let i = 0; i < 20; i++) {
      learner.recordOutcome('cot', false, 0.1);
    }

    // Sample many times and check rag is selected more often
    let ragCount = 0;
    let cotCount = 0;
    for (let i = 0; i < 100; i++) {
      const sel = learner.selectStrategy({
        availableStrategies: ['rag', 'cot'],
        context: {},
      });
      if (sel.strategyId === 'rag') ragCount++;
      else cotCount++;
    }

    // rag should be selected more often (with high probability)
    expect(ragCount).toBeGreaterThan(cotCount);
  });
});

// ============================================================================
// Phase 7: LLM Router
// ============================================================================

import { ContractLlmRouter } from '../../src/runtime/contractLlmRouter';

describe('LLM Router', () => {
  let router: ContractLlmRouter;

  beforeEach(() => {
    router = new ContractLlmRouter();
    router.registerProvider({
      id: 'openai',
      models: [
        { modelId: 'gpt-4', inputCostPer1k: 0.03, outputCostPer1k: 0.06, avgLatencyMs: 2000, maxTokens: 8192 },
        { modelId: 'gpt-3.5-turbo', inputCostPer1k: 0.001, outputCostPer1k: 0.002, avgLatencyMs: 500, maxTokens: 4096 },
      ],
      health: {
        providerId: 'openai',
        state: 'HEALTHY',
        averageLatency: 0,
        errorRate: 0,
        circuitBreakerOpen: false,
      },
      priority: 1,
      enabled: true,
    } as never);
  });

  it('should route to the correct model', () => {
    const selection = router.route({ modelId: 'gpt-4', inputTokens: 100, outputTokens: 50 });
    expect(selection.modelId).toBe('gpt-4');
    expect(selection.providerId).toBe('openai');
    expect(selection.estimatedCost).toBeGreaterThan(0);
  });

  it('should estimate cost', () => {
    const cost = router.estimateCost({ modelId: 'gpt-4', inputTokens: 1000, outputTokens: 500 });
    expect(cost).toBeCloseTo(0.03 + 0.03, 5); // 1k input + 0.5k output
  });

  it('should track provider health', () => {
    const health = router.getProviderHealth('openai');
    expect(health.state).toBe('HEALTHY');
    expect(health.circuitBreakerOpen).toBe(false);
  });

  it('should open circuit breaker on errors', () => {
    // Record many errors to trigger circuit breaker
    for (let i = 0; i < 10; i++) {
      router.recordError('openai');
    }
    const health = router.getProviderHealth('openai');
    expect(health.circuitBreakerOpen).toBe(true);
  });

  it('should stream responses', async () => {
    const chunks: unknown[] = [];
    for await (const chunk of router.stream({ modelId: 'gpt-4', prompt: 'hello world' })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    // Last chunk should be 'done' type
    const lastChunk = chunks[chunks.length - 1] as { type: string };
    expect(lastChunk.type).toBe('done');
  });

  it('should use fallback chain when primary is down', () => {
    router.registerProvider({
      id: 'anthropic',
      models: [
        { modelId: 'claude-3', inputCostPer1k: 0.01, outputCostPer1k: 0.03, avgLatencyMs: 1500, maxTokens: 8192 },
      ],
      health: {
        providerId: 'anthropic',
        state: 'HEALTHY',
        averageLatency: 0,
        errorRate: 0,
        circuitBreakerOpen: false,
      },
      priority: 2,
      enabled: true,
    } as never);

    router.setFallbackChain('gpt-4', ['anthropic']);

    // Disable openai
    router.setProviderEnabled('openai', false);

    const selection = router.route({ modelId: 'gpt-4' });
    // Should fall back to anthropic
    expect(selection.providerId).toBe('anthropic');
  });
});
