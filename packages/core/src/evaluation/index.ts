// ─────────────────────────────────────────────────────────────────────────────
// Evaluation module index — re-exports all evaluation components
// ─────────────────────────────────────────────────────────────────────────────

export {
  LLMJudgeEngine,
  getGlobalLLMJudgeEngine,
  resetGlobalLLMJudgeEngine,
} from './llmJudgeEngine';
export type {
  JudgeDimension,
  DimensionScore,
  JudgeResult,
  JudgeTarget,
  JudgeProvider,
  LLMJudgeConfig,
} from './llmJudgeEngine';

export { DatasetVersionManager, getGlobalDatasetManager } from './datasetVersionManager';
export type {
  DatasetCase,
  DatasetVersion,
  VersionedDataset,
  CreateDatasetInput,
  AddCasesInput,
  ExportResult,
} from './datasetVersionManager';

export {
  ABExperimentComparator,
  getGlobalABComparator,
  wilcoxonSignedRankTest,
} from './abExperimentComparator';
export type {
  ExperimentConfig,
  ExperimentPairResult,
  StatisticalResult,
  ABExperimentResult,
} from './abExperimentComparator';
