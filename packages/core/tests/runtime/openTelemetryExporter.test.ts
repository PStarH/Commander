import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OpenTelemetryExporter } from '../../src/runtime/openTelemetryExporter';
import type { OTelSpan } from '../../src/runtime/openTelemetryExporter';

/**
 * RTC-15 / OPR-18: every test in this file previously ran `exportSpan(...)`
 * with no assertion at all ("No error means success"), and the exporter's PII
 * redaction contract — `gen_ai.prompt`, `gen_ai.completion` and
 * `gen_ai.tool.call.arguments` must never reach the network or the disk
 * fallback — was never asserted anywhere in the repository.
 *
 * The intake endpoint points at the reserved `.invalid` TLD, so the transport
 * fails deterministically with and without network egress, which lets the
 * fallback-to-disk path be asserted rather than assumed.
 */

const UNREACHABLE_ENDPOINT = 'http://commander-test.invalid:4318/v1/traces';

function makeSpan(overrides: Partial<OTelSpan> = {}): OTelSpan {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'test-span',
    kind: 0,
    startTime: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    endTime: new Date('2025-01-01T00:00:01.000Z').toISOString(),
    attributes: {},
    ...overrides,
  };
}

/** The spans queued for the next flush (TS `private`, real at runtime). */
function queuedSpans(exporter: OpenTelemetryExporter): OTelSpan[] {
  return (exporter as unknown as { queue: OTelSpan[] }).queue;
}

function queuedFileContents(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf-8'))
    .join('\n');
}

