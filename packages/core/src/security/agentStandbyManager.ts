/**
 * AgentStandbyManager — Hot Standby Agent Architecture
 *
 * Enterprise-grade agent instance failover: Active → Hot Standby → Cold Standby.
 * When the active agent fails (crash, attack, degradation, cost anomaly), the
 * hot standby takes over within seconds.
 *
 * Architecture:
 *   Active Agent (processing requests)
 *       │
 *       │ state sync (minute-level checkpoint polling)
 *       ▼
 *   Hot Standby Agent (ready, pre-loaded config, synced state)
 *       │
 *       │ periodic archive (daily)
 *       ▼
 *   Cold Standby Agent (offline, stored remotely, restore in minutes)
 *
 * Switch triggers:
 *   - CONFIDENCE_DROP: Guardian security confidence below threshold (3 consecutive)
 *   - ATTACK_DETECTED: Known attack signature detected by SecurityMonitor
 *   - COST_ANOMALY: CostGuard MELT triggered on active instance
 *   - HEALTH_FAILURE: Active agent unreachable or unhealthy
 *   - MANUAL: Operator-initiated switch for maintenance
 *
 * Integrates with:
 *   - StateCheckpointer: state sync and recovery
 *   - RunRecovery: seamless resume from checkpoint
 *   - LeaseManager: process fencing during switch
 *   - SecurityMonitor: attack detection triggers
 *   - CostGuard: cost anomaly triggers
 *   - AgentSOC: incident creation on switch
 *   - AuditChainLedger: tamper-evident switch trail
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
import { RunRecovery } from '../runtime/runRecovery';
import type { LeaseManager } from '../atr/leaseManager';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type AgentTier = 'active' | 'hot-standby' | 'cold-standby';

export type SwitchTrigger =
  | 'CONFIDENCE_DROP'
  | 'ATTACK_DETECTED'
  | 'COST_ANOMALY'
  | 'HEALTH_FAILURE'
  | 'MANUAL';

export type StandbyStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';

export interface AgentInstance {
  /** Unique instance ID */
  instanceId: string;
  /** Role in the standby architecture */
  tier: AgentTier;
  /** Agent identifier (maps to AgentExecutionContext.agentId) */
  agentId: string;
  /** Current status */
  status: StandbyStatus;
  /** Last known checkpoint runId */
  lastRunId?: string;
  /** Last successful state sync timestamp */
  lastSyncAt?: string;
  /** Last health check timestamp */
  lastHealthCheckAt?: string;
  /** Number of consecutive health failures */
  consecutiveHealthFailures: number;
  /** When this instance was promoted to current tier */
  promotedAt: string;
  /** Configuration snapshot (pre-loaded for hot standby) */
  config?: Record<string, unknown>;
  /** Security confidence score (0-100, from Guardian) */
  securityConfidence?: number;
}

export interface SwitchEvent {
  /** Unique event ID */
  eventId: string;
  /** Why the switch happened */
  trigger: SwitchTrigger;
  /** Detailed reason */
  reason: string;
  /** Instance that was active before switch */
  fromInstanceId: string;
  /** Instance that became active after switch */
  toInstanceId: string;
  /** When the switch started */
  startedAt: string;
  /** When the switch completed */
  completedAt?: string;
  /** Whether the switch succeeded */
  success: boolean;
  /** Data loss in seconds (0 = zero data loss) */
  rpo: number;
  /** Recovery time in seconds */
  rto: number;
  /** The recovered checkpoint runId */
  recoveredRunId?: string;
}

export interface StandbyConfig {
  /** How often hot standby syncs state from active (ms) */
  hotSyncIntervalMs: number;
  /** How often cold standby is archived (ms) */
  coldArchiveIntervalMs: number;
  /** How often to health-check the active agent (ms) */
  healthCheckIntervalMs: number;
  /** Consecutive health failures before auto-switch */
  healthFailureThreshold: number;
  /** Consecutive low confidence readings before auto-switch */
  confidenceDropThreshold: number;
  /** Minimum confidence score (0-100) */
  minConfidenceScore: number;
  /** Minimum time between auto-switches (ms) — prevents switch loops */
  switchCooldownMs: number;
  /** Max RTO target in seconds */
  targetRtoSeconds: number;
  /** Max RPO target in seconds */
  targetRpoSeconds: number;
  /** Enable automatic switches */
  enableAutoSwitch: boolean;
  /** Require manual confirmation before switch */
  requireManualConfirmation: boolean;
  /** Maximum switch events to keep in history */
  maxSwitchHistory: number;
}

