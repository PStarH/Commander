/**
 * AUDIT api-management#L2 — the evaluation criteria list bypassed the batch work
 * limit.
 *
 * Before this change the three evaluation entry points validated `criteria` by
 * truthiness and then **cast** it:
 *
 *     if (!targetId || !input || !output || !criteria || criteria.length === 0) …
 *     criteria: criteria as EvaluationCriterion[]
 *
 * A cast is not a check. `evaluateMulti` runs one judge call per criteria entry
 * (and a second, retry call when the first score is <= 2), so
 * `criteria: Array(10_000).fill('clarity')` fit inside the global body limit and
 * bought 10 000 paid calls from one authenticated request. The batch route
 * capped the *item* count at `MAX_BATCH_ITEMS` but never bounded each item's
 * criteria, and its three workers bound concurrency, not total work.
 *
 * These tests pin the fail-closed contract: every malformed request is rejected
 * **before the first judge call**, and the accepted criteria set is exactly the
 * set the API publishes at `GET /criteria`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import {
  createEvaluationRouter,
  MAX_BATCH_ITEMS,
  MAX_CRITERIA_PER_ITEM,
  MAX_CRITERIA_PER_REQUEST,
  MAX_EVALUATION_FIELD_CHARS,
} from '../src/evaluationEndpoints';
import { EVALUATION_CRITERIA, LLMEvaluator, ScoreSmoother } from '../src/evaluation';

/** A judge that records every call and always returns a healthy score. */
function countingJudge(score = 4): { calls: string[]; call: (p: string) => Promise<string> } {
  const calls: string[] = [];
  return {
    calls,
    call: async (prompt: string) => {
      calls.push(prompt);
      return JSON.stringify({ score, explanation: 'ok' });
    },
  };
}

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

interface Harness {
  post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  get: (path: string) => Promise<{ status: number; body: any }>;
  calls: string[];
  close: () => Promise<void>;
}

async function harness(
  llmCall: (prompt: string) => Promise<string>,
  calls: string[],
): Promise<Harness> {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/evaluation', createEvaluationRouter(new LLMEvaluator(), new ScoreSmoother(), llmCall));
  const { port, close } = await listen(app);
  const request = async (method: 'POST' | 'GET', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return {
    post: (path, body) => request('POST', path, body),
    get: (path) => request('GET', path),
    calls,
    close,
  };
}

const VALID_ITEM = {
  targetId: 't-1',
  input: 'question',
  output: 'answer',
  criteria: ['clarity'],
};

describe('evaluation request bounds — criteria', () => {
  it('pins the derived bounds', () => {
    // The per-request cap must remain the product of the two reachable caps, so
    // widening either one cannot silently widen the total work of a request.
    assert.equal(MAX_CRITERIA_PER_REQUEST, MAX_BATCH_ITEMS * MAX_CRITERIA_PER_ITEM);
    assert.equal(MAX_CRITERIA_PER_ITEM, EVALUATION_CRITERIA.length);
    assert.ok(MAX_BATCH_ITEMS > 0 && MAX_CRITERIA_PER_ITEM > 0);
  });

  it('rejects 100 duplicate criteria with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      // 100 entries trips the length bound first — the cheapest rejection wins,
      // and the caller is told the list is too long rather than walked through it.
      const overLong = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: Array.from({ length: 100 }, () => 'clarity'),
      });
      assert.equal(overLong.status, 400);
      assert.match(overLong.body.error, /must not exceed 7 entries/);

      // A list that is short enough still has to be free of duplicates, or a
      // caller buys the same paid call twice.
      const duplicated = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: ['clarity', 'accuracy', 'clarity'],
      });
      assert.equal(duplicated.status, 400);
      assert.match(duplicated.body.error, /duplicate criterion: clarity/);

      assert.deepEqual(judge.calls, [], 'a rejected request must buy zero judge calls');
    } finally {
      await h.close();
    }
  });

  it('rejects an unknown criterion with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: ['clarity', 'vibes'],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /unknown criterion: vibes/);
      assert.deepEqual(judge.calls, []);
    } finally {
      await h.close();
    }
  });

  it('rejects non-array, empty and over-long criteria with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      for (const criteria of ['clarity', 7, null, {}, []]) {
        const res = await h.post('/evaluation/evaluate', { ...VALID_ITEM, criteria });
        assert.equal(res.status, 400, `criteria=${JSON.stringify(criteria)} must reject`);
      }
      const tooMany = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: [...EVALUATION_CRITERIA, EVALUATION_CRITERIA[0]],
      });
      assert.equal(tooMany.status, 400);
      assert.deepEqual(judge.calls, []);
    } finally {
      await h.close();
    }
  });

  it('rejects a non-string and an oversized text field with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      const notAString = await h.post('/evaluation/evaluate', { ...VALID_ITEM, output: 42 });
      assert.equal(notAString.status, 400);
      const oversized = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        output: 'x'.repeat(MAX_EVALUATION_FIELD_CHARS + 1),
      });
      assert.equal(oversized.status, 400);
      assert.match(oversized.body.error, /exceeds/);
      assert.deepEqual(judge.calls, []);
    } finally {
      await h.close();
    }
  });

  it('buys exactly one judge call per accepted criterion', async () => {
    const judge = countingJudge(4);
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: [...EVALUATION_CRITERIA],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.results.length, EVALUATION_CRITERIA.length);
      assert.equal(judge.calls.length, EVALUATION_CRITERIA.length);
    } finally {
      await h.close();
    }
  });

  it('buys at most two calls per criterion when every score is low (documented retry)', async () => {
    const judge = countingJudge(1);
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: [...EVALUATION_CRITERIA],
      });
      assert.equal(res.status, 200);
      // `LLMEvaluator.evaluate` retries once when the first score is <= 2.
      assert.equal(judge.calls.length, EVALUATION_CRITERIA.length * 2);
    } finally {
      await h.close();
    }
  });
});

