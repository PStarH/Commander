/**
 * Phase A test — additive route-out from threeLayerMemory.add() to MemoryStore.
 *
 * Audit MED item 1. Verifies the contract that:
 *   1. `mapMemoryEntryToWriteOptions` is a pure, deterministic function.
 *   2. `ThreeLayerMemory` constructed with a `memoryStore` routes non-working
 *      layer writes through it, while the working layer stays ephemeral.
 *   3. `setMemoryStore(null)` disables route-out at runtime.
 *   4. `wireGlobalThreeLayerMemory(store)` wires the singleton.
 *
 * The fire-and-forget pattern in `add()` is honored in tests by spying on
 * `store.write` and collecting the resulting promises so we can `await` them
 * deterministically before asserting state.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  createThreeLayerMemory,
  mapMemoryEntryToWriteOptions,
  wireGlobalThreeLayerMemory,
  resetGlobalThreeLayerMemory,
  getGlobalThreeLayerMemory,
  type MemoryEntry,
  type MemoryLayer,
} from '../src/threeLayerMemory';
import { InMemoryMemoryService } from '../src/memory/inMemoryMemoryService';
import { MemoryStoreFacade } from '../src/memory/memoryStoreFacade';
import { getGlobalLogger } from '../src/logging';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  layer: MemoryLayer,
  importance: number,
  content = 'memory content',
  context = 'memory context',
  extras: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id: `entry-${layer}-${importance}-${Math.random().toString(36).slice(2, 6)}`,
    layer,
    content,
    context,
    importance,
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    decayScore: layer === 'episodic' ? 1 : 0,
    tags: ['t1'],
    metadata: {},
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Pure-function tests for mapMemoryEntryToWriteOptions
// ---------------------------------------------------------------------------

describe('mapMemoryEntryToWriteOptions (pure)', () => {
  it('routes episodic → SUMMARY/EPISODIC, projectId forwarded', () => {
    const out = mapMemoryEntryToWriteOptions(makeEntry('episodic', 0.5), 'proj-A');
    expect(out.kind).toBe('SUMMARY');
    expect(out.duration).toBe('EPISODIC');
    expect(out.projectId).toBe('proj-A');
    expect(out.priority).toBe(50);
    expect(out.confidence).toBe(0.5);
  });

  it('routes longterm (importance >= 0.7) → DECISION/LONG_TERM', () => {
    const out = mapMemoryEntryToWriteOptions(makeEntry('longterm', 0.8), 'proj-A');
    expect(out.kind).toBe('DECISION');
    expect(out.duration).toBe('LONG_TERM');
    expect(out.priority).toBe(80);
  });

  it('routes longterm (importance < 0.7) → LESSON/LONG_TERM', () => {
    const out = mapMemoryEntryToWriteOptions(makeEntry('longterm', 0.4), 'proj-A');
    expect(out.kind).toBe('LESSON');
    expect(out.duration).toBe('LONG_TERM');
    expect(out.priority).toBe(40);
  });

  it('routes procedural → LESSON/EPISODIC (Phase A lossiness accept)', () => {
    const out = mapMemoryEntryToWriteOptions(
      makeEntry('procedural', 0.6, 'p-content', 'p-context', {
        proceduralType: 'tool',
        successRate: 0.9,
        usageCount: 7,
        conditions: ['web-search'],
      }),
      'proj-A',
    );
    expect(out.kind).toBe('LESSON');
    expect(out.duration).toBe('EPISODIC');
    // Phase A deliberately drops Procedural-specific fields (proceduralType,
    // successRate, usageCount, conditions). Verified safe by pre-flight grep:
    // no production code reads these on a MemoryEntry. Phase D recovers them
    // via a `meta` JSON column on memory_items.
    expect(out).not.toHaveProperty('proceduralType');
    expect(out).not.toHaveProperty('successRate');
  });

  it('derived title prefers entry.context and substring-truncates to 100 chars', () => {
    // Context wins; short context is returned verbatim even with long content.
    expect(
      mapMemoryEntryToWriteOptions(makeEntry('episodic', 0.3, 'x'.repeat(150), 'short-title'))
        .title,
    ).toBe('short-title');

    // Empty context falls back to content; long content is substring-truncated
    // to the documented 100-char cap.
    const out = mapMemoryEntryToWriteOptions(makeEntry('episodic', 0.3, 'x'.repeat(150), ''));
    expect(out.title.length).toBe(100);
  });

  it('defaults projectId to "default"', () => {
    const out = mapMemoryEntryToWriteOptions(makeEntry('episodic', 0.5));
    expect(out.projectId).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — threeLayerMemory.add() → memoryStore
// ---------------------------------------------------------------------------

describe('threeLayerMemory.add() routes to MemoryStore (Phase A)', () => {
  let store: MemoryStoreFacade;
  let writes: Promise<unknown>[];
  let deletes: Promise<unknown>[];

  beforeEach(async () => {
    store = new MemoryStoreFacade(new InMemoryMemoryService(), '__default__');

    // Deterministic promise capture for fire-and-forget writes (Phase A).
    writes = [];
    const original = store.write.bind(store);
    const spy = vi.spyOn(store, 'write');
    spy.mockImplementation((opts) => {
      const p = original(opts);
      writes.push(p);
      return p;
    });

    // Deterministic promise capture for fire-and-forget deletes (Phase B).
    deletes = [];
    const deleteOriginal = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation((id, pid) => {
      const p = deleteOriginal(id, pid);
      deletes.push(p);
      return p;
    });
  });

  afterEach(async () => {
    await store.close();
  });

  // Belt-and-braces: even if a test fails or the file is interrupted mid-run,
  // no later test in this file should observe a wired singleton from us.
  afterAll(() => {
    wireGlobalThreeLayerMemory(null);
    resetGlobalThreeLayerMemory();
    vi.restoreAllMocks();
  });

  it('routes non-working writes through memoryStore; skips working', async () => {
    const m = createThreeLayerMemory({ memoryStore: store });

    m.add('Working note', 'working', 'wc', 0.5, ['t']);
    m.add('Episodic 1', 'episodic', 'ec', 0.5, ['t']);
    m.add('Longterm 1', 'longterm', 'lc', 0.8, ['t']);
    m.add('Procedural 1', 'procedural', 'pc', 0.6, ['t']);

    // In-Memory Map holds all four
    expect(
      m
        .getAll()
        .map((e) => e.layer)
        .sort(),
    ).toEqual(['episodic', 'longterm', 'procedural', 'working']);

    // MemoryStore.write was called only for non-working layers
    expect(writes).toHaveLength(3);

    await Promise.all(writes);

    const result = await store.search({ projectId: 'default', limit: 100 });
    expect(result.items).toHaveLength(3);
    const durations = result.items.map((i) => i.duration).sort();
    expect(durations).toEqual(['EPISODIC', 'EPISODIC', 'LONG_TERM']);
  });

  it('working-only writes do not call memoryStore.write', async () => {
    const m = createThreeLayerMemory({ memoryStore: store });
    m.add('Only working', 'working', 'wc', 0.5);
    expect(writes).toHaveLength(0);

    await new Promise((r) => setImmediate(r));
    const result = await store.search({ projectId: 'default', limit: 100 });
    expect(result.items).toHaveLength(0);
  });

  it('setMemoryStore(null) disables route-out at runtime', async () => {
    const m = createThreeLayerMemory({ memoryStore: store });
    m.setMemoryStore(null);

    m.add('Episodic 2', 'episodic', 'ec', 0.5);
    m.add('Longterm 2', 'longterm', 'lc', 0.8);
    expect(writes).toHaveLength(0);
  });

  it('replaces a memoryStore: subsequent writes use the new store', async () => {
    const otherStore = new MemoryStoreFacade(new InMemoryMemoryService(), '__default__');
    const otherWrites: Promise<unknown>[] = [];
    const otherOriginal = otherStore.write.bind(otherStore);
    vi.spyOn(otherStore, 'write').mockImplementation((opts) => {
      const p = otherOriginal(opts);
      otherWrites.push(p);
      return p;
    });

    try {
      const m = createThreeLayerMemory({ memoryStore: store });
      m.add('Episodic to first store', 'episodic', 'ec', 0.5);

      m.setMemoryStore(otherStore);
      m.add('Episodic to second store', 'episodic', 'ec2', 0.5);

      await Promise.all([...writes, ...otherWrites]);

      // First store holds the first entry only
      const firstResult = await store.search({ projectId: 'default', limit: 100 });
      expect(firstResult.items).toHaveLength(1);

      // Second store holds the second entry only
      const secondResult = await otherStore.search({ projectId: 'default', limit: 100 });
      expect(secondResult.items).toHaveLength(1);
    } finally {
      await otherStore.close();
    }
  });

  it('a ThreeLayerMemory without memoryStore stays file/disk inert', async () => {
    const m = createThreeLayerMemory({}); // no memoryStore, no persistPath
    m.add('Episodic no-store', 'episodic', 'ec', 0.5);
    m.add('Longterm no-store', 'longterm', 'lc', 0.8);

    // No memoryStore ref → no writes captured (spy never invoked)
    expect(writes).toHaveLength(0);
    // No persistPath → no JSON file written
  });

  it('route-out .catch branch logs structured context and never throws', async () => {
    // Override the capture-spy with a rejection so the production `.catch`
    // branch fires. The spy is re-applied in beforeEach; we override here.
    vi.spyOn(store, 'write').mockImplementation(() => Promise.reject(new Error('boom')));

    // Spy on the global logger's .warn to verify the catch handler actively
    // logs structured context (a silently-dropped rejection would pass an
    // `expect(...).not.toThrow()` check alone — this proves the handler ran).
    const warnSpy = vi.spyOn(getGlobalLogger(), 'warn');
    warnSpy.mockClear();

    const m = createThreeLayerMemory({ memoryStore: store });
    // add() is synchronous; the sync portion must not throw even when the
    // async route-out will reject.
    expect(() => m.add('Will fail to persist', 'episodic', 'ec', 0.5)).not.toThrow();

    // Flush microtasks so the .catch consumer runs and logs.
    await new Promise((resolve) => setImmediate(resolve));

    // Strengthen (audit MED item 1 review bullet 2): prove the catch handler
    // actively logged with the expected structure, not just that nothing
    // escaped. The component name 'ThreeLayerMemory' and message fragment
    // 'route-out' guard against a refactor that drops the catch chain.
    const routeOutCalls = warnSpy.mock.calls.filter(
      (c) => c[0] === 'ThreeLayerMemory' && /route-out/.test(String(c[1] ?? '')),
    );
    expect(routeOutCalls.length).toBeGreaterThan(0);
    const ctx = routeOutCalls[0]?.[2] as
      { entryId?: string; layer?: string; error?: string } | undefined;
    expect(ctx?.entryId).toBeTruthy();
    expect(ctx?.layer).toBe('episodic');
    expect(ctx?.error).toMatch(/boom/);

    warnSpy.mockRestore();
  });

  it('wireGlobalThreeLayerMemory routes the singleton to a store', async () => {
    resetGlobalThreeLayerMemory();
    try {
      wireGlobalThreeLayerMemory(store);
      const m = getGlobalThreeLayerMemory();
      m.add('Singleton episodic', 'episodic', 'ec', 0.5);

      expect(writes).toHaveLength(1);
      await Promise.all(writes);

      const result = await store.search({ projectId: 'default', limit: 100 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].kind).toBe('SUMMARY');
      expect(result.items[0].duration).toBe('EPISODIC');
    } finally {
      wireGlobalThreeLayerMemory(null);
      resetGlobalThreeLayerMemory();
    }
  });

  // -------------------------------------------------------------------------
  // Phase B: in-memory tail drains to memoryStore when wired
  // -------------------------------------------------------------------------

  it('Phase B: evictIfNeeded fires memoryStore.delete for non-working layers', async () => {
    // Override the episodic-layer config so we hit the cap at 2 entries.
    // LayerConfig isn't exported (intentional encapsulation), so we inline
    // a structurally identical object — TypeScript structural typing accepts
    // it for the `Partial<Record<MemoryLayer, LayerConfig>>` slot.
    const episodicConfig = {
      maxEntries: 2,
      maxMemoryBytes: 500_000,
      decayRate: 0.05,
      baseDecayPerHour: 0.01,
      importanceBoost: 0.02,
    };

    const m = createThreeLayerMemory({ episodic: episodicConfig, memoryStore: store });

    m.add('low-importance', 'episodic', 'ec', 0.4);
    m.add('mid-importance', 'episodic', 'ec', 0.5);
    m.add('high-importance', 'episodic', 'ec', 0.9);

    // After the 3rd add, evictIfNeeded removes the lowest-composite-score entry.
    expect(m.getByLayer('episodic')).toHaveLength(2);
    // Phase B contract: 1 delete call against memoryStore for the evicted entry.
    expect(deletes).toHaveLength(1);

    // Wait for fire-and-forget deletes + writes before asserting persistent state.
    await Promise.all([...writes, ...deletes]);

    const result = await store.search({ projectId: 'default', limit: 100 });
    expect(result.items).toHaveLength(2);
    expect(result.items.find((i) => i.content === 'low-importance')).toBeUndefined();
    expect(result.items.find((i) => i.content === 'mid-importance')).toBeTruthy();
    expect(result.items.find((i) => i.content === 'high-importance')).toBeTruthy();
  });

  it('Phase B: evictIfNeeded does NOT call memoryStore.delete for working layer', async () => {
    // Working-layer override for fast cap saturation.
    const workingConfig = {
      maxEntries: 2,
      maxMemoryBytes: 100_000,
      decayRate: 0,
      baseDecayPerHour: 0,
      importanceBoost: 0,
    };

    const m = createThreeLayerMemory({ working: workingConfig, memoryStore: store });

    m.add('w1', 'working', 'wc', 0.1);
    m.add('w2', 'working', 'wc', 0.5);
    m.add('w3', 'working', 'wc', 0.9);

    expect(m.getByLayer('working')).toHaveLength(2);
    // CRITICAL: working layer is ephemeral session context. No delete call
    // is allowed against memoryStore — there was never a row in the first place.
    expect(deletes).toHaveLength(0);
    expect(writes).toHaveLength(0); // working is also excluded from Phase A writes

    await Promise.all(writes);
    const result = await store.search({ projectId: 'default', limit: 100 });
    expect(result.items).toHaveLength(0);
  });

  it('Phase B: applyTimeDecay returns 0 + keeps in-memory + does not delete when memoryStore wired', async () => {
    const m = createThreeLayerMemory({ memoryStore: store });
    // Low importance 0.3 so importanceBoost reduces little; large hoursElapsed
    // pushes decayScore from 1.0 to ~0 (decay-per-hour ≈ 0.01 * (1 - 0.3*0.02)).
    m.add('decaying', 'episodic', 'ec', 0.3);

    const evicted = m.applyTimeDecay(150); // ~150h * 0.00994 ≈ 1.49 drop > 1.0

    // MemoryCurator (single stack) owns TTL via deleteExpired. Three-layer doesn't delete.
    expect(evicted).toBe(0);
    expect(m.getAll()).toHaveLength(1);
    expect(deletes).toHaveLength(0);

    await Promise.all(writes);
    // Entry is still in memoryStore (TTL is the responsibility of the curator,
    // which would query and deleteExpired on its own schedule).
    const result = await store.search({ projectId: 'default', limit: 100 });
    expect(result.items).toHaveLength(1);
  });

  it('Phase B/back-compat: applyTimeDecay legacy deletes when no memoryStore', async () => {
    // No memoryStore wired — preserve pre-Phase-B in-memory-only behavior.
    const m = createThreeLayerMemory({});
    m.add('decaying-legacy', 'episodic', 'ec', 0.3);

    const evicted = m.applyTimeDecay(150);

    expect(evicted).toBe(1);
    expect(m.getAll()).toHaveLength(0);
  });

  it('Phase B: the .catch branch logs structured context for memoryStore.delete failures', async () => {
    // Override the delete-spy to reject, verifying the new evictIfNeeded
    // route-out-delete also has a structured-log catch branch.
    vi.spyOn(store, 'delete').mockImplementation(() => Promise.reject(new Error('boom')));

    const warnSpy = vi.spyOn(getGlobalLogger(), 'warn');
    warnSpy.mockClear();

    const episodicConfig = {
      maxEntries: 1,
      maxMemoryBytes: 500_000,
      decayRate: 0.05,
      baseDecayPerHour: 0.01,
      importanceBoost: 0.02,
    };
    const m = createThreeLayerMemory({ episodic: episodicConfig, memoryStore: store });
    // Both importance values > 0.3 to pass quickQualityCheck (entries < 0.3
    // would be rejected and never enter the in-memory Map).
    m.add('first', 'episodic', 'ec', 0.4);
    m.add('second', 'episodic', 'ec', 0.7); // forces evictIfNeeded → delete('first', ...)

    // Flush microtasks so the catch handler runs.
    await new Promise((resolve) => setImmediate(resolve));

    const evictCalls = warnSpy.mock.calls.filter(
      (c) => c[0] === 'ThreeLayerMemory' && /evict route-out/.test(String(c[1] ?? '')),
    );
    expect(evictCalls.length).toBeGreaterThan(0);
    const ctx = evictCalls[0]?.[2] as
      { entryId?: string; layer?: string; error?: string } | undefined;
    expect(ctx?.entryId).toBeTruthy();
    expect(ctx?.layer).toBe('episodic');
    expect(ctx?.error).toMatch(/boom/);

    warnSpy.mockRestore();
  });
});
