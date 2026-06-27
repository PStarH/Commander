/**
 * Reflexion Loop — Self-improving agent behavior via reflection
 *
 * Implements the IReflexionLoop contract from Pillar IV.
 *
 * Reflexion Cycle:
 * 1. Actor attempts a task → produces an ExecutionOutcome
 * 2. Evaluator assesses the outcome → ReflexionVerdict
 * 3. Reflector generates a self-critique → ReflectionOutput
 * 4. Memory incorporates the reflection for future improvement
 * 5. Improvement trends are tracked over time
 *
 * Per constraint PIV-FR-06, implements Reflexion Loop.
 * Per constraint PIV-FR-12, generates explicit reasoning traces.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  IReflexionLoop,
  ExecutionOutcome,
  ReflexionVerdict,
  ReflectionOutput,
  ImprovementTrend,
} from '../contracts/pillarIV';

// ============================================================================
// Types
// ============================================================================

interface ReflexionEntry {
  /** Timestamp of this reflection */
  timestamp: number;
  /** The execution outcome that triggered it */
  outcome: ExecutionOutcome;
  /** The verdict */
  verdict: ReflexionVerdict;
  /** The reflection output */
  reflection: ReflectionOutput;
}

// ============================================================================
// ReflexionLoop Implementation
// ============================================================================

export class ReflexionLoop implements IReflexionLoop {
  private history: ReflexionEntry[] = [];
  private reflections: ReflectionOutput[] = [];
  private maxHistorySize: number;

  // Thresholds for verdict determination
  private readonly latencyThresholdMs: number;
  private readonly tokenCostThreshold: number;
  private readonly satisfactionThreshold: number;

  constructor(options?: {
    maxHistorySize?: number;
    latencyThresholdMs?: number;
    tokenCostThreshold?: number;
    satisfactionThreshold?: number;
  }) {
    this.maxHistorySize = options?.maxHistorySize ?? 200;
    this.latencyThresholdMs = options?.latencyThresholdMs ?? 5000;
    this.tokenCostThreshold = options?.tokenCostThreshold ?? 10000;
    this.satisfactionThreshold = options?.satisfactionThreshold ?? 0.7;
  }

  /**
   * Evaluate an execution outcome and determine a verdict.
   *
   * POSITIVE: success + good performance + high satisfaction
   * NEGATIVE: failure OR very poor performance OR low satisfaction
   * NEUTRAL: success with mediocre performance, or ambiguous signals
   */
  evaluate(outcome: ExecutionOutcome): ReflexionVerdict {
    let negativeSignals = 0;
    let positiveSignals = 0;

    // Success/failure
    if (outcome.success) {
      positiveSignals++;
    } else {
      negativeSignals += 2; // Failure is a strong negative signal
    }

    // Latency
    if (outcome.latencyMs > this.latencyThresholdMs * 2) {
      negativeSignals++;
    } else if (outcome.latencyMs < this.latencyThresholdMs) {
      positiveSignals++;
    }

    // Token cost
    if (outcome.tokenCost > this.tokenCostThreshold * 2) {
      negativeSignals++;
    } else if (outcome.tokenCost < this.tokenCostThreshold) {
      positiveSignals++;
    }

    // User satisfaction (if available)
    if (outcome.userSatisfaction !== undefined) {
      if (outcome.userSatisfaction < this.satisfactionThreshold - 0.2) {
        negativeSignals += 2;
      } else if (outcome.userSatisfaction > this.satisfactionThreshold) {
        positiveSignals++;
      }
    }

    // Determine verdict
    if (negativeSignals >= 2) return 'NEGATIVE';
    if (positiveSignals >= 3) return 'POSITIVE';
    return 'NEUTRAL';
  }

