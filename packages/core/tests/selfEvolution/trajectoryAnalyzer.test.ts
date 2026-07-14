import { describe, it, expect, vi } from 'vitest';
import { TrajectoryAnalyzer } from '../../src/selfEvolution/trajectoryAnalyzer';
import type { ExecutionExperience, LLMProvider, LLMResponse } from '../../src/runtime/types';

function makeExp(overrides: Partial<ExecutionExperience> = {}): ExecutionExperience {
  return {
    id: 'exp-1',
    runId: 'run-1',
    taskType: 'code',
    modelUsed: 'gpt-4',
    strategyUsed: 'direct',
    success: false,
    errorPattern: 'tool failed with timeout',
    lessons: [],
    toolsUsed: [],
    durationMs: 1000,
    tokenCost: 150,
    ...(overrides as Partial<ExecutionExperience>),
  } as ExecutionExperience;
}

function mockProvider(response: LLMResponse): LLMProvider {
  return {
    name: 'mock',
    call: vi.fn().mockResolvedValue(response),
  };
}

describe('TrajectoryAnalyzer', () => {
  it('light mode classifies failures heuristically', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'tool crashed with malformed call' }),
      makeExp({ success: true, errorPattern: '' }),
    ]);
    expect(insights).toHaveLength(2);
    const failure = insights.find((i) => !i.success)!;
    expect(failure.failureCategory).toBe('tool_misuse');
    expect(failure.confidence).toBeGreaterThan(0);
    expect(failure.analysisTokens).toBe(0);
  });

  it('classifies context_overflow failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'token limit exceeded in context window' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('context_overflow');
  });

  it('classifies timeout failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'request timed out after deadline' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('timeout');
  });

  it('classifies model_refusal failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'model refused to comply as an ai' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('model_refusal');
  });

  it('classifies missing_capability failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'command not found: missing requirement' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('missing_capability');
  });

  it('classifies planning_error failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'wrong approach caused backtrack' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('planning_error');
  });

  it('classifies hallucination failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'fabricated nonexistent entity' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('hallucination');
  });

  it('classifies dependency_failure failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'subtask failed, upstream dependency failed' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('dependency_failure');
  });

  it('classifies quality_gate failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'quality gate rejected output below threshold' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('quality_gate');
  });

  it('classifies rate_limit failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: '429 too many requests, rate limited' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('rate_limit');
  });

  it('classifies authentication failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'unauthorized 401 invalid token' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('authentication');
  });

  it('classifies resource_exhaustion failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'out of memory, heap limit exceeded' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('resource_exhaustion');
  });

  it('classifies data_validation failures', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'validation error: malformed schema violation' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('data_validation');
  });

  it('returns unclassified for unknown patterns', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'something weird happened' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('unclassified');
    expect(insights[0]!.confidence).toBe(0);
  });

  it('boosts confidence with multiple keyword matches', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([
      makeExp({
        errorPattern: 'tool failed',
        lessons: ['tool call malformed', 'unknown tool'],
      }),
    ]);
    expect(insights[0]!.failureCategory).toBe('tool_misuse');
    expect(insights[0]!.confidence).toBeGreaterThan(0.7);
  });

  it('balanced mode uses LLM fallback for unclassified failures', async () => {
    const provider = mockProvider({
      content: JSON.stringify({
        category: 'planning_error',
        confidence: 0.8,
        evidence: ['wrong approach'],
        suggestion: 'replan',
      }),
    });
    const analyzer = new TrajectoryAnalyzer('balanced', provider, 'mock-model');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'something weird happened' }),
    ]);
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(insights[0]!.failureCategory).toBe('planning_error');
    expect(insights[0]!.confidence).toBe(0.8);
  });

  it('balanced mode skips LLM when no provider configured', async () => {
    const analyzer = new TrajectoryAnalyzer('balanced');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'something weird happened' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('unclassified');
  });

  it('balanced mode uses heuristic when classification succeeds', async () => {
    const analyzer = new TrajectoryAnalyzer('balanced');
    const insights = await analyzer.analyze([makeExp({ errorPattern: 'timeout' })]);
    expect(insights[0]!.failureCategory).toBe('timeout');
  });

  it('thorough mode calls LLM for all failures', async () => {
    const provider = mockProvider({
      content: JSON.stringify({
        category: 'context_overflow',
        confidence: 0.9,
        evidence: ['too many tokens'],
      }),
    });
    const analyzer = new TrajectoryAnalyzer('thorough', provider, 'mock-model');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'timeout' }),
      makeExp({ errorPattern: 'tool failed' }),
    ]);
    expect(provider.call).toHaveBeenCalledTimes(2);
    expect(insights.every((i) => i.failureCategory === 'context_overflow')).toBe(true);
  });

  it('thorough mode falls back to unclassified when LLM fails', async () => {
    const provider = mockProvider({ content: 'not-valid-json' });
    const analyzer = new TrajectoryAnalyzer('thorough', provider, 'mock-model');
    const insights = await analyzer.analyze([makeExp({ errorPattern: 'tool failed' })]);
    expect(insights[0]!.failureCategory).toBe('unclassified');
    expect(insights[0]!.evidence).toContain('LLM analysis failed');
  });

  it('thorough mode degrades to heuristic without provider', async () => {
    const analyzer = new TrajectoryAnalyzer('thorough');
    const insights = await analyzer.analyze([makeExp({ errorPattern: 'tool failed' })]);
    expect(insights[0]!.failureCategory).toBe('tool_misuse');
  });

  it('success experiences have unclassified failure category', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([makeExp({ success: true, errorPattern: '' })]);
    expect(insights[0]!.success).toBe(true);
    expect(insights[0]!.failureCategory).toBe('unclassified');
    expect(insights[0]!.confidence).toBe(1);
  });

  it('returns empty array for no experiences', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const insights = await analyzer.analyze([]);
    expect(insights).toEqual([]);
  });

  it('handles LLM markdown code block wrapping', async () => {
    const provider = mockProvider({
      content: '```json\n{"category":"rate_limit","confidence":0.8,"evidence":["429"]}\n```',
    });
    const analyzer = new TrajectoryAnalyzer('balanced', provider, 'mock-model');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'something weird happened' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('rate_limit');
  });

  it('ignores invalid LLM category and falls back', async () => {
    const provider = mockProvider({
      content: JSON.stringify({
        category: 'not_a_real_category',
        confidence: 0.8,
        evidence: ['x'],
      }),
    });
    const analyzer = new TrajectoryAnalyzer('balanced', provider, 'mock-model');
    const insights = await analyzer.analyze([
      makeExp({ errorPattern: 'something weird happened' }),
    ]);
    expect(insights[0]!.failureCategory).toBe('unclassified');
  });
});
