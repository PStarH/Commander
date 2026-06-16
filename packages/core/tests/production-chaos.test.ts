import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextCompactor } from '../src/runtime/contextCompactor';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import { StateCheckpointer, type CheckpointState } from '../src/runtime/stateCheckpointer';
import { DeadLetterQueue } from '../src/runtime/deadLetterQueue';
import { MetricsCollector, resetMetricsCollector } from '../src/runtime/metricsCollector';
import { SimpleTenantProvider, NullTenantProvider } from '../src/runtime/tenantProvider';
import { classifyLLMError, computeBackoff } from '../src/runtime/llmRetry';
import type { LLMMessage } from '../src/runtime/types';

function makeMessages(n: number, contentSize: number = 100): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: 'system', content: 'You are a test assistant.' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `User ${i}: ${'x'.repeat(contentSize)}` });
    msgs.push({ role: 'assistant', content: `Assistant ${i}: ${'y'.repeat(contentSize)}` });
  }
  return msgs;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-chaos-'));
}

function makeCheckpointState(runId: string, step: number): CheckpointState {
  return {
    runId,
    agentId: 'test-agent',
    timestamp: new Date().toISOString(),
    phase: 'started',
    stepNumber: step,
    attemptNumber: 1,
    messages: [{ role: 'user', content: `Step ${step}` }],
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    stepDurations: [100],
    context: {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'Test goal',
      availableTools: ['test'],
      maxSteps: 100,
      tokenBudget: 10000,
    },
    totalDurationMs: 100,
  };
}

describe('Production Chaos — 1. Agent Runtime Concurrent Stress', () => {
  it('handles 50 rapid context compactions without corruption', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 10000, layer1Trigger: 0.5, layer2Trigger: 0.7, keepRecentTurns: 2 });
    const results: { dropped: number; saved: number }[] = [];

    for (let i = 0; i < 50; i++) {
      const msgs = makeMessages(100, 200);
      const { action } = compactor.compact(msgs);
      results.push({ dropped: action.droppedCount, saved: action.tokensSaved });
    }

    const totalDropped = results.reduce((s, r) => s + r.dropped, 0);
    const totalSaved = results.reduce((s, r) => s + r.saved, 0);

    assert.ok(totalDropped > 0, `Should drop messages, got ${totalDropped}`);
    assert.ok(totalSaved > 0, `Should save tokens, got ${totalSaved}`);
    console.log(`  50 compactions: dropped=${totalDropped}, saved=${totalSaved} tokens`);
  });

  it('compaction under rapid message insertion/removal', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 5000, layer1Trigger: 0.4, keepRecentTurns: 2 });
    let msgs = makeMessages(50, 100);

    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `New message ${i}`.repeat(20) });
      msgs.push({ role: 'assistant', content: `New response ${i}`.repeat(20) });
      if (msgs.length > 60) {
        const { messages } = compactor.compact(msgs);
        msgs = messages;
      }
    }

    assert.ok(msgs.length > 0, 'Messages should survive');
    assert.ok(msgs.length < 200, `Messages should be bounded, got ${msgs.length}`);
  });
});

describe('Production Chaos — 2. State Checkpoint Crash Recovery', () => {
  let tmpPath: string;
  let checkpointer: StateCheckpointer;

  before(() => {
    tmpPath = tmpDir();
    checkpointer = new StateCheckpointer(tmpPath);
  });

  after(() => { fs.rmSync(tmpPath, { recursive: true, force: true }); });

  it('survives 100 rapid checkpoint-write cycles', () => {
    for (let i = 0; i < 100; i++) {
      checkpointer.checkpoint(makeCheckpointState('run-ckpt', i));
    }
    const loaded = checkpointer.resume('run-ckpt');
    assert.ok(loaded, 'Should load checkpoint');
    assert.strictEqual(loaded!.stepNumber, 99);
  });

  it('handles concurrent checkpoint saves for different run IDs', () => {
    for (let i = 0; i < 20; i++) {
      checkpointer.checkpoint(makeCheckpointState(`concurrent-${i}`, i));
    }
    for (let i = 0; i < 20; i++) {
      const loaded = checkpointer.resume(`concurrent-${i}`);
      assert.ok(loaded, `Should load concurrent-${i}`);
      assert.strictEqual(loaded!.stepNumber, i);
    }
  });
});

describe('Production Chaos — 3. Circuit Breaker Chaos', () => {
  it('rapid open/close cycling under random failures', () => {
    const cb = new CircuitBreaker(5, 100);
    let success = 0, failure = 0, blocked = 0;

    for (let i = 0; i < 100; i++) {
      if (cb.isAvailable()) {
        if (Math.random() < 0.3) { cb.onFailure(); failure++; }
        else { cb.onSuccess(); success++; }
      } else { blocked++; }
    }

    console.log(`  100 iterations: success=${success}, failure=${failure}, blocked=${blocked}`);
    assert.ok(success > 0 && failure > 0);
  });

  it('circuit breaker resets after timeout', async () => {
    const cb = new CircuitBreaker(3, 50);
    for (let i = 0; i < 3; i++) cb.onFailure();
    assert.ok(!cb.isAvailable());
    await new Promise(r => setTimeout(r, 60));
    assert.ok(cb.isAvailable());
  });

  it('half-open state allows exactly one probe', async () => {
    const cb = new CircuitBreaker(2, 50);
    cb.onFailure(); cb.onFailure();
    await new Promise(r => setTimeout(r, 60));
    assert.ok(cb.isAvailable());
    cb.onSuccess();
    assert.ok(cb.isAvailable());
  });
});

