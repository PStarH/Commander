/**
 * Adaptive Stopping — Beta-Binomial + KS Test Convergence Detection
 *
 * Research basis: "Commander-BFT-C3" consensus report section 6 (Debate Layer).
 *
 * Core insight: Debate's value is candidate-space EXPLORATION, not belief updating.
 * The Martingale property shows debate rounds don't improve expected accuracy —
 * final voting is the primary driver. By detecting when the candidate answer
 * space is saturated (no new distinct answers emerging), we can stop debate early,
 * cutting 60-90% of token costs.
 *
 * Algorithm:
 *   1. Track answer diversity per round using a Beta-Binomial model.
 *      P(new distinct answer) ~ Beta(α, β) updated each round.
 *      When P(new distinct) falls below threshold, the answer space is saturated.
 *   2. Cross-validate with a Kolmogorov-Smirnov (KS) test: compare the
 *      distribution of answer fingerprints between consecutive rounds.
 *      If the distributions are statistically indistinguishable (p > α_KS),
 *      candidates have converged.
 *   3. Combine both signals: stop when BOTH the Beta-Binomial probability
 *      is low AND the KS test fails to reject the null hypothesis.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DebateRound {
  roundNumber: number;
  answers: string[];
  /** Token cost consumed in this round */
  tokenCost: number;
}

export interface AdaptiveStoppingResult {
  shouldStop: boolean;
  reason: string;
  /** Estimated token savings from stopping now vs. running all remaining rounds */
  estimatedTokenSavings: number;
  /** Current probability of seeing a new distinct answer in the next round */
  noveltyProbability: number;
  /** KS test p-value for distribution comparison */
  ksPValue: number;
  /** Current round number */
  currentRound: number;
  /** Maximum rounds configured */
  maxRounds: number;
}

export interface AdaptiveStoppingConfig {
  /** Maximum debate rounds (hard cap). Default 10. */
  maxRounds: number;
  /** Minimum rounds before stopping can trigger (exploration floor). Default 2. */
  minRounds: number;
  /** Beta-Binomial: probability threshold below which the answer space is saturated. Default 0.05. */
  noveltyThreshold: number;
  /** KS test: significance level — if p > this, distributions are similar. Default 0.05. */
  ksAlpha: number;
  /** KS test: critical D value override (computed from sample size if not provided) */
  ksCriticalD?: number;
  /** Prior parameters for Beta distribution (α = prior successes, β = prior failures). Default 1, 1 (uniform). */
  betaPrior: { alpha: number; beta: number };
  /** Maximum tokens to spend before forcing stop. 0 = no limit. */
  maxTokens: number;
  /** If true, requires BOTH signals to agree before stopping. If false, either signal suffices. */
  requireBothSignals: boolean;
}

export const DEFAULT_CONFIG: AdaptiveStoppingConfig = {
  maxRounds: 10,
  minRounds: 2,
  noveltyThreshold: 0.05,
  ksAlpha: 0.05,
  betaPrior: { alpha: 1, beta: 1 },
  maxTokens: 0,
  requireBothSignals: true,
};

// ── Beta-Binomial Model ──────────────────────────────────────────────────────

/**
 * Beta-Binomial model for tracking answer novelty.
 *
 * Each round, we observe whether at least one NEW distinct answer appeared
 * (success) or only previously-seen answers were produced (failure).
 *
 * Posterior: P(new distinct answer next round) = α / (α + β)
 * Updated: α += 1 on success, β += 1 on failure.
 */
export class BetaBinomialTracker {
  private alpha: number;
  private beta: number;
  private seenAnswers: Set<string> = new Set();

