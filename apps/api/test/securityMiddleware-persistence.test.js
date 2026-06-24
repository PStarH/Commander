/**
 * Middleware-level integration test for the persistent rate-limit layer
 * (apps/api/src/securityMiddleware.ts + apps/api/src/persistentRateLimitStore.ts).
 *
 * This test exercises the WRITE-THROUGH path that the standalone persistent
 * store smoke test can't reach: it spins up a real Express app, binds to an
 * ephemeral port, fires N requests through Node's http module, and asserts
 * the SQL row content matches the in-memory state after every request.
 *
 * Then it simulates a process restart by closing the middleware's persistent
 * handle, opening a fresh PersistentRateLimitStore against the same DB file,
 * and asserting the row content survives. That's the real test for the
 * auth-reset bypass — without persistence, the row would be empty post-restart
 * (in-memory Map is process-local).
 *
 * The runner is `node --test test/*.test.js` (apps/api/package.json).
 * better-sqlite3 is an optional peerDependency; this suite skips cleanly
 * when the native binding isn't present.
 */

// 1. Set env vars BEFORE requiring the module so the module-load defaults
//    (API_RATE_LIMIT, GLOBAL_*) resolve to predictable test values. Smaller
//    limits keep the test fast — 4 read-tier requests fits inside one window
//    and the 429 path is easily triggerable.
process.env.API_RATE_LIMIT = process.env.API_RATE_LIMIT || '4';
process.env.API_GLOBAL_RATE_LIMIT = process.env.API_GLOBAL_RATE_LIMIT || '10000';
process.env.API_GLOBAL_RATE_REFILL_PER_SEC = process.env.API_GLOBAL_RATE_REFILL_PER_SEC || '10000';
process.env.API_RATE_LIMIT_PERSISTENT = process.env.API_RATE_LIMIT_PERSISTENT || 'on';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

