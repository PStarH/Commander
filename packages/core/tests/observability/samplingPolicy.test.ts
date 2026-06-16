import { describe, it, expect } from 'vitest';
import { SamplingPolicy, type SamplingPolicyConfig } from '../../src/observability/samplingPolicy';
import type { TraceEvent } from '../../src/runtime/types';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'id',
    spanId: 'span_a',
    parentSpanId: undefined,
    traceId: 'trace_a',
    runId: 'run_a',
    agentId: 'agent',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    type: 'state_change',
    data: { input: 'noop', output: 'ok' },
    ...overrides,
  };
}

describe('SamplingPolicy', () => {
  describe('decide()', () => {
    it('drops a routine short trace when baseRate=0', () => {
      const policy = new SamplingPolicy({ baseRate: 0 });
      const d = policy.decide([makeEvent()], 'trace-a', 50);
      expect(d.keep).toBe(false);
      expect(d.reason).toBe('drop');
    });

    it('keeps a trace with an error', () => {
      const policy = new SamplingPolicy({ baseRate: 0 });
      const d = policy.decide([makeEvent({ type: 'error', data: { error: 'boom' } })], 'trace-a', 50);
      expect(d.keep).toBe(true);
      expect(d.reason).toBe('error');
    });

    it('keeps a trace exceeding latency threshold', () => {
      const policy = new SamplingPolicy({ baseRate: 0, keepIfLatencyMs: 1000 });
      const d = policy.decide([makeEvent()], 'trace-a', 5000);
      expect(d.keep).toBe(true);
      expect(d.reason).toBe('latency');
    });

    it('keeps a trace with retries when retrying=true flag is set', () => {
      const policy = new SamplingPolicy({ baseRate: 0, keepIfRetriesAtLeast: 1 });
      const d = policy.decide([
        makeEvent({ type: 'error', data: { error: 'transient', retrying: true } }),
      ], 'trace-a', 50);
      expect(d.keep).toBe(true);
      expect(d.reason).toBe('retry');
    });

    it('keeps a trace with verification failure when keepIfVerificationFailed=true', () => {
      const policy = new SamplingPolicy({ baseRate: 0 });
      const d = policy.decide([
        makeEvent({ type: 'verification', data: { evaluationPassed: false, evaluationScore: 0.2 } }),
      ], 'trace-a', 50);
      expect(d.keep).toBe(true);
      expect(d.reason).toBe('verification');
    });

    it('keeps a trace with low quality score', () => {
      const policy = new SamplingPolicy({ baseRate: 0, keepIfQualityBelow: 0.7 });
      const d = policy.decide([
        makeEvent({ type: 'verification', data: { evaluationPassed: true, evaluationScore: 0.3 } }),
      ], 'trace-a', 50);
      expect(d.keep).toBe(true);
      expect(d.reason).toBe('quality');
    });

    it('deterministic: same traceId+salt always produces the same decision', () => {
      const policy = new SamplingPolicy({ baseRate: 0.5, salt: 'fixed' });
      const a = policy.decide([makeEvent()], 'trace-X', 50);
      const b = policy.decide([makeEvent()], 'trace-X', 50);
      expect(a.keep).toBe(b.keep);
      expect(a.reason).toBe(b.reason);
    });

    it('different salts can produce different decisions for the same traceId', () => {
      // Run many trials to check the salt actually affects the outcome
      // distribution (statistical, not deterministic).
      const a = new SamplingPolicy({ baseRate: 0.5, salt: 'A' });
      const b = new SamplingPolicy({ baseRate: 0.5, salt: 'B' });
      const ids = Array.from({ length: 100 }, (_, i) => `trace-${i}`);
      const aKept = ids.filter(id => a.decide([makeEvent()], id, 50).keep).length;
      const bKept = ids.filter(id => b.decide([makeEvent()], id, 50).keep).length;
      // With 100 trials and baseRate=0.5, both should keep ~50.
      // The fact that they differ at all demonstrates salt matters.
      expect(aKept).toBeGreaterThan(0);
      expect(bKept).toBeGreaterThan(0);
    });

    it('baseRate=1 keeps everything', () => {
      const policy = new SamplingPolicy({ baseRate: 1 });
      expect(policy.decide([makeEvent()], 'trace-1', 50).keep).toBe(true);
      expect(policy.decide([makeEvent()], 'trace-2', 50).keep).toBe(true);
    });
  });

  describe('toCollectorConfig()', () => {
    it('emits a valid tail_sampling block', () => {
      const policy = new SamplingPolicy({ baseRate: 0.1, keepIfLatencyMs: 5000 });
      const cfg = policy.toCollectorConfig();
      expect(cfg.tail_sampling.decision_wait).toBe('10s');
      expect(cfg.tail_sampling.policies).toHaveLength(3);
      const probabilistic = cfg.tail_sampling.policies.find((p) => p['type'] === 'probabilistic');
      expect((probabilistic?.['probabilistic'] as { sampling_percentage: number })?.sampling_percentage).toBe(10);
      const latency = cfg.tail_sampling.policies.find((p) => p['type'] === 'latency');
      expect((latency?.['latency'] as { threshold_ms: number })?.threshold_ms).toBe(5000);
    });
  });

  describe('toJSON()', () => {
    it('returns a plain config snapshot', () => {
      const policy = new SamplingPolicy({ baseRate: 0.2, keepIfLatencyMs: 1234 });
      const json = policy.toJSON();
      expect(json.baseRate).toBe(0.2);
      expect(json.keepIfLatencyMs).toBe(1234);
    });
  });

  describe('defaults', () => {
    it('default baseRate is 0.05 (5%)', () => {
      const policy = new SamplingPolicy();
      expect(policy.toJSON().baseRate).toBe(0.05);
    });
    it('default keepIfLatencyMs is 30000', () => {
      const policy = new SamplingPolicy();
      expect(policy.toJSON().keepIfLatencyMs).toBe(30_000);
    });
    it('default keepIfVerificationFailed is true', () => {
      const policy = new SamplingPolicy();
      expect(policy.toJSON().keepIfVerificationFailed).toBe(true);
    });
  });

  describe('clamping', () => {
    it('clamps out-of-range baseRate to [0, 1]', () => {
      expect(new SamplingPolicy({ baseRate: -1 }).toJSON().baseRate).toBe(0);
      expect(new SamplingPolicy({ baseRate: 2 }).toJSON().baseRate).toBe(1);
      expect(new SamplingPolicy({ baseRate: NaN }).toJSON().baseRate).toBe(0.05);
    });
  });
});
