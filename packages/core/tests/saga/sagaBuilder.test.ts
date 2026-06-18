import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSaga, SagaBuilder, SagaBuilderError, buildSaga } from '../../src/saga/sagaBuilder';

describe('SagaBuilder', () => {
  it('creates a builder with a name', () => {
    const b = createSaga('test');
    assert.ok(b instanceof SagaBuilder);
  });

  it('throws on empty name', () => {
    assert.throws(() => createSaga(''), SagaBuilderError);
  });

  it('adds steps with auto-generated ids', () => {
    const graph = createSaga('test')
      .step('a', async () => 1)
      .step('b', async () => 2)
      .build();
    assert.strictEqual(graph.nodes.length, 2);
    assert.notStrictEqual(graph.nodes[0].id, graph.nodes[1].id);
    assert.strictEqual(graph.rootId, graph.nodes[0].id);
  });

  it('adds steps with explicit ids', () => {
    const graph = createSaga('test')
      .step('a', async () => 1, { id: 'first' })
      .step('b', async () => 2, { id: 'second' })
      .build();
    assert.strictEqual(graph.nodes[0].id, 'first');
    assert.strictEqual(graph.nodes[1].id, 'second');
  });

  it('set compensate on last step', () => {
    const graph = createSaga('test')
      .step('a', async () => 1)
      .compensate(async () => undefined)
      .build();
    const step = graph.nodes[0];
    assert.strictEqual(step.kind, 'step');
    if (step.kind === 'step') {
      assert.strictEqual(step.compensable, true);
      assert.ok(typeof step.compensate === 'function');
    }
  });

  it('throws when compensate follows non-step', () => {
    assert.throws(
      () =>
        createSaga('test')
          .parallel([
            createSaga('b')
              .step('x', async () => 1)
              .build(),
          ])
          .compensate(async () => undefined),
      SagaBuilderError,
    );
  });

  it('adds parallel branches as nested sagas', () => {
    const b1 = createSaga('b1')
      .step('a', async () => 1)
      .build();
    const b2 = createSaga('b2')
      .step('a', async () => 2)
      .build();
    const graph = createSaga('root').parallel([b1, b2]).build();
    assert.strictEqual(graph.nodes.length, 1);
    const parallel = graph.nodes[0];
    assert.strictEqual(parallel.kind, 'parallel');
    if (parallel.kind === 'parallel') {
      assert.strictEqual(parallel.branches.length, 2);
      assert.strictEqual(parallel.branches[0].kind, 'nested');
      assert.strictEqual(parallel.failFast, true);
    }
  });

  it('throws on empty parallel', () => {
    assert.throws(() => createSaga('test').parallel([]), SagaBuilderError);
  });

  it('adds approval gate', () => {
    const graph = createSaga('test').approval('alice').build();
    const node = graph.nodes[0];
    assert.strictEqual(node.kind, 'approval');
    if (node.kind === 'approval') {
      assert.strictEqual(node.approver, 'alice');
      assert.strictEqual(node.onTimeout, 'reject');
    }
  });

  it('throws on approval without approver', () => {
    assert.throws(() => createSaga('test').approval(''), SagaBuilderError);
  });

  it('adds nested saga', () => {
    const child = createSaga('child')
      .step('a', async () => 1)
      .build();
    const graph = createSaga('parent').nested(child).build();
    assert.strictEqual(graph.nodes.length, 1);
    assert.strictEqual(graph.nodes[0].kind, 'nested');
  });

  it('sets global timeout', () => {
    const graph = createSaga('test')
      .withTimeout(5000)
      .step('a', async () => 1)
      .build();
    assert.strictEqual(graph.timeoutMs, 5000);
  });

  it('throws on non-positive timeout', () => {
    assert.throws(() => createSaga('test').withTimeout(0), SagaBuilderError);
  });

  it('sets default retry policy', () => {
    const policy = {
      maxAttempts: 3,
      backoff: 'fixed' as const,
      initialDelayMs: 50,
      maxDelayMs: 1000,
      jitter: 'full' as const,
    };
    const graph = createSaga('test')
      .withRetry(policy)
      .step('a', async () => 1)
      .build();
    assert.deepStrictEqual(graph.defaultRetryPolicy, policy);
  });

  it('sets tenant and metadata', () => {
    const graph = createSaga('test')
      .withTenant('acme')
      .withMetadata({ env: 'prod' })
      .step('a', async () => 1)
      .build();
    assert.strictEqual(graph.tenantId, 'acme');
    assert.deepStrictEqual(graph.metadata, { env: 'prod' });
  });

  it('merges metadata on repeated calls', () => {
    const graph = createSaga('test')
      .withMetadata({ a: 1 })
      .withMetadata({ b: 2 })
      .step('a', async () => 1)
      .build();
    assert.deepStrictEqual(graph.metadata, { a: 1, b: 2 });
  });

  it('throws on empty build', () => {
    assert.throws(() => createSaga('test').build(), SagaBuilderError);
  });

  it('describes the saga', () => {
    const graph = createSaga('test')
      .describe('does a thing')
      .step('a', async () => 1)
      .build();
    assert.strictEqual(graph.description, 'does a thing');
  });

  it('buildSaga helper', () => {
    const graph = buildSaga('test', (b) => b.step('a', async () => 1).step('b', async () => 2));
    assert.strictEqual(graph.nodes.length, 2);
  });

  it('per-step timeout and retry override', () => {
    const graph = createSaga('test')
      .step('a', async () => 1, {
        timeoutMs: 1000,
        retryPolicy: { maxAttempts: 5 },
      })
      .build();
    const step = graph.nodes[0];
    if (step.kind === 'step') {
      assert.strictEqual(step.timeoutMs, 1000);
      assert.strictEqual(step.retryPolicy?.maxAttempts, 5);
    }
  });
});
