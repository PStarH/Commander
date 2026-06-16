/**
 * TokenBudgetManager — Centralized token budget tracking and proportional
 * allocation across sub-agents.
 *
 * The orchestrator creates one instance per run. As tasks are decomposed,
 * the total budget is split proportionally across sub-agents based on their
 * estimated token needs. Actual usage is tracked in real-time, and hard/soft
 * cap enforcement triggers warnings or abort signals.
 */
import { getMetricsCollector } from './metricsCollector';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface SubAgentAllocation {
  nodeId: string;
  allocatedBudget: number;
  usedTokens: number;
  status: 'pending' | 'running' | 'completed' | 'cancelled';
  hardCapExceeded: boolean;
}

export interface RunBudgetStatus {
  runId: string;
  totalBudget: number;
  softCap: number;
  hardCap: number;
  usedTokens: number;
  remainingTokens: number;
  utilizationPercent: number;
  phase: 'relaxed' | 'moderate' | 'tight' | 'critical' | 'exceeded';
  subAgents: SubAgentAllocation[];
  createdAt: string;
  updatedAt: string;
}

export interface TokenBudgetConfig {
  /** Total token budget for the run (hard cap) */
  hardCap: number;
  /** Soft cap — warning threshold (default 80% of hard cap) */
  softCap?: number;
}

const DEFAULT_SOFT_CAP_RATIO = 0.8;
const MAX_ACTIVE_BUDGETS = 200;

// ============================================================================
// TokenBudgetManager
// ============================================================================

export class TokenBudgetManager {
  private budgets: Map<string, RunBudgetStatus> = new Map();
  private runLookup: Map<string, string> = new Map(); // agentId → runId