describe('evaluation request bounds — batch', () => {
  it('rejects a null item with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate/batch', {
        items: [VALID_ITEM, null],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /items\[1\] must be an object/);
      assert.deepEqual(judge.calls, [], 'one malformed item must not let the rest execute');
    } finally {
      await h.close();
    }
  });

  it('rejects an item whose criteria exceed the per-item bound, with zero judge calls', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate/batch', {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, targetId: 't-2', criteria: Array.from({ length: 50 }, () => 'clarity') },
        ],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /items\[1\]/);
      assert.deepEqual(judge.calls, []);
    } finally {
      await h.close();
    }
  });

  it('rejects a batch whose item count exceeds the limit', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      const res = await h.post('/evaluation/evaluate/batch', {
        items: Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => ({
          ...VALID_ITEM,
          targetId: `t-${i}`,
        })),
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /maximum of 50/);
      assert.deepEqual(judge.calls, []);
    } finally {
      await h.close();
    }
  });

  it('accepts a batch at the criteria total and reports the accepted count', async () => {
    const judge = countingJudge(4);
    const h = await harness(judge.call, judge.calls);
    try {
      const items = Array.from({ length: MAX_BATCH_ITEMS }, (_, i) => ({
        targetId: `t-${i}`,
        input: 'q',
        output: 'a',
        criteria: [...EVALUATION_CRITERIA],
      }));
      const res = await h.post('/evaluation/evaluate/batch', { items });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, MAX_BATCH_ITEMS);
      assert.equal(judge.calls.length, MAX_CRITERIA_PER_REQUEST);
    } finally {
      await h.close();
    }
  });

  it('rejects a batch whose criteria total exceeds the cap even when each item is within bounds', async () => {
    const judge = countingJudge();
    const h = await harness(judge.call, judge.calls);
    try {
      // The cap is the product of the two reachable caps, so it is exactly
      // reachable and never exceeded by a legal batch. Asserting both halves
      // keeps the guard honest: a future widening of either factor must move the
      // product, and this test then fails until the guard is re-derived.
      assert.equal(MAX_CRITERIA_PER_REQUEST, MAX_BATCH_ITEMS * MAX_CRITERIA_PER_ITEM);

      const overItemCap = await h.post('/evaluation/evaluate/batch', {
        items: [
          {
            targetId: 't-over',
            input: 'q',
            output: 'a',
            criteria: [...EVALUATION_CRITERIA, EVALUATION_CRITERIA[0]],
          },
        ],
      });
      assert.equal(overItemCap.status, 400, 'the only way past the total is past an item cap');
      assert.deepEqual(judge.calls, [], 'the rejection must precede the first judge call');
    } finally {
      await h.close();
    }
  });
});

describe('evaluation request bounds — published set matches accepted set', () => {
  it('publishes every accepted criterion and accepts every published one', async () => {
    const judge = countingJudge(4);
    const h = await harness(judge.call, judge.calls);
    try {
      const published = await h.get('/evaluation/criteria');
      assert.equal(published.status, 200);
      const publishedIds: string[] = published.body.criteria.map((c: { id: string }) => c.id);
      assert.deepEqual([...publishedIds].sort(), [...EVALUATION_CRITERIA].sort());

      // Every published criterion is individually accepted.
      for (const id of publishedIds) {
        const res = await h.post('/evaluation/evaluate', { ...VALID_ITEM, criteria: [id] });
        assert.equal(res.status, 200, `${id} is published but rejected`);
      }
      // And nothing outside the published list is accepted.
      const invented = await h.post('/evaluation/evaluate', {
        ...VALID_ITEM,
        criteria: ['not_published'],
      });
      assert.equal(invented.status, 400);
    } finally {
      await h.close();
    }
  });
});
