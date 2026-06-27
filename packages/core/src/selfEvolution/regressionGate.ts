import type { ExecutionExperience, RegressionEvent } from '../runtime/types';
import { getMessageBus } from '../runtime/messageBus';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { getGlobalLogger } from '../logging';

// ── Feature 6: Quality-Level PRM (Process Reward Model) Regression Gate ─────
//
// Research basis: "Commander-BFT-C3" consensus report section 5 (Regression Gate).
//
// The three-layer Regression Gate architecture:
//   Layer 1 (step-level): max_iterations — enforced by CycleDetector
//   Layer 2 (cost-level): Token budget caps — enforced by TokenGovernor
//   Layer 3 (quality-level): PRM — real-time quality monitoring with early stopping
//
// This PRM layer tracks quality scores across reflection iterations. When quality
// consistently drops (indicating Degeneration-of-Thought), it triggers early
// stopping and human intervention, preventing the model from spiraling into
// worse outputs through excessive self-correction.

export interface PRMScoreEntry {
  /** Step/iteration number within the current reflection cycle */
  step: number;
  /** Quality score from PRM or quality gate (0-1) */
  score: number;
  /** Timestamp */
  timestamp: number;
  /** Optional dimension scores */
  dimensions?: {
    relevance?: number;
    accuracy?: number;
    depth?: number;
    logic?: number;
    clarity?: number;
  };
  /** What triggered the scoring (e.g., 'quality_gate', 'self_eval', 'external_eval') */
  source: string;
}

export interface PRMRegressionAlert {
  type: 'quality_regression' | 'early_stop_triggered' | 'human_intervention_required';
  strategy: string;
  modelId: string;
  previousQuality: number;
  currentQuality: number;
  dropRatio: number;
  consecutiveDrops: number;
  message: string;
  triggeredAt: string;
}

export interface PRMConfig {
  /** Number of consecutive quality drops before triggering early stop. Default 3. */
  consecutiveDropThreshold: number;
  /** Minimum quality drop ratio to count as a regression. Default 0.05. */
  minDropRatio: number;
  /** Absolute quality floor — if score drops below this, immediately stop. Default 0.3. */
  qualityFloor: number;
  /** Whether to auto-publish alerts to the message bus. Default true. */
  publishAlerts: boolean;
  /** Maximum PRM score entries to retain per strategy. Default 50. */
  maxScoreHistory: number;
}

const DEFAULT_PRM_CONFIG: PRMConfig = {
  consecutiveDropThreshold: 3,
  minDropRatio: 0.05,
  qualityFloor: 0.3,
  publishAlerts: true,
  maxScoreHistory: 50,
};

export class RegressionGate {
  private regressionEvents: RegressionEvent[] = [];
  /** Rolling success rate history per strategy: Map<strategyName, number[]> */
  private successRateHistory: Map<string, number[]> = new Map();
  private threshold: number;

  // PRM quality tracking: Map<strategyKey, PRMScoreEntry[]>
  private prmScoreHistory: Map<string, PRMScoreEntry[]> = new Map();
  private prmConfig: PRMConfig;
  private prmAlerts: PRMRegressionAlert[] = [];
  /** Track consecutive quality drops per strategy */
  private consecutiveDrops: Map<string, number> = new Map();
  /** Strategies that have been early-stopped (prevent further reflection) */
  private earlyStopped: Set<string> = new Set();

  static readonly MAX_SUCCESS_RATE_ENTRIES = 200;

  constructor(threshold = 0.15, prmConfig?: Partial<PRMConfig>) {
    this.threshold = threshold;
    this.prmConfig = { ...DEFAULT_PRM_CONFIG, ...prmConfig };
  }

