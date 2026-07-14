/**
 * UnifiedCostAuthority (UCA) — 单一成本真相源
 *
 * 取代之前分散的 5 套成本机制（BillExplosionGuard + CostGuard + DynamicCostGuardian
 * + TokenGovernor 强制路径 + TokenSentinel），将成本控制重构为四层职责分离：
 *
 *   Layer 1: CostPredictor   — 预估（调用前）
 *   Layer 2: BudgetEnforcer  — 强制（硬阻断，唯一强制入口）
 *   Layer 3: AnomalyObserver — 观察（advisory 非阻断）
 *   Layer 4: BudgetOptimizer — 策略建议（advisory 非强制，由 tokenGovernor 承担）
 *
 * 核心设计原则（基于业界 LLM Gateway 最佳实践）：
 * 1. 单一成本真相源 —— 所有成本决策的唯一入口，杜绝多套机制对"剩余预算"给出不同数字
 * 2. 热路径只过一次检查 —— preCall 一次预估+强制，postCall 一次记录+熔断
 * 3. 预测/强制/观察分离 —— 强制层只做硬阻断，观察层只做 advisory，永不混淆
 * 4. 分层预算 —— per-request → per-run → per-tenant(daily/monthly) → global(daily)
 * 5. Per-tool 成本门控 —— 工具声明 costTier，UCA 按档位强制 per-call + per-run 上限
 * 6. 三档响应 —— WARN(80%) → THROTTLE(90%) → MELT(100%)，preCall 不触发 MELT 避免误杀
 *
 * 集成模块：
 * - LiteLLMPricing: 实时模型定价（成本预估）
 * - tenantAwareSingleton: 按租户隔离的预算状态
 * - securityAuditLogger: 安全事件审计
 * - GlobalLogger/GlobalMetrics: 日志和指标
 *
 * Usage:
 *   import { getUnifiedCostAuthority } from './unifiedCostAuthority';
 *   const uca = getUnifiedCostAuthority();
 *
 *   // LLM 调用前
 *   const decision = uca.preCall({ runId, tenantId, model: 'gpt-4o', estimatedTokens: 5000 });
 *   if (!decision.allowed) throw new Error(decision.reason);
 *
 *   // LLM 调用后
 *   uca.postCall({ runId, tenantId, model: 'gpt-4o' }, { costUsd: 0.05, promptTokens: 1000, completionTokens: 500 });
 *
 *   // 工具调用前
 *   const toolDecision = uca.preCall({ runId, tenantId, tool: { name: 'code_exec', costTier: 'high' } });
 *   if (!toolDecision.allowed) throw new Error(toolDecision.reason);
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getLiteLLMPricing } from './litellmPricing';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getGlobalTenantProvider } from '../runtime/tenantProvider';

// ============================================================================
// Per-Tool 成本元数据
// ============================================================================

// ToolCostTier 定义在 runtime/types/tool.ts（基础类型层），这里 import + re-export
// 保持向后兼容。外部模块既可从 unifiedCostAuthority 导入，也可从 runtime/types 导入。
import type { ToolCostTier } from '../runtime/types/tool';
export type { ToolCostTier };

/** 工具成本声明。注册时由工具作者声明，运行时由 UCA 强制。 */
export interface ToolCostProfile {
  costTier: ToolCostTier;
  estimatedOutputTokens?: number;
  perCallCostCeilingUsd?: number;
  perRunCallCap?: number;
}

/**
 * 档位 → 默认参数表。
 *
 * 默认值基于业界工具成本量级观察：
 * - free: 内存读取、列表查询（输出 < 200 token）
 * - low: 搜索、检索（输出 ~1K token）
 * - medium: 文件读取、RAG 查询（输出 ~5K token）
 * - high: 代码执行、文件写入（输出 ~20K token，可能触发下游 LLM 调用）
 * - critical: shell、网络写入（不可逆，输出可达 100K token）
 */
export const TIER_DEFAULTS: Record<
  ToolCostTier,
  { estimatedOutputTokens: number; perCallCostCeilingUsd: number; perRunCallCap: number }
