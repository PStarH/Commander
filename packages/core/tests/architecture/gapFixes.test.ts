/**
 * Tests for the architecture gap fixes:
 * 1. HNSW vector index (O(log n) ANN search)
 * 2. Distributed EventBus (Redis Pub/Sub backend)
 * 3. PetriNetEngine marking API (used by runtime Petri net, not scheduler)
 *
 * Note: The previous "Petri Net Scheduler Integration" and "ContractTeeEnclave
 * (worker_threads)" test blocks were removed together with the underlying
 * modules. The scheduler's Petri net integration was dead code (admit/complete
 * transitions never fired on the production path), and contractTeeEnclave was
 * a half-wired dead path (registered in scheduler.backends but schedule() was
 * never invoked). See scheduler.ts Simplification note for details.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HNSWIndex } from '../../src/memory/hnswIndex';
import { DistributedEventBus, createDistributedEventBus } from '../../src/runtime/distributedEventBus';
import { PetriNetEngine } from '../../src/runtime/petriNetEngine';

// ============================================================================
// 1. HNSW Vector Index Tests
// ============================================================================

describe('HNSW Vector Index', () => {
  let index: HNSWIndex;

  beforeEach(() => {
    index = new HNSWIndex({ bruteForceThreshold: 5 });
  });

  it('should add and search vectors with brute-force for small datasets', () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    const v3 = [0, 0, 1];

    index.add('a', v1);
    index.add('b', v2);
    index.add('c', v3);

    expect(index.size).toBe(3);
    expect(index.isHNSWActive).toBe(false);

    const results = index.search([1, 0.1, 0], 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('should return empty for empty index', () => {
    expect(index.search([1, 0, 0], 5)).toEqual([]);
  });

  it('should filter by minimum score', () => {
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);

    const results = index.search([1, 0, 0], 5, 0.99);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
  });

  it('should update vector when adding same ID', () => {
    index.add('a', [1, 0, 0]);
    index.add('a', [0, 1, 0]);

    expect(index.size).toBe(1);
    const results = index.search([0, 1, 0], 1);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeGreaterThan(0.99);
  });

  it('should remove vectors', () => {
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);

    index.remove('a');
    expect(index.size).toBe(1);

    const results = index.search([1, 0, 0], 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('b');
  });

  it('should build HNSW graph when crossing threshold', () => {
    // Add vectors up to threshold (brute-force)
    for (let i = 0; i < 5; i++) {
      const vec = Array(10).fill(0);
      vec[i] = 1;
      index.add(`v${i}`, vec);
    }

    expect(index.isHNSWActive).toBe(false);

    // Cross the threshold — triggers HNSW build
    const vec = Array(10).fill(0);
    vec[5] = 1;
    index.add('v5', vec);

    // HNSW should now be active
    expect(index.isHNSWActive).toBe(true);

    // Search should still work
    const query = Array(10).fill(0);
    query[0] = 1;
    const results = index.search(query, 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe('v0');
  });

  it('should handle high-dimensional vectors', () => {
    const dim = 256;
    index.add('a', Array(dim).fill(0).map((_, i) => Math.sin(i)));
    index.add('b', Array(dim).fill(0).map((_, i) => Math.cos(i)));

    const query = Array(dim).fill(0).map((_, i) => Math.sin(i));
    const results = index.search(query, 2);
    expect(results[0].id).toBe('a');
  });

  it('should clear all vectors', () => {
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.search([1, 0, 0], 5)).toEqual([]);
  });
});

// ============================================================================
// 2. PetriNetEngine setMarking Tests
// ============================================================================

describe('PetriNetEngine setMarking', () => {
  it('should set marking directly', () => {
    const engine = new PetriNetEngine();
    engine.addPlace({ id: 'p1', label: 'Place 1', marking: 5, capacity: 10 });
    engine.addPlace({ id: 'p2', label: 'Place 2', marking: 0, capacity: Infinity });

    engine.setMarking('p1', 8);
    expect(engine.getPlace('p1')?.marking).toBe(8);

    engine.setMarking('p2', 100);
    expect(engine.getPlace('p2')?.marking).toBe(100);
  });

  it('should reject marking exceeding capacity', () => {
    const engine = new PetriNetEngine();
    engine.addPlace({ id: 'p1', label: 'Place 1', marking: 0, capacity: 5 });

    expect(() => engine.setMarking('p1', 6)).toThrow('exceeds capacity');
  });

  it('should reject negative marking', () => {
    const engine = new PetriNetEngine();
    engine.addPlace({ id: 'p1', label: 'Place 1', marking: 0, capacity: 10 });

    expect(() => engine.setMarking('p1', -1)).toThrow('non-negative');
  });

  it('should reject unknown place', () => {
    const engine = new PetriNetEngine();
    expect(() => engine.setMarking('unknown', 1)).toThrow('Unknown place');
  });

  it('should get transition count', () => {
    const engine = new PetriNetEngine();
    engine.addPlace({ id: 'p1', label: 'P1', marking: 1, capacity: Infinity });
    engine.addPlace({ id: 'p2', label: 'P2', marking: 0, capacity: Infinity });
    engine.addTransition({
      id: 't1', label: 'T1',
      inputs: new Map([['p1', 1]]),
      outputs: new Map([['p2', 1]]),
    });

    expect(engine.getTransitionCount()).toBe(1);
  });
});

// ============================================================================
// 3. Distributed EventBus Tests
// ============================================================================

describe('Distributed EventBus', () => {
  it('should operate in memory mode by default', () => {
    const bus = createDistributedEventBus();
    expect(bus.getBackend()).toBe('memory');
    expect(bus.isDistributed()).toBe(false);
  });

  it('should have a node ID', () => {
    const bus = createDistributedEventBus();
    expect(bus.getNodeId()).toBeTruthy();
    expect(bus.getNodeId()).toContain('node-');
  });

  it('should deliver messages locally in memory mode', async () => {
    const bus = createDistributedEventBus();
    const received: unknown[] = [];

    bus.subscribe('test-topic', (msg) => {
      received.push(msg);
    });

    await bus.publish('test-topic', { hello: 'world' });

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ hello: 'world' });
  });

  it('should support multiple subscribers', async () => {
    const bus = createDistributedEventBus();
    const received1: unknown[] = [];
    const received2: unknown[] = [];

    bus.subscribe('topic', (msg) => received1.push(msg));
    bus.subscribe('topic', (msg) => received2.push(msg));

    await bus.publish('topic', 'event');

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);
  });

  it('should handle unsubscribe', async () => {
    const bus = createDistributedEventBus();
    const received: unknown[] = [];

    const unsub = bus.subscribe('topic', (msg) => received.push(msg));
    await bus.publish('topic', 'first');

    unsub();
    await bus.publish('topic', 'second');

    expect(received.length).toBe(1);
    expect(received[0]).toBe('first');
  });

  it('should fall back to memory when redis is unavailable', async () => {
    const bus = new DistributedEventBus({
      backend: 'redis',
      redisUrl: 'redis://nonexistent:6379',
    });

    // Wait a bit for init to fail
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should fall back to memory mode
    expect(bus.getBackend()).toBe('memory');

    const received: unknown[] = [];
    bus.subscribe('topic', (msg) => received.push(msg));
    await bus.publish('topic', 'test');

    expect(received.length).toBe(1);
  });

  it('should shutdown gracefully', async () => {
    const bus = createDistributedEventBus();
    await bus.shutdown();
    // Should not throw
  });
});
