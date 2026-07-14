import { describe, it, expect, vi } from 'vitest';
import { deliberate, deliberateWithLLM, classifyTaskNature } from '../../src/ultimate/deliberation';
import type { LLMProvider, LLMResponse } from '../../src/runtime/types';

describe('deliberate', () => {
  it('classifies coding tasks', () => {
    const plan = deliberate('Implement a function to sort an array');
    expect(plan.taskType).toBe('CODING');
    expect(plan.capabilitiesNeeded).toContain('code_understanding');
  });

  it('selects DISPATCH and STEP for complex coding tasks', () => {
    const plan = deliberate('Implement and deploy a microservice with tests', {
      availableTools: Array(10).fill('tool'),
    });
    expect(plan.taskType).toBe('CODING');
    expect(plan.recommendedTopology).toBe('DISPATCH');
    expect(plan.decompositionStrategy).toBe('STEP');
  });

  it('classifies research tasks and flags external info', () => {
    const plan = deliberate('Research the latest AI news from 2026');
    expect(plan.taskType).toBe('RESEARCH');
    expect(plan.requiresExternalInfo).toBe(true);
    expect(plan.taskNature).toBe('IO_BOUND');
  });

  it('classifies reasoning tasks', () => {
    const plan = deliberate('Explain why the sky is blue and evaluate the physics');
    expect(plan.taskType).toBe('REASONING');
  });

  it('selects CHAIN for moderate reasoning tasks', () => {
    const clause =
      'Explain and evaluate why and how neural networks generalize. ' +
      'Reason about the theoretical foundations and assess the empirical evidence. ';
    const goal = clause.repeat(3);
    expect(goal.length).toBeGreaterThan(400);
    expect(goal.length).toBeLessThan(1500);
    const plan = deliberate(goal);
    expect(plan.taskType).toBe('REASONING');
    expect(plan.recommendedTopology).toBe('CHAIN');
  });

  it('selects DEBATE for complex reasoning tasks', () => {
    const clause =
      'Explain why and reason about how and evaluate whether complex systems exhibit emergent behavior. ' +
      'Assess the arguments and determine the implications. ';
    const goal = clause.repeat(12);
    expect(goal.length).toBeGreaterThan(1500);
    expect(goal.length).toBeLessThan(3000);
    const plan = deliberate(goal);
    expect(plan.taskType).toBe('REASONING');
    expect(plan.recommendedTopology).toBe('DEBATE');
  });

  it('classifies creative tasks', () => {
    const plan = deliberate('Write a short story about a robot');
    expect(plan.taskType).toBe('CREATIVE');
  });

  it('selects ENSEMBLE for complex creative tasks', () => {
    const clause =
      'Write a creative story that imagines a future world. Design characters, craft an original plot, ' +
      'and produce an engaging narrative with vivid descriptions. ';
    const goal = clause.repeat(11);
    expect(goal.length).toBeGreaterThan(1500);
    expect(goal.length).toBeLessThan(3000);
    const plan = deliberate(goal);
    expect(plan.taskType).toBe('CREATIVE');
    expect(plan.recommendedTopology).toBe('ENSEMBLE');
  });

  it('classifies analysis tasks', () => {
    const plan = deliberate('Review and audit this codebase for bugs');
    expect(plan.taskType).toBe('ANALYSIS');
  });

  it('selects ASPECT decomposition and DISPATCH topology for moderate analysis', () => {
    const plan = deliberate(
      (
        'Review and audit this large codebase for bugs, performance issues, and security vulnerabilities. ' +
        'Analyze the architecture, identify code smells, and evaluate test coverage. '
      ).repeat(8),
    );
    expect(plan.taskType).toBe('ANALYSIS');
    expect(plan.recommendedTopology).toBe('DISPATCH');
    expect(plan.decompositionStrategy).toBe('ASPECT');
  });

  it('defaults to FACTUAL when no keywords match', () => {
    const plan = deliberate('xyzabc');
    expect(plan.taskType).toBe('FACTUAL');
  });

  it('uses context to adjust confidence and effort', () => {
    const plan = deliberate('What is the capital of France?', {
      availableTools: ['web_search'],
      governanceProfile: { riskLevel: 'LOW' },
    });
    expect(plan.confidence).toBeGreaterThan(0.5);
    expect(plan.effortLevel).toBe('SIMPLE');
  });

  it('detects temporal queries', () => {
    const plan = deliberate('What is the weather today?');
    expect(plan.requiresExternalInfo).toBe(true);
    expect(plan.reasoning.some((r) => r.includes('Temporal'))).toBe(true);
  });

  it('flags suitable tasks for speculation', () => {
    const plan = deliberate(
      (
        'Research and compare multiple open source licenses across dimensions like licensing, compatibility, and community adoption. ' +
        'Investigate use cases, evaluate restrictions, and summarize recommendations. '
      ).repeat(6),
    );
    expect(plan.suitableForSpeculation).toBe(true);
  });

  it('flags deep research tasks as HYBRID and RECURSIVE', () => {
    const plan = deliberate('a'.repeat(3500));
    expect(plan.effortLevel).toBe('DEEP_RESEARCH');
    expect(plan.recommendedTopology).toBe('HYBRID');
    expect(plan.decompositionStrategy).toBe('RECURSIVE');
  });

  it('infers vision capability when goal mentions images', () => {
    const plan = deliberate('Analyze this UI image and describe the components');
    expect(plan.capabilitiesNeeded).toContain('vision');
  });

  it('infers math capability for calculation tasks', () => {
    const plan = deliberate('Calculate the orbital velocity of Mars');
    expect(plan.capabilitiesNeeded).toContain('math');
  });

  it('infers security capability for audit tasks', () => {
    const plan = deliberate('Audit the authentication flow for vulnerabilities');
    expect(plan.capabilitiesNeeded).toContain('security_analysis');
  });

  it('applies confidence penalty for critical risk', () => {
    const plan = deliberate('Some task', { governanceProfile: { riskLevel: 'CRITICAL' } });
    expect(plan.confidence).toBeLessThan(0.5);
  });
});