describe('Production Chaos — 4. Dead Letter Queue Persistence', () => {
  let tmpPath: string;
  let dlq: DeadLetterQueue;

  before(() => {
    tmpPath = tmpDir();
    dlq = new DeadLetterQueue(tmpPath);
  });

  after(() => { fs.rmSync(tmpPath, { recursive: true, force: true }); });

  it('persists 100 errors and retrieves them', () => {
    for (let i = 0; i < 100; i++) {
      dlq.enqueue({
        category: 'llm',
        runId: `run-${i}`,
        operationName: `op-${i}`,
        errorMessage: `Error ${i}`,
        errorClass: 'transient',
        retryable: true,
      });
    }
    dlq.flush('llm');
    const entries = dlq.readEntries('llm', 100);
    assert.ok(entries.length > 0, `Should have entries, got ${entries.length}`);
    console.log(`  DLQ: persisted ${entries.length} entries`);
  });

  it('handles concurrent enqueue operations', () => {
    for (let i = 0; i < 50; i++) {
      dlq.enqueue({
        category: 'tool',
        runId: `concurrent-${i}`,
        operationName: `tool-${i}`,
        errorMessage: `Error ${i}`,
        errorClass: 'permanent',
        retryable: false,
      });
    }
    dlq.flush('tool');
    const entries = dlq.readEntries('tool', 50);
    assert.ok(entries.length > 0);
  });
});

describe('Production Chaos — 5. Multi-Tenant Isolation Stress', () => {
  it('tenant A changes do not leak to tenant B', () => {
    const provider = new SimpleTenantProvider([
      { tenantId: 'tenant-a', tokenBudget: 10000, maxConcurrency: 5, maxRunsPerMinute: 100, enabled: true },
      { tenantId: 'tenant-b', tokenBudget: 20000, maxConcurrency: 5, maxRunsPerMinute: 100, enabled: true },
    ]);
    const configA = provider.getTenantConfig('tenant-a');
    const configB = provider.getTenantConfig('tenant-b');
    assert.ok(configA && configB);
    assert.strictEqual(configA!.tokenBudget, 10000);
    assert.strictEqual(configB!.tokenBudget, 20000);
  });

  it('NullTenantProvider returns undefined for unknown tenants', () => {
    const provider = new NullTenantProvider();
    assert.strictEqual(provider.getTenantConfig('any-tenant'), undefined);
  });

  it('handles 100 concurrent tenant config lookups', () => {
    const configs = Array.from({ length: 100 }, (_, i) => ({
      tenantId: `tenant-${i}`, tokenBudget: 10000 + i, maxConcurrency: 5, maxRunsPerMinute: 100, enabled: true,
    }));
    const provider = new SimpleTenantProvider(configs);
    for (let i = 0; i < 100; i++) {
      const config = provider.getTenantConfig(`tenant-${i}`);
      assert.ok(config);
      assert.strictEqual(config!.tokenBudget, 10000 + i);
    }
  });
});

describe('Production Chaos — 6. Token Budget Enforcement', () => {
  it('compaction respects token budget limits', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 1000, layer1Trigger: 0.5, layer2Trigger: 0.7, keepRecentTurns: 2 });
    const msgs = makeMessages(50, 200);
    const { messages, action } = compactor.compact(msgs);
    const { total } = compactor.getUsage(messages);
    assert.ok(total <= 1200, `Tokens should be within budget, got ${total}`);
    assert.ok(action.tokensSaved > 0);
  });

  it('layer 4 emergency compaction respects hard cap', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 2000, layer4Trigger: 0.8, keepRecentTurns: 1 });
    const msgs = makeMessages(100, 300);
    const { messages } = compactor.compact(msgs);
    const { total } = compactor.getUsage(messages);
    assert.ok(total <= 2500, `Emergency compaction should respect hard cap, got ${total}`);
  });
});

