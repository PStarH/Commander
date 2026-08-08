import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Task1ReadinessProof,
  type Task1ReadinessRequest,
  type Task1ReadinessResponse,
} from '../src/task1ReadinessProof.js';

const challenge = Buffer.alloc(32, 7).toString('base64url');
const digest = (value: string): string => value.repeat(64).slice(0, 64);

class Response implements Task1ReadinessResponse {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  body = '';
  status(value: number): this { this.statusCode = value; return this; }
  setHeader(name: string, value: string): void { this.headers.set(name.toLowerCase(), value); }
  end(value = ''): void { this.body = value; }
}

function request(overrides: Partial<Task1ReadinessRequest> = {}): Task1ReadinessRequest {
  return {
    method: 'GET',
    url: '/ready/tenant-authority/v1',
    rawHeaders: [],
    ...overrides,
  };
}

function fixture() {
  let now = 1_000;
  const proof = new Task1ReadinessProof({
    nowMonotonicMs: () => now,
    installationId: 'installation-1',
    databasePeerBindingSha256: digest('d'),
    expectedPhase: 'enforce',
    expectedImageDigest: `sha256:${digest('a')}`,
    expectedConfigurationSha256: digest('c'),
  });
  proof.recordTenantSelfCheck(true);
  proof.recordRuntimeIdentity({
    operationVersion: '17',
    phase: 'enforce',
    imageDigest: `sha256:${digest('a')}`,
    configurationSha256: digest('c'),
  });
  return { proof, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('Task 1 challenged readiness proof', () => {
  it('serves only the exact GET path and handles non-GET before middleware', () => {
    const { proof } = fixture();
    for (const url of ['/ready/tenant-authority/v1/', '/ready//tenant-authority/v1', '/ready/tenant-authority/v1?x=1']) {
      const response = new Response();
      assert.equal(proof.handle(request({ url }), response), false);
      assert.equal(response.body, '');
    }
    const response = new Response();
    assert.equal(proof.handle(request({ method: 'OPTIONS' }), response), true);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });

  it('returns only ready status for a fresh no-challenge probe', () => {
    const { proof } = fixture();
    const response = new Response();
    assert.equal(proof.handle(request(), response), true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(response.body), { status: 'ready' });
  });

  it('rejects duplicate and malformed challenge headers', () => {
    const { proof } = fixture();
    for (const rawHeaders of [
      ['X-Commander-Readiness-Challenge', challenge, 'x-commander-readiness-challenge', challenge],
      ['X-Commander-Readiness-Challenge', 'not-base64url'],
    ]) {
      const response = new Response();
      proof.handle(request({ rawHeaders }), response);
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, '');
    }
  });

  it('echoes a fresh challenge with only the sealed current identity', () => {
    const { proof } = fixture();
    const response = new Response();
    proof.handle(request({ rawHeaders: ['X-Commander-Readiness-Challenge', challenge] }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      challenge,
      operationVersion: '17',
      phase: 'enforce',
      installationId: 'installation-1',
      databasePeerBindingSha256: digest('d'),
      imageDigest: `sha256:${digest('a')}`,
      configurationSha256: digest('c'),
    });
  });

  it('fails challenged requests closed after identity expiry or environment mismatch', () => {
    const state = fixture();
    state.advance(1_001);
    let response = new Response();
    state.proof.handle(request({ rawHeaders: ['X-Commander-Readiness-Challenge', challenge] }), response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body, '');

    state.proof.recordRuntimeIdentity({
      operationVersion: '18', phase: 'enforce', imageDigest: `sha256:${digest('a')}`,
      configurationSha256: digest('f'),
    });
    response = new Response();
    state.proof.handle(request({ rawHeaders: ['X-Commander-Readiness-Challenge', challenge] }), response);
    assert.equal(response.statusCode, 503);
  });

  it('invalidates both probe forms immediately on a self-check failure', () => {
    const { proof } = fixture();
    proof.recordTenantSelfCheck(false);
    for (const rawHeaders of [[], ['X-Commander-Readiness-Challenge', challenge]]) {
      const response = new Response();
      proof.handle(request({ rawHeaders }), response);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body, '');
    }
  });
});
