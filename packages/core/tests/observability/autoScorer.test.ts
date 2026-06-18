/**
 * Tests for the P-obs-3 AutoScorer.
 *
 * Coverage:
 *  - isInSample: deterministic for the same traceId; varies with salt
 *  - sampleRate clamping in configure()
 *  - scoreTrace is a no-op when disabled or out of sample
 *  - matchesFilters: tenantId, minTokens, errorsOnly, model, taskCategory
 *  - synchronous mode returns the result; async (default) returns undefined
 *  - drain() awaits in-flight scoring
 *  - getResults() returns newest-first; maxResults cap; clearResults()
 *  - summarizeTrace: extracts agentId, model, tenantId, hasErrors from the trace
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EvalScorer,
  type JudgeProvider,
  type LLMResponse,
} from '../../src/observability/evalScorer';
import { AutoScorer } from '../../src/observability/autoScorer';
import type { ExecutionTrace, TraceEvent } from '../../src/runtime/types';

function mockJudge(score: number, delayMs = 0): JudgeProvider {
  return {
    name: 'mock',
    async call(): Promise<LLMResponse> {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: JSON.stringify({ score, reasoning: 'ok' }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      };
    },
  };
}

function makeTrace(
  opts: {
    runId: string;
    agentId?: string;
    tenantId?: string;
    hasError?: boolean;
    tokens?: number;
    model?: string;
  } = { runId: 'r' },
): ExecutionTrace {
  const events: TraceEvent[] = [];
  if (opts.model) {
    events.push({
      type: 'llm_call',
      timestamp: new Date().toISOString(),
      durationMs: 0,
      spanId: 's1',
      traceId: 't1',
      agentId: opts.agentId ?? 'a',
      data: {
        modelInfo: { provider: 'mock', model: opts.model },
        tokenUsage: {
          promptTokens: opts.tokens ?? 100,
          completionTokens: 0,
          totalTokens: opts.tokens ?? 100,
        },
      },
    });
  } else {
    events.push({
      type: 'state_change',
      timestamp: new Date().toISOString(),
      durationMs: 0,
      spanId: 's1',
      traceId: 't1',
      agentId: opts.agentId ?? 'a',
      data: { input: { goal: 'g' } },
    });
  }
  if (opts.hasError) {
    events.push({
      type: 'error',
      timestamp: new Date().toISOString(),
      durationMs: 0,
      spanId: 's2',
      traceId: 't1',
      agentId: opts.agentId ?? 'a',
      data: { error: 'boom' },
    });
  }
  return {
    runId: opts.runId,
    traceId: `trace-${opts.runId}`,
    agentId: opts.agentId ?? 'a',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    events,
    summary: {
      totalEvents: events.length,
      totalDurationMs: 10,
      totalTokens: opts.tokens ?? 100,
      llmCalls: events.filter((e) => e.type === 'llm_call').length,
      toolExecutions: 0,
      errors: events.filter((e) => e.type === 'error').length,
      modelUsed: opts.model,
    },
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
  };
}

describe('AutoScorer — sampling', () => {
  it('isInSample is deterministic for a given traceId', () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      rubricId: 'default-quality',
      sampleRate: 0.5,
      salt: 's',
    });
    const a1 = auto.isInSample('trace-1');
    const a2 = auto.isInSample('trace-1');
    expect(a1).toBe(a2);
  });
  it('sampleRate 0 keeps nothing in; sampleRate 1 keeps everything', () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto0 = new AutoScorer(scorer, { enabled: true, sampleRate: 0, salt: 's' });
    const auto1 = new AutoScorer(scorer, { enabled: true, sampleRate: 1, salt: 's' });
    expect(auto0.isInSample('t1')).toBe(false);
    expect(auto1.isInSample('t1')).toBe(true);
  });
  it('isInSample is false when disabled', () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, { enabled: false, sampleRate: 1, salt: 's' });
    expect(auto.isInSample('t1')).toBe(false);
  });
  it('different salts produce different sample sets over 1000 traceIds', () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const a = new AutoScorer(scorer, { enabled: true, sampleRate: 0.5, salt: 'salt-a' });
    const b = new AutoScorer(scorer, { enabled: true, sampleRate: 0.5, salt: 'salt-b' });
    // 1000 traceIds is plenty to catch salt-collision; the in-sample
    // sets should differ by at least 5% of the sample (probability of
    // 0 collisions across 1000 hashes with two independent djb2 salts
    // is effectively 0).
    const ids = Array.from({ length: 1000 }, (_, i) => `trace-${i}`);
    const aIn = new Set(ids.filter((id) => a.isInSample(id)));
    const bIn = new Set(ids.filter((id) => b.isInSample(id)));
    let sameCount = 0;
    for (const id of ids) if (aIn.has(id) === bIn.has(id)) sameCount++;
    const diffRate = 1 - sameCount / ids.length;
    expect(diffRate).toBeGreaterThan(0.05);
  });
  it('configure() clamps sampleRate to [0, 1]', () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, { enabled: true, sampleRate: 0.5, salt: 's' });
    auto.configure({ sampleRate: 5 });
    expect(auto.getConfig().sampleRate).toBe(1);
    auto.configure({ sampleRate: -1 });
    expect(auto.getConfig().sampleRate).toBe(0);
    auto.configure({ sampleRate: Number.NaN });
    expect(auto.getConfig().sampleRate).toBe(0);
  });
});

describe('AutoScorer — filters', () => {
  let scorer: EvalScorer;
  let auto: AutoScorer;
  beforeEach(() => {
    scorer = new EvalScorer(mockJudge(0.5));
    auto = new AutoScorer(scorer, {
      enabled: true,
      rubricId: 'default-quality',
      sampleRate: 1, // always in sample so we can isolate the filter logic
      salt: 's',
      filters: { tenantId: ['t1'], errorsOnly: true, minTokens: 50, model: ['gpt-4o-mini'] },
    });
  });

  it('drops traces with the wrong tenantId', async () => {
    const t = makeTrace({
      runId: 'r1',
      tenantId: 'other',
      hasError: true,
      tokens: 100,
      model: 'gpt-4o-mini',
    });
    expect(await auto.scoreTrace(t)).toBeUndefined();
  });
  it('drops traces below minTokens', async () => {
    const t = makeTrace({
      runId: 'r1',
      tenantId: 't1',
      hasError: true,
      tokens: 10,
      model: 'gpt-4o-mini',
    });
    expect(await auto.scoreTrace(t)).toBeUndefined();
  });
  it('drops traces without errors when errorsOnly is set', async () => {
    const t = makeTrace({ runId: 'r1', tenantId: 't1', tokens: 100, model: 'gpt-4o-mini' });
    expect(await auto.scoreTrace(t)).toBeUndefined();
  });
  it('drops traces with the wrong model', async () => {
    const t = makeTrace({
      runId: 'r1',
      tenantId: 't1',
      hasError: true,
      tokens: 100,
      model: 'claude-haiku-4-5',
    });
    expect(await auto.scoreTrace(t)).toBeUndefined();
  });
  it('passes a trace matching all filters (synchronous mode returns the result)', async () => {
    auto.configure({ synchronous: true });
    const t = makeTrace({
      runId: 'r1',
      tenantId: 't1',
      hasError: true,
      tokens: 100,
      model: 'gpt-4o-mini',
    });
    const r = await auto.scoreTrace(t);
    expect(r).toBeTruthy();
    expect(r!.score).toBe(0.5);
    expect(r!.traceSummary.hasErrors).toBe(true);
    expect(r!.traceSummary.tenantId).toBe('t1');
  });
});

describe('AutoScorer — result storage + drain', () => {
  it('stores results; getResults() returns newest-first', async () => {
    const scorer = new EvalScorer(mockJudge(0.7));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      sampleRate: 1,
      salt: 's',
      synchronous: true,
      maxResults: 10,
    });
    await auto.scoreTrace(makeTrace({ runId: 'r1' }));
    await auto.scoreTrace(makeTrace({ runId: 'r2' }));
    await auto.scoreTrace(makeTrace({ runId: 'r3' }));
    const results = auto.getResults();
    expect(results).toHaveLength(3);
    expect(results[0]!.runId).toBe('r3'); // newest first
    expect(auto.size()).toBe(3);
  });
  it('clearResults() empties the buffer', async () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      sampleRate: 1,
      salt: 's',
      synchronous: true,
    });
    await auto.scoreTrace(makeTrace({ runId: 'r1' }));
    expect(auto.size()).toBe(1);
    auto.clearResults();
    expect(auto.size()).toBe(0);
  });
  it('maxResults evicts the oldest (FIFO)', async () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      sampleRate: 1,
      salt: 's',
      synchronous: true,
      maxResults: 2,
    });
    await auto.scoreTrace(makeTrace({ runId: 'a' }));
    await auto.scoreTrace(makeTrace({ runId: 'b' }));
    await auto.scoreTrace(makeTrace({ runId: 'c' }));
    expect(auto.size()).toBe(2);
    const ids = auto
      .getResults()
      .map((r) => r.runId)
      .sort();
    expect(ids).toEqual(['b', 'c']);
  });
  it('async mode returns undefined synchronously; drain() awaits inflight', async () => {
    const scorer = new EvalScorer(mockJudge(0.6, 5));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      sampleRate: 1,
      salt: 's' /* synchronous: false default */,
    });
    const p = auto.scoreTrace(makeTrace({ runId: 'r1' }));
    // Async: the immediate result is undefined; the result lands in storage after the judge call.
    // We need to be careful — scoreTrace returns the in-flight promise which *will* resolve to
    // undefined in async mode. Wait for it to settle and for storage to be populated.
    const immediate = await p;
    expect(immediate).toBeUndefined();
    await auto.drain();
    expect(auto.size()).toBe(1);
    expect(auto.getResults()[0]!.score).toBe(0.6);
  });
  it('scoreTrace is a no-op when disabled', async () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, {
      enabled: false,
      sampleRate: 1,
      salt: 's',
      synchronous: true,
    });
    expect(await auto.scoreTrace(makeTrace({ runId: 'r1' }))).toBeUndefined();
    expect(auto.size()).toBe(0);
  });
  it('scoreTrace is a no-op when trace is out of sample', async () => {
    const scorer = new EvalScorer(mockJudge(0.5));
    const auto = new AutoScorer(scorer, {
      enabled: true,
      sampleRate: 0,
      salt: 's',
      synchronous: true,
    });
    expect(await auto.scoreTrace(makeTrace({ runId: 'r1' }))).toBeUndefined();
    expect(auto.size()).toBe(0);
  });
});
