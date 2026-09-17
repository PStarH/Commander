/**
 * WP-12: a token's capability entry used to *replace* `defaultCapabilities`
 * (`tokenCapabilities?.get(token) ?? defaultCapabilities`), so a token could hold a
 * capability the deployment's default set denies. The effective grant must be the
 * intersection — the token narrows the ceiling, it can never widen it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiKeyWorkerAuthenticator, WorkerAuthError } from './apiKeyAuthenticator.js';
import type { WorkerDefinition, WorkerIdentity } from './types.js';

const TOKEN = 'secret-token-12345678901234567890';

function identity(): WorkerIdentity {
  return {
    subject: 'worker:worker-1',
    token: TOKEN,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function definition(capabilities: string[]): WorkerDefinition {
  return {
    id: 'worker-1',
    kind: 'agent',
    version: '0.2.0',
    capabilities,
    maxConcurrency: 10,
  };
}

function authenticator(
  defaultCapabilities: string[],
  tokenCapabilities?: string[],
): ApiKeyWorkerAuthenticator {
  return new ApiKeyWorkerAuthenticator({
    validTokens: new Set([TOKEN]),
    defaultTenantIds: ['tenant-a'],
    defaultCapabilities,
    ...(tokenCapabilities === undefined
      ? {}
      : { tokenCapabilities: new Map([[TOKEN, tokenCapabilities]]) }),
  });
}

describe('ApiKeyWorkerAuthenticator capability ceiling (WP-12)', () => {
  it('denies a declared capability the token requests but the defaults deny', async () => {
    // Token asks for more than the ceiling; before the fix the token entry replaced
    // the ceiling, so `tool` was authorized and the worker was admitted with it.
    const auth = authenticator(['agent'], ['agent', 'tool', 'admin']);
    await assert.rejects(
      () => auth.authenticate(identity(), definition(['tool'])),
      (err: unknown) => err instanceof WorkerAuthError && err.code === 'CAPABILITY_DENIED',
    );
  });

  it('returns the intersection, not the token list', async () => {
    const auth = authenticator(['agent'], ['agent', 'tool', 'admin']);
    const result = await auth.authenticate(identity(), definition(['agent']));
    assert.deepEqual(result.capabilities, ['agent']);
  });

  it('falls back to the ceiling when the token has no capability entry', async () => {
    const auth = authenticator(['agent', 'tool']);
    const result = await auth.authenticate(identity(), definition(['agent', 'tool']));
    assert.deepEqual(result.capabilities, ['agent', 'tool']);
  });

  it('lets a token narrow a wildcard ceiling', async () => {
    const auth = authenticator(['*'], ['read']);
    const result = await auth.authenticate(identity(), definition(['read']));
    assert.deepEqual(result.capabilities, ['read']);
  });

  it('does not let a wildcard token widen a narrow ceiling', async () => {
    const auth = authenticator(['read'], ['*']);
    const result = await auth.authenticate(identity(), definition(['read']));
    assert.deepEqual(result.capabilities, ['read']);
    await assert.rejects(
      () => auth.authenticate(identity(), definition(['write'])),
      (err: unknown) => err instanceof WorkerAuthError && err.code === 'CAPABILITY_DENIED',
    );
  });

  it('fails closed when the intersection is empty', async () => {
    const auth = authenticator(['agent'], ['tool']);
    const result = await auth.authenticate(identity(), definition([]));
    assert.deepEqual(result.capabilities, []);
    await assert.rejects(
      () => auth.authenticate(identity(), definition(['agent'])),
      (err: unknown) => err instanceof WorkerAuthError && err.code === 'CAPABILITY_DENIED',
    );
  });
});
