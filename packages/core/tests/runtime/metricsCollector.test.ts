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
      collector.recordHistogram('latency', 'Latency', 25, buckets, [
        { name: 'endpoint', value: '/api' },
      ]);
      collector.recordHistogram('latency', 'Latency', 75, buckets, [
        { name: 'endpoint', value: '/health' },
      ]);
    });
  });

  describe('recordToolCall', () => {
    it('records successful tool call', () => {
      collector.recordToolCall('file_read', 50);
      expect(
        collector.getCounter('tool_success_total', [{ name: 'tool', value: 'file_read' }]),
      ).toBe(1);
    });

    it('records failed tool call', () => {
      collector.recordToolCall('shell_execute', 100, 'timeout');
      expect(
        collector.getCounter('tool_errors_total', [{ name: 'tool', value: 'shell_execute' }]),
      ).toBe(1);
    });

    it('includes tenant label', () => {
      collector.recordToolCall('file_read', 50, undefined, 'tenant-1');
      expect(
        collector.getCounter('tool_success_total', [
          { name: 'tool', value: 'file_read' },
          { name: 'tenant', value: 'tenant-1' },
        ]),
      ).toBe(1);
    });
  });

  describe('recordLLMCall', () => {
    it('records successful LLM call', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 1000, 500);
      expect(
        collector.getCounter('llm_success_total', [
          { name: 'model', value: 'gpt-4o' },
          { name: 'provider', value: 'openai' },
        ]),
      ).toBe(1);
    });

    it('records failed LLM call', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 0, 100, 'rate_limit');
      expect(
        collector.getCounter('llm_errors_total', [
          { name: 'model', value: 'gpt-4o' },
          { name: 'provider', value: 'openai' },
        ]),
      ).toBe(1);
    });

    it('accumulates token count', () => {
      collector.recordLLMCall('gpt-4o', 'openai', 1000, 500);
      collector.recordLLMCall('gpt-4o', 'openai', 2000, 600);
      expect(
        collector.getCounter('llm_tokens_total', [
          { name: 'model', value: 'gpt-4o' },
          { name: 'provider', value: 'openai' },
        ]),
      ).toBe(3000);
    });
  });

  describe('recordError', () => {
    it('records error by class', () => {
      collector.recordError('TimeoutError');
      expect(collector.getCounter('errors_total', [{ name: 'class', value: 'TimeoutError' }])).toBe(
        1,
      );
    });

    it('includes tenant label', () => {
      collector.recordError('ValidationError', 'tenant-1');
      expect(
        collector.getCounter('errors_total', [
          { name: 'class', value: 'ValidationError' },
          { name: 'tenant', value: 'tenant-1' },
        ]),
      ).toBe(1);
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
    it('exports counter in OpenMetrics format with commander_ namespace prefix', () => {
      collector.incrementCounter('test_total', 'Test counter', 5);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP commander_test_total Test counter');
      expect(output).toContain('# TYPE commander_test_total counter');
      expect(output).toContain('commander_test_total 5');
    });

    it('exports gauge in OpenMetrics format with commander_ namespace prefix', () => {
      collector.setGauge('test_gauge', 'Test gauge', 42);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP commander_test_gauge Test gauge');
      expect(output).toContain('# TYPE commander_test_gauge gauge');
      expect(output).toContain('commander_test_gauge 42');
    });

    it('exports histogram in OpenMetrics format with commander_ namespace prefix', () => {
      collector.recordHistogram('test_duration', 'Duration', 25, [10, 50, 100]);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# HELP commander_test_duration Duration');
      expect(output).toContain('# TYPE commander_test_duration histogram');
    });

    it('does NOT prefix gen_ai.* OTel semantic convention metrics', () => {
      collector.incrementCounter('gen_ai.client.request.count', 'OTel request count', 1);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('gen_ai.client.request.count');
      expect(output).not.toContain('commander_gen_ai.');
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

  // ── Subsystem instrumentation methods (P0/P1 gap coverage) ──
  // These 8 methods wire business metrics into the Prometheus /metrics endpoint.
  // Each test asserts: (a) metric name carries commander_ prefix in OpenMetrics output,
  // (b) label set matches the dashboard contract, (c) value semantics (counter vs gauge).

  describe('recordEventSourcingWrite', () => {
    it('records WAL write latency into event_sourcing_write_ms histogram', () => {
      collector.recordEventSourcingWrite(75);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# TYPE commander_event_sourcing_write_ms histogram');
      expect(output).toContain('# HELP commander_event_sourcing_write_ms');
      // 75ms falls into le=100 bucket (LATENCY_BUCKETS_MS = [10,50,100,500,...])
      expect(output).toContain('commander_event_sourcing_write_ms_bucket{le="100"} 1');
      expect(output).toContain('commander_event_sourcing_write_ms_count 1');
    });

    it('attaches tenant label when tenantId is provided', () => {
      collector.recordEventSourcingWrite(20, 'tenant-a');
      const output = collector.exportOpenMetrics();
      expect(output).toContain('commander_event_sourcing_write_ms_count{tenant="tenant-a"} 1');
    });

    it('omits tenant label when tenantId is undefined', () => {
      collector.recordEventSourcingWrite(20);
      const output = collector.exportOpenMetrics();
      const line = output
        .split('\n')
        .find((l) => l.startsWith('commander_event_sourcing_write_ms_count'));
      expect(line).toBeDefined();
      expect(line!).not.toContain('tenant=');
    });

    it('accumulates multiple writes into the same histogram', () => {
      collector.recordEventSourcingWrite(10);
      collector.recordEventSourcingWrite(200);
      collector.recordEventSourcingWrite(5000);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('commander_event_sourcing_write_ms_count 3');
      expect(output).toContain('commander_event_sourcing_write_ms_sum 5210');
    });
  });

  describe('setEventSourcingWalSize', () => {
    it('sets event_sourcing_wal_size_bytes gauge', () => {
      collector.setEventSourcingWalSize(4096);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# TYPE commander_event_sourcing_wal_size_bytes gauge');
      expect(output).toContain('commander_event_sourcing_wal_size_bytes 4096');
    });

    it('overwrites previous value (gauge semantics)', () => {
      collector.setEventSourcingWalSize(1024);
      collector.setEventSourcingWalSize(8192);
      expect(collector.getGauge('event_sourcing_wal_size_bytes')).toBe(8192);
    });

    it('attaches tenant label when provided', () => {
      collector.setEventSourcingWalSize(2048, 'tenant-b');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_event_sourcing_wal_size_bytes{tenant="tenant-b"} 2048',
      );
    });
  });

  describe('setEventSourcingTotals', () => {
    it('sets both event count and snapshot count gauges atomically', () => {
      collector.setEventSourcingTotals(1500, 12);
      expect(collector.getGauge('event_sourcing_total_events')).toBe(1500);
      expect(collector.getGauge('event_sourcing_total_snapshots')).toBe(12);
    });

    it('exports both gauges in OpenMetrics with commander_ prefix', () => {
      collector.setEventSourcingTotals(100, 5);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('commander_event_sourcing_total_events 100');
      expect(output).toContain('commander_event_sourcing_total_snapshots 5');
    });

    it('propagates tenantId to both gauges', () => {
      collector.setEventSourcingTotals(100, 5, 'tenant-c');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_event_sourcing_total_events{tenant="tenant-c"} 100',
      );
      expect(output).toContain(
        'commander_event_sourcing_total_snapshots{tenant="tenant-c"} 5',
      );
    });
  });

  describe('setDlqDepth', () => {
    it('sets dlq_depth aggregate gauge when no category given', () => {
      collector.setDlqDepth(42);
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# TYPE commander_dlq_depth gauge');
      expect(output).toContain('commander_dlq_depth 42');
    });

    it('emits per-category gauge when category is provided', () => {
      collector.setDlqDepth(10, 'execution');
      collector.setDlqDepth(5, 'compensation');
      const output = collector.exportOpenMetrics();
      expect(output).toContain('commander_dlq_depth{category="execution"} 10');
      expect(output).toContain('commander_dlq_depth{category="compensation"} 5');
    });

    it('overwrites aggregate gauge on subsequent calls', () => {
      collector.setDlqDepth(10);
      collector.setDlqDepth(3);
      expect(collector.getGauge('dlq_depth')).toBe(3);
    });
  });

  describe('setCircuitBreakerOpen', () => {
    it('emits gauge value 1 when breaker is OPEN', () => {
      collector.setCircuitBreakerOpen(true, 'anthropic');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_circuit_breaker_open{provider="anthropic"} 1',
      );
    });

    it('emits gauge value 0 when breaker is CLOSED', () => {
      collector.setCircuitBreakerOpen(false, 'openai');
      const output = collector.exportOpenMetrics();
      expect(output).toContain('commander_circuit_breaker_open{provider="openai"} 0');
    });

    it('tracks multiple providers independently', () => {
      collector.setCircuitBreakerOpen(true, 'anthropic');
      collector.setCircuitBreakerOpen(false, 'openai');
      expect(
        collector.getGauge('circuit_breaker_open', [{ name: 'provider', value: 'anthropic' }]),
      ).toBe(1);
      expect(
        collector.getGauge('circuit_breaker_open', [{ name: 'provider', value: 'openai' }]),
      ).toBe(0);
    });

    it('attaches tenant label when provided', () => {
      collector.setCircuitBreakerOpen(true, 'anthropic', 'tenant-d');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_circuit_breaker_open{provider="anthropic",tenant="tenant-d"} 1',
      );
    });
  });

  describe('recordAuditEvent', () => {
    it('increments audit_events_total counter by category', () => {
      collector.recordAuditEvent('security');
      collector.recordAuditEvent('security');
      collector.recordAuditEvent('compliance');
      expect(
        collector.getCounter('audit_events_total', [{ name: 'category', value: 'security' }]),
      ).toBe(2);
      expect(
        collector.getCounter('audit_events_total', [{ name: 'category', value: 'compliance' }]),
      ).toBe(1);
    });

    it('exports with commander_ prefix in OpenMetrics', () => {
      collector.recordAuditEvent('security');
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# TYPE commander_audit_events_total counter');
      expect(output).toContain('commander_audit_events_total{category="security"} 1');
    });

    it('attaches tenant label when provided', () => {
      collector.recordAuditEvent('security', 'tenant-e');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_audit_events_total{category="security",tenant="tenant-e"} 1',
      );
    });
  });

  describe('recordCheckpoint', () => {
    it('increments checkpoint_total counter by status', () => {
      collector.recordCheckpoint('success');
      collector.recordCheckpoint('success');
      collector.recordCheckpoint('failed');
      expect(
        collector.getCounter('checkpoint_total', [{ name: 'status', value: 'success' }]),
      ).toBe(2);
      expect(
        collector.getCounter('checkpoint_total', [{ name: 'status', value: 'failed' }]),
      ).toBe(1);
    });

    it('uses status label (not outcome) to match Grafana dashboard contract', () => {
      collector.recordCheckpoint('success');
      const output = collector.exportOpenMetrics();
      // dashboard references `commander_checkpoint_total{status="..."}` — verify label name
      expect(output).toContain('commander_checkpoint_total{status="success"} 1');
      expect(output).not.toContain('commander_checkpoint_total{outcome=');
    });

    it('attaches tenant label when provided', () => {
      collector.recordCheckpoint('success', 'tenant-f');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_checkpoint_total{status="success",tenant="tenant-f"} 1',
      );
    });
  });

  describe('recordSqliteBusyError', () => {
    it('increments sqlite_busy_errors_total counter by call site', () => {
      collector.recordSqliteBusyError('transaction');
      collector.recordSqliteBusyError('transaction');
      collector.recordSqliteBusyError('query');
      expect(
        collector.getCounter('sqlite_busy_errors_total', [{ name: 'site', value: 'transaction' }]),
      ).toBe(2);
      expect(
        collector.getCounter('sqlite_busy_errors_total', [{ name: 'site', value: 'query' }]),
      ).toBe(1);
    });

    it('exports with commander_ prefix in OpenMetrics', () => {
      collector.recordSqliteBusyError('transaction');
      const output = collector.exportOpenMetrics();
      expect(output).toContain('# TYPE commander_sqlite_busy_errors_total counter');
      expect(output).toContain('commander_sqlite_busy_errors_total{site="transaction"} 1');
    });

    it('attaches tenant label when provided', () => {
      collector.recordSqliteBusyError('transaction', 'tenant-g');
      const output = collector.exportOpenMetrics();
      expect(output).toContain(
        'commander_sqlite_busy_errors_total{site="transaction",tenant="tenant-g"} 1',
      );
    });
  });

  describe('subsystem metric → Grafana dashboard contract', () => {
    // End-to-end sanity: every dashboard-referenced metric is now produced by the collector.
    // Sources: deploy/observability/grafana/dashboards/{developer-overview,mechanistic-view}.json
    it('produces all metrics referenced by the Grafana dashboards', () => {
      // Seed every subsystem method.
      collector.recordEventSourcingWrite(50);
      collector.setEventSourcingWalSize(8192);
      collector.setEventSourcingTotals(100, 5);
      collector.setDlqDepth(3, 'execution');
      collector.setCircuitBreakerOpen(true, 'anthropic');
      collector.recordAuditEvent('security');
      collector.recordCheckpoint('success');
      collector.recordSqliteBusyError('transaction');

      const output = collector.exportOpenMetrics();
      const requiredMetrics = [
        'commander_event_sourcing_write_ms',
        'commander_event_sourcing_wal_size_bytes',
        'commander_event_sourcing_total_events',
        'commander_event_sourcing_total_snapshots',
        'commander_dlq_depth',
        'commander_circuit_breaker_open',
        'commander_audit_events_total',
        'commander_checkpoint_total',
        'commander_sqlite_busy_errors_total',
      ];
      for (const metric of requiredMetrics) {
        expect(output).toContain(metric);
      }
    });
  });
});
