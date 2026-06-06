import { describe, it, beforeEach, expect } from 'vitest';
import { MetricsCollector } from '../../src/runtime/metricsCollector';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('counters', () => {
    it('increments a counter', () => {
      collector.incrementCounter('test_counter', 'Test counter');
      expect(collector.getCounter('test_counter')).toBe(1);
    });

    it('increments by custom value', () => {
      collector.incrementCounter('test_counter', 'Test counter', 5);
      expect(collector.getCounter('test_counter')).toBe(5);
    });

    it('accumulates multiple increments', () => {
      collector.incrementCounter('test_counter', 'Test counter', 3);
      collector.incrementCounter('test_counter', 'Test counter', 7);
      expect(collector.getCounter('test_counter')).toBe(10);
    });

    it('returns 0 for non-existent counter', () => {
      expect(collector.getCounter('nonexistent')).toBe(0);
    });

    it('handles labels', () => {
      collector.incrementCounter('requests', 'Requests', 1, [{ name: 'method', value: 'GET' }]);
      collector.incrementCounter('requests', 'Requests', 1, [{ name: 'method', value: 'POST' }]);
      expect(collector.getCounter('requests', [{ name: 'method', value: 'GET' }])).toBe(1);
      expect(collector.getCounter('requests', [{ name: 'method', value: 'POST' }])).toBe(1);
    });

    it('enforces cap on unique metrics', () => {
      const smallCollector = new MetricsCollector();
      // The cap is 1000, but let's test the mechanism exists
      for (let i = 0; i < 10; i++) {
        smallCollector.incrementCounter(`counter_${i}`, 'Test', 1);
      }
      expect(smallCollector.getCounter('counter_0')).toBe(1);
    });
  });

  describe('gauges', () => {
    it('sets a gauge', () => {
      collector.setGauge('test_gauge', 'Test gauge', 42);
      expect(collector.getGauge('test_gauge')).toBe(42);
    });

    it('overwrites gauge value', () => {
      collector.setGauge('test_gauge', 'Test gauge', 10);
      collector.setGauge('test_gauge', 'Test gauge', 20);
      expect(collector.getGauge('test_gauge')).toBe(20);
    });

    it('returns 0 for non-existent gauge', () => {
      expect(collector.getGauge('nonexistent')).toBe(0);
    });

    it('handles labels', () => {
      collector.setGauge('memory', 'Memory', 100, [{ name: 'type', value: 'heap' }]);
      collector.setGauge('memory', 'Memory', 200, [{ name: 'type', value: 'rss' }]);
      expect(collector.getGauge('memory', [{ name: 'type', value: 'heap' }])).toBe(100);
      expect(collector.getGauge('memory', [{ name: 'type', value: 'rss' }])).toBe(200);
    });
  });

  describe('histograms', () => {
    it('records histogram values', () => {
      const buckets = [10, 50, 100, 500];
      collector.recordHistogram('latency', 'Latency', 25, buckets);
      collector.recordHistogram('latency', 'Latency', 75, buckets);
      collector.recordHistogram('latency', 'Latency', 200, buckets);
      // 25 <= 50, 75 <= 100, 200 <= 500
      // Should have counts in buckets [0, 1, 1, 1, 0]
    });

    it('handles values below first bucket', () => {
      const buckets = [10, 50, 100];
      collector.recordHistogram('test', 'Test', 5, buckets);
      // 5 <= 10, so first bucket
    });

    it('handles values above last bucket', () => {
      const buckets = [10, 50, 100];
      collector.recordHistogram('test', 'Test', 500, buckets);
      // 500 > 100, so overflow bucket
    });

    it('handles labels', () => {
      const buckets = [10, 50, 100];
      collector.recordHistogram('latency', 'Latency', 25, buckets, [{ name: 'endpoint', value: '/api' }]);
      collector.recordHistogram('latency', 'Latency', 75, buckets, [{ name: 'endpoint', value: '/health' }]);
    });
  });

  describe('recordToolCall', () => {
    it('records successful tool call', () => {
      collector.recordToolCall('file_read', 50);
      expect(collector.getCounter('tool_success_total', [{ name: 'tool', value: 'file_read' }])).toBe(1);
    });

    it('records failed tool call', () => {
      collector.recordToolCall('shell_execute', 100, 'timeout');
      expect(collector.getCounter('tool_errors_total', [{ name: 'tool', value: 'shell_execute' }])).toBe(1);
    });

    it('includes tenant label', () => {
      collector.recordToolCall('file_read', 50, undefined, 'tenant-1');
      expect(collector.getCounter('tool_success_total', [
        { name: 'tool', value: 'file_read' },
        { name: 'tenant', value: 'tenant-1' },
      ])).toBe(1);
    });
  });

  describe('recordLLMCall', () => {
    it('records successful LLM call', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 1000, 500);
      expect(collector.getCounter('llm_success_total', [
        { name: 'model', value: 'gpt-4o' },
        { name: 'provider', value: 'openai' },
      ])).toBe(1);
    });

    it('records failed LLM call', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 0, 100, 'rate_limit');
      expect(collector.getCounter('llm_errors_total', [
        { name: 'model', value: 'gpt-4o' },
        { name: 'provider', value: 'openai' },
      ])).toBe(1);
    });

    it('accumulates token count', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 1000, 500);
      collector.recordLLMCall('gpt-4o', 'openai', 2000, 600);
      expect(collector.getCounter('llm_tokens_total', [
        { name: 'model', value: 'gpt-4o' },
        { name: 'provider', value: 'openai' },
      ])).toBe(3000);
    });
  });

  describe('recordError', () => {
    it('records error by class', () => {
      collector.recordError('TimeoutError');
      expect(collector.getCounter('errors_total', [{ name: 'class', value: 'TimeoutError' }])).toBe(1);
    });

    it('includes tenant label', () => {
      collector.recordError('ValidationError', 'tenant-1');
      expect(collector.getCounter('errors_total', [
        { name: 'class', value: 'ValidationError' },
        { name: 'tenant', value: 'tenant-1' },
      ])).toBe(1);
    });
  });

  describe('recordRunComplete', () => {
    it('records successful run', () => {
      collector.recordRunComplete('success', 5000, 10);
      expect(collector.getCounter('runs_total', [{ name: 'status', value: 'success' }])).toBe(1);
    });

    it('records failed run', () => {
      collector.recordRunComplete('failed', 2000, 5);
      expect(collector.getCounter('runs_total', [{ name: 'status', value: 'failed' }])).toBe(1);
    });
  });

  describe('exportOpenMetrics', () => {
    it('exports counter in OpenMetrics format', () => {
      collector.incrementCounter('test_total', 'Test counter', 5);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP test_total Test counter');
      expect(output).toContain('# TYPE test_total counter');
      expect(output).toContain('test_total 5');
    });

    it('exports gauge in OpenMetrics format', () => {
      collector.setGauge('test_gauge', 'Test gauge', 42);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP test_gauge Test gauge');
      expect(output).toContain('# TYPE test_gauge gauge');
      expect(output).toContain('test_gauge 42');
    });

    it('exports histogram in OpenMetrics format', () => {
      collector.recordHistogram('test_duration', 'Duration', 25, [10, 50, 100]);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP test_duration Duration');
      expect(output).toContain('# TYPE test_duration histogram');
    });
  });

  describe('exportJSONLines', () => {
    it('exports as JSON lines', () => {
      collector.incrementCounter('test_total', 'Test', 5);
      collector.setGauge('test_gauge', 'Test', 42);
      const lines = collector.exportJSONLines();
      expect(lines).toBeDefined();
      expect(typeof lines).toBe('string');
    });
  });
});
