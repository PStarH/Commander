/**
 * Quality gate engine for synthesizer outputs.
 *
 * Replaces the regex-only heuristic gates with a layered evaluation system:
 *   1. Rule-based signals (safe, fast, no LLM cost) with false-positive-prone
 *      patterns removed.
 *   2. Optional LLM-as-judge for semantic hallucination / consistency / completeness.
 *   3. Optional embedding-based semantic similarity when LLM is unavailable.
 *
 * The engine is designed to distinguish "pretending to know" (hallucination)
 * from "careful analytical language" (e.g. "might indicate", "suggests that").
 */
import type { QualityGateConfig, TaskTreeNode } from './types';
import type { LLMProvider, LLMRequest, LLMResponse } from '../runtime/types';
import { cosineSimilarity } from '../runtime/embedding';

export type QualityGateType =
  | 'HALLUCINATION_CHECK'
  | 'CONSISTENCY'
  | 'COMPLETENESS'
  | 'ACCURACY'
  | 'SAFETY';

export interface QualityGateResult {
  gate: string;
  passed: boolean;
  score: number;
  reason?: string;
}

export interface QualityGateEvaluator {
  /** Which gate types this evaluator can score. */
  supports(type: QualityGateType): boolean;
  /** Return a score in [0, 1] and optional reason. */
  evaluate(
    type: QualityGateType,
    synthesis: string,
    context?: { taskTree?: TaskTreeNode; reference?: string },
  ): Promise<{ score: number; reason?: string }>;
}

export interface QualityGateEngineOptions {
  /** Optional LLM-based evaluator. If provided, it overrides rule-based scoring. */
  llmEvaluator?: QualityGateEvaluator;
  /** Optional embedding-based evaluator. Used as a fallback when no LLM evaluator is provided. */
  embeddingEvaluator?: QualityGateEvaluator;
  /** If true, use the fastest available evaluator (rule > embedding > LLM). */
  preferFastPath?: boolean;
}

interface CountedSubtaskNode {
  status: string;
  result?: string;
  subtasks: CountedSubtaskNode[];
}

const CHARS_PER_SUBTASK = 200;
const HALLUCINATION_PENALTY = 0.25;
const CONTRADICTION_PENALTY = 0.25;
const CITATION_PENALTY = 0.2;
const UNSAFETY_PENALTY = 0.35;

/**
 * Built-in rule-based evaluator. Penalizes genuine hallucination signals
 * without punishing careful analytical language.
 */
class RuleBasedEvaluator implements QualityGateEvaluator {
  supports(): boolean {
    return true;
  }

  async evaluate(
    type: QualityGateType,
    synthesis: string,
    context?: { taskTree?: TaskTreeNode },
  ): Promise<{ score: number; reason?: string }> {
    switch (type) {
      case 'HALLUCINATION_CHECK':
        return { score: this.checkHallucination(synthesis) };
      case 'CONSISTENCY':
        return { score: this.checkConsistency(synthesis, context?.taskTree) };
      case 'COMPLETENESS':
        return { score: this.checkCompleteness(synthesis, context?.taskTree) };
      case 'ACCURACY':
        return { score: this.checkAccuracy(synthesis) };
      case 'SAFETY':
        return { score: this.checkSafety(synthesis) };
      default:
        return { score: 1 };
    }
  }

  private checkHallucination(synthesis: string): number {
    let score = 1.0;

    // Genuine hallucination signals: fabricating confidence, inventing citations,
    // or claiming knowledge the model cannot have.
    const hallucinationSignals = [
      /\b(unverified|unsourced|allegedly|reportedly|supposedly)\b/gi,
      /\b(as of my last|as of my knowledge cutoff)\b/gi,
      /\b(I don't have|I cannot|I'm not able)\b/gi,
      /\b(it is important to note that it is important)\b/gi,
      /\b(clearly|obviously|undoubtedly|certainly)\s+.{0,50}\b(because|since|due to)\b/gi,
    ];

    for (const signal of hallucinationSignals) {
      if (signal.test(synthesis)) {
        score -= HALLUCINATION_PENALTY;
      }
    }

    return Math.max(0, score);
  }

  private checkConsistency(synthesis: string, taskTree?: TaskTreeNode): number {
    let score = 1.0;
    const lower = synthesis.toLowerCase();

    // We no longer penalize single hedging / contrastive words.
    // Instead, we only flag *pairs* of directly contradictory strong claims.
    const contradictionPatterns: [RegExp, RegExp][] = [
      [/\b(always|must|never)\b/i, /\b(sometimes|may|can)\b/i],
      [/\bincrease[sd]?\b/i, /\bdecrease[sd]?\b/i],
      [/\bhigh\b/i, /\blow\b/i],
      [/\ball\b/i, /\bnone\b/i],
      [/\bdefinitely\b/i, /\bnot\s+(?:true|correct|accurate)\b/i],
    ];

    let contradictionCount = 0;
    for (const [pos, neg] of contradictionPatterns) {
      if (pos.test(synthesis) && neg.test(synthesis)) {
        contradictionCount++;
      }
    }
    if (contradictionCount > 0) {
      score -= contradictionCount * CONTRADICTION_PENALTY;
    }

    // Check if subtask results are present and substantial
    if (taskTree) {
      const completed = this.collectCompleted(taskTree);
      let hasResults = 0;
      for (const n of completed) {
        if (n.result && n.result.length > 20) hasResults++;
      }
      if (completed.length > 0 && hasResults < completed.length) {
        score -= 0.2;
      }
    }

    return Math.max(0, score);
  }

