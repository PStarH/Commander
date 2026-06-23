/**
 * Global topology routing stores.
 *
 * Provides process-wide singletons for LearnedWeights, EpsilonStore, and
 * ExplorationEventLog so that the UltimateOrchestrator, TopologyRouter,
 * ReflexionTopologicalOptimizer, and the HTTP routing dashboard all observe
 * the same state.
 *
 * This mirrors the pattern used by getTraceRecorder(), getMetricsCollector(),
 * and other global runtime services. Reset helpers are exported for tests.
 */
import { LearnedWeights, type LearnedWeightsOptions } from './learnedWeights';
import { EpsilonStore } from './epsilonStore';
import { ExplorationEventLog } from './explorationEventLog';

let globalLearnedWeights: LearnedWeights | undefined;
let globalExplorationEventLog: ExplorationEventLog | undefined;
let globalExplorationEventLogConfig: { maxSize?: number; persistPath?: string } | undefined;

/**
 * Return the process-wide LearnedWeights instance, creating it on first call.
 */
export function getGlobalLearnedWeights(options?: LearnedWeightsOptions): LearnedWeights {
  if (!globalLearnedWeights) {
    globalLearnedWeights = new LearnedWeights(options);
  }
  return globalLearnedWeights;
}

/**
 * Return the process-wide ExplorationEventLog (and its embedded EpsilonStore),
 * creating it on first call.
 */
export function getGlobalExplorationEventLog(
  maxSize?: number,
  persistPath?: string,
): ExplorationEventLog {
  if (
    !globalExplorationEventLog ||
    globalExplorationEventLogConfig?.maxSize !== maxSize ||
    globalExplorationEventLogConfig?.persistPath !== persistPath
  ) {
    globalExplorationEventLog = new ExplorationEventLog(maxSize, undefined, persistPath);
    globalExplorationEventLogConfig = { maxSize, persistPath };
  }
  return globalExplorationEventLog;
}

/**
 * Return the process-wide EpsilonStore. This is the same instance embedded in
 * the global ExplorationEventLog, so PUTs from the dashboard and reads from
 * TopologyRouter see the same overrides.
 */
export function getGlobalEpsilonStore(): EpsilonStore {
  return getGlobalExplorationEventLog().getEpsilonStore();
}

/** Replace the global LearnedWeights instance (useful for tests). */
export function setGlobalLearnedWeights(weights: LearnedWeights): void {
  globalLearnedWeights = weights;
}

/** Replace the global ExplorationEventLog instance (useful for tests). */
export function setGlobalExplorationEventLog(log: ExplorationEventLog): void {
  globalExplorationEventLog = log;
}

/** Reset the global stores. Tests should call this in beforeEach. */
export function resetTopologyStores(): void {
  globalLearnedWeights = undefined;
  globalExplorationEventLog = undefined;
}
