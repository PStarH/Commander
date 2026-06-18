import { describe, it, expect } from 'vitest';
import { EpsilonStore } from '../../src/ultimate/epsilonStore';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import { ExplorationEventLog } from '../../src/ultimate/explorationEventLog';
import type { OrchestrationTopology } from '../../src/ultimate/types';

function makeDeliberation(taskType: OrchestrationTopology = 'CODING') {
  return {
    taskType: 'CODING' as const,
    reasoning: [],
    confidence: 0.9,
    estimatedAgentCount: 3,
    estimatedTokens: 1000,
    estimatedSteps: 5,
    capabilitiesNeeded: [],
    decompositionStrategy: 'STEP' as const,
    taskNature: 'IO_BOUND' as const,
    suitableForSpeculation: false,
    recommendedTopology: taskType,
  };
}

describe('EpsilonStore', () => {
  it('set + get round-trip', () => {
    const store = new EpsilonStore();
    store.set('A', 0.1);
    expect(store.get('A')?.epsilon).toBe(0.1);
    expect(store.get('A')?.tenantId).toBe('A');
  });

  it('set records a setAt timestamp', () => {
    const store = new EpsilonStore();
    const entry = store.set('A', 0.1);
    expect(entry.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('clamps to [0, 1]', () => {
    const store = new EpsilonStore();
    expect(store.set('A', -0.5).epsilon).toBe(0);
    expect(store.set('B', 1.5).epsilon).toBe(1);
    expect(store.set('C', 0.5).epsilon).toBe(0.5);
  });

  it('falls back to 0.05 on NaN/Infinity', () => {
    const store = new EpsilonStore();
    expect(store.set('A', NaN).epsilon).toBe(0.05);
    expect(store.set('B', Infinity).epsilon).toBe(1); // Infinity clamps to 1, not 0.05
    expect(store.set('C', -Infinity).epsilon).toBe(0); // -Infinity clamps to 0
  });

  it('overwrites an existing override', () => {
    const store = new EpsilonStore();
    store.set('A', 0.1);
    store.set('A', 0.3);
    expect(store.get('A')?.epsilon).toBe(0.3);
  });

  it('list returns sorted by tenantId with defensive copy', () => {
    const store = new EpsilonStore();
    store.set('C', 0.1);
    store.set('A', 0.2);
    store.set('B', 0.3);
    const list = store.list();
    expect(list.map((e) => e.tenantId)).toEqual(['A', 'B', 'C']);
    list[0]!.epsilon = 999; // mutate returned array
    expect(store.get('A')?.epsilon).toBe(0.2); // store unchanged
  });

  it('clear removes a single override', () => {
    const store = new EpsilonStore();
    store.set('A', 0.1);
    expect(store.clear('A')).toBe(true);
    expect(store.get('A')).toBeUndefined();
    expect(store.clear('A')).toBe(false); // already cleared
  });

  it('clearAll returns the count and empties the store', () => {
    const store = new EpsilonStore();
    store.set('A', 0.1);
    store.set('B', 0.2);
    expect(store.clearAll()).toBe(2);
    expect(store.size()).toBe(0);
  });

  it('resolve returns override or fallback', () => {
    const store = new EpsilonStore();
    store.set('A', 0.1);
    expect(store.resolve('A')).toBe(0.1);
    expect(store.resolve('B')).toBe(0.05); // default fallback
    expect(store.resolve('B', 0.2)).toBe(0.2); // custom fallback
  });

  it('size reflects the override count', () => {
    const store = new EpsilonStore();
    expect(store.size()).toBe(0);
    store.set('A', 0.1);
    store.set('B', 0.2);
    expect(store.size()).toBe(2);
  });
});

describe('TopologyRouter — per-tenant ε resolution (P6)', () => {
  it('uses per-tenant override when set', () => {
    const store = new EpsilonStore();
    store.set('A', 1.0); // always explore
    const router = new TopologyRouter(undefined, undefined, {
      epsilon: 0.0, // never explore at the constructor level
      epsilonStore: store,
    });
    const r = router.route(makeDeliberation(), undefined, undefined, 'A');
    // ε=1.0 with >1 candidate → exploration fires (or argmax stays if Boltzmann returns argmax)
    // The test asserts the override was applied, not the constructor default
    expect(r.epsilonUsed).toBe(1.0);
  });

  it('falls back to constructor default when no override', () => {
    const store = new EpsilonStore();
    store.set('OTHER', 0.5);
    const router = new TopologyRouter(undefined, undefined, {
      epsilon: 0.2,
      epsilonStore: store,
    });
    const r = router.route(makeDeliberation(), undefined, undefined, 'A');
    expect(r.epsilonUsed).toBe(0.2);
  });

  it('per-call routeOptions.epsilon wins over per-tenant override', () => {
    const store = new EpsilonStore();
    store.set('A', 0.5);
    const router = new TopologyRouter(undefined, undefined, {
      epsilon: 0.1,
      epsilonStore: store,
    });
    const r = router.route(makeDeliberation(), undefined, undefined, 'A', { epsilon: 0.8 });
    expect(r.epsilonUsed).toBe(0.8);
  });

  it('per-tenant wins over constructor default', () => {
    const store = new EpsilonStore();
    store.set('A', 0.5);
    const router = new TopologyRouter(undefined, undefined, {
      epsilon: 0.1,
      epsilonStore: store,
    });
    const r = router.route(makeDeliberation(), undefined, undefined, 'A');
    expect(r.epsilonUsed).toBe(0.5);
  });

  it('no epsilonStore means no per-tenant resolution', () => {
    const router = new TopologyRouter(undefined, undefined, { epsilon: 0.3 });
    const r = router.route(makeDeliberation(), undefined, undefined, 'A');
    expect(r.epsilonUsed).toBe(0.3);
  });

  it('no tenantId means no per-tenant resolution (constructor default used)', () => {
    const store = new EpsilonStore();
    store.set('A', 0.5);
    const router = new TopologyRouter(undefined, undefined, {
      epsilon: 0.1,
      epsilonStore: store,
    });
    const r = router.route(makeDeliberation());
    expect(r.epsilonUsed).toBe(0.1);
  });
});

describe('ExplorationEventLog — EpsilonStore integration (P6)', () => {
  it('constructor accepts an injected EpsilonStore', () => {
    const store = new EpsilonStore();
    const log = new ExplorationEventLog(100, store);
    expect(log.getEpsilonStore()).toBe(store);
  });

  it('constructor creates a fresh EpsilonStore when none injected', () => {
    const log = new ExplorationEventLog(100);
    const store = log.getEpsilonStore();
    expect(store).toBeInstanceOf(EpsilonStore);
    expect(store.size()).toBe(0);
  });

  it('reset() does NOT clear the EpsilonStore (operator overrides survive)', () => {
    const log = new ExplorationEventLog(100);
    log.getEpsilonStore().set('A', 0.1);
    log.record({
      tenantId: 'A',
      taskType: 'CODING',
      chosenTopology: 'PARALLEL',
      argmaxTopology: 'SEQUENTIAL',
      diverged: false,
      epsilon: 0.05,
      topCandidates: [{ topology: 'PARALLEL', score: 5 }],
    });
    log.reset();
    expect(log.getEpsilonStore().get('A')?.epsilon).toBe(0.1);
  });
});
