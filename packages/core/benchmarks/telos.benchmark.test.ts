import { describe, it, expect, afterAll } from 'vitest';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../src/runtime/modelRouter';
import { getMessageBus, resetMessageBus } from '../src/runtime/messageBus';
import { getTraceRecorder, resetTraceRecorder } from '../src/runtime/executionTrace';
import { TokenSentinel, resetTokenSentinel } from '../src/telos/tokenSentinel';
import { TELOSOrchestrator } from '../src/telos/telosOrchestrator';
import { ProviderPool, resetProviderPool } from '../src/telos/providerPool';
import { MockLLMProvider } from '../src/runtime/mockLLMProvider';
import { MCPServer } from '../src/mcp/server';
import { HeuristicEvaluator, EvalSuite } from '../src/telos/evaluator';
import { cosineSimilarity } from '../src/runtime/embedding';
import type { AgentExecutionContext, Tool } from '../src/runtime/types';

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
}

function bench(name: string, iterations: number, fn: () => void): BenchmarkResult {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 100); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - start;
  return {
    name, iterations, totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / iterations) * 1000) / 1000,
    opsPerSec: Math.round((iterations / totalMs) * 1000),
  };
}

function fmt(r: BenchmarkResult): string {
  return `${r.name}: ${r.avgMs.toFixed(3)}ms avg (${r.opsPerSec} ops/sec, ${r.iterations} runs)`;
}

