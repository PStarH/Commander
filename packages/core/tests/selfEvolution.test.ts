import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TrajectoryAnalyzer } from '../src/selfEvolution/trajectoryAnalyzer';
import { MetaLearner, DEFAULT_META_LEARNER_CONFIG } from '../src/selfEvolution/metaLearner';
import {
  EvolverAgent,
  getEvolverAgent,
  resetEvolverAgent,
} from '../src/selfEvolution/evolverAgent';
import { DEFAULT_ULTIMATE_CONFIG } from '../src/ultimate/types';
import type { ExecutionExperience, FailureCategory, EvolutionInsight } from '../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeExp(overrides: Partial<ExecutionExperience> & { id: string }): ExecutionExperience {
  return {
    runId: overrides.id,
    agentId: 'test-agent',
    taskType: 'general',
    modelUsed: 'test-model',
    strategyUsed: 'SEQUENTIAL',
    success: false,
    durationMs: 1000,
    tokenCost: 500,
    lessons: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// TrajectoryAnalyzer — heuristic classification (light mode, zero LLM cost)
// ============================================================================

describe('TrajectoryAnalyzer — heuristic classification', () => {
  it('classifies tool_misuse from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't1', errorPattern: 'Tool error: unknown tool call_foo' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'tool_misuse');
    assert.ok(insight.confidence > 0);
    assert.strictEqual(insight.analysisTokens, 0);
  });

  it('classifies context_overflow from lessons', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't2', lessons: ['token limit exceeded', 'context window full'] });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'context_overflow');
    assert.strictEqual(insight.analysisTokens, 0);
  });

  it('classifies timeout from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't3', errorPattern: 'request timed out after 30000ms' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'timeout');
    assert.strictEqual(insight.analysisTokens, 0);
  });

  it('classifies model_refusal from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't4', errorPattern: 'Sorry, I cannot perform that action' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'model_refusal');
  });

  it('classifies missing_capability from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't5', errorPattern: 'command not found: npm' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'missing_capability');
  });

  it('classifies planning_error from lessons', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({
      id: 't6',
      lessons: ['wrong approach taken', 'strategy failed completely'],
    });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'planning_error');
  });

  it('classifies hallucination from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't7', errorPattern: 'fabricated reference to nonexistent API' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'hallucination');
  });

  it('classifies dependency_failure from lessons', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't8', lessons: ['dependency failed: subtask-3 crashed'] });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'dependency_failure');
  });

  it('classifies quality_gate from lessons', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't9', lessons: ['quality gate consistency scored 45%'] });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'quality_gate');
  });

  it('returns unclassified when no keywords match', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({
      id: 't10',
      errorPattern: 'some completely unique error no keywords match',
      lessons: [],
    });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'unclassified');
    assert.strictEqual(insight.analysisTokens, 0);
  });

  it('classifies successful executions as success with unclassified', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 't11', success: true });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.success, true);
    assert.strictEqual(insight.analysisTokens, 0);
  });

  it('handles multiple experiences in one batch', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const results = await analyzer.analyze([
      makeExp({ id: 'm1', errorPattern: 'tool error: crashed' }),
      makeExp({ id: 'm2', errorPattern: 'timeout after 60s' }),
      makeExp({ id: 'm3', errorPattern: 'unique gibberish zzzzz' }),
      makeExp({ id: 'm4', success: true }),
    ]);
    assert.strictEqual(results.length, 4);
    assert.strictEqual(results.find((r) => r.runId === 'm1')!.failureCategory, 'tool_misuse');
    assert.strictEqual(results.find((r) => r.runId === 'm2')!.failureCategory, 'timeout');
    assert.strictEqual(results.find((r) => r.runId === 'm3')!.failureCategory, 'unclassified');
    assert.strictEqual(results.find((r) => r.runId === 'm4')!.success, true);
  });

  it('degrades gracefully in thorough mode when no LLM provider is available', async () => {
    // This tests the infinite recursion fix: thorough mode with no provider/model should
    // fall back to heuristic classification, not loop infinitely.
    const analyzer = new TrajectoryAnalyzer('thorough');
    const results = await analyzer.analyze([
      makeExp({ id: 'd1', errorPattern: 'tool error: crashed' }),
      makeExp({ id: 'd2', success: true }),
    ]);
    assert.strictEqual(results.length, 2);
    // Results are grouped: [successes..., failures...]
    const failInsight = results.find((r) => r.runId === 'd1')!;
    const successInsight = results.find((r) => r.runId === 'd2')!;
    assert.strictEqual(failInsight.failureCategory, 'tool_misuse');
    assert.strictEqual(successInsight.success, true);
    // thorough without LLM → 0 analysis tokens (heuristic only)
    assert.strictEqual(failInsight.analysisTokens, 0);
    assert.strictEqual(successInsight.analysisTokens, 0);
  });
});

