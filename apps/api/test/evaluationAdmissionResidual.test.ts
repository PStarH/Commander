/**
 * LM-28 — evaluation admission: an ungoverned paid execution path must not be
 * reachable from the production assembly.
 *
 * Before this change `createProductionLLMCall()` built its own OpenAI/Anthropic
 * client and called `fetch()` directly: no deadline, no cost authority, no
 * settlement, and the provider response body was echoed into error messages.
 *
 * These tests pin the fail-closed contract:
 *   - with no governed judge adapter, zero network I/O and a stable non-2xx;
 *   - `COMMANDER_EVAL_MOCK` is not a production fallback;
 *   - a wired adapter is called with a deadline signal, and its failures are
 *     surfaced as stable codes without leaking upstream text;
 *   - an unusable judge response fails instead of fabricating a score.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import {
  createEvaluationRouter,
  createProductionLLMCall,
  DEFAULT_JUDGE_TIMEOUT_MS,
  EvaluationUnavailableError,
  EVALUATION_JUDGE_FAILED,
  EVALUATION_NOT_AVAILABLE,
  type GovernedJudgeAdapter,
} from '../src/evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from '../src/evaluation';

/** A judge response shaped like a valid LLM-as-Judge verdict. */
const VALID_JUDGE_JSON = JSON.stringify({ score: 4, explanation: 'ok' });

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind'));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * Replace global `fetch` with a recorder that only intercepts **external**
 * egress. Requests to the local express fixture used by this test are passed
 * through to the real implementation; anything else is recorded and refused.
 */
function withFetchRecorder<T>(fn: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) {
      return original(input as RequestInfo, init as RequestInit);
    }
    calls.push(url);
    throw new Error('network egress is not permitted in this test');
  }) as typeof globalThis.fetch;
  return fn()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

async function postEvaluate(
  llmCall: (prompt: string) => Promise<string>,
  path = '/evaluation/evaluate',
  body: unknown = {
    targetId: 't-1',
    input: 'q',
    output: 'a',
    criteria: ['clarity'],
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/evaluation', createEvaluationRouter(new LLMEvaluator(), new ScoreSmoother(), llmCall));
  const { port, close } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await close();
  }
}

const originalEvalMock = process.env.COMMANDER_EVAL_MOCK;
afterEach(() => {
  if (originalEvalMock === undefined) delete process.env.COMMANDER_EVAL_MOCK;
  else process.env.COMMANDER_EVAL_MOCK = originalEvalMock;
});

describe('LM-28: no governed judge wired', () => {
  it('fails closed with EVALUATION_NOT_AVAILABLE and performs zero network I/O', async () => {
    const { result, calls } = await withFetchRecorder(async () => {
      const judge = createProductionLLMCall();
      try {
        await judge('score this');
        return 'resolved' as const;
      } catch (err) {
        assert.ok(err instanceof EvaluationUnavailableError, 'expected EvaluationUnavailableError');
        return err.code;
      }
    });

    assert.equal(result, EVALUATION_NOT_AVAILABLE);
    assert.deepEqual(calls, [], 'an ungoverned judge must not reach the network');
  });

  it('does not treat COMMANDER_EVAL_MOCK=true as a production fallback', async () => {
    process.env.COMMANDER_EVAL_MOCK = 'true';
    const judge = createProductionLLMCall();
    await assert.rejects(
      () => judge('score this'),
      (err: unknown) =>
        err instanceof EvaluationUnavailableError && err.code === EVALUATION_NOT_AVAILABLE,
    );
  });

  it('returns a stable 503 from POST /evaluate with no provider text', async () => {
    const { result, calls } = await withFetchRecorder(() =>
      postEvaluate(createProductionLLMCall()),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error, EVALUATION_NOT_AVAILABLE);
    // The response must not echo any upstream/host configuration detail.
    assert.equal(JSON.stringify(result.body).includes('API_KEY'), false);
    assert.deepEqual(calls, []);
  });

  it('returns a stable 503 from POST /evaluate/quick', async () => {
    const { result, calls } = await withFetchRecorder(() =>
      postEvaluate(createProductionLLMCall(), '/evaluation/evaluate/quick', {
        targetId: 't-1',
        input: 'q',
        output: 'a',
      }),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error, EVALUATION_NOT_AVAILABLE);
    assert.deepEqual(calls, []);
  });

  it('reports a per-item stable code for a batch, never provider text', async () => {
    const { result, calls } = await withFetchRecorder(() =>
      postEvaluate(createProductionLLMCall(), '/evaluation/evaluate/batch', {
        items: [
          { targetId: 't-1', input: 'q', output: 'a', criteria: ['clarity'] },
          { targetId: 't-2', input: 'q', output: 'a', criteria: ['accuracy'] },
        ],
      }),
    );
    assert.equal(result.status, 200);
    const results = result.body.results as Record<string, { error: string }>;
    assert.equal(results['t-1'].error, EVALUATION_NOT_AVAILABLE);
    assert.equal(results['t-2'].error, EVALUATION_NOT_AVAILABLE);
    assert.deepEqual(calls, []);
  });
});

