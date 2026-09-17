// Regression tests for the web bundle's API origin resolution and token scope.
//
// The production image is built with `VITE_API_BASE_URL=""` (apps/web/Dockerfile)
// and served same-origin by nginx under `connect-src 'self'` (apps/web/nginx.conf).
// Two mistakes break that deployment and are pinned here:
//
//   * `|| 'http://localhost:4000'` — every deployed browser would call the end
//     user's own machine, off the production CSP.
//   * a bare relative base (`''`) — `new URL(API_BASE)` in the auth-origin check
//     and every `new URL(\`${API_BASE}/…\`)` query builder in src/api.ts throw.
//
// The helper under test takes the environment value and the browser location as
// explicit parameters, so no browser, DOM shim or network is involved.
//
// No package.json wiring is required: run with
//   node --import tsx --test scripts/web-api-origin.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEV_API_BASE,
  apiRequestTargetsOrigin,
  resolveApiBase,
  type BrowserLocationLike,
} from '../apps/web/src/lib/apiOrigin';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The deployment: bundle served by nginx on the deployment's own origin. */
const DEPLOYED: BrowserLocationLike = { origin: 'https://console.commander.example' };
const PROJECT_ID = 'project-war-room';

// ── VITE_API_BASE_URL resolution ──────────────────────────────────────────────

describe('resolveApiBase', () => {
  it('resolves an empty VITE_API_BASE_URL to the deployment origin, not the dev default', () => {
    const base = resolveApiBase('', DEPLOYED);
    assert.equal(base, DEPLOYED.origin);
    assert.notEqual(base, DEV_API_BASE);
    assert.doesNotMatch(base, /localhost/);
  });

  it('keeps the development default when the variable is undefined', () => {
    // `vite dev` without a .env file, and a plain `import` under Node.
    assert.equal(resolveApiBase(undefined, DEPLOYED), DEV_API_BASE);
    assert.equal(resolveApiBase(undefined, undefined), DEV_API_BASE);
  });

  it('uses a custom absolute API origin verbatim', () => {
    assert.equal(
      resolveApiBase('https://api.commander.example', DEPLOYED),
      'https://api.commander.example',
    );
    assert.equal(
      resolveApiBase('  https://api.commander.example  ', DEPLOYED),
      'https://api.commander.example',
    );
    assert.equal(
      resolveApiBase('https://api.commander.example', undefined),
      'https://api.commander.example',
    );
  });

  it('treats a blank value as empty and never invents a production origin', () => {
    assert.equal(resolveApiBase('   ', DEPLOYED), DEPLOYED.origin);
    // No usable browser origin (Node, or an opaque `file://` origin): the only
    // safe value is the pre-existing development default.
    assert.equal(resolveApiBase('', undefined), DEV_API_BASE);
    assert.equal(resolveApiBase('', { origin: 'null' }), DEV_API_BASE);
    assert.equal(resolveApiBase('', { origin: '  ' }), DEV_API_BASE);
  });

  it('reads a page origin from `location.origin` only', () => {
    const withHref: BrowserLocationLike = { href: 'https://console.commander.example/app/chat' };
    assert.equal(resolveApiBase('', withHref), DEV_API_BASE);
  });
});

// ── new URL(API_BASE …) query construction (src/api.ts) ───────────────────────

describe('query construction from the resolved base', () => {
  it('parses the base with a bare `new URL`, as the auth-origin check does', () => {
    const cases: Array<{ configured: string | undefined; expected: string }> = [
      { configured: '', expected: DEPLOYED.origin as string },
      { configured: undefined, expected: DEV_API_BASE },
      { configured: 'https://api.commander.example', expected: 'https://api.commander.example' },
    ];
    for (const { configured, expected } of cases) {
      const base = resolveApiBase(configured, DEPLOYED);
      assert.equal(
        new URL(base).origin,
        new URL(expected).origin,
        `base for ${String(configured)}`,
      );
    }
  });

  it('keeps search-parameter queries absolute and same-origin in a deployed bundle', () => {
    const base = resolveApiBase('', DEPLOYED);
    const url = new URL(`${base}/projects/${PROJECT_ID}/memory/search`);
    url.searchParams.set('limit', '24');
    url.searchParams.set('q', 'deploy');
    assert.equal(url.origin, DEPLOYED.origin);
    assert.equal(url.pathname, `/projects/${PROJECT_ID}/memory/search`);
    assert.equal(url.search, '?limit=24&q=deploy');
    assert.equal(
      url.toString(),
      `https://console.commander.example/projects/${PROJECT_ID}/memory/search?limit=24&q=deploy`,
    );
  });

  it('documents why the base is never left relative', () => {
    // The naive "empty means same-origin" reading: both throw, so every
    // `new URL(\`${API_BASE}/…\`)` caller would fail before it ever fetched.
    assert.throws(() => new URL(''));
    assert.throws(() => new URL('/api/chat'));
  });
});

