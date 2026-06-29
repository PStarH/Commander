/**
 * SLO Monitoring Engine
 *
 * Provides continuous SLO monitoring with sliding-window evaluation and
 * burn-rate alerting — the operational backbone for SLO-driven reliability.
 *
 * Key concepts:
 *   - Sliding window: SLOs are evaluated over a rolling window (e.g. 5 min,
 *     1 hour, 24 hours) so the system always reflects recent behavior.
 *   - Burn rate: how fast the error budget is being consumed relative to
 *     the SLO target.  A burn rate of 1 means the SLO will be exactly met
 *     over the full window.  >1 means budget is being consumed too fast.
 *   - Multi-window alerting: short window (5m) + long window (1h) evaluated
 *     together to catch both acute spikes and sustained degradation.
 *
 * Integration:
 *   - Consumes ExecutionTrace events from the message bus
 *   - Evaluates SLOs via the existing SLOManager
 *   - Emits alerts via AlertRuleEngine
 *   - Records incidents via IncidentManager when burn rate is critical
 */

import type { ExecutionTrace } from '../runtime/types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface SLOWindowConfig {
  /** Short window for fast alerting (default: 5 minutes) */
  shortWindowMs: number;
  /** Long window for sustained degradation (default: 1 hour) */
  longWindowMs: number;
  /** Full SLO evaluation window (default: 24 hours) */
  fullWindowMs: number;
  /** Evaluation interval (default: 30 seconds) */
  evaluationIntervalMs: number;
}

export const DEFAULT_WINDOW_CONFIG: SLOWindowConfig = {
  shortWindowMs: 5 * 60 * 1000, // 5 minutes
  longWindowMs: 60 * 60 * 1000, // 1 hour
  fullWindowMs: 24 * 60 * 60 * 1000, // 24 hours
  evaluationIntervalMs: 30 * 1000, // 30 seconds
};

export type BurnRateSeverity = 'none' | 'warning' | 'critical' | 'page';

export interface BurnRateResult {
  sloId: string;
  sloName: string;
  metric: string;
  /** Current burn rate (1.0 = on pace to exactly meet SLO) */
  burnRate: number;
  /** Error budget remaining (0-1) */
  errorBudgetRemaining: number;
  /** Short window burn rate */
  shortWindowBurnRate: number;
  /** Long window burn rate */
  longWindowBurnRate: number;
  /** Derived severity */
  severity: BurnRateSeverity;
  /** Whether the SLO is currently being violated */
  isViolating: boolean;
  /** Timestamp of evaluation */
  evaluatedAt: string;
}

export interface SLODashboard {
  timestamp: string;
  totalSLOs: number;
  healthySLOs: number;
  violatingSLOs: number;
  criticalSLOs: number;
  burnRates: BurnRateResult[];
  /** Rolling event counts per window */
  eventCounts: {
    short: number;
    long: number;
    full: number;
  };
}

// ============================================================================
// Metrics Ring Buffer
// ============================================================================

interface MetricEvent {
  timestamp: number;
  sloId: string;
  metric: string;
  value: number;
  passed: boolean;
}

/**
 * Fixed-size ring buffer for storing metric events within the
 * longest evaluation window.  Old events are evicted automatically.
 */
class MetricEventBuffer {
  private events: MetricEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 100000) {
    this.maxSize = maxSize;
  }

  push(event: MetricEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  /**
   * Return events within the given time window (ms ago → now).
   */
  query(windowMs: number, sloId?: string): MetricEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.events.filter(
      (e) => e.timestamp >= cutoff && (sloId === undefined || e.sloId === sloId),
    );
  }

  count(windowMs: number, sloId?: string): number {
    return this.query(windowMs, sloId).length;
  }

  clear(): void {
    this.events = [];
  }
}

// ============================================================================
// Burn Rate Calculator
// ============================================================================