> = {
  free: { estimatedOutputTokens: 200, perCallCostCeilingUsd: 0.001, perRunCallCap: 500 },
  low: { estimatedOutputTokens: 1000, perCallCostCeilingUsd: 0.01, perRunCallCap: 200 },
  medium: { estimatedOutputTokens: 5000, perCallCostCeilingUsd: 0.05, perRunCallCap: 100 },
  high: { estimatedOutputTokens: 20000, perCallCostCeilingUsd: 0.2, perRunCallCap: 50 },
  critical: { estimatedOutputTokens: 100000, perCallCostCeilingUsd: 1.0, perRunCallCap: 10 },
};

// ============================================================================
// 分层预算状态
// ============================================================================

/** 单次调用（LLM 或工具）的成本记录条目。 */
export interface CostLedgerEntry {
  timestamp: string;
  runId: string;
  tenantId?: string;
  kind: 'llm' | 'tool';
  modelOrTool: string;
  predictedCostUsd: number;
  actualCostUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  toolCostTier?: ToolCostTier;
}

/** 分层预算快照（一个时间点的全层级成本状态）。 */
export interface BudgetSnapshot {
  perRequest: { used: number; cap: number };
  perRun: { used: number; cap: number };
  perTenantDaily: { used: number; cap: number };
  perTenantMonthly: { used: number; cap: number };
  globalDaily: { used: number; cap: number };
}

/** 预算上限配置（可被 AnomalyObserver 动态调整）。 */
export interface BudgetCap {
  perRequestUsd: number;
  perRunUsd: number;
  perTenantDailyUsd: number;
  perTenantMonthlyUsd: number;
  globalDailyUsd: number;
}

/** UCA 默认配置。 */
export const DEFAULT_UCA_CONFIG: BudgetCap = {
  perRequestUsd: 5.0,
  perRunUsd: 50.0,
  perTenantDailyUsd: 500.0,
  perTenantMonthlyUsd: 10_000.0,
  globalDailyUsd: 5_000.0,
};

// ============================================================================
// UCA 公共接口
// ============================================================================

export interface UCACallContext {
  runId: string;
  tenantId?: string;
  sessionId?: string;
  /** LLM 调用: 模型名；工具调用: null。 */
  model?: string;
  /** LLM 调用: 预估 token；工具调用: null。 */
  estimatedTokens?: number;
  /** 工具调用: 工具名+成本档位；LLM 调用: null。 */
  tool?: { name: string; costTier: ToolCostTier };
  /** 缓存命中率（0-1），用于 LLM 成本预估。 */
  cacheHitRatio?: number;
}

export interface UCADecision {
  allowed: boolean;
  /** ALLOW / WARN / THROTTLE / MELT。preCall 永不返回 MELT（避免预估误杀）。 */
  action: 'ALLOW' | 'WARN' | 'THROTTLE' | 'MELT';
  reason?: string;
  snapshot?: BudgetSnapshot;
  estimatedCostUsd: number;
}

export interface UCAPostCallResult {
  /** 是否触发熔断。true 表示后续调用将被拒绝。 */
  melted: boolean;
  reason?: string;
  /** 更新后的快照。 */
  snapshot: BudgetSnapshot;
}

// ============================================================================
// 内部状态结构
// ============================================================================

interface RunBudgetState {
  usedUsd: number;
  toolCallCounts: Map<string, number>;
  createdAt: string;
}

interface TenantBudgetState {
  dailyUsedUsd: number;
  monthlyUsedUsd: number;
  dailyResetAt: string; // ISO date (YYYY-MM-DD)
  monthlyResetAt: string; // ISO month (YYYY-MM)
  /** AnomalyObserver 动态调整后的预算覆盖。 */
  dynamicCapOverride?: Partial<BudgetCap>;
}

// ============================================================================
// Layer 1: CostPredictor — 预估（调用前）
// ============================================================================

class CostPredictor {
  /**
   * 预估 LLM 调用成本（美元）。
   * 优先使用 LiteLLM 实时定价；不可用时回退到保守默认 $5/M tokens。
   */
  predictLLMCost(model: string, estimatedTokens: number, cacheHitRatio = 0): number {
    const litellm = getLiteLLMPricing();
    const fullRate = litellm.getCostPer1MTokens(model) ?? 5.0;

    if (cacheHitRatio > 0) {
      const cacheRate = litellm.getCacheReadCostPer1MTokens(model);
      if (cacheRate !== undefined) {
        const blendedRate = cacheHitRatio * cacheRate + (1 - cacheHitRatio) * fullRate;
        return (estimatedTokens / 1_000_000) * blendedRate;
      }
    }
    return (estimatedTokens / 1_000_000) * fullRate;
  }

