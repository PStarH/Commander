/**
 * CourtEval — Adversarial Court Evaluation Framework
 *
 * Research basis: "Commander-BFT-C3" consensus report section 6 (Evaluation Layer).
 *
 * CourtEval implements an "adversarial court" with three roles:
 *   1. GRADER  — scores the answer on 5 dimensions (relevance, accuracy, depth, logic, clarity)
 *   2. CRITIC  — attacks the answer, identifies weaknesses and errors
 *   3. DEFENDER — defends the answer against the critic's attacks
 *
 * Cross-model-family requirement: the grader, critic, and defender MUST come from
 * different model families to reduce same-model bias (e.g., OpenAI models tend to
 * rate OpenAI outputs higher). This is enforced by the caller providing model family
 * tags for each role.
 *
 * The final verdict combines:
 *   - Grader's dimensional scores (weighted by grader reputation)
 *   - Critic's attack severity (reduces score if attacks are sustained)
 *   - Defender's defense success (recovers score if defenses are valid)
 *
 * Output: a CourtVerdict with adjusted scores and a final ruling.
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '../../../runtime/types';
import { reportSilentFailure } from '../../../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export type CourtRole = 'grader' | 'critic' | 'defender';

export interface CourtParticipant {
  role: CourtRole;
  modelFamily: string; // e.g., 'openai', 'anthropic', 'google', 'deepseek'
  provider: LLMProvider;
  model: string;
}

export interface GraderScores {
  relevance: number; // 0-1
  accuracy: number; // 0-1
  depth: number; // 0-1
  logic: number; // 0-1
  clarity: number; // 0-1
  overall: number; // weighted average
  reasoning: string;
}

export interface CriticAttack {
  dimension: keyof Omit<GraderScores, 'overall' | 'reasoning'>;
  severity: number; // 0-1, how severe the attack is
  description: string;
  evidence: string;
}

export interface DefenseResponse {
  attackIndex: number;
  successful: boolean; // did the defense counter the attack?
  reasoning: string;
  /** Score recovery amount (0-1, how much of the attack severity is mitigated) */
  recovery: number;
}

export interface CourtVerdict {
  /** Final adjusted overall score (0-1) after court proceedings */
  finalScore: number;
  /** Original grader scores before court proceedings */
  originalScores: GraderScores;
  /** Critic's attacks */
  attacks: CriticAttack[];
  /** Defender's responses to each attack */
  defenses: DefenseResponse[];
  /** Dimension scores after court adjustments */
  adjustedScores: GraderScores;
  /** Final ruling text */
  ruling: string;
  /** Whether the answer passes the quality threshold */
  passed: boolean;
  /** Participants and their model families */
  participants: Array<{ role: CourtRole; modelFamily: string }>;
  /** Whether cross-model-family requirement was met */
  crossFamilyVerified: boolean;
  /** Warnings (e.g., same-family participants) */
  warnings: string[];
}

export interface CourtEvalConfig {
  /** Quality threshold for pass/fail. Default 0.7 */
  passThreshold: number;
  /** Dimension weights for overall score computation */
  dimensionWeights: {
    relevance: number;
    accuracy: number;
    depth: number;
    logic: number;
    clarity: number;
  };
  /** Whether to enforce cross-model-family requirement. Default true */
  enforceCrossFamily: boolean;
  /** Maximum attacks the critic can raise. Default 5 */
  maxAttacks: number;
  /** Weight of critic attacks in final score adjustment. Default 0.3 */
  criticWeight: number;
  /** Weight of defender recovery in final score adjustment. Default 0.2 */
  defenderWeight: number;
}

export const DEFAULT_CONFIG: CourtEvalConfig = {
  passThreshold: 0.7,
  dimensionWeights: {
    relevance: 0.25,
    accuracy: 0.3,
    depth: 0.15,
    logic: 0.2,
    clarity: 0.1,
  },
  enforceCrossFamily: true,
  maxAttacks: 5,
  criticWeight: 0.3,
  defenderWeight: 0.2,
};

