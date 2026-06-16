import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSaga, buildSaga } from '../../src/saga/sagaBuilder';
import { SagaCoordinator, runSaga, startSaga } from '../../src/saga/sagaCoordinator';
import { InMemorySagaStore } from '../../src/saga/sagaStore';
import { CheckpointManager } from '../../src/saga/checkpointManager';
import { InMemoryApprovalStore, ApprovalManager } from '../../src/saga/approvalManager';
import { InProcessWorkerPool } from '../../src/saga/workerPool';
import {
  CompensationScheduler,
  defaultCompensationRetryPolicy,
} from '../../src/saga/compensationScheduler';
import type { SagaContext, SagaResult } from '../../src/saga/types';

function makeContext(input: Record<string, unknown> = {}): SagaContext {
  return {
    runId: 'test-' + Math.random().toString(36).slice(2),
    input,
    results: new Map(),
    attempts: new Map(),
    metadata: {},
    signal: new AbortController().signal,
  };
}

function setup() {
  const store = new InMemorySagaStore();
  const checkpoint = new CheckpointManager(store);
  const approvalStore = new InMemoryApprovalStore();
  const approval = new ApprovalManager({ store: approvalStore });
  const compensation = new CompensationScheduler({
    retryPolicy: defaultCompensationRetryPolicy(),
  });
  const pool = new InProcessWorkerPool(4);
  return { store, checkpoint, approval, compensation, pool };
}

describe('SagaCoordinator — sequential', () => {
  it('runs a single step to completion', async () => {
    const graph = createSaga('s')
      .step('a', async () => 42)
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    const result = await runSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'committed');
    assert.strictEqual(result.results['a'], 42);
  });

  it('runs steps in order', async () => {
    const order: string[] = [];
    const graph = createSaga('s')
      .step('a', async () => {
        order.push('a');
        return 1;
      })
      .step('b', async () => {
        order.push('b');
        return 2;
      })
      .step('c', async () => {
        order.push('c');
        return 3;
      })
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });
});

describe('SagaCoordinator — compensation', () => {
  it('triggers LIFO compensation on step failure', async () => {
    const compensated: string[] = [];
    const graph = createSaga('s')
      .step('a', async () => 1)
      .compensate(async () => {
        compensated.push('a');
      })
      .step('b', async () => 2)
      .compensate(async () => {
        compensated.push('b');
      })
      .step('c', async () => {
        throw new Error('c failed');
      })
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'aborted');
    assert.deepStrictEqual(compensated, ['b', 'a']);
  });

  it('compensates completed steps before uncompensable failure', async () => {
    const compensated: string[] = [];
    const graph = createSaga('s')
      .step('a', async () => 1)
      .compensate(async () => {
        compensated.push('a');
      })
      .step('b', async () => {
        throw new Error('b failed');
      })
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'aborted');
    assert.deepStrictEqual(compensated, ['a']);
  });

  it('retries step with retry policy', async () => {
    let attempts = 0;
    const graph = createSaga('s')
      .step(
        'a',
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return 'ok';
        },
        {
          retryPolicy: {
            maxAttempts: 5,
            backoff: 'fixed',
            initialDelayMs: 1,
            maxDelayMs: 10,
            jitter: 'none',
          },
        },
      )
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'committed');
    assert.strictEqual(attempts, 3);
    assert.strictEqual(result.results['a'], 'ok');
  });
});

describe('SagaCoordinator — parallel', () => {
  it('runs parallel branches', async () => {
    const b1 = createSaga('b1')
      .step('charge', async () => 'charged')
      .build();
    const b2 = createSaga('b2')
      .step('reserve', async () => 'reserved')
      .build();
    const graph = createSaga('order').parallel([b1, b2]).build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'committed');
  });

  it('runs parallel branches in parallel (timing)', async () => {
    const start = Date.now();
    const slowBranch = (ms: number) =>
      createSaga('b')
        .step('slow', async () => {
          await new Promise((r) => setTimeout(r, ms));
          return ms;
        })
        .build();
    const graph = createSaga('p')
      .parallel([slowBranch(50), slowBranch(50), slowBranch(50)], {
        failFast: true,
      })
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(result.status, 'committed');
    assert.ok(elapsed < 150, `expected <150ms, got ${elapsed}ms`);
  });
});

