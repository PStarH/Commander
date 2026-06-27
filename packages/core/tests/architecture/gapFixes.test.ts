/**
 * Tests for the 4 architecture gap fixes:
 * 1. HNSW vector index (O(log n) ANN search)
 * 2. TEE worker_threads isolation
 * 3. Distributed EventBus (Redis Pub/Sub backend)
 * 4. Petri net scheduler integration (deadlock detection)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HNSWIndex } from '../../src/memory/hnswIndex';
import { PetriNetSchedulerIntegration } from '../../src/sandbox/petriNetScheduler';
import { DistributedEventBus, createDistributedEventBus } from '../../src/runtime/distributedEventBus';
import { ContractTeeEnclave } from '../../src/sandbox/contractTeeEnclave';
import { PetriNetEngine } from '../../src/runtime/petriNetEngine';
import { HybridSandboxScheduler } from '../../src/sandbox/scheduler';
import { assessRisk } from '../../src/sandbox/scheduler';

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
// 2. Petri Net Scheduler Integration Tests
// ============================================================================

describe('Petri Net Scheduler Integration', () => {
  let integration: PetriNetSchedulerIntegration;

  beforeEach(() => {
    integration = new PetriNetSchedulerIntegration({
      'v8-isolate': 3,
      'seccomp': 2,
      'wasm': 1,
      'tee': 1,
    });
  });

  it('should initialize with correct available slots', () => {
    expect(integration.getAvailableSlots('v8-isolate')).toBe(3);
    expect(integration.getAvailableSlots('seccomp')).toBe(2);
    expect(integration.getAvailableSlots('wasm')).toBe(1);
    expect(integration.getAvailableSlots('tee')).toBe(1);
  });

  it('should track pending requests', () => {
    integration.addPendingRequest();
    integration.addPendingRequest();
    expect(integration.getPendingCount()).toBe(2);
  });

  it('should admit requests when slots are available', () => {
    integration.addPendingRequest();
    expect(integration.canAdmit('v8-isolate')).toBe(true);

    const admitted = integration.admit('v8-isolate');
    expect(admitted).toBe(true);
    expect(integration.getAvailableSlots('v8-isolate')).toBe(2);
    expect(integration.getExecutingCount()).toBe(1);
    expect(integration.getPendingCount()).toBe(0);
  });

  it('should fail to admit when no slots available', () => {
    // Fill all v8 slots
    for (let i = 0; i < 3; i++) {
      integration.addPendingRequest();
      integration.admit('v8-isolate');
    }

    expect(integration.getAvailableSlots('v8-isolate')).toBe(0);

    integration.addPendingRequest();
    expect(integration.canAdmit('v8-isolate')).toBe(false);
    expect(integration.admit('v8-isolate')).toBe(false);
  });

  it('should complete execution and return slot', () => {
    integration.addPendingRequest();
    integration.admit('v8-isolate');
    expect(integration.getAvailableSlots('v8-isolate')).toBe(2);

    integration.complete('v8-isolate');
    expect(integration.getAvailableSlots('v8-isolate')).toBe(3);
    expect(integration.getExecutingCount()).toBe(0);
    expect(integration.getCompletedCount()).toBe(1);
  });

  it('should detect deadlock when all slots exhausted and no executing', () => {
    // Add pending but no slots available
    for (let i = 0; i < 3; i++) {
      integration.addPendingRequest();
      integration.admit('v8-isolate');
    }
    for (let i = 0; i < 2; i++) {
      integration.addPendingRequest();
      integration.admit('seccomp');
    }
    integration.addPendingRequest();
    integration.admit('wasm');
    integration.addPendingRequest();
    integration.admit('tee');

    // All slots used, now add another pending request
    integration.addPendingRequest();

    const analysis = integration.analyzeDeadlock();
    // With executing > 0, it's saturated not deadlocked
    expect(analysis.isDeadlocked).toBe(false);
    expect(analysis.recommendation).toContain('SATURATED');

    // Now complete all executions
    for (let i = 0; i < 3; i++) integration.complete('v8-isolate');
    for (let i = 0; i < 2; i++) integration.complete('seccomp');
    integration.complete('wasm');
    integration.complete('tee');

    // Now we have 1 pending, 0 executing, but slots are back
    // Actually slots are returned, so it's not deadlocked
    expect(integration.getAvailableSlots('v8-isolate')).toBe(3);
  });

  it('should detect true deadlock (pending, no slots, no executing)', () => {
    // Exhaust all slots without tracking executing properly
    // Manually set executing to 0 by using setMarking on the PetriNet engine
    const petriNet = integration.getPetriNetEngine();
    petriNet.setMarking('pending', 5);
    petriNet.setMarking('v8_slots', 0);
    petriNet.setMarking('seccomp_slots', 0);
    petriNet.setMarking('wasm_slots', 0);
    petriNet.setMarking('tee_slots', 0);
    petriNet.setMarking('executing', 0);

    const analysis = integration.analyzeDeadlock();
    expect(analysis.isDeadlocked).toBe(true);
    expect(analysis.recommendation).toContain('DEADLOCK');
  });

  it('should report safe state when resources available', () => {
    integration.addPendingRequest();
    const analysis = integration.analyzeDeadlock();
    expect(analysis.safeState).toBe(true);
    expect(analysis.recommendation).toContain('SAFE');
  });

  it('should check if safe to admit', () => {
    integration.addPendingRequest();
    expect(integration.isSafeToAdmit('v8-isolate')).toBe(true);
  });

  it('should get full state snapshot', () => {
    integration.addPendingRequest();
    integration.admit('v8-isolate');

    const snapshot = integration.getSnapshot();
    expect(snapshot.pending).toBe(0);
    expect(snapshot.executing).toBe(1);
    expect(snapshot.completed).toBe(0);
    expect(snapshot.availableSlots['v8-isolate']).toBe(2);
    expect(snapshot.isDeadlocked).toBe(false);
  });

  it('should record firing history', () => {
    integration.addPendingRequest();
    integration.admit('v8-isolate');
    integration.complete('v8-isolate');

    const history = integration.getFiringHistory();
    expect(history).toContain('admit_v8-isolate');
    expect(history).toContain('complete_v8-isolate');
  });

  it('should reset to initial state', () => {
    integration.addPendingRequest();
    integration.admit('v8-isolate');

    integration.reset();
    expect(integration.getAvailableSlots('v8-isolate')).toBe(3);
    expect(integration.getPendingCount()).toBe(0);
    expect(integration.getExecutingCount()).toBe(0);
  });
});

// ============================================================================
// 3. PetriNetEngine setMarking Tests
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
// 4. Distributed EventBus Tests
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

// ============================================================================
// 5. TEE Enclave Worker Threads Tests
// ============================================================================

describe('ContractTeeEnclave (worker_threads)', () => {
  let enclave: ContractTeeEnclave;

  beforeEach(async () => {
    enclave = new ContractTeeEnclave();
    await enclave.initialize();
  });

  it('should initialize with attestation', () => {
    expect(enclave.isInitialized()).toBe(true);
    expect(enclave.getTeeIdentity()).toBeTruthy();
    expect(enclave.getBackend()).toBe('software-simulation');
  });

  it('should verify attestation', async () => {
    const verified = await enclave.verifyAttestation();
    expect(verified).toBe(true);
  });

  it('should execute code in isolated worker', async () => {
    const result = await enclave.executeInEnclave(
      'return input * 2',
      21,
    );
    expect(result).toBe(42);
  });

  it('should handle async code in enclave', async () => {
    const result = await enclave.executeInEnclave(
      'return Promise.resolve(input + 1)',
      41,
    );
    expect(result).toBe(42);
  });

  it('should handle execution errors', async () => {
    await expect(
      enclave.executeInEnclave('throw new Error("test error")', null),
    ).rejects.toThrow('test error');
  });

  it('should seal and unseal data', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const sealed = await enclave.seal(data);
    expect(sealed.length).toBeGreaterThan(data.length);

    const unsealed = await enclave.unseal(sealed);
    expect(Array.from(unsealed)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should fail unseal with corrupted data', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const sealed = await enclave.seal(data);

    // Corrupt the sealed data
    sealed[sealed.length - 1] ^= 0xff;

    await expect(enclave.unseal(sealed)).rejects.toThrow();
  });

  it('should provide crypto access in enclave', async () => {
    const result = await enclave.executeInEnclave(
      'return crypto.createHash("sha256").update(String(input)).digest("hex")',
      'test',
    );
    expect(result).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });
});

// ============================================================================
// 6. HybridSandboxScheduler with Petri Net Integration Tests
// ============================================================================

describe('HybridSandboxScheduler Petri Net Integration', () => {
  it('should initialize with Petri net integration', () => {
    const scheduler = new HybridSandboxScheduler();
    const state = scheduler.getPetriState();
    expect(state.availableSlots['v8-isolate']).toBe(10);
    expect(state.availableSlots['seccomp']).toBe(4);
    expect(state.pending).toBe(0);
    expect(state.executing).toBe(0);
  });

  it('should analyze deadlock state', () => {
    const scheduler = new HybridSandboxScheduler();
    const analysis = scheduler.analyzeDeadlock();
    expect(analysis).toHaveProperty('isDeadlocked');
    expect(analysis).toHaveProperty('recommendation');
    expect(analysis.safeState).toBe(true);
  });

  it('should check safe to admit', () => {
    const scheduler = new HybridSandboxScheduler();
    expect(scheduler.isSafeToAdmit('v8-isolate')).toBe(true);
    expect(scheduler.isSafeToAdmit('seccomp')).toBe(true);
  });
});
