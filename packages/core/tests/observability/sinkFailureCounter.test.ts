/**
 * Tests for the shared recordSinkFailure helper.
 *
 * Phase 2.3.5 — DRY-extract of byte-identical recordSinkFailure(sink)
 * helper from packages/core/src/security/capabilityToken.ts and
 * packages/core/src/runtime/toolApproval.ts. Both call sites now import
 * this helper instead of carrying their own copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getMetricsCollector, resetMetricsCollector } from '../../src/runtime/metricsCollector';
import {
  recordSinkFailure,
  AUDIT_SINK_FAILURES_METRIC,
} from '../../src/observability/sinkFailureCounter';

test.beforeEach(() => {
  resetMetricsCollector();
});

test('recordSinkFailure — exports the metric name as a constant', () => {
  assert.equal(typeof AUDIT_SINK_FAILURES_METRIC, 'string');
  assert.equal(AUDIT_SINK_FAILURES_METRIC, 'audit_sink_failures_total');
});

test('Phase 2.3.5 — recordSinkFailure increments audit_sink_failures_total{sink="auditChain"}.', () => {
  const before = getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
    { name: 'sink', value: 'auditChain' },
  ]);
  recordSinkFailure('auditChain');
  recordSinkFailure('auditChain');
  recordSinkFailure('auditChain');
  const after = getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
    { name: 'sink', value: 'auditChain' },
  ]);
  assert.equal(
    after - before,
    3,
    'counter must increment by exactly the number of recordSinkFailure calls',
  );
});

test('Phase 2.3.5 — recordSinkFailure labels are isolated across sink names.', () => {
  recordSinkFailure('auditLogger');
  recordSinkFailure('auditLogger');
  recordSinkFailure('auditLogger');
  recordSinkFailure('auditChain');
  recordSinkFailure('tokenRejectedLogger');

  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'auditLogger' },
    ]),
    3,
    'auditLogger counter must reflect only its own calls',
  );
  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'auditChain' },
    ]),
    1,
    'auditChain counter must reflect only its own calls',
  );
  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'tokenRejectedLogger' },
    ]),
    1,
    'tokenRejectedLogger counter must reflect only its own calls',
  );
});

test('Phase 2.3.5 — recordSinkFailure is a no-op when not called (no false positives).', () => {
  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'auditLogger' },
    ]),
    0,
    'auditLogger counter must remain zero without any recordSinkFailure calls',
  );
  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'auditChain' },
    ]),
    0,
    'auditChain counter must remain zero without any recordSinkFailure calls',
  );
  assert.equal(
    getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, [
      { name: 'sink', value: 'tokenRejectedLogger' },
    ]),
    0,
    'tokenRejectedLogger counter must remain zero without any recordSinkFailure calls',
  );
});

test('Phase 2.3.5 — getCounter name-only lookup returns 0 when no unlabeled counter exists.', () => {
  // MetricsCollector.getCounter(name, []) does an exact key lookup for the
  // unlabeled counter name (NOT partial-label sum). All recordSinkFailure
  // calls always attach a {sink: …} label, so the unlabeled counter never
  // exists, and the name-only lookup must return 0. Asserting this directly
  // documents the contract callers should rely on when writing dashboards.
  recordSinkFailure('auditLogger');
  recordSinkFailure('auditChain');
  recordSinkFailure('tokenRejectedLogger');
  const unlabeledTotal = getMetricsCollector().getCounter(AUDIT_SINK_FAILURES_METRIC, []);
  assert.equal(
    unlabeledTotal,
    0,
    'name-only getCounter lookup must return 0 when only labelled entries exist',
  );
});

test('Phase 2.3.5 — recordSinkFailure never throws, even if MetricsCollector does.', () => {
  // The helper's entire purpose is the outer last-resort swallow: a broken
  // metrics collector must NEVER propagate into the underlying token/approval
  // flow. Monkey-patch incrementCounter on the live singleton to throw, call
  // the helper, then assert no exception leaked.
  const collector = getMetricsCollector();
  const original = collector.incrementCounter.bind(collector);
  (collector as { incrementCounter: typeof original }).incrementCounter = () => {
    throw new Error('simulated metrics collector crash');
  };
  try {
    assert.doesNotThrow(
      () => recordSinkFailure('auditChain'),
      'recordSinkFailure must swallow MetricsCollector exceptions',
    );
    assert.doesNotThrow(
      () => recordSinkFailure('tokenRejectedLogger'),
      'recordSinkFailure must swallow MetricsCollector exceptions across all sink labels',
    );
  } finally {
    (collector as { incrementCounter: typeof original }).incrementCounter = original;
  }
});
