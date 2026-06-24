import { describe, it, expect } from 'vitest';
import { SamplingPolicy, type SamplingPolicyConfig } from '../src/samplingPolicy';
import type { TraceEvent } from '@commander/core';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    spanId: `span_${Date.now()}_${Math.random()}`,
    traceId: 'trace_123',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    data: {},
    ...overrides,
  };
}

describe('SamplingPolicy', () => {
  describe('head-based sampling', () => {
    it('keeps traces at 100% rate', () => {
      const policy = new SamplingPolicy({ baseRate: 1.0, salt: 'test' });
      const events = [makeEvent()];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('base');
    });

    it('drops traces at 0% rate (unless tail rules apply)', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [makeEvent()];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(false);
      expect(decision.reason).toBe('drop');
    });

    it('is deterministic for the same traceId', () => {
      const policy = new SamplingPolicy({ baseRate: 0.5, salt: 'test' });
      const events = [makeEvent()];
      const d1 = policy.decide(events, 'trace-1', 100);
      const d2 = policy.decide(events, 'trace-1', 100);
      expect(d1.keep).toBe(d2.keep);
      expect(d1.reason).toBe(d2.reason);
    });

    it('different salts produce different results for same traceIds', () => {
      const events = [makeEvent()];
      const p1 = new SamplingPolicy({ baseRate: 0.5, salt: 'salt-a' });
      const p2 = new SamplingPolicy({ baseRate: 0.5, salt: 'salt-b' });
      let diffCount = 0;
      for (let i = 0; i < 100; i++) {
        const d1 = p1.decide(events, `trace-${i}`, 100);
        const d2 = p2.decide(events, `trace-${i}`, 100);
        if (d1.keep !== d2.keep) diffCount++;
      }
      expect(diffCount).toBeGreaterThan(0);
    });
  });

  describe('tail-based rules', () => {
    it('always keeps traces with errors', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [makeEvent({ type: 'error', data: { error: 'boom' } }), makeEvent()];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('error');
    });

    it('always keeps traces with retries', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [makeEvent({ type: 'error', data: { retrying: true } }), makeEvent()];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('retry');
    });

    it('always keeps traces with transient error class', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [makeEvent({ type: 'error', data: { errorClass: 'transient' } })];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('retry');
    });

    it('always keeps traces exceeding latency threshold', () => {
      const policy = new SamplingPolicy({ baseRate: 0, keepIfLatencyMs: 1000, salt: 'test' });
      const events = [makeEvent()];
      const decision = policy.decide(events, 'trace-1', 2000);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('latency');
    });

    it('always keeps traces with failed verification', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [makeEvent({ type: 'verification', data: { evaluationPassed: false } })];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('verification');
    });

    it('always keeps traces with low quality score', () => {
      const policy = new SamplingPolicy({ baseRate: 0, keepIfQualityBelow: 0.5, salt: 'test' });
      const events = [makeEvent({ type: 'verification', data: { evaluationScore: 0.3 } })];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.keep).toBe(true);
      expect(decision.reason).toBe('quality');
    });

    it('retry rule takes precedence over error rule', () => {
      const policy = new SamplingPolicy({ baseRate: 0, salt: 'test' });
      const events = [
        makeEvent({ type: 'error', data: { retrying: true, errorClass: 'transient' } }),
        makeEvent({ type: 'error', data: { error: 'permanent' } }),
      ];
      const decision = policy.decide(events, 'trace-1', 100);
      expect(decision.reason).toBe('retry');
    });
  });

  describe('config', () => {
    it('clamps probability to [0, 1]', () => {
      const p1 = new SamplingPolicy({ baseRate: -1 });
      expect(p1.toJSON().baseRate).toBe(0);
      const p2 = new SamplingPolicy({ baseRate: 2 });
      expect(p2.toJSON().baseRate).toBe(1);
    });

    it('uses defaults when no config provided', () => {
      const policy = new SamplingPolicy();
      const json = policy.toJSON();
      expect(json.baseRate).toBe(0.05);
      expect(json.keepIfLatencyMs).toBe(30000);
      expect(json.keepIfErrorsAtLeast).toBe(1);
    });
  });

  describe('toCollectorConfig', () => {
    it('returns valid collector config structure', () => {
      const policy = new SamplingPolicy({ baseRate: 0.1 });
      const config = policy.toCollectorConfig();
      expect(config.tail_sampling).toBeDefined();
      expect(config.tail_sampling.policies.length).toBeGreaterThan(0);
      const probabilistic = config.tail_sampling.policies.find((p) => p.type === 'probabilistic');
      expect(probabilistic).toBeDefined();
    });
  });

  describe('toJSON', () => {
    it('returns all config fields', () => {
      const policy = new SamplingPolicy({ salt: 'my-salt' });
      const json = policy.toJSON();
      expect(json.salt).toBe('my-salt');
      expect(json.keepIfRetriesAtLeast).toBe(1);
      expect(json.keepIfQualityBelow).toBe(0.5);
      expect(json.keepIfVerificationFailed).toBe(true);
    });
  });
});
