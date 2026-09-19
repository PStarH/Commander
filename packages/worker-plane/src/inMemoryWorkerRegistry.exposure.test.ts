/**
 * WP-14: `registry.ts` documented `InMemoryWorkerRegistry` as "deliberately not
 * exported from the package root" while `index.ts` exported it, so the test-only
 * implementation (no persistence, no RLS, no secret hashing) was reachable from the
 * published surface. It also compared claim secrets with `!==`, which short-circuits
 * on the first differing byte.
 *
 * The class stays available at its source path for tests; only the package-root
 * re-export is removed, and the comparison is now constant time.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as packageRoot from './index.js';
import { InMemoryWorkerRegistry } from './registry.js';

const REGISTRY_SOURCE = readFileSync(
  fileURLToPath(new URL('./registry.ts', import.meta.url)),
  'utf8',
);

describe('InMemoryWorkerRegistry exposure and claim-secret comparison (WP-14)', () => {
  it('is not re-exported from the package root', () => {
    assert.equal(
      (packageRoot as Record<string, unknown>).InMemoryWorkerRegistry,
      undefined,
      'the test-only registry must not be part of the published package surface',
    );
  });

  it('keeps the class importable from its source module for tests', () => {
    assert.equal(typeof InMemoryWorkerRegistry, 'function');
  });

  it('compares claim secrets in constant time instead of with !==', () => {
    assert.match(REGISTRY_SOURCE, /timingSafeEqual/);
    assert.doesNotMatch(REGISTRY_SOURCE, /claimSecret\s*!==\s*expected/);
    assert.doesNotMatch(REGISTRY_SOURCE, /previousClaimSecret\s*!==\s*expected/);
  });

  it('still accepts the real claim secret and rejects a wrong one', async () => {
    const registry = new InMemoryWorkerRegistry();
    const registered = await registry.register(
      { id: 'w', kind: 'tool', version: '1', capabilities: ['tool'], maxConcurrency: 1 },
      'subject',
      ['tenant-1'],
    );
    const secret = registered.claimSecret;
    assert.equal(typeof secret, 'string');

    assert.equal(await registry.heartbeat('w', 1, 0, 'wrong-secret'), null);
    assert.equal(await registry.drain('w', 1, 'wrong-secret'), false);

    const heartbeat = await registry.heartbeat('w', 1, 0, secret as string);
    assert.equal(heartbeat?.id, 'w');
    assert.equal(await registry.drain('w', 1, secret as string), true);
  });
});