// ── Prompt Templates ─────────────────────────────────────────────────────────

const GRADER_PROMPT = `You are a GRADER in an adversarial court evaluation. Score the following answer on 5 dimensions.
Output ONLY a JSON object: {"relevance":0.0-1.0,"accuracy":0.0-1.0,"depth":0.0-1.0,"logic":0.0-1.0,"clarity":0.0-1.0,"reasoning":"brief explanation"}

Question/Prompt: {question}
Answer to grade: {answer}

Score each dimension 0.0-1.0 where 1.0 is excellent and 0.0 is completely wrong.
Be strict and fair. Output JSON only.`;

const CRITIC_PROMPT = `You are a CRITIC in an adversarial court evaluation. Your job is to ATTACK the answer and find its weaknesses.
Output ONLY a JSON array of attacks: [{"dimension":"relevance|accuracy|depth|logic|clarity","severity":0.0-1.0,"description":"what's wrong","evidence":"specific quote or reference"}]

Question/Prompt: {question}
Answer being criticized: {answer}
Grader's scores: {graderScores}

Find up to {maxAttacks} weaknesses. Be aggressive but fair — only raise attacks you can justify with evidence.
Output JSON array only.`;

const DEFENDER_PROMPT = `You are a DEFENDER in an adversarial court evaluation. Your job is to DEFEND the answer against the critic's attacks.
For each attack, output whether the defense succeeds and how much of the attack severity is mitigated.
Output ONLY a JSON array: [{"attackIndex":0,"successful":true/false,"reasoning":"why defense succeeds or fails","recovery":0.0-1.0}]

Question/Prompt: {question}
Answer being defended: {answer}
Critic's attacks: {attacks}

For each attack, assess whether the answer actually addresses the concern. recovery=1.0 means fully defended, 0.0 means no defense.
Output JSON array only.`;

// ── CourtEval Engine ─────────────────────────────────────────────────────────

export class CourtEvalEngine {
  private config: CourtEvalConfig;