  /**
   * Generate a self-critique reflection for the given outcome.
   *
   * Analyzes what went well, what went wrong, and suggests improvements.
   */
  async generateReflection(outcome: ExecutionOutcome): Promise<ReflectionOutput> {
    const verdict = this.evaluate(outcome);
    const suggestions: string[] = [];
    const critiqueParts: string[] = [];

    // Analyze success
    if (!outcome.success) {
      critiqueParts.push('Task execution failed.');
      suggestions.push('Review the failure point and add error handling or retry logic.');
      suggestions.push('Consider breaking down the task into smaller, more verifiable steps.');
    } else {
      critiqueParts.push('Task executed successfully.');
    }

    // Analyze latency
    if (outcome.latencyMs > this.latencyThresholdMs) {
      critiqueParts.push(
        `Latency of ${outcome.latencyMs}ms exceeded the ${this.latencyThresholdMs}ms threshold.`,
      );
      suggestions.push('Optimize the execution path — consider caching, parallelization, or model selection.');
    } else if (outcome.success) {
      critiqueParts.push(
        `Latency of ${outcome.latencyMs}ms was within acceptable bounds.`,
      );
    }

    // Analyze token cost
    if (outcome.tokenCost > this.tokenCostThreshold) {
      critiqueParts.push(
        `Token cost of ${outcome.tokenCost} exceeded the ${this.tokenCostThreshold} budget.`,
      );
      suggestions.push('Reduce token usage — consider prompt compression, context trimming, or a more efficient model.');
    }

    // Analyze user satisfaction
    if (outcome.userSatisfaction !== undefined) {
      if (outcome.userSatisfaction < this.satisfactionThreshold) {
        critiqueParts.push(
          `User satisfaction was low (${outcome.userSatisfaction.toFixed(2)}).`,
        );
        suggestions.push('Improve response quality — consider adding more context or refining the output format.');
      } else {
        critiqueParts.push(
          `User satisfaction was high (${outcome.userSatisfaction.toFixed(2)}).`,
        );
      }
    }

    // Verdict-specific suggestions
    if (verdict === 'POSITIVE') {
      suggestions.push('Consider this execution pattern as a template for similar future tasks.');
    } else if (verdict === 'NEGATIVE') {
      suggestions.push('Record this failure case in procedural memory to avoid repeating the same mistakes.');
      suggestions.push('Consider escalating to a more capable model or adding human review.');
    }

    // Compute confidence based on signal strength
    const signalsAvailable =
      (outcome.success !== undefined ? 1 : 0) +
      (outcome.latencyMs > 0 ? 1 : 0) +
      (outcome.tokenCost > 0 ? 1 : 0) +
      (outcome.userSatisfaction !== undefined ? 1 : 0);
    const confidence = Math.min(1, signalsAvailable / 4);

    const critique = critiqueParts.join(' ');

    const reflection: ReflectionOutput = {
      critique,
      suggestions,
      confidence,
    };

    getGlobalLogger().debug('ReflexionLoop', 'Reflection generated', {
      verdict,
      task: outcome.task,
      confidence,
      suggestionCount: suggestions.length,
    });

    return reflection;
  }

  /**
   * Incorporate a reflection into memory.
   * Stores the reflection for future reference and trend tracking.
   */
  async incorporate(reflection: ReflectionOutput): Promise<void> {
    this.reflections.push(reflection);

    // Trim history if exceeding max size
    if (this.reflections.length > this.maxHistorySize) {
      this.reflections.shift();
    }

    getGlobalLogger().debug('ReflexionLoop', 'Reflection incorporated', {
      totalReflections: this.reflections.length,
      confidence: reflection.confidence,
    });
  }

