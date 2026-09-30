/**
 * WEB-03: an OIDC implicit-flow callback must only be exchanged when an
 * explicit SSO login stored a NON-EMPTY state and the returned state matches it
 * exactly. Without a stored attempt (or with unreadable storage) the callback
 * is an unsolicited token drop and must be rejected without touching the
 * network. The stored attempt is consumed on every callback so a captured
 * fragment cannot be replayed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleOIDCCallback, type OIDCStateStorage } from '../src/pages/LoginPage';

const OIDC_STATE_KEY = 'commander.oidc.state';

interface FakeStorage extends OIDCStateStorage {
  stored(): string | null;
}

function createStorage(initial: string | null = null): FakeStorage {
  let value = initial;
  return {
    getItem: (key) => (key === OIDC_STATE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === OIDC_STATE_KEY) value = next;
    },
    removeItem: (key) => {
      if (key === OIDC_STATE_KEY) value = null;
    },
    stored: () => value,
  };
}

interface RunResult {
  exchanged: string[];
  rejected: string[];
  exchangeStarts: number;
  authenticated: () => { token: string; refreshToken: string } | null;
  urlClears: () => number;
}

function run(hash: string, storage: OIDCStateStorage | null): RunResult {
  const exchanged: string[] = [];
  const rejected: string[] = [];
  let exchangeStarts = 0;
  let authenticated: { token: string; refreshToken: string } | null = null;
  let urlClears = 0;

  handleOIDCCallback({
    hash,
    storage,
    clearCallbackUrl: () => {
      urlClears++;
    },
    exchange: async (idToken) => {
      exchanged.push(idToken);
      return { token: 'commander-token', refreshToken: 'commander-refresh' };
    },
    onExchangeStart: () => {
      exchangeStarts++;
    },
    onAuthenticated: (response) => {
      authenticated = response;
    },
    onRejected: (message) => {
      rejected.push(message);
    },
  });

  return {
    exchanged,
    rejected,
    exchangeStarts,
    authenticated: () => authenticated,
    urlClears: () => urlClears,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('handleOIDCCallback (WEB-03)', () => {
  it('rejects an unsolicited callback with no stored state and exchanges nothing', () => {
    const storage = createStorage(null);
    const result = run('#id_token=attacker.id.token&state=attacker-state', storage);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.exchangeStarts, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0], /could not be verified/);
    assert.equal(result.urlClears(), 1);
  });

  it('rejects a callback without a state parameter even when a state was stored', () => {
    const storage = createStorage('expected-state');
    const result = run('#id_token=attacker.id.token', storage);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(storage.stored(), null);
  });

  it('rejects a mismatched state and consumes the stored attempt', () => {
    const storage = createStorage('expected-state');
    const result = run('#id_token=attacker.id.token&state=other-state', storage);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.exchangeStarts, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0], /Invalid OIDC callback state/);
    assert.equal(storage.stored(), null);
    assert.equal(result.urlClears(), 1);
  });

  it('exchanges a matching state exactly once, consumes it, and cannot be replayed', async () => {
    const storage = createStorage('expected-state');
    const hash = '#id_token=valid.id.token&state=expected-state';
    const result = run(hash, storage);

    assert.deepEqual(result.exchanged, ['valid.id.token']);
    assert.equal(result.exchangeStarts, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(storage.stored(), null);
    assert.equal(result.urlClears(), 1);

    await flush();
    assert.deepEqual(result.authenticated(), {
      token: 'commander-token',
      refreshToken: 'commander-refresh',
    });

    // Replaying the same fragment must not trigger a second exchange.
    const replay = run(hash, storage);
    assert.deepEqual(replay.exchanged, []);
    assert.equal(replay.exchangeStarts, 0);
    assert.equal(replay.rejected.length, 1);
  });

  it('fails closed when sessionStorage is unavailable', () => {
    const result = run('#id_token=attacker.id.token&state=attacker-state', null);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0], /could not be verified/);
  });

  it('fails closed when reading the stored state throws', () => {
    const storage: OIDCStateStorage = {
      getItem: () => {
        throw new Error('storage denied');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const result = run('#id_token=attacker.id.token&state=attacker-state', storage);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.exchangeStarts, 0);
    assert.equal(result.rejected.length, 1);
  });

  it('fails closed when the stored state cannot be consumed', () => {
    const storage: OIDCStateStorage = {
      getItem: () => 'expected-state',
      setItem: () => undefined,
      removeItem: () => {
        throw new Error('storage denied');
      },
    };
    const result = run('#id_token=valid.id.token&state=expected-state', storage);

    assert.deepEqual(result.exchanged, []);
    assert.equal(result.exchangeStarts, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0], /could not be verified/);
  });

  it('ignores a hash without an id_token', () => {
    const storage = createStorage('expected-state');
    const result = run('#access_token=unused', storage);

    assert.deepEqual(result.exchanged, []);
    assert.deepEqual(result.rejected, []);
    assert.equal(storage.stored(), 'expected-state');
  });
});