  private checkCompleteness(synthesis: string, taskTree?: TaskTreeNode): number {
    if (!taskTree) return 1;
    const completed = this.collectCompleted(taskTree);
    const total = this.countAllNodes(taskTree);
    const completionRatio = total > 0 ? completed.length / total : 1;

    const expectedLength = Math.max(500, total * CHARS_PER_SUBTASK);
    const lengthScore = Math.min(1, synthesis.length / expectedLength);

    return completionRatio * 0.6 + lengthScore * 0.4;
  }

  private checkAccuracy(synthesis: string): number {
    let score = 1.0;
    const lower = synthesis.toLowerCase();

    // These are normal analytical hedges, not accuracy problems.
    // We deliberately do NOT penalize them.
    const allowedHedges = [
      'might indicate',
      'might suggest',
      'suggests that',
      'could indicate',
      'may indicate',
      'appears to',
      'seems to',
      'is likely',
      'is unlikely',
      'tends to',
      'in many cases',
      'on average',
    ];

    // Only penalize direct admission of lacking information or missing citations.
    const uncertaintyPhrases = [
      'i do not know',
      'i have no information',
      'no data available',
      '[citation needed]',
      '[source missing]',
    ];

    let uncertaintyCount = 0;
    for (const phrase of uncertaintyPhrases) {
      if (lower.includes(phrase)) uncertaintyCount++;
    }

    // Count allowed hedges and treat them as positive (they show epistemic care).
    let hedgeCount = 0;
    for (const phrase of allowedHedges) {
      if (lower.includes(phrase)) hedgeCount++;
    }

    // Net uncertainty penalty cannot exceed 0.4; hedges partially offset admissions.
    score -= Math.min(Math.max(0, uncertaintyCount - Math.min(hedgeCount, 2)) * 0.05, 0.4);

    if (synthesis.includes('[citation needed]')) score -= CITATION_PENALTY;
    if (synthesis.includes('[source missing]')) score -= CITATION_PENALTY;

    return Math.max(0, score);
  }

  private checkSafety(synthesis: string): number {
    let score = 1.0;

    const unsafePatterns = [
      /(bypass|circumvent|evade)(?:\s+\w+){0,3}\s+(security|safety|restriction|control)/i,
      /(malicious|harmful|dangerous)\s+(code|script|command|payload)/i,
      /(exploit|vulnerability)\s+(in|for)\s+(production|live|deployed)/i,
    ];

    for (const pattern of unsafePatterns) {
      if (pattern.test(synthesis)) {
        score -= UNSAFETY_PENALTY;
      }
    }

    return Math.max(0, score);
  }

  private collectCompleted(node: CountedSubtaskNode): CountedSubtaskNode[] {
    const completed: CountedSubtaskNode[] = [];
    if (node.status === 'COMPLETED' && node.result !== undefined && node.result !== null) {
      completed.push(node);
    }
    for (const sub of node.subtasks) {
      completed.push(...this.collectCompleted(sub));
    }
    return completed;
  }

  private countAllNodes(node: CountedSubtaskNode): number {
    let count = 1;
    for (const sub of node.subtasks) {
      count += this.countAllNodes(sub);
    }
    return count;
  }
}

/**
 * LLM-as-judge evaluator. Prompts a provider to score a synthesis on a gate
 * dimension. Returns a structured score in [0, 1].
 */
export class LLMJudgeEvaluator implements QualityGateEvaluator {
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  supports(type: QualityGateType): boolean {
    return ['HALLUCINATION_CHECK', 'CONSISTENCY', 'COMPLETENESS', 'ACCURACY'].includes(type);
  }