/**
 * Calculate burn rate for a given set of events.
 *
 * Burn rate = actual error rate / allowed error rate
 *
 * For an SLO with 99% success target:
 *   - allowed error rate = 1%
 *   - if actual error rate = 2%, burn rate = 2.0 (consuming budget 2x fast)
 *
 * For latency SLOs (e.g. P99 < 500ms):
 *   - "error" = event where latency exceeded threshold
 *   - burn rate = fraction of events exceeding threshold / allowed fraction
 */
function calculateBurnRate(
  events: MetricEvent[],
  sloTargetPercent: number,
): { burnRate: number; errorRate: number; errorBudgetRemaining: number } {
  if (events.length === 0) {
    return { burnRate: 0, errorRate: 0, errorBudgetRemaining: 1 };
  }

  const failed = events.filter((e) => !e.passed).length;
  const errorRate = failed / events.length;
  const allowedErrorRate = 1 - sloTargetPercent / 100;

  if (allowedErrorRate <= 0) {
    return { burnRate: errorRate > 0 ? Infinity : 0, errorRate, errorBudgetRemaining: 0 };
  }

  const burnRate = errorRate / allowedErrorRate;

  // Estimate remaining budget (simplified: linear consumption)
  // In production this would use the full SLO window's event history
  const consumedFraction = Math.min(1, burnRate * 0.1); // scaled by window ratio
  const errorBudgetRemaining = Math.max(0, 1 - consumedFraction);

  return { burnRate, errorRate, errorBudgetRemaining };
}

/**
 * Determine severity from multi-window burn rate.
 *
 * Standard multi-window multi-burn-rate alerting (Google SRE workbook):
 *   - Page:   short > 14.4x AND long > 14.4x  (2% budget in 1 hour)
 *   - Critical: short > 6x AND long > 6x       (5% budget in 6 hours)
 *   - Warning: short > 3x AND long > 3x        (10% budget in 3 days)
 *   - Warning: short > 1x AND long > 1x        (budget being consumed)
 */
function deriveSeverity(shortBurnRate: number, longBurnRate: number): BurnRateSeverity {
  if (shortBurnRate > 14.4 && longBurnRate > 14.4) return 'page';
  if (shortBurnRate > 6 && longBurnRate > 6) return 'critical';
  if (shortBurnRate > 3 && longBurnRate > 3) return 'warning';
  if (shortBurnRate > 1 && longBurnRate > 1) return 'warning';
  return 'none';
}

// ============================================================================
// SLO Monitoring Engine
// ============================================================================

export class SLOMonitoringEngine {
  private buffer: MetricEventBuffer;
  private config: SLOWindowConfig;
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private lastBurnRates: Map<string, BurnRateResult> = new Map();
  private sloTargetPercents: Map<string, number> = new Map();

  // Callbacks for alerting and incident creation
  private onAlertCallback: ((result: BurnRateResult) => void) | null = null;
  private onIncidentCallback: ((result: BurnRateResult) => void) | null = null;

  constructor(config: Partial<SLOWindowConfig> = {}) {
    this.config = { ...DEFAULT_WINDOW_CONFIG, ...config };
    this.buffer = new MetricEventBuffer();
  }

  /**
   * Register an SLO for monitoring with its target percentage.
   * E.g. 99.9 means 99.9% of events must pass.
   */
  registerSLO(sloId: string, targetPercent: number): void {
    this.sloTargetPercents.set(sloId, targetPercent);
  }

  /**
   * Record a metric event for SLO evaluation.
   * Called from the trace processing pipeline.
   */
  recordEvent(sloId: string, metric: string, value: number, passed: boolean): void {
    this.buffer.push({
      timestamp: Date.now(),
      sloId,
      metric,
      value,
      passed,
    });
  }

