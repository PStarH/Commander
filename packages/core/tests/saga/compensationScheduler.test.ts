import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CompensationScheduler,
  defaultCompensationRetryPolicy,
} from '../../src/saga/compensationScheduler';
import type { SagaStepNode, SagaContext } from '../../src/saga/types';

function makeStepNode(id: string, name: string): SagaStepNode {
  return {
    kind: 'step',
    id,
    name,
    fn: async () => null,
    compensable: true,
    compensateOrder: 'lifo',
    tags: [],
  };
}

function makeContext(): SagaContext {
  return {
    runId: 'r1',
    input: {},
    results: new Map(),
    attempts: new Map(),
    metadata: {},
    signal: new AbortController().signal,
  };
}

describe('CompensationScheduler', () => {
  it('runs all compensations in order', async () => {
    const order: string[] = [];
    const scheduler = new CompensationScheduler({
      retryPolicy: defaultCompensationRetryPolicy(),
    });
    const steps = [
      { node: makeStepNode('a', 'a'), result: 1 },
      { node: makeStepNode('b', 'b'), result: 2 },
    ];
    steps[0].node.compensate = async () => {
      order.push('a');
    };
    steps[1].node.compensate = async () => {
      order.push('b');
    };
    const result = await scheduler.compensate(steps, makeContext());
    assert.deepStrictEqual(order, ['a', 'b']);
    assert.deepStrictEqual(result.compensated, ['a', 'b']);
    assert.strictEqual(result.failed.length, 0);
  });

  it('retries failed compensation', async () => {
    let attempts = 0;
    const scheduler = new CompensationScheduler({
      retryPolicy: {
        maxAttempts: 3,
        backoff: 'fixed',
        initialDelayMs: 1,
        maxDelayMs: 10,
        jitter: 'none',
      },
    });
    const step = { node: makeStepNode('a', 'a'), result: 1 };
    step.node.compensate = async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
    };
    const result = await scheduler.compensate([step], makeContext());
    assert.strictEqual(result.compensated.length, 1);
    assert.strictEqual(attempts, 3);
  });

  it('sends failed compensation to DLQ after max attempts', async () => {
    const dlq: Array<{ nodeId: string; attempts: number }> = [];
    const scheduler = new CompensationScheduler({
      retryPolicy: {
        maxAttempts: 2,
        backoff: 'fixed',
        initialDelayMs: 1,
        maxDelayMs: 5,
        jitter: 'none',
      },
      deadLetter: async (entry) => {
        dlq.push({ nodeId: entry.nodeId, attempts: entry.attempts });
      },
    });
    const step = { node: makeStepNode('a', 'a'), result: 1 };
    step.node.compensate = async () => {
      throw new Error('permanent');
    };
    const result = await scheduler.compensate([step], makeContext());
    assert.strictEqual(result.compensated.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.deepStrictEqual(dlq, [{ nodeId: 'a', attempts: 2 }]);
  });

  it('forceCompensate runs single step', async () => {
    let ran = false;
    const scheduler = new CompensationScheduler({
      retryPolicy: defaultCompensationRetryPolicy(),
    });
    const step = { node: makeStepNode('a', 'a'), result: 1 };
    step.node.compensate = async () => {
      ran = true;
    };
    await scheduler.forceCompensate(step, makeContext());
    assert.strictEqual(ran, true);
  });

  it('skips step with no compensate function', async () => {
    const scheduler = new CompensationScheduler({
      retryPolicy: defaultCompensationRetryPolicy(),
    });
    const step = { node: makeStepNode('a', 'a'), result: 1 };
    const result = await scheduler.compensate([step], makeContext());
    assert.deepStrictEqual(result.compensated, ['a']);
  });

  it('compensateParallel runs concurrently', async () => {
    const order: string[] = [];
    const scheduler = new CompensationScheduler({
      retryPolicy: defaultCompensationRetryPolicy(),
    });
    const make = (id: string) => {
      const step = { node: makeStepNode(id, id), result: 1 };
      step.node.compensate = async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(id);
      };
      return step;
    };
    const start = Date.now();
    await scheduler.compensateParallel([make('a'), make('b'), make('c')], makeContext());
    const elapsed = Date.now() - start;
    assert.strictEqual(order.length, 3);
    assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}ms`);
  });
});