  /**
   * 预估工具调用成本（美元）。
   * 成本驱动 = 工具输出回流 LLM 的 token 消耗。
   * 使用档位默认值或工具声明的 estimatedOutputTokens。
   */
  predictToolCost(
    toolName: string,
    tier: ToolCostTier,
    profile?: ToolCostProfile,
  ): {
    costUsd: number;
    outputTokens: number;
  } {
    const defaults = TIER_DEFAULTS[tier];
    const outputTokens = profile?.estimatedOutputTokens ?? defaults.estimatedOutputTokens;
    // 工具输出回流 LLM 的成本（按 default model $5/M 保守预估）
    const costUsd = (outputTokens / 1_000_000) * 5.0;
    return { costUsd, outputTokens };
  }
}

// ============================================================================
// Layer 2: BudgetEnforcer — 强制（硬阻断）
// ============================================================================

class BudgetEnforcer {
  private runStates = new Map<string, RunBudgetState>();
  private tenantStates = new Map<string, TenantBudgetState>();
  private globalDailyUsedUsd = 0;
  private globalDailyResetAt = this.todayIso();
  private config: BudgetCap;

  constructor(config: BudgetCap = DEFAULT_UCA_CONFIG) {
    this.config = config;
  }

  /** 更新配置（运行时可被 AnomalyObserver 调整）。 */
  updateConfig(patch: Partial<BudgetCap>): void {
    this.config = { ...this.config, ...patch };
  }

  /** AnomalyObserver 反馈动态阈值调整（per-tenant）。 */
  applyDynamicThresholds(tenantId: string, adjustment: Partial<BudgetCap>): void {
    const state = this.getOrCreateTenantState(tenantId);
    state.dynamicCapOverride = { ...state.dynamicCapOverride, ...adjustment };
  }

  /**
   * 调用前强制检查。唯一硬阻断入口。
   * 返回 ALLOW / WARN / THROTTLE。永不返回 MELT（MELT 只在 postCall 触发，避免预估误杀）。
   */
  preCheck(
    ctx: UCACallContext,
    estimatedCostUsd: number,
    toolProfile?: ToolCostProfile,
  ): { allowed: boolean; action: UCADecision['action']; reason?: string } {
    const runState = this.getOrCreateRunState(ctx.runId, ctx.tenantId);
    const tenantId = ctx.tenantId ?? '__global__';
    const tenantState = this.getOrCreateTenantState(tenantId);
    this.maybeResetDailyMonthly(tenantState);

    // Per-tool 调用次数门控（替代旧的"60次/分钟频率检测"，更精准）
    if (ctx.tool) {
      const tier = ctx.tool.costTier;
      const defaults = TIER_DEFAULTS[tier];
      const callCap = toolProfile?.perRunCallCap ?? defaults.perRunCallCap;
      const currentCalls = runState.toolCallCounts.get(ctx.tool.name) ?? 0;
      if (currentCalls >= callCap) {
        return {
          allowed: false,
          action: 'THROTTLE',
          reason: `Tool '${ctx.tool.name}' per-run call cap reached: ${currentCalls}/${callCap} (tier: ${tier})`,
        };
      }

      // Per-call 成本上限门控
      const perCallCeiling = toolProfile?.perCallCostCeilingUsd ?? defaults.perCallCostCeilingUsd;
      if (estimatedCostUsd > perCallCeiling) {
        return {
          allowed: false,
          action: 'THROTTLE',
          reason: `Tool '${ctx.tool.name}' per-call cost ceiling exceeded: $${estimatedCostUsd.toFixed(4)} > $${perCallCeiling} (tier: ${tier})`,
        };
      }
    }

    // 分层预算检查
    const caps = this.effectiveCaps(tenantState);
    const projectedRun = runState.usedUsd + estimatedCostUsd;
    const projectedGlobalDaily = this.globalDailyUsedUsd + estimatedCostUsd;

    // per-request 硬上限
    if (estimatedCostUsd > caps.perRequestUsd) {
      return {
        allowed: false,
        action: 'THROTTLE',
        reason: `Per-request cost exceeded: $${estimatedCostUsd.toFixed(4)} > $${caps.perRequestUsd}`,
      };
    }

    // per-run 硬上限
    if (projectedRun > caps.perRunUsd) {
      return {
        allowed: false,
        action: 'THROTTLE',
        reason: `Per-run budget exceeded: $${projectedRun.toFixed(4)} > $${caps.perRunUsd}`,
      };
    }

    // per-tenant 硬上限（按租户 billingCycle，默认 daily）
    const tenantIdForConfig = ctx.tenantId ?? 'default';
    const billingCycle = this.getTenantBillingCycle(tenantIdForConfig);
    const perTenantCap =
      billingCycle === 'monthly' ? caps.perTenantMonthlyUsd : caps.perTenantDailyUsd;
    const perTenantUsed =
      billingCycle === 'monthly' ? tenantState.monthlyUsedUsd : tenantState.dailyUsedUsd;
    const projectedTenant = perTenantUsed + estimatedCostUsd;
    if (projectedTenant > perTenantCap) {
      return {
        allowed: false,
        action: 'THROTTLE',
        reason: `Per-tenant ${billingCycle} budget exceeded for tenant '${tenantIdForConfig}': $${projectedTenant.toFixed(4)} > $${perTenantCap}`,
      };
    }

    // global daily 硬上限
    if (projectedGlobalDaily > caps.globalDailyUsd) {
      return {
        allowed: false,
        action: 'THROTTLE',
        reason: `Global daily budget exceeded: $${projectedGlobalDaily.toFixed(4)} > $${caps.globalDailyUsd}`,
      };
    }

    // 三档响应（基于 per-run 利用率）
    const utilization = projectedRun / caps.perRunUsd;
    if (utilization >= 0.9) {
      return {
        allowed: true,
        action: 'THROTTLE',
        reason: `Per-run budget at ${(utilization * 100).toFixed(0)}% (THROTTLE threshold 90%)`,
      };
    }
    if (utilization >= 0.8) {
      return {
        allowed: true,
        action: 'WARN',
        reason: `Per-run budget at ${(utilization * 100).toFixed(0)}%`,
      };
    }

    return { allowed: true, action: 'ALLOW' };
  }

