import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyTask, getSamplingParams, getAdaptiveParams, createParameterControllerPlugin } from '../../src/runtime/parameterController';
import type { LLMMessage } from '../../src/runtime/types';

describe('Parameter Controller — Task Classification', () => {
  it('classifies code generation task', () => {
    const profile = classifyTask('implement a function to sort an array of integers');
    assert.strictEqual(profile.taskType, 'code_generation');
    assert.ok(profile.confidence > 0);
  });

  it('classifies creative task', () => {
    const profile = classifyTask('give me some creative project name ideas');
    assert.strictEqual(profile.taskType, 'creative');
    assert.ok(profile.confidence > 0);
  });

  it('classifies tool calling task', () => {
    const profile = classifyTask('search the web for latest AI news');
    assert.strictEqual(profile.taskType, 'tool_calling');
  });

  it('classifies reasoning task', () => {
    const profile = classifyTask('calculate the probability of rolling two sixes');
    assert.strictEqual(profile.taskType, 'reasoning');
  });

  it('classifies conversation task', () => {
    const profile = classifyTask('hello, can you explain what machine learning is?');
    assert.strictEqual(profile.taskType, 'conversation');
  });

  it('classifies planning task', () => {
    const profile = classifyTask('create a roadmap for this project with milestones');
    assert.strictEqual(profile.taskType, 'planning');
  });

  it('classifies code review task', () => {
    const profile = classifyTask('review this code for security vulnerabilities');
    assert.strictEqual(profile.taskType, 'code_review');
  });

  it('defaults to default for ambiguous input', () => {
    const profile = classifyTask('the weather is nice today');
    assert.strictEqual(profile.taskType, 'default');
  });

  it('respects tool result history context', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'run the test suite' },
      { role: 'assistant', content: 'running tests', tool_calls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', content: 'tests passed', tool_call_id: '1' },
    ];
    const profile = classifyTask('now fix the failing test', history);
    assert.strictEqual(profile.taskType, 'code_generation');
  });
});

describe('Parameter Controller — Sampling Params', () => {
  it('code_generation uses low temperature', () => {
    const profile = classifyTask('write a function to parse JSON');
    const params = getSamplingParams(profile);
    assert.ok(params.temperature <= 0.3, `code_generation temp should be <= 0.3, got ${params.temperature}`);
    assert.strictEqual(params.topP, 0.95);
  });

  it('creative uses high temperature', () => {
    const profile = classifyTask('write a creative story');
    const params = getSamplingParams(profile);
    assert.ok(params.temperature >= 0.7, `creative temp should be >= 0.7, got ${params.temperature}`);
  });

  it('tool_calling uses very low temperature', () => {
    const profile = classifyTask('search the web for results');
    const params = getSamplingParams(profile);
    assert.ok(params.temperature <= 0.1, `tool_calling temp should be <= 0.1, got ${params.temperature}`);
  });

  it('user override takes precedence', () => {
    const profile = classifyTask('write a function');
    const params = getSamplingParams(profile, { temperature: 0.8 });
    assert.strictEqual(params.temperature, 0.8);
  });

  it('low confidence constrains temperature', () => {
    const profile = { taskType: 'creative' as const, confidence: 0.2, reasoning: 'low conf' };
    const params = getSamplingParams(profile);
    assert.ok(params.temperature <= 0.5, `Low confidence should clamp temp, got ${params.temperature}`);
  });
});

describe('Parameter Controller — Multi-Turn Strategy', () => {
  it('first retry increases temperature slightly', () => {
    const params0 = getAdaptiveParams('write a function', [], 0);
    const params1 = getAdaptiveParams('write a function', [], 1);
    assert.ok(params1.temperature >= params0.temperature, `Retry should increase temp (${params0.temp} -> ${params1.temp})`);
  });

  it('third retry falls back to low temperature', () => {
    const params2 = getAdaptiveParams('write a function', [], 2);
    assert.ok(params2.temperature <= 0.2, `Third retry should have low temp, got ${params2.temperature}`);
  });
});

describe('Parameter Controller — Plugin Integration', () => {
  it('creates plugin with correct name', () => {
    const plugin = createParameterControllerPlugin();
    assert.strictEqual(plugin.name, 'parameter-controller');
    assert.ok(typeof plugin.beforeLLMCall === 'function');
  });

  it('plugin modifies temperature on code task', () => {
    const plugin = createParameterControllerPlugin();
    const result = plugin.beforeLLMCall!({
      request: { model: 'test', messages: [{ role: 'user', content: 'write a sorting function' }], maxTokens: 100 },
      agentId: 'test', runId: 'test',
    } as any);
    assert.ok(typeof result === 'object' && 'temperature' in result);
    const temp = (result as any).temperature;
    assert.ok(temp !== undefined, 'Plugin should set temperature');
    // Should be low for code
    if (typeof temp === 'number') {
      assert.ok(temp <= 0.5, `Code task temperature should be <= 0.5, got ${temp}`);
    }
  });

  it('plugin uses user overrides', () => {
    const plugin = createParameterControllerPlugin({
      code_generation: { temperature: 0.5 },
    });
    const result = plugin.beforeLLMCall!({
      request: { model: 'test', messages: [{ role: 'user', content: 'write a function' }], maxTokens: 100 },
      agentId: 'test', runId: 'test',
    } as any);
    const temp = (result as any).temperature;
    assert.ok(typeof temp === 'number');
  });
});