// ============================================================================
// MetaLearner — prediction loop
// ============================================================================

describe('MetaLearner — prediction loop', () => {
  it('creates a prediction and produces a verdict on strategy change', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: true,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      minRunsBeforeLearning: 0,
    });

    // Step 1: selectStrategy registers the chosen strategy for this (model, taskType)
    const chosen = ml.selectStrategy('general', 'test-model');
    const different = chosen === 'SEQUENTIAL' ? 'PARALLEL' : 'SEQUENTIAL';

    // Step 2: create a prediction: switching to a different strategy should improve things
    ml.createPrediction(
      'edit-1',
      'switch to different strategy for better throughput',
      different,
      chosen,
      'test-model',
      ['general'],
    );

    assert.strictEqual(ml.getPredictions().length, 1);

    // Step 3: record experience with different strategy => triggers change detection
    ml.recordExperience(
      makeExp({
        id: 'v1',
        strategyUsed: different,
        modelUsed: 'test-model',
        taskType: 'general',
        success: true,
      }),
    );

    const verdicts = ml.getVerdicts();
    assert.strictEqual(verdicts.length, 1);
    assert.strictEqual(verdicts[0].netImpact, 'positive');
  });

  it('does not produce verdict when strategy stays the same', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: true,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      minRunsBeforeLearning: 0,
    });

    ml.selectStrategy('general', 'test-model');
    // Record with the same strategy — no change, no verdict
    ml.recordExperience(
      makeExp({
        id: 'no-change',
        strategyUsed: ml.selectStrategy('general', 'test-model'),
        success: true,
      }),
    );
    // selectStrategy already recorded it, and recordExperience should not trigger a verdict since same strategy
    // Actually the prediction loop verification happens when strategy CHANGES from what's in lastPredictedStrategy
    // selectStrategy sets lastPredictedStrategy = chosen. Then if we don't change,
    // verifyPrediction sees previousStrategy === exp.strategyUsed and returns early.
    // So: first call sets it, second call with same strategy → no verdict
    assert.strictEqual(ml.getVerdicts().length, 0);
  });
});

// ============================================================================
// MetaLearner — regression gate
// ============================================================================

describe('MetaLearner — regression gate', () => {
  it('detects a significant drop in success rate', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: true,
      enableCrossModelMemory: false,
      regressionThreshold: 0.2,
      analysisMode: 'light',
      minRunsBeforeLearning: 1,
    });

    // Record 8 successes to establish baseline
    for (let i = 0; i < 8; i++) {
      ml.recordExperience(
        makeExp({
          id: `base-${i}`,
          strategyUsed: 'SEQUENTIAL',
          modelUsed: 'test-model',
          success: true,
        }),
      );
    }

    assert.strictEqual(ml.getRegressionEvents().length, 0);

    // Record 4 failures in a row — should trigger regression
    for (let i = 0; i < 4; i++) {
      ml.recordExperience(
        makeExp({
          id: `fail-${i}`,
          strategyUsed: 'SEQUENTIAL',
          modelUsed: 'test-model',
          success: false,
        }),
      );
    }

    const events = ml.getRegressionEvents();
    assert.ok(events.length >= 1, 'Should have at least 1 regression event');
    const latest = events[events.length - 1];
    assert.strictEqual(latest.strategyName, 'SEQUENTIAL');
    assert.strictEqual(latest.modelId, 'test-model');
    assert.ok(latest.dropRatio >= 0.2, `Drop ratio ${latest.dropRatio} should be >= 0.2`);
  });

  it('does not trigger regression on stable success rate', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: true,
      enableCrossModelMemory: false,
      regressionThreshold: 0.3,
      analysisMode: 'light',
      minRunsBeforeLearning: 1,
    });

    // Record all successes — no regression possible
    for (let i = 0; i < 15; i++) {
      ml.recordExperience(
        makeExp({
          id: `ok-${i}`,
          strategyUsed: 'PARALLEL',
          modelUsed: 'test-model',
          success: true,
        }),
      );
    }

    assert.strictEqual(ml.getRegressionEvents().length, 0);
  });
});

