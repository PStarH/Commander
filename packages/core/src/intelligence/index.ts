/**
 * Intelligence Layer — Agent internal capabilities.
 *
 * These are NOT CLI commands. They're internal systems that the agent uses
 * automatically to be smarter. Users see the results, not the mechanism.
 *
 * - Cost Predictor: estimates task cost before execution
 * - Failure Pattern Learner: learns from past mistakes
 * - Impact Analyzer: predicts change side effects
 * - Skill Extractor: extracts reusable patterns from successes
 */

export { CostPredictor, getCostPredictor } from './costPredictor';
export type { CostEstimate, CostHistory } from './costPredictor';

export { FailurePatternLearner, getFailurePatternLearner } from './failurePatterns';
export type { FailurePattern, FailureWarning } from './failurePatterns';

export { ImpactAnalyzer, getImpactAnalyzer } from './impactAnalyzer';
export type { ImpactAnalysis, DependencyNode } from './impactAnalyzer';

export { SkillExtractor, getSkillExtractor } from './skillExtractor';
export type { ExtractedSkill, ExtractionResult } from './skillExtractor';
