import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubPrBodyMarker } from '@commander/contracts';
import { createGitHubPullRequestCreateAdapter } from '../github/pullRequestCreate.js';
import type { AdapterCredentialProvider } from '../types.js';
import {
  createGitHubResponseCutFetch,
  GitHubResponseCutError,
  GitHubResponseCutPreconditionError,
  isSuccessfulGitHubCreateResponse,
  type GitHubResponseCutState,
} from './githubResponseCut.js';

const createUrl = 'https://api.github.com/repos/octo/repo/pulls';

function state(): GitHubResponseCutState {
  return {
    createRequestCount: 0,
    remoteCommitConfirmed: false,
    responseCutInjected: false,
  };
}

interface MockPull {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body: string;
  head: { ref: string };
  base: { ref: string };
}

function testCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      return 'gh-test-token';
    },
    async getServiceNowCredentials() {
      throw new Error('not used');
    },
  };
}

describe('GitHub response-cut harness', () => {
  it('requires an accepted HTTP 201 before marking a remote commit', async () => {
    assert.equal(isSuccessfulGitHubCreateResponse(new Response('{}', { status: 200 })), false);
    assert.equal(isSuccessfulGitHubCreateResponse(new Response('{}', { status: 201 })), true);

    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response('duplicate head/base', { status: 422 }),
      observed,
    );

    await assert.rejects(
      () => fetch(createUrl, { method: 'POST' }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubResponseCutPreconditionError);
        assert.equal(error.status, 422);
        return true;
      },
    );
    assert.equal(observed.createRequestCount, 1);
    assert.equal(observed.postStatus, 422);
    assert.equal(observed.remoteCommitConfirmed, false);
    assert.equal(observed.responseCutInjected, false);
  });

  it('cuts only after a successful create response', async () => {
    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
      observed,
    );

    await assert.rejects(
      () => fetch(createUrl, { method: 'POST' }),
      (error: unknown) => error instanceof GitHubResponseCutError,
    );
    assert.equal(observed.createRequestCount, 1);
    assert.equal(observed.postStatus, 201);
    assert.equal(observed.remoteCommitConfirmed, true);
    assert.equal(observed.responseCutInjected, true);
  });

  it('passes a successful response when injection is disabled', async () => {
    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
      observed,
      false,
    );

    const response = await fetch(createUrl, { method: 'POST' });
    assert.equal(response.status, 201);
    assert.equal(observed.remoteCommitConfirmed, true);
    assert.equal(observed.responseCutInjected, false);
  });
});

describe('GitHub response-cut recovery (runs by default, no live egress)', () => {
  it('recovers the committed PR via queryOutcome without a second create', async () => {
    const tenantId = 'tenant-a';
    const idempotencyKey = 'idem-response-cut';
    const destination = 'github://octo/repo/pulls';
    const pulls: MockPull[] = [];
    let createCount = 0;
    const backend = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/pulls?')) {
        return new Response(JSON.stringify(pulls), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        createCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          title: string;
          body: string;
          head: string;
          base: string;
        };
        const created: MockPull = {
          number: pulls.length + 1,
          html_url: `https://github.com/octo/repo/pull/${pulls.length + 1}`,
          state: 'open',
          title: body.title,
          body: body.body,
          head: { ref: body.head },
          base: { ref: body.base },
        };
        pulls.push(created);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    };

    // The cut harness is the adapter's fetch over a local backend, so the real
    // control (commit → cut → recover via queryOutcome) is proven without the
    // opt-in live test, which alone cannot run in CI.
    const observed = state();
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: testCredentials(),
      fetch: createGitHubResponseCutFetch(backend, observed),
    });

    await assert.rejects(
      () =>
        adapter.execute({
          tenantId,
          effectId: 'eff-response-cut',
          idempotencyKey,
          destination,
          args: { title: 'cut test', body: 'body', head: 'feature', base: 'main' },
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => error instanceof GitHubResponseCutError,
    );
    assert.equal(observed.postStatus, 201);
    assert.equal(observed.remoteCommitConfirmed, true);
    assert.equal(createCount, 1);
    assert.equal(pulls.length, 1, 'the remote commit happened before the cut');

    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-response-cut',
      idempotencyKey,
      destination,
      request: {},
    });
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(outcome.response?.prNumber, 1);
    assert.equal(createCount, 1, 'recovery must not issue a second create');
    assert.equal(
      pulls[0]!.body.includes(githubPrBodyMarker(tenantId, idempotencyKey)),
      true,
      'the committed body must carry the idempotency marker',
    );
  });
});
