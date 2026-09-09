import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OpenTelemetryExporter } from '../../src/runtime/openTelemetryExporter';

describe('OpenTelemetryExporter', () => {
  let exporter: OpenTelemetryExporter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-test-'));
    exporter = new OpenTelemetryExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      serviceName: 'commander-test',
      fallbackDir: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates exporter with default config', () => {
      const exp = new OpenTelemetryExporter();
      expect(exp).toBeDefined();
    });

    it('creates exporter with custom config', () => {
      expect(exporter).toBeDefined();
    });
  });

  describe('exportSpan', () => {
    it('exports a span', () => {
      exporter.exportSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'test-span',
        kind: 0,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        attributes: {},
      });
      // No error means success
    });

    it('exports span with parent', () => {
      exporter.exportSpan({
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        name: 'child-span',
        kind: 0,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        attributes: {},
      });
    });

    it('exports span with attributes', () => {
      exporter.exportSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'test-span',
        kind: 0,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        attributes: {
          'service.name': 'commander',
          'agent.id': 'agent-1',
        },
      });
    });
  });

  describe('start/stop', () => {
    it('does not schedule a flush after stop interrupts startup', async () => {
      const interval = vi.spyOn(globalThis, 'setInterval');
      try {
        const starting = exporter.start();
        await exporter.stop();
        await starting;
        expect(interval.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(0);
      } finally {
        await exporter.stop();
        interval.mockRestore();
      }
    });

    it('only schedules the newest startup when restarted during recovery', async () => {
      const interval = vi.spyOn(globalThis, 'setInterval');
      try {
        const starting = exporter.start();
        const stopping = exporter.stop();
        const restarting = exporter.start();
        await Promise.all([starting, stopping, restarting]);
        expect(interval.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);
      } finally {
        await exporter.stop();
        for (const result of interval.mock.results) {
          if (result.type === 'return') clearInterval(result.value);
        }
        interval.mockRestore();
      }
    });

    it('starts and stops cleanly', async () => {
      await exporter.start();
      await exporter.stop();
    });
  });

  describe('getStats', () => {
    it('returns export statistics', () => {
      const stats = exporter.getStats();
      expect(stats).toBeDefined();
    });
  });
});
