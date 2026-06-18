import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SemanticCache, computeRequestSignature } from '../../src/runtime/semanticCache';
import type { EmbeddingFunction } from '../../src/runtime/embedding';
import type { LLMRequest, LLMResponse } from '../../src/runtime/types';

const DIM = 4;

class ScriptedEmbeddingFn implements EmbeddingFunction {
  readonly name = 'scripted';
  readonly dimension = DIM;
  private scripts = new Map<string, number[]>();
  public calls: string[] = [];

  setVector(text: string, vec: number[]): void {
    this.scripts.set(text, vec);
  }

  generate(text: string): number[] {
    this.calls.push(text);
    return this.scripts.get(text) ?? [0, 0, 0, 0];
  }
}

function makeRequest(userContent: string, opts: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: userContent }],
    temperature: 0,
    ...opts,
  };
}

function makeResponse(content: string, opts: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content,
    model: 'gpt-4o-mini',
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...opts,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe('SemanticCache', () => {
  let fn: ScriptedEmbeddingFn;

  beforeEach(() => {
    fn = new ScriptedEmbeddingFn();
  });

  afterEach(() => {
    fn.calls = [];
  });

  it('disabled cache always returns null', async () => {
    const cache = new SemanticCache(fn, { enabled: false });
    fn.setVector('hello', [1, 0, 0, 0]);
    cache.store(makeRequest('hello'), makeResponse('world'));
    await flushMicrotasks();
    expect(await cache.lookup(makeRequest('hello'))).toBeNull();
    cache.dispose();
  });

  it('exact-match hit returns cached response', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('What is TypeScript?', [1, 0, 0, 0]);
    cache.store(
      makeRequest('What is TypeScript?'),
      makeResponse('TypeScript is a typed superset of JavaScript.'),
    );
    await flushMicrotasks();
    const result = await cache.lookup(makeRequest('What is TypeScript?'));
    expect(result).not.toBeNull();
    expect(result!.content).toBe('TypeScript is a typed superset of JavaScript.');
    const stats = cache.getStats();
    expect(stats.totalHits).toBe(1);
    expect(stats.totalMisses).toBe(0);
    expect(stats.hitRate).toBe(1);
    cache.dispose();
  });

  it('miss on unrelated text', async () => {
    const cache = new SemanticCache(fn, {
      enabled: true,
      similarityThreshold: 0.92,
      pruneIntervalMs: 0,
    });
    fn.setVector('cats are cute', [1, 0, 0, 0]);
    fn.setVector('quantum physics', [0, 1, 0, 0]);
    cache.store(makeRequest('cats are cute'), makeResponse('yes'));
    await flushMicrotasks();
    const result = await cache.lookup(makeRequest('quantum physics'));
    expect(result).toBeNull();
    expect(cache.getStats().totalMisses).toBe(1);
    cache.dispose();
  });

  it('semantic hit on near-parallel vectors', async () => {
    const cache = new SemanticCache(fn, {
      enabled: true,
      similarityThreshold: 0.9,
      pruneIntervalMs: 0,
    });
    fn.setVector('how to make pasta', [0.95, 0.31, 0, 0]);
    fn.setVector('how do I cook pasta', [0.96, 0.28, 0, 0]);
    fn.setVector('weather tomorrow', [0, 0, 1, 0]);
    cache.store(makeRequest('how to make pasta'), makeResponse('Boil water, add salt...'));
    await flushMicrotasks();
    const similar = await cache.lookup(makeRequest('how do I cook pasta'));
    expect(similar).not.toBeNull();
    const unrelated = await cache.lookup(makeRequest('weather tomorrow'));
    expect(unrelated).toBeNull();
    cache.dispose();
  });

  it('tenant isolation: tenant A does not see tenant B entries', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('shared query', [1, 0, 0, 0]);
    cache.store(makeRequest('shared query'), makeResponse('tenant A response'), 'tenant-A');
    await flushMicrotasks();
    const fromA = await cache.lookup(makeRequest('shared query'), 'tenant-A');
    const fromB = await cache.lookup(makeRequest('shared query'), 'tenant-B');
    expect(fromA).not.toBeNull();
    expect(fromA!.content).toBe('tenant A response');
    expect(fromB).toBeNull();
    cache.dispose();
  });

  it('TTL expiry: old entries do not hit', async () => {
    const cache = new SemanticCache(fn, { enabled: true, defaultTtlMs: 10, pruneIntervalMs: 0 });
    fn.setVector('query', [1, 0, 0, 0]);
    cache.store(makeRequest('query'), makeResponse('old answer'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 30));
    const result = await cache.lookup(makeRequest('query'));
    expect(result).toBeNull();
    expect(cache.getStats().totalMisses).toBe(1);
    cache.dispose();
  });

  it('global LRU eviction: oldest entry evicted at capacity', async () => {
    const cache = new SemanticCache(fn, {
      enabled: true,
      maxEntries: 2,
      maxBucketSize: 16,
      pruneIntervalMs: 0,
    });
    fn.setVector('a', [1, 0, 0, 0]);
    fn.setVector('b', [0, 1, 0, 0]);
    fn.setVector('c', [0, 0, 1, 0]);
    cache.store(makeRequest('a'), makeResponse('answer a'));
    await new Promise((r) => setTimeout(r, 5));
    cache.store(makeRequest('b'), makeResponse('answer b'));
    await new Promise((r) => setTimeout(r, 5));
    cache.store(makeRequest('c'), makeResponse('answer c'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const aHit = await cache.lookup(makeRequest('a'));
    const cHit = await cache.lookup(makeRequest('c'));
    expect(aHit).toBeNull();
    expect(cHit).not.toBeNull();
    cache.dispose();
  });

  it('stochastic skip: temperature > 0 not cached by default', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('creative query', [1, 0, 0, 0]);
    cache.store(
      makeRequest('creative query', { temperature: 0.7 }),
      makeResponse('stochastic answer'),
    );
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const result = await cache.lookup(makeRequest('creative query', { temperature: 0.7 }));
    expect(result).toBeNull();
    cache.dispose();
  });

  it('tool-call skip: tool calls not cached by default', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('query with tools', [1, 0, 0, 0]);
    const req = makeRequest('query with tools', {
      tools: [{ name: 'foo', description: 'bar', parameters: {} }],
    });
    const resp = makeResponse('answer', { toolCalls: [{ id: '1', name: 'foo', arguments: '{}' }] });
    cache.store(req, resp);
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const result = await cache.lookup(req);
    expect(result).toBeNull();
    cache.dispose();
  });

  it('error responses are not cached', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('bad query', [1, 0, 0, 0]);
    cache.store(makeRequest('bad query'), makeResponse('error', { finishReason: 'error' }));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const result = await cache.lookup(makeRequest('bad query'));
    expect(result).toBeNull();
    cache.dispose();
  });

  it('stats: tracks hits, misses, stores, embeddingCalls, costSaved', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('x', [1, 0, 0, 0]);
    fn.setVector('y', [0, 1, 0, 0]);
    cache.store(makeRequest('x'), makeResponse('ans1'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    await cache.lookup(makeRequest('x'));
    await cache.lookup(makeRequest('y'));
    const stats = cache.getStats();
    expect(stats.totalHits).toBe(1);
    expect(stats.totalMisses).toBe(1);
    expect(stats.totalStores).toBe(1);
    expect(stats.embeddingCalls).toBeGreaterThanOrEqual(3);
    expect(stats.estimatedCostSavedUsd).toBeGreaterThan(0);
    cache.dispose();
  });

  it('prune: removes expired entries', async () => {
    const cache = new SemanticCache(fn, { enabled: true, defaultTtlMs: 10, pruneIntervalMs: 0 });
    fn.setVector('p1', [1, 0, 0, 0]);
    fn.setVector('p2', [0, 1, 0, 0]);
    cache.store(makeRequest('p1'), makeResponse('a1'));
    await flushMicrotasks();
    cache.store(makeRequest('p2'), makeResponse('a2'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 30));
    const pruned = cache.prune();
    expect(pruned).toBeGreaterThanOrEqual(2);
    expect(cache.getStats().totalEntries).toBe(0);
    cache.dispose();
  });

  it('invalidateTenant: removes only the specified tenant', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('shared', [1, 0, 0, 0]);
    cache.store(makeRequest('shared'), makeResponse('A'), 'tenant-A');
    await flushMicrotasks();
    cache.store(makeRequest('shared'), makeResponse('B'), 'tenant-B');
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const removed = cache.invalidateTenant('tenant-A');
    expect(removed).toBe(1);
    const fromA = await cache.lookup(makeRequest('shared'), 'tenant-A');
    const fromB = await cache.lookup(makeRequest('shared'), 'tenant-B');
    expect(fromA).toBeNull();
    expect(fromB).not.toBeNull();
    cache.dispose();
  });

  it('invalidateModel: removes entries for a specific model', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('m1', [1, 0, 0, 0]);
    fn.setVector('m2', [0, 1, 0, 0]);
    cache.store(makeRequest('m1'), makeResponse('a', { model: 'gpt-4o-mini' }));
    await flushMicrotasks();
    cache.store(makeRequest('m2'), makeResponse('b', { model: 'gpt-4o' }));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const removed = cache.invalidateModel('gpt-4o-mini');
    expect(removed).toBe(1);
    const m1 = await cache.lookup(makeRequest('m1'));
    const m2 = await cache.lookup(makeRequest('m2'));
    expect(m1).toBeNull();
    expect(m2).not.toBeNull();
    cache.dispose();
  });

  it('clear: removes all entries', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('q1', [1, 0, 0, 0]);
    fn.setVector('q2', [0, 1, 0, 0]);
    cache.store(makeRequest('q1'), makeResponse('a1'));
    await flushMicrotasks();
    cache.store(makeRequest('q2'), makeResponse('a2'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    cache.clear();
    expect(cache.getStats().totalEntries).toBe(0);
    cache.dispose();
  });

  it('computeRequestSignature: same model+system → same signature', () => {
    const r1 = makeRequest('q1', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'q1' },
      ],
    });
    const r2 = makeRequest('q1', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'DIFFERENT q' },
      ],
    });
    const r3 = makeRequest('q1', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be verbose' },
        { role: 'user', content: 'q1' },
      ],
    });
    expect(computeRequestSignature(r1)).toBe(computeRequestSignature(r2));
    expect(computeRequestSignature(r1)).not.toBe(computeRequestSignature(r3));
  });

  it('computeRequestSignature: different temperature → different signature', () => {
    const greedy = makeRequest('q', { temperature: 0 });
    const stochastic = makeRequest('q', { temperature: 0.7 });
    expect(computeRequestSignature(greedy)).not.toBe(computeRequestSignature(stochastic));
  });

  it('hit returns a clone (callers cannot corrupt the cache)', async () => {
    const cache = new SemanticCache(fn, { enabled: true, pruneIntervalMs: 0 });
    fn.setVector('clone test', [1, 0, 0, 0]);
    cache.store(makeRequest('clone test'), makeResponse('original'));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
    const first = await cache.lookup(makeRequest('clone test'));
    expect(first).not.toBeNull();
    first!.content = 'MUTATED';
    const second = await cache.lookup(makeRequest('clone test'));
    expect(second!.content).toBe('original');
    cache.dispose();
  });

  it('cost-reduction micro-benchmark: 30% duplicate traffic yields measurable savings', async () => {
    const cache = new SemanticCache(fn, {
      enabled: true,
      similarityThreshold: 0.9,
      pruneIntervalMs: 0,
    });

    const baseQueries: Array<[string, number[]]> = [
      ['how to make pasta', [0.95, 0.31, 0, 0]],
      ['explain quantum entanglement', [0, 0, 0.95, 0.31]],
      ['tell me about cats', [0.31, 0, 0, 0.95]],
    ];
    baseQueries.forEach(([q, v]) => fn.setVector(q, v));

    const variantVectors: Array<[string, number[]]> = [
      ['how do I cook pasta', [0.96, 0.28, 0, 0]],
      ['how to boil noodles', [0.93, 0.34, 0, 0]],
      ['best way to make spaghetti', [0.97, 0.25, 0, 0]],
      ['what is quantum superposition', [0, 0, 0.94, 0.34]],
      ['quantum physics basics', [0, 0, 0.96, 0.27]],
      ['cat behavior explained', [0.34, 0, 0, 0.94]],
      ['are cats good pets', [0.28, 0, 0, 0.96]],
    ];
    variantVectors.forEach(([q, v]) => fn.setVector(q, v));

    const unrelatedVectors: Array<[string, number[]]> = [
      ['weather in tokyo', [0.5, 0.5, 0.5, 0.5]],
      ['stock price today', [0.7, 0.1, 0.7, 0.1]],
      ['movie recommendations', [0.4, 0.4, 0.4, 0.4]],
    ];
    unrelatedVectors.forEach(([q, v]) => fn.setVector(q, v));

    for (const [q] of baseQueries) {
      cache.store(makeRequest(q), makeResponse(`answer for ${q}`));
    }
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 30));

    let hits = 0;
    let misses = 0;
    for (let i = 0; i < 100; i++) {
      let query: string;
      if (i % 10 === 0) {
        query = unrelatedVectors[i % unrelatedVectors.length][0];
      } else if (i % 3 === 0) {
        query = variantVectors[i % variantVectors.length][0];
      } else {
        query = baseQueries[i % baseQueries.length][0];
      }
      const result = await cache.lookup(makeRequest(query));
      if (result) hits++;
      else misses++;
    }

    const stats = cache.getStats();
    expect(hits).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);
    expect(stats.hitRate).toBeGreaterThan(0.6);
    expect(stats.hitRate).toBeLessThan(0.95);
    expect(stats.estimatedCostSavedUsd).toBeGreaterThan(0);
    cache.dispose();
  });
});