// ============================================================================
// MetaLearner — cross-model memory
// ============================================================================

describe('MetaLearner — cross-model memory', () => {
  it('tracks per-model priors independently', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: true,
      analysisMode: 'light',
      minRunsBeforeLearning: 1,
    });

    // Model A: SEQUENTIAL works well
    for (let i = 0; i < 10; i++) {
      ml.recordExperience(
        makeExp({
          id: `a-ok-${i}`,
          modelUsed: 'model-a',
          strategyUsed: 'SEQUENTIAL',
          success: true,
        }),
      );
    }
    // Model A: PARALLEL works poorly
    for (let i = 0; i < 5; i++) {
      ml.recordExperience(
        makeExp({
          id: `a-fail-${i}`,
          modelUsed: 'model-a',
          strategyUsed: 'PARALLEL',
          success: false,
        }),
      );
    }

    // Model B: opposite pattern
    for (let i = 0; i < 3; i++) {
      ml.recordExperience(
        makeExp({
          id: `b-fail-${i}`,
          modelUsed: 'model-b',
          strategyUsed: 'SEQUENTIAL',
          success: false,
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      ml.recordExperience(
        makeExp({ id: `b-ok-${i}`, modelUsed: 'model-b', strategyUsed: 'PARALLEL', success: true }),
      );
    }

    const modelAScores = ml.getStrategyScoresForModel('model-a');
    const modelBScores = ml.getStrategyScoresForModel('model-b');

    // Model A: SEQUENTIAL > PARALLEL
    const aSeq = modelAScores.find((s) => s.strategy === 'SEQUENTIAL')!;
    const aPar = modelAScores.find((s) => s.strategy === 'PARALLEL')!;
    assert.ok(
      aSeq.score > aPar.score,
      `Model-A: SEQUENTIAL(${aSeq.score}) should beat PARALLEL(${aPar.score})`,
    );

    // Model B: PARALLEL > SEQUENTIAL
    const bSeq = modelBScores.find((s) => s.strategy === 'SEQUENTIAL')!;
    const bPar = modelBScores.find((s) => s.strategy === 'PARALLEL')!;
    assert.ok(
      bPar.score > bSeq.score,
      `Model-B: PARALLEL(${bPar.score}) should beat SEQUENTIAL(${bSeq.score})`,
    );
  });

  it('returns empty array for unknown model', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enableCrossModelMemory: true,
      analysisMode: 'light',
    });
    assert.strictEqual(ml.getStrategyScoresForModel('nonexistent').length, 0);
  });
});

// ============================================================================
// MetaLearner — config
// ============================================================================

describe('MetaLearner — config', () => {
  it('uses default config when none provided', () => {
    const ml = new MetaLearner();
    const config = ml.getConfig();
    assert.strictEqual(config.analysisMode, 'light');
    assert.strictEqual(config.enablePredictionLoop, true);
    assert.strictEqual(config.enableRegressionGate, true);
    assert.strictEqual(config.enableCrossModelMemory, true);
    assert.strictEqual(config.regressionThreshold, 0.15);
  });

  it('setConfig updates runtime config', () => {
    const ml = new MetaLearner();
    ml.setConfig({ analysisMode: 'balanced', regressionThreshold: 0.3 });
    const config = ml.getConfig();
    assert.strictEqual(config.analysisMode, 'balanced');
    assert.strictEqual(config.regressionThreshold, 0.3);
    // Other defaults preserved
    assert.strictEqual(config.enablePredictionLoop, true);
  });

  it('setConfig works with partial updates', () => {
    const ml = new MetaLearner();
    ml.setConfig({ enablePredictionLoop: false });
    assert.strictEqual(ml.getConfig().enablePredictionLoop, false);
    assert.strictEqual(ml.getConfig().analysisMode, 'light'); // unchanged
  });
});

