import { describe, it, expect, vi } from 'vitest';
import {
  QualityGateEngine,
  LLMJudgeEvaluator,
  EmbeddingEvaluator,
} from '../../src/ultimate/qualityGates';
import type { QualityGateConfig, TaskTreeNode } from '../../src/ultimate/types';
import type { LLMProvider, LLMRequest } from '../../src/runtime/types';

const defaultGates: QualityGateConfig[] = [
  {
    name: 'hallucination',
    type: 'HALLUCINATION_CHECK',
    enabled: true,
    threshold: 0.8,
    autoFix: false,
  },
  { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.8, autoFix: false },
  { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.5, autoFix: false },
  { name: 'accuracy', type: 'ACCURACY', enabled: true, threshold: 0.8, autoFix: false },
  { name: 'safety', type: 'SAFETY', enabled: true, threshold: 0.8, autoFix: false },
];

const makeTree = (overrides?: Partial<TaskTreeNode>): TaskTreeNode => ({
  id: 'root',
  goal: 'test',
  status: 'COMPLETED',
  result: 'subtask result one',
  subtasks: [],
  ...overrides,
});

describe('QualityGateEngine rule-based', () => {
  it('passes careful analytical language in accuracy gate', async () => {
    const engine = new QualityGateEngine();
    const synthesis =
      'The data might indicate a correlation, and the paper suggests that further study is needed.';
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const accuracy = results.find((r) => r.gate === 'accuracy');
    expect(accuracy?.passed).toBe(true);
    expect(accuracy?.score).toBeGreaterThanOrEqual(0.8);
  });

  it('flags hallucination signals', async () => {
    const engine = new QualityGateEngine();
    const synthesis =
      'This is allegedly caused by quantum fluctuations, as of my knowledge cutoff in 2023.';
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const hallucination = results.find((r) => r.gate === 'hallucination');
    expect(hallucination?.passed).toBe(false);
  });

  it('does not penalize single hedging words like however', async () => {
    const engine = new QualityGateEngine();
    const synthesis =
      'The first experiment succeeded. However, the second run showed a minor calibration drift.';
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const consistency = results.find((r) => r.gate === 'consistency');
    expect(consistency?.passed).toBe(true);
  });

  it('penalizes direct contradictions', async () => {
    const engine = new QualityGateEngine();
    const synthesis =
      'The system must always respond in under 10ms. The system sometimes responds in over 10ms.';
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const consistency = results.find((r) => r.gate === 'consistency');
    expect(consistency?.passed).toBe(false);
  });

  it('flags unsafe content', async () => {
    const engine = new QualityGateEngine();
    const synthesis = 'You can bypass the security restriction by editing the config.';
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const safety = results.find((r) => r.gate === 'safety');
    expect(safety?.passed).toBe(false);
  });

  it('returns high completeness for substantial synthesis', async () => {
    const engine = new QualityGateEngine();
    const synthesis = 'A'.repeat(600);
    const results = await engine.run(defaultGates, synthesis, { taskTree: makeTree() });
    const completeness = results.find((r) => r.gate === 'completeness');
    expect(completeness?.passed).toBe(true);
  });

  it('does not run disabled gates', async () => {
    const engine = new QualityGateEngine();
    const disabledGates = defaultGates.map((g) => ({ ...g, enabled: false }));
    const results = await engine.run(disabledGates, 'any text', { taskTree: makeTree() });
    expect(results).toHaveLength(0);
  });
});

describe('LLMJudgeEvaluator', () => {
  it('parses JSON score from provider response', async () => {
    const provider = {
      call: vi.fn().mockResolvedValue({
        content: '{"score": 0.3, "reason": "invented citation"}',
      }),
    } as unknown as LLMProvider;

    const evaluator = new LLMJudgeEvaluator(provider, 'gpt-4');
    const result = await evaluator.evaluate('HALLUCINATION_CHECK', 'Some text');
    expect(result.score).toBe(0.3);
    expect(result.reason).toBe('invented citation');
    const request = (provider.call as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequest;
    expect(request.model).toBe('gpt-4');
  });

  it('returns neutral score on provider error', async () => {
    const provider = {
      call: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as LLMProvider;

    const evaluator = new LLMJudgeEvaluator(provider, 'gpt-4');
    const result = await evaluator.evaluate('HALLUCINATION_CHECK', 'Some text');
    expect(result.score).toBe(0.5);
  });
});

describe('EmbeddingEvaluator', () => {
  it('computes cosine similarity against reference', async () => {
    const embed = vi.fn().mockImplementation((text: string) => {
      // Return deterministic simple embeddings: "hello world" vs "hello there"
      if (text.includes('hello world')) return Promise.resolve([1, 0, 0]);
      return Promise.resolve([0.9, 0.1, 0]);
    });

    const evaluator = new EmbeddingEvaluator(embed, 0.8);
    const result = await evaluator.evaluate('ACCURACY', 'hello world', {
      reference: 'hello there',
    });
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.reason).toMatch(/cosine similarity/);
  });

  it('returns neutral score when no reference is provided', async () => {
    const evaluator = new EmbeddingEvaluator(vi.fn(), 0.8);
    const result = await evaluator.evaluate('ACCURACY', 'hello');
    expect(result.score).toBe(0.5);
  });
});