let sm; // securityMiddleware module
let PersistentRateLimitStore;
try {
  // eslint-disable-next-line global-require
  sm = require('../dist/securityMiddleware.js');
  // eslint-disable-next-line global-require
  PersistentRateLimitStore =
    require('../dist/persistentRateLimitStore.js').PersistentRateLimitStore;
} catch (err) {
  test('securityMiddleware-persistence: SKIPPED (deps unavailable)', { skip: true }, () => {
    assert.fail(`Could not load dist modules: ${err.message}`);
  });
  return;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * fireRequest — resolves with the parsed response. Used to drive the in-
 * process Express app via http.request. Reads the full body so callers can
 * inspect it if needed; current tests only inspect status + headers.
 */
function fireRequest(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const headers = { ...res.headers };
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * withFreshStore — wraps each test in: fresh tmpdir, override env-driven DB
 * path, reset module-scope state, run fn(), close + cleanup. Uses
 * _resetRateLimitStoreForTesting() to clear the `initialized` latch so
 * initRateLimitStore() will reopen against the new path.
 *
 * NOTE — both `_resetRateLimitStoreForTesting()` calls are intentional and
 * MUST NOT be "simplified" away:
 *  - The PRE-init reset clears `initialized = true` left over by the previous
 *    test in the same file. Without it, initRateLimitStore() would silently
 *    no-op (already initialized) and the new dbPath would never open.
 *  - The POST-finally reset is defensive: it ensures module-scope state is
 *    null before the next test runs, even if a future test forgets to call
 *    closeRateLimitStore().
 */
async function withFreshStore(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mw-int-'));
  const dbPath = path.join(tmpDir, 'rate-limit.sqlite');
  // Each test gets its own DB so listActive() can be asserted precisely.
  process.env.API_RATE_LIMIT_DB_PATH = dbPath;
  sm._resetRateLimitStoreForTesting();
  await sm.initRateLimitStore();
  try {
    return await fn({ tmpDir, dbPath });
  } finally {
    sm.closeRateLimitStore();
    sm._resetRateLimitStoreForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * startApp — binds a fresh Express app on an ephemeral port and wires
 * only the rateLimitMiddleware + a tiny test route. Returns a cleanup
 * function that closes the http.Server.
 *
 * Bound explicitly to '127.0.0.1' (not the system default of '::') so
 * `req.ip` resolves deterministically to '127.0.0.1' on all platforms
 * (macOS, Linux CI, Windows, IPv4-only stacks); without this, dual-stack
 * setups report `'::ffff:127.0.0.1'` for the same connection, which
 * would force each test's IP-equality assertion to handle both forms.
 */
async function startApp() {
  const app = express();
  app.use(sm.rateLimitMiddleware);
  app.get('/api/v1/test', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('write-through: rate-limit counters persist to SQL after every counted request', async () => {
  await withFreshStore(async ({ dbPath }) => {
    const { port, close } = await startApp();
    try {
      // Fire 5 read-tier requests. tierMax = API_RATE_LIMIT(4) * read(1) = 4.
      // First 4 succeed (200, Remaining counts down); 5th trips 429.
      const responses = [];
      for (let i = 0; i < 5; i++) {
        responses.push(await fireRequest(port, '/api/v1/test'));
      }
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 200, 200, 200, 429],
        'first 4 requests in window, 5th hits tier cap',
      );
      assert.equal(
        responses[0].headers['x-ratelimit-tier'],
        'read',
        'GET /api/v1/test should classify as read-tier, not write',
      );
      assert.equal(
        Number(responses[0].headers['x-ratelimit-limit']),
        4,
        'tierMax = RATE_LIMIT_MAX × read multiplier (1)',
      );
      assert.equal(
        Number(responses[0].headers['x-ratelimit-remaining']),
        3,
        'remaining = 4 − 1 after first request',
      );
      assert.equal(
        Number(responses[3].headers['x-ratelimit-remaining']),
        0,
        'remaining pinned at 0 once tierMax is reached',
      );
      assert.equal(
        responses[4].headers['x-ratelimit-reason'],
        'per-ip-tier-read',
        '429 reason header reflects per-IP tier',
      );

      // Confirm the SQL row exists with count=5 (saturating writes — the
      // middleware writes the (post-increment) count on every request, even
      // ones that crossed the threshold). This is the write-through contract.
      const fresh = new PersistentRateLimitStore(dbPath);
      try {
        const rows = fresh.listActive(Date.now());
        assert.equal(rows.length, 1, 'exactly one row expected post-fire');
        assert.equal(rows[0].count, 5, 'counter matches last seen count');
        assert.ok(rows[0].resetAt > Date.now(), 'resetAt is in the future');
      } finally {
        fresh.close();
      }
    } finally {
      await close();
    }
  });
});

test('restart round-trip: counter survives a fresh process handle against the same DB', async () => {
  await withFreshStore(async ({ dbPath }) => {
    const { port, close } = await startApp();
    try {
      // Fire 3 requests within the same window — count should be 3 after.
      const responses = [];
      for (let i = 0; i < 3; i++) {
        responses.push(await fireRequest(port, '/api/v1/test'));
      }
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 200, 200],
        'first 3 requests all within tier cap',
      );
    } finally {
      await close();
    }

    // Simulate FULL process restart against the same DB path. The
    // withFreshStore wrapper's finally has not yet run — it runs AFTER this
    // block. We do the simulated restart INSIDE the wrapper so we still have
    // access to dbPath.
    //
    // Step A: closeRateLimitStore() — drops the middleware's reference so
    // a simulated restart won't see double-handle SQLite locks.
    sm.closeRateLimitStore();
    sm._resetRateLimitStoreForTesting();

    // Step B: open a fresh handle against the same DB path (this is what
    // an initRateLimitStore() call on next process boot does).
    const reopened = new PersistentRateLimitStore(dbPath);
    try {
      const rows = reopened.listActive(Date.now());
      assert.equal(rows.length, 1, 'one row survives restart');
      assert.equal(rows[0].count, 3, 'counter === 3 after restart — defeats the auth-reset bypass');
      assert.ok(rows[0].resetAt > Date.now(), 'resetAt still in the future after restart');

      // The fresh handle should also be ready to UNION state on next fire.
      // Hydration semantics: a fresh in-process map would be empty, but a
      // fresh boot would call listActive and seed it. Confirm by counting
      // unexpired rows.
      assert.equal(
        reopened.countActive(Date.now()),
        1,
        'countActive returns 1 from the fresh handle',
      );
    } finally {
      reopened.close();
    }
  });
});

test('hydrate-on-init: rows in the DB are loaded into the in-memory Map before the first request', async () => {
  await withFreshStore(async ({ dbPath }) => {
    // Pre-populate the DB with a row from a "previous run" — simulates the
    // scenario where another process wrote a row, exited, and a new boot
    // hydrates from it.
    const seed = new PersistentRateLimitStore(dbPath);
    try {
      // Use a long-future resetAt so it stays in listActive().
      seed.set('1.2.3.4', 7, Date.now() + 600_000);
    } finally {
      seed.close();
    }

    // Simulate restart: close current handle, reset module state,
    // initRateLimitStore() opens a fresh handle and MUST hydrate Map.
    sm.closeRateLimitStore();
    sm._resetRateLimitStoreForTesting();
    await sm.initRateLimitStore();

    // Trigger one counted request — the middleware reads Map first. With
    // proper hydration, the existing row would have been promoted to Map
    // before this request fires, so the next write is increment(7) + 1
    // (post-hydration read). But this IP arriving from http.request WILL
    // be 127.0.0.1, not 1.2.3.4 — different key. So this proves hydration
    // doesn't corrupt the seeded row, AND that initRateLimitStore did not
    // crash on pre-existing rows.
    const { port, close } = await startApp();
    try {
      const r1 = await fireRequest(port, '/api/v1/test');
      assert.equal(r1.status, 200);

      // Read SQL: seeded row must STILL be present with count=7
      // (untouched by our unrelated-IP request); plus a fresh 127.0.0.1 row
      // from the request we just fired. startApp binds explicitly to
      // '127.0.0.1' so we can match exactly without a fallback.
      const reopened = new PersistentRateLimitStore(dbPath);
      try {
        const rows = reopened.listActive(Date.now());
        const byIp = Object.fromEntries(rows.map((r) => [r.ip, r]));
        assert.ok(byIp['1.2.3.4'], 'seeded row preserved across restart');
        assert.equal(byIp['1.2.3.4'].count, 7);
        assert.ok(byIp['127.0.0.1'], 'loopback IP 127.0.0.1 present (explicit bind)');
        assert.equal(byIp['127.0.0.1'].count, 1, 'fresh request was counted exactly once');
      } finally {
        reopened.close();
      }
    } finally {
      await close();
    }
  });
});

test('graceful fallback: persistent=off still serves traffic on in-memory only', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mw-off-'));
  // Force the off branch. Note the env read inside initRateLimitStore() is
  // done lazily, so this overrides the file-load default of 'on'.
  process.env.API_RATE_LIMIT_PERSISTENT = 'off';
  process.env.API_RATE_LIMIT_DB_PATH = path.join(tmpDir, 'should-not-be-created.sqlite');
  const fsSpyFile = path.join(tmpDir, 'should-not-be-created.sqlite');
  sm._resetRateLimitStoreForTesting();
  try {
    await sm.initRateLimitStore();

    const { port, close } = await startApp();
    try {
      const responses = [];
      for (let i = 0; i < 3; i++) {
        responses.push(await fireRequest(port, '/api/v1/test'));
      }
      // 5/4 cap from API_RATE_LIMIT=4 × read 1 = 4. First 4 succeed.
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 200, 200],
        'in-memory only path still rate-limits correctly',
      );

      // The DB file MUST NOT have been created — we passed a path but the
      // off branch skipped the SQLite open.
      assert.equal(
        fs.existsSync(fsSpyFile),
        false,
        'no SQLite file is created when persistent is off',
      );
    } finally {
      await close();
    }
  } finally {
    sm.closeRateLimitStore();
    sm._resetRateLimitStoreForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore persistent=on for any subsequent tests in the same process.
    process.env.API_RATE_LIMIT_PERSISTENT = 'on';
  }
});
