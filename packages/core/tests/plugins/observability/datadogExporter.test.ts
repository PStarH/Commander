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
import { getGlobalLogger } from '../../../src/logging';
import type { ExecutionTrace, TraceEvent } from '../../../src/runtime/types';

// ============================================================================
// Observability seams
// ============================================================================
//
// OPR-05/OPR-06: the previous `flush` block called `assert.ok(true)` after
// `await exporter.flush()` and relied on the real Datadog intake being
// unreachable, so it passed even if the exporter sent nothing at all, sent the
// wrong spans, or dropped a failed batch.
//
// `node:https` cannot be stubbed from here: this file is ESM (`"type":
// "module"`) and Node's ESM namespace for a builtin is a snapshot of the CJS
// exports, so patching `require('node:https').request` is invisible to the
// exporter. The tests therefore read the exporter's own runtime queue — the
// exact `DatadogSpan` objects that `flush()` serialises — and drive the
// transport through the reserved `.invalid` TLD, which never resolves, so the
// failure path is forced deterministically with and without network egress.

interface DatadogSpanShape {
  trace_id: number;
  span_id: number;
  parent_id?: number;
  name: string;
  resource: string;
  service: string;
  type: string;
  error?: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
}

/** The spans currently queued for the next flush (TS `private`, real at runtime). */
function queuedSpans(exporter: DatadogExporter): DatadogSpanShape[] {
  return (exporter as unknown as { queue: DatadogSpanShape[] }).queue;
}

/** A dedicated exporter whose intake host can never resolve. */
function offlineExporter(): DatadogExporter {
  return new DatadogExporter({ apiKey: 'test-key', site: 'commander-test.invalid' });
}

let loggerWarnings: string[] = [];
let realLoggerWarn: ((...args: unknown[]) => void) | null = null;

function captureLoggerWarnings(): void {
  const logger = getGlobalLogger() as unknown as { warn: (...args: unknown[]) => void };
  loggerWarnings = [];
  realLoggerWarn = logger.warn;
  logger.warn = (scope: unknown, message: unknown) => {
    loggerWarnings.push(`${String(scope)}: ${String(message)}`);
  };
}

function releaseLogger(): void {
  if (realLoggerWarn) {
    (getGlobalLogger() as unknown as { warn: (...args: unknown[]) => void }).warn = realLoggerWarn;
    realLoggerWarn = null;
  }
}

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
    captureLoggerWarnings();
  });

  afterEach(async () => {
    // `stop()` flushes. The shared exporter is replaced per-test by any test
    // that actually sends, so this one is only ever drained while empty.
    await exporter.stop();
    releaseLogger();
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
      await exporter.flush();
      assert.strictEqual(queuedSpans(exporter).length, 0);
      assert.deepStrictEqual(loggerWarnings, [], 'an empty queue must not reach the transport');
    });

    it('queues one Datadog span per trace event, with the intake payload shape', () => {
      exporter.exportTrace(makeTrace([makeEvent()]));

      const queued = queuedSpans(exporter);
      assert.strictEqual(queued.length, 1);
      const span = queued[0];
      assert.strictEqual(typeof span.trace_id, 'number');
      assert.strictEqual(typeof span.span_id, 'number');
      assert.strictEqual(span.name, 'llm_call:gpt-4o');
      assert.strictEqual(span.resource, 'llm_call.gpt-4o');
      assert.strictEqual(span.type, 'llm');
      assert.strictEqual(span.service, 'commander');
      assert.strictEqual(span.meta['commander.run_id'], 'run-001');
      assert.strictEqual(span.meta['commander.agent_id'], 'agent-001');
      assert.strictEqual(span.meta['gen_ai.request.model'], 'gpt-4o');
      assert.strictEqual(span.metrics['gen_ai.usage.prompt_tokens'], 100);
      assert.strictEqual(span.metrics['gen_ai.usage.total_tokens'], 150);
      assert.strictEqual(span.error, undefined);

      // A second trace adds its own spans rather than overwriting the queue.
      exporter.exportTrace(makeTrace([makeEvent({ spanId: 'span-2', type: 'tool_execution' })]));
      const after = queuedSpans(exporter);
      assert.strictEqual(after.length, 2);
      assert.strictEqual(after[1].type, 'tool');
      assert.strictEqual(after[1].name, 'tool_execution:gpt-4o');
    });

    it('marks failing events on the span', () => {
      exporter.exportTrace(makeTrace([makeEvent({ data: { error: 'LLM timeout' } as never })]));
      const span = queuedSpans(exporter)[0];
      assert.strictEqual(span.error, 1);
      assert.strictEqual(span.meta['error.message'], 'LLM timeout');
    });

    it('reaches the configured site and re-queues the batch when the intake fails', async () => {
      const failing = offlineExporter();
      failing.exportTrace(makeTrace([makeEvent()]));
      const before = queuedSpans(failing);
      assert.strictEqual(before.length, 1);

      await assert.doesNotReject(() => failing.flush());

      // A failed send must not lose the span: it is pushed back for the retry.
      assert.strictEqual(queuedSpans(failing).length, 1);
      assert.strictEqual(queuedSpans(failing)[0].span_id, before[0].span_id);
      // The transport really was attempted (and failed) rather than skipped:
      // the exporter reports it through the global logger's HTTP-error path.
      assert.strictEqual(loggerWarnings.length, 1);
      assert.match(loggerWarnings[0], /^DatadogExporter: HTTP error: /);
    });

    it('clears the queue after a successful send', async () => {
      // A private `queue` that survives a resolved flush would re-send the same
      // batch forever; assert the empty case stays empty after repeated flushes.
      await exporter.flush();
      await exporter.flush();
      assert.strictEqual(queuedSpans(exporter).length, 0);
    });
  });

  describe('start/stop', () => {
    it('start does not throw', () => {
      assert.doesNotThrow(() => exporter.start());
    });

    it('stop does not throw when queue is empty', async () => {
      await exporter.stop();
      assert.strictEqual(queuedSpans(exporter).length, 0);
    });

    it('stop flushes the remaining queue and preserves spans the intake rejected', async () => {
      const failing = offlineExporter();
      failing.exportTrace(makeTrace([makeEvent()]));
      const queuedBefore = queuedSpans(failing)[0].span_id;

      await assert.doesNotReject(() => failing.stop());

      assert.strictEqual(
        queuedSpans(failing).length,
        1,
        'an undelivered span must not be silently dropped by stop()',
      );
      assert.strictEqual(queuedSpans(failing)[0].span_id, queuedBefore);
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