  /**
   * Track improvement over time.
   * Analyzes recent history to determine trends in success rate,
   * latency, and token efficiency.
   */
  getImprovements(): ImprovementTrend[] {
    if (this.history.length < 2) {
      return [{
        period: 'all-time',
        successRateTrend: 'stable',
        latencyTrend: 'stable',
        tokenEfficiencyTrend: 'stable',
      }];
    }

    // Split history into two halves for trend comparison
    const midpoint = Math.floor(this.history.length / 2);
    const firstHalf = this.history.slice(0, midpoint);
    const secondHalf = this.history.slice(midpoint);

    const firstSuccessRate = this.computeSuccessRate(firstHalf);
    const secondSuccessRate = this.computeSuccessRate(secondHalf);
    const firstAvgLatency = this.computeAverageLatency(firstHalf);
    const secondAvgLatency = this.computeAverageLatency(secondHalf);
    const firstAvgTokens = this.computeAverageTokens(firstHalf);
    const secondAvgTokens = this.computeAverageTokens(secondHalf);

    const successRateTrend = this.determineTrend(secondSuccessRate, firstSuccessRate);
    const latencyTrend = this.determineTrend(firstAvgLatency, secondAvgLatency); // Lower is better
    const tokenEfficiencyTrend = this.determineTrend(firstAvgTokens, secondAvgTokens); // Lower is better

    const trend: ImprovementTrend = {
      period: `last-${this.history.length}-executions`,
      successRateTrend,
      latencyTrend,
      tokenEfficiencyTrend,
    };

    getGlobalLogger().debug('ReflexionLoop', 'Improvement trends computed', {
      successRateTrend,
      latencyTrend,
      tokenEfficiencyTrend,
      firstHalfSuccessRate: firstSuccessRate.toFixed(3),
      secondHalfSuccessRate: secondSuccessRate.toFixed(3),
    });

    return [trend];
  }

  // ------------------------------------------------------------------------
  // Internal methods for tracking execution outcomes
  // ------------------------------------------------------------------------

  /**
   * Record an execution outcome with its verdict and reflection.
   * This is used internally to maintain history for trend tracking.
   */
  recordOutcome(
    outcome: ExecutionOutcome,
    reflection: ReflectionOutput,
  ): void {
    const verdict = this.evaluate(outcome);
    const entry: ReflexionEntry = {
      timestamp: Date.now(),
      outcome,
      verdict,
      reflection,
    };

    this.history.push(entry);

    // Trim history
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Also incorporate the reflection
    this.reflections.push(reflection);
    if (this.reflections.length > this.maxHistorySize) {
      this.reflections.shift();
    }
  }

  /**
   * Get all stored reflections.
   */
  getReflections(): ReflectionOutput[] {
    return [...this.reflections];
  }

  /**
   * Get the full history of execution outcomes with verdicts.
   */
  getHistory(): ReflexionEntry[] {
    return [...this.history];
  }

  /**
   * Get the count of reflections by verdict type.
   */
  getVerdictCounts(): { positive: number; negative: number; neutral: number } {
    let positive = 0;
    let negative = 0;
    let neutral = 0;

    for (const entry of this.history) {
      switch (entry.verdict) {
        case 'POSITIVE': positive++; break;
        case 'NEGATIVE': negative++; break;
        case 'NEUTRAL': neutral++; break;
      }
    }

    return { positive, negative, neutral };
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  private computeSuccessRate(entries: ReflexionEntry[]): number {
    if (entries.length === 0) return 0;
    const successes = entries.filter((e) => e.outcome.success).length;
    return successes / entries.length;
  }

  private computeAverageLatency(entries: ReflexionEntry[]): number {
    if (entries.length === 0) return 0;
    const total = entries.reduce((sum, e) => sum + e.outcome.latencyMs, 0);
    return total / entries.length;
  }

  private computeAverageTokens(entries: ReflexionEntry[]): number {
    if (entries.length === 0) return 0;
    const total = entries.reduce((sum, e) => sum + e.outcome.tokenCost, 0);
    return total / entries.length;
  }

  /**
   * Determine trend: improving if second > first (for success rate),
   * or first > second (for latency/tokens where lower is better).
   */
  private determineTrend(first: number, second: number): 'improving' | 'declining' | 'stable' {
    const threshold = 0.1; // 10% change threshold
    const diff = second - first;

    if (Math.abs(diff) < threshold * Math.max(first, 1)) return 'stable';
    return diff > 0 ? 'improving' : 'declining';
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalReflexionLoop: ReflexionLoop | null = null;

export function getGlobalReflexionLoop(): ReflexionLoop {
  if (!globalReflexionLoop) {
    globalReflexionLoop = new ReflexionLoop();
  }
  return globalReflexionLoop;
}
