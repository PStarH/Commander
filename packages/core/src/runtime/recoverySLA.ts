// ─────────────────────────────────────────────────────────────────────────────
// RecoverySLA — Recovery Service Level Agreement monitoring
//
// Tracks three key SLOs for the reversibility subsystem:
// 1. recovery.time_to_recover — p95 time from crash to recovery
// 2. replay.accuracy — consistency rate of replay vs original run
// 3. compensation.success_rate — compensation success rate
//
// Also provides gradual rollout configuration for per-tenant recovery
// strategy selection.
// ─────────────────────────────────────────────────────────────────────────────

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type RecoveryStrategy = 'checkpoint' | 'replay' | 'hybrid';

export interface RecoverySLOConfig {
  /** p95 time-to-recover target in ms (default: 30000) */
  timeToRecoverP95Ms: number;
  /** Replay accuracy target (default: 0.99) */
  replayAccuracyTarget: number;
  /** Compensation success rate target (default: 0.95) */
  compensationSuccessRateTarget: number;
}

export interface RecoveryMetrics {
  timeToRecoverMs: number;
  strategy: RecoveryStrategy;
  replayAccuracy?: number;
  compensationSucceeded: boolean;
  runId: string;
  tenantId?: string;
  timestamp: string;
}

export interface SLAReport {
  timeToRecover: {
    p50: number;
    p95: number;
    p99: number;
    samples: number;
    target: number;
    meeting: boolean;
  };
  replayAccuracy: {
    avg: number;
    samples: number;
    target: number;
    meeting: boolean;
  };
  compensationSuccessRate: {
    rate: number;
    samples: number;
    target: number;
    meeting: boolean;
  };
  overall: 'healthy' | 'degraded' | 'critical';
}

// ============================================================================
// TenantConfig — gradual rollout
// ============================================================================

export interface TenantRecoveryConfig {
  tenantId: string;
  strategy: RecoveryStrategy;
  /** When this config was set */
  updatedAt: string;
  /** Optional: disable replay for safety (rollback to checkpoint-only) */
  disableReplay?: boolean;
}

const DEFAULT_TENANT_STRATEGY: RecoveryStrategy = 'hybrid';

// ============================================================================
// RecoverySLA
// ============================================================================

export class RecoverySLA {
  private metrics: RecoveryMetrics[] = [];
  private maxMetrics: number = 1000;
  private tenantConfigs: Map<string, TenantRecoveryConfig> = new Map();
  private config: RecoverySLOConfig;

  constructor(config?: Partial<RecoverySLOConfig>) {
    this.config = {
      timeToRecoverP95Ms: 30_000,
      replayAccuracyTarget: 0.99,
      compensationSuccessRateTarget: 0.95,
      ...config,
    };
  }

  /**
   * Record a recovery event for SLO tracking.
   */
  recordRecovery(metrics: RecoveryMetrics): void {
    this.metrics.push(metrics);
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }

    // Log SLO violations
    if (metrics.timeToRecoverMs > this.config.timeToRecoverP95Ms) {
      getGlobalLogger().warn('RecoverySLA', 'SLO violation: time_to_recover exceeded', {
        runId: metrics.runId,
        actual: metrics.timeToRecoverMs,
        target: this.config.timeToRecoverP95Ms,
      });
    }
  }

  /**
   * Generate an SLO compliance report.
   */
  getReport(): SLAReport {
    const recentMetrics = this.metrics.slice(-100);
    const times = recentMetrics.map((m) => m.timeToRecoverMs).sort((a, b) => a - b);

    const p50 = this.percentile(times, 50);
    const p95 = this.percentile(times, 95);
    const p99 = this.percentile(times, 99);

    const replayMetrics = recentMetrics.filter((m) => m.replayAccuracy !== undefined);
    const replayAccuracies = replayMetrics.map((m) => m.replayAccuracy!);
    const avgReplayAccuracy =
      replayAccuracies.length > 0
        ? replayAccuracies.reduce((s, v) => s + v, 0) / replayAccuracies.length
        : 1.0;

    const compensationMetrics = recentMetrics.filter((m) => m.compensationSucceeded !== undefined);
    const compensationSuccesses = compensationMetrics.filter((m) => m.compensationSucceeded).length;
    const compensationRate =
      compensationMetrics.length > 0 ? compensationSuccesses / compensationMetrics.length : 1.0;

    const ttrMeeting = p95 <= this.config.timeToRecoverP95Ms;
    const replayMeeting = avgReplayAccuracy >= this.config.replayAccuracyTarget;
    const compensationMeeting = compensationRate >= this.config.compensationSuccessRateTarget;

    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    const violations = [ttrMeeting, replayMeeting, compensationMeeting].filter((m) => !m).length;
    if (violations >= 2) overall = 'critical';
    else if (violations === 1) overall = 'degraded';

    return {
      timeToRecover: {
        p50,
        p95,
        p99,
        samples: times.length,
        target: this.config.timeToRecoverP95Ms,
        meeting: ttrMeeting,
      },
      replayAccuracy: {
        avg: avgReplayAccuracy,
        samples: replayAccuracies.length,
        target: this.config.replayAccuracyTarget,
        meeting: replayMeeting,
      },
      compensationSuccessRate: {
        rate: compensationRate,
        samples: compensationMetrics.length,
        target: this.config.compensationSuccessRateTarget,
        meeting: compensationMeeting,
      },
      overall,
    };
  }

  // ── Tenant config (gradual rollout) ──────────────────────────────────

  /**
   * Set the recovery strategy for a tenant. This enables gradual rollout
   * of event replay recovery — new tenants default to 'hybrid', existing
   * tenants can be migrated one at a time.
   */
  setTenantStrategy(tenantId: string, strategy: RecoveryStrategy): void {
    this.tenantConfigs.set(tenantId, {
      tenantId,
      strategy,
      updatedAt: new Date().toISOString(),
    });
    getGlobalLogger().info('RecoverySLA', 'Tenant recovery strategy updated', {
      tenantId,
      strategy,
    });
  }

  /**
   * Get the recovery strategy for a tenant. Returns 'hybrid' by default
   * for new tenants (prefer replay, degrade to checkpoint).
   */
  getTenantStrategy(tenantId?: string): RecoveryStrategy {
    if (!tenantId) return DEFAULT_TENANT_STRATEGY;
    return this.tenantConfigs.get(tenantId)?.strategy ?? DEFAULT_TENANT_STRATEGY;
  }

  /**
   * Instant rollback: disable replay for a tenant, falling back to
   * checkpoint-only recovery. Use when replay is causing issues.
   */
  disableReplayForTenant(tenantId: string): void {
    const config = this.tenantConfigs.get(tenantId);
    this.tenantConfigs.set(tenantId, {
      tenantId,
      strategy: 'checkpoint',
      updatedAt: new Date().toISOString(),
      disableReplay: true,
    });
    getGlobalLogger().warn(
      'RecoverySLA',
      'Replay disabled for tenant — rollback to checkpoint-only',
      {
        tenantId,
        previousStrategy: config?.strategy,
      },
    );
  }

  /**
   * List all tenant configs for admin/monitoring.
   */
  listTenantConfigs(): TenantRecoveryConfig[] {
    return [...this.tenantConfigs.values()];
  }

  // ── Private ──────────────────────────────────────────────────────────

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalRecoverySLA: RecoverySLA | null = null;

export function getGlobalRecoverySLA(): RecoverySLA {
  if (!globalRecoverySLA) {
    globalRecoverySLA = new RecoverySLA();
  }
  return globalRecoverySLA;
}
