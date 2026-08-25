/**
 * AUDIT-W2: the global fetch interceptor must never attach the session
 * bearer token to a destination other than the configured API origin or a
 * same-origin request.
 */
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { isCommanderApiRequest, API_BASE } from '../src/api';

describe('isCommanderApiRequest (AUDIT-W2)', () => {
  beforeEach(() => {
    (globalThis as { location?: { origin: string } }).location = {
      origin: 'https://app.commander.example',
    };
  });

  test('same-origin relative path is an API request', () => {
    assert.equal(isCommanderApiRequest('/api/teams/t1/agents'), true);
  });

  test('absolute same-origin URL is an API request', () => {
    assert.equal(isCommanderApiRequest('https://app.commander.example/api/x'), true);
  });

  test('the configured API_BASE origin is an API request (default localhost:4000)', () => {
    assert.equal(isCommanderApiRequest(`${API_BASE}/api/v1/runs`), true);
  });

  test('external host is NOT an API request (baseline: token leaked there)', () => {
    // FAILING before the fix: the interceptor attached Authorization
    // unconditionally, sending the bearer token to arbitrary hosts.
    assert.equal(isCommanderApiRequest('https://evil.example/avatar.png'), false);
    assert.equal(isCommanderApiRequest('https://cdn.jsdelivr.net/lib.js'), false);
  });

  test('look-alike host is NOT an API request (origin match is exact)', () => {
    assert.equal(isCommanderApiRequest('https://app.commander.example.evil.io/x'), false);
  });

  test('unresolvable input refuses to attach', () => {
    (globalThis as { location?: unknown }).location = undefined;
    assert.equal(isCommanderApiRequest('not a url \u0000'), false);
  });
});
