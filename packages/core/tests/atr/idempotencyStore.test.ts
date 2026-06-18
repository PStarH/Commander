/**
 * IdempotencyStore tests — P0-1 ATR kernel component.
 *
 * Coverage:
 *   - begin: fresh acquire, double-begin (race), expired reclaim
 *   - complete / fail: state transitions, result/error persistence
 *   - get: hit / miss / expired
 *   - tenant isolation: same logical key, different tenants → independent records
 *   - canonical args: key invariant to key order
 *   - TTL: expired records reclaimable
 *   - eviction: size cap respected
 *   - canonicalJson: stability across key order, types, nested structures
 *   - generateIdempotencyKey: same input → same key, different input → different key
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { IdempotencyStore } from '../../src/atr/idempotencyStore';
import {
  canonicalJson,
  generateIdempotencyKey,
  hashIntent,
  sha256OfCanonical,
} from '../../src/atr/canonicalJson';

// ============================================================================
// Helpers
// ============================================================================

function newStore(ttlSeconds = 60): IdempotencyStore {
  return new IdempotencyStore({
    filePath: ':memory:',
    maxRecords: 1000,
    defaultTtlSeconds: ttlSeconds,
    evictEveryOps: 100_000, // disable auto-evict during tests
  });
}

// ============================================================================
// IdempotencyStore
// ============================================================================

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = newStore();
  });

  describe('begin', () => {
    it('acquires a fresh slot on first call', () => {
      const { acquired, record } = store.begin('key-a');
      assert.strictEqual(acquired, true);
      assert.strictEqual(record.state, 'in_progress');
      assert.strictEqual(record.key, 'key-a');
      assert.strictEqual(record.attemptCount, 1);
    });

    it('returns existing in_progress on concurrent call', () => {
      const first = store.begin('key-b');
      const second = store.begin('key-b');
      assert.strictEqual(first.acquired, true);
      assert.strictEqual(second.acquired, false);
      assert.strictEqual(second.record.state, 'in_progress');
      assert.strictEqual(
        second.record.attemptCount,
        1,
        'attempt count not incremented on concurrent in_progress',
      );
    });

    it('increments attempt count on reclaim of expired record', async () => {
      // short TTL
      const shortStore = new IdempotencyStore({
        filePath: ':memory:',
        defaultTtlSeconds: 1, // 1 second
        evictEveryOps: 100_000,
        maxRecords: 1000,
      });
      shortStore.begin('key-c', { toolName: 't' });
      shortStore.complete('key-c', 'done', { ttlSeconds: 1 });

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1100));

      const second = shortStore.begin('key-c', { toolName: 't' });
      assert.strictEqual(second.acquired, true, 'should reclaim expired record');
      assert.strictEqual(second.record.state, 'in_progress');
      assert.ok(second.record.attemptCount >= 2, 'attempt count should be >= 2');
      shortStore.close();
    });
  });

  describe('complete / fail', () => {
    it('transitions in_progress → completed with result', () => {
      store.begin('key-d');
      store.complete('key-d', 'result-payload');
      const rec = store.get('key-d');
      assert.strictEqual(rec?.state, 'completed');
      assert.strictEqual(rec?.result, 'result-payload');
      assert.ok(rec?.completedAt);
    });

    it('transitions in_progress → failed with error', () => {
      store.begin('key-e');
      store.fail('key-e', 'connection timeout');
      const rec = store.get('key-e');
      assert.strictEqual(rec?.state, 'failed');
      assert.strictEqual(rec?.error, 'connection timeout');
    });

    it('records tenant, run, tool metadata', () => {
      const { record } = store.begin('key-f', {
        tenantId: 'tenant-x',
        runId: 'run-123',
        toolName: 'github.create_pr',
      });
      assert.strictEqual(record.tenantId, 'tenant-x');
      assert.strictEqual(record.runId, 'run-123');
      assert.strictEqual(record.toolName, 'github.create_pr');
    });
  });

  describe('get', () => {
    it('returns null for missing key', () => {
      assert.strictEqual(store.get('nope'), null);
    });

    it('returns null for expired key', async () => {
      const shortStore = new IdempotencyStore({
        filePath: ':memory:',
        defaultTtlSeconds: 1,
        evictEveryOps: 100_000,
        maxRecords: 1000,
      });
      shortStore.begin('key-g', { ttlSeconds: 1 });
      shortStore.complete('key-g', 'x', { ttlSeconds: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      assert.strictEqual(shortStore.get('key-g'), null);
      shortStore.close();
    });
  });

  describe('tenant isolation', () => {
    it('keeps same key independent across tenants', () => {
      store.begin('shared-key', { tenantId: 'tenant-a' });
      store.begin('shared-key', { tenantId: 'tenant-b' });
      const a = store.get('shared-key', { tenantId: 'tenant-a' });
      const b = store.get('shared-key', { tenantId: 'tenant-b' });
      assert.strictEqual(a?.state, 'in_progress');
      assert.strictEqual(b?.state, 'in_progress');
      // They are stored as different physical keys; completing one doesn't affect the other
      store.complete('shared-key', 'a-result', { tenantId: 'tenant-a' });
      const aAfter = store.get('shared-key', { tenantId: 'tenant-a' });
      const bAfter = store.get('shared-key', { tenantId: 'tenant-b' });
      assert.strictEqual(aAfter?.state, 'completed');
      assert.strictEqual(bAfter?.state, 'in_progress');
    });
  });

  describe('replay semantics (the reason this exists)', () => {
    it('returns cached result on replay', () => {
      // First call: expensive side effect
      store.begin('expensive-action');
      store.complete('expensive-action', 'side-effect-happened-once');

      // Replay (e.g. after crash, restart, retry): must NOT re-execute
      const replay = store.begin('expensive-action');
      assert.strictEqual(replay.acquired, false);
      assert.strictEqual(replay.record.state, 'completed');
      assert.strictEqual(replay.record.result, 'side-effect-happened-once');
    });

    it('replay of failed action returns cached error', () => {
      store.begin('flaky-call');
      store.fail('flaky-call', '503 Service Unavailable');

      const replay = store.begin('flaky-call');
      assert.strictEqual(replay.acquired, false);
      assert.strictEqual(replay.record.state, 'failed');
      assert.strictEqual(replay.record.error, '503 Service Unavailable');
    });
  });

  describe('eviction', () => {
    it('removes expired records', async () => {
      const shortStore = new IdempotencyStore({
        filePath: ':memory:',
        defaultTtlSeconds: 1,
        evictEveryOps: 100_000,
        maxRecords: 1000,
      });
      shortStore.begin('key-h', { ttlSeconds: 1 });
      shortStore.begin('key-i', { ttlSeconds: 1 });
      assert.strictEqual(shortStore.size(), 2);
      await new Promise((r) => setTimeout(r, 1100));
      const evicted = shortStore.evict();
      assert.strictEqual(evicted, 2);
      assert.strictEqual(shortStore.size(), 0);
      shortStore.close();
    });

    it('trim-oldest when size exceeds maxRecords', () => {
      const tinyStore = new IdempotencyStore({
        filePath: ':memory:',
        defaultTtlSeconds: 60,
        evictEveryOps: 100_000,
        maxRecords: 3,
      });
      tinyStore.begin('k1');
      tinyStore.begin('k2');
      tinyStore.begin('k3');
      tinyStore.begin('k4');
      // Force eviction pass
      const evicted = tinyStore.evict();
      // trim to maxRecords
      tinyStore['maybeEvict']?.();
      // size should be <= 3 after manual trim
      assert.ok(tinyStore.size() <= 3, `size ${tinyStore.size()} should be <= 3`);
      tinyStore.close();
    });
  });
});

// ============================================================================
// canonicalJson
// ============================================================================

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    assert.strictEqual(a, b);
    assert.strictEqual(a, '{"a":2,"b":1}');
  });

  it('recurses into nested objects', () => {
    const a = canonicalJson({ x: { b: 1, a: 2 }, y: [3, 2] });
    const b = canonicalJson({ y: [3, 2], x: { a: 2, b: 1 } });
    assert.strictEqual(a, b);
  });

  it('serializes Date as ISO', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    const json = canonicalJson({ ts: d });
    assert.strictEqual(json, '{"ts":{"__type":"Date","value":"2024-01-01T00:00:00.000Z"}}');
  });

  it('serializes Map by sorted keys', () => {
    const m = new Map<string, unknown>();
    m.set('b', 1);
    m.set('a', 2);
    const json = canonicalJson(m);
    assert.strictEqual(json, '{"__type":"Map","a":2,"b":1}');
  });

  it('serializes Buffer as base64', () => {
    const buf = Buffer.from('hello');
    const json = canonicalJson(buf);
    assert.ok(json.includes('"__type":"Buffer"'));
    assert.ok(json.includes('"value":"aGVsbG8="'));
  });

  it('throws on non-finite numbers', () => {
    assert.throws(() => canonicalJson({ x: NaN }));
    assert.throws(() => canonicalJson({ x: Infinity }));
  });

  it('throws on functions', () => {
    assert.throws(() => canonicalJson({ x: () => 1 }));
  });
});

describe('sha256OfCanonical', () => {
  it('same input → same hash', () => {
    const h1 = sha256OfCanonical({ a: 1, b: 2 });
    const h2 = sha256OfCanonical({ b: 2, a: 1 });
    assert.strictEqual(h1, h2);
  });

  it('different input → different hash', () => {
    const h1 = sha256OfCanonical({ a: 1 });
    const h2 = sha256OfCanonical({ a: 2 });
    assert.notStrictEqual(h1, h2);
  });

  it('returns 64-char hex', () => {
    const h = sha256OfCanonical({ x: 1 });
    assert.strictEqual(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('hashIntent', () => {
  it('normalizes whitespace and case', () => {
    const a = hashIntent('  Open a PR   for the bug fix  ');
    const b = hashIntent('open a pr for the bug fix');
    assert.strictEqual(a, b);
  });

  it('different intent → different hash', () => {
    assert.notStrictEqual(hashIntent('open a PR'), hashIntent('close the PR'));
  });
});

// ============================================================================
// generateIdempotencyKey
// ============================================================================

describe('generateIdempotencyKey', () => {
  const baseInput = {
    externalSystem: 'github',
    toolName: 'create_pr',
    args: { repo: 'commander', head: 'feature/x', base: 'main' },
    intentHash: hashIntent('open a PR'),
    runId: 'run-1',
    stepId: 'step-3',
  };

  it('is deterministic for the same input', () => {
    const k1 = generateIdempotencyKey(baseInput);
    const k2 = generateIdempotencyKey(baseInput);
    assert.strictEqual(k1, k2);
  });

  it('is invariant to argument key ordering', () => {
    const reordered = {
      ...baseInput,
      args: { base: 'main', head: 'feature/x', repo: 'commander' },
    };
    assert.strictEqual(generateIdempotencyKey(baseInput), generateIdempotencyKey(reordered));
  });

  it('changes when tool name changes', () => {
    assert.notStrictEqual(
      generateIdempotencyKey(baseInput),
      generateIdempotencyKey({ ...baseInput, toolName: 'merge_pr' }),
    );
  });

  it('changes when args change', () => {
    assert.notStrictEqual(
      generateIdempotencyKey(baseInput),
      generateIdempotencyKey({
        ...baseInput,
        args: { ...baseInput.args, head: 'feature/y' },
      }),
    );
  });

  it('changes when step changes (allows same tool called multiple times in run)', () => {
    assert.notStrictEqual(
      generateIdempotencyKey(baseInput),
      generateIdempotencyKey({ ...baseInput, stepId: 'step-4' }),
    );
  });

  it('changes when run changes', () => {
    assert.notStrictEqual(
      generateIdempotencyKey(baseInput),
      generateIdempotencyKey({ ...baseInput, runId: 'run-2' }),
    );
  });

  it('changes when intent changes', () => {
    assert.notStrictEqual(
      generateIdempotencyKey(baseInput),
      generateIdempotencyKey({ ...baseInput, intentHash: hashIntent('close the PR') }),
    );
  });
});