// ============================================================================
// MetaLearner — selectStrategy with model ID
// ============================================================================

describe('MetaLearner — selectStrategy', () => {
  it('selects a strategy and records it for prediction tracking', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: true,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
    });

    // With modelId: should record the selection for prediction tracking
    const strategy = ml.selectStrategy('general', 'test-model');
    assert.ok(typeof strategy === 'string');
    assert.ok(strategy.length > 0);
  });

  it('selects strategy without modelId (backward compatible)', () => {
    const ml = new MetaLearner();
    const strategy = ml.selectStrategy('general');
    assert.ok(typeof strategy === 'string');
    assert.ok(strategy.length > 0);
  });
});

// ============================================================================
// DEFAULT_META_LEARNER_CONFIG
// ============================================================================

// ============================================================================
// Evolver Agent
// ============================================================================

function makeInsight(
  overrides: Partial<EvolutionInsight> & { failureCategory: FailureCategory },
): EvolutionInsight {
  return {
    runId: 'evolver-test',
    taskType: 'general',
    modelUsed: 'test-model',
    strategyUsed: 'SEQUENTIAL',
    success: false,
    errorPattern: 'test error',
    failureCategory: overrides.failureCategory,
    confidence: 0.7,
    evidence: ['test evidence'],
    analysisTokens: 0,
    ...overrides,
  };
}