  /**
   * 调用后记录实际成本 + 触发熔断检查。
   * MELT 只在此处触发（基于实际成本，避免预估误杀）。
   */
  postRecord(
    ctx: UCACallContext,
    actual: { costUsd: number; promptTokens?: number; completionTokens?: number },
  ): { melted: boolean; reason?: string } {
    const runState = this.getOrCreateRunState(ctx.runId, ctx.tenantId);
    const tenantId = ctx.tenantId ?? '__global__';
    const tenantState = this.getOrCreateTenantState(tenantId);
    this.maybeResetDailyMonthly(tenantState);

    runState.usedUsd += actual.costUsd;
    tenantState.dailyUsedUsd += actual.costUsd;
    tenantState.monthlyUsedUsd += actual.costUsd;
    this.globalDailyUsedUsd += actual.costUsd;

    if (ctx.tool) {
      runState.toolCallCounts.set(
        ctx.tool.name,
        (runState.toolCallCounts.get(ctx.tool.name) ?? 0) + 1,
      );
    }

    // MELT 检查（基于实际成本）
    const caps = this.effectiveCaps(tenantState);
    if (runState.usedUsd >= caps.perRunUsd) {
      return {
        melted: true,
        reason: `Per-run budget MELT: $${runState.usedUsd.toFixed(4)} >= $${caps.perRunUsd}`,
      };
    }

    // per-tenant MELT（按租户 billingCycle，默认 daily）
    const tenantIdForConfig = ctx.tenantId ?? 'default';
    const billingCycle = this.getTenantBillingCycle(tenantIdForConfig);
    const perTenantCap =
      billingCycle === 'monthly' ? caps.perTenantMonthlyUsd : caps.perTenantDailyUsd;
    const perTenantUsed =
      billingCycle === 'monthly' ? tenantState.monthlyUsedUsd : tenantState.dailyUsedUsd;
    if (perTenantUsed >= perTenantCap) {
      return {
        melted: true,
        reason: `Per-tenant ${billingCycle} MELT for tenant '${tenantIdForConfig}': $${perTenantUsed.toFixed(4)} >= $${perTenantCap}`,
      };
    }
    if (this.globalDailyUsedUsd >= caps.globalDailyUsd) {
      return {
        melted: true,
        reason: `Global daily MELT: $${this.globalDailyUsedUsd.toFixed(4)} >= $${caps.globalDailyUsd}`,
      };
    }

    return { melted: false };
  }