  async evaluate(
    type: QualityGateType,
    synthesis: string,
    context?: { taskTree?: TaskTreeNode; reference?: string },
  ): Promise<{ score: number; reason?: string }> {
    const prompt = this.buildPrompt(type, synthesis, context);
    const request: LLMRequest = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict quality judge. Reply with JSON only: {"score": number 0-1, "reason": string}.',
        },
        { role: 'user', content: prompt },
      ],
      maxTokens: 256,
    };

    let response: LLMResponse;
    try {
      response = await this.provider.call(request);
    } catch {
      return { score: 0.5, reason: 'LLM judge unavailable; falling back to neutral score' };
    }

    const content = response.content?.trim() ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { score: 0.5, reason: 'LLM judge did not return parseable JSON' };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { score?: number; reason?: string };
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5;
      return { score, reason: parsed.reason };
    } catch {
      return { score: 0.5, reason: 'Failed to parse LLM judge JSON' };
    }
  }

  private buildPrompt(
    type: QualityGateType,
    synthesis: string,
    context?: { taskTree?: TaskTreeNode; reference?: string },
  ): string {
    const referenceText = context?.reference ? `Reference text:\n${context.reference}\n\n` : '';
    switch (type) {
      case 'HALLUCINATION_CHECK':
        return (
          `${referenceText}Evaluate whether the following synthesis contains hallucinations ` +
          `(claims presented as fact without evidence, invented citations, or pretending to know). ` +
          `Distinguish this from careful analytical language ("might indicate", "suggests that").\n\n` +
          `Synthesis:\n${synthesis}\n\nReturn score 0-1 where 1 = no hallucination, 0 = severe hallucination.`
        );
      case 'CONSISTENCY':
        return (
          `${referenceText}Evaluate whether the following synthesis is internally consistent. ` +
          `Penalize direct contradictions, not contrastive discussion.\n\n` +
          `Synthesis:\n${synthesis}\n\nReturn score 0-1 where 1 = fully consistent.`
        );
      case 'COMPLETENESS':
        return (
          `${referenceText}Evaluate whether the following synthesis covers the key points and ` +
          `subtask results it should.\n\n` +
          `Synthesis:\n${synthesis}\n\nReturn score 0-1 where 1 = complete.`
        );
      case 'ACCURACY':
        return (
          `${referenceText}Evaluate the accuracy of the following synthesis relative to the reference. ` +
          `Do not penalize hedged, evidence-based conclusions.\n\n` +
          `Synthesis:\n${synthesis}\n\nReturn score 0-1 where 1 = accurate.`
        );
      default:
        return `Evaluate the following synthesis.\n\n${synthesis}\n\nReturn score 0-1.`;
    }
  }
}

/**
 * Embedding-based evaluator. Compares synthesis to a reference text using
 * cosine similarity. Useful when LLM calls are too expensive or unavailable.
 */
export class EmbeddingEvaluator implements QualityGateEvaluator {
  constructor(
    private embed: (text: string) => Promise<number[]>,
    private threshold = 0.75,
  ) {}

  supports(type: QualityGateType): boolean {
    return type === 'HALLUCINATION_CHECK' || type === 'ACCURACY' || type === 'CONSISTENCY';
  }

  async evaluate(
    type: QualityGateType,
    synthesis: string,
    context?: { reference?: string },
  ): Promise<{ score: number; reason?: string }> {
    if (!context?.reference) {
      return { score: 0.5, reason: 'No reference available for embedding comparison' };
    }

    try {
      const [synthesisEmbedding, referenceEmbedding] = await Promise.all([
        this.embed(synthesis),
        this.embed(context.reference),
      ]);
      const similarity = cosineSimilarity(synthesisEmbedding, referenceEmbedding);
      const score = Math.max(0, Math.min(1, similarity / this.threshold));
      return {
        score,
        reason: `Embedding cosine similarity: ${similarity.toFixed(3)} (threshold ${this.threshold})`,
      };
    } catch {
      return { score: 0.5, reason: 'Embedding evaluation failed' };
    }
  }
}

/**
 * Quality gate engine.
 */
export class QualityGateEngine {
  private ruleEvaluator = new RuleBasedEvaluator();

  constructor(private options: QualityGateEngineOptions = {}) {}

  async run(
    gates: QualityGateConfig[],
    synthesis: string,
    context?: { taskTree?: TaskTreeNode; reference?: string },
  ): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = [];

    for (const gate of gates) {
      if (!gate.enabled) continue;

      const evaluator = this.selectEvaluator(gate.type);
      const { score, reason } = await evaluator.evaluate(gate.type, synthesis, context);

      results.push({
        gate: gate.name,
        passed: score >= gate.threshold,
        score,
        reason,
      });
    }

    return results;
  }

  private selectEvaluator(type: QualityGateType): QualityGateEvaluator {
    if (this.options.llmEvaluator && this.options.llmEvaluator.supports(type)) {
      if (!this.options.preferFastPath) return this.options.llmEvaluator;
    }
    if (this.options.embeddingEvaluator && this.options.embeddingEvaluator.supports(type)) {
      return this.options.embeddingEvaluator;
    }
    // Fall back to rule-based if fast path is preferred and LLM is skipped.
    if (this.options.preferFastPath && this.options.llmEvaluator?.supports(type)) {
      return this.ruleEvaluator;
    }
    if (this.options.llmEvaluator && this.options.llmEvaluator.supports(type)) {
      return this.options.llmEvaluator;
    }
    return this.ruleEvaluator;
  }
}