  /**
   * Start tracking a new run's budget.
   */
  startRun(runId: string, config: TokenBudgetConfig): RunBudgetStatus {
    const softCap = config.softCap ?? Math.round(config.hardCap * DEFAULT_SOFT_CAP_RATIO);
    const status: RunBudgetStatus = {
      runId,
      totalBudget: config.hardCap,
      softCap,
      hardCap: config.hardCap,
      usedTokens: 0,
      remainingTokens: config.hardCap,
      utilizationPercent: 0,
      phase: 'relaxed',
      subAgents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Evict oldest if over capacity
    if (this.budgets.size >= MAX_ACTIVE_BUDGETS) {
      const oldest = this.budgets.keys().next().value;
      if (oldest) this.budgets.delete(oldest);
    }

    this.budgets.set(runId, status);
    this.emitMetrics(runId);
    return status;
  }

  /**
   * Allocate budget proportionally across sub-agents based on their
   * estimated token needs. Returns a Map of nodeId → allocated budget.
   *
   * The allocation formula:
   *   allocated[i] = totalBudget * (estimatedTokens[i] / sum(estimatedTokens))
   *
   * A 10% reserve is kept for synthesis and quality fix overhead.
   */
  allocateToSubAgents(
    runId: string,
    subAgentEstimates: Array<{ nodeId: string; estimatedTokens: number }>,
  ): Map<string, number> {
    const status = this.budgets.get(runId);
    if (!status) {
      getGlobalLogger().warn('TokenBudgetManager', 'Allocation on unknown run', { runId });
      return new Map();
    }

    const totalEstimated = subAgentEstimates.reduce((s, e) => s + e.estimatedTokens, 0);
    if (totalEstimated === 0) {
      // Equal split when no estimates available
      const equalShare = Math.floor(status.remainingTokens / subAgentEstimates.length);
      return new Map(subAgentEstimates.map(e => [e.nodeId, equalShare]));
    }

    // 10% reserve for synthesis + quality fix overhead
    const allocatable = Math.floor(status.totalBudget * 0.9);

    const result = new Map<string, number>();
    const allocations: SubAgentAllocation[] = [];

    let allocatedSum = 0;
    const entries = subAgentEstimates.map((e, i) => {
      // Last entry gets the remainder to avoid rounding losses
      const isLast = i === subAgentEstimates.length - 1;
      const share = isLast
        ? allocatable - allocatedSum
        : Math.floor(allocatable * (e.estimatedTokens / totalEstimated));
      allocatedSum += share;
      return { ...e, share };
    });

    for (const entry of entries) {
      result.set(entry.nodeId, entry.share);
      allocations.push({
        nodeId: entry.nodeId,
        allocatedBudget: entry.share,
        usedTokens: 0,
        status: 'pending',
        hardCapExceeded: false,
      });
    }

    status.subAgents = allocations;
    status.updatedAt = new Date().toISOString();
    this.budgets.set(runId, status);

    return result;
  }

  /**
   * Record token usage from a sub-agent. Updates the run-level total
   * and the per-agent allocation tracker.
   */
  recordUsage(runId: string, nodeId: string, tokens: number): { warning: boolean; exceeded: boolean } {
    const status = this.budgets.get(runId);
    if (!status) return { warning: false, exceeded: false };

    status.usedTokens += tokens;
    status.remainingTokens = Math.max(0, status.totalBudget - status.usedTokens);
    status.utilizationPercent = status.totalBudget > 0
      ? Math.round((status.usedTokens / status.totalBudget) * 100)
      : 0;
    status.updatedAt = new Date().toISOString();

    // Update phase
    if (status.usedTokens >= status.hardCap) {
      status.phase = 'exceeded';
    } else if (status.usedTokens >= status.hardCap * 0.95) {
      status.phase = 'critical';
    } else if (status.usedTokens >= status.softCap) {
      status.phase = 'tight';
    } else if (status.usedTokens >= status.softCap * 0.65) {
      status.phase = 'moderate';
    }

    // Update per-agent tracker
    const agent = status.subAgents.find(a => a.nodeId === nodeId);
    if (agent) {
      agent.usedTokens += tokens;
      agent.status = 'running';
      if (agent.usedTokens >= agent.allocatedBudget && agent.allocatedBudget > 0) {
        agent.hardCapExceeded = true;
      }
    }

    this.budgets.set(runId, status);

    // Emit warnings
    const warning = status.phase === 'tight' || status.phase === 'critical';
    const exceeded = status.phase === 'exceeded';

    if (warning && !exceeded) {
      getMessageBus().publish('system.alert', 'budget-manager', {
        type: 'token_budget_warning',
        runId,
        phase: status.phase,
        utilizationPercent: status.utilizationPercent,
        usedTokens: status.usedTokens,
        remainingTokens: status.remainingTokens,
      });
    }

    if (exceeded) {
      getMessageBus().publish('system.alert', 'budget-manager', {
        type: 'token_budget_exceeded',
        runId,
        usedTokens: status.usedTokens,
        hardCap: status.hardCap,
      });
    }

    this.emitMetrics(runId);
    return { warning, exceeded };
  }

  /**
   * Mark a sub-agent as completed and record its final token usage.
   */
  markSubAgentComplete(runId: string, nodeId: string, finalTokens: number): void {
    const status = this.budgets.get(runId);
    if (!status) return;

    const agent = status.subAgents.find(a => a.nodeId === nodeId);
    if (agent) {
      agent.usedTokens = finalTokens;
      agent.status = 'completed';
      agent.hardCapExceeded = agent.usedTokens >= agent.allocatedBudget;
    }

    status.updatedAt = new Date().toISOString();
    this.budgets.set(runId, status);
  }

  /**
   * Get the budget status for a run.
   */
  getRunStatus(runId: string): RunBudgetStatus | null {
    return this.budgets.get(runId) ?? null;
  }

  /**
   * Check if a run's budget is exceeded (hard cap).
   */
  isBudgetExceeded(runId: string): boolean {
    const status = this.budgets.get(runId);
    return status ? status.phase === 'exceeded' : false;
  }

  /**
   * Get all active budget statuses, most recent first.
   */
  getActiveBudgets(): RunBudgetStatus[] {
    return Array.from(this.budgets.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Get remaining budget for a run.
   */
  getRemainingBudget(runId: string): number {
    return this.budgets.get(runId)?.remainingTokens ?? 0;
  }

  /**
   * Clean up a completed run's budget tracking.
   */
  completeRun(runId: string): void {
    this.budgets.delete(runId);
  }

  /**
   * Number of active budgets being tracked.
   */
  getActiveBudgetCount(): number {
    return this.budgets.size;
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  private emitMetrics(runId: string): void {
    const status = this.budgets.get(runId);
    if (!status) return;
    try {
      const mc = getMetricsCollector();
      mc.setGauge('token_budget_utilization_percent', 'Token budget utilization %', status.utilizationPercent, [
        { name: 'run_id', value: runId },
        { name: 'phase', value: status.phase },
      ]);
      mc.setGauge('token_budget_remaining', 'Remaining token budget', status.remainingTokens, [
        { name: 'run_id', value: runId },
      ]);
    } catch { /* best-effort */ }
  }
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const budgetManagerSingleton = createTenantAwareSingleton(
  () => new TokenBudgetManager(),
);

/**
 * Get the global TokenBudgetManager (single-tenant) or tenant-scoped (multi-tenant).
 */
export function getTokenBudgetManager(): TokenBudgetManager {
  return budgetManagerSingleton.get();
}

/** Reset for test isolation. */
export function resetTokenBudgetManager(): void {
  budgetManagerSingleton.reset();
}
