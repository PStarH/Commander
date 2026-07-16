/**
 * P2 security: batch evaluate size + concurrency caps.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import {
  createEvaluationRouter,
  createMockLLMCall,
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_ITEMS,
} from '../src/evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from '../src/evaluation';

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

describe('evaluation batch limits', () => {
  it('exports MAX_BATCH_ITEMS=50 and MAX_BATCH_CONCURRENCY=3', () => {
    assert.equal(MAX_BATCH_ITEMS, 50);
    assert.equal(MAX_BATCH_CONCURRENCY, 3);
  });

  it('rejects batches larger than MAX_BATCH_ITEMS with 400', async () => {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(
      '/evaluation',
      createEvaluationRouter(new LLMEvaluator(), new ScoreSmoother(), createMockLLMCall()),
    );
    const { port, close } = await listen(app);
    try {
      const items = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => ({
        targetId: `t-${i}`,
        input: 'q',
        output: 'a',
        criteria: ['clarity'],
      }));
      const res = await fetch(`http://127.0.0.1:${port}/evaluation/evaluate/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; max: number; received: number };
      assert.match(body.error, /maximum of 50/i);
      assert.equal(body.max, 50);
      assert.equal(body.received, 51);
    } finally {
      await close();
    }
  });

  it('accepts a batch at the size limit and caps concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const llmCall = async (_prompt: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return JSON.stringify({ score: 4, explanation: 'ok' });
    };

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/evaluation', createEvaluationRouter(new LLMEvaluator(), new ScoreSmoother(), llmCall));
    const { port, close } = await listen(app);
    try {
      const items = Array.from({ length: 9 }, (_, i) => ({
        targetId: `t-${i}`,
        input: 'q',
        output: 'a',
        criteria: ['clarity'],
      }));
      const res = await fetch(`http://127.0.0.1:${port}/evaluation/evaluate/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { count: number };
      assert.equal(body.count, 9);
      assert.ok(peak <= MAX_BATCH_CONCURRENCY, `peak concurrency ${peak} > ${MAX_BATCH_CONCURRENCY}`);
      assert.ok(peak >= 1);
    } finally {
      await close();
    }
  });
});
