/**
 * evalPlugin — Built-in CommanderPlugin for LLM-as-Judge evaluation, dataset
 * versioning, and A/B experiment comparison.
 *
 * Registers as `builtin-eval` (category: 'analytics'). This is a development-
 * time toolset: LLM-as-Judge consumes extra tokens, datasets are only needed
 * when benchmarking, and A/B comparison is offline analysis. Production agents
 * don't need it, so the plugin defaults to disabled.
 *
 * On enable it exposes four tools:
 *   - eval_run          — judge a single target with the LLMJudgeEngine
 *   - eval_run_batch    — batch judge multiple targets
 *   - eval_dataset_*    — create/list/get/rollback/export/import dataset versions
 *   - eval_compare_ab   — run Wilcoxon signed-rank test on paired results
 *
 * No hooks are installed — evaluation is explicitly invoked, not automatic.
 * The JudgeProvider must be supplied by the caller (anti-self-eval bias).
 */
import type { CommanderPlugin } from '../../pluginManager';
import {
  LLMJudgeEngine,
  getGlobalLLMJudgeEngine,
  resetGlobalLLMJudgeEngine,
  DatasetVersionManager,
  getGlobalDatasetManager,
  ABExperimentComparator,
  getGlobalABComparator,
  wilcoxonSignedRankTest,
  type JudgeTarget,
  type JudgeProvider,
  type LLMJudgeConfig,
  type ExperimentConfig,
  type ExperimentPairResult,
} from './eval';
import { getGlobalLogger } from '../../logging';

// ============================================================================
// Shared store handles (module-level so API endpoints reach the same instance)
// ============================================================================

let sharedJudgeEngine: LLMJudgeEngine | null = null;
let sharedDatasetManager: DatasetVersionManager | null = null;
let sharedABComparator: ABExperimentComparator | null = null;

export function getSharedJudgeEngine(): LLMJudgeEngine | null {
  return sharedJudgeEngine;
}
export function getSharedDatasetManager(): DatasetVersionManager | null {
  return sharedDatasetManager;
}
export function getSharedABComparator(): ABExperimentComparator | null {
  return sharedABComparator;
}

// ============================================================================
// Eval Plugin factory
// ============================================================================

