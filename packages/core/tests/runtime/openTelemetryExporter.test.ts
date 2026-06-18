import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
