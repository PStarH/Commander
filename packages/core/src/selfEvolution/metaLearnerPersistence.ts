import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { getGlobalLogger } from '../logging';
import { BetaDistribution } from './betaDistribution';
import type {
  ExecutionExperience,
  EvolutionPrediction,
  MetaLearnerConfig,
  PredictionVerdict,
  RegressionEvent,
  StrategyPerformance,
} from '../runtime/types';

export const PERSISTENCE_ENABLED = true;

export interface MetaLearnerState {
  experiences: ExecutionExperience[];
  reflections: string[];
  strategyPerformance: Map<string, StrategyPerformance>;
  thompsonPriors: Map<string, BetaDistribution[]>;
  predictions: EvolutionPrediction[];
  verdicts: PredictionVerdict[];
  regressionEvents: RegressionEvent[];
  successRateHistory: Map<string, number[]>;
  perModelPriors: Map<string, Map<string, BetaDistribution>>;
  config: MetaLearnerConfig;
}

/**
 * Persist MetaLearner state to disk asynchronously.
 *
 * Uses an atomic write pattern: write to a .tmp file, then rename.
 * All I/O is non-blocking via fs/promises — never blocks the event loop.
 */
export async function persist(
  state: MetaLearnerState,
  persistPath: string | null,
): Promise<void> {
  if (!persistPath) return;
  try {
    const dir = nodePath.dirname(persistPath);
    await fsp.mkdir(dir, { recursive: true });

    // Serialize Thompson priors (Beta distributions as alpha/beta pairs)
    const serializedPriors: Record<string, Array<{ alpha: number; beta: number }>> = {};
    for (const [taskType, distributions] of state.thompsonPriors) {
      serializedPriors[taskType] = distributions.map((d) => ({ alpha: d.alpha, beta: d.beta }));
    }

    // Serialize cross-model priors
    const serializedCrossModel: Record<
      string,
      Record<string, { alpha: number; beta: number }>
    > = {};
    for (const [modelId, modelMap] of state.perModelPriors) {
      serializedCrossModel[modelId] = {};
      for (const [strategy, dist] of modelMap) {
        serializedCrossModel[modelId][strategy] = { alpha: dist.alpha, beta: dist.beta };
      }
    }

    const data = {
      experiences: state.experiences,
      reflections: state.reflections.slice(-200),
      strategyPerformance: Array.from(state.strategyPerformance.entries()),
      thompsonPriors: serializedPriors,
      predictions: state.predictions,
      verdicts: state.verdicts,
      regressionEvents: state.regressionEvents,
      successRateHistory: Array.from(state.successRateHistory.entries()),
      crossModelPriors: serializedCrossModel,
      config: state.config,
    };

    const tmpPath = persistPath + '.tmp';
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmpPath, persistPath);
  } catch (e) {
    getGlobalLogger().warn('MetaLearner', 'Persistence failed (best-effort)', {
      error: (e as Error)?.message,
    });
  }
}

/**
 * Load MetaLearner state from disk asynchronously.
 *
 * Non-blocking via fs/promises. If the persist file does not exist yet
 * (ENOENT), the state is left unchanged — this is the normal first-run path.
 */
export async function load(
  state: MetaLearnerState,
  persistPath: string | null,
): Promise<void> {
  if (!persistPath) return;
  let raw: string;
  try {
    raw = await fsp.readFile(persistPath, 'utf-8');
  } catch (e) {
    // First run — no persist file yet; silently skip.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    getGlobalLogger().warn('MetaLearner', 'Load failed (best-effort)', {
      error: (e as Error)?.message,
    });
    return;
  }

  try {
    const data = JSON.parse(raw);

    if (Array.isArray(data.experiences)) state.experiences = data.experiences;
    if (Array.isArray(data.reflections)) state.reflections = data.reflections;

    if (Array.isArray(data.strategyPerformance)) {
      for (const [key, val] of data.strategyPerformance) {
        state.strategyPerformance.set(key, val);
      }
    }

    if (data.thompsonPriors && typeof data.thompsonPriors === 'object') {
      for (const [taskType, dists] of Object.entries(data.thompsonPriors)) {
        const priors = (dists as Array<{ alpha: number; beta: number }>).map(
          (d) => new BetaDistribution(d.alpha, d.beta),
        );
        state.thompsonPriors.set(taskType, priors);
      }
    }

    // Restore cross-model priors
    if (data.crossModelPriors && typeof data.crossModelPriors === 'object') {
      for (const [modelId, strategies] of Object.entries(data.crossModelPriors)) {
        const modelMap = new Map<string, BetaDistribution>();
        for (const [strategy, d] of Object.entries(
          strategies as Record<string, { alpha: number; beta: number }>,
        )) {
          modelMap.set(strategy, new BetaDistribution(d.alpha, d.beta));
        }
        state.perModelPriors.set(modelId, modelMap);
      }
    }

    if (Array.isArray(data.predictions)) state.predictions = data.predictions;
    if (Array.isArray(data.verdicts)) state.verdicts = data.verdicts;
    if (Array.isArray(data.regressionEvents)) state.regressionEvents = data.regressionEvents;
    if (Array.isArray(data.successRateHistory)) {
      for (const [key, vals] of data.successRateHistory) {
        state.successRateHistory.set(key, vals);
      }
    }
    if (data.config && typeof data.config === 'object') {
      state.config = { ...state.config, ...data.config };
    }
  } catch (e) {
    getGlobalLogger().warn('MetaLearner', 'Load failed (best-effort)', {
      error: (e as Error)?.message,
    });
  }
}