export function createEvalPlugin(): CommanderPlugin {
  let persistenceDir: string | undefined;

  return {
    name: 'builtin-eval',
    version: '0.1.0',
    description: 'LLM-as-Judge evaluation, dataset versioning, and A/B experiment comparison',
    category: 'analytics',
    configSchema: {
      type: 'object',
      properties: {
        persistenceDir: {
          type: 'string',
          description: 'Directory for dataset persistence (default: .commander_state/eval)',
          default: '.commander_state/eval',
        },
        judgeModel: {
          type: 'string',
          description: 'Default judge model name (provider must be injected by caller)',
          default: 'gpt-4o',
        },
        maxConcurrentJudges: {
          type: 'number',
          description: 'Maximum parallel judge calls (cost circuit breaker)',
          default: 3,
        },
        tokensPerMinute: {
          type: 'number',
          description: 'Token bucket refill rate for judge calls',
          default: 50000,
        },
        maxTokensPerEvaluation: {
          type: 'number',
          description: 'Hard token cap per single evaluation',
          default: 100000,
        },
      },
    },

    onLoad: async (ctx) => {
      const cfg = ctx.config;
      persistenceDir = (cfg.persistenceDir as string) || '.commander_state/eval';

      // Dataset manager is self-contained (no LLM, no MessageBus).
      sharedDatasetManager = new DatasetVersionManager({ persistenceDir });
      // AB comparator is pure statistics.
      sharedABComparator = new ABExperimentComparator();
      // Judge engine is created without a provider; caller must inject one via
      // getGlobalLLMJudgeEngine(provider, config) or by constructing directly.
      sharedJudgeEngine = getGlobalLLMJudgeEngine(undefined, {
        defaultJudgeModel: (cfg.judgeModel as string) || 'gpt-4o',
        maxConcurrentJudges: Number(cfg.maxConcurrentJudges) || 3,
        tokensPerMinute: Number(cfg.tokensPerMinute) || 50000,
        maxTokensPerEvaluation: Number(cfg.maxTokensPerEvaluation) || 100000,
      });

      getGlobalLogger().info(
        'EvalPlugin',
        `Evaluation engine loaded (judgeModel=${cfg.judgeModel}, persistenceDir=${persistenceDir})`,
      );
    },

    onUnload: async () => {
      sharedJudgeEngine = null;
      sharedDatasetManager = null;
      sharedABComparator = null;
      resetGlobalLLMJudgeEngine();
      getGlobalLogger().info('EvalPlugin', 'Evaluation engine unloaded');
    },

    tools: [
      {
        name: 'eval_run',
        description:
          'Run LLM-as-Judge evaluation on a single target. Returns multi-dimensional scores ' +
          '(correctness/completeness/safety/helpfulness/costEfficiency) with confidence and reasoning. ' +
          'A JudgeProvider must be registered first via the /api/eval/configure endpoint.',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'The input prompt given to the evaluated model' },
            output: { type: 'string', description: 'The output produced by the evaluated model' },
            expected: { type: 'string', description: 'Optional reference answer' },
            evaluatedModel: { type: 'string', description: 'Name of the evaluated model' },
          },
          required: ['input', 'output'],
        },
        execute: async (args) => {
          const engine = sharedJudgeEngine ?? getGlobalLLMJudgeEngine();
          if (!engine) {
            return JSON.stringify({ error: 'JudgeEngine not initialized' });
          }
          const target: JudgeTarget = {
            input: String(args.input ?? ''),
            output: String(args.output ?? ''),
            expected: args.expected ? String(args.expected) : undefined,
            evaluatedModel: args.evaluatedModel ? String(args.evaluatedModel) : undefined,
          };
          const result = await engine.judge(target);
          return JSON.stringify(result);
        },
      },
      {
        name: 'eval_dataset_list',
        description: 'List all versioned datasets managed by the DatasetVersionManager.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const dm = sharedDatasetManager ?? getGlobalDatasetManager();
          if (!dm) return JSON.stringify({ error: 'DatasetManager not initialized' });
          return JSON.stringify({ datasets: dm.list() });
        },
      },
      {
        name: 'eval_compare_ab',
        description:
          'Run a Wilcoxon signed-rank test on paired A/B experiment results. ' +
          'Returns statistical significance, effect size r, and a ship_A/ship_B/inconclusive recommendation.',
        inputSchema: {
          type: 'object',
          properties: {
            experimentId: { type: 'string', description: 'Experiment identifier' },
            config: {
              type: 'object',
              description: 'Experiment config (alpha, metric direction, etc.)',
            },
            pairs: {
              type: 'array',
              description: 'Array of paired A/B results',
            },
          },
          required: ['experimentId', 'config', 'pairs'],
        },
        execute: async (args) => {
          const comparator = sharedABComparator ?? getGlobalABComparator();
          if (!comparator) return JSON.stringify({ error: 'ABComparator not initialized' });
          const result = comparator.compare(
            args.config as ExperimentConfig,
            (args.pairs as ExperimentPairResult[]) ?? [],
          );
          return JSON.stringify({ experimentId: args.experimentId, result });
        },
      },
      {
        name: 'wilcoxon_test',
        description:
          'Pure-function Wilcoxon signed-rank test. Pass an array of paired deltas ' +
          '(A - B) and optional alpha (default 0.05). Returns { D, pValue, significant, r }.',
        inputSchema: {
          type: 'object',
          properties: {
            deltas: {
              type: 'array',
              items: { type: 'number' },
              description: 'Array of paired differences (A - B)',
            },
            alpha: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Significance level (default 0.05)',
            },
          },
          required: ['deltas'],
        },
        execute: async (args) => {
          const deltas = (args.deltas as number[]) ?? [];
          if (deltas.length === 0) {
            return JSON.stringify({ error: 'deltas must be a non-empty array' });
          }
          const alpha = typeof args.alpha === 'number' ? args.alpha : 0.05;
          const result = wilcoxonSignedRankTest(deltas, alpha);
          return JSON.stringify(result);
        },
      },
    ],
  };
}
