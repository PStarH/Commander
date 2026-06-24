import type { Skill } from './types';

export interface QualityFactor {
  name: string;
  score: number; // 0.0–1.0
  weight: number; // contribution to total
}

export interface QualityScoreResult {
  total: number; // 0.0–1.0
  factors: QualityFactor[];
}

// ============================================================================
// Optional LLM rubric evaluation
// ============================================================================

export interface RubricCriterion {
  name: string;
  description: string;
  score: number; // 0.0–1.0 filled in by the evaluator
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

const DEFAULT_RUBRIC_CRITERIA: RubricCriterion[] = [
  {
    name: 'clarity',
    description: 'Are the instructions clear, well-structured, and unambiguous?',
    score: 0,
    weight: 0.25,
  },
  {
    name: 'actionability',
    description: 'Can an agent directly act on these instructions without additional context?',
    score: 0,
    weight: 0.25,
  },
  {
    name: 'correctness',
    description:
      'Does the approach described appear technically correct and follow best practices?',
    score: 0,
    weight: 0.25,
  },
  {
    name: 'completeness',
    description: 'Are all necessary steps, preconditions, and edge cases covered?',
    score: 0,
    weight: 0.25,
  },
];

/**
 * Build a prompt string for the LLM rubric evaluator.
 * Exported for testing.
 */
export function buildRubricPrompt(skill: Skill, criteria: RubricCriterion[]): string {
  return [
    'You are a skill quality evaluator. Rate the following skill on the given criteria.',
    'Return ONLY a JSON array of numbers between 0.0 and 1.0, one per criterion, in order.',
    'Example: [0.9, 0.7, 0.8, 0.6]',
    '',
    '--- Skill ---',
    `Name: ${skill.name}`,
    `Description: ${skill.description}`,
    `Category: ${skill.metadata.category}`,
    `Tags: ${skill.metadata.tags.join(', ')}`,
    `Tools: ${skill.tools.join(', ')}`,
    '',
    skill.content,
    '',
    '--- Criteria ---',
    ...criteria.map((c, i) => `${i + 1}. ${c.name}: ${c.description}`),
    '',
    'Return only the JSON array, nothing else.',
  ].join('\n');
}

/**
 * Run the LLM rubric evaluator and return criterion scores.
 * Returns null if the evaluator fails or returns an invalid response.
 */
export async function evaluateWithRubric(
  skill: Skill,
  config: LLMRubricConfig,
): Promise<QualityFactor[] | null> {
  const criteria = config.criteria;
  const prompt = buildRubricPrompt(skill, criteria);

  let rawScores: number[] | null;
  try {
    rawScores = await config.evaluator(prompt);
  } catch (err) {
    console.warn('[Catch]', err);
    return null;
  }

  if (!rawScores || rawScores.length !== criteria.length) return null;
  if (rawScores.some((s) => typeof s !== 'number' || s < 0 || s > 1)) return null;

  return criteria.map((c, i) => ({
    name: `llm_${c.name}`,
    score: rawScores![i],
    weight: c.weight,
  }));
}

// ============================================================================
// Deterministic factors
// ============================================================================

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
export function computeDeterministicScore(skill: Skill): QualityScoreResult {
  const factors: QualityFactor[] = [
    { name: 'content_length', score: scoreContentLength(skill.content), weight: 0.15 },
    { name: 'has_tools', score: skill.tools.length > 0 ? 1 : 0, weight: 0.15 },
    { name: 'has_tags', score: skill.metadata.tags.length > 0 ? 1 : 0, weight: 0.1 },
    {
      name: 'has_description',
      score: skill.description && skill.description !== skill.name ? 1 : 0,
      weight: 0.1,
    },
    { name: 'usage_frequency', score: scoreUsage(skill.metadata.usageCount), weight: 0.15 },
    { name: 'success_rate', score: skill.metadata.avgSuccessRate, weight: 0.15 },
    { name: 'content_structure', score: scoreContentStructure(skill.content), weight: 0.1 },
    { name: 'has_examples', score: skill.content.includes('```') ? 1 : 0, weight: 0.1 },
  ];

  const total = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
  return { total: clamp01(total), factors };
}

/**
 * Compute a hybrid quality score combining deterministic factors and optional LLM rubric.
 * If no LLM config is provided, falls back to purely deterministic scoring.
 *
 * The deterministic score is always computed. When an LLM rubric is available,
 * the final score is a weighted blend: (1 - llmWeight) * deterministic + llmWeight * llmRubric.
 */
export async function computeQualityScore(
  skill: Skill,
  llmConfig?: LLMRubricConfig,
): Promise<QualityScoreResult> {
  const deterministic = computeDeterministicScore(skill);

  if (!llmConfig) {
    return deterministic;
  }

  const llmFactors = await evaluateWithRubric(skill, llmConfig);
  if (!llmFactors) {
    // LLM unavailable — return deterministic only
    return deterministic;
  }

  const llmWeight = llmConfig.llmWeight ?? 0.4;
  const detWeight = 1 - llmWeight;

  const llmTotal = llmFactors.reduce((sum, f) => sum + f.score * f.weight, 0);

  const combinedTotal = clamp01(detWeight * deterministic.total + llmWeight * llmTotal);

  return {
    total: combinedTotal,
    factors: [
      ...deterministic.factors,
      ...llmFactors.map((f) => ({ ...f, weight: f.weight * llmWeight })),
    ],
  };
}

// ============================================================================
// Scoring helpers
// ============================================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function scoreContentLength(content: string): number {
  const lines = content.split('\n').length;
  if (lines >= 50) return 1.0;
  if (lines >= 20) return 0.7;
  if (lines >= 10) return 0.4;
  if (lines >= 3) return 0.2;
  return 0.0;
}

function scoreUsage(usageCount: number): number {
  if (usageCount >= 50) return 1.0;
  if (usageCount >= 20) return 0.8;
  if (usageCount >= 10) return 0.6;
  if (usageCount >= 5) return 0.4;
  if (usageCount >= 2) return 0.2;
  if (usageCount >= 1) return 0.1;
  return 0.0;
}

function scoreContentStructure(content: string): number {
  let score = 0;
  if (/^#+\s/m.test(content)) score += 0.3;
  if (/^\s*[-*]\s/m.test(content)) score += 0.2;
  if (/^\s*\d+\.\s/m.test(content)) score += 0.2;
  if (/\*\*.*\*\*/.test(content)) score += 0.15;
  if (/`[^`]+`/.test(content)) score += 0.15;
  return Math.min(1, score);
}
