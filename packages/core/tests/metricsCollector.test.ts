import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  MetricsCollector,
  getMetricsCollector,
  resetMetricsCollector,
} from '../src/runtime/metricsCollector';

describe('MetricsCollector', () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = new MetricsCollector();
  });

  describe('Counters', () => {
    it('increments from zero', () => {
      mc.incrementCounter('test_total', 'Test counter');
      assert.strictEqual(mc.getCounter('test_total'), 1);
    });

    it('increments by arbitrary values', () => {
      mc.incrementCounter('test_total', 'Test counter', 5);
      assert.strictEqual(mc.getCounter('test_total'), 5);
    });

    it('tracks label variants independently', () => {
      mc.incrementCounter('ops_total', 'Ops', 1, [{ name: 'kind', value: 'a' }]);
      mc.incrementCounter('ops_total', 'Ops', 2, [{ name: 'kind', value: 'b' }]);
      assert.strictEqual(mc.getCounter('ops_total', [{ name: 'kind', value: 'a' }]), 1);
      assert.strictEqual(mc.getCounter('ops_total', [{ name: 'kind', value: 'b' }]), 2);
    });

    it('returns 0 for unknown counter', () => {
      assert.strictEqual(mc.getCounter('nonexistent'), 0);
    });
  });

  describe('Gauges', () => {
    it('sets and gets a value', () => {
      mc.setGauge('active_workers', 'Workers', 5);
      assert.strictEqual(mc.getGauge('active_workers'), 5);
    });

    it('overwrites previous value', () => {
      mc.setGauge('active_workers', 'Workers', 5);
      mc.setGauge('active_workers', 'Workers', 3);
      assert.strictEqual(mc.getGauge('active_workers'), 3);
    });

    it('returns 0 for unknown gauge', () => {
      assert.strictEqual(mc.getGauge('nonexistent'), 0);
    });

    it('tracks label variants independently', () => {
      mc.setGauge('queue_depth', 'Queue', 10, [{ name: 'queue', value: 'high' }]);
      mc.setGauge('queue_depth', 'Queue', 5, [{ name: 'queue', value: 'low' }]);
      assert.strictEqual(mc.getGauge('queue_depth', [{ name: 'queue', value: 'high' }]), 10);
      assert.strictEqual(mc.getGauge('queue_depth', [{ name: 'queue', value: 'low' }]), 5);
    });
  });

  describe('Histograms', () => {
    const buckets = [10, 50, 100];

    it('records and distributes values into buckets', () => {
      mc.recordHistogram('latency_ms', 'Latency', 30, buckets);
      // 30 falls into bucket 50 (le=50), not 10 (le=10)
      const result = mc.exportOpenMetrics();
      assert.ok(result.includes('latency_ms_bucket{le="10"} 0'));
      assert.ok(result.includes('latency_ms_bucket{le="50"} 1'));
      assert.ok(result.includes('latency_ms_bucket{le="100"} 1'));
      assert.ok(result.includes('latency_ms_bucket{le="+Inf"} 1'));
    });

    it('records values in +Inf bucket when above max bucket', () => {
      mc.recordHistogram('latency_ms', 'Latency', 200, buckets);
      const result = mc.exportOpenMetrics();
      assert.ok(result.includes('latency_ms_bucket{le="+Inf"} 1'));
    });

    it('accumulates sum and count', () => {
      mc.recordHistogram('latency_ms', 'Latency', 10, buckets);
      mc.recordHistogram('latency_ms', 'Latency', 20, buckets);
      const result = mc.exportOpenMetrics();
      assert.ok(result.includes('latency_ms_sum 30'));
      assert.ok(result.includes('latency_ms_count 2'));
    });

    it('handles single value', () => {
      mc.recordHistogram('latency_ms', 'Latency', 5, buckets);
      assert.ok(mc.exportOpenMetrics().includes('latency_ms_bucket{le="10"} 1'));
    });
  });

  describe('recordToolCall', () => {
    it('records success counter and duration', () => {
      mc.recordToolCall('read_file', 42);
      assert.strictEqual(mc.getCounter('tool_success_total', [{ name: 'tool', value: 'read_file' }]), 1);
      assert.strictEqual(mc.getCounter('tool_errors_total', [{ name: 'tool', value: 'read_file' }]), 0);
    });

    it('records error counter on failure', () => {
      mc.recordToolCall('read_file', 42, 'ENOENT');
      assert.strictEqual(mc.getCounter('tool_errors_total', [{ name: 'tool', value: 'read_file' }]), 1);
      assert.strictEqual(mc.getCounter('tool_success_total', [{ name: 'tool', value: 'read_file' }]), 0);
    });

    it('preserves histogram on multiple calls', () => {
      mc.recordToolCall('search', 10);
      mc.recordToolCall('search', 200);
      const result = mc.exportOpenMetrics();
      assert.ok(result.includes('tool_duration_ms_count{tool="search"} 2'));
    });
  });

  describe('recordLLMCall', () => {
    it('records success, tokens, and duration', () => {
      mc.recordLLMCall('gpt-4', 'openai', 150, 500);
      assert.strictEqual(
        mc.getCounter('llm_success_total', [{ name: 'model', value: 'gpt-4' }, { name: 'provider', value: 'openai' }]),
        1,
      );
      assert.strictEqual(
        mc.getCounter('llm_tokens_total', [{ name: 'model', value: 'gpt-4' }, { name: 'provider', value: 'openai' }]),
        150,
      );
    });

    it('records error on failure', () => {
      mc.recordLLMCall('gpt-4', 'openai', 0, 500, 'timeout');
      assert.strictEqual(
        mc.getCounter('llm_errors_total', [{ name: 'model', value: 'gpt-4' }, { name: 'provider', value: 'openai' }]),
        1,
      );
    });
  });

  describe('recordError', () => {
    it('counts by error class', () => {
      mc.recordError('permanent');
      mc.recordError('permanent');
      mc.recordError('transient');
      assert.strictEqual(mc.getCounter('errors_total', [{ name: 'class', value: 'permanent' }]), 2);
      assert.strictEqual(mc.getCounter('errors_total', [{ name: 'class', value: 'transient' }]), 1);
    });
  });

  describe('recordRunComplete', () => {
    it('records success runs', () => {
      mc.recordRunComplete('success', 1200, 5);
      assert.strictEqual(mc.getCounter('runs_total', [{ name: 'status', value: 'success' }]), 1);
    });

    it('records failed runs', () => {
      mc.recordRunComplete('failed', 3000, 2);
      assert.strictEqual(mc.getCounter('runs_total', [{ name: 'status', value: 'failed' }]), 1);
    });
  });

  describe('exportOpenMetrics', () => {
    it('produces valid OpenMetrics text', () => {
      mc.incrementCounter('requests_total', 'Total requests');
      mc.setGauge('uptime_seconds', 'Uptime', 3600);
      mc.recordHistogram('duration_ms', 'Duration', 50, [10, 100]);

      const output = mc.exportOpenMetrics();
      assert.ok(output.startsWith('# HELP commander_metrics'));
      assert.ok(output.includes('# TYPE requests_total counter'));
      assert.ok(output.includes('# TYPE uptime_seconds gauge'));
      assert.ok(output.includes('# TYPE duration_ms histogram'));
      assert.ok(output.endsWith('# EOF\n'));
    });

    it('includes label values with quoting', () => {
      mc.incrementCounter('ops_total', 'Ops', 1, [{ name: 'kind', value: 'read' }]);
      const output = mc.exportOpenMetrics();
      assert.ok(output.includes('ops_total{kind="read"} 1'));
    });
  });

  describe('exportJSONLines', () => {
    it('produces valid NDJSON with timestamp', () => {
      mc.incrementCounter('test_total', 'Test counter');
      const output = mc.exportJSONLines();
      const lines = output.trim().split('\n');
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.type, 'counter');
      assert.strictEqual(parsed.name, 'test_total');
      assert.ok(typeof parsed.timestamp === 'number');
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      mc.incrementCounter('test_total', 'Test counter');
      mc.setGauge('active', 'Active', 1);
      mc.recordHistogram('dur', 'Duration', 50, [100]);
      mc.reset();
      assert.strictEqual(mc.getCounter('test_total'), 0);
      assert.strictEqual(mc.getGauge('active'), 0);
      assert.strictEqual(mc.listMetricNames().length, 0);
    });
  });

  describe('listMetricNames', () => {
    it('returns sorted unique metric names', () => {
      mc.incrementCounter('z_total', 'Z');
      mc.setGauge('a_gauge', 'A');
      mc.recordHistogram('m_hist', 'M', 1, [10]);
      const names = mc.listMetricNames();
      assert.deepStrictEqual(names, ['a_gauge', 'm_hist', 'z_total']);
    });
  });
});

describe('getMetricsCollector (singleton)', () => {
  it('returns the same instance', () => {
    resetMetricsCollector();
    const a = getMetricsCollector();
    const b = getMetricsCollector();
    assert.strictEqual(a, b);
  });

  it('resetMetricsCollector creates fresh instance on next call', () => {
    resetMetricsCollector();
    const a = getMetricsCollector();
    a.incrementCounter('test_total', 'Test');
    resetMetricsCollector();
    const b = getMetricsCollector();
    assert.strictEqual(b.getCounter('test_total'), 0);
  });
});