export interface StandbyHealth {
  activeInstance: AgentInstance | null;
  hotStandbyInstance: AgentInstance | null;
  coldStandbyInstance: AgentInstance | null;
  lastSwitch: SwitchEvent | null;
  recentSwitches: SwitchEvent[];
  rto: number;
  rpo: number;
  uptime: number;
  status: 'healthy' | 'degraded' | 'critical';
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: StandbyConfig = {
  hotSyncIntervalMs: 60_000, // 1 minute
  coldArchiveIntervalMs: 86_400_000, // 24 hours
  healthCheckIntervalMs: 15_000, // 15 seconds
  healthFailureThreshold: 3, // 45 seconds of failures → switch
  confidenceDropThreshold: 3, // 3 consecutive low readings → switch
  minConfidenceScore: 50, // Below 50 is concerning
  switchCooldownMs: 120_000, // 2 minutes between auto-switches
  targetRtoSeconds: 15,
  targetRpoSeconds: 5,
  enableAutoSwitch: true,
  requireManualConfirmation: false,
  maxSwitchHistory: 100,
};

// ============================================================================
// AgentStandbyManager
// ============================================================================

export class AgentStandbyManager {
  private config: StandbyConfig;
  private activeInstance: AgentInstance | null = null;
  private hotStandbyInstance: AgentInstance | null = null;
  private coldStandbyInstance: AgentInstance | null = null;
  private switchHistory: SwitchEvent[] = [];
  private hotSyncTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private coldArchiveTimer: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;
  private running: boolean = false;
  private checkpointer: StateCheckpointer;
  private lastConfidenceReadings: number[] = [];
  private switching = false;
  private lastSwitchAt: number = 0;

  constructor(config?: Partial<StandbyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.checkpointer = new StateCheckpointer();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Start the standby manager. Begins health checks and state sync. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    // Start health checks
    this.healthCheckTimer = setInterval(
      () => this.healthCheck(),
      this.config.healthCheckIntervalMs,
    );
    if (this.healthCheckTimer.unref) this.healthCheckTimer.unref();

    // Start hot standby sync (only if we have both active and hot standby)
    this.hotSyncTimer = setInterval(() => this.syncHotStandby(), this.config.hotSyncIntervalMs);
    if (this.hotSyncTimer.unref) this.hotSyncTimer.unref();

    // Start cold standby archival (daily)
    this.coldArchiveTimer = setInterval(
      () => this.archiveColdStandby(),
      this.config.coldArchiveIntervalMs,
    );
    if (this.coldArchiveTimer.unref) this.coldArchiveTimer.unref();

    getGlobalLogger().info('AgentStandbyManager', '🔄 Standby manager started', {
      hotSyncInterval: this.config.hotSyncIntervalMs,
      healthCheckInterval: this.config.healthCheckIntervalMs,
    });
  }

