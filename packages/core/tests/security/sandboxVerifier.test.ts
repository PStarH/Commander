/**
 * SandboxVerifier Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxVerifier, resetSandboxVerifier } from '../../src/security/sandboxVerifier';

// Sandbox verifier tests run actual sandbox commands (shell exec, network
// probes, filesystem checks) which can be slow on CI runners, especially
// Windows. Bump the default vitest timeout from 5s to 30s.
const SANDBOX_TIMEOUT = 30_000;

describe('SandboxVerifier', () => {
  let verifier: SandboxVerifier;

  beforeEach(() => {
    resetSandboxVerifier();
    verifier = new SandboxVerifier();
  });

  afterEach(() => {
    resetSandboxVerifier();
  });

  it('constructs successfully', () => {
    expect(verifier).toBeDefined();
  });

  it(
    'runs verification and returns a report',
    async () => {
      const report = await verifier.verify();
      expect(report).toBeDefined();
      expect(report.reportId).toBeTruthy();
      expect(report.sandboxMechanism).toBeTruthy();
      expect(report.totalTests).toBeGreaterThan(0);
      expect(report.evidence.length).toBeGreaterThan(0);
      expect(typeof report.passed).toBe('boolean');
      expect(typeof report.score).toBe('number');
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
    },
    SANDBOX_TIMEOUT,
  );

  it(
    'quickCheck returns boolean',
    async () => {
      const passed = await verifier.quickCheck();
      expect(typeof passed).toBe('boolean');
    },
    SANDBOX_TIMEOUT,
  );

  it(
    'evidence entries have required fields',
    async () => {
      const report = await verifier.verify();
      for (const ev of report.evidence) {
        expect(ev.testId).toBeTruthy();
        expect(['pass', 'fail', 'skip', 'error']).toContain(ev.result);
        expect(typeof ev.durationMs).toBe('number');
      }
    },
    SANDBOX_TIMEOUT,
  );

  it(
    'results map covers all areas',
    async () => {
      const report = await verifier.verify();
      expect(report.results.file_isolation).toBeDefined();
      expect(report.results.network_isolation).toBeDefined();
      expect(report.results.process_isolation).toBeDefined();
      expect(report.results.env_sanitization).toBeDefined();
      expect(report.results.resource_limits).toBeDefined();
    },
    SANDBOX_TIMEOUT,
  );

  it(
    'includes recommendations for noop sandbox',
    async () => {
      const report = await verifier.verify();
      expect(Array.isArray(report.recommendations)).toBe(true);
    },
    SANDBOX_TIMEOUT,
  );
});