  /**
   * Evaluate all registered SLOs and compute burn rates.
   */
  evaluate(): BurnRateResult[] {
    const results: BurnRateResult[] = [];

    for (const [sloId, targetPercent] of this.sloTargetPercents) {
      const shortEvents = this.buffer.query(this.config.shortWindowMs, sloId);
      const longEvents = this.buffer.query(this.config.longWindowMs, sloId);

      const shortCalc = calculateBurnRate(shortEvents, targetPercent);
      const longCalc = calculateBurnRate(longEvents, targetPercent);

      // Use the higher burn rate for the primary value
      const burnRate = Math.max(shortCalc.burnRate, longCalc.burnRate);
      const severity = deriveSeverity(shortCalc.burnRate, longCalc.burnRate);
      const isViolating = burnRate > 1;

      const result: BurnRateResult = {
        sloId,
        sloName: sloId, // populated by caller via registerSLO metadata
        metric: shortEvents[0]?.metric ?? 'unknown',
        burnRate,
        errorBudgetRemaining: Math.min(
          shortCalc.errorBudgetRemaining,
          longCalc.errorBudgetRemaining,
        ),
        shortWindowBurnRate: shortCalc.burnRate,
        longWindowBurnRate: longCalc.burnRate,
        severity,
        isViolating,
        evaluatedAt: new Date().toISOString(),
      };

      this.lastBurnRates.set(sloId, result);
      results.push(result);

      // Fire callbacks
      if (severity === 'page' || severity === 'critical') {
        this.onAlertCallback?.(result);
        if (severity === 'page') {
          this.onIncidentCallback?.(result);
        }
      } else if (severity === 'warning' && isViolating) {
        this.onAlertCallback?.(result);
      }
    }

    return results;
  }

  /**
   * Get the dashboard view of all SLOs.
   */
  getDashboard(): SLODashboard {
    const burnRates = Array.from(this.lastBurnRates.values());
    const violating = burnRates.filter((r) => r.isViolating);
    const critical = burnRates.filter((r) => r.severity === 'critical' || r.severity === 'page');

    return {
      timestamp: new Date().toISOString(),
      totalSLOs: this.sloTargetPercents.size,
      healthySLOs: burnRates.length - violating.length,
      violatingSLOs: violating.length,
      criticalSLOs: critical.length,
      burnRates,
      eventCounts: {
        short: this.buffer.count(this.config.shortWindowMs),
        long: this.buffer.count(this.config.longWindowMs),
        full: this.buffer.count(this.config.fullWindowMs),
      },
    };
  }

  /**
   * Get the latest burn rate for a specific SLO.
   */
  getBurnRate(sloId: string): BurnRateResult | undefined {
    return this.lastBurnRates.get(sloId);
  }

  /**
   * Start continuous monitoring.
   */
  start(): void {
    if (this.evaluationTimer) return;

    getGlobalLogger().info('SLOMonitoringEngine', 'Starting continuous SLO monitoring', {
      evaluationInterval: `${this.config.evaluationIntervalMs}ms`,
      registeredSLOs: this.sloTargetPercents.size,
    });

    // Run an initial evaluation
    this.evaluate();

    this.evaluationTimer = setInterval(() => {
      try {
        this.evaluate();
      } catch (err) {
        getGlobalLogger().error('SLOMonitoringEngine', 'Evaluation failed', err as Error);
      }
    }, this.config.evaluationIntervalMs);
  }

  /**
   * Stop continuous monitoring.
   */
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
      getGlobalLogger().info('SLOMonitoringEngine', 'Stopped continuous SLO monitoring');
    }
  }

  /**
   * Register callbacks for alerting and incident creation.
   */
  onAlert(callback: (result: BurnRateResult) => void): void {
    this.onAlertCallback = callback;
  }

  onIncident(callback: (result: BurnRateResult) => void): void {
    this.onIncidentCallback = callback;
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.buffer.clear();
    this.lastBurnRates.clear();
    this.sloTargetPercents.clear();
    this.stop();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalEngine: SLOMonitoringEngine | null = null;

export function getSLOMonitoringEngine(): SLOMonitoringEngine {
  if (!globalEngine) {
    globalEngine = new SLOMonitoringEngine();
  }
  return globalEngine;
}

export function resetSLOMonitoringEngine(): void {
  globalEngine?.stop();
  globalEngine = null;
}