  constructor(config?: Partial<CourtEvalConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the full CourtEval adversarial evaluation.
   *
   * @param question - The original question/prompt
   * @param answer - The answer being evaluated
   * @param participants - Grader, Critic, and Defender participants (with providers)
   * @returns Court verdict with adjusted scores
   */
  async evaluate(
    question: string,
    answer: string,
    participants: {
      grader: CourtParticipant;
      critic: CourtParticipant;
      defender: CourtParticipant;
    },
  ): Promise<CourtVerdict> {
    const warnings: string[] = [];

    // Verify cross-model-family requirement
    const families = new Set([
      participants.grader.modelFamily,
      participants.critic.modelFamily,
      participants.defender.modelFamily,
    ]);
    const crossFamilyVerified = families.size >= 3;
    if (this.config.enforceCrossFamily && !crossFamilyVerified) {
      warnings.push(
        `Cross-model-family requirement not met: only ${families.size} distinct families ` +
          `(grader=${participants.grader.modelFamily}, critic=${participants.critic.modelFamily}, defender=${participants.defender.modelFamily}). ` +
          `Same-family bias may affect evaluation.`,
      );
    }

    // Phase 1: Grader scores the answer
    const originalScores = await this.runGrader(question, answer, participants.grader);

    // Phase 2: Critic attacks the answer
    const attacks = await this.runCritic(question, answer, originalScores, participants.critic);

    // Phase 3: Defender responds to each attack
    const defenses = await this.runDefender(question, answer, attacks, participants.defender);

    // Phase 4: Compute adjusted scores
    const adjustedScores = this.adjustScores(originalScores, attacks, defenses);

    // Phase 5: Compute final verdict
    const passed = adjustedScores.overall >= this.config.passThreshold;
    const ruling = this.composeRuling(originalScores, adjustedScores, attacks, defenses, passed);

    return {
      finalScore: adjustedScores.overall,
      originalScores,
      attacks,
      defenses,
      adjustedScores,
      ruling,
      passed,
      participants: [
        { role: 'grader', modelFamily: participants.grader.modelFamily },
        { role: 'critic', modelFamily: participants.critic.modelFamily },
        { role: 'defender', modelFamily: participants.defender.modelFamily },
      ],
      crossFamilyVerified,
      warnings,
    };
  }

  /**
   * Run the grader to score the answer.
   */
  private async runGrader(
    question: string,
    answer: string,
    participant: CourtParticipant,
  ): Promise<GraderScores> {
    const prompt = GRADER_PROMPT.replace('{question}', question.slice(0, 2000)).replace(
      '{answer}',
      answer.slice(0, 4000),
    );

    try {
      const response = await this.callLLM(participant.provider, participant.model, prompt);
      const parsed = this.extractJSON(response) as Record<string, unknown>;
      const w = this.config.dimensionWeights;
      const scores: GraderScores = {
        relevance: this.clamp(typeof parsed.relevance === 'number' ? parsed.relevance : 0.5),
        accuracy: this.clamp(typeof parsed.accuracy === 'number' ? parsed.accuracy : 0.5),
        depth: this.clamp(typeof parsed.depth === 'number' ? parsed.depth : 0.5),
        logic: this.clamp(typeof parsed.logic === 'number' ? parsed.logic : 0.5),
        clarity: this.clamp(typeof parsed.clarity === 'number' ? parsed.clarity : 0.5),
        overall: 0,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      };
      scores.overall = this.computeWeighted(scores, w);
      return scores;
    } catch (err) {
      reportSilentFailure(err, 'courtEval:runGrader');
      // Fallback: neutral scores
      const w = this.config.dimensionWeights;
      const scores: GraderScores = {
        relevance: 0.5,
        accuracy: 0.5,
        depth: 0.5,
        logic: 0.5,
        clarity: 0.5,
        overall: 0.5,
        reasoning: 'Grader LLM call failed; using neutral fallback',
      };
      scores.overall = this.computeWeighted(scores, w);
      return scores;
    }
  }

  /**
   * Run the critic to attack the answer.
   */
  private async runCritic(
    question: string,
    answer: string,
    graderScores: GraderScores,
    participant: CourtParticipant,
  ): Promise<CriticAttack[]> {
    const prompt = CRITIC_PROMPT.replace('{question}', question.slice(0, 2000))
      .replace('{answer}', answer.slice(0, 4000))
      .replace('{graderScores}', JSON.stringify(graderScores))
      .replace('{maxAttacks}', String(this.config.maxAttacks));

    try {
      const response = await this.callLLM(participant.provider, participant.model, prompt);
      const parsed = this.extractJSONArray(response) as Array<Record<string, unknown>>;
      const validDims = ['relevance', 'accuracy', 'depth', 'logic', 'clarity'] as const;
      const attacks: CriticAttack[] = parsed.slice(0, this.config.maxAttacks).map((a) => ({
        dimension: validDims.includes(a.dimension as (typeof validDims)[number])
          ? (a.dimension as (typeof validDims)[number])
          : 'accuracy',
        severity: this.clamp(typeof a.severity === 'number' ? a.severity : 0.5),
        description: typeof a.description === 'string' ? a.description : '',
        evidence: typeof a.evidence === 'string' ? a.evidence : '',
      }));
      return attacks;
    } catch (err) {
      reportSilentFailure(err, 'courtEval:runCritic');
      return [];
    }
  }

  /**
   * Run the defender to respond to attacks.
   */
  private async runDefender(
    question: string,
    answer: string,
    attacks: CriticAttack[],
    participant: CourtParticipant,
  ): Promise<DefenseResponse[]> {
    if (attacks.length === 0) return [];

    const prompt = DEFENDER_PROMPT.replace('{question}', question.slice(0, 2000))
      .replace('{answer}', answer.slice(0, 4000))
      .replace('{attacks}', JSON.stringify(attacks));

    try {
      const response = await this.callLLM(participant.provider, participant.model, prompt);
      const parsed = this.extractJSONArray(response) as Array<Record<string, unknown>>;
      const defenses: DefenseResponse[] = parsed.map((d, i) => ({
        attackIndex: typeof d.attackIndex === 'number' ? d.attackIndex : i,
        successful: typeof d.successful === 'boolean' ? d.successful : false,
        reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
        recovery: this.clamp(typeof d.recovery === 'number' ? d.recovery : 0),
      }));
      return defenses;
    } catch (err) {
      reportSilentFailure(err, 'courtEval:runDefender');
      // Fallback: no defense for any attack
      return attacks.map((_, i) => ({
        attackIndex: i,
        successful: false,
        reasoning: 'Defender LLM call failed; no defense provided',
        recovery: 0,
      }));
    }
  }

  /**
   * Adjust scores based on critic attacks and defender responses.
   */
  private adjustScores(
    original: GraderScores,
    attacks: CriticAttack[],
    defenses: DefenseResponse[],
  ): GraderScores {
    const adjusted: GraderScores = {
      relevance: original.relevance,
      accuracy: original.accuracy,
      depth: original.depth,
      logic: original.logic,
      clarity: original.clarity,
      overall: 0,
      reasoning: original.reasoning,
    };

    // Apply each attack's net impact (severity - recovery)
    for (let i = 0; i < attacks.length; i++) {
      const attack = attacks[i];
      const defense = defenses.find((d) => d.attackIndex === i);
      const recovery = defense?.recovery ?? 0;
      const netImpact =
        attack.severity * this.config.criticWeight * (1 - recovery * this.config.defenderWeight);

      // Reduce the attacked dimension
      adjusted[attack.dimension] = Math.max(0, adjusted[attack.dimension] - netImpact);
    }

    // Recompute overall
    adjusted.overall = this.computeWeighted(adjusted, this.config.dimensionWeights);
    return adjusted;
  }

  /**
   * Compose a human-readable ruling.
   */
  private composeRuling(
    original: GraderScores,
    adjusted: GraderScores,
    attacks: CriticAttack[],
    defenses: DefenseResponse[],
    passed: boolean,
  ): string {
    const lines: string[] = [];
    lines.push(`Court Verdict: ${passed ? 'PASS' : 'FAIL'}`);
    lines.push(`Original overall score: ${(original.overall * 100).toFixed(1)}%`);
    lines.push(`Adjusted overall score: ${(adjusted.overall * 100).toFixed(1)}%`);
    lines.push(`Critic raised ${attacks.length} attack(s).`);
    const successfulDefenses = defenses.filter((d) => d.successful).length;
    lines.push(`Defender countered ${successfulDefenses}/${attacks.length} attack(s).`);

    if (attacks.length > 0) {
      lines.push('Key attacks:');
      for (const attack of attacks.slice(0, 3)) {
        lines.push(
          `  - [${attack.dimension}] severity=${(attack.severity * 100).toFixed(0)}%: ${attack.description}`,
        );
      }
    }

    return lines.join('\n');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async callLLM(provider: LLMProvider, model: string, prompt: string): Promise<string> {
    const request: LLMRequest = {
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      temperature: 0.3,
    };
    const response: LLMResponse = await provider.call(request);
    return response.content ?? '';
  }

  private computeWeighted(
    scores: Pick<GraderScores, 'relevance' | 'accuracy' | 'depth' | 'logic' | 'clarity'>,
    weights: CourtEvalConfig['dimensionWeights'],
  ): number {
    return (
      scores.relevance * weights.relevance +
      scores.accuracy * weights.accuracy +
      scores.depth * weights.depth +
      scores.logic * weights.logic +
      scores.clarity * weights.clarity
    );
  }

  private clamp(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  private extractJSON(text: string): Record<string, unknown> {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    return JSON.parse(match[0]);
  }

  private extractJSONArray(text: string): Array<Record<string, unknown>> {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found in response');
    return JSON.parse(match[0]);
  }

  getConfig(): CourtEvalConfig {
    return { ...this.config };
  }
}