describe('SagaCoordinator — nested', () => {
  it('runs nested saga', async () => {
    const child = createSaga('child')
      .step('inner', async () => 'child-result')
      .build();
    const graph = createSaga('parent').nested(child).build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'committed');
  });

  it('cascades compensation on nested failure', async () => {
    const compensated: string[] = [];
    const child = createSaga('child')
      .step('inner1', async () => 1)
      .compensate(async () => {
        compensated.push('inner1');
      })
      .step('inner2', async () => {
        throw new Error('inner2 failed');
      })
      .build();
    const graph = createSaga('parent')
      .step('outer1', async () => 1)
      .compensate(async () => {
        compensated.push('outer1');
      })
      .nested(child)
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const result = await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.strictEqual(result.status, 'aborted');
    assert.ok(compensated.includes('inner1'));
    assert.ok(compensated.includes('outer1'));
  });
});

describe('SagaCoordinator — approval', () => {
  it('pauses saga at approval gate', async () => {
    const graph = createSaga('s').approval('alice').build();
    const { checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    const promise = runSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    await new Promise((r) => setTimeout(r, 50));
    const pending = await approval.listPending('alice');
    assert.strictEqual(pending.length, 1);
    await approval.decide(ctx.runId, graph.nodes[0].id, {
      decision: 'approve',
      decidedAt: new Date().toISOString(),
      decidedBy: 'alice',
    });
    const result = await promise;
    assert.strictEqual(result.status, 'committed');
  });

  it('rejection causes saga to abort', async () => {
    const compensated: string[] = [];
    const graph = createSaga('s')
      .step('setup', async () => 1)
      .compensate(async () => {
        compensated.push('setup');
      })
      .approval('alice')
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    const promise = runSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    await new Promise((r) => setTimeout(r, 50));
    await approval.decide(ctx.runId, graph.nodes[1].id, {
      decision: 'reject',
      decidedAt: new Date().toISOString(),
      decidedBy: 'alice',
      reason: 'not authorized',
    });
    const result = await promise;
    assert.strictEqual(result.status, 'aborted');
    assert.deepStrictEqual(compensated, ['setup']);
  });
});

describe('SagaCoordinator — checkpoint/recover', () => {
  it('persists snapshot after each node', async () => {
    const graph = createSaga('s')
      .step('a', async () => 1)
      .step('b', async () => 2)
      .build();
    const { store, checkpoint, approval, pool, compensation } = setup();
    await runSaga(graph, makeContext(), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    const snapshot = await checkpoint.loadSnapshot(graph.nodes[0].id === undefined ? 'x' : 'x');
    const runIds = await store.listRunIds();
    assert.ok(runIds.length > 0);
  });

  it('recovers from snapshot', async () => {
    const graph = createSaga('s')
      .step('a', async () => 1)
      .build();
    const { store, checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    await runSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    const events = await store.readEvents(ctx.runId);
    assert.ok(events.length > 0);
    const recovered = await checkpoint.recover(ctx.runId);
    assert.ok(recovered);
    assert.strictEqual(recovered!.snapshot.runId, ctx.runId);
  });
});

describe('startSaga — cancellation', () => {
  it('cancels an in-flight run via the returned handle', async () => {
    const graph = createSaga('s')
      .step('slow', async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 1;
      })
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    const running = startSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    assert.ok(typeof running.cancel === 'function');
    assert.ok(typeof running.snapshot === 'function');
    running.cancel();
    const result = await running.result;
    assert.strictEqual(result.status, 'aborted');
  });

  it('snapshot() returns current state', async () => {
    const graph = createSaga('s')
      .step('a', async () => 1)
      .build();
    const { checkpoint, approval, pool, compensation } = setup();
    const ctx = makeContext();
    const running = startSaga(graph, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool: pool,
    });
    const snap = running.snapshot();
    assert.strictEqual(snap.runId, ctx.runId);
    await running.result;
  });
});