  /** 查询当前快照。 */
  getSnapshot(runId: string, tenantId?: string): BudgetSnapshot {
    const runState = this.getOrCreateRunState(runId, tenantId);
    const tid = tenantId ?? '__global__';
    const tenantState = this.getOrCreateTenantState(tid);
    this.maybeResetDailyMonthly(tenantState);
    const caps = this.effectiveCaps(tenantState);

    return {
      perRequest: { used: 0, cap: caps.perRequestUsd },
      perRun: { used: runState.usedUsd, cap: caps.perRunUsd },
      perTenantDaily: { used: tenantState.dailyUsedUsd, cap: caps.perTenantDailyUsd },
      perTenantMonthly: { used: tenantState.monthlyUsedUsd, cap: caps.perTenantMonthlyUsd },
      globalDaily: { used: this.globalDailyUsedUsd, cap: caps.globalDailyUsd },
    };
  }

  /** 清理已完成的 run 状态（防止内存泄漏）。 */
  disposeRun(runId: string, tenantId?: string): void {
    this.runStates.delete(this.runKey(runId, tenantId));
  }

  // ── 内部辅助 ──────────────────────────────────────────────────

  /**
   * Run state key — tenant-scoped to enforce multi-tenant isolation.
   *
   * 业界多租户预算隔离最佳实践：run 状态键必须包含 tenantId，
   * 防止两个租户使用相同 runId 时发生状态泄漏。AWS/Azure/GCP 的
   * 资源标识符均采用 account-scoped 模式。
   */
  private runKey(runId: string, tenantId?: string): string {
    return tenantId ? `${tenantId}::${runId}` : runId;
  }

  private getOrCreateRunState(runId: string, tenantId?: string): RunBudgetState {
    const key = this.runKey(runId, tenantId);
    let state = this.runStates.get(key);
    if (!state) {
      state = { usedUsd: 0, toolCallCounts: new Map(), createdAt: new Date().toISOString() };
      this.runStates.set(key, state);
    }
    return state;
  }

  private getOrCreateTenantState(tenantId: string): TenantBudgetState {
    let state = this.tenantStates.get(tenantId);
    if (!state) {
      const now = new Date();
      state = {
        dailyUsedUsd: 0,
        monthlyUsedUsd: 0,
        dailyResetAt: this.todayIso(),
        monthlyResetAt: this.monthIso(),
      };
      this.tenantStates.set(tenantId, state);
    }
    return state;
  }

  private effectiveCaps(tenantState: TenantBudgetState): BudgetCap {
    if (!tenantState.dynamicCapOverride) return this.config;
    return { ...this.config, ...tenantState.dynamicCapOverride };
  }

  /**
   * Resolve the tenant's configured billing cycle.
   *
   * Default is 'daily'. A tenant may opt into 'monthly' budgeting via
   * `metadata.billingCycle: 'monthly'` in its TenantConfig.
   */
  private getTenantBillingCycle(tenantId: string): 'daily' | 'monthly' {
    try {
      const cycle = getGlobalTenantProvider().getTenantConfig(tenantId)?.metadata?.billingCycle;
      if (cycle === 'monthly') return 'monthly';
    } catch {
      // Best-effort: if the provider is not initialized, fall back to daily.
    }
    return 'daily';
  }

  private maybeResetDailyMonthly(state: TenantBudgetState): void {
    const today = this.todayIso();
    if (state.dailyResetAt !== today) {
      state.dailyUsedUsd = 0;
      state.dailyResetAt = today;
    }
    const month = this.monthIso();
    if (state.monthlyResetAt !== month) {
      state.monthlyUsedUsd = 0;
      state.monthlyResetAt = month;
    }
    if (this.globalDailyResetAt !== today) {
      this.globalDailyUsedUsd = 0;
      this.globalDailyResetAt = today;
    }
  }

