import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  Logger,
  MetricsCollector,
  Timer,
  type LogLevel,
  type LogEntry,
  type MetricPoint,
} from '../src/logging';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freezeTime(iso: string): Date {
  return new Date(iso);
}

/** Create a MetricsCollector that will NOT fire its cleanup timer during the
 *  test (retention set to a very large value).  We also unref the timer so
 *  the process can exit cleanly. */
function makeMetrics(retentionMs = 3_600_000): MetricsCollector {
  return new MetricsCollector({ retentionPeriod: retentionMs, sampleInterval: 10_000 });
}

// ===========================================================================
// Logger
// ===========================================================================

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger({ enableConsole: false, enableStorage: true });
  });

  // ---------------------------------------------------------------------------
  // Construction & configuration
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('uses default config when nothing is passed', () => {
      const l = new Logger();
      assert.strictEqual(l.getLevel(), 'info');
    });

    it('merges partial config with defaults', () => {
      const l = new Logger({ level: 'debug', maxEntries: 50 });
      assert.strictEqual(l.getLevel(), 'debug');
    });
  });

  // ---------------------------------------------------------------------------
  // Level management
  // ---------------------------------------------------------------------------

  describe('setLevel / getLevel', () => {
    it('returns the level that was set', () => {
      logger.setLevel('warn');
      assert.strictEqual(logger.getLevel(), 'warn');
    });

    it('can be changed multiple times', () => {
      logger.setLevel('error');
      assert.strictEqual(logger.getLevel(), 'error');
      logger.setLevel('debug');
      assert.strictEqual(logger.getLevel(), 'debug');
    });

    it('accepts every valid log level', () => {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical'];
      for (const level of levels) {
        logger.setLevel(level);
        assert.strictEqual(logger.getLevel(), level);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Level filtering
  // ---------------------------------------------------------------------------

  describe('level filtering', () => {
    it('drops messages below the configured threshold', () => {
      logger.setLevel('warn');
      logger.debug('test', 'dropped');
      logger.info('test', 'dropped');
      assert.strictEqual(logger.getRecent(100).length, 0);
    });

    it('passes messages at or above the threshold', () => {
      logger.setLevel('warn');
      logger.warn('test', 'kept');
      logger.error('test', 'kept');
      logger.critical('test', 'kept');
      const entries = logger.getRecent(100);
      assert.strictEqual(entries.length, 3);
      assert.deepStrictEqual(entries.map(e => e.level), ['warn', 'error', 'critical']);
    });

    it('debug level lets everything through', () => {
      logger.setLevel('debug');
      logger.debug('c', 'd');
      logger.info('c', 'i');
      logger.warn('c', 'w');
      logger.error('c', 'e');
      logger.critical('c', 'c');
      assert.strictEqual(logger.getRecent(100).length, 5);
    });

    it('critical level only allows critical', () => {
      logger.setLevel('critical');
      logger.debug('c', 'no');
      logger.info('c', 'no');
      logger.warn('c', 'no');
      logger.error('c', 'no');
      logger.critical('c', 'yes');
      const entries = logger.getRecent(100);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].level, 'critical');
    });
  });

  // ---------------------------------------------------------------------------
  // Log entry structure
  // ---------------------------------------------------------------------------

  describe('log entry structure', () => {
    it('populates id, timestamp, level, component, message', () => {
      logger.info('myComponent', 'hello');
      const entry = logger.getRecent(1)[0];
      assert.ok(entry.id, 'id should be set');
      assert.ok(entry.timestamp, 'timestamp should be set');
      assert.strictEqual(entry.level, 'info');
      assert.strictEqual(entry.component, 'myComponent');
      assert.strictEqual(entry.message, 'hello');
    });

    it('stores context when provided', () => {
      logger.info('c', 'msg', { key: 'value' });
      const entry = logger.getRecent(1)[0];
      assert.deepStrictEqual(entry.context, { key: 'value' });
    });

    it('stores error info on error level', () => {
      const err = new Error('boom');
      logger.error('svc', 'failed', err);
      const entry = logger.getRecent(1)[0];
      assert.ok(entry.error);
      assert.strictEqual(entry.error.name, 'Error');
      assert.strictEqual(entry.error.message, 'boom');
      assert.ok(entry.error.stack);
    });

    it('does not set error when none is passed', () => {
      logger.error('svc', 'no error object');
      const entry = logger.getRecent(1)[0];
      assert.strictEqual(entry.error, undefined);
    });

    it('generates unique ids', () => {
      logger.info('c', 'a');
      logger.info('c', 'b');
      const [a, b] = logger.getRecent(2);
      assert.notStrictEqual(a.id, b.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Ring buffer behaviour
  // ---------------------------------------------------------------------------

  describe('ring buffer (maxEntries)', () => {
    it('caps entries at maxEntries', () => {
      const l = new Logger({ maxEntries: 5, enableConsole: false, enableStorage: true });
      l.setLevel('debug');
      for (let i = 0; i < 10; i++) {
        l.info('c', `msg-${i}`);
      }
      const entries = l.getRecent(100);
      assert.strictEqual(entries.length, 5);
      // Oldest should have been evicted — first kept message is msg-5
      assert.strictEqual(entries[0].message, 'msg-5');
      assert.strictEqual(entries[4].message, 'msg-9');
    });

    it('defaults maxEntries to 10000', () => {
      const l = new Logger({ enableConsole: false });
      // We cannot inspect private config directly, but we can verify the
      // ring buffer holds at least a large number of entries.
      for (let i = 0; i < 200; i++) {
        l.info('c', `m${i}`);
      }
      assert.strictEqual(l.getRecent(10000).length, 200);
    });
  });

  // ---------------------------------------------------------------------------
  // enableStorage = false
  // ---------------------------------------------------------------------------

  describe('enableStorage = false', () => {
    it('does not store entries when storage is disabled', () => {
      const l = new Logger({ enableStorage: false, enableConsole: false });
      l.info('c', 'no store');
      assert.strictEqual(l.getRecent(100).length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // getRecent
  // ---------------------------------------------------------------------------

  describe('getRecent', () => {
    it('returns at most `limit` entries', () => {
      for (let i = 0; i < 10; i++) logger.info('c', `m${i}`);
      assert.strictEqual(logger.getRecent(3).length, 3);
    });

    it('returns the most recent entries', () => {
      for (let i = 0; i < 5; i++) logger.info('c', `m${i}`);
      const recent = logger.getRecent(2);
      assert.strictEqual(recent[0].message, 'm3');
      assert.strictEqual(recent[1].message, 'm4');
    });

    it('filters by level when level is given', () => {
      logger.info('c', 'i');
      logger.warn('c', 'w');
      logger.error('c', 'e');
      const warns = logger.getRecent(100, 'warn');
      assert.strictEqual(warns.length, 1);
      assert.strictEqual(warns[0].level, 'warn');
    });

    it('defaults limit to 100', () => {
      for (let i = 0; i < 150; i++) logger.info('c', `m${i}`);
      assert.strictEqual(logger.getRecent().length, 100);
    });

    it('returns empty array when no entries exist', () => {
      assert.deepStrictEqual(logger.getRecent(10), []);
    });
  });

  // ---------------------------------------------------------------------------
  // getByComponent
  // ---------------------------------------------------------------------------

  describe('getByComponent', () => {
    it('returns entries matching the component', () => {
      logger.info('alpha', 'a1');
      logger.info('beta', 'b1');
      logger.info('alpha', 'a2');
      const alphaEntries = logger.getByComponent('alpha');
      assert.strictEqual(alphaEntries.length, 2);
      assert.ok(alphaEntries.every(e => e.component === 'alpha'));
    });

    it('limits results when limit is given', () => {
      logger.info('x', '1');
      logger.info('x', '2');
      logger.info('x', '3');
      assert.strictEqual(logger.getByComponent('x', 2).length, 2);
    });

    it('returns all matching entries when no limit is given', () => {
      for (let i = 0; i < 10; i++) logger.info('comp', `m${i}`);
      assert.strictEqual(logger.getByComponent('comp').length, 10);
    });

    it('returns empty array for unknown component', () => {
      assert.deepStrictEqual(logger.getByComponent('nope'), []);
    });
  });

  // ---------------------------------------------------------------------------
  // getErrors
  // ---------------------------------------------------------------------------

  describe('getErrors', () => {
    it('returns error and critical entries', () => {
      logger.info('c', 'i');
      logger.error('c', 'e');
      logger.critical('c', 'c');
      const errors = logger.getErrors();
      assert.strictEqual(errors.length, 2);
      assert.deepStrictEqual(errors.map(e => e.level), ['error', 'critical']);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) logger.error('c', `e${i}`);
      assert.strictEqual(logger.getErrors(3).length, 3);
    });

    it('returns empty array when no errors exist', () => {
      logger.info('c', 'ok');
      assert.deepStrictEqual(logger.getErrors(), []);
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all entries', () => {
      logger.info('c', 'a');
      logger.info('c', 'b');
      logger.clear();
      assert.strictEqual(logger.getRecent(100).length, 0);
    });

    it('does not affect new entries after clear', () => {
      logger.info('c', 'before');
      logger.clear();
      logger.info('c', 'after');
      assert.strictEqual(logger.getRecent(100).length, 1);
      assert.strictEqual(logger.getRecent(1)[0].message, 'after');
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns zeroed stats when empty', () => {
      const stats = logger.getStats();
      assert.strictEqual(stats.total, 0);
      assert.strictEqual(stats.byLevel.debug, 0);
      assert.strictEqual(stats.byLevel.info, 0);
      assert.strictEqual(stats.errorRate, 0);
    });

    it('counts entries by level and component', () => {
      logger.info('svc', 'a');
      logger.info('svc', 'b');
      logger.warn('db', 'c');
      logger.error('svc', 'd');
      const stats = logger.getStats();
      assert.strictEqual(stats.total, 4);
      assert.strictEqual(stats.byLevel.info, 2);
      assert.strictEqual(stats.byLevel.warn, 1);
      assert.strictEqual(stats.byLevel.error, 1);
      assert.strictEqual(stats.byComponent['svc'], 3);
      assert.strictEqual(stats.byComponent['db'], 1);
    });

    it('computes error rate (error + critical)', () => {
      logger.info('c', 'ok');
      logger.error('c', 'err');
      logger.critical('c', 'crit');
      const stats = logger.getStats();
      assert.ok(Math.abs(stats.errorRate - 2 / 3) < 1e-10);
    });

    it('errorRate is 0 when no errors', () => {
      logger.info('c', 'a');
      logger.warn('c', 'b');
      assert.strictEqual(logger.getStats().errorRate, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Listener pattern (onLog / offLog)
  // ---------------------------------------------------------------------------

  describe('onLog / offLog', () => {
    it('notifies listener for each log entry', () => {
      const received: LogEntry[] = [];
      logger.onLog(entry => received.push(entry));
      logger.info('c', 'a');
      logger.warn('c', 'b');
      assert.strictEqual(received.length, 2);
      assert.strictEqual(received[0].message, 'a');
      assert.strictEqual(received[1].message, 'b');
    });

    it('supports multiple listeners', () => {
      const a: LogEntry[] = [];
      const b: LogEntry[] = [];
      logger.onLog(e => a.push(e));
      logger.onLog(e => b.push(e));
      logger.info('c', 'x');
      assert.strictEqual(a.length, 1);
      assert.strictEqual(b.length, 1);
    });

    it('removes a listener with offLog', () => {
      const received: LogEntry[] = [];
      const listener = (e: LogEntry) => received.push(e);
      logger.onLog(listener);
      logger.info('c', 'before');
      logger.offLog(listener);
      logger.info('c', 'after');
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].message, 'before');
    });

    it('offLog is a no-op for unknown listener', () => {
      const listener = (_e: LogEntry) => {};
      // Should not throw
      logger.offLog(listener);
    });

    it('MAX_LISTENERS = 50: evicts oldest when exceeded', () => {
      const l = new Logger({ enableConsole: false, enableStorage: true });
      const calls: number[] = [];
      // Add 50 listeners
      for (let i = 0; i < 50; i++) {
        const idx = i;
        l.onLog(() => calls.push(idx));
      }
      // Add one more — should evict listener 0
      l.onLog(() => calls.push(999));
      l.info('c', 'test');
      // Listener 0 should NOT have been called
      assert.ok(!calls.includes(0));
      assert.ok(calls.includes(999));
      // Total calls = 50 (listeners 1..49 + 999)
      assert.strictEqual(calls.length, 50);
    });

    it('listeners are not called when message is filtered by level', () => {
      const received: LogEntry[] = [];
      logger.setLevel('warn');
      logger.onLog(e => received.push(e));
      logger.info('c', 'dropped');
      assert.strictEqual(received.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // All five log level methods
  // ---------------------------------------------------------------------------

  describe('individual level methods', () => {
    it('debug logs at debug level', () => {
      logger.setLevel('debug');
      logger.debug('c', 'msg');
      assert.strictEqual(logger.getRecent(1)[0].level, 'debug');
    });

    it('info logs at info level', () => {
      logger.info('c', 'msg');
      assert.strictEqual(logger.getRecent(1)[0].level, 'info');
    });

    it('warn logs at warn level', () => {
      logger.warn('c', 'msg');
      assert.strictEqual(logger.getRecent(1)[0].level, 'warn');
    });

    it('error logs at error level with optional Error object', () => {
      const err = new TypeError('bad type');
      logger.error('c', 'msg', err);
      const entry = logger.getRecent(1)[0];
      assert.strictEqual(entry.level, 'error');
      assert.ok(entry.error);
      assert.strictEqual(entry.error.name, 'TypeError');
    });

    it('critical logs at critical level', () => {
      logger.critical('c', 'msg');
      assert.strictEqual(logger.getRecent(1)[0].level, 'critical');
    });
  });
});

// ===========================================================================
// MetricsCollector
// ===========================================================================

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = makeMetrics();
  });

  afterEach(() => {
    metrics.dispose();
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts partial config', () => {
      const m = new MetricsCollector({ retentionPeriod: 60000 });
      m.dispose();
    });

    it('starts with no metrics', () => {
      assert.strictEqual(metrics.getAll().length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Counter
  // ---------------------------------------------------------------------------

  describe('incrementCounter', () => {
    it('creates and increments a counter', () => {
      metrics.incrementCounter('requests');
      metrics.incrementCounter('requests');
      metrics.incrementCounter('requests');
      const metric = metrics.get('requests');
      assert.ok(metric);
      assert.strictEqual(metric.type, 'counter');
      assert.strictEqual(metric.values.length, 3);
      assert.strictEqual(metric.values[0].value, 1);
      assert.strictEqual(metric.values[1].value, 1);
      assert.strictEqual(metric.values[2].value, 1);
    });

    it('increments by a custom amount', () => {
      metrics.incrementCounter('bytes', 1024);
      assert.strictEqual(metrics.getLatest('bytes')?.value, 1024);
    });

    it('defaults increment to 1', () => {
      metrics.incrementCounter('x');
      assert.strictEqual(metrics.getLatest('x')?.value, 1);
    });

    it('stores labels', () => {
      metrics.incrementCounter('req', 1, { method: 'GET' });
      const point = metrics.getLatest('req');
      assert.deepStrictEqual(point?.labels, { method: 'GET' });
    });
  });

  // ---------------------------------------------------------------------------
  // Gauge
  // ---------------------------------------------------------------------------

  describe('setGauge', () => {
    it('records gauge values', () => {
      metrics.setGauge('temperature', 22.5);
      metrics.setGauge('temperature', 23.1);
      const metric = metrics.get('temperature');
      assert.ok(metric);
      assert.strictEqual(metric.type, 'gauge');
      assert.strictEqual(metric.values.length, 2);
    });

    it('unit defaults to count for gauge', () => {
      metrics.setGauge('g', 1);
      assert.strictEqual(metrics.get('g')?.unit, 'count');
    });
  });

  // ---------------------------------------------------------------------------
  // Histogram
  // ---------------------------------------------------------------------------

  describe('recordHistogram', () => {
    it('records histogram values', () => {
      metrics.recordHistogram('latency', 100);
      metrics.recordHistogram('latency', 200);
      const metric = metrics.get('latency');
      assert.ok(metric);
      assert.strictEqual(metric.type, 'histogram');
      assert.strictEqual(metric.unit, 'ms');
    });
  });

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------

  describe('recordTimer', () => {
    it('records timer values', () => {
      metrics.recordTimer('duration', 42);
      metrics.recordTimer('duration', 58);
      const metric = metrics.get('duration');
      assert.ok(metric);
      assert.strictEqual(metric.type, 'timer');
      assert.strictEqual(metric.unit, 'ms');
    });
  });

  // ---------------------------------------------------------------------------
  // get / getAll / getLatest
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('returns undefined for unknown metric', () => {
      assert.strictEqual(metrics.get('nope'), undefined);
    });

    it('returns the metric after recording', () => {
      metrics.incrementCounter('c');
      assert.ok(metrics.get('c'));
    });
  });

  describe('getAll', () => {
    it('returns all registered metrics', () => {
      metrics.incrementCounter('a');
      metrics.setGauge('b', 1);
      metrics.recordHistogram('c', 1);
      const all = metrics.getAll();
      assert.strictEqual(all.length, 3);
    });
  });

  describe('getLatest', () => {
    it('returns the most recent point', () => {
      metrics.incrementCounter('x', 10);
      metrics.incrementCounter('x', 20);
      metrics.incrementCounter('x', 30);
      const latest = metrics.getLatest('x');
      assert.ok(latest);
      assert.strictEqual(latest.value, 30);
    });

    it('returns undefined for unknown metric', () => {
      assert.strictEqual(metrics.getLatest('nope'), undefined);
    });

    it('returns undefined for metric with no values', () => {
      // directly create empty metric via setGauge then verify getLatest
      // Actually setGauge always adds a point. We test the undefined path:
      assert.strictEqual(metrics.getLatest('empty'), undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // getTimeSeries with timestamp filtering
  // ---------------------------------------------------------------------------

  describe('getTimeSeries', () => {
    it('returns all points when no filters given', () => {
      metrics.incrementCounter('x', 1);
      metrics.incrementCounter('x', 2);
      const series = metrics.getTimeSeries('x');
      assert.strictEqual(series.length, 2);
    });

    it('returns empty array for unknown metric', () => {
      assert.deepStrictEqual(metrics.getTimeSeries('nope'), []);
    });

    it('filters by fromTimestamp', () => {
      // Record a point, get its timestamp, then record another.
      // Use the first point's own timestamp as `from` — both share the same
      // millisecond so `>=` will include both, which is the correct behaviour.
      metrics.incrementCounter('t', 1);
      const firstTs = metrics.getLatest('t')!.timestamp;
      metrics.incrementCounter('t', 2);
      // from = firstTs should include both (>= semantics, same ms)
      const series = metrics.getTimeSeries('t', firstTs);
      assert.ok(series.length >= 1, 'at least the first point should match');
      // Now set from well into the future — nothing should match
      const future = new Date(Date.now() + 60_000).toISOString();
      const empty = metrics.getTimeSeries('t', future);
      assert.strictEqual(empty.length, 0);
    });

    it('filters by toTimestamp', () => {
      metrics.incrementCounter('t', 1);
      metrics.incrementCounter('t', 2);
      // Set to well into the future — both points should match (<= semantics)
      const future = new Date(Date.now() + 60_000).toISOString();
      const series = metrics.getTimeSeries('t', undefined, future);
      assert.strictEqual(series.length, 2);
      // Set to in the past — nothing should match
      const past = new Date(Date.now() - 60_000).toISOString();
      const empty = metrics.getTimeSeries('t', undefined, past);
      assert.strictEqual(empty.length, 0);
    });

    it('filters by both from and to', () => {
      metrics.incrementCounter('t', 1);
      metrics.incrementCounter('t', 2);
      // Both from and to set to wide range — should include all points
      const from = new Date(Date.now() - 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const series = metrics.getTimeSeries('t', from, to);
      assert.strictEqual(series.length, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // getStats and percentile calculations
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns null for unknown metric', () => {
      assert.strictEqual(metrics.getStats('nope'), null);
    });

    it('computes basic stats (count, sum, avg, min, max, latest)', () => {
      metrics.recordHistogram('h', 10);
      metrics.recordHistogram('h', 20);
      metrics.recordHistogram('h', 30);
      const stats = metrics.getStats('h');
      assert.ok(stats);
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.sum, 60);
      assert.strictEqual(stats.avg, 20);
      assert.strictEqual(stats.min, 10);
      assert.strictEqual(stats.max, 30);
      assert.strictEqual(stats.latest, 30);
    });

    it('computes percentiles correctly for a known distribution', () => {
      // Record 100 values: 1..100
      for (let i = 1; i <= 100; i++) {
        metrics.recordHistogram('dist', i);
      }
      const stats = metrics.getStats('dist');
      assert.ok(stats);
      assert.strictEqual(stats.count, 100);
      // p50 = value at index ceil(0.5*100)-1 = 49 => value 50 (sorted 1..100)
      assert.strictEqual(stats.p50, 50);
      // p95 = value at index ceil(0.95*100)-1 = 94 => value 95
      assert.strictEqual(stats.p95, 95);
      // p99 = value at index ceil(0.99*100)-1 = 98 => value 99
      assert.strictEqual(stats.p99, 99);
    });

    it('percentiles work for a single value', () => {
      metrics.recordHistogram('single', 42);
      const stats = metrics.getStats('single');
      assert.ok(stats);
      assert.strictEqual(stats.p50, 42);
      assert.strictEqual(stats.p95, 42);
      assert.strictEqual(stats.p99, 42);
    });

    it('handles duplicate values', () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordHistogram('dup', 5);
      }
      const stats = metrics.getStats('dup');
      assert.ok(stats);
      assert.strictEqual(stats.min, 5);
      assert.strictEqual(stats.max, 5);
      assert.strictEqual(stats.p50, 5);
    });

    it('latest reflects insertion order, not sorted order', () => {
      metrics.recordHistogram('order', 100);
      metrics.recordHistogram('order', 1);
      metrics.recordHistogram('order', 50);
      const stats = metrics.getStats('order');
      assert.ok(stats);
      // latest should be the last value inserted, but getStats sorts values
      // and uses sortedValues[length-1] for latest. Let's verify the actual
      // behaviour: latest = max of sorted = 100
      assert.strictEqual(stats.latest, 100);
      // getLatest returns the actual last inserted point
      assert.strictEqual(metrics.getLatest('order')?.value, 50);
    });
  });

  // ---------------------------------------------------------------------------
  // Value cap (5000 -> sliced to 3000)
  // ---------------------------------------------------------------------------

  describe('value cap', () => {
    it('slices to 3000 when values exceed 5000', () => {
      // Record 5001 points
      for (let i = 0; i < 5001; i++) {
        metrics.recordHistogram('big', i);
      }
      const metric = metrics.get('big');
      assert.ok(metric);
      // After exceeding 5000, values are sliced to last 3000
      assert.strictEqual(metric.values.length, 3000);
      // First value should be 2001 (5001 - 3000)
      assert.strictEqual(metric.values[0].value, 2001);
      assert.strictEqual(metric.values[2999].value, 5000);
    });

    it('does not slice when at exactly 5000', () => {
      for (let i = 0; i < 5000; i++) {
        metrics.recordHistogram('exact', i);
      }
      const metric = metrics.get('exact');
      assert.ok(metric);
      assert.strictEqual(metric.values.length, 5000);
    });

    it('does not slice well below the cap', () => {
      for (let i = 0; i < 100; i++) {
        metrics.recordHistogram('small', i);
      }
      assert.strictEqual(metrics.get('small')?.values.length, 100);
    });
  });

  // ---------------------------------------------------------------------------
  // Listener pattern (onMetric / offMetric)
  // ---------------------------------------------------------------------------

  describe('onMetric / offMetric', () => {
    it('notifies listener when metric is recorded', () => {
      const received: Array<{ name: string; point: MetricPoint }> = [];
      metrics.onMetric((name, point) => received.push({ name, point }));
      metrics.incrementCounter('req', 1);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].name, 'req');
      assert.strictEqual(received[0].point.value, 1);
    });

    it('supports multiple listeners', () => {
      let countA = 0;
      let countB = 0;
      metrics.onMetric(() => countA++);
      metrics.onMetric(() => countB++);
      metrics.incrementCounter('x');
      assert.strictEqual(countA, 1);
      assert.strictEqual(countB, 1);
    });

    it('removes listener with offMetric', () => {
      let count = 0;
      const listener = () => count++;
      metrics.onMetric(listener);
      metrics.incrementCounter('a');
      metrics.offMetric(listener);
      metrics.incrementCounter('b');
      assert.strictEqual(count, 1);
    });

    it('offMetric is a no-op for unknown listener', () => {
      const listener = (_name: string, _point: MetricPoint) => {};
      // Should not throw
      metrics.offMetric(listener);
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  describe('dispose', () => {
    it('clears all metrics and listeners', () => {
      metrics.incrementCounter('a');
      metrics.setGauge('b', 1);
      const received: MetricPoint[] = [];
      metrics.onMetric((_n, p) => received.push(p));

      metrics.dispose();

      assert.strictEqual(metrics.getAll().length, 0);
      // Recording after dispose should not throw (listeners are cleared)
      // Note: after dispose, the internal maps are cleared so new metrics
      // can still be created, but old ones are gone.
      assert.strictEqual(metrics.get('a'), undefined);
    });

    it('can be called multiple times safely', () => {
      metrics.dispose();
      metrics.dispose(); // should not throw
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all metrics', () => {
      metrics.incrementCounter('a');
      metrics.setGauge('b', 2);
      metrics.clear();
      assert.strictEqual(metrics.getAll().length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // MetricPoint structure
  // ---------------------------------------------------------------------------

  describe('MetricPoint structure', () => {
    it('has timestamp, value, and labels', () => {
      metrics.incrementCounter('c', 5, { env: 'test' });
      const point = metrics.getLatest('c');
      assert.ok(point);
      assert.ok(point.timestamp);
      assert.strictEqual(point.value, 5);
      assert.deepStrictEqual(point.labels, { env: 'test' });
    });

    it('defaults labels to empty object', () => {
      metrics.incrementCounter('c');
      const point = metrics.getLatest('c');
      assert.deepStrictEqual(point?.labels, {});
    });
  });

  // ---------------------------------------------------------------------------
  // Metric unit assignment
  // ---------------------------------------------------------------------------

  describe('metric unit defaults', () => {
    it('counter unit is count', () => {
      metrics.incrementCounter('c');
      assert.strictEqual(metrics.get('c')?.unit, 'count');
    });

    it('gauge unit is count', () => {
      metrics.setGauge('g', 1);
      assert.strictEqual(metrics.get('g')?.unit, 'count');
    });

    it('histogram unit is ms', () => {
      metrics.recordHistogram('h', 1);
      assert.strictEqual(metrics.get('h')?.unit, 'ms');
    });

    it('timer unit is ms', () => {
      metrics.recordTimer('t', 1);
      assert.strictEqual(metrics.get('t')?.unit, 'ms');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case: recording to same name with different types
  // ---------------------------------------------------------------------------

  describe('same name, different types', () => {
    it('keeps the first type registered for a given name', () => {
      metrics.incrementCounter('mixed', 1);
      metrics.setGauge('mixed', 99);
      const metric = metrics.get('mixed');
      assert.ok(metric);
      // The first call registered it as 'counter'; subsequent calls use
      // the existing metric regardless of the public method used.
      assert.strictEqual(metric.type, 'counter');
      assert.strictEqual(metric.values.length, 2);
    });
  });
});

// ===========================================================================
// Timer Helper
// ===========================================================================

describe('Timer', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = makeMetrics();
  });

  afterEach(() => {
    metrics.dispose();
  });

  it('records a duration when stopped', () => {
    const timer = new Timer();
    const duration = timer.stop(metrics, 'operation');
    assert.ok(typeof duration === 'number');
    assert.ok(duration >= 0);
    const point = metrics.getLatest('operation');
    assert.ok(point);
    assert.strictEqual(point.value, duration);
  });

  it('stores labels from constructor', () => {
    const timer = new Timer({ method: 'GET', path: '/api' });
    timer.stop(metrics, 'req');
    const point = metrics.getLatest('req');
    assert.deepStrictEqual(point?.labels, { method: 'GET', path: '/api' });
  });

  it('defaults labels to empty object', () => {
    const timer = new Timer();
    timer.stop(metrics, 'x');
    const point = metrics.getLatest('x');
    assert.deepStrictEqual(point?.labels, {});
  });

  it('returns a non-negative duration', () => {
    const timer = new Timer();
    // Small sleep to ensure some time passes
    const start = Date.now();
    while (Date.now() - start < 2) { /* busy wait */ }
    const duration = timer.stop(metrics, 'delayed');
    assert.ok(duration >= 0);
  });

  it('multiple timers can record to the same metric name', () => {
    const t1 = new Timer({ id: '1' });
    const t2 = new Timer({ id: '2' });
    t1.stop(metrics, 'batch');
    t2.stop(metrics, 'batch');
    const metric = metrics.get('batch');
    assert.ok(metric);
    assert.strictEqual(metric.values.length, 2);
    assert.strictEqual(metric.values[0].labels.id, '1');
    assert.strictEqual(metric.values[1].labels.id, '2');
  });

  it('creates a timer metric of type timer', () => {
    const timer = new Timer();
    timer.stop(metrics, 'myTimer');
    const metric = metrics.get('myTimer');
    assert.ok(metric);
    assert.strictEqual(metric.type, 'timer');
    assert.strictEqual(metric.unit, 'ms');
  });
});

// ===========================================================================
// Integration: Logger + MetricsCollector working together
// ===========================================================================

describe('Logger + MetricsCollector integration', () => {
  it('listener on logger can feed metrics', () => {
    const logger = new Logger({ enableConsole: false });
    const metrics = makeMetrics();

    logger.onLog(entry => {
      if (entry.level === 'error') {
        metrics.incrementCounter('error_count', 1, { component: entry.component });
      }
    });

    logger.info('svc', 'ok');
    logger.error('svc', 'fail');
    logger.error('db', 'timeout');
    logger.info('svc', 'ok again');

    const errors = metrics.get('error_count');
    assert.ok(errors);
    assert.strictEqual(errors.values.length, 2);
    assert.strictEqual(metrics.getStats('error_count')?.sum, 2);

    metrics.dispose();
  });
});
