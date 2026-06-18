import type { SharedState, SharedStateUpdate } from './types';
/**
 * Create initial shared state with default values.
 */
export declare function createInitialSharedState(): SharedState;
/**
 * Merge a partial update into shared state using per-key reducers.
 * Accumulating fields (findings, errors, messages, artifacts, costAccumulator)
 * use their reducers to merge. Overwrite fields (currentStep) replace directly.
 */
export declare function mergeSharedState(current: SharedState, update: SharedStateUpdate): SharedState;
//# sourceMappingURL=stateManager.d.ts.map