/**
 * Smoke test for PersistentRateLimitStore — persistence layer for the
 * rate-limit middleware (audit MED item 3 follow-up).
 *
 * Validates:
 *   - set + get round-trip (write-through)
 *   - get auto-evicts expired rows
 *   - delete removes rows
 *   - cleanup removes only expired rows and returns the change count
 *   - listActive returns only non-expired rows, ordered by resetAt ASC,
 *     respects an optional LIMIT bound
 *   - countActive reports the number of unexpired rows
 *   - data survives a process restart (close → reopen → read)
 *
 * Uses Node's built-in test runner (matching the npm test script in
 * apps/api/package.json which is `node --test test/*.test.js`).
 *
 * IMPORTANT: better-sqlite3 is an OPTIONAL peerDependency for the api
 * package. If it isn't installed, skip the test suite rather than fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let PersistentRateLimitStore;
try {
  // eslint-disable-next-line global-require
  PersistentRateLimitStore =
    require('../dist/persistentRateLimitStore.js').PersistentRateLimitStore;
} catch (err) {
  // Dist artifacts missing (no `tsc` run) or better-sqlite3 missing — skip
  // the suite. The optional `better-sqlite3` peer dep is declared in
  // apps/api/package.json with peerDependenciesMeta.optional=true, so a
  // missing install is a valid scenario, not a test error.
  test('persistentRateLimitStore: SKIPPED (deps unavailable)', { skip: true }, () => {
    assert.fail(`persistentRateLimitStore could not be loaded: ${err.message}`);
  });
  return;
}

function makeStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-persist-test-'));
  const dbPath = path.join(tmp, 'rate-limit.sqlite');
  return { store: new PersistentRateLimitStore(dbPath), tmp, dbPath };
}

test('PersistentRateLimitStore: set + get round-trip', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('1.2.3.4', 5, now + 60_000);
    const row = store.get('1.2.3.4', now);
    assert.deepEqual(row, { count: 5, resetAt: now + 60_000 });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: get returns null for missing ip', () => {
  const { store, tmp } = makeStore();
  try {
    assert.equal(store.get('not-here', Date.now()), null);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: get evicts expired entries on read', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('1.2.3.4', 1, now - 100); // already expired
    assert.equal(store.get('1.2.3.4', now), null);
    // Second read still null; eviction is idempotent.
    assert.equal(store.get('1.2.3.4', now), null);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: delete removes row', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('to-delete', 1, now + 60_000);
    store.delete('to-delete');
    assert.equal(store.get('to-delete', now), null);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: cleanup removes only expired rows', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('fresh', 1, now + 60_000);
    store.set('expired1', 2, now - 100);
    store.set('expired2', 3, now - 200);
    const removed = store.cleanup(now);
    assert.equal(removed, 2);
    assert.deepEqual(store.get('fresh', now), { count: 1, resetAt: now + 60_000 });
    assert.equal(store.get('expired1', now), null);
    assert.equal(store.get('expired2', now), null);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: listActive returns non-expired rows ordered by resetAt ASC', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    // Insert in shuffled order so we can verify sort, not insertion order.
    store.set('later', 1, now + 120_000);
    store.set('expired', 9, now - 100);
    store.set('soonest', 2, now + 10_000);
    store.set('middle', 3, now + 60_000);
    const rows = store.listActive(now);
    assert.deepEqual(
      rows.map((r) => r.key),
      ['soonest', 'middle', 'later'],
    );
    assert.deepEqual(
      rows.map((r) => r.count),
      [2, 3, 1],
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: listActive respects optional limit', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      store.set(`ip-${i}`, i, now + 60_000 + i * 1000);
    }
    assert.equal(store.listActive(now, 5).length, 5);
    assert.equal(store.listActive(now, 0).length, 10); // limit <= 0 ignored
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: countActive counts unexpired rows only', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('a', 1, now + 60_000);
    store.set('b', 2, now + 60_000);
    store.set('c', 3, now - 100);
    assert.equal(store.countActive(now), 2);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: data survives restart (close → reopen → read)', () => {
  const { store, tmp, dbPath } = makeStore();
  try {
    const now = Date.now();
    store.set('persist', 7, now + 60_000);
    store.close();
    const reopened = new PersistentRateLimitStore(dbPath);
    try {
      assert.deepEqual(reopened.get('persist', now), { count: 7, resetAt: now + 60_000 });
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PersistentRateLimitStore: set upsert overwrites previous count', () => {
  const { store, tmp } = makeStore();
  try {
    const now = Date.now();
    store.set('a', 1, now + 60_000);
    store.set('a', 99, now + 60_000);
    assert.deepEqual(store.get('a', now), { count: 99, resetAt: now + 60_000 });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