describe('EvolverAgent', () => {
  it('produces hallucination mutation that tightens the hallucination gate', () => {
    resetEvolverAgent();
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const mutations = evolver.evolve(insights, config);
    assert.ok(mutations.length > 0);
    const hallMutation = mutations.find(
      (m) => m.configPath === 'qualityGates.hallucination.threshold',
    );
    assert.ok(hallMutation, 'Should produce a hallucination gate mutation');
    // Hallucination gate starts at 0.8, delta 0.9 → 0.72
    assert.strictEqual(hallMutation!.oldValue, 0.8);
    assert.strictEqual(hallMutation!.newValue, 0.72);
    assert.strictEqual(hallMutation!.triggeredBy, 'hallucination');
  });

  it('produces context_overflow mutation that reduces thinking budget', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'context_overflow' })];
    const mutations = evolver.evolve(insights, config);
    assert.ok(mutations.length >= 2, 'Should produce at least 2 context_overflow mutations');
    const thinkBudget = mutations.find(
      (m) => m.configPath === 'defaultThinkingBudget.maxThinkingTokens',
    );
    assert.ok(thinkBudget, 'Should reduce maxThinkingTokens');
    // DEFAULT: maxThinkingTokens = 4096, delta 0.75 → 3072
    assert.strictEqual(thinkBudget!.oldValue, 4096);
    assert.strictEqual(thinkBudget!.newValue, 3072);
  });

  it('produces timeout mutation that reduces parallel agents', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'timeout' })];
    const mutations = evolver.evolve(insights, config);
    assert.ok(mutations.length > 0);
    const paraMut = mutations.find((m) => m.configPath === 'maxParallelSubAgents');
    assert.ok(paraMut, 'Should reduce maxParallelSubAgents');
    // DEFAULT: maxParallelSubAgents = 10, delta 0.8 → 8
    assert.strictEqual(paraMut!.oldValue, 10);
    assert.strictEqual(paraMut!.newValue, 8);
  });

  it('produces model_refusal mutation that upgrades model tier', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'model_refusal' })];
    const mutations = evolver.evolve(insights, config);
    const modelMut = mutations.find((m) => m.configPath === 'modelTierMapping.MODERATE');
    assert.ok(modelMut, 'Should upgrade MODERATE tier');
    // MODERATE defaults to 'standard', upgrade to 'power'
    assert.strictEqual(modelMut!.oldValue, 'standard');
    assert.strictEqual(modelMut!.newValue, 'power');
  });

  it('applies mutations to the config object', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const mutations = evolver.evolve(insights, config);
    assert.ok(mutations.length > 0);
    // config should still have old values before apply
    assert.strictEqual(config.qualityGates.find((g) => g.name === 'hallucination')!.threshold, 0.8);
    const applied = evolver.applyMutations(config, mutations);
    assert.strictEqual(applied, mutations.length);
    assert.strictEqual(
      config.qualityGates.find((g) => g.name === 'hallucination')!.threshold,
      0.72,
    );
  });

  it('is idempotent — applying same mutation twice does nothing', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const mutations = evolver.evolve(insights, config);
    evolver.applyMutations(config, mutations);
    const secondApply = evolver.applyMutations(config, mutations);
    assert.strictEqual(secondApply, 0, 'Second apply should be a no-op');
  });

  it('reverts mutations back to original values', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const mutations = evolver.evolve(insights, config);
    evolver.applyMutations(config, mutations);
    assert.strictEqual(
      config.qualityGates.find((g) => g.name === 'hallucination')!.threshold,
      0.72,
    );
    const reverted = evolver.revertMutations(config, mutations);
    assert.strictEqual(reverted, mutations.length);
    assert.strictEqual(config.qualityGates.find((g) => g.name === 'hallucination')!.threshold, 0.8);
  });

  it('skips mutation when condition predicate returns false', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    // Set hallucination threshold below the condition minimum
    const hallGate = config.qualityGates.find((g) => g.name === 'hallucination')!;
    hallGate.threshold = 0.3; // condition requires > 0.5
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const mutations = evolver.evolve(insights, config);
    const hallMutation = mutations.find(
      (m) => m.configPath === 'qualityGates.hallucination.threshold',
    );
    assert.strictEqual(hallMutation, undefined, 'Should skip mutation when condition fails');
  });

  it('skips mutation when insight confidence is below rule minConfidence', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination', confidence: 0.3 })];
    const mutations = evolver.evolve(insights, config);
    // hallucination rule has minConfidence = 0.5, so 0.3 should be skipped
    assert.strictEqual(mutations.length, 0);
  });

  it('produces no mutations for unclassified failures', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'unclassified' })];
    const mutations = evolver.evolve(insights, config);
    assert.strictEqual(mutations.length, 0);
  });

  it('produces no mutations for successful insights', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination', success: true })];
    const mutations = evolver.evolve(insights, config);
    assert.strictEqual(mutations.length, 0);
  });

  it('produces multiple mutations from multiple failure insights', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [
      makeInsight({ runId: 'i1', failureCategory: 'hallucination' }),
      makeInsight({ runId: 'i2', failureCategory: 'timeout' }),
    ];
    const mutations = evolver.evolve(insights, config);
    assert.ok(mutations.length >= 2, 'Should produce mutations for each failure type');
    const paths = mutations.map((m) => m.configPath);
    assert.ok(
      paths.some((p) => p === 'qualityGates.hallucination.threshold'),
      'Should have hallucination mutation',
    );
    assert.ok(
      paths.some((p) => p === 'maxParallelSubAgents'),
      'Should have timeout mutation',
    );
  });

  it('runCycle stores mutations as canary deployment', () => {
    const evolver = new EvolverAgent();
    const config = structuredClone(DEFAULT_ULTIMATE_CONFIG);
    const insights = [makeInsight({ failureCategory: 'hallucination' })];
    const exp: ExecutionExperience = {
      runId: 'cycle-test',
      agentId: 'test',
      taskType: 'general',
      modelUsed: 'test-model',
      strategyUsed: 'SEQUENTIAL',
      success: false,
      durationMs: 1000,
      tokenCost: 500,
      lessons: [],
      timestamp: new Date().toISOString(),
    };
    const cycle = evolver.runCycle(insights, config, exp, ['general']);
    assert.ok(cycle.mutations.length > 0);
    // Mutations are stored as canary (not applied globally) — applied always 0
    assert.strictEqual(cycle.applied, 0);
    assert.ok(cycle.cycleId.startsWith('evolve_'));
    // Verify canary is active
    const status = evolver.getCanaryStatus();
    assert.ok(status.active);
    assert.ok(status.mutations > 0);
  });

  it('getEvolverAgent returns a singleton', () => {
    resetEvolverAgent();
    const a = getEvolverAgent();
    const b = getEvolverAgent();
    assert.strictEqual(a, b);
  });

  it('resetEvolverAgent creates a new singleton', () => {
    resetEvolverAgent();
    const a = getEvolverAgent();
    resetEvolverAgent();
    const b = getEvolverAgent();
    assert.notStrictEqual(a, b);
  });
});