  constructor(prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 }) {
    this.alpha = prior.alpha;
    this.beta = prior.beta;
  }

  /**
   * Record a round's answers. Returns true if at least one new distinct answer was observed.
   */
  recordRound(answers: string[]): boolean {
    let hasNovelty = false;
    for (const answer of answers) {
      const fingerprint = this.hashAnswer(answer);
      if (!this.seenAnswers.has(fingerprint)) {
        this.seenAnswers.add(fingerprint);
        hasNovelty = true;
      }
    }

    if (hasNovelty) {
      this.alpha += 1;
    } else {
      this.beta += 1;
    }

    return hasNovelty;
  }

  /**
   * Current probability of seeing a new distinct answer in the next round.
   */
  get noveltyProbability(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  /**
   * Number of distinct answers seen so far.
   */
  get distinctCount(): number {
    return this.seenAnswers.size;
  }

  /**
   * Hash an answer to a fingerprint for deduplication.
   * Normalizes whitespace and lowercases for comparison.
   */
  private hashAnswer(answer: string): string {
    return answer
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim()
      .slice(0, 500); // Cap length to bound memory
  }

  reset(prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 }): void {
    this.alpha = prior.alpha;
    this.beta = prior.beta;
    this.seenAnswers.clear();
  }
}

// ── Kolmogorov-Smirnov Test ──────────────────────────────────────────────────

/**
 * Two-sample Kolmogorov-Smirnov test.
 *
 * Compares the empirical cumulative distribution functions (ECDFs) of two
 * samples. Returns the test statistic D and an approximate p-value.
 *
 * For answer-space convergence: if two consecutive rounds produce answers
 * with statistically indistinguishable distributions (high p-value), the
 * candidates have converged and further rounds won't add diversity.
 */
export function ksTest(sample1: number[], sample2: number[]): { D: number; pValue: number } {
  if (sample1.length === 0 || sample2.length === 0) {
    return { D: 1, pValue: 0 };
  }

  // Sort both samples
  const s1 = [...sample1].sort((a, b) => a - b);
  const s2 = [...sample2].sort((a, b) => a - b);

  const n1 = s1.length;
  const n2 = s2.length;

  // Merge and compute ECDFs
  const allValues = [...new Set([...s1, ...s2])].sort((a, b) => a - b);

  let maxD = 0;
  for (const v of allValues) {
    const ecdf1 = s1.filter((x) => x <= v).length / n1;
    const ecdf2 = s2.filter((x) => x <= v).length / n2;
    maxD = Math.max(maxD, Math.abs(ecdf1 - ecdf2));
  }

  // Approximate p-value using the Kolmogorov distribution
  // D_n = D * sqrt(n1*n2 / (n1+n2))
  const effectiveN = Math.sqrt((n1 * n2) / (n1 + n2));
  const lambda = (effectiveN + 0.12 + 0.11 / effectiveN) * maxD;

  // Q_KS(λ) = 2 * Σ (-1)^(j-1) * e^(-2*j^2*λ^2)
  let pValue = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * Math.pow(-1, j - 1) * Math.exp(-2 * j * j * lambda * lambda);
    pValue += term;
    if (Math.abs(term) < 1e-10) break;
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return { D: maxD, pValue };
}

/**
 * Convert answer texts to numeric fingerprints for KS testing.
 * Uses a simple hash-to-number mapping.
 */
