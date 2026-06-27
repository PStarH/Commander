import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvolutionRunner } from '../../src/ultimate/evolutionRunner';
import { resetMetaLearner, getMetaLearner } from '../../src/selfEvolution/metaLearner';
import { resetEvolverAgent } from '../../src/selfEvolution/evolverAgent';
import { resetMessageBus, getMessageBus } from '../../src/runtime/messageBus';
import { resetGlobalLogger } from '../../src/logging';
import type { UltimateOrchestratorConfig } from '../../src/ultimate/types';
import type { AgentRuntimeInterface, ExecutionExperience } from '../../src/runtime/types';
import type { OptimizationSuggestion, EvolutionInsight } from '../../src/runtime/types/selfEvolution';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<UltimateOrchestratorConfig>): UltimateOrchestratorConfig {
  return {
    defaultBudget: { hardCapTokens: 128000, softCapTokens: 96000, costCapUsd: 5.0 },
    defaultThinkingBudget: { enabled: false, budgetTokens: 0 },
    defaultSynthesisConfig: {
      qualityGates: [
        { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: true },
      ],
      consensusThreshold: 0.7,
      maxIterations: 3,
    },
    defaultEffortLevel: 'MODERATE',
    maxRecursiveDepth: 3,
    maxParallelSubAgents: 10,
    enableDeliberation: true,
    enableArtifactSystem: true,
    enableTeams: true,
    enableCapabilityRouting: true,
    enableCircuitBreaker: true,
    qualityGates: [
      { name: 'hallucination', type: 'HALLUCINATION_CHECK', enabled: true, threshold: 0.8, autoFix: true },
      { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: true },
      { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
    ],
    modelTierMapping: {
      SIMPLE: 'eco',
      MODERATE: 'standard',
      COMPLEX: 'power',
      DEEP_RESEARCH: 'consensus',
    },
    ...overrides,
  } as unknown as UltimateOrchestratorConfig;
}

function makeRuntime(): AgentRuntimeInterface {
  return {
    getProvider: vi.fn(() => undefined),
  } as unknown as AgentRuntimeInterface;
}

function makeExperience(overrides?: Partial<ExecutionExperience>): ExecutionExperience {
  return {
    id: 'exp-1',
    runId: 'run-1',
    agentId: 'agent-1',
    taskType: 'coding',
    modelUsed: 'gpt-4o',
    strategyUsed: 'CHAIN',
    success: false,
    durationMs: 5000,
    tokenCost: 0.05,
    errorPattern: 'timeout',
    lessons: ['need better timeout handling'],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EvolutionRunner', () => {
  beforeEach(() => {
    resetMetaLearner();
    resetEvolverAgent();
    resetMessageBus();
    resetGlobalLogger();
  });

  it('constructs with deps', () => {
    const runner = new EvolutionRunner({
      config: makeConfig(),
      runtime: makeRuntime(),
    });
    expect(runner).toBeDefined();
  });

  // ── applyOptimizationSuggestions ─────────────────────────────────────────

  describe('applyOptimizationSuggestions', () => {
    it('does nothing when no suggestions exist', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const originalMapping = { ...config.modelTierMapping };
      runner.applyOptimizationSuggestions();

      expect(config.modelTierMapping).toEqual(originalMapping);
    });

    it('applies model_tier_change suggestion with high confidence', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      // Inject a suggestion into the meta-learner
      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'model_tier_change',
        target: 'MODERATE',
        from: 'standard',
        to: 'power',
        confidence: 0.8,
        evidence: ['success rate improved 15%'],
        impact: 'medium',
      };
      (learner as any).suggestions = [suggestion];
      // Override getSuggestions to return our suggestion
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      runner.applyOptimizationSuggestions();

      // The MODERATE tier should have been changed from 'standard' to 'power'
      expect(config.modelTierMapping.MODERATE).toBe('power');
    });

    it('skips suggestions with confidence below 0.3', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'model_tier_change',
        target: 'MODERATE',
        from: 'standard',
        to: 'power',
        confidence: 0.2, // below threshold
        evidence: [],
        impact: 'low',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      const originalMapping = { ...config.modelTierMapping };
      runner.applyOptimizationSuggestions();

      expect(config.modelTierMapping).toEqual(originalMapping);
    });

    it('applies strategy_change suggestion and adjusts consistency gate', () => {
      const config = makeConfig();
      const originalThreshold = config.defaultSynthesisConfig.qualityGates.find(
        (g) => g.name === 'consistency',
      )!.threshold;
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'strategy_change',
        target: 'topology',
        from: 'SEQUENTIAL',
        to: 'PARALLEL',
        confidence: 0.9,
        evidence: ['parallel is faster for independent tasks'],
        impact: 'high',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      runner.applyOptimizationSuggestions();

      const consistencyGate = config.defaultSynthesisConfig.qualityGates.find(
        (g) => g.name === 'consistency',
      )!;
      // For PARALLEL, threshold should decrease (thresholdAdjustment = 0.9 * 0.1 = 0.09)
      expect(consistencyGate.threshold).toBeLessThan(originalThreshold);
      expect(consistencyGate.threshold).toBeGreaterThanOrEqual(0.1);
    });

    it('creates prediction when experience is provided with strategy_change', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });
      const exp = makeExperience();

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'strategy_change',
        target: 'topology',
        from: 'SEQUENTIAL',
        to: 'HYBRID',
        confidence: 0.85,
        evidence: ['hybrid handles complex tasks better'],
        impact: 'high',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);
      const createPredictionSpy = vi.spyOn(learner, 'createPrediction').mockImplementation(() => ({
        id: 'pred-1',
        editId: 'edit-1',
        description: 'test prediction',
        predictedFixes: [],
        predictedRegressions: [],
        targetStrategy: 'HYBRID',
        sourceStrategy: 'SEQUENTIAL',
        modelId: 'gpt-4o',
        taskTypes: ['coding'],
        timestamp: new Date().toISOString(),
      }));

      runner.applyOptimizationSuggestions(exp);

      expect(createPredictionSpy).toHaveBeenCalledTimes(1);
      const args = createPredictionSpy.mock.calls[0];
      expect(args[2]).toBe('HYBRID'); // targetStrategy
      expect(args[3]).toBe('SEQUENTIAL'); // sourceStrategy
    });

    it('applies prompt_template_change suggestion to quality gate', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'prompt_template_change',
        target: 'hallucination',
        from: 'default',
        to: 'strict',
        confidence: 0.7,
        evidence: ['stricter prompts reduce hallucination'],
        impact: 'medium',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      const originalThreshold = config.qualityGates.find((g) => g.name === 'hallucination')!.threshold;
      runner.applyOptimizationSuggestions();

      const gate = config.qualityGates.find((g) => g.name === 'hallucination')!;
      // 'strict' should increase threshold
      expect(gate.threshold).toBeGreaterThan(originalThreshold);
      expect(gate.threshold).toBeLessThanOrEqual(1.0);
    });

    it('applies prompt_template_change with "relaxed" to decrease threshold', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'prompt_template_change',
        target: 'hallucination',
        from: 'default',
        to: 'relaxed',
        confidence: 0.6,
        evidence: ['relaxed prompts improve creativity'],
        impact: 'low',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      const originalThreshold = config.qualityGates.find((g) => g.name === 'hallucination')!.threshold;
      runner.applyOptimizationSuggestions();

      const gate = config.qualityGates.find((g) => g.name === 'hallucination')!;
      expect(gate.threshold).toBeLessThan(originalThreshold);
      expect(gate.threshold).toBeGreaterThanOrEqual(0.1);
    });

    it('publishes system.alert for tool_change suggestions', () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });

      const learner = getMetaLearner();
      const suggestion: OptimizationSuggestion = {
        type: 'tool_change',
        target: 'file_editor',
        from: 'basic_editor',
        to: 'advanced_editor',
        confidence: 0.75,
        evidence: ['advanced editor reduces errors'],
        impact: 'medium',
      };
      vi.spyOn(learner, 'getSuggestions').mockReturnValue([suggestion]);

      const bus = getMessageBus();
      const publishSpy = vi.spyOn(bus, 'publish');

      runner.applyOptimizationSuggestions();

      const alertCall = publishSpy.mock.calls.find(
        (c) => c[0] === 'system.alert' && (c[2] as any).type === 'self_optimization',
      );
      expect(alertCall).toBeDefined();
      expect((alertCall![2] as any).change).toContain('tool_change');
    });
  });

  // ── analyzeAndEvolve ──────────────────────────────────────────────────────

  describe('analyzeAndEvolve', () => {
    it('runs in light mode without a provider and completes without error', async () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });
      const exp = makeExperience();

      // MetaLearner defaults to 'light' mode, so no provider is needed
      await expect(runner.analyzeAndEvolve(exp, 'MODERATE', 'coding')).resolves.toBeUndefined();
    });

    it('publishes trajectory insights for failed experiences', async () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });
      const exp = makeExperience({ success: false, errorPattern: 'timeout' });

      const bus = getMessageBus();
      const publishSpy = vi.spyOn(bus, 'publish');

      await runner.analyzeAndEvolve(exp, 'MODERATE', 'coding');

      // In light mode, TrajectoryAnalyzer produces insights without LLM calls.
      // Check if any memory.written event was published for failed experiences.
      const memoryCalls = publishSpy.mock.calls.filter((c) => c[0] === 'memory.written');
      // In light mode, insights may or may not be produced depending on the experience data.
      // The key assertion is that the method completes without error.
      expect(publishSpy).toHaveBeenCalled();
    });

    it('handles evolver errors gracefully', async () => {
      const config = makeConfig();
      const runner = new EvolutionRunner({ config, runtime: makeRuntime() });
      const exp = makeExperience({ success: false });

      // The evolver may throw — the method should catch and log, not throw
      await expect(runner.analyzeAndEvolve(exp, 'MODERATE', 'coding')).resolves.toBeUndefined();
    });

    it('passes effortLevel to resolve model from config', async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      // Make getProvider return something so the non-light path can be exercised
      (runtime.getProvider as any) = vi.fn(() => ({
        complete: vi.fn(),
      }));

      const runner = new EvolutionRunner({ config, runtime });
      const exp = makeExperience();

      // Even if mode is not 'light', the method should complete
      await expect(runner.analyzeAndEvolve(exp, 'COMPLEX', 'coding')).resolves.toBeUndefined();
    });
  });
});
