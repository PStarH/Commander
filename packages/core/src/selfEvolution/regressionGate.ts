import type { ExecutionExperience, RegressionEvent } from '../runtime/types';
import { getMessageBus } from '../runtime/messageBus';
import { getMetricsCollector } from '../runtime/metricsCollector';

export class RegressionGate {
  private regressionEvents: RegressionEvent[] = [];
  /** Rolling success rate history per strategy: Map<strategyName, number[]> */
  private successRateHistory: Map<string, number[]> = new Map();
  private threshold: number;

  static readonly MAX_SUCCESS_RATE_ENTRIES = 200;

  constructor(threshold = 0.15) {
    this.threshold = threshold;
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
        try {
          // @ts-ignore — best-effort metric, may not be on collector yet
          getMetricsCollector().recordRegressionActiveCount(this.regressionEvents.length);
        } catch {
          /* best-effort */
        }

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
}
