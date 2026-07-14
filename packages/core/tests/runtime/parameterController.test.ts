import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyTask,
  getSamplingParams,
  getAdaptiveParams,
  applyControllerParams,
  createParameterControllerPlugin,
  setEvalProfile,
  getEvalProfile,
  isEvalProfileActive,
  getParamDecisions,
  type SamplingParams,
  type TaskProfile,
} from '../../src/runtime/parameterController';
import type { LLMMessage, LLMRequest } from '../../src/runtime/types';

describe('Parameter Controller — Task Classification', () => {
  it('classifies code generation task', () => {
    const profile = classifyTask('implement a function to sort an array of integers');
    expect(profile.taskType).toBe('code_generation');
    expect(profile.confidence).toBeGreaterThan(0);
  });

  it('classifies creative task', () => {
    const profile = classifyTask('give me some creative project name ideas');
    expect(profile.taskType).toBe('creative');
    expect(profile.confidence).toBeGreaterThan(0);
  });

  it('classifies tool calling task', () => {
    const profile = classifyTask('search the web for latest AI news');
    expect(profile.taskType).toBe('tool_calling');
  });

  it('classifies reasoning task', () => {
    const profile = classifyTask('calculate the probability of rolling two sixes');
    expect(profile.taskType).toBe('reasoning');
  });

  it('classifies conversation task', () => {
    const profile = classifyTask('hello, can you explain what machine learning is?');
    expect(profile.taskType).toBe('conversation');
  });

  it('classifies planning task', () => {
    const profile = classifyTask('create a roadmap for this project with milestones');
    expect(profile.taskType).toBe('planning');
  });

  it('classifies code review task', () => {
    const profile = classifyTask('review this code for security vulnerabilities');
    expect(profile.taskType).toBe('code_review');
  });

  it('defaults to default for ambiguous input', () => {
    const profile = classifyTask('the weather is nice today');
    expect(profile.taskType).toBe('default');
    expect(profile.confidence).toBe(0.3);
  });

  it('respects tool result history context', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'run the test suite' },
      {
        role: 'assistant',
        content: 'running tests',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
      },
      { role: 'tool', content: 'tests passed', tool_call_id: '1' },
    ];
    const profile = classifyTask('now fix the failing test', history);
    expect(profile.taskType).toBe('code_generation');
  });

  it('matches patterns with higher weight than keywords', () => {
    const profile = classifyTask('write a function to parse json');
    expect(profile.taskType).toBe('code_generation');
    expect(profile.confidence).toBeGreaterThan(0.3);
  });
});

describe('Parameter Controller — Sampling Params', () => {
  it('code_generation uses low temperature', () => {
    const profile = classifyTask('write a function to parse JSON');
    const params = getSamplingParams(profile);
    expect(params.temperature).toBeLessThanOrEqual(0.3);
    expect(params.topP).toBe(0.95);
  });

  it('creative uses high temperature', () => {
    const profile = classifyTask('write a creative story');
    const params = getSamplingParams(profile);
    expect(params.temperature).toBeGreaterThanOrEqual(0.7);
  });

  it('tool_calling uses very low temperature', () => {
    const profile = classifyTask('search the web for results');
    const params = getSamplingParams(profile);
    expect(params.temperature).toBeLessThanOrEqual(0.1);
  });

  it('user override takes precedence', () => {
    const profile = classifyTask('write a function');
    const params = getSamplingParams(profile, { temperature: 0.8 });
    expect(params.temperature).toBe(0.8);
  });

  it('overrides all sampling fields', () => {
    const profile: TaskProfile = { taskType: 'creative', confidence: 1, reasoning: 'test' };
    const params = getSamplingParams(profile, {
      temperature: 0.1,
      topP: 0.5,
      frequencyPenalty: 0.4,
      presencePenalty: 0.6,
    });
    expect(params).toMatchObject({
      temperature: 0.1,
      topP: 0.5,
      frequencyPenalty: 0.4,
      presencePenalty: 0.6,
    });
  });

  it('low confidence constrains temperature', () => {
    const profile = { taskType: 'creative' as const, confidence: 0.2, reasoning: 'low conf' };
    const params = getSamplingParams(profile);
    expect(params.temperature).toBeLessThanOrEqual(0.5);
  });

  it('does not clamp temperature when confidence is high', () => {
    const profile = { taskType: 'creative' as const, confidence: 0.8, reasoning: 'high conf' };
    const params = getSamplingParams(profile);
    expect(params.temperature).toBe(0.8);
  });
});

