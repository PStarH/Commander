import type { Skill } from './types';
export interface QualityFactor {
    name: string;
    score: number;
    weight: number;
}
export interface QualityScoreResult {
    total: number;
    factors: QualityFactor[];
}
export interface RubricCriterion {
    name: string;
    description: string;
    score: number;
    weight: number;
}
export interface LLMRubricConfig {
    criteria: RubricCriterion[];
    /**
     * Callback that sends a rubric prompt to an LLM and returns criterion scores.
     * Signature: (prompt: string) => Promise<number[]>
     * The returned array must match the length and order of criteria.
     * If the LLM is unavailable or the call fails, return null to fall back
     * to the deterministic score alone.
     */
    evaluator: (prompt: string) => Promise<number[] | null>;
    /**
     * How much weight to give the LLM rubric vs the deterministic score.
     * 0.0 = deterministic only, 1.0 = LLM only.
     */
    llmWeight?: number;
}
/**
 * Build a prompt string for the LLM rubric evaluator.
 * Exported for testing.
 */
export declare function buildRubricPrompt(skill: Skill, criteria: RubricCriterion[]): string;
/**
 * Run the LLM rubric evaluator and return criterion scores.
 * Returns null if the evaluator fails or returns an invalid response.
 */
export declare function evaluateWithRubric(skill: Skill, config: LLMRubricConfig): Promise<QualityFactor[] | null>;
/**
 * Compute a deterministic quality score (0.0–1.0) for a skill based on
 * observable characteristics. No LLM dependency — purely structural metrics
 * that can be computed synchronously.
 *
 * Factors (weighted):
 *   - content_length (15%): longer content is more useful, up to a point
 *   - has_tools (15%): skills with tool bindings are more actionable
 *   - has_tags (10%): tagged skills are better discoverable
 *   - has_description (10%): a real description (not just skill name)
 *   - usage_frequency (15%): more used = more valuable
 *   - success_rate (15%): higher success rate = more reliable
 *   - content_structure (10%): has headings, lists, code blocks
 *   - has_examples (10%): contains code examples
 */
export declare function computeDeterministicScore(skill: Skill): QualityScoreResult;
/**
 * Compute a hybrid quality score combining deterministic factors and optional LLM rubric.
 * If no LLM config is provided, falls back to purely deterministic scoring.
 *
 * The deterministic score is always computed. When an LLM rubric is available,
 * the final score is a weighted blend: (1 - llmWeight) * deterministic + llmWeight * llmRubric.
 */
export declare function computeQualityScore(skill: Skill, llmConfig?: LLMRubricConfig): Promise<QualityScoreResult>;
//# sourceMappingURL=skillQualityScorer.d.ts.map