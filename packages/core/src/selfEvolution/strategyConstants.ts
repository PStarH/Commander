import type { MetaLearnerConfig } from '../runtime/types';

export const STRATEGY_NAMES = ['SEQUENTIAL', 'PARALLEL', 'HANDOFF', 'MAGENTIC', 'CONSENSUS'];

export const DEFAULT_META_LEARNER_CONFIG: MetaLearnerConfig = {
  analysisMode: 'light',
  enablePredictionLoop: true,
  enableRegressionGate: true,
  enableCrossModelMemory: true,
  regressionThreshold: 0.15,
};