describe('TELOS Benchmarks', () => {
  const results: BenchmarkResult[] = [];

  afterAll(() => {
    console.log('\n═══ TELOS BENCHMARK RESULTS ═══');
    results.sort((a, b) => b.opsPerSec - a.opsPerSec);
    for (const r of results) console.log(fmt(r));
  });

  it('ModelRouter: route a task (1000×)', () => {
    resetModelRouter();
    const router = new ModelRouter();
    const ctx: AgentExecutionContext = {
      agentId: 'bench', projectId: 'bench', goal: 'A complex task that requires careful analysis and planning across multiple components',
      contextData: { governanceProfile: { riskLevel: 'MEDIUM' } },
      availableTools: ['search', 'read', 'write'], maxSteps: 10, tokenBudget: 16000,
    };
    results.push(bench('ModelRouter.route', 1000, () => router.route(ctx)));
  });

  it('TokenSentinel: estimate and check (1000×)', () => {
    resetTokenSentinel();
    const sentinel = new TokenSentinel();
    const msgs = [{ role: 'system', content: 'You are a helpful AI assistant.' }, { role: 'user', content: 'Analyze the architecture.' }];
    const budget = { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 };
    results.push(bench('TokenSentinel.check', 1000, () => sentinel.check(msgs, 'gpt-4o', budget)));
  });

  it('MessageBus: publish + subscribe (10000×)', () => {
    resetMessageBus();
    const bus = getMessageBus();
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    results.push(bench('MessageBus.publish', 10000, () => bus.publish('agent.message', 'bench', 'test')));
  });

  it('ExecutionTrace: record events (1000×)', () => {
    resetTraceRecorder();
    const tracer = getTraceRecorder();
    tracer.startRun('bench-run', 'bench-agent');
    results.push(bench('ExecutionTrace.recordDecision', 1000, () => tracer.recordDecision('bench-run', 'bench', 0)));
    tracer.completeRun('bench-run');
  });

  it('TELOSOrchestrator: plan (1000×)', () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 });
    runtime.registerProvider('openai', new MockLLMProvider('bench', { defaultResponse: 'Done.' }));
    const telos = new TELOSOrchestrator(runtime, { enableBudgetEnforcement: false });
    results.push(bench('TELOS.plan', 1000, () => telos.plan({ projectId: 'bench', agentId: 'agent', goal: 'Simple task' })));
  });

  it('TELOSOrchestrator: planAndExecute (50×)', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 });
    runtime.registerProvider('openai', new MockLLMProvider('bench', { defaultResponse: 'Completed.' }));
    const telos = new TELOSOrchestrator(runtime, { enableBudgetEnforcement: false });
    const start = performance.now();
    const count = 50;
    for (let i = 0; i < count; i++) {
      await telos.planAndExecute({ projectId: 'bench', agentId: 'agent', goal: `Task ${i}` });
    }
    const totalMs = performance.now() - start;
    results.push({ name: 'TELOS.planAndExecute', iterations: count, totalMs: Math.round(totalMs * 100) / 100, avgMs: Math.round((totalMs / count) * 100) / 100, opsPerSec: Math.round((count / totalMs) * 1000) });
  });

  it('ProviderPool: select with failover (5000×)', () => {
    resetProviderPool();
    const pool = new ProviderPool(0, 0);
    pool.registerProvider(new MockLLMProvider('p1', { defaultResponse: 'ok' }));
    pool.registerProvider(new MockLLMProvider('p2', { defaultResponse: 'ok' }));
    pool.configureEndpoints([
      { provider: 'p1', modelId: '*', priority: 0, weight: 1, isEnabled: true },
      { provider: 'p2', modelId: '*', priority: 1, weight: 1, isEnabled: true },
    ]);
    results.push(bench('ProviderPool.select', 5000, () => pool.select('eco')));
  });

  it('MCPServer: handleRequest (1000×)', async () => {
    const server = new MCPServer('bench', '1.0.0');
    server.registerTool({ name: 'test', description: 'test', inputSchema: { type: 'object', properties: {} } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      await server.handleRequest({ jsonrpc: '2.0', id: i, method: 'tools/list' });
    }
    const totalMs = performance.now() - start;
    results.push({ name: 'MCPServer.handleRequest', iterations: 1000, totalMs: Math.round(totalMs * 100) / 100, avgMs: Math.round((totalMs / 1000) * 1000) / 1000, opsPerSec: Math.round((1000 / totalMs) * 1000) });
  });

  it('HeuristicEvaluator: evaluate (10000×)', () => {
    const evaluator = new HeuristicEvaluator();
    const result = { runId: 'bench', summary: 'Test completion successfully.', steps: [{ stepNumber: 1, timestamp: '', type: 'response' as const, content: 'done', durationMs: 100 }], status: 'success' as const };
    results.push(bench('HeuristicEvaluator.evaluate', 10000, () => evaluator.evaluate(result)));
  });

  it('EvalSuite: run regression (1000 tests)', () => {
    const suite = new EvalSuite();
    for (let i = 0; i < 1000; i++) {
      suite.addTest({ id: `t${i}`, taskType: 'bench', input: `input${i}` });
    }
    const map = new Map<string, any>();
    for (let i = 0; i < 1000; i++) {
      map.set(`t${i}`, { runId: `t${i}`, summary: 'ok', steps: [], status: 'success' });
    }
    results.push(bench('EvalSuite.run(1000)', 10, () => { suite.run(map); }));
  });

  it('Memory: embedding similarity (50000×)', () => {
    const a = Array.from({ length: 64 }, () => Math.random() - 0.5);
    const b = Array.from({ length: 64 }, () => Math.random() - 0.5);
    results.push(bench('cosineSimilarity(64d)', 50000, () => cosineSimilarity(a, b)));
  });

  it('AgentRuntime: full execute with mock (100×)', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 1000 });
    runtime.registerProvider('openai', new MockLLMProvider('bench', { defaultResponse: 'Completed.' }));
    const ctx: AgentExecutionContext = { agentId: 'bench', projectId: 'bench', goal: 'Test task', contextData: {}, availableTools: [], maxSteps: 5, tokenBudget: 4000 };
    const start = performance.now();
    for (let i = 0; i < 100; i++) await runtime.execute(ctx);
    const totalMs = performance.now() - start;
    results.push({ name: 'AgentRuntime.execute', iterations: 100, totalMs: Math.round(totalMs * 100) / 100, avgMs: Math.round((totalMs / 100) * 100) / 100, opsPerSec: Math.round((100 / totalMs) * 1000) });
  });
});