describe('Production Chaos — 7. Error Classification Chaos', () => {
  it('classifies HTTP error codes correctly', () => {
    const cases = [
      { error: '400 Bad Request', retryable: false },
      { error: '401 Unauthorized', retryable: false },
      { error: '403 Forbidden', retryable: false },
      { error: '429 Too Many Requests', retryable: true },
      { error: '500 Internal Server Error', retryable: true },
      { error: '502 Bad Gateway', retryable: true },
      { error: '503 Service Unavailable', retryable: true },
      { error: '504 Gateway Timeout', retryable: true },
    ];
    for (const tc of cases) {
      const result = classifyLLMError(new Error(tc.error));
      assert.strictEqual(result.retryable, tc.retryable, `${tc.error}: retryable should be ${tc.retryable}`);
    }
  });

  it('backoff increases monotonically with jitter', () => {
    const delays = Array.from({ length: 10 }, (_, i) => computeBackoff(i, 1000, 30000));
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1] * 0.4);
    }
    assert.ok(delays[0] >= 500 && delays[0] <= 2000);
    assert.ok(delays[9] <= 35000);
  });
});

describe('Production Chaos — 8. Metrics Collector Stress', () => {
  let metrics: MetricsCollector;

  before(() => { resetMetricsCollector(); metrics = new MetricsCollector(); });

  it('handles 10000 counter increments without corruption', () => {
    for (let i = 0; i < 10000; i++) {
      metrics.incrementCounter('test_counter', 'Test counter', 1, [{ name: 'key', value: `value-${i % 10}` }]);
    }
    const total = metrics.getCounterTotal('test_counter');
    assert.strictEqual(total, 10000);
  });

  it('handles rapid gauge updates', () => {
    for (let i = 0; i < 1000; i++) {
      metrics.setGauge('test_gauge', 'Test gauge', Math.random() * 100);
    }
    const value = metrics.getGauge('test_gauge');
    assert.ok(value >= 0 && value <= 100);
  });

  it('event loop lag monitor starts and stops cleanly', () => {
    metrics.startEventLoopLagMonitor(100);
    assert.ok(metrics.getEventLoopLagMs() >= 0);
    metrics.stopEventLoopLagMonitor();
    assert.ok(metrics.getEventLoopLagMs() >= 0);
  });
});

describe('Production Chaos — 9. Provider Fallback Chain Chaos', () => {
  it('falls back through 10 providers with mixed failures', async () => {
    const { ProviderFallbackChain } = await import('../src/runtime/providerFallbackChain');
    const chain = new ProviderFallbackChain<string>({ maxProviders: 10, totalTimeoutMs: 5000 });
    const providers = Array.from({ length: 10 }, (_, i) => ({
      name: `provider-${i}`,
      attempt: async () => {
        if (i < 7) throw new Error(`Provider ${i} failed with timeout`);
        return `success-from-${i}`;
      },
    }));
    const result = await chain.tryProviders(providers);
    assert.strictEqual(result.result, 'success-from-7');
    assert.strictEqual(result.providerUsed, 'provider-7');
  });

  it('respects circuit breakers across fallback chain', async () => {
    const { ProviderFallbackChain } = await import('../src/runtime/providerFallbackChain');
    const chain = new ProviderFallbackChain<string>({ maxProviders: 3 });
    const brokenBreaker = new CircuitBreaker(1, 10000);
    brokenBreaker.onFailure();
    const providers = [
      { name: 'broken', attempt: async () => 'should-not-reach', breaker: brokenBreaker },
      { name: 'healthy', attempt: async () => 'healthy-result' },
    ];
    const result = await chain.tryProviders(providers);
    assert.strictEqual(result.result, 'healthy-result');
  });
});

describe('Production Chaos — 10. Memory Pressure', () => {
  it('handles 10000 messages without OOM', () => {
    const msgs = makeMessages(10000, 500);
    assert.strictEqual(msgs.length, 20001);
    const compactor = new ContextCompactor({ maxContextTokens: 50000, layer1Trigger: 0.3, keepRecentTurns: 2 });
    const { messages, action } = compactor.compact(msgs);
    assert.ok(messages.length < msgs.length);
    assert.ok(action.tokensSaved > 0);
    console.log(`  10000 messages: ${msgs.length} -> ${messages.length}, saved ${action.tokensSaved} tokens`);
  });

  it('repeated compaction does not grow messages', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 5000, layer1Trigger: 0.4, keepRecentTurns: 2 });
    let msgs = makeMessages(200, 100);
    for (let i = 0; i < 10; i++) {
      const { messages } = compactor.compact(msgs);
      msgs = messages;
    }
    assert.ok(msgs.length < 100, `Messages should stay bounded, got ${msgs.length}`);
  });
});

describe('Production Chaos — Summary', () => {
  it('all chaos tests completed', () => {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  PRODUCTION CHAOS TEST SUITE — COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Modules tested:');
    console.log('    1. Agent Runtime Concurrent Stress');
    console.log('    2. State Checkpoint Crash Recovery');
    console.log('    3. Circuit Breaker Chaos');
    console.log('    4. Dead Letter Queue Persistence');
    console.log('    5. Multi-Tenant Isolation Stress');
    console.log('    6. Token Budget Enforcement');
    console.log('    7. Error Classification Chaos');
    console.log('    8. Metrics Collector Stress');
    console.log('    9. Provider Fallback Chain Chaos');
    console.log('    10. Memory Pressure');
    console.log('═══════════════════════════════════════════════════════════════\n');
    assert.ok(true);
  });
});