describe('classifyTaskNature', () => {
  it('marks factual tasks without external info as MIXED', () => {
    expect(classifyTaskNature('FACTUAL', false)).toBe('MIXED');
  });

  it('marks factual tasks with external info as IO_BOUND', () => {
    expect(classifyTaskNature('FACTUAL', true)).toBe('IO_BOUND');
  });

  it('marks coding tasks as COMPUTE_BOUND', () => {
    expect(classifyTaskNature('CODING', false)).toBe('COMPUTE_BOUND');
  });
});

describe('deliberateWithLLM', () => {
  it('falls back to keyword deliberation when no provider is given', async () => {
    const plan = await deliberateWithLLM('Implement a sort function');
    expect(plan.taskType).toBe('CODING');
  });

  it('uses LLM response when valid JSON is returned', async () => {
    const provider = {
      name: 'openai',
      defaultModel: 'gpt-4',
      call: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          taskType: 'RESEARCH',
          requiresExternalInfo: true,
          recommendedTopology: 'ORCHESTRATOR',
          decompositionStrategy: 'ASPECT',
          capabilitiesNeeded: ['web_search'],
          estimatedAgentCount: 5,
          estimatedSteps: 20,
          estimatedTokens: 100000,
          estimatedDurationMs: 30000,
          confidence: 0.9,
          suitableForSpeculation: true,
          taskNature: 'IO_BOUND',
          reasoning: ['LLM reasoned'],
        }),
      }),
    } as unknown as LLMProvider;

    const plan = await deliberateWithLLM('Research quantum computing', provider);
    expect(plan.taskType).toBe('RESEARCH');
    expect(plan.recommendedTopology).toBe('ORCHESTRATOR');
    expect(plan.reasoning[0]).toBe('=== LLM deliberation ===');
  });

  it('parses JSON wrapped in markdown fences', async () => {
    const provider = {
      name: 'openai',
      defaultModel: 'gpt-4',
      call: vi.fn().mockResolvedValue({
        content:
          '```json\n' +
          JSON.stringify({
            taskType: 'CODING',
            requiresExternalInfo: false,
            recommendedTopology: 'SINGLE',
            decompositionStrategy: 'NONE',
            capabilitiesNeeded: ['reasoning'],
            estimatedAgentCount: 1,
            estimatedSteps: 5,
            estimatedTokens: 10000,
            estimatedDurationMs: 11000,
            confidence: 0.6,
            suitableForSpeculation: false,
            taskNature: 'MIXED',
            reasoning: ['ok'],
          }) +
          '\n```',
      }),
    } as unknown as LLMProvider;

    const plan = await deliberateWithLLM('Fix a bug', provider);
    expect(plan.taskType).toBe('CODING');
  });

  it('reads reasoning_content for reasoning models', async () => {
    const provider = {
      name: 'mimo',
      defaultModel: 'mimo-reasoner',
      call: vi.fn().mockResolvedValue({
        content: '',
        reasoning_content: JSON.stringify({
          taskType: 'REASONING',
          requiresExternalInfo: false,
          recommendedTopology: 'DEBATE',
          decompositionStrategy: 'ASPECT',
          capabilitiesNeeded: ['reasoning'],
          estimatedAgentCount: 3,
          estimatedSteps: 10,
          estimatedTokens: 50000,
          estimatedDurationMs: 20000,
          confidence: 0.8,
          suitableForSpeculation: false,
          taskNature: 'COMPUTE_BOUND',
          reasoning: ['chain'],
        }),
      }),
    } as unknown as LLMProvider;

    const plan = await deliberateWithLLM('Solve a logic puzzle', provider);
    expect(plan.taskType).toBe('REASONING');
  });

  it('falls back to keyword plan when LLM returns invalid JSON', async () => {
    const provider = {
      name: 'openai',
      defaultModel: 'gpt-4',
      call: vi.fn().mockResolvedValue({ content: 'not json' }),
    } as unknown as LLMProvider;

    const plan = await deliberateWithLLM('Implement a function', provider);
    expect(plan.taskType).toBe('CODING');
  });

  it('falls back to keyword plan when LLM call throws', async () => {
    const provider = {
      name: 'openai',
      defaultModel: 'gpt-4',
      call: vi.fn().mockRejectedValue(new Error('llm error')),
    } as unknown as LLMProvider;

    const plan = await deliberateWithLLM('Implement a function', provider);
    expect(plan.taskType).toBe('CODING');
  });
});