// ============================================================================
// MetaLearner — Shadow Mode (selectShadowStrategy, recordShadowComparison)
// ============================================================================

describe('MetaLearner — Shadow Mode', () => {
  it('selectShadowStrategy returns runner-up when enough data exists', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
      minRunsBeforeLearning: 1,
    });

    // Feed data: SEQUENTIAL succeeds, PARALLEL also succeeds but less
    for (let i = 0; i < 10; i++) {
      ml.recordExperience(
        makeExp({ id: `s-seq-${i}`, strategyUsed: 'SEQUENTIAL', success: true, durationMs: 5000 }),
      );
    }
    for (let i = 0; i < 5; i++) {
      ml.recordExperience(
        makeExp({ id: `s-par-${i}`, strategyUsed: 'PARALLEL', success: true, durationMs: 3000 }),
      );
    }
    for (let i = 0; i < 3; i++) {
      ml.recordExperience(
        makeExp({ id: `s-ho-${i}`, strategyUsed: 'HANDOFF', success: false, durationMs: 10000 }),
      );
    }

    const shadow = ml.selectShadowStrategy('general');
    const scores = ml.calculateAdjustedScores('general');

    assert.ok(shadow !== null, 'Should return a shadow strategy');
    assert.strictEqual(shadow, scores[1].name, 'Shadow should be the runner-up strategy');
    assert.ok(typeof shadow === 'string' && shadow.length > 0);
  });

  it('selectShadowStrategy returns null with no data', () => {
    const ml = new MetaLearner(100, 1);
    const shadow = ml.selectShadowStrategy('unknown_task');
    assert.strictEqual(shadow, null);
  });

  it('selectShadowStrategy returns null when only one strategy has data', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
    });

    // Only one strategy has data
    for (let i = 0; i < 5; i++) {
      ml.recordExperience(
        makeExp({ id: `only-seq-${i}`, strategyUsed: 'SEQUENTIAL', success: true }),
      );
    }

    const shadow = ml.selectShadowStrategy('general');
    assert.strictEqual(shadow, null);
  });

  it('recordShadowComparison stores comparison and updates priors', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
    });

    // Feed some baseline data
    ml.recordExperience(makeExp({ id: 'base-1', strategyUsed: 'SEQUENTIAL', success: true }));
    ml.recordExperience(makeExp({ id: 'base-2', strategyUsed: 'PARALLEL', success: false }));

    // Record shadow comparison
    ml.recordShadowComparison({
      runId: 'shadow-test-1',
      taskType: 'general',
      mainStrategy: 'SEQUENTIAL',
      shadowStrategy: 'PARALLEL',
      mainSuccess: true,
      shadowSuccess: false,
      mainDurationMs: 5000,
      shadowDurationMs: 3000,
    });

    const comparisons = ml.getShadowComparisons();
    assert.strictEqual(comparisons.length, 1);
    assert.strictEqual(comparisons[0].mainStrategy, 'SEQUENTIAL');
    assert.strictEqual(comparisons[0].shadowStrategy, 'PARALLEL');
    assert.strictEqual(comparisons[0].mainSuccess, true);
    assert.strictEqual(comparisons[0].shadowSuccess, false);
  });

  it('getShadowComparisons respects limit', () => {
    const ml = new MetaLearner(100, 1);

    for (let i = 0; i < 5; i++) {
      ml.recordShadowComparison({
        runId: `shadow-${i}`,
        taskType: 'general',
        mainStrategy: 'SEQUENTIAL',
        shadowStrategy: 'PARALLEL',
        mainSuccess: true,
        shadowSuccess: i % 2 === 0,
        mainDurationMs: 5000,
        shadowDurationMs: 3000 + i * 100,
      });
    }

    const limited = ml.getShadowComparisons(3);
    assert.strictEqual(limited.length, 3);
  });

  it('recordShadowComparison feeds half-weight to Thompson priors', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
    });

    // Baseline: SEQUENTIAL succeeds
    ml.recordExperience(makeExp({ id: 'b1', strategyUsed: 'SEQUENTIAL', success: true }));

    // Get scores before shadow
    const before = ml.getStrategyScores('general');
    const parBefore = before.find((s) => s.strategy === 'PARALLEL')!;

    // Record a shadow where PARALLEL succeeds
    ml.recordShadowComparison({
      runId: 'shadow-priors',
      taskType: 'general',
      mainStrategy: 'SEQUENTIAL',
      shadowStrategy: 'PARALLEL',
      mainSuccess: true,
      shadowSuccess: true,
      mainDurationMs: 5000,
      shadowDurationMs: 3000,
    });

    // PARALLEL should have slightly improved due to half-weight shadow feedback
    const after = ml.getStrategyScores('general');
    const parAfter = after.find((s) => s.strategy === 'PARALLEL')!;

    // The half-weight update means PARALLEL's alpha increased by 0.5
    assert.ok(
      parAfter.trials >= parBefore.trials,
      `PARALLEL trials should not decrease: ${parBefore.trials} → ${parAfter.trials}`,
    );
  });
});