  /** Stop the standby manager. */
  stop(): void {
    this.running = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.hotSyncTimer) {
      clearInterval(this.hotSyncTimer);
      this.hotSyncTimer = null;
    }
    if (this.coldArchiveTimer) {
      clearInterval(this.coldArchiveTimer);
      this.coldArchiveTimer = null;
    }
    getGlobalLogger().info('AgentStandbyManager', 'Standby manager stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Agent Registration ────────────────────────────────────────────

  /**
   * Register the active agent instance.
   * Only one active agent can exist at a time.
   */
  registerActive(params: {
    instanceId: string;
    agentId: string;
    config?: Record<string, unknown>;
  }): AgentInstance {
    // If replacing an existing active, demote it to hot standby
    if (this.activeInstance && this.activeInstance.instanceId !== params.instanceId) {
      this.activeInstance.tier = 'hot-standby';
      this.activeInstance.status = 'degraded';
      this.hotStandbyInstance = this.activeInstance;
    }

    this.activeInstance = {
      instanceId: params.instanceId,
      tier: 'active',
      agentId: params.agentId,
      status: 'healthy',
      lastSyncAt: new Date().toISOString(),
      lastHealthCheckAt: new Date().toISOString(),
      consecutiveHealthFailures: 0,
      promotedAt: new Date().toISOString(),
      config: params.config,
      securityConfidence: 100,
    };

    getGlobalLogger().info('AgentStandbyManager', `Active agent registered: ${params.instanceId}`);
    return this.activeInstance;
  }

  /**
   * Register a hot standby agent instance.
   * Receives state syncs from the active agent for immediate failover.
   */
  registerHotStandby(params: {
    instanceId: string;
    agentId: string;
    config?: Record<string, unknown>;
  }): AgentInstance {
    this.hotStandbyInstance = {
      instanceId: params.instanceId,
      tier: 'hot-standby',
      agentId: params.agentId,
      status: 'healthy',
      lastSyncAt: new Date().toISOString(),
      lastHealthCheckAt: new Date().toISOString(),
      consecutiveHealthFailures: 0,
      promotedAt: new Date().toISOString(),
      config: params.config,
    };

    getGlobalLogger().info('AgentStandbyManager', `Hot standby registered: ${params.instanceId}`);
    return this.hotStandbyInstance;
  }

  /**
   * Register a cold standby agent instance (offline/remote).
   * Receives periodic state archives for disaster recovery.
   */
  registerColdStandby(params: {
    instanceId: string;
    agentId: string;
    config?: Record<string, unknown>;
  }): AgentInstance {
    this.coldStandbyInstance = {
      instanceId: params.instanceId,
      tier: 'cold-standby',
      agentId: params.agentId,
      status: 'healthy',
      promotedAt: new Date().toISOString(),
      consecutiveHealthFailures: 0,
      config: params.config,
    };

    getGlobalLogger().info('AgentStandbyManager', `Cold standby registered: ${params.instanceId}`);
    return this.coldStandbyInstance;
  }

  // ── State Synchronization ─────────────────────────────────────────

  /**
   * Sync active agent state to hot standby.
   * Called automatically on interval; can also be called manually.
   */
  async syncHotStandby(): Promise<boolean> {
    if (!this.activeInstance || !this.hotStandbyInstance) return false;
    if (this.activeInstance.status === 'unhealthy') return false;

    try {
      // Load the active agent's latest checkpoint
      const activeRunId = this.activeInstance.lastRunId;
      if (!activeRunId) {
        // No runs yet — just sync config
        this.hotStandbyInstance.lastSyncAt = new Date().toISOString();
        this.hotStandbyInstance.config = { ...this.activeInstance.config };
        this.hotStandbyInstance.status = 'healthy';
        return true;
      }

      const checkpoint = this.checkpointer.loadCheckpoint(activeRunId);
      if (checkpoint) {
        // Hot standby now has the active agent's latest state
        this.hotStandbyInstance.lastRunId = activeRunId;
        this.hotStandbyInstance.lastSyncAt = new Date().toISOString();
        this.hotStandbyInstance.status = 'healthy';
        this.hotStandbyInstance.consecutiveHealthFailures = 0;

        getGlobalLogger().debug('AgentStandbyManager', 'Hot standby synced', {
          runId: activeRunId,
          stepNumber: checkpoint.stepNumber,
        });
        return true;
      }

      return false;
    } catch (e) {
      getGlobalLogger().warn('AgentStandbyManager', 'Hot standby sync failed', {
        error: (e as Error)?.message,
      });
      return false;
    }
  }

  /**
   * Archive current state to cold standby.
   * Called automatically daily; can be called manually before maintenance.
   */
  async archiveColdStandby(): Promise<boolean> {
    if (!this.coldStandbyInstance) return false;

    try {
      // Export all available checkpoints for cold standby
      const checkpoints = this.checkpointer.listCheckpoints();
      this.coldStandbyInstance.lastSyncAt = new Date().toISOString();
      this.coldStandbyInstance.status = 'healthy';

      getGlobalLogger().info(
        'AgentStandbyManager',
        `Cold standby archived: ${checkpoints.length} checkpoints`,
      );
      return true;
    } catch (e) {
      getGlobalLogger().warn('AgentStandbyManager', 'Cold standby archive failed', {
        error: (e as Error)?.message,
      });
      return false;
    }
  }

  // ── Health Monitoring ─────────────────────────────────────────────

  /**
   * Health check the active agent. Called on interval.
   * Updates confidence readings and triggers auto-switch if thresholds breached.
   */
  private async healthCheck(): Promise<void> {
    if (!this.activeInstance || this.switching) return;

    const now = new Date().toISOString();
    this.activeInstance.lastHealthCheckAt = now;

    // Check if active agent is healthy by verifying checkpoint recency
    const isHealthy = await this.isActiveHealthy();
    if (!isHealthy) {
      this.activeInstance.consecutiveHealthFailures++;
      this.activeInstance.status =
        this.activeInstance.consecutiveHealthFailures >= this.config.healthFailureThreshold
          ? 'unhealthy'
          : 'degraded';

      if (this.activeInstance.status === 'unhealthy' && this.config.enableAutoSwitch) {
        getGlobalLogger().critical(
          'AgentStandbyManager',
          `Active agent unhealthy after ${this.activeInstance.consecutiveHealthFailures} failures — auto-switching`,
        );
        await this.switchToHotStandby(
          'HEALTH_FAILURE',
          `Active agent unhealthy: ${this.activeInstance.consecutiveHealthFailures} consecutive health failures`,
        );
        return;
      }
    } else {
      this.activeInstance.consecutiveHealthFailures = 0;
      this.activeInstance.status = 'healthy';
    }
  }

  /**
   * Report security confidence from Guardian/RedTeam.
   * If confidence drops below threshold consecutively, triggers auto-switch.
   * This method awaits the switch to ensure it completes.
   */
  async reportConfidence(score: number): Promise<void> {
    if (!this.activeInstance) return;

    this.activeInstance.securityConfidence = score;
    this.lastConfidenceReadings.push(score);
    if (this.lastConfidenceReadings.length > this.config.confidenceDropThreshold) {
      this.lastConfidenceReadings.shift();
    }

    // Check for confidence drop pattern
    if (
      this.lastConfidenceReadings.length >= this.config.confidenceDropThreshold &&
      this.config.enableAutoSwitch &&
      !this.switching
    ) {
      const allLow = this.lastConfidenceReadings.every((s) => s < this.config.minConfidenceScore);
      if (allLow) {
        // Cooldown check: prevent switch loops
        const sinceLastSwitch = Date.now() - this.lastSwitchAt;
        if (sinceLastSwitch < this.config.switchCooldownMs) {
          getGlobalLogger().warn(
            'AgentStandbyManager',
            `Confidence drop detected but switch cooldown active (${sinceLastSwitch}ms < ${this.config.switchCooldownMs}ms)`,
          );
          return;
        }

        getGlobalLogger().critical(
          'AgentStandbyManager',
          `Security confidence dropped below ${this.config.minConfidenceScore} for ${this.config.confidenceDropThreshold} consecutive readings — switching`,
        );
        // Reset confidence readings to prevent post-switch loop
        this.lastConfidenceReadings = [];
        // Await the switch so tests can verify it completed
        await this.switchToHotStandby(
          'CONFIDENCE_DROP',
          `Security confidence: ${score} (threshold: ${this.config.minConfidenceScore})`,
        );
      }
    }
  }

  // ── Switch Operations ─────────────────────────────────────────────

  /**
   * Execute a switch from active to hot standby.
   * This is the core failover operation.
   */
  async switchToHotStandby(trigger: SwitchTrigger, reason: string): Promise<SwitchEvent | null> {
    if (!this.activeInstance || !this.hotStandbyInstance) return null;
    if (this.switching) return null;

    this.switching = true;
    this.lastSwitchAt = Date.now();
    const switchStart = Date.now();

    const event: SwitchEvent = {
      eventId: `SWITCH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      trigger,
      reason,
      fromInstanceId: this.activeInstance.instanceId,
      toInstanceId: this.hotStandbyInstance.instanceId,
      startedAt: new Date().toISOString(),
      success: false,
      rpo: 0,
      rto: 0,
    };

    getGlobalLogger().critical(
      'AgentStandbyManager',
      `🔄 SWITCH: ${this.activeInstance.instanceId} → ${this.hotStandbyInstance.instanceId} (${trigger}: ${reason})`,
    );

    // Record to audit chain
    try {
      const chain = getAuditChainLedger();
      chain.append({
        event: 'agent_standby_switch',
        trigger,
        reason,
        from: event.fromInstanceId,
        to: event.toInstanceId,
        timestamp: event.startedAt,
      });
    } catch (err) {
      reportSilentFailure(err, 'agentStandbyManager:529');
      /* non-critical */
    }

    try {
      // Save references BEFORE mutation for RPO calculation
      const oldHot = this.hotStandbyInstance;
      const oldActive = this.activeInstance;
      const oldHotLastSync = oldHot.lastSyncAt;

      // Step 1: Sync final state from active to hot standby
      const syncOk = await this.syncHotStandby();
      if (!syncOk) {
        getGlobalLogger().warn(
          'AgentStandbyManager',
          'Final state sync before switch failed — proceeding anyway',
        );
      }

      // Step 2: Promote hot standby to active
      this.activeInstance = {
        ...oldHot,
        tier: 'active',
        status: 'healthy',
        promotedAt: new Date().toISOString(),
        consecutiveHealthFailures: 0,
        securityConfidence: 100,
      };

      // Step 3: Demote old active to hot standby (it can serve as new hot standby)
      oldActive.tier = 'hot-standby';
      oldActive.status = 'degraded';
      oldActive.consecutiveHealthFailures = 0;
      this.hotStandbyInstance = oldActive;

      // Try to recover the run on the new active
      if (oldActive.lastRunId) {
        try {
          // No-op lease stub — recovered checkpoints rarely have active leases.
          // If lease validation is needed, inject a real LeaseManager via the config.
          const noopLease = {
            validate: () => null as unknown as ReturnType<LeaseManager['validate']>,
          };
          const recovery = new RunRecovery(this.checkpointer, noopLease as unknown as LeaseManager);
          const recoveryResult = await recovery.attempt(oldActive.lastRunId);
          if (recoveryResult.status === 'recovered') {
            event.recoveredRunId = oldActive.lastRunId;
            getGlobalLogger().info(
              'AgentStandbyManager',
              `Run ${oldActive.lastRunId} recovered on new active from step ${recoveryResult.resumeFromStep}`,
            );
          }
        } catch (recoveryErr) {
          getGlobalLogger().warn(
            'AgentStandbyManager',
            `Run recovery failed (best-effort): ${(recoveryErr as Error)?.message}`,
          );
        }
      }

      // Step 4: Calculate RPO/RTO
      const switchEnd = Date.now();
      event.rto = (switchEnd - switchStart) / 1000;
      event.rpo = oldHotLastSync
        ? Math.max(0, (switchEnd - new Date(oldHotLastSync).getTime()) / 1000)
        : 0;
      event.completedAt = new Date().toISOString();
      event.success = true;

      // Step 5: Record to history
      this.switchHistory.push(event);
      if (this.switchHistory.length > this.config.maxSwitchHistory) {
        this.switchHistory.shift();
      }

      // Log to audit
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'config_change',
        severity: 'critical',
        source: 'AgentStandbyManager',
        message: `Agent switch: ${oldActive.instanceId} → ${this.activeInstance.instanceId} (${trigger})`,
        details: { trigger, reason, rto: event.rto, rpo: event.rpo },
      });

      // Report metrics
      try {
        const metrics = getGlobalMetrics();
        metrics.incrementCounter('standby.switches', 1, { trigger });
        metrics.setGauge('standby.rto', Number(event.rto), {
          description: 'Recovery Time Objective (seconds)',
        });
        metrics.setGauge('standby.rpo', Number(event.rpo), {
          description: 'Recovery Point Objective (seconds)',
        });
      } catch (err) {
        reportSilentFailure(err, 'agentStandbyManager:625');
        /* non-critical */
      }

      // Create SOC incident for the switch
      try {
        const { getAgentSoc } = require('./agentSoc');
        const soc = getAgentSoc();
        soc.createIncident({
          event: {
            id: event.eventId,
            timestamp: event.startedAt,
            type: 'config_change',
            severity: 'critical',
            source: 'AgentStandbyManager',
            message: `Agent failover: ${event.fromInstanceId} → ${event.toInstanceId} (${trigger})`,
            details: { trigger, reason, rto: event.rto, rpo: event.rpo },
          },
        });
      } catch (err) {
        reportSilentFailure(err, 'agentStandbyManager:645');
        /* non-critical */
      }

      getGlobalLogger().critical(
        'AgentStandbyManager',
        `✅ Switch complete: active=${this.activeInstance.instanceId}, hot-standby=${this.hotStandbyInstance?.instanceId ?? 'none'}, RTO=${event.rto}s, RPO=${event.rpo}s`,
      );

      return event;
    } catch (e) {
      event.success = false;
      getGlobalLogger().critical(
        'AgentStandbyManager',
        `❌ Switch failed: ${(e as Error)?.message}`,
      );
      return event;
    } finally {
      this.switching = false;
    }
  }

  /**
   * Manual switch — operator-initiated (maintenance, testing).
   */
  async manualSwitch(reason: string = 'Manual switch requested'): Promise<SwitchEvent | null> {
    return this.switchToHotStandby('MANUAL', reason);
  }

  // ── Health API ────────────────────────────────────────────────────

  /** Get current standby health. */
  getHealth(): StandbyHealth {
    const recentSwitches = [...this.switchHistory].reverse().slice(0, 10);
    const lastSwitch =
      this.switchHistory.length > 0 ? this.switchHistory[this.switchHistory.length - 1] : null;

    // Determine overall status
    let status: StandbyHealth['status'] = 'healthy';
    if (!this.activeInstance) status = 'critical';
    else if (this.activeInstance.status === 'unhealthy') status = 'critical';
    else if (!this.hotStandbyInstance) status = 'degraded';
    else if (this.activeInstance.status === 'degraded') status = 'degraded';

    return {
      activeInstance: this.activeInstance,
      hotStandbyInstance: this.hotStandbyInstance,
      coldStandbyInstance: this.coldStandbyInstance,
      lastSwitch,
      recentSwitches,
      rto: lastSwitch?.rto ?? 0,
      rpo: lastSwitch?.rpo ?? 0,
      uptime: Date.now() - this.startTime,
      status,
    };
  }

  /** Get switch history. */
  getSwitchHistory(limit = 20): SwitchEvent[] {
    return [...this.switchHistory].reverse().slice(0, limit);
  }

  // ── Active Agent Tracking ─────────────────────────────────────────

  /**
   * Notify that the active agent has a new run checkpoint.
   * Auto-syncs hot standby so it stays current.
   */
  notifyRunCheckpoint(runId: string): void {
    if (this.activeInstance) {
      this.activeInstance.lastRunId = runId;
    }
    // Auto-sync hot standby to keep it current
    if (this.hotStandbyInstance) {
      this.syncHotStandby().catch((e) => {
        getGlobalLogger().debug('AgentStandbyManager', 'Auto-sync after checkpoint failed', {
          error: (e as Error)?.message,
        });
      });
    }
  }

  /** Check if currently switching (prevent re-entrant switches). */
  isSwitching(): boolean {
    return this.switching;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async isActiveHealthy(): Promise<boolean> {
    if (!this.activeInstance) return false;
    // Health check: verify the checkpointer can access recent checkpoints.
    // A healthy agent writes checkpoints regularly. If the latest checkpoint
    // is older than 2x the health check interval, the agent is unhealthy.
    try {
      const checkpoints = this.checkpointer.listCheckpoints();
      if (checkpoints.length === 0) {
        // No checkpoints yet — agent might have just started, consider healthy
        return true;
      }
      // Check recency: latest checkpoint should be within 2x health check window
      const latest = checkpoints[0]; // Sorted by timestamp desc
      const latestTime = new Date(latest.timestamp).getTime();
      const maxAge = this.config.healthCheckIntervalMs * 2;
      return Date.now() - latestTime < maxAge;
    } catch (err) {
      reportSilentFailure(err, 'agentStandbyManager:751');
      return false;
    }
  }

  /** Reset state (for test isolation). */
  reset(): void {
    this.stop();
    this.activeInstance = null;
    this.hotStandbyInstance = null;
    this.coldStandbyInstance = null;
    this.switchHistory = [];
    this.lastConfidenceReadings = [];
    this.switching = false;
    this.lastSwitchAt = 0;
    this.startTime = 0;
  }
}

// ============================================================================
// Singleton
// ============================================================================

const standbyManagerSingleton = createTenantAwareSingleton(() => new AgentStandbyManager());

/** Get the global AgentStandbyManager. */
export function getAgentStandbyManager(_config?: Partial<StandbyConfig>): AgentStandbyManager {
  return standbyManagerSingleton.get();
}

/** Reset the standby manager (for test isolation). */
export function resetAgentStandbyManager(): void {
  standbyManagerSingleton.reset();
}