describe('LM-28: a governed adapter is called under a deadline', () => {
  it('returns the judge text when the adapter succeeds', async () => {
    const adapter: GovernedJudgeAdapter = {
      call: async () => VALID_JUDGE_JSON,
    };
    const judge = createProductionLLMCall(adapter);
    assert.equal(await judge('score this'), VALID_JUDGE_JSON);
  });

  it('passes an AbortSignal that is not yet aborted', async () => {
    let sawSignal = false;
    let abortedAtCall: boolean | null = null;
    const adapter: GovernedJudgeAdapter = {
      call: async (_prompt, { signal }) => {
        sawSignal = signal instanceof AbortSignal;
        abortedAtCall = signal.aborted;
        return VALID_JUDGE_JSON;
      },
    };
    await createProductionLLMCall(adapter)('score this');
    assert.equal(sawSignal, true, 'adapter must receive an AbortSignal');
    assert.equal(abortedAtCall, false, 'signal must be live when the call starts');
  });

  it('aborts the adapter when it exceeds the deadline', async () => {
    let observedAbort = false;
    const adapter: GovernedJudgeAdapter = {
      call: (_prompt, { signal }) =>
        new Promise<string>((_resolve, reject) => {
          // `AbortSignal.timeout()` uses an unref'd timer, so the test must keep
          // the loop alive itself; otherwise the pending promise is reported as
          // "event loop has already resolved" instead of as a real failure.
          const keepAlive = setTimeout(
            () => reject(new Error('deadline did not fire within the test bound')),
            5_000,
          );
          signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            observedAbort = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const judge = createProductionLLMCall(adapter, { timeoutMs: 25 });
    await assert.rejects(
      () => judge('score this'),
      (err: unknown) =>
        err instanceof EvaluationUnavailableError && err.code === EVALUATION_JUDGE_FAILED,
    );
    assert.equal(observedAbort, true, 'the deadline must abort the in-flight adapter call');
  });

  it('falls back to the safe default deadline for NaN / zero / negative timeouts', async () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      let aborted = false;
      const adapter: GovernedJudgeAdapter = {
        call: (_prompt, { signal }) =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            // Resolve well before any plausible deadline.
            setTimeout(() => resolve(VALID_JUDGE_JSON), 1);
          }),
      };
      const judge = createProductionLLMCall(adapter, { timeoutMs: bad as number });
      assert.equal(await judge('score this'), VALID_JUDGE_JSON);
      assert.equal(aborted, false, `timeout ${String(bad)} must not disable the deadline`);
    }
    assert.ok(DEFAULT_JUDGE_TIMEOUT_MS > 0);
  });

  it('does not leak the adapter error text into the surfaced message', async () => {
    const secret = 'sk-live-DO-NOT-ECHO-provider-body';
    const adapter: GovernedJudgeAdapter = {
      call: async () => {
        throw new Error(`upstream said: ${secret}`);
      },
    };
    const judge = createProductionLLMCall(adapter);
    await assert.rejects(
      () => judge('score this'),
      (err: unknown) => {
        assert.ok(err instanceof EvaluationUnavailableError);
        assert.equal(err.code, EVALUATION_JUDGE_FAILED);
        assert.equal(err.message.includes(secret), false, 'upstream text must not be forwarded');
        return true;
      },
    );
  });

  it('fails instead of fabricating a score when the judge returns an empty response', async () => {
    const adapter: GovernedJudgeAdapter = { call: async () => '   ' };
    const judge = createProductionLLMCall(adapter);
    await assert.rejects(
      () => judge('score this'),
      (err: unknown) =>
        err instanceof EvaluationUnavailableError && err.code === EVALUATION_JUDGE_FAILED,
    );
  });

  it('surfaces a stable code through the router without upstream text', async () => {
    const secret = 'provider-body-SHOULD-NOT-APPEAR';
    const adapter: GovernedJudgeAdapter = {
      call: async () => {
        throw new Error(secret);
      },
    };
    const { result } = await withFetchRecorder(() =>
      postEvaluate(createProductionLLMCall(adapter)),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error, EVALUATION_JUDGE_FAILED);
    assert.equal(JSON.stringify(result.body).includes(secret), false);
  });
});