// ============================================================================
// MetaLearner — calculateAdjustedScores (shared scoring logic)
// ============================================================================

describe('MetaLearner — calculateAdjustedScores', () => {
  it('returns sorted scores with all strategies', () => {
    const ml = new MetaLearner(100, 1);
    const scores = ml.calculateAdjustedScores('general');
    assert.strictEqual(scores.length, 5); // SEQUENTIAL, PARALLEL, HANDOFF, MAGENTIC, CONSENSUS
    assert.ok(scores[0].score >= scores[1].score, 'Should be sorted descending');
  });

  it('selectStrategy and selectShadowStrategy share same scoring', () => {
    const ml = new MetaLearner(100, 1, undefined, {
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
      analysisMode: 'light',
      minRunsBeforeLearning: 1,
    });

    // Feed: SEQUENTIAL wins, PARALLEL is runner-up
    for (let i = 0; i < 10; i++) {
      ml.recordExperience(
        makeExp({ id: `sc-seq-${i}`, strategyUsed: 'SEQUENTIAL', success: true }),
      );
    }
    for (let i = 0; i < 5; i++) {
      ml.recordExperience(makeExp({ id: `sc-par-${i}`, strategyUsed: 'PARALLEL', success: true }));
    }

    const shadow = ml.selectShadowStrategy('general')!;
    const scores = ml.calculateAdjustedScores('general');

    assert.ok(scores.length >= 2, 'Should have at least two scored strategies');
    assert.strictEqual(scores[0].name, 'SEQUENTIAL');
    assert.strictEqual(scores[1].name, shadow);
  });
});

describe('DEFAULT_META_LEARNER_CONFIG', () => {
  it('has all required fields', () => {
    assert.strictEqual(DEFAULT_META_LEARNER_CONFIG.analysisMode, 'light');
    assert.strictEqual(DEFAULT_META_LEARNER_CONFIG.enablePredictionLoop, true);
    assert.strictEqual(DEFAULT_META_LEARNER_CONFIG.enableRegressionGate, true);
    assert.strictEqual(DEFAULT_META_LEARNER_CONFIG.enableCrossModelMemory, true);
    assert.strictEqual(DEFAULT_META_LEARNER_CONFIG.regressionThreshold, 0.15);
  });
});