// ── token scope (isCommanderApiRequest) ───────────────────────────────────────

describe('auth origin scope', () => {
  it('scopes the bearer token to the deployment origin when the env value is empty', () => {
    const base = resolveApiBase('', DEPLOYED);
    assert.equal(apiRequestTargetsOrigin(base, '/api/teams/t1/agents', DEPLOYED), true);
    assert.equal(apiRequestTargetsOrigin(base, `${base}/api/v1/runs`, DEPLOYED), true);
    assert.equal(apiRequestTargetsOrigin(base, new URL(`${base}/api/v1/runs`), DEPLOYED), true);
  });

  it('refuses every other host, including look-alikes', () => {
    const base = resolveApiBase('', DEPLOYED);
    assert.equal(apiRequestTargetsOrigin(base, 'https://evil.example/avatar.png', DEPLOYED), false);
    assert.equal(apiRequestTargetsOrigin(base, 'https://cdn.jsdelivr.net/lib.js', DEPLOYED), false);
    assert.equal(
      apiRequestTargetsOrigin(base, 'https://console.commander.example.evil.io/x', DEPLOYED),
      false,
    );
  });

  it('scopes to the configured API origin when one is set explicitly', () => {
    const apiOrigin = 'https://api.commander.example';
    const base = resolveApiBase(apiOrigin, DEPLOYED);
    assert.equal(apiRequestTargetsOrigin(base, `${apiOrigin}/v1/actions`, DEPLOYED), true);
    // The page's own origin stays in scope (same-origin requests carry no
    // cross-origin risk) …
    assert.equal(apiRequestTargetsOrigin(base, '/api/teams', DEPLOYED), true);
    // … and nothing else does.
    assert.equal(apiRequestTargetsOrigin(base, 'https://other.example/api', DEPLOYED), false);
    assert.equal(
      apiRequestTargetsOrigin(base, 'https://api.commander.example.evil.io/x', DEPLOYED),
      false,
    );
  });

  it('resolves relative paths against the page URL, not just its origin', () => {
    const page: BrowserLocationLike = {
      origin: DEPLOYED.origin,
      href: 'https://console.commander.example/app/chat',
    };
    assert.equal(apiRequestTargetsOrigin(resolveApiBase('', page), 'api/teams', page), true);
  });

  it('matches the configured origin even with no browser location', () => {
    assert.equal(
      apiRequestTargetsOrigin(DEV_API_BASE, 'http://localhost:4000/api/x', undefined),
      true,
    );
  });

  it('refuses to attach a token when the destination cannot be resolved', () => {
    const base = resolveApiBase('', DEPLOYED);
    // No browser location, relative path — nothing to resolve against.
    assert.equal(apiRequestTargetsOrigin(base, '/api/teams', undefined), false);
    assert.equal(apiRequestTargetsOrigin(base, 'not a url \u0000', undefined), false);
    // A malformed absolute URL fails closed even with a page origin available.
    assert.equal(apiRequestTargetsOrigin(base, 'https://[::1', DEPLOYED), false);
  });
});

// ── client wiring ─────────────────────────────────────────────────────────────

describe('client modules', () => {
  const apiSource = read('apps/web/src/api.ts');
  const actionsSource = read('apps/web/src/api/actions.ts');
  const helperSource = read('apps/web/src/lib/apiOrigin.ts');

  it('resolves the API base through the shared helper', () => {
    assert.match(apiSource, /from '\.\/lib\/apiOrigin'/);
    assert.match(apiSource, /export const API_BASE = resolveApiBase\(/);
    assert.match(actionsSource, /from '\.\.\/lib\/apiOrigin'/);
    assert.match(actionsSource, /const DEFAULT_API_BASE = resolveApiBase\(/);
  });

  it('still reads the VITE_API_BASE_URL build arg', () => {
    assert.match(apiSource, /VITE_API_BASE_URL/);
    assert.match(actionsSource, /VITE_API_BASE_URL/);
  });

  it('no longer falls back to the development API origin', () => {
    for (const [name, source] of [
      ['apps/web/src/api.ts', apiSource],
      ['apps/web/src/api/actions.ts', actionsSource],
    ] as const) {
      assert.doesNotMatch(source, /localhost:4000/, `${name} must not carry the dev API origin`);
      assert.doesNotMatch(
        source,
        /\|\|\s*'https?:\/\//,
        `${name} must not default to a URL literal`,
      );
    }
    // The single definition lives in the helper.
    assert.match(helperSource, /export const DEV_API_BASE = 'http:\/\/localhost:4000';/);
  });

  it('delegates the auth-origin decision to the shared helper', () => {
    assert.match(
      apiSource,
      /return apiRequestTargetsOrigin\(API_BASE, target, globalThis\.location\);/,
    );
  });
});
