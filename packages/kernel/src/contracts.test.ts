import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelErrorDetails, KernelEvent } from './index.js';

const event: KernelEvent = {
  eventId: 'event-1',
  aggregateType: 'run',
  aggregateId: 'run-1',
  sequence: 1,
  type: 'run.created',
  tenantId: 'tenant-1',
  runId: 'run-1',
  actor: 'kernel',
  schemaVersion: 'v2',
  payload: {},
  occurredAt: '2026-07-15T00:00:00.000Z',
};

const error: KernelErrorDetails = {
  code: 'KERNEL_TEST_ERROR',
  message: 'test error',
  retryable: false,
};

test('kernel reuses the canonical event and error contracts', () => {
  assert.equal(event.eventId, 'event-1');
  assert.equal(error.code, 'KERNEL_TEST_ERROR');
});