  recordExperience(exp: ExecutionExperience): void {
    const histKey = `${exp.strategyUsed}::${exp.modelUsed}`;
    if (!this.successRateHistory.has(histKey)) {
      if (this.successRateHistory.size >= RegressionGate.MAX_SUCCESS_RATE_ENTRIES) {
        const oldest = this.successRateHistory.keys().next().value;
        if (oldest) this.successRateHistory.delete(oldest);
      }
      this.successRateHistory.set(histKey, []);
    }
    const history = this.successRateHistory.get(histKey)!;
    history.push(exp.success ? 1 : 0);

    // Keep last 20 outcomes for the rolling window
    if (history.length > 20) history.shift();

    // Need at least 5 data points and a prior comparison window
    if (history.length < 10) return;

    const recentWindow = Math.min(5, Math.floor(history.length / 2));
    const recent = history.slice(-recentWindow);
    const prior = history.slice(0, history.length - recentWindow);

    const recentRate = recent.reduce((s, v) => s + v, 0) / recent.length;
    const priorRate = prior.reduce((s, v) => s + v, 0) / prior.length;

    if (priorRate > 0 && recentRate < priorRate * (1 - this.threshold)) {
      const dropRatio = priorRate > 0 ? (priorRate - recentRate) / priorRate : 0;
      if (dropRatio >= this.threshold) {
        const event: RegressionEvent = {
          strategyName: exp.strategyUsed,
          modelId: exp.modelUsed,
          taskType: exp.taskType,
          previousSuccessRate: priorRate,
          currentSuccessRate: recentRate,
          dropRatio,
          triggeredAt: new Date().toISOString(),
          autoReverted: false,
        };
        this.regressionEvents.push(event);
        if (this.regressionEvents.length > 200) this.regressionEvents.shift();

        // Update regression active count gauge
        getMetricsCollector().recordRegressionActiveCount(this.regressionEvents.length);

        const bus = getMessageBus();
        bus.publish('system.alert', 'meta-learner', {
          type: 'regression_detected',
          strategy: exp.strategyUsed,
          modelId: exp.modelUsed,
          dropRatio,
          priorRate,
          recentRate,
        });
      }
    }
  }

  getRegressionEvents(limit = 20): RegressionEvent[] {
    return this.regressionEvents.slice(-limit);
  }

  getRegressionEventsList(): RegressionEvent[] {
    return this.regressionEvents;
  }

  getSuccessRateHistory(): Map<string, number[]> {
    return this.successRateHistory;
  }

  setRegressionEvents(events: RegressionEvent[]): void {
    this.regressionEvents = events;
  }