  private todayIso(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private monthIso(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }
}

// ============================================================================
// Layer 3: AnomalyObserver — 观察（advisory 非阻断）
// ============================================================================

interface TenantCostWindow {
  samples: number[]; // 最近 N 次调用成本
  lastUpdate: number;
}

/**
 * 3σ 偏差检测器（来自 DynamicCostGuardian 的核心能力，简化为 advisory）。
 *
 * 不阻断任何调用，仅在检测到异常时：
 * 1. 发出 system.alert 事件（由调用方发布到 MessageBus）
 * 2. 反馈动态阈值收紧给 BudgetEnforcer
 */
class AnomalyObserver {
  private windows = new Map<string, TenantCostWindow>();
  private readonly WINDOW_SIZE = 100;
  private readonly SIGMA_THRESHOLD = 3;

  /** 记录一次调用成本，返回异常检测结果（如有）。 */
  observe(tenantId: string, costUsd: number): { anomaly: boolean; type?: string; zscore?: number } {
    const key = tenantId ?? '__global__';
    let window = this.windows.get(key);
    if (!window) {
      window = { samples: [], lastUpdate: Date.now() };
      this.windows.set(key, window);
    }
    window.samples.push(costUsd);
    if (window.samples.length > this.WINDOW_SIZE) {
      window.samples.shift();
    }
    window.lastUpdate = Date.now();

    if (window.samples.length < 30) {
      return { anomaly: false }; // 样本不足
    }

    const mean = window.samples.reduce((s, v) => s + v, 0) / window.samples.length;
    const variance =
      window.samples.reduce((s, v) => s + (v - mean) ** 2, 0) / window.samples.length;
    const std = Math.sqrt(variance);
    if (std < 1e-9) return { anomaly: false };

    const zscore = (costUsd - mean) / std;
    if (Math.abs(zscore) > this.SIGMA_THRESHOLD) {
      return {
        anomaly: true,
        type: zscore > 0 ? 'cost_spike' : 'cost_drop',
        zscore,
      };
    }
    return { anomaly: false };
  }

  /**
   * 检测到异常时，建议 BudgetEnforcer 收紧阈值。
   * 返回建议的收紧比例（如 0.8 表示收紧到 80%）。
   */
  suggestThresholdAdjustment(zscore: number): number {
    // zscore 3-5: 收紧到 80%；5-10: 收紧到 50%；>10: 收紧到 20%
    const abs = Math.abs(zscore);
    if (abs > 10) return 0.2;
    if (abs > 5) return 0.5;
    return 0.8;
  }
}

// ============================================================================
// UnifiedCostAuthority — 主类，编排三层
// ============================================================================

export class UnifiedCostAuthority {
  private predictor = new CostPredictor();
  private enforcer = new BudgetEnforcer();
  private observer = new AnomalyObserver();
  private ledger: CostLedgerEntry[] = [];
  private readonly MAX_LEDGER_SIZE = 10_000;

  /** 调用前检查（LLM 或工具）。唯一强制入口。 */
  preCall(ctx: UCACallContext): UCADecision {
    let estimatedCostUsd = 0;

    if (ctx.tool) {
      const result = this.predictor.predictToolCost(ctx.tool.name, ctx.tool.costTier);
      estimatedCostUsd = result.costUsd;
    } else if (ctx.model && ctx.estimatedTokens) {
      estimatedCostUsd = this.predictor.predictLLMCost(
        ctx.model,
        ctx.estimatedTokens,
        ctx.cacheHitRatio ?? 0,
      );
    }

    const check = this.enforcer.preCheck(ctx, estimatedCostUsd);
    const snapshot = this.enforcer.getSnapshot(ctx.runId, ctx.tenantId);

    if (!check.allowed) {
      this.auditReject(ctx, check.reason ?? 'denied', estimatedCostUsd);
    }

    return {
      allowed: check.allowed,
      action: check.action,
      reason: check.reason,
      snapshot,
      estimatedCostUsd,
    };
  }

