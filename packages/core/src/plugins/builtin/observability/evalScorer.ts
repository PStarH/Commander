/**
 * Re-export of canonical `observability/evalScorer.ts` (was a verbatim duplicate).
 * Collapsed 2026-07-15 for PRINCIPLES §3 / DRY.
 */
export {
  EvalScorer,
  parseJudgeResponse,
  type EvalRubric,
  type EvalTarget,
  type EvalScore,
  type EvalScorerConfig,
  type JudgeProvider,
} from '../../../observability/evalScorer';
