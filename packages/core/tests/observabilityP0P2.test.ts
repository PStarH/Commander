import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import { CompensationRegistry, type CompensableAction } from '../src/runtime/compensationRegistry';
import { getMetricsCollector, resetMetricsCollector } from '../src/runtime/metricsCollector';

describe('Observability P0–P2 wiring (smoke)', () => {
  beforeEach(() => resetMetricsCollector());

  describe('CircuitBreaker observability', () => {
    it('fires user callback + metric when wired', () => {
      const cb = new CircuitBreaker(2, 1000);
      cb.setProviderName('test');
      const events: string[] = [];
      cb.setObservability({
        onTransition: (from, to, provider) => {
          events.push(`${from}->${to}`);
          getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'test');
        },
      });
      cb.onFailure();
      cb.onFailure();
      assert.deepStrictEqual(events, ['CLOSED->OPEN']);
      const mc = getMetricsCollector();
      const all = mc.listMetricNames();
      assert.ok(all.some(n => n.startsWith('circuit_transitions_total')), 'metric emitted');
    });
  });

  describe('CompensationRegistry observability', () => {
    it('fires user callback + metric on success/failed/exhausted', async () => {
      const reg = new CompensationRegistry();
      const outcomes: string[] = [];
      reg.setObservability({
        onSuccess: (a) => { outcomes.push(`s:${a.toolName}`); getMetricsCollector().recordCompensation(a.toolName, 'success'); },
        onFailed: (a, err) => { outcomes.push(`f:${a.toolName}`); getMetricsCollector().recordCompensation(a.toolName, 'failed'); },
        onExhausted: (a) => { outcomes.push(`e:${a.toolName}`); getMetricsCollector().recordCompensation(a.toolName, 'exhausted'); },
      });
      reg.register('tool_a', async () => ({ success: true }));
      reg.register('tool_b', async () => ({ success: false, error: 'nope' }));
      reg.recordAction({ actionId: 'a1', toolName: 'tool_a', args: {}, description: 'x', tags: [] });
      reg.recordAction({ actionId: 'a2', toolName: 'tool_b', args: {}, description: 'y', tags: [] });
      await reg.compensate('a1');
      await reg.compensate('a2');
      assert.deepStrictEqual(outcomes.sort(), ['f:tool_b', 's:tool_a']);
      const mc = getMetricsCollector();
      const all = mc.listMetricNames();
      assert.ok(all.some(n => n.startsWith('compensation_total')));
    });
  });

  describe('MetricsCollector observability methods', () => {
    it('emits all P0–P2 counters without error', () => {
      const mc = getMetricsCollector();
      mc.recordCircuitTransition('CLOSED', 'OPEN', 'p1', 't1');
      mc.recordCompensation('tool_x', 'success', 't1');
      mc.recordVerificationResult(0.9, true, 3, ['sig1', 'sig2'], 't1');
      mc.recordCascadeEscalation('m1', 'm2', 'fail', 't1');
      mc.recordTopoChoice('PARALLEL', 'code', 't1');
      mc.recordSubAgentOutcome('a1', 'success', 1, 't1');
      mc.recordHookFailure('onLLMCall', 'p1', 't1');
      mc.recordDLQEntry('circuit_breaker', 't1');
      mc.recordIntentEscalation('s1', 's2', 'fail', 't1');
      mc.recordCheckpointFlush('test', 't1');
      mc.recordPartialRun('t1');
      const all = mc.listMetricNames();
      assert.ok(all.includes('circuit_transitions_total'));
      assert.ok(all.includes('compensation_total'));
      assert.ok(all.includes('verification_results_total'));
      assert.ok(all.includes('cascade_escalations_total'));
      assert.ok(all.includes('topology_choices_total'));
      assert.ok(all.includes('sub_agent_outcomes_total'));
      assert.ok(all.includes('hook_failures_total'));
      assert.ok(all.includes('dlq_entries_total'));
      assert.ok(all.includes('intent_escalations_total'));
      assert.ok(all.includes('checkpoint_flushes_total'));
      assert.ok(all.includes('partial_runs_total'));
    });
  });
});
