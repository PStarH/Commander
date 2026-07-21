import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubPrBodyMarker } from '@commander/contracts';
import { AdapterExecutionError } from '@commander/effect-broker';
import { createGitHubPullRequestCreateAdapter } from './pullRequestCreate.js';
import type { AdapterCredentialProvider } from '../types.js';

const tenantId = 'tenant-a';
const destination = 'github://octo/repo/pulls';
const idempotencyKey = 'idem-1';

function mockCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      return 'gh-test-token';
    },
    async getServiceNowCredentials() {
      throw new Error('not used');
    },
  };
}

interface MockState {
  pulls: Array<{
    number: number;
    html_url: string;
    state: string;
    body: string;
    head: { ref: string };
    base: { ref: string };
  }>;
  createCount: number;
  writeCount: number;
}

function createMockFetch(state: MockState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/pulls?')) {
      return new Response(JSON.stringify(state.pulls), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/pulls')) {
      state.createCount += 1;
      state.writeCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      const created = {
        number: state.pulls.length + 1,
        html_url: `https://github.com/octo/repo/pull/${state.pulls.length + 1}`,
        state: 'open',
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      state.pulls.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    if (method === 'PATCH' && /\/pulls\/\d+$/.test(url)) {
      state.writeCount += 1;
      const number = Number(url.split('/').pop());
      const pull = state.pulls.find((entry) => entry.number === number);
      if (!pull) return new Response('not found', { status: 404 });
      pull.state = 'closed';
      return new Response(JSON.stringify(pull), { status: 200 });
    }
    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
      const number = Number(url.split('/').pop());
      const pull = state.pulls.find((entry) => entry.number === number);
      if (!pull) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(pull), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/pulls') && init?.headers) {
      const statusHeader = (init.headers as Record<string, string>)['X-Mock-Status'];
      if (statusHeader) {
        return new Response('error', { status: Number(statusHeader) });
      }
    }
    return new Response('unexpected', { status: 500 });
  };
}

function baseInput() {
  return {
    tenantId,
    effectId: 'eff-1',
    idempotencyKey,
    destination,
    args: { title: 'Test PR', body: 'body', head: 'feature', base: 'main' },
    signal: AbortSignal.timeout(5_000),
  };
}

describe('github.pullRequestCreate adapter', () => {
  it('injects marker into PR body on create', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const response = await adapter.execute(baseInput());
    assert.equal(state.createCount, 1);
    assert.match(state.pulls[0]!.body, /<!-- commander-action:/);
    assert.equal(response.prNumber, 1);
    assert.equal(
      state.pulls[0]!.body.includes(githubPrBodyMarker(tenantId, idempotencyKey)),
      true,
    );
  });

  it('double execute with same idempotency creates only one remote PR', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const input = baseInput();
    await adapter.execute(input);
    await adapter.execute(input);
    assert.equal(state.createCount, 1);
    assert.equal(state.pulls.length, 1);
  });

  it('queryOutcome lists by marker without write', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const fetch = createMockFetch(state);
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch,
    });
    await adapter.execute(baseInput());
    const writesBefore = state.writeCount;
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: { head: 'feature', base: 'main' },
    });
    assert.equal(state.writeCount, writesBefore);
    assert.equal(outcome.status, 'COMPLETED');
    if (outcome.status === 'COMPLETED') {
      assert.equal(outcome.response.prNumber, 1);
    }
  });

  it('compensate closes PR and queryCompensationOutcome observes closed state', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const forward = await adapter.execute(baseInput());
    const compensated = await adapter.compensate({
      tenantId,
      effectId: 'eff-cmp-1',
      originalEffectId: 'eff-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      forwardResponse: forward,
      compensationPatch: {},
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(compensated.state, 'closed');
    const outcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      request: { prNumber: forward.prNumber },
      compensationResponse: compensated,
    });
    assert.equal(outcome.status, 'COMPLETED');
  });

  it('maps 401/403 to NOT_COMMITTED NEVER', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async () => new Response('forbidden', { status: 403 }),
    });
    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'NOT_COMMITTED');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
  });

  it('maps 429/5xx to UNKNOWN QUERY_FIRST', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response('rate limited', { status: 429 });
        }
        return new Response('[]', { status: 200 });
      },
    });
    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
  });

  it('queryOutcome returns UNKNOWN with MULTI_MARKER_MATCH when multiple PRs share marker', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey);
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          body: marker,
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
        {
          number: 2,
          html_url: 'https://github.com/octo/repo/pull/2',
          state: 'open',
          body: marker,
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: { head: 'feature', base: 'main' },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('rejects GitHub destinations outside manifest charset', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch({ pulls: [], createCount: 0, writeCount: 0 }),
    });
    await assert.rejects(
      () =>
        adapter.execute({
          ...baseInput(),
          destination: 'github://octo/repo with space/pulls',
        }),
      /Invalid GitHub destination/,
    );
  });

  it('compensate refuses PR without Commander marker', async () => {
    const state: MockState = {
      pulls: [
        {
          number: 99,
          html_url: 'https://github.com/octo/repo/pull/99',
          state: 'open',
          body: 'unrelated human PR',
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'eff-cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.0.0',
          destination,
          forwardResponse: { prNumber: 99 },
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_COMPENSATE_MARKER_MISSING');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
    assert.equal(state.pulls[0]!.state, 'open');
    assert.equal(state.writeCount, 0);
  });

  it('compensate enforces exact marker when forwardResponse carries idempotencyKey', async () => {
    const state: MockState = {
      pulls: [
        {
          number: 7,
          html_url: 'https://github.com/octo/repo/pull/7',
          state: 'open',
          body: githubPrBodyMarker(tenantId, 'other-key'),
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'eff-cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.0.0',
          destination,
          forwardResponse: { prNumber: 7, idempotencyKey },
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_COMPENSATE_MARKER_MISMATCH');
        return true;
      },
    );
    assert.equal(state.pulls[0]!.state, 'open');
  });
});