  /** 调用后记录实际成本 + 触发熔断检查。 */
  postCall(
    ctx: UCACallContext,
    actual: { costUsd: number; promptTokens?: number; completionTokens?: number },
  ): UCAPostCallResult {
    const meltResult = this.enforcer.postRecord(ctx, actual);
    const snapshot = this.enforcer.getSnapshot(ctx.runId, ctx.tenantId);

    // 记录到 ledger
    const entry: CostLedgerEntry = {
      timestamp: new Date().toISOString(),
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      kind: ctx.tool ? 'tool' : 'llm',
      modelOrTool: ctx.tool?.name ?? ctx.model ?? 'unknown',
      predictedCostUsd: 0, // 由 preCall 计算，此处简化
      actualCostUsd: actual.costUsd,
      promptTokens: actual.promptTokens,
      completionTokens: actual.completionTokens,
      toolCostTier: ctx.tool?.costTier,
    };
    this.appendLedger(entry);

    // AnomalyObserver 观察（advisory）
    // Skip dynamic threshold tightening in benchmark mode so long-running
    // benchmark suites don't get budget-capped mid-run. Set
    // COMMANDER_BENCHMARK_MODE=1 to bypass anomaly-driven budget reduction.
    const skipDynamicTightening = process.env['COMMANDER_BENCHMARK_MODE'] === '1';
    const anomaly = this.observer.observe(ctx.tenantId ?? '__global__', actual.costUsd);
    if (anomaly.anomaly && anomaly.zscore && !skipDynamicTightening) {
      try {
        getGlobalLogger().warn('UnifiedCostAuthority', 'Cost anomaly detected', {
          tenantId: ctx.tenantId,
          type: anomaly.type,
          zscore: anomaly.zscore,
          costUsd: actual.costUsd,
        });
        // 反馈动态阈值收紧给 enforcer
        const factor = this.observer.suggestThresholdAdjustment(anomaly.zscore);
        if (ctx.tenantId) {
          this.enforcer.applyDynamicThresholds(ctx.tenantId, {
            perRunUsd: snapshot.perRun.cap * factor,
            perTenantDailyUsd: snapshot.perTenantDaily.cap * factor,
          });
        }
      } catch (err) {
        reportSilentFailure(err, 'uca:anomalyObserver');
      }
    }

    if (meltResult.melted) {
      try {
        getSecurityAuditLogger().logEvent({
          type: 'token_budget_breach',
          severity: 'critical',
          source: 'UnifiedCostAuthority',
          message: meltResult.reason ?? 'Budget melt triggered',
          details: { usedUsd: snapshot.perRun.used, kind: ctx.tool ? 'tool' : 'llm' },
          context: { runId: ctx.runId, tenantId: ctx.tenantId },
        });
      } catch (err) {
        reportSilentFailure(err, 'uca:meltAudit');
      }
    }

    return { melted: meltResult.melted, reason: meltResult.reason, snapshot };
  }

  /** 查询当前快照（供 dashboard / observability）。 */
  getSnapshot(runId: string, tenantId?: string): BudgetSnapshot {
    return this.enforcer.getSnapshot(runId, tenantId);
  }

  /** 清理已完成的 run 状态。 */
  disposeRun(runId: string, tenantId?: string): void {
    this.enforcer.disposeRun(runId, tenantId);
  }

  /** 读取 ledger（供 observability 持久化到 .commander_samples）。 */
  readLedger(): readonly CostLedgerEntry[] {
    return this.ledger;
  }

  /** 更新预算配置。 */
  updateConfig(patch: Partial<BudgetCap>): void {
    this.enforcer.updateConfig(patch);
  }

  // ── 内部辅助 ──────────────────────────────────────────────────

  private appendLedger(entry: CostLedgerEntry): void {
    this.ledger.push(entry);
    if (this.ledger.length > this.MAX_LEDGER_SIZE) {
      this.ledger.shift();
    }
    try {
      getGlobalMetrics().incrementCounter('uca_cost_entries', 1, {
        kind: entry.kind,
        tenantId: entry.tenantId ?? '__global__',
      });
    } catch (err) {
      reportSilentFailure(err, 'uca:metrics');
    }
  }

  private auditReject(ctx: UCACallContext, reason: string, estimatedCostUsd: number): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'token_budget_breach',
        severity: 'high',
        source: 'UnifiedCostAuthority',
        message: reason,
        details: {
          estimatedCostUsd,
          tool: ctx.tool?.name,
          model: ctx.model,
          kind: ctx.tool ? 'tool' : 'llm',
        },
        context: { runId: ctx.runId, tenantId: ctx.tenantId },
      });
    } catch (err) {
      reportSilentFailure(err, 'uca:rejectAudit');
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

export function getUnifiedCostAuthority(): UnifiedCostAuthority {
  return singleton.get();
}

export function resetUnifiedCostAuthority(): void {
  singleton.reset();
}

const singleton = createTenantAwareSingleton(() => new UnifiedCostAuthority(), {
  componentName: 'UnifiedCostAuthority',
});
