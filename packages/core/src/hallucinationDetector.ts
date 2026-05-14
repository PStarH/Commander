/**
 * Hallucination Detector
 * 
 * Multi-signal hallucination detection for LLM outputs.
 * Uses pattern analysis, confidence calibration, and consistency checking
 * without requiring additional LLM calls (zero-cost first pass).
 * 
 * Based on research:
 * - "A Survey on Hallucination in Large Language Models" (Huang et al., 2023)
 * - "SelfCheckGPT: Zero-Resource Black-Box Hallucination Detection" (Manakul et al., 2023)
 * - "FActScore: Fine-grained Atomic Evaluation of Factual Precision" (Min et al., 2023)
 */

export interface HallucinationSignal {
  type: 'overconfidence' | 'unsupported_specificity' | 'inconsistency' | 'fabricated_reference' | 'temporal_impossibility' | 'numeric_anomaly';
  severity: 'low' | 'medium' | 'high';
  evidence: string;
  suggestion: string;
}

export interface HallucinationReport {
  riskScore: number; // 0-1, higher = more likely hallucination
  signals: HallucinationSignal[];
  summary: string;
  recommendation: 'pass' | 'flag_for_review' | 'reject';
}

// ============================================================================
// Pattern Definitions
// ============================================================================

/** Overconfidence markers (multilingual) */
const OVERCONFIDENCE_PATTERNS = [
  // English
  /\b(100% (certain|sure|confident|guaranteed))\b/i,
  /\b(I('m| am) (absolutely |completely )?(certain|sure|confident))\b/i,
  /\b(without (a |any )?doubt)\b/i,
  /\b(guaranteed? to (be|work|succeed))\b/i,
  /\b(this (is|will) definitely)\b/i,
  /\b(there is no (way|chance|possibility) (that )?(this|it) (is|could|would) (wrong|false|incorrect))\b/i,
  // Chinese
  /[我确]定/,
  /毫无疑问/,
  /百分之百/,
  /绝对(?:正确|没错|不会错)/,
  /(?:一定|肯定)(?:是|会|能)/,
  // Common LLM hallucination patterns
  /\b(as (an AI|a language model),? I (can|do) (confirm|verify|assure))\b/i,
];

/** Unsupported specificity — very precise claims without hedging */
const SPECIFICITY_PATTERNS = [
  // Exact dates/numbers without source
  /(?:on |dated? )\d{4}[-\/]\d{2}[-\/]\d{2}/,
  // Specific statistics without attribution
  /\b\d+(\.\d+)?%\s+(of|increase|decrease|growth|reduction)\b/i,
  // Named studies without citation
  /(?:according to|published in|study (by|from|in))\s+(?:the\s+)?[A-Z][a-z]+/g,
];

/** Fabricated reference patterns */
const FABRICATED_REF_PATTERNS = [
  /\b(?:a |the )?(?:recent |20\d{2} )?(?:study|research|paper|report|survey)\s+(?:by|from|conducted by|published in)\b/i,
  /\b(?:Dr\.|Professor|Prof\.)\s+[A-Z][a-z]+\s+(?:et al\.?|and (?:colleagues|team|researchers))?\s+(?:found|showed|discovered|demonstrated|proved)\b/i,
  /\b(?:Journal of|Proceedings of|IEEE|Nature|Science|Lancet|NEJM)\b/i,
];

/** Temporal markers that might be impossible */
const TEMPORAL_PATTERNS = [
  /\b(?:as of|since|until|after|in)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20[3-9]\d\b/i,
  /\b(?:yesterday|last week|last month|earlier today)\b/i,
];

// ============================================================================
// Detector
// ============================================================================

export class HallucinationDetector {
  private knowledgeCutOffDate: Date;

  constructor(options?: { knowledgeCutOffDate?: Date }) {
    this.knowledgeCutOffDate = options?.knowledgeCutOffDate ?? new Date('2025-04-01');
  }

  /**
   * Analyze an LLM output for hallucination signals.
   * Zero-cost first pass — no additional LLM calls.
   */
  analyze(input: string, output: string): HallucinationReport {
    const signals: HallucinationSignal[] = [];

    // 1. Overconfidence detection
    signals.push(...this.detectOverconfidence(output));

    // 2. Unsupported specificity
    signals.push(...this.detectUnsupportedSpecificity(output));

    // 3. Fabricated references
    signals.push(...this.detectFabricatedReferences(output));

    // 4. Temporal impossibility
    signals.push(...this.detectTemporalIssues(output));

    // 5. Input-output relevance
    signals.push(...this.checkRelevance(input, output));

    // 6. Numeric anomalies
    signals.push(...this.detectNumericAnomalies(output));

    // Calculate risk score (weighted by severity)
    const severityWeights = { low: 0.1, medium: 0.3, high: 0.5 };
    const rawScore = signals.reduce((sum, s) => sum + severityWeights[s.severity], 0);
    const riskScore = Math.min(rawScore, 1.0);

    // Determine recommendation
    let recommendation: HallucinationReport['recommendation'];
    if (riskScore >= 0.6) recommendation = 'reject';
    else if (riskScore >= 0.3) recommendation = 'flag_for_review';
    else recommendation = 'pass';

    return {
      riskScore,
      signals,
      summary: this.buildSummary(signals, riskScore),
      recommendation,
    };
  }

  // ---------------------------------------------------------------------------
  // Detection Methods
  // ---------------------------------------------------------------------------

  private detectOverconfidence(text: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];
    for (const pattern of OVERCONFIDENCE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        signals.push({
          type: 'overconfidence',
          severity: 'medium',
          evidence: `Overconfidence marker: "${match[0]}"`,
          suggestion: 'Use hedging language: "I believe", "likely", "based on available information"',
        });
        break; // One overconfidence signal is enough
      }
    }
    return signals;
  }

  private detectUnsupportedSpecificity(text: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];
    for (const pattern of SPECIFICITY_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        signals.push({
          type: 'unsupported_specificity',
          severity: 'low',
          evidence: `Specific claim without source: "${match[0]}"`,
          suggestion: 'Add attribution or hedge: "approximately", "around", "according to..."',
        });
      }
    }
    return signals;
  }

  private detectFabricatedReferences(text: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];
    for (const pattern of FABRICATED_REF_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        signals.push({
          type: 'fabricated_reference',
          severity: 'high',
          evidence: `Possible fabricated reference: "${match[0]}"`,
          suggestion: 'Verify reference exists or remove. LLMs commonly hallucinate academic citations.',
        });
        break;
      }
    }
    return signals;
  }

  private detectTemporalIssues(text: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];
    for (const pattern of TEMPORAL_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Try to parse the date
        const dateMatch = match[0].match(/20\d{2}/);
        if (dateMatch) {
          const year = parseInt(dateMatch[0], 10);
          const now = new Date();
          if (year > now.getFullYear() + 1) {
            signals.push({
              type: 'temporal_impossibility',
              severity: 'high',
              evidence: `Future date referenced: "${match[0]}"`,
              suggestion: 'Verify temporal claims against current date.',
            });
          }
        }
        // Relative time references are risky (model doesn't know "today")
        if (/(?:yesterday|last week|earlier today)/i.test(match[0])) {
          signals.push({
            type: 'temporal_impossibility',
            severity: 'low',
            evidence: `Relative time reference: "${match[0]}"`,
            suggestion: 'LLMs cannot reliably track "now". Prefer absolute dates.',
          });
        }
      }
    }
    return signals;
  }

  private checkRelevance(input: string, output: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];

    // Simple relevance check: if output is much longer than input with no new context
    const inputTokens = input.split(/\s+/).length;
    const outputTokens = output.split(/\s+/).length;

    // Output >5x input length without question marks in input suggests hallucination expansion
    if (outputTokens > inputTokens * 5 && !input.includes('?') && inputTokens > 5) {
      signals.push({
        type: 'inconsistency',
        severity: 'low',
        evidence: `Output (${outputTokens} words) is ${Math.round(outputTokens / Math.max(inputTokens, 1))}x longer than input (${inputTokens} words)`,
        suggestion: 'Verify that expanded content is grounded in the input.',
      });
    }

    return signals;
  }

  private detectNumericAnomalies(text: string): HallucinationSignal[] {
    const signals: HallucinationSignal[] = [];

    // Detect percentages that sum to more than 100%
    const percentMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    if (percentMatches.length >= 3) {
      const sum = percentMatches.reduce((s, m) => s + parseFloat(m[1]), 0);
      if (sum > 105) { // Small tolerance for rounding
        signals.push({
          type: 'numeric_anomaly',
          severity: 'medium',
          evidence: `Percentages sum to ${sum.toFixed(1)}%: ${percentMatches.map(m => m[0]).join(', ')}`,
          suggestion: 'Verify numeric claims. Percentages summing >100% is a common hallucination.',
        });
      }
    }

    // Detect impossibly precise numbers
    const preciseNumbers = text.match(/\b\d{10,}\b/g);
    if (preciseNumbers && preciseNumbers.length > 0) {
      signals.push({
        type: 'numeric_anomaly',
        severity: 'low',
        evidence: `Impossibly precise number: ${preciseNumbers[0]}`,
        suggestion: 'Very precise numbers in free text are often hallucinated.',
      });
    }

    return signals;
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  private buildSummary(signals: HallucinationSignal[], riskScore: number): string {
    if (signals.length === 0) {
      return 'No hallucination signals detected. Output appears grounded.';
    }

    const highCount = signals.filter(s => s.severity === 'high').length;
    const medCount = signals.filter(s => s.severity === 'medium').length;
    const lowCount = signals.filter(s => s.severity === 'low').length;

    const parts: string[] = [];
    if (highCount > 0) parts.push(`${highCount} high-risk`);
    if (medCount > 0) parts.push(`${medCount} medium-risk`);
    if (lowCount > 0) parts.push(`${lowCount} low-risk`);

    return `Detected ${signals.length} hallucination signal(s): ${parts.join(', ')}. Risk score: ${(riskScore * 100).toFixed(0)}%.`;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultDetector: HallucinationDetector | null = null;

export function getHallucinationDetector(options?: { knowledgeCutOffDate?: Date }): HallucinationDetector {
  if (!defaultDetector) {
    defaultDetector = new HallucinationDetector(options);
  }
  return defaultDetector;
}