describe('OpenTelemetryExporter', () => {
  let exporter: OpenTelemetryExporter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-test-'));
    exporter = new OpenTelemetryExporter({
      endpoint: UNREACHABLE_ENDPOINT,
      serviceName: 'commander-test',
      fallbackDir: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('defaults to the local collector endpoint with full redaction on', () => {
      const exp = new OpenTelemetryExporter();
      const config = (exp as unknown as { config: Record<string, unknown> }).config;
      expect(config.endpoint).toBe(
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
      );
      expect(config.serviceName).toBe('commander');
      expect(config.batchSize).toBe(64);
      expect(config.redactInput).toBe(true);
      expect(config.redactOutput).toBe(true);
      expect(config.redactToolArgs).toBe(true);
    });

    it('takes the configured endpoint, service name and redaction opt-outs', () => {
      const exp = new OpenTelemetryExporter({
        endpoint: 'http://collector.internal:4318/v1/traces',
        serviceName: 'my-service',
        redactInput: false,
      });
      const config = (exp as unknown as { config: Record<string, unknown> }).config;
      expect(config.endpoint).toBe('http://collector.internal:4318/v1/traces');
      expect(config.serviceName).toBe('my-service');
      expect(config.redactInput).toBe(false);
      expect(config.redactOutput).toBe(true);
    });
  });

  describe('exportSpan', () => {
    it('queues the span with its identity, link and attributes intact', () => {
      exporter.exportSpan(
        makeSpan({
          spanId: 'span-child',
          parentSpanId: 'span-parent',
          attributes: { 'service.name': 'commander', 'agent.id': 'agent-1', 'retry.count': 2 },
        }),
      );

      const queued = queuedSpans(exporter);
      expect(queued).toHaveLength(1);
      expect(queued[0].traceId).toBe('trace-1');
      expect(queued[0].spanId).toBe('span-child');
      expect(queued[0].parentSpanId).toBe('span-parent');
      expect(queued[0].name).toBe('test-span');
      expect(queued[0].kind).toBe(0);
      expect(queued[0].startTime).toBe('2025-01-01T00:00:00.000Z');
      expect(queued[0].attributes['service.name']).toBe('commander');
      expect(queued[0].attributes['agent.id']).toBe('agent-1');
      expect(queued[0].attributes['retry.count']).toBe(2);
      expect(exporter.getStats().queued).toBe(1);
    });

    it('accepts a span without a parent link', () => {
      exporter.exportSpan(makeSpan({ spanId: 'span-root' }));
      const queued = queuedSpans(exporter);
      expect(queued[0].parentSpanId).toBeUndefined();
    });

    it('strips prompt, completion and tool arguments before the span is queued', () => {
      exporter.exportSpan(
        makeSpan({
          attributes: {
            'gen_ai.prompt': 'raw secret prompt',
            'gen_ai.completion': 'raw secret completion',
            'gen_ai.tool.call.arguments': '{"password":"hunter2"}',
            'gen_ai.tool.name': 'file_read',
            'gen_ai.usage.total_tokens': 42,
          },
        }),
      );

      const attrs = queuedSpans(exporter)[0].attributes;
      expect(attrs).not.toHaveProperty('gen_ai.prompt');
      expect(attrs).not.toHaveProperty('gen_ai.completion');
      expect(attrs).not.toHaveProperty('gen_ai.tool.call.arguments');
      // Non-PII telemetry survives redaction.
      expect(attrs['gen_ai.tool.name']).toBe('file_read');
      expect(attrs['gen_ai.usage.total_tokens']).toBe(42);
    });

    it('strips the unprefixed input/output/arguments aliases too', () => {
      exporter.exportSpan(
        makeSpan({
          attributes: { input: 'a', output: 'b', arguments: 'c', 'tool.args': 'd', keep: 'e' },
        }),
      );
      const attrs = queuedSpans(exporter)[0].attributes;
      expect(Object.keys(attrs)).toEqual(['keep']);
    });

    it('keeps raw prompt when redactInput is explicitly disabled', () => {
      const optOut = new OpenTelemetryExporter({
        endpoint: UNREACHABLE_ENDPOINT,
        fallbackDir: tmpDir,
        redactInput: false,
      });
      optOut.exportSpan(makeSpan({ attributes: { 'gen_ai.prompt': 'kept on purpose' } }));
      expect(queuedSpans(optOut)[0].attributes['gen_ai.prompt']).toBe('kept on purpose');
    });
  });

  describe('start/stop', () => {
    it('flushes the queue and persists rejected spans to the fallback dir without PII', async () => {
      await exporter.start();
      exporter.exportSpan(
        makeSpan({
          attributes: { 'gen_ai.prompt': 'raw secret prompt', 'agent.id': 'agent-1' },
        }),
      );
      expect(exporter.getStats().queued).toBe(1);

      await exporter.stop();

      expect(exporter.getStats().queued).toBe(0);
      expect(exporter.getStats().totalFailed).toBe(1);
      expect(exporter.getStats().totalExported).toBe(0);

      const persisted = queuedFileContents(tmpDir);
      expect(persisted).toContain('agent-1');
      expect(persisted).not.toContain('raw secret prompt');
      expect(persisted).not.toContain('gen_ai.prompt');
    });

    it('stops cleanly with an empty queue', async () => {
      await exporter.start();
      await exporter.stop();
      expect(exporter.getStats().queued).toBe(0);
      expect(exporter.getStats().totalFailed).toBe(0);
    });
  });

  describe('getStats', () => {
    it('reports the queue and buffer configuration', () => {
      expect(exporter.getStats()).toEqual({
        queued: 0,
        totalExported: 0,
        totalFailed: 0,
        bufferOverflowCount: 0,
        spansSampledOut: 0,
        samplingRate: 1,
        maxBufferSize: 10000,
      });
    });

    it('counts dropped spans when the buffer overflows', () => {
      const small = new OpenTelemetryExporter({
        endpoint: UNREACHABLE_ENDPOINT,
        fallbackDir: tmpDir,
        maxBufferSize: 2,
        batchSize: 100,
      });
      for (let i = 0; i < 5; i++) small.exportSpan(makeSpan({ spanId: `span-${i}` }));

      const stats = small.getStats();
      expect(stats.queued).toBe(2);
      expect(stats.bufferOverflowCount).toBe(3);
      // The most recent spans survive; the oldest were evicted.
      expect(queuedSpans(small).map((s) => s.spanId)).toEqual(['span-3', 'span-4']);
    });
  });
});
