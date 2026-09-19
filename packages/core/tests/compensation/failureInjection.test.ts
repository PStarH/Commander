/**
 * Tests for FailureInjection — chaos harness for the reversibility runtime.
 *
 * Covers:
 *   - FailureInjector rule matching and probability
 *   - HTTP wrapper (timeout, 500, 429, connection refused, etc.)
 *   - DB wrapper (deadlock, failover)
 *   - FS wrapper (disk full, I/O hang)
 *   - Scenario presets
 *   - runScenario helper
 *   - maxInvocations decrement
 *   - Deterministic RNG via seed
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  FailureInjector,
  SCENARIOS,
  runScenario,
  type FaultRule,
  type HttpRequest,
  type HttpResponse,
} from '../../src/compensation/failureInjection';

describe('FailureInjection', () => {
  describe('FailureInjector', () => {
    it('creates an injector with default options', () => {
      const inj = new FailureInjector();
      assert.strictEqual(inj.injectedCount(), 0);
      assert.strictEqual(inj.getInjected().length, 0);
    });

    it('creates an injector with a seed for deterministic RNG', async () => {
      const inj1 = new FailureInjector({ seed: 42 });
      const inj2 = new FailureInjector({ seed: 42 });
      inj1.addRule({ target: 'http', mode: 'http_500', probability: 0.5 });
      inj2.addRule({ target: 'http', mode: 'http_500', probability: 0.5 });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped1 = inj1.wrapHttp(send);
      const wrapped2 = inj2.wrapHttp(send);
      const req: HttpRequest = { method: 'GET', url: 'http://test', timeoutMs: 100 };

      const outcomes1: number[] = [];
      const outcomes2: number[] = [];
      for (let i = 0; i < 20; i++) {
        outcomes1.push((await wrapped1({ ...req })).status);
        outcomes2.push((await wrapped2({ ...req })).status);
      }

      // Two injectors sharing a seed must produce the identical decision sequence.
      assert.deepStrictEqual(outcomes1, outcomes2, 'same seed must replay the same sequence');
      // mulberry32(42) with p=0.5 injects on exactly 9 of the first 20 draws.
      assert.strictEqual(inj1.injectedCount(), 9);
      assert.strictEqual(inj2.injectedCount(), 9);
      assert.strictEqual(
        outcomes1.filter((s) => s === 500).length,
        9,
        'injected calls must surface as 500s',
      );

      // A different seed must produce a different sequence — proves the seeded
      // RNG is actually wired in rather than falling through to Math.random.
      const inj3 = new FailureInjector({ seed: 7 });
      inj3.addRule({ target: 'http', mode: 'http_500', probability: 0.5 });
      const wrapped3 = inj3.wrapHttp(send);
      const outcomes3: number[] = [];
      for (let i = 0; i < 20; i++) outcomes3.push((await wrapped3({ ...req })).status);
      assert.strictEqual(inj3.injectedCount(), 11);
      assert.notDeepStrictEqual(outcomes1, outcomes3, 'seed 7 must diverge from seed 42');
    });

    it('addRule adds a fault rule', () => {
      const inj = new FailureInjector();
      inj.addRule({ target: 'http', mode: 'http_500' });
      assert.strictEqual(inj.invocations, 0);
    });

    it('addScenario adds a predefined scenario', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addScenario('network-500');
      assert.strictEqual(inj.invocations, 0);
    });

    it('reset clears all rules and injected failures', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'http_500' });
      inj.reset();
      assert.strictEqual(inj.injectedCount(), 0);
    });
  });

  describe('HTTP wrapper', () => {
    it('passes through when no rule matches', async () => {
      const inj = new FailureInjector();
      const send = async (req: HttpRequest): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: 'ok',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(inj.injectedCount(), 0);
    });

    it('injects HTTP 500', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'http_500' });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(inj.injectedCount(), 1);
    });

    it('injects HTTP 429 with retry-after header', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'http_429' });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 429);
      assert.ok(res.headers['retry-after']);
    });

    it('injects connection refused', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'refused' });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.ok, false);
      assert.ok(res.body.includes('refused'));
    });

    it('injects auth expired (401)', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'auth_expired' });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 401);
    });

    it('injects IAM deny (403)', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'iam_deny' });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://test' });
      assert.strictEqual(res.status, 403);
    });

    it('respects probability setting', async () => {
      const inj = new FailureInjector({ seed: 42 });
      inj.addRule({ target: 'http', mode: 'http_500', probability: 0.0 });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: 'ok',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      // With probability 0, should never inject
      for (let i = 0; i < 10; i++) {
        const res = await wrapped({ method: 'GET', url: 'http://test' });
        assert.strictEqual(res.status, 200, `Iteration ${i}: should not inject`);
      }
      assert.strictEqual(inj.injectedCount(), 0);
    });

    it('respects maxInvocations', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'http', mode: 'http_500', maxInvocations: 2 });
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: 'ok',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      // First two calls should inject
      const r1 = await wrapped({ method: 'GET', url: 'http://t' });
      const r2 = await wrapped({ method: 'GET', url: 'http://t' });
      assert.strictEqual(r1.status, 500);
      assert.strictEqual(r2.status, 500);
      // Third call should pass through
      const r3 = await wrapped({ method: 'GET', url: 'http://t' });
      assert.strictEqual(r3.status, 200);
      assert.strictEqual(inj.injectedCount(), 2);
    });
  });

  describe('DB wrapper', () => {
    it('injects db deadlock', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'db', mode: 'db_deadlock' });
      const mockDb = {
        query: () => 'result',
      };
      const wrapped = inj.wrapDb(mockDb);
      assert.throws(() => wrapped.query('SELECT 1'), /SQLITE_BUSY/);
      assert.strictEqual(inj.injectedCount(), 1);
    });

    it('injects db failover', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'db', mode: 'db_failover' });
      const mockDb = { query: () => 'ok' };
      const wrapped = inj.wrapDb(mockDb);
      assert.throws(() => wrapped.query('SELECT 1'), /failover/);
    });

    it('passes through when no db rule matches', () => {
      const inj = new FailureInjector();
      const mockDb = { query: () => 'ok' };
      const wrapped = inj.wrapDb(mockDb);
      assert.strictEqual(wrapped.query('SELECT 1'), 'ok');
    });
  });

  describe('FS wrapper', () => {
    it('injects disk full', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'fs', mode: 'disk_full' });
      const mockFs = { writeFileSync: () => {} };
      const wrapped = inj.wrapFs(mockFs);
      assert.throws(() => wrapped.writeFileSync('/test', 'data'), /ENOSPC/);
      assert.strictEqual(inj.injectedCount(), 1);
    });

    it('injects I/O hang', () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addRule({ target: 'fs', mode: 'io_hang' });
      const mockFs = { readFileSync: () => 'data' };
      const wrapped = inj.wrapFs(mockFs);
      assert.throws(() => wrapped.readFileSync('/test'), /I\/O hang/);
    });

    it('passes through when no fs rule matches', () => {
      const inj = new FailureInjector();
      const mockFs = { readFileSync: () => 'data' };
      const wrapped = inj.wrapFs(mockFs);
      assert.strictEqual(wrapped.readFileSync('/test'), 'data');
    });
  });

  describe('SCENARIOS presets', () => {
    it('contains network-timeout scenario', () => {
      assert.ok(SCENARIOS['network-timeout']);
      assert.strictEqual(SCENARIOS['network-timeout'].target, 'http');
      assert.strictEqual(SCENARIOS['network-timeout'].mode, 'timeout');
    });

    it('contains db-deadlock scenario', () => {
      assert.ok(SCENARIOS['db-deadlock']);
      assert.strictEqual(SCENARIOS['db-deadlock'].target, 'db');
    });

    it('contains flaky-network scenario with probability', () => {
      assert.ok(SCENARIOS['flaky-network']);
      assert.strictEqual(SCENARIOS['flaky-network'].probability, 0.3);
    });

    it('contains clock-skew scenario', () => {
      assert.ok(SCENARIOS['clock-skew']);
      assert.strictEqual(SCENARIOS['clock-skew'].target, 'clock');
    });

    it('can be added via addScenario', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addScenario('network-500');
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);
      const res = await wrapped({ method: 'GET', url: 'http://t' });
      assert.strictEqual(res.status, 500);
    });
  });

  describe('runScenario', () => {
    it('runs a scenario and returns a report', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addScenario('network-500');
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);

      const report = await runScenario({
        name: 'test-scenario',
        setup: () => {},
        work: async () => {
          try {
            await wrapped({ method: 'GET', url: 'http://test' });
          } catch {
            // expected
          }
        },
        injector: inj,
      });

      assert.strictEqual(report.scenarioName, 'test-scenario');
      assert.ok(report.totalInvocations >= 1);
      assert.ok(report.durationMs >= 0);
      assert.ok(typeof report.success === 'boolean');
      assert.ok(report.byMode);
      assert.ok(report.byCategory);
    });

    it('captures failed work as success=false', async () => {
      const inj = new FailureInjector();
      const report = await runScenario({
        name: 'fail-scenario',
        setup: () => {},
        work: async () => {
          throw new Error('intentional failure');
        },
        injector: inj,
      });
      assert.strictEqual(report.success, false);
    });

    it('runs teardown after work', async () => {
      const inj = new FailureInjector();
      let tornDown = false;
      await runScenario({
        name: 'teardown-test',
        setup: () => {},
        work: async () => {},
        teardown: () => {
          tornDown = true;
        },
        injector: inj,
      });
      assert.strictEqual(tornDown, true);
    });

    it('categorizes injected failures correctly', async () => {
      const inj = new FailureInjector({ seed: 1 });
      inj.addScenario('network-500');
      const send = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      });
      const wrapped = inj.wrapHttp(send);

      const report = await runScenario({
        name: 'categorize-test',
        setup: () => {},
        work: async () => {
          await wrapped({ method: 'GET', url: 'http://t' });
        },
        injector: inj,
      });

      // http_500 → dependency category
      assert.ok(
        report.byCategory.dependency >= 1,
        `network-500 must be categorized as dependency, got ${JSON.stringify(report.byCategory)}`,
      );
    });
  });

  describe('clock skew', () => {
    it('skewClock adjusts the clock', async () => {
      const inj = new FailureInjector({ seed: 1 });
      const before = Date.now();
      inj.skewClock(5000);
      inj.addRule({ target: 'http', mode: 'http_500' });

      const wrapped = inj.wrapHttp(async () => ({
        status: 200,
        headers: {},
        body: '',
        ok: true,
      }));
      await wrapped({ method: 'GET', url: 'http://skew-test' });

      const injected = inj.getInjected();
      assert.strictEqual(injected.length, 1, 'the rule must fire so a timestamp is recorded');
      const stamped = injected[0]!.timestamp;
      // skewClock(5000) makes the injector's clock read ~5s ahead of wall time.
      assert.ok(
        stamped >= before + 5000 && stamped <= Date.now() + 5000,
        `injected timestamp ${stamped} must be ~5000ms ahead of ${before}`,
      );
    });
  });
});
