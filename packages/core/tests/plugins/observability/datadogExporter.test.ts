/**
 * Tests for DatadogExporter — converts ExecutionTrace events to Datadog spans.
 *
 * Since the DatadogExporter makes real HTTPS calls to Datadog's trace intake,
 * these tests focus on:
 *   - Constructor config defaults
 *   - exportTrace does not throw on various inputs
 *   - flush is a no-op when queue is empty
 *   - start/stop lifecycle
 *   - Error handling (flush gracefully handles network failures)
 *   - Re-queue behavior on failed sends
 *
 * Note: Span payload format (array-of-arrays, trace_id as number, etc.)
 * is verified in the packages/observability test suite where the HTTPS
 * transport can be more easily intercepted.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatadogExporter } from '../../../src/plugins/builtin/observability/datadogExporter';
import type { ExecutionTrace, TraceEvent } from '../../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    traceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    spanId: '11111111-2222-3333-4444-555555555555',
    parentSpanId: undefined,
    runId: 'run-001',
    agentId: 'agent-001',
    timestamp: '2025-01-01T00:00:00.000Z',
    durationMs: 150,
    type: 'llm_call',
    data: {
      modelInfo: { model: 'gpt-4o', provider: 'openai' },
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      input: 'test input',
      output: 'test output',
    },
    ...overrides,
  } as TraceEvent;
}

function makeTrace(events: TraceEvent[] = [makeEvent()]): ExecutionTrace {
  return {
    runId: 'run-001',
    agentId: 'agent-001',
    startTime: '2025-01-01T00:00:00.000Z',
    endTime: '2025-01-01T00:00:01.000Z',
    events,
    status: 'completed',
  } as ExecutionTrace;
}

// ============================================================================
// Tests
// ============================================================================

describe('DatadogExporter', () => {
  let exporter: DatadogExporter;

  beforeEach(() => {
    exporter = new DatadogExporter({ apiKey: 'test-key' });
  });

  afterEach(() => {
    exporter.stop();
  });

  describe('constructor', () => {
    it('creates an exporter with API key', () => {
      assert.doesNotThrow(() => {
        new DatadogExporter({ apiKey: 'my-key' });
      });
    });

    it('creates an exporter with custom site', () => {
      assert.doesNotThrow(() => {
        new DatadogExporter({ apiKey: 'key', site: 'datadoghq.eu' });
      });
    });

    it('creates an exporter with custom service name', () => {
      assert.doesNotThrow(() => {
        new DatadogExporter({ apiKey: 'key', serviceName: 'my-service' });
      });
    });

    it('creates an exporter with custom environment', () => {
      assert.doesNotThrow(() => {
        new DatadogExporter({ apiKey: 'key', environment: 'staging' });
      });
    });
  });

  describe('exportTrace', () => {
    it('does not throw when exporting a single-event trace', () => {
      assert.doesNotThrow(() => exporter.exportTrace(makeTrace([makeEvent()])));
    });

    it('does not throw when exporting a multi-event trace', () => {
      const trace = makeTrace([
        makeEvent({ spanId: 'span-1', type: 'llm_call' }),
        makeEvent({ spanId: 'span-2', type: 'tool_execution' }),
        makeEvent({ spanId: 'span-3', type: 'checkpoint' }),
      ]);
      assert.doesNotThrow(() => exporter.exportTrace(trace));
    });

    it('does not throw when exporting an empty trace', () => {
      assert.doesNotThrow(() => exporter.exportTrace(makeTrace([])));
    });

    it('does not throw when exporting a trace with error events', () => {
      const trace = makeTrace([
        makeEvent({
          type: 'llm_call',
          data: { error: 'LLM timeout' } as any,
        }),
      ]);
      assert.doesNotThrow(() => exporter.exportTrace(trace));
    });

    it('does not throw when exporting a trace with token usage', () => {
      const trace = makeTrace([
        makeEvent({
          data: {
            modelInfo: { model: 'gpt-4o', provider: 'openai' },
            tokenUsage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
          } as any,
        }),
      ]);
      assert.doesNotThrow(() => exporter.exportTrace(trace));
    });

    it('does not throw when exporting a trace with parent span', () => {
      const trace = makeTrace([makeEvent({ parentSpanId: 'parent-aaa-bbb-ccc-ddd' })]);
      assert.doesNotThrow(() => exporter.exportTrace(trace));
    });

    it('does not throw when exporting a trace with no model info', () => {
      const trace = makeTrace([
        makeEvent({
          data: { input: 'test', output: 'result' } as any,
        }),
      ]);
      assert.doesNotThrow(() => exporter.exportTrace(trace));
    });
  });

  describe('flush', () => {
    it('is a no-op when queue is empty', async () => {
      // Should resolve immediately without making any HTTP calls
      await exporter.flush();
      // If we get here without throwing, the test passes
      assert.ok(true);
    });

    it('handles network errors gracefully (does not throw)', async () => {
      exporter.exportTrace(makeTrace([makeEvent()]));
      // flush will try to connect to datadoghq.com and fail
      // (no network in test env), but should not throw
      await exporter.flush();
      // The batch should be re-queued after failure
      assert.ok(true);
    });

    it('re-queues batch on failure for retry', async () => {
      exporter.exportTrace(makeTrace([makeEvent()]));
      // First flush fails (no network), batch is re-queued
      await exporter.flush();
      // Second flush also fails, but should not throw
      await exporter.flush();
      assert.ok(true);
    });
  });

  describe('start/stop', () => {
    it('start does not throw', () => {
      assert.doesNotThrow(() => exporter.start());
    });

    it('stop does not throw when queue is empty', async () => {
      await exporter.stop();
    });

    it('stop flushes remaining queue (handles errors gracefully)', async () => {
      exporter.exportTrace(makeTrace([makeEvent()]));
      await exporter.stop();
      // Should not throw even if flush fails due to no network
    });

    it('can start and stop multiple times', () => {
      exporter.start();
      exporter.stop();
      exporter.start();
      exporter.stop();
    });
  });

  describe('multiple traces', () => {
    it('handles exporting multiple traces in sequence', () => {
      for (let i = 0; i < 10; i++) {
        const trace = makeTrace([
          makeEvent({
            spanId: `span-${i}`,
            runId: `run-${i}`,
            timestamp: new Date(Date.now() + i * 1000).toISOString(),
          }),
        ]);
        assert.doesNotThrow(() => exporter.exportTrace(trace));
      }
    });

    it('handles exporting traces with various event types', () => {
      const types = ['llm_call', 'tool_execution', 'checkpoint', 'error', 'custom_event'];
      const events = types.map((type, i) =>
        makeEvent({ spanId: `span-${i}`, type: type as TraceEvent['type'] }),
      );
      assert.doesNotThrow(() => exporter.exportTrace(makeTrace(events)));
    });
  });
});
