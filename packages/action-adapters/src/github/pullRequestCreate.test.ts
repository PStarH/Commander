import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubPrBodyMarker } from '@commander/contracts';
import { AdapterExecutionError } from '@commander/effect-broker';
import { createGitHubPullRequestCreateAdapter } from './pullRequestCreate.js';
import { ActionAdapterRegistry } from '../registry.js';
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
  /** Error injection: force this HTTP status on the next create request. */
  injectCreateStatus?: number;
}

function createMockFetch(state: MockState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    // Error injection must be evaluated before the success handlers, otherwise
    // the branch is unreachable (the previous `X-Mock-Status` check sat after the
    // catch-all POST handler, and the adapter never sends that header anyway).
    if (method === 'POST' && url.endsWith('/pulls') && state.injectCreateStatus !== undefined) {
      return new Response('injected failure', { status: state.injectCreateStatus });
    }
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
        title: body.title,
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
    assert.equal(state.pulls[0]!.body.includes(githubPrBodyMarker(tenantId, idempotencyKey)), true);
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

  it('rejects same-key execution when title or body changes', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());

    await assert.rejects(
      () =>
        adapter.execute({
          ...baseInput(),
          args: { title: 'Changed PR', body: 'changed body', head: 'feature', base: 'main' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
        assert.equal(error.commitState, 'NOT_COMMITTED');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
    assert.equal(state.createCount, 1);
  });

  it('rejects same-key execution when head or base changes', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());

    for (const args of [
      { title: 'Test PR', body: 'body', head: 'other-feature', base: 'main' },
      { title: 'Test PR', body: 'body', head: 'feature', base: 'other-main' },
    ]) {
      await assert.rejects(
        () => adapter.execute({ ...baseInput(), args }),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
          assert.equal(error.commitState, 'NOT_COMMITTED');
          assert.equal(error.retryMode, 'NEVER');
          return true;
        },
      );
    }
    assert.equal(state.createCount, 1);
  });

  it('rejects same-key replay when the remote title is missing', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey);
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          body: `body\n\n${marker}`,
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
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
        assert.equal(error.commitState, 'NOT_COMMITTED');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
    assert.equal(state.createCount, 0);
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
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status === 'APPLIED') {
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
    assert.equal(outcome.status, 'APPLIED');
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

  it('does not record a write when the create request is rejected (mock error injection)', async () => {
    const state: MockState = {
      pulls: [],
      createCount: 0,
      writeCount: 0,
      injectCreateStatus: 500,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
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
    // The injected failure must actually have been reached, and a failed create
    // must never be counted as a remote write.
    assert.equal(state.createCount, 0);
    assert.equal(state.writeCount, 0);
    assert.equal(state.pulls.length, 0);
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

  it('classifies empty and non-object 2xx create bodies instead of throwing untyped errors', async () => {
    for (const body of [
      new Response('{}', { status: 201 }),
      new Response('', { status: 201 }),
      new Response('null', { status: 201 }),
    ]) {
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: async (input, init) =>
          (init?.method ?? 'GET') === 'GET' && String(input).includes('/pulls?')
            ? new Response(JSON.stringify([]), { status: 200 })
            : body,
      });
      await assert.rejects(
        () => adapter.execute(baseInput()),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.code, 'ADAPTER_RESPONSE_BODY_INVALID');
          assert.equal(error.commitState, 'UNKNOWN');
          assert.equal(error.retryMode, 'QUERY_FIRST');
          return true;
        },
      );
    }
  });
});

/**
 * The broker installs its effect deadline by aborting a controller and forwards
 * that signal through the adapter. `findByMarker`'s pre-flight GET previously
 * dropped it, so a delayed lookup outlived the deadline and the broker could not
 * settle or park the effect until the request finished on its own.
 */
describe('github.pullRequestCreate adapter — cancellation propagation', () => {
  /** Records the exact signal handed to each fetch call, and hangs GETs. */
  function createSignalRecordingFetch(seen: Array<AbortSignal | undefined>) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push(init?.signal ?? undefined);
      if (method === 'GET' && url.includes('/pulls?')) {
        const signal = init?.signal;
        // No signal => the request would hang forever; return promptly so a
        // regression shows up as a failed assertion, not a hung test.
        if (!signal) return new Response(JSON.stringify([]), { status: 200 });
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({
            number: 1,
            html_url: 'https://github.com/octo/repo/pull/1',
            state: 'open',
          }),
          { status: 201 },
        );
      }
      return new Response('unexpected', { status: 500 });
    };
  }

  it('the marker pre-flight GET carries the broker signal', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.execute({ ...baseInput(), signal: controller.signal });
    // Let the pre-flight GET reach fetch, then fire the effect deadline.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('effect deadline'));

    await assert.rejects(pending, 'the aborted pre-flight must settle the effect');
    assert.ok(seen.length > 0, 'the pre-flight GET must reach fetch');
    assert.equal(seen[0], controller.signal, 'the GET must receive the caller’s exact signal');
  });

  it('queryOutcome forwards its caller’s exact signal', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {},
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('reconcile deadline'));

    await assert.rejects(pending, 'an aborted reconciliation query must settle');
    assert.ok(seen.length > 0, 'the query must reach fetch');
    assert.equal(seen[0], controller.signal, 'the query must not invent a signal');
  });

  it('does not open a PR when the pre-flight is cancelled', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.execute({ ...baseInput(), signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('effect deadline'));
    await assert.rejects(pending);

    assert.equal(
      seen.some((s) => s === undefined),
      false,
      'no fetch call may run without the caller’s signal',
    );
  });
});

describe('github compensation reconciliation via the registry', () => {
  it('reads the governed forwardResponse so compensation can converge', async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'GET' && /\/pulls\/42$/.test(String(input))) {
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/octo/repo/pull/42',
            state: 'closed',
            body: null,
            head: { ref: 'feature' },
            base: { ref: 'main' },
          }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: fetchImpl,
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('compensate.github.pull-request.create');
    assert.ok(querier);
    const outcome = await querier.queryOutcome({
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      type: 'compensate.github.pull-request.create',
      tenantId,
      request: {
        originalEffectId: 'eff-1',
        destination,
        // The kernel constructs exactly this shape for governed compensations.
        forwardResponse: {
          prNumber: 42,
          url: 'https://github.com/octo/repo/pull/42',
          state: 'open',
        },
        compensationPatch: {},
      },
    });
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(outcome.response?.prNumber, 42);
  });
});