describe('Parameter Controller — Adaptive Params', () => {
  beforeEach(() => {
    setEvalProfile(null);
  });

  it('first retry increases temperature slightly', () => {
    const params0 = getAdaptiveParams('write a function', [], 0);
    const params1 = getAdaptiveParams('write a function', [], 1);
    expect(params1.temperature).toBeGreaterThanOrEqual(params0.temperature);
  });

  it('third retry falls back to low temperature', () => {
    const params2 = getAdaptiveParams('write a function', [], 2);
    expect(params2.temperature).toBeLessThanOrEqual(0.2);
  });

  it('records decisions in the audit trail', () => {
    const before = getParamDecisions().length;
    getAdaptiveParams('write a function', [], 0);
    expect(getParamDecisions().length).toBe(before + 1);
    const decision = getParamDecisions()[getParamDecisions().length - 1];
    expect(decision.taskType).toBe('code_generation');
    expect(decision.evalProfileApplied).toBe(false);
  });

  it('applies active eval profile', () => {
    setEvalProfile({ temperature: 0.1, topP: 0.5, maxTokens: 1024 });
    expect(isEvalProfileActive()).toBe(true);
    expect(getEvalProfile()).toMatchObject({ temperature: 0.1, topP: 0.5, maxTokens: 1024 });

    const params = getAdaptiveParams('creative task', [], 0);
    expect(params.temperature).toBe(0.1);
    expect(params.topP).toBe(0.5);

    const decision = getParamDecisions()[getParamDecisions().length - 1];
    expect(decision.evalProfileApplied).toBe(true);
  });

  it('clears eval profile', () => {
    setEvalProfile({ temperature: 0.1, topP: 0.5, maxTokens: 1024 });
    setEvalProfile(null);
    expect(isEvalProfileActive()).toBe(false);
    expect(getEvalProfile()).toBeNull();
  });

  it('prunes the decision log when it exceeds max size', () => {
    setEvalProfile(null);
    // Make many decisions to trigger pruning
    for (let i = 0; i < 1100; i++) {
      getAdaptiveParams('test', [], 0);
    }
    expect(getParamDecisions().length).toBeLessThanOrEqual(1000);
  });
});

describe('Parameter Controller — applyControllerParams', () => {
  beforeEach(() => {
    setEvalProfile(null);
  });

  it('applies temperature to a base request', () => {
    const base: LLMRequest = { model: 'test', messages: [], maxTokens: 100 };
    const result = applyControllerParams(base, 'write a function', [], 0);
    expect(result.temperature).toBeDefined();
    expect(typeof result.temperature).toBe('number');
  });

  it('applies eval profile reasoning config', () => {
    setEvalProfile({
      temperature: 0.1,
      topP: 0.5,
      maxTokens: 1024,
      reasoningConfig: { mode: 'extended', budgetTokens: 500 },
    });
    const base: LLMRequest = { model: 'test', messages: [], maxTokens: 100 };
    const result = applyControllerParams(base, 'solve this', [], 0);
    expect(result.reasoningConfig).toEqual({ mode: 'extended', budgetTokens: 500 });
  });
});

describe('Parameter Controller — Plugin Integration', () => {
  beforeEach(() => {
    setEvalProfile(null);
  });

  it('creates plugin with correct name', () => {
    const plugin = createParameterControllerPlugin();
    expect(plugin.name).toBe('parameter-controller');
    expect(typeof plugin.beforeLLMCall).toBe('function');
  });

  it('plugin modifies temperature on code task', () => {
    const plugin = createParameterControllerPlugin();
    const result = plugin.beforeLLMCall!({
      request: {
        model: 'test',
        messages: [{ role: 'user', content: 'write a sorting function' }],
        maxTokens: 100,
      },
      agentId: 'test',
      runId: 'test',
    } as any);
    expect(typeof result).toBe('object');
    expect('temperature' in result).toBe(true);
    expect((result as any).temperature).toBeLessThanOrEqual(0.5);
  });

  it('plugin uses user overrides', () => {
    const plugin = createParameterControllerPlugin({
      code_generation: { temperature: 0.5 },
    });
    const result = plugin.beforeLLMCall!({
      request: {
        model: 'test',
        messages: [{ role: 'user', content: 'write a function' }],
        maxTokens: 100,
      },
      agentId: 'test',
      runId: 'test',
    } as any);
    expect(typeof (result as any).temperature).toBe('number');
  });

  it('plugin ignores unknown task type overrides', () => {
    const plugin = createParameterControllerPlugin({
      unknown_task: { temperature: 0.9 },
    } as any);
    const result = plugin.beforeLLMCall!({
      request: {
        model: 'test',
        messages: [{ role: 'user', content: 'write a function' }],
        maxTokens: 100,
      },
      agentId: 'test',
      runId: 'test',
    } as any);
    expect(typeof (result as any).temperature).toBe('number');
  });

  it('plugin handles non-string user content', () => {
    const plugin = createParameterControllerPlugin();
    const result = plugin.beforeLLMCall!({
      request: {
        model: 'test',
        messages: [{ role: 'user', content: { type: 'image' } as any }],
        maxTokens: 100,
      },
      agentId: 'test',
      runId: 'test',
    } as any);
    expect(typeof (result as any).temperature).toBe('number');
  });
});