export function answersToNumeric(answers: string[]): number[] {
  return answers.map((a) => {
    let hash = 0;
    const normalized = a.toLowerCase().replace(/\s+/g, ' ').trim();
    for (let i = 0; i < normalized.length && i < 200; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  });
}

// ── Adaptive Stopping Controller ─────────────────────────────────────────────

export class AdaptiveStoppingController {
  private config: AdaptiveStoppingConfig;
  private betaBinomial: BetaBinomialTracker;
  private rounds: DebateRound[] = [];
  private totalTokensSpent = 0;
  private previousNumeric: number[] = [];

  constructor(config?: Partial<AdaptiveStoppingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.betaBinomial = new BetaBinomialTracker(this.config.betaPrior);
  }

  /**
   * Record a completed debate round and check if we should stop.
   */
  recordRound(round: DebateRound): AdaptiveStoppingResult {
    this.rounds.push(round);
    this.totalTokensSpent += round.tokenCost;

    const currentRound = round.roundNumber;

    // Beta-Binomial novelty tracking
    const hasNovelty = this.betaBinomial.recordRound(round.answers);
    const noveltyProbability = this.betaBinomial.noveltyProbability;
    const noveltySaturated = noveltyProbability < this.config.noveltyThreshold;

    // KS test: compare current round's answer distribution with previous round
    const currentNumeric = answersToNumeric(round.answers);
    let ksPValue = 1.0;
    let distributionsSimilar = true;

    if (this.previousNumeric.length > 0 && currentNumeric.length > 0) {
      const ksResult = ksTest(this.previousNumeric, currentNumeric);
      ksPValue = ksResult.pValue;
      // If p > alpha, we CANNOT reject the null hypothesis that the
      // distributions are the same — meaning the rounds are producing
      // statistically similar answer sets (convergence).
      distributionsSimilar = ksPValue > this.config.ksAlpha;
    }
    this.previousNumeric = currentNumeric;

    // Determine if we should stop
    let shouldStop = false;
    let reason = '';

    // Hard caps
    if (currentRound >= this.config.maxRounds) {
      shouldStop = true;
      reason = `Maximum rounds reached (${this.config.maxRounds})`;
    } else if (this.config.maxTokens > 0 && this.totalTokensSpent >= this.config.maxTokens) {
      shouldStop = true;
      reason = `Token budget exhausted (${this.totalTokensSpent} >= ${this.config.maxTokens})`;
    } else if (currentRound >= this.config.minRounds) {
      // Signal-based stopping
      const noveltySignal = noveltySaturated;
      const ksSignal = distributionsSimilar;

      if (this.config.requireBothSignals) {
        if (noveltySignal && ksSignal) {
          shouldStop = true;
          reason = `Both signals agree: novelty P=${noveltyProbability.toFixed(4)} < ${this.config.noveltyThreshold}, KS p=${ksPValue.toFixed(4)} > ${this.config.ksAlpha}`;
        }
      } else {
        if (noveltySignal) {
          shouldStop = true;
          reason = `Novelty saturated: P(new distinct)=${noveltyProbability.toFixed(4)} < ${this.config.noveltyThreshold}`;
        } else if (ksSignal && this.previousNumeric.length > 0) {
          shouldStop = true;
          reason = `Distributions converged: KS p=${ksPValue.toFixed(4)} > ${this.config.ksAlpha}`;
        }
      }
    }

    if (!shouldStop && currentRound < this.config.minRounds) {
      reason = `Minimum rounds not yet reached (${currentRound}/${this.config.minRounds})`;
    }

    // Estimate token savings: remaining rounds × average tokens per round
    const avgTokensPerRound =
      this.rounds.length > 0 ? this.totalTokensSpent / this.rounds.length : 0;
    const remainingRounds = this.config.maxRounds - currentRound;
    const estimatedTokenSavings = shouldStop ? remainingRounds * avgTokensPerRound : 0;

    return {
      shouldStop,
      reason,
      estimatedTokenSavings,
      noveltyProbability,
      ksPValue,
      currentRound,
      maxRounds: this.config.maxRounds,
    };
  }

  /**
   * Get a summary of all rounds recorded so far.
   */
  getSummary(): {
    totalRounds: number;
    totalTokensSpent: number;
    distinctAnswers: number;
    noveltyProbability: number;
    avgTokensPerRound: number;
    rounds: DebateRound[];
  } {
    return {
      totalRounds: this.rounds.length,
      totalTokensSpent: this.totalTokensSpent,
      distinctAnswers: this.betaBinomial.distinctCount,
      noveltyProbability: this.betaBinomial.noveltyProbability,
      avgTokensPerRound: this.rounds.length > 0 ? this.totalTokensSpent / this.rounds.length : 0,
      rounds: [...this.rounds],
    };
  }

  reset(): void {
    this.betaBinomial.reset(this.config.betaPrior);
    this.rounds = [];
    this.totalTokensSpent = 0;
    this.previousNumeric = [];
  }

  getConfig(): AdaptiveStoppingConfig {
    return { ...this.config };
  }
}