  setSuccessRateHistory(history: Map<string, number[]>): void {
    this.successRateHistory = history;
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  // ── PRM (Process Reward Model) Quality-Level Regression Gate ─────────────

  /**
   * Record a PRM quality score for a strategy at a given step.
   * This is the quality-level (Layer 3) regression gate: it monitors quality
   * scores across reflection iterations and triggers early stopping when
   * quality consistently degrades (Degeneration-of-Thought prevention).
   *
   * @param strategyKey - Strategy identifier (e.g., "DEBATE_gpt-4o")
   * @param score - Quality score from PRM or quality gate (0-1)
   * @param step - Reflection iteration number
   * @param source - What produced the score (e.g., 'quality_gate', 'self_eval')
   * @param dimensions - Optional per-dimension scores
   * @returns A PRMRegressionAlert if early stopping was triggered, null otherwise
   */
  recordPRMScore(
    strategyKey: string,
    score: number,
    step: number,
    source: string = 'quality_gate',
    dimensions?: PRMScoreEntry['dimensions'],
  ): PRMRegressionAlert | null {
    const clampedScore = Math.max(0, Math.min(1, score));
    const entry: PRMScoreEntry = {
      step,
      score: clampedScore,
      timestamp: Date.now(),
      dimensions,
      source,
    };

    // Get or create score history for this strategy
    let history = this.prmScoreHistory.get(strategyKey);
    if (!history) {
      if (this.prmScoreHistory.size >= 100) {
        // Prune oldest strategy
        const oldest = this.prmScoreHistory.keys().next().value;
        if (oldest) this.prmScoreHistory.delete(oldest);
      }
      history = [];
      this.prmScoreHistory.set(strategyKey, history);
    }
    history.push(entry);
    if (history.length > this.prmConfig.maxScoreHistory) {
      history.shift();
    }

    // Check for quality regression
    return this.checkPRMRegression(strategyKey, history);
  }

  /**
   * Check if the quality scores show a regression pattern.
   * Triggers early stopping when:
   *   1. Quality drops below the absolute floor (qualityFloor)
   *   2. Quality has dropped consecutively N times (consecutiveDropThreshold)
   *   3. The drop ratio exceeds minDropRatio
   */
  private checkPRMRegression(strategyKey: string, history: PRMScoreEntry[]): PRMRegressionAlert | null {
    if (history.length < 2) return null;

    const current = history[history.length - 1];
    const previous = history[history.length - 2];

    // Check 1: Absolute quality floor
    if (current.score < this.prmConfig.qualityFloor) {
      // Increment consecutiveDrops so the alert reflects the true state
      const currentDrops = (this.consecutiveDrops.get(strategyKey) ?? 0) + 1;
      this.consecutiveDrops.set(strategyKey, currentDrops);
      const alert = this.createPRMAlert(
        'early_stop_triggered',
        strategyKey,
        previous.score,
        current.score,
        `Quality score ${current.score.toFixed(3)} dropped below floor ${this.prmConfig.qualityFloor}`,
      );
      this.earlyStopped.add(strategyKey);
      this.publishPRMAlert(alert);
      return alert;
    }

    // Check 2: Consecutive quality drops
    if (current.score < previous.score) {
      const dropRatio = (previous.score - current.score) / Math.max(previous.score, 0.01);
      if (dropRatio >= this.prmConfig.minDropRatio) {
        const drops = (this.consecutiveDrops.get(strategyKey) ?? 0) + 1;
        this.consecutiveDrops.set(strategyKey, drops);

        if (drops >= this.prmConfig.consecutiveDropThreshold) {
          const alert = this.createPRMAlert(
            'quality_regression',
            strategyKey,
            previous.score,
            current.score,
            `Quality regressed ${drops} consecutive times (drop ratio: ${dropRatio.toFixed(3)})`,
          );
          this.earlyStopped.add(strategyKey);
          this.publishPRMAlert(alert);
          return alert;
        }
      }
    } else {
      // Quality improved or stayed same — reset consecutive drop counter
      this.consecutiveDrops.set(strategyKey, 0);
    }

    // Check 3: Overall trend regression (compare recent window to earlier window)
    if (history.length >= 6) {
      const recentWindow = Math.min(3, Math.floor(history.length / 2));
      const recent = history.slice(-recentWindow);
      const prior = history.slice(0, history.length - recentWindow);
      const recentAvg = recent.reduce((s, e) => s + e.score, 0) / recent.length;
      const priorAvg = prior.reduce((s, e) => s + e.score, 0) / prior.length;
      if (priorAvg > 0 && recentAvg < priorAvg * (1 - this.threshold)) {
        const dropRatio = (priorAvg - recentAvg) / priorAvg;
        if (dropRatio >= this.threshold) {
          const alert = this.createPRMAlert(
            'quality_regression',
            strategyKey,
            priorAvg,
            recentAvg,
            `Quality trend regression: recent avg ${recentAvg.toFixed(3)} vs prior avg ${priorAvg.toFixed(3)} (drop: ${(dropRatio * 100).toFixed(1)}%)`,
          );
          this.publishPRMAlert(alert);
          return alert;
        }
      }
    }

    return null;
  }

  /**
   * Check if a strategy has been early-stopped (should not continue reflecting).
   */  isEarlyStopped(strategyKey: string): boolean {
    return this.earlyStopped.has(strategyKey);
  }

  /**
   * Clear the early-stopped flag for a strategy (e.g., when starting a new task).
   */
  clearEarlyStop(strategyKey: string): void {
    this.earlyStopped.delete(strategyKey);
    this.consecutiveDrops.delete(strategyKey);
  }

  /**
   * Get PRM score history for a strategy.
   */
  getPRMScoreHistory(strategyKey: string): PRMScoreEntry[] {
    return [...(this.prmScoreHistory.get(strategyKey) ?? [])];
  }

  /**
   * Get all PRM regression alerts.
   */
  getPRMAlerts(): PRMRegressionAlert[] {
    return [...this.prmAlerts];
  }

  /**
   * Get the current PRM config.
   */
  getPRMConfig(): PRMConfig {
    return { ...this.prmConfig };
  }

  /**
   * Update PRM config.
   */
  setPRMConfig(config: Partial<PRMConfig>): void {
    this.prmConfig = { ...this.prmConfig, ...config };
  }

  private createPRMAlert(
    type: PRMRegressionAlert['type'],
    strategyKey: string,
    previousQuality: number,
    currentQuality: number,
    message: string,
  ): PRMRegressionAlert {
    const [strategy, modelId] = strategyKey.split('::');
    const dropRatio = previousQuality > 0
      ? (previousQuality - currentQuality) / previousQuality
      : 0;
    const alert: PRMRegressionAlert = {
      type,
      strategy: strategy ?? strategyKey,
      modelId: modelId ?? 'unknown',
      previousQuality,
      currentQuality,
      dropRatio,
      consecutiveDrops: this.consecutiveDrops.get(strategyKey) ?? 0,
      message,
      triggeredAt: new Date().toISOString(),
    };
    this.prmAlerts.push(alert);
    if (this.prmAlerts.length > 100) this.prmAlerts.shift();
    return alert;
  }

  private publishPRMAlert(alert: PRMRegressionAlert): void {
    getGlobalLogger().warn('RegressionGate/PRM', alert.message, {
      type: alert.type,
      strategy: alert.strategy,
      dropRatio: alert.dropRatio.toFixed(3),
    });

    if (this.prmConfig.publishAlerts) {
      try {
        const bus = getMessageBus();
        bus.publish('system.alert', 'regression-gate-prm', {
          ...alert,
          type: 'prm_regression',
        });
      } catch {
        // best-effort
      }
    }
  }
}
