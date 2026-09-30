/**
 * AUDIT api-management#L1 — legacy evaluation results and trends were shared
 * across tenants.
 *
 * `LLMEvaluator.results` and `ScoreSmoother.history` are process-wide maps keyed
 * by a **caller-supplied** `targetId` / criterion only, and the production
 * assembly (`apps/api/src/index.ts`) constructs exactly one of each and hands
 * them to the router. Two tenants that both evaluated a target called
 * `same-target` therefore shared one bucket: tenant B could read tenant A's
 * judge explanations — which quote A's evaluated output — and both tenants
 * contaminated each other's aggregate scores and trends.
 *
 * These tests pin the isolation contract using the **shared** evaluator and
 * smoother instances the production assembly uses, driven through the real
 * `tenantContextMiddleware` (which binds the ambient tenant from
 * `X-Tenant-ID` in non-production standard profile).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { createEvaluationRouter } from '../src/evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from '../src/evaluation';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';

const TENANT_A_SECRET = 'tenant-A-private-reasoning-marker';

/** A judge whose explanation quotes the evaluated output, as a real one would. */
function echoJudge(): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const quoted = /Output:\s*([\s\S]*)/.exec(prompt)?.[1]?.trim().slice(0, 200) ?? '';
    return JSON.stringify({ score: 4, explanation: `judged: ${quoted}` });
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
  as: (tenant: string) => {
    post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
    get: (path: string) => Promise<{ status: number; body: any }>;
  };
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  // The production shape: one evaluator and one smoother shared by all requests.
  const evaluator = new LLMEvaluator();
  const smoother = new ScoreSmoother();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(tenantContextMiddleware);
  app.use('/evaluation', createEvaluationRouter(evaluator, smoother, echoJudge()));
  const { port, close } = await listen(app);

  const as = (tenant: string) => {
    const request = async (method: 'POST' | 'GET', path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'X-Tenant-ID': tenant,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    return {
      post: (path: string, body: unknown) => request('POST', path, body),
      get: (path: string) => request('GET', path),
    };
  };

  return { as, close };
}

const SAME_TARGET = 'same-target';

describe('evaluation tenant isolation', () => {
  it('does not let tenant B read tenant A results for the same target id', async () => {
    const h = await harness();
    try {
      const a = h.as('tenant-a');
      const b = h.as('tenant-b');

      const write = await a.post('/evaluation/evaluate', {
        targetId: SAME_TARGET,
        input: 'q',
        output: TENANT_A_SECRET,
        criteria: ['clarity'],
      });
      assert.equal(write.status, 200, JSON.stringify(write.body));
      assert.equal(write.body.results.length, 1);

      const aRead = await a.get(`/evaluation/evaluate/${SAME_TARGET}`);
      assert.equal(aRead.status, 200);
      assert.equal(aRead.body.results.length, 1, 'tenant A must still see its own result');
      assert.ok(aRead.body.aggregated, 'tenant A must still get an aggregate');
      assert.equal(
        JSON.stringify(aRead.body).includes(TENANT_A_SECRET),
        true,
        'tenant A is entitled to its own judge explanation',
      );

      const bRead = await b.get(`/evaluation/evaluate/${SAME_TARGET}`);
      assert.equal(bRead.status, 200);
      assert.deepEqual(
        bRead.body.results,
        [],
        'tenant B must see no result for the same target id',
      );
      assert.equal(bRead.body.aggregated, null, 'tenant B must get no aggregate');
      assert.equal(
        JSON.stringify(bRead.body).includes(TENANT_A_SECRET),
        false,
        "tenant B must not receive tenant A's judge explanation",
      );
    } finally {
      await h.close();
    }
  });

  it('does not let tenant B read tenant A trends', async () => {
    const h = await harness();
    try {
      const a = h.as('tenant-a');
      const b = h.as('tenant-b');

      const write = await a.post('/evaluation/evaluate', {
        targetId: SAME_TARGET,
        input: 'q',
        output: 'a-output',
        criteria: ['clarity', 'accuracy'],
      });
      assert.equal(write.status, 200);

      const aTrends = await a.get('/evaluation/trends');
      assert.equal(aTrends.status, 200);
      assert.equal(aTrends.body.trends.length, 2, 'tenant A must see its own two criteria');

      const bTrends = await b.get('/evaluation/trends');
      assert.equal(bTrends.status, 200);
      assert.deepEqual(bTrends.body.trends, [], 'tenant B must see no trends');

      // The reported criterion must be the declared id, not the internal scoped key.
      for (const trend of aTrends.body.trends) {
        assert.ok(
          ['clarity', 'accuracy'].includes(trend.criterion),
          `criterion leaked internal key: ${trend.criterion}`,
        );
      }

      const bPerCriterion = await b.get('/evaluation/trends/clarity');
      assert.equal(bPerCriterion.body.smoothedScore, 0);
      assert.equal(bPerCriterion.body.trend, 'stable');
    } finally {
      await h.close();
    }
  });

  it('keeps single-tenant behaviour unchanged when no tenant is bound', async () => {
    const evaluator = new LLMEvaluator();
    const smoother = new ScoreSmoother();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(tenantContextMiddleware);
    app.use('/evaluation', createEvaluationRouter(evaluator, smoother, echoJudge()));
    const { port, close } = await listen(app);
    try {
      const post = await fetch(`http://127.0.0.1:${port}/evaluation/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: SAME_TARGET,
          input: 'q',
          output: 'a',
          criteria: ['clarity'],
        }),
      });
      assert.equal(post.status, 200);
      const read = await fetch(`http://127.0.0.1:${port}/evaluation/evaluate/${SAME_TARGET}`);
      const body = (await read.json()) as { results: unknown[]; aggregated: unknown };
      assert.equal(body.results.length, 1);
      assert.ok(body.aggregated, 'single-tenant mode must keep one unscoped bucket');
    } finally {
      await close();
    }
  });
});
