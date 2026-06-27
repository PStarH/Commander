/**
 * BillExplosionGuard — 不可绕过的账单爆炸防护系统
 *
 * 作为现有 CostGuard 的增强版，提供多层级硬性成本上限，确保 LLM 调用
 * 的成本永远不会超出预设预算。与 CostGuard 不同，本模块在 LLM 调用前
 * 和调用后都执行强制检查，形成不可绕过的双重保障。
 *
 * 核心设计原则：
 * 1. 不可绕过 —— 调用前预估检查 + 调用后实际成本检查，双重保障
 * 2. 多层级控制 —— 每请求/每会话/每租户每日/每租户每月/全局每日
 * 3. 实时追踪 —— 每次 LLM 调用后立即更新成本，无延迟
 * 4. 自动熔断 —— 80% 警告 → 90% 限流 → 100% 熔断
 * 5. 攻击检测 —— 六种经济攻击模式自动识别
 * 6. 防篡改审计 —— 所有关键操作记录到安全审计日志和哈希链
 *
 * 防护层级：
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Layer 1: 预估成本检查（checkBeforeCall）                     │
 * │   - 在 LLM 调用前预估成本，若超限则直接拒绝                   │
 * │   - 检测攻击模式（token 洪水、并发爆发、模型降级等）           │
 * │   - 咨询 CostGuard 作为二次验证                               │
 * │                                                               │
 * │ Layer 2: 实际成本记录（recordAfterCall）                      │
 * │   - LLM 调用后记录实际成本                                    │
 * │   - 检查熔断器阈值，触发警告/限流/熔断                        │
 * │   - 即使预估通过，实际成本超限也会触发熔断                     │
 * │                                                               │
 * │ Layer 3: 工具调用检查（checkToolCall）                        │
 * │   - 检测递归工具调用放大攻击                                   │
 * │   - 每分钟工具调用频率监控                                     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 集成模块：
 * - CostGuard: 二次经济攻击检测（提供更强保障）
 * - SecurityAuditLogger: 安全事件审计日志
 * - AuditChainLedger: 防篡改哈希链
 * - LiteLLMPricing: 实时模型定价
 * - GlobalLogger/GlobalMetrics: 日志和指标
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getCostGuard } from './costGuard';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getLiteLLMPricing } from './litellmPricing';
import { getCurrentTenantId } from '../runtime/tenantContext';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 账单防护执行动作类型。
 * - ALLOW: 允许请求通过
 * - WARN: 允许但发出警告（成本接近上限）
 * - THROTTLE: 限流，调用方应延迟或拒绝请求
 * - MELT: 熔断，立即拒绝所有后续请求
 */
export type BillGuardAction = 'ALLOW' | 'WARN' | 'THROTTLE' | 'MELT';

/**
 * 账单攻击模式类型。
 * - token_flood: Token 洪水攻击（单请求大量 token）
 * - tool_amplification: 递归工具调用放大
 * - concurrent_burst: 并发请求爆发
 * - context_stuffing: 上下文窗口填充
 * - model_degradation: 模型降级攻击（强制使用昂贵模型）
 * - retry_storm: 重试风暴
 */
export type BillAttackPattern =
  | 'token_flood'
  | 'tool_amplification'
  | 'concurrent_burst'
  | 'context_stuffing'
  | 'model_degradation'
  | 'retry_storm';

/**
 * 计费周期类型。
 * - session: 会话周期
 * - daily: 每日周期
 * - monthly: 每月周期
 */
export type BillingPeriod = 'session' | 'daily' | 'monthly';

/**
 * 单个会话的成本状态。
 */
export interface SessionState {
  /** 会话 ID */
  sessionId: string;
  /** 会话累计成本（美元） */
  cost: number;
  /** 会话累计 token 数 */
  tokens: number;
  /** 会话工具调用次数 */
  toolCalls: number;
  /** 上下文累计 token 数（用于上下文填充检测） */
  contextTokens: number;
  /** 请求时间戳数组（用于并发爆发检测） */
  requestTimestamps: number[];
  /** 重试时间戳数组（用于重试风暴检测） */
  retryTimestamps: number[];
  /** 最近工具调用时间戳数组（用于放大检测） */
  recentToolCallTimestamps: number[];
  /** 最后活跃时间戳 */
  lastActiveAt: number;
}

/**
 * 单个租户的成本状态。
 */
export interface TenantCostState {
  /** 租户 ID */
  tenantId: string;
  /** 所有会话的状态映射 */
  sessions: Map<string, SessionState>;
  /** 当日成本（美元） */
  dailyCost: number;
  /** 当日 token 数 */
  dailyTokens: number;
  /** 当日日期标记（YYYY-MM-DD） */
  dailyDate: string;
  /** 当月成本（美元） */
  monthlyCost: number;
  /** 当月 token 数 */
  monthlyTokens: number;
  /** 当月月份标记（YYYY-MM） */
  monthlyDate: string;
  /** 是否已熔断 */
  melted: boolean;
  /** 熔断原因 */
  meltReason: string | undefined;
  /** 熔断时间戳 */
  meltedAt: number | undefined;
  /** 熔断作用域（哪个层级触发的熔断） */
  meltScope: string | undefined;
  /** 是否被限流 */
  throttled: boolean;
  /** 是否已发出警告 */
  warned: boolean;
  /** 最后使用的模型 ID */
  lastModel: string | undefined;
  /** 模型成本历史（用于降级攻击检测） */
  modelCostHistory: Array<{ model: string; cost: number; timestamp: number }>;
  /** 最后快照时间戳 */
  lastSnapshotAt: number | undefined;
}

/**
 * 账单防护配置接口 —— 所有硬上限配置。
 */
export interface BillGuardConfig {
  // ── 硬性成本上限 ──────────────────────────────────────────────
  /** 每次请求成本硬上限（美元） */
  maxCostPerRequest: number;
  /** 每次请求 token 硬上限 */
  maxTokensPerRequest: number;
  /** 每会话成本硬上限（美元） */
  maxCostPerSession: number;
  /** 每会话 token 硬上限 */
  maxTokensPerSession: number;
  /** 每租户每日成本硬上限（美元） */
  maxCostPerTenantDaily: number;
  /** 每租户每月成本硬上限（美元） */
  maxCostPerTenantMonthly: number;
  /** 全局每日成本硬上限（美元） */
  maxCostGlobalDaily: number;

  // ── 攻击检测阈值 ──────────────────────────────────────────────
  /** Token 洪水攻击阈值（单请求 token 数超过此值触发检测） */
  tokenFloodThreshold: number;
  /** 递归工具调用放大阈值（每分钟工具调用次数） */
  toolAmplificationThreshold: number;
  /** 并发请求爆发检测窗口（毫秒） */
  concurrentBurstWindowMs: number;
  /** 并发请求爆发阈值（窗口内请求数） */
  concurrentBurstThreshold: number;
  /** 上下文窗口填充阈值（累计 token 数） */
  contextStuffingTokenThreshold: number;
  /** 模型降级攻击成本倍数（新模型成本超过旧模型的 N 倍触发检测） */
  modelDegradationCostMultiplier: number;
  /** 重试风暴检测窗口（毫秒） */
  retryStormWindowMs: number;
  /** 重试风暴阈值（窗口内重试次数） */
  retryStormThreshold: number;

  // ── 熔断器阈值（硬上限的百分比） ────────────────────────────────
  /** 警告阈值（达到硬上限的此比例时发出警告，默认 0.8） */
  warnThreshold: number;
  /** 限流阈值（达到硬上限的此比例时开始限流，默认 0.9） */
  throttleThreshold: number;
  /** 熔断阈值（达到硬上限的此比例时立即熔断，默认 1.0） */
  meltThreshold: number;

  // ── 快照配置 ──────────────────────────────────────────────────
  /** 快照间隔（毫秒） */
  snapshotIntervalMs: number;
  /** 最大保存快照数 */
  maxSnapshots: number;

  // ── 定价配置 ──────────────────────────────────────────────────
  /** 每 1M token 成本（按模型，LiteLLM 不可用时回退使用） */
  costPer1MTokens: Record<string, number>;
  /** 预估安全边际系数（预估成本乘以此系数，保守估计，默认 1.2） */
  estimateSafetyMargin: number;

  // ── 会话管理 ──────────────────────────────────────────────────
  /** 会话最大空闲时间（毫秒，超过后自动清理） */
  sessionMaxIdleMs: number;
  /** 每租户最大活跃会话数 */
  maxSessionsPerTenant: number;

  // ── 功能开关 ──────────────────────────────────────────────────
  /** 启用自动熔断 */
  enableAutoMelt: boolean;
  /** 启用攻击模式检测 */
  enableAttackDetection: boolean;
  /** 启用 CostGuard 二次检查 */
  enableCostGuardIntegration: boolean;
}

/**
 * 账单防护当前成本状态接口。
 */
export interface BillGuardState {
  /** 租户 ID */
  tenantId: string;
  /** 当前会话成本（美元） */
  sessionCost: number;
  /** 当前会话 token 数 */
  sessionTokens: number;
  /** 当前会话工具调用次数 */
  sessionToolCalls: number;
  /** 上下文累计 token 数 */
  contextTokens: number;
  /** 当日成本（美元） */
  dailyCost: number;
  /** 当日 token 数 */
  dailyTokens: number;
  /** 当日日期标记 */
  dailyDate: string;
  /** 当月成本（美元） */
  monthlyCost: number;
  /** 当月 token 数 */
  monthlyTokens: number;
  /** 当月月份标记 */
  monthlyDate: string;
  /** 全局当日成本（美元） */
  globalDailyCost: number;
  /** 全局当日 token 数 */
  globalDailyTokens: number;
  /** 全局当日日期标记 */
  globalDailyDate: string;
  /** 是否已熔断 */
  melted: boolean;
  /** 熔断原因 */
  meltReason: string | undefined;
  /** 熔断时间戳 */
  meltedAt: number | undefined;
  /** 熔断作用域 */
  meltScope: string | undefined;
  /** 是否被限流 */
  throttled: boolean;
  /** 是否已发出警告 */
  warned: boolean;
  /** 活跃会话数 */
  activeSessions: number;
  /** 全局是否已熔断 */
  globalMelted: boolean;
}

/**
 * 成本检查结果接口。
 */
export interface CostCheckResult {
  /** 是否允许调用 */
  allowed: boolean;
  /** 执行动作 */
  action: BillGuardAction;
  /** 拒绝/警告原因 */
  reason: string;
  /** 预估/实际成本（美元） */
  estimatedCost: number;
  /** 剩余预算（美元，取所有层级中最小的剩余值） */
  remainingBudget: number;
  /** 检测到的攻击模式（如有） */
  attackPattern: BillAttackPattern | undefined;
  /** 触发限制的层级（如有） */
  limitScope: string | undefined;
  /** 当前各层级成本快照 */
  currentCosts: {
    session: number;
    daily: number;
    monthly: number;
    globalDaily: number;
  };
  /** 检查时间戳 */
  timestamp: string;
}

/**
 * 成本快照接口 —— 用于持久化和恢复。
 */
export interface CostSnapshot {
  /** 快照版本号 */
  version: number;
  /** 快照时间戳（ISO 格式） */
  timestamp: string;
  /** 租户 ID */
  tenantId: string;
  /** 租户成本数据 */
  tenant: {
    dailyCost: number;
    dailyTokens: number;
    dailyDate: string;
    monthlyCost: number;
    monthlyTokens: number;
    monthlyDate: string;
    melted: boolean;
    meltReason: string | undefined;
    meltedAt: number | undefined;
    meltScope: string | undefined;
    throttled: boolean;
    warned: boolean;
    lastModel: string | undefined;
    modelCostHistory: Array<{ model: string; cost: number; timestamp: number }>;
  };
  /** 会话数据数组 */
  sessions: Array<{
    sessionId: string;
    cost: number;
    tokens: number;
    toolCalls: number;
    contextTokens: number;
    lastActiveAt: number;
  }>;
  /** 全局当日状态 */
  globalDaily: {
    date: string;
    cost: number;
    tokens: number;
  };
  /** 全局是否已熔断 */
  globalMelted: boolean;
}

/**
 * 成本报告接口。
 */
export interface BillCostReport {
  /** 租户 ID */
  tenantId: string;
  /** 会话成本信息 */
  session: {
    cost: number;
    tokens: number;
    toolCalls: number;
    contextTokens: number;
    limit: number;
    utilization: number;
    activeSessions: number;
  };
  /** 当日成本信息 */
  daily: {
    cost: number;
    tokens: number;
    date: string;
    limit: number;
    utilization: number;
  };
  /** 当月成本信息 */
  monthly: {
    cost: number;
    tokens: number;
    month: string;
    limit: number;
    utilization: number;
  };
  /** 全局当日成本信息 */
  globalDaily: {
    cost: number;
    tokens: number;
    date: string;
    limit: number;
    utilization: number;
  };
  /** 每次请求限制 */
  perRequest: {
    costLimit: number;
    tokenLimit: number;
  };
  /** 状态信息 */
  status: {
    melted: boolean;
    throttled: boolean;
    warned: boolean;
    meltReason: string | undefined;
    meltedAt: string | undefined;
    meltScope: string | undefined;
    globalMelted: boolean;
  };
  /** 熔断器信息 */
  circuitBreaker: {
    warnThreshold: number;
    throttleThreshold: number;
    meltThreshold: number;
    maxUtilization: number;
    maxUtilizationScope: string;
  };
  /** 报告生成时间 */
  generatedAt: string;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: BillGuardConfig = {
  // 硬性成本上限
  maxCostPerRequest: 5.0,
  maxTokensPerRequest: 100_000,
  maxCostPerSession: 50.0,
  maxTokensPerSession: 1_000_000,
  maxCostPerTenantDaily: 500.0,
  maxCostPerTenantMonthly: 10_000.0,
  maxCostGlobalDaily: 5_000.0,

  // 攻击检测阈值
  tokenFloodThreshold: 50_000,
  toolAmplificationThreshold: 60,
  concurrentBurstWindowMs: 60_000,
  concurrentBurstThreshold: 30,
  contextStuffingTokenThreshold: 200_000,
  modelDegradationCostMultiplier: 5,
  retryStormWindowMs: 300_000,
  retryStormThreshold: 10,

  // 熔断器阈值
  warnThreshold: 0.8,
  throttleThreshold: 0.9,
  meltThreshold: 1.0,

  // 快照配置
  snapshotIntervalMs: 300_000,
  maxSnapshots: 100,

  // 定价配置
  costPer1MTokens: {
    'gpt-4o': 5.0,
    'gpt-4o-mini': 0.15,
    'claude-3-opus': 15.0,
    'claude-3-sonnet': 3.0,
    'claude-3-haiku': 0.25,
    'gemini-1.5-pro': 3.5,
    'gemini-1.5-flash': 0.075,
    'deepseek-v3': 0.27,
    default: 5.0,
  },
  estimateSafetyMargin: 1.2,

  // 会话管理
  sessionMaxIdleMs: 30 * 60 * 1000,
  maxSessionsPerTenant: 100,

  // 功能开关
  enableAutoMelt: true,
  enableAttackDetection: true,
  enableCostGuardIntegration: true,
};

// ============================================================================
// 成本预估辅助函数
// ============================================================================

/**
 * 预估 token 成本（美元）。
 *
 * 优先使用 LiteLLM 实时定价，不可用时回退到配置中的硬编码定价。
 * 支持缓存命中率感知的混合成本预估。
 *
 * @param tokens - token 数量
 * @param model - 模型 ID
 * @param config - 账单防护配置
 * @param cacheHitRatio - 缓存命中率（0-1），默认 0
 * @returns 预估成本（美元）
 */
function estimateCost(
  tokens: number,
  model: string,
  config: BillGuardConfig,
  cacheHitRatio = 0,
): number {
  const litellm = getLiteLLMPricing();

  // 缓存感知预估
  if (cacheHitRatio > 0) {
    const cacheRate = litellm.getCacheReadCostPer1MTokens(model);
    const fullRate =
      litellm.getCostPer1MTokens(model) ??
      config.costPer1MTokens[model] ??
      config.costPer1MTokens['default'] ??
      5.0;
    if (cacheRate !== undefined) {
      const blendedRate = cacheHitRatio * cacheRate + (1 - cacheHitRatio) * fullRate;
      return (tokens / 1_000_000) * blendedRate;
    }
  }

  // LiteLLM 实时定价
  const litellmRate = litellm.getCostPer1MTokens(model);
  if (litellmRate !== undefined) {
    return (tokens / 1_000_000) * litellmRate;
  }

  // 回退到硬编码定价
  const rate = config.costPer1MTokens[model] ?? config.costPer1MTokens['default'] ?? 5.0;
  return (tokens / 1_000_000) * rate;
}

/**
 * 计算利用率（当前值 / 上限值）。
 * 对于 Infinity 上限返回 0（无限制）。
 *
 * @param current - 当前值
 * @param limit - 上限值
 * @returns 利用率（0-1+），无限制时返回 0
 */
function computeUtilization(current: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return current / limit;
}

// ============================================================================
// 模块级共享状态（跨所有实例共享）
// ============================================================================

/**
 * 全局当日状态 —— 所有租户实例共享，用于全局每日成本上限。
 */
interface GlobalDailyState {
  date: string;
  cost: number;
  tokens: number;
  melted: boolean;
  meltReason: string | undefined;
  meltedAt: number | undefined;
}

const globalDailyState: GlobalDailyState = {
  date: '',
  cost: 0,
  tokens: 0,
  melted: false,
  meltReason: undefined,
  meltedAt: undefined,
};

/**
 * 所有租户的成本状态映射 —— 跨实例共享，支持跨租户查询。
 */
const sharedTenantStates = new Map<string, TenantCostState>();

// ============================================================================
// 日期辅助函数
// ============================================================================

/** 获取当前日期字符串（YYYY-MM-DD） */
function getDateString(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 获取当前月份字符串（YYYY-MM） */
function getMonthString(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 检查并执行全局每日周期滚动。
 * 当日期变更时重置全局当日成本和熔断状态。
 */
function rolloverGlobalDailyIfNeeded(): void {
  const today = getDateString(new Date());
  if (globalDailyState.date !== today) {
    globalDailyState.date = today;
    globalDailyState.cost = 0;
    globalDailyState.tokens = 0;
    // 新的一天，解除全局熔断
    if (globalDailyState.melted) {
      globalDailyState.melted = false;
      globalDailyState.meltReason = undefined;
      globalDailyState.meltedAt = undefined;
    }
  }
}

// ============================================================================
// BillExplosionGuard 类
// ============================================================================

/**
 * 账单爆炸防护系统 —— 不可绕过的多层级成本控制。
 *
 * 在 LLM 调用前和调用后都执行强制成本检查，确保成本永不超限。
 * 支持五层硬性成本上限、六种攻击模式检测、自动熔断机制和成本持久化。
 *
 * @example
 * ```typescript
 * const guard = getBillExplosionGuard();
 *
 * // LLM 调用前检查
 * const before = guard.checkBeforeCall({
 *   sessionId: 'sess-123',
 *   model: 'gpt-4o',
 *   estimatedTokens: 5000,
 * });
 * if (!before.allowed) {
 *   throw new Error(`请求被拒绝: ${before.reason}`);
 * }
 *
 * // 执行 LLM 调用...
 *
 * // LLM 调用后记录实际成本
 * const after = guard.recordAfterCall({
 *   sessionId: 'sess-123',
 *   model: 'gpt-4o',
 *   inputTokens: 3000,
 *   outputTokens: 2500,
 * });
 * if (after.action === 'MELT') {
 *   // 租户已被熔断，停止后续调用
 * }
 * ```
 */
export class BillExplosionGuard {
  private config: BillGuardConfig;
  private snapshots: CostSnapshot[] = [];
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param config - 部分配置，与默认配置合并
   */
  constructor(config?: Partial<BillGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 配置管理 ──────────────────────────────────────────────────

  /**
   * 运行时重新配置。
   * @param config - 部分配置，与当前配置合并
   */
  reconfigure(config: Partial<BillGuardConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置。
   * @returns 当前配置的只读副本
   */
  getConfig(): Readonly<BillGuardConfig> {
    return { ...this.config };
  }

  // ── 核心：LLM 调用前检查 ─────────────────────────────────────

  /**
   * LLM 调用前检查 —— 预估成本并验证所有硬上限。
   *
   * 此方法在 LLM 调用前执行，预估请求成本并检查是否会超出任何层级的硬上限。
   * 同时执行攻击模式检测和 CostGuard 二次验证。
   *
   * **不可绕过**：调用方必须在每次 LLM 调用前调用此方法，否则成本上限无法生效。
   *
   * @param params.tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @param params.sessionId - 会话 ID
   * @param params.model - 使用的模型 ID
   * @param params.estimatedTokens - 预估 token 数（输入 + 输出）
   * @param params.input - 用户输入文本（用于攻击模式检测，可选）
   * @param params.cacheHitRatio - 缓存命中率 0-1（可选，用于成本预估）
   * @param params.isRetry - 是否为重试请求（可选，用于重试风暴检测）
   * @param params.source - 请求来源标识（可选）
   * @returns 成本检查结果
   */
  checkBeforeCall(params: {
    tenantId?: string;
    sessionId?: string;
    model: string;
    estimatedTokens: number;
    input?: string;
    cacheHitRatio?: number;
    isRetry?: boolean;
    source?: string;
  }): CostCheckResult {
    const {
      sessionId,
      model,
      estimatedTokens,
      input,
      cacheHitRatio,
      isRetry,
      source,
    } = params;
    const tenantId = this.resolveTenantId(params.tenantId);
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    // 获取租户状态和会话状态
    const state = this.getOrCreateTenantState(tenantId);
    this.rolloverPeriodsIfNeeded(state);
    const session = this.getOrCreateSession(state, sessionId ?? 'default');

    // ── 检查熔断状态 ──────────────────────────────────────────
    if (state.melted) {
      return this.buildResult(
        false,
        'MELT',
        `租户已熔断: ${state.meltReason ?? '未知原因'}（作用域: ${state.meltScope ?? 'unknown'}）`,
        0,
        0,
        undefined,
        state.meltScope,
        state,
        session,
        timestamp,
      );
    }

    if (globalDailyState.melted) {
      return this.buildResult(
        false,
        'MELT',
        `全局熔断: ${globalDailyState.meltReason ?? '全局每日成本上限已达'}`,
        0,
        0,
        undefined,
        'global_daily',
        state,
        session,
        timestamp,
      );
    }

    // ── 记录请求时间戳（用于并发爆发检测） ────────────────────
    session.requestTimestamps.push(now);
    const burstWindowStart = now - this.config.concurrentBurstWindowMs;
    session.requestTimestamps = session.requestTimestamps.filter(
      (t) => t > burstWindowStart,
    );

    // ── 记录重试时间戳（用于重试风暴检测） ────────────────────
    if (isRetry) {
      session.retryTimestamps.push(now);
      const retryWindowStart = now - this.config.retryStormWindowMs;
      session.retryTimestamps = session.retryTimestamps.filter(
        (t) => t > retryWindowStart,
      );
    }

    // ── 预估成本（含安全边际） ────────────────────────────────
    const baseCost = estimateCost(
      estimatedTokens,
      model,
      this.config,
      cacheHitRatio ?? 0,
    );
    const estimatedCost = baseCost * this.config.estimateSafetyMargin;

    // ── 攻击模式检测 ──────────────────────────────────────────
    if (this.config.enableAttackDetection) {
      const attack = this.detectAttackPatterns(
        state,
        session,
        model,
        estimatedTokens,
        input,
        isRetry ?? false,
        now,
      );
      if (attack) {
        const action: BillGuardAction =
          attack === 'token_flood' && estimatedTokens > this.config.maxTokensPerRequest
            ? 'MELT'
            : 'THROTTLE';

        if (action === 'MELT') {
          this.applyMelt(state, tenantId, `攻击检测: ${attack}`, attack);
        }

        this.logSecurityEvent(
          action === 'MELT' ? 'critical' : 'high',
          `攻击模式检测: ${attack}`,
          { tenantId, sessionId, model, estimatedTokens, attack, action },
        );

        return this.buildResult(
          false,
          action,
          `攻击检测触发: ${attack}`,
          estimatedCost,
          this.computeRemainingBudget(state, session, estimatedCost),
          attack,
          attack,
          state,
          session,
          timestamp,
        );
      }
    }

    // ── Token 硬上限检查 ──────────────────────────────────────
    if (estimatedTokens > this.config.maxTokensPerRequest) {
      this.applyMelt(state, tenantId, 'token_flood', 'token_flood');
      this.logSecurityEvent(
        'critical',
        `Token 硬上限超出: ${estimatedTokens} > ${this.config.maxTokensPerRequest}`,
        { tenantId, sessionId, model, estimatedTokens },
      );
      return this.buildResult(
        false,
        'MELT',
        `单次请求 token 数 ${estimatedTokens} 超过硬上限 ${this.config.maxTokensPerRequest}`,
        estimatedCost,
        0,
        'token_flood',
        'request',
        state,
        session,
        timestamp,
      );
    }

    if (session.tokens + estimatedTokens > this.config.maxTokensPerSession) {
      return this.buildResult(
        false,
        'THROTTLE',
        `会话 token 总数 ${session.tokens + estimatedTokens} 将超过硬上限 ${this.config.maxTokensPerSession}`,
        estimatedCost,
        0,
        undefined,
        'session',
        state,
        session,
        timestamp,
      );
    }

    // ── 成本硬上限检查（预估） ────────────────────────────────
    const capCheck = this.checkHardCaps(state, session, estimatedCost);
    if (capCheck) {
      const action: BillGuardAction =
        capCheck.scope === 'request' ? 'MELT' : 'THROTTLE';

      if (action === 'MELT') {
        this.applyMelt(state, tenantId, capCheck.reason, capCheck.scope);
      }

      this.logSecurityEvent(
        action === 'MELT' ? 'critical' : 'high',
        `硬上限检查失败: ${capCheck.reason}`,
        { tenantId, sessionId, model, estimatedCost, scope: capCheck.scope },
      );

      return this.buildResult(
        false,
        action,
        capCheck.reason,
        estimatedCost,
        0,
        undefined,
        capCheck.scope,
        state,
        session,
        timestamp,
      );
    }

    // ── CostGuard 二次检查 ────────────────────────────────────
    if (this.config.enableCostGuardIntegration) {
      const cgAction = this.consultCostGuard(
        tenantId,
        model,
        estimatedTokens,
        source ?? tenantId,
        input,
      );
      if (cgAction === 'MELT') {
        this.applyMelt(state, tenantId, 'CostGuard 二次检查触发熔断', 'costguard');
        return this.buildResult(
          false,
          'MELT',
          'CostGuard 二次检查触发熔断',
          estimatedCost,
          this.computeRemainingBudget(state, session, estimatedCost),
          undefined,
          'costguard',
          state,
          session,
          timestamp,
        );
      }
      if (cgAction === 'THROTTLE') {
        return this.buildResult(
          false,
          'THROTTLE',
          'CostGuard 二次检查触发限流',
          estimatedCost,
          this.computeRemainingBudget(state, session, estimatedCost),
          undefined,
          'costguard',
          state,
          session,
          timestamp,
        );
      }
    }

    // ── 检查限流状态 ──────────────────────────────────────────
    if (state.throttled) {
      return this.buildResult(
        false,
        'THROTTLE',
        '租户当前被限流（成本已达限流阈值）',
        estimatedCost,
        this.computeRemainingBudget(state, session, estimatedCost),
        undefined,
        'throttle',
        state,
        session,
        timestamp,
      );
    }

    // ── 检查警告状态 ──────────────────────────────────────────
    const cbAction = this.computeCircuitBreakerAction(state, session);
    if (cbAction.action === 'WARN' && !state.warned) {
      state.warned = true;
      this.logSecurityEvent(
        'medium',
        `成本警告: 已达 ${this.config.warnThreshold * 100}% 上限（作用域: ${cbAction.maxUtilizationScope}）`,
        { tenantId, sessionId, utilization: cbAction.maxUtilization, scope: cbAction.maxUtilizationScope },
      );
    }

    // ── 更新最后使用的模型 ────────────────────────────────────
    state.lastModel = model;

    // ── 返回允许结果 ──────────────────────────────────────────
    return this.buildResult(
      true,
      cbAction.action === 'WARN' ? 'WARN' : 'ALLOW',
      cbAction.action === 'WARN'
        ? `成本警告: 已达 ${this.config.warnThreshold * 100}% 上限`
        : '请求允许通过',
      estimatedCost,
      this.computeRemainingBudget(state, session, estimatedCost),
      undefined,
      undefined,
      state,
      session,
      timestamp,
    );
  }

  // ── 核心：LLM 调用后记录 ─────────────────────────────────────

  /**
   * LLM 调用后记录实际成本 —— 实时更新所有成本计数器并检查熔断器。
   *
   * 此方法在 LLM 调用完成后执行，记录实际发生的成本，并检查是否触发了
   * 熔断器阈值。即使调用前预估通过，如果实际成本导致超限，也会触发熔断。
   *
   * **不可绕过**：调用方必须在每次 LLM 调用后调用此方法，确保成本被准确追踪。
   *
   * @param params.tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @param params.sessionId - 会话 ID
   * @param params.model - 使用的模型 ID
   * @param params.inputTokens - 实际输入 token 数
   @param params.outputTokens - 实际输出 token 数
   * @param params.actualCost - 实际成本（可选，未提供时自动计算）
   * @param params.cacheHitRatio - 缓存命中率 0-1（可选）
   * @returns 成本检查结果（包含调用后状态和触发的熔断器动作）
   */
  recordAfterCall(params: {
    tenantId?: string;
    sessionId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    actualCost?: number;
    cacheHitRatio?: number;
  }): CostCheckResult {
    const { sessionId, model, inputTokens, outputTokens, cacheHitRatio } = params;
    const tenantId = this.resolveTenantId(params.tenantId);
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const totalTokens = inputTokens + outputTokens;

    // 获取状态
    const state = this.getOrCreateTenantState(tenantId);
    this.rolloverPeriodsIfNeeded(state);
    rolloverGlobalDailyIfNeeded();
    const session = this.getOrCreateSession(state, sessionId ?? 'default');

    // 计算实际成本
    const actualCost =
      params.actualCost ??
      estimateCost(totalTokens, model, this.config, cacheHitRatio ?? 0);

    // ── 更新会话成本 ──────────────────────────────────────────
    session.cost += actualCost;
    session.tokens += totalTokens;
    session.contextTokens += totalTokens;
    session.lastActiveAt = now;

    // ── 更新租户当日成本 ──────────────────────────────────────
    state.dailyCost += actualCost;
    state.dailyTokens += totalTokens;

    // ── 更新租户当月成本 ──────────────────────────────────────
    state.monthlyCost += actualCost;
    state.monthlyTokens += totalTokens;

    // ── 更新全局当日成本 ──────────────────────────────────────
    globalDailyState.cost += actualCost;
    globalDailyState.tokens += totalTokens;

    // ── 更新模型成本历史 ──────────────────────────────────────
    state.modelCostHistory.push({ model, cost: actualCost, timestamp: now });
    if (state.modelCostHistory.length > 50) {
      state.modelCostHistory.shift();
    }
    state.lastModel = model;

    // ── 检查熔断器 ────────────────────────────────────────────
    const cb = this.computeCircuitBreakerAction(state, session);
    let action: BillGuardAction = cb.action;
    let reason = '成本已记录';

    if (action === 'MELT') {
      this.applyMelt(
        state,
        tenantId,
        `熔断器触发: 成本已达 ${this.config.meltThreshold * 100}% 上限（作用域: ${cb.maxUtilizationScope}）`,
        cb.maxUtilizationScope,
      );
      reason = `熔断触发: 成本已达 ${this.config.meltThreshold * 100}% 硬上限（作用域: ${cb.maxUtilizationScope}）`;

      // 全局熔断
      if (cb.maxUtilizationScope === 'global_daily') {
        globalDailyState.melted = true;
        globalDailyState.meltReason = reason;
        globalDailyState.meltedAt = now;
      }

      this.logSecurityEvent('critical', reason, {
        tenantId,
        sessionId,
        model,
        actualCost,
        totalTokens,
        utilization: cb.maxUtilization,
        scope: cb.maxUtilizationScope,
      });
    } else if (action === 'THROTTLE') {
      state.throttled = true;
      reason = `限流触发: 成本已达 ${this.config.throttleThreshold * 100}% 上限（作用域: ${cb.maxUtilizationScope}）`;
      this.logSecurityEvent('high', reason, {
        tenantId,
        sessionId,
        model,
        actualCost,
        utilization: cb.maxUtilization,
        scope: cb.maxUtilizationScope,
      });
    } else if (action === 'WARN') {
      if (!state.warned) {
        state.warned = true;
      }
      reason = `成本警告: 已达 ${this.config.warnThreshold * 100}% 上限（作用域: ${cb.maxUtilizationScope}）`;
      this.logSecurityEvent('medium', reason, {
        tenantId,
        sessionId,
        model,
        actualCost,
        utilization: cb.maxUtilization,
        scope: cb.maxUtilizationScope,
      });
    }

    // ── 记录指标 ──────────────────────────────────────────────
    this.recordMetrics('afterCall', action, {
      tenantId,
      model,
      actualCost,
      totalTokens,
      utilization: cb.maxUtilization,
    });

    // ── 记录到审计链 ──────────────────────────────────────────
    this.logChainEvent({
      event: 'bill_guard_after_call',
      tenantId,
      sessionId,
      model,
      inputTokens,
      outputTokens,
      actualCost,
      action,
      utilization: cb.maxUtilization,
      scope: cb.maxUtilizationScope,
    });

    return this.buildResult(
      action !== 'MELT',
      action,
      reason,
      actualCost,
      this.computeRemainingBudget(state, session, 0),
      undefined,
      action === 'MELT' ? cb.maxUtilizationScope : undefined,
      state,
      session,
      timestamp,
    );
  }

  // ── 核心：工具调用检查 ───────────────────────────────────────

  /**
   * 工具调用检查 —— 检测递归工具调用放大攻击。
   *
   * 在每次工具调用前执行，检测工具调用频率是否异常。
   * 如果工具调用频率超过阈值，触发限流或熔断。
   *
   * @param params.tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @param params.sessionId - 会话 ID
   * @param params.toolName - 工具名称
   * @param params.sequenceCallCount - 当前序列中的工具调用次数（可选）
   * @returns 成本检查结果
   */
  checkToolCall(params: {
    tenantId?: string;
    sessionId?: string;
    toolName: string;
    sequenceCallCount?: number;
  }): CostCheckResult {
    const { sessionId, toolName, sequenceCallCount } = params;
    const tenantId = this.resolveTenantId(params.tenantId);
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    const state = this.getOrCreateTenantState(tenantId);
    this.rolloverPeriodsIfNeeded(state);
    const session = this.getOrCreateSession(state, sessionId ?? 'default');

    // 检查熔断状态
    if (state.melted) {
      return this.buildResult(
        false,
        'MELT',
        `租户已熔断: ${state.meltReason ?? '未知原因'}`,
        0,
        0,
        undefined,
        state.meltScope,
        state,
        session,
        timestamp,
      );
    }

    if (globalDailyState.melted) {
      return this.buildResult(
        false,
        'MELT',
        `全局熔断: ${globalDailyState.meltReason ?? '全局每日成本上限已达'}`,
        0,
        0,
        undefined,
        'global_daily',
        state,
        session,
        timestamp,
      );
    }

    // 记录工具调用
    session.toolCalls++;
    session.recentToolCallTimestamps.push(now);

    // 清理旧的工具调用记录
    const oneMinuteAgo = now - 60_000;
    session.recentToolCallTimestamps = session.recentToolCallTimestamps.filter(
      (t) => t > oneMinuteAgo,
    );
    const callsPerMinute = session.recentToolCallTimestamps.length;

    // 检查限流状态
    if (state.throttled) {
      return this.buildResult(
        false,
        'THROTTLE',
        '租户当前被限流，工具调用被拒绝',
        0,
        this.computeRemainingBudget(state, session, 0),
        undefined,
        'throttle',
        state,
        session,
        timestamp,
      );
    }

    // ── 检测工具调用放大 ──────────────────────────────────────
    if (this.config.enableAttackDetection) {
      // 每分钟工具调用频率检测
      if (callsPerMinute > this.config.toolAmplificationThreshold * 2) {
        this.applyMelt(
          state,
          tenantId,
          `工具调用放大攻击: ${callsPerMinute} 次/分钟（阈值: ${this.config.toolAmplificationThreshold * 2}）`,
          'tool_amplification',
        );
        this.logSecurityEvent(
          'critical',
          `工具调用放大熔断: ${callsPerMinute} 次/分钟`,
          { tenantId, sessionId, toolName, callsPerMinute },
        );
        return this.buildResult(
          false,
          'MELT',
          `工具调用放大攻击: ${callsPerMinute} 次/分钟，触发熔断`,
          0,
          0,
          'tool_amplification',
          'tool_amplification',
          state,
          session,
          timestamp,
        );
      }

      if (callsPerMinute > this.config.toolAmplificationThreshold) {
        this.logSecurityEvent(
          'high',
          `工具调用放大警告: ${callsPerMinute} 次/分钟`,
          { tenantId, sessionId, toolName, callsPerMinute },
        );
        return this.buildResult(
          false,
          'THROTTLE',
          `工具调用频率 ${callsPerMinute} 次/分钟超过阈值 ${this.config.toolAmplificationThreshold}`,
          0,
          this.computeRemainingBudget(state, session, 0),
          'tool_amplification',
          'tool_amplification',
          state,
          session,
          timestamp,
        );
      }

      // 序列工具调用次数检测
      if (sequenceCallCount !== undefined && sequenceCallCount > 500) {
        this.applyMelt(
          state,
          tenantId,
          `工具调用序列过长: ${sequenceCallCount} 次`,
          'tool_amplification',
        );
        return this.buildResult(
          false,
          'MELT',
          `工具调用序列过长: ${sequenceCallCount} 次，触发熔断`,
          0,
          0,
          'tool_amplification',
          'tool_amplification',
          state,
          session,
          timestamp,
        );
      }
    }

    // 记录指标
    this.recordMetrics('toolCall', 'ALLOW', { tenantId, toolName, callsPerMinute });

    return this.buildResult(
      true,
      'ALLOW',
      `工具调用允许: ${toolName}`,
      0,
      this.computeRemainingBudget(state, session, 0),
      undefined,
      undefined,
      state,
      session,
      timestamp,
    );
  }

  // ── 报告 ─────────────────────────────────────────────────────

  /**
   * 获取成本报告 —— 全面的成本状态和利用率报告。
   *
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @param sessionId - 会话 ID（可选，指定后仅报告该会话，否则聚合所有会话）
   * @returns 成本报告
   */
  getCostReport(tenantId?: string, sessionId?: string): BillCostReport {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    this.rolloverPeriodsIfNeeded(state);
    rolloverGlobalDailyIfNeeded();

    // 聚合会话成本或使用指定会话
    let sessionCost = 0;
    let sessionTokens = 0;
    let sessionToolCalls = 0;
    let contextTokens = 0;

    if (sessionId) {
      const session = state.sessions.get(sessionId);
      if (session) {
        sessionCost = session.cost;
        sessionTokens = session.tokens;
        sessionToolCalls = session.toolCalls;
        contextTokens = session.contextTokens;
      }
    } else {
      for (const session of state.sessions.values()) {
        sessionCost += session.cost;
        sessionTokens += session.tokens;
        sessionToolCalls += session.toolCalls;
        contextTokens += session.contextTokens;
      }
    }

    // 计算利用率
    const sessionUtil = computeUtilization(sessionCost, this.config.maxCostPerSession);
    const dailyUtil = computeUtilization(state.dailyCost, this.config.maxCostPerTenantDaily);
    const monthlyUtil = computeUtilization(state.monthlyCost, this.config.maxCostPerTenantMonthly);
    const globalUtil = computeUtilization(globalDailyState.cost, this.config.maxCostGlobalDaily);

    const maxUtilization = Math.max(sessionUtil, dailyUtil, monthlyUtil, globalUtil);
    const utils: Array<{ scope: string; value: number }> = [
      { scope: 'session', value: sessionUtil },
      { scope: 'daily', value: dailyUtil },
      { scope: 'monthly', value: monthlyUtil },
      { scope: 'global_daily', value: globalUtil },
    ];
    const maxUtilScope = utils.reduce((max, cur) => (cur.value > max.value ? cur : max)).scope;

    return {
      tenantId: tid,
      session: {
        cost: sessionCost,
        tokens: sessionTokens,
        toolCalls: sessionToolCalls,
        contextTokens,
        limit: this.config.maxCostPerSession,
        utilization: sessionUtil,
        activeSessions: state.sessions.size,
      },
      daily: {
        cost: state.dailyCost,
        tokens: state.dailyTokens,
        date: state.dailyDate,
        limit: this.config.maxCostPerTenantDaily,
        utilization: dailyUtil,
      },
      monthly: {
        cost: state.monthlyCost,
        tokens: state.monthlyTokens,
        month: state.monthlyDate,
        limit: this.config.maxCostPerTenantMonthly,
        utilization: monthlyUtil,
      },
      globalDaily: {
        cost: globalDailyState.cost,
        tokens: globalDailyState.tokens,
        date: globalDailyState.date,
        limit: this.config.maxCostGlobalDaily,
        utilization: globalUtil,
      },
      perRequest: {
        costLimit: this.config.maxCostPerRequest,
        tokenLimit: this.config.maxTokensPerRequest,
      },
      status: {
        melted: state.melted,
        throttled: state.throttled,
        warned: state.warned,
        meltReason: state.meltReason,
        meltedAt: state.meltedAt ? new Date(state.meltedAt).toISOString() : undefined,
        meltScope: state.meltScope,
        globalMelted: globalDailyState.melted,
      },
      circuitBreaker: {
        warnThreshold: this.config.warnThreshold,
        throttleThreshold: this.config.throttleThreshold,
        meltThreshold: this.config.meltThreshold,
        maxUtilization,
        maxUtilizationScope: maxUtilScope,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── 快照管理 ─────────────────────────────────────────────────

  /**
   * 获取成本快照 —— 用于持久化当前成本状态。
   *
   * 快照包含租户成本数据、所有会话数据和全局当日状态，
   * 可通过 restoreSnapshot() 恢复。
   *
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @returns 成本快照
   */
  takeSnapshot(tenantId?: string): CostSnapshot {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    const now = Date.now();
    state.lastSnapshotAt = now;

    return {
      version: 1,
      timestamp: new Date(now).toISOString(),
      tenantId: tid,
      tenant: {
        dailyCost: state.dailyCost,
        dailyTokens: state.dailyTokens,
        dailyDate: state.dailyDate,
        monthlyCost: state.monthlyCost,
        monthlyTokens: state.monthlyTokens,
        monthlyDate: state.monthlyDate,
        melted: state.melted,
        meltReason: state.meltReason,
        meltedAt: state.meltedAt,
        meltScope: state.meltScope,
        throttled: state.throttled,
        warned: state.warned,
        lastModel: state.lastModel,
        modelCostHistory: [...state.modelCostHistory],
      },
      sessions: [...state.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        cost: s.cost,
        tokens: s.tokens,
        toolCalls: s.toolCalls,
        contextTokens: s.contextTokens,
        lastActiveAt: s.lastActiveAt,
      })),
      globalDaily: {
        date: globalDailyState.date,
        cost: globalDailyState.cost,
        tokens: globalDailyState.tokens,
      },
      globalMelted: globalDailyState.melted,
    };
  }

  /**
   * 恢复成本快照 —— 从快照恢复成本状态。
   *
   * 恢复租户级别的成本数据和会话数据。
   * 全局状态仅在日期匹配时恢复，避免影响其他租户。
   *
   * @param snapshot - 要恢复的成本快照
   * @throws {Error} 快照版本不兼容时抛出错误
   */
  restoreSnapshot(snapshot: CostSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(`不支持的快照版本: ${snapshot.version}`);
    }

    const state = this.getOrCreateTenantState(snapshot.tenantId);

    // 恢复租户级别数据
    state.dailyCost = snapshot.tenant.dailyCost;
    state.dailyTokens = snapshot.tenant.dailyTokens;
    state.dailyDate = snapshot.tenant.dailyDate;
    state.monthlyCost = snapshot.tenant.monthlyCost;
    state.monthlyTokens = snapshot.tenant.monthlyTokens;
    state.monthlyDate = snapshot.tenant.monthlyDate;
    state.melted = snapshot.tenant.melted;
    state.meltReason = snapshot.tenant.meltReason;
    state.meltedAt = snapshot.tenant.meltedAt;
    state.meltScope = snapshot.tenant.meltScope;
    state.throttled = snapshot.tenant.throttled;
    state.warned = snapshot.tenant.warned;
    state.lastModel = snapshot.tenant.lastModel;
    state.modelCostHistory = [...snapshot.tenant.modelCostHistory];

    // 恢复会话数据
    state.sessions.clear();
    for (const s of snapshot.sessions) {
      state.sessions.set(s.sessionId, {
        sessionId: s.sessionId,
        cost: s.cost,
        tokens: s.tokens,
        toolCalls: s.toolCalls,
        contextTokens: s.contextTokens,
        requestTimestamps: [],
        retryTimestamps: [],
        recentToolCallTimestamps: [],
        lastActiveAt: s.lastActiveAt,
      });
    }

    // 全局状态仅在日期匹配时恢复
    if (snapshot.globalDaily.date === getDateString(new Date())) {
      globalDailyState.cost = snapshot.globalDaily.cost;
      globalDailyState.tokens = snapshot.globalDaily.tokens;
      globalDailyState.melted = snapshot.globalMelted;
    }

    this.logSecurityEvent(
      'medium',
      `成本快照已恢复: 租户 ${snapshot.tenantId}`,
      { tenantId: snapshot.tenantId, snapshotTimestamp: snapshot.timestamp },
    );
  }

  // ── 周期管理 ─────────────────────────────────────────────────

  /**
   * 重置计费周期 —— 清零指定周期的成本计数器。
   *
   * 重置 daily 或 monthly 周期时，如果熔断是由该周期触发的，
   * 则自动解除熔断（下一个计费周期自动恢复）。
   *
   * @param period - 要重置的计费周期
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   */
  resetPeriod(period: BillingPeriod, tenantId?: string): void {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    const now = new Date();

    switch (period) {
      case 'session': {
        // 重置所有会话
        for (const session of state.sessions.values()) {
          session.cost = 0;
          session.tokens = 0;
          session.toolCalls = 0;
          session.contextTokens = 0;
          session.requestTimestamps = [];
          session.retryTimestamps = [];
          session.recentToolCallTimestamps = [];
        }
        // 如果熔断由会话级别触发，解除熔断
        if (state.melted && state.meltScope === 'session') {
          state.melted = false;
          state.meltReason = undefined;
          state.meltedAt = undefined;
          state.meltScope = undefined;
        }
        state.throttled = false;
        state.warned = false;
        break;
      }
      case 'daily': {
        state.dailyCost = 0;
        state.dailyTokens = 0;
        state.dailyDate = getDateString(now);
        // 如果熔断由每日级别触发，解除熔断
        if (state.melted && (state.meltScope === 'daily' || state.meltScope === 'global_daily')) {
          state.melted = false;
          state.meltReason = undefined;
          state.meltedAt = undefined;
          state.meltScope = undefined;
        }
        state.throttled = false;
        state.warned = false;
        // 同步重置全局状态
        rolloverGlobalDailyIfNeeded();
        break;
      }
      case 'monthly': {
        state.monthlyCost = 0;
        state.monthlyTokens = 0;
        state.monthlyDate = getMonthString(now);
        // 如果熔断由每月级别触发，解除熔断
        if (state.melted && state.meltScope === 'monthly') {
          state.melted = false;
          state.meltReason = undefined;
          state.meltedAt = undefined;
          state.meltScope = undefined;
        }
        state.throttled = false;
        state.warned = false;
        break;
      }
    }

    this.logSecurityEvent(
      'medium',
      `计费周期已重置: ${period}（租户: ${tid}）`,
      { tenantId: tid, period },
    );
  }

  // ── 熔断管理 ─────────────────────────────────────────────────

  /**
   * 检查租户是否已熔断。
   *
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @returns 如果租户已熔断或全局已熔断，返回 true
   */
  isMelted(tenantId?: string): boolean {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    return state.melted || globalDailyState.melted;
  }

  /**
   * 手动解除熔断 —— 管理员操作。
   *
   * 解除指定租户的熔断状态。如果全局已熔断，也一并解除。
   * 此操作会记录到安全审计日志。
   *
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @returns 如果之前处于熔断状态返回 true
   */
  liftMelt(tenantId?: string): boolean {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    let lifted = false;

    if (state.melted) {
      state.melted = false;
      state.meltReason = undefined;
      state.meltedAt = undefined;
      state.meltScope = undefined;
      state.throttled = false;
      state.warned = false;
      lifted = true;
    }

    if (globalDailyState.melted) {
      globalDailyState.melted = false;
      globalDailyState.meltReason = undefined;
      globalDailyState.meltedAt = undefined;
      lifted = true;
    }

    if (lifted) {
      this.logSecurityEvent(
        'high',
        `熔断已手动解除: 租户 ${tid}`,
        { tenantId: tid, liftedBy: 'manual' },
      );
    }

    return lifted;
  }

  // ── 快照定时器 ───────────────────────────────────────────────

  /**
   * 启动定期快照定时器。
   * 按配置的 snapshotIntervalMs 间隔自动获取快照并存储在内存中。
   */
  startSnapshotTimer(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      try {
        // 为所有已知租户获取快照
        for (const tenantId of sharedTenantStates.keys()) {
          const snapshot = this.takeSnapshot(tenantId);
          this.snapshots.push(snapshot);
          if (this.snapshots.length > this.config.maxSnapshots) {
            this.snapshots.shift();
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'billExplosionGuard:snapshotTimer');
      }
    }, this.config.snapshotIntervalMs);

    if (typeof this.snapshotTimer.unref === 'function') {
      this.snapshotTimer.unref();
    }
  }

  /**
   * 停止定期快照定时器。
   */
  stopSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /**
   * 获取所有存储的快照。
   * @returns 快照数组的只读副本
   */
  getSnapshots(): readonly CostSnapshot[] {
    return [...this.snapshots];
  }

  // ── 状态获取 ─────────────────────────────────────────────────

  /**
   * 获取当前成本状态（用于调试/监控）。
   *
   * @param tenantId - 租户 ID（可选，默认为当前租户上下文）
   * @param sessionId - 会话 ID（可选，指定后返回该会话的状态）
   * @returns 当前成本状态
   */
  getState(tenantId?: string, sessionId?: string): BillGuardState {
    const tid = this.resolveTenantId(tenantId);
    const state = this.getOrCreateTenantState(tid);
    this.rolloverPeriodsIfNeeded(state);
    rolloverGlobalDailyIfNeeded();

    let sessionCost = 0;
    let sessionTokens = 0;
    let sessionToolCalls = 0;
    let contextTokens = 0;

    if (sessionId) {
      const session = state.sessions.get(sessionId);
      if (session) {
        sessionCost = session.cost;
        sessionTokens = session.tokens;
        sessionToolCalls = session.toolCalls;
        contextTokens = session.contextTokens;
      }
    } else {
      for (const session of state.sessions.values()) {
        sessionCost += session.cost;
        sessionTokens += session.tokens;
        sessionToolCalls += session.toolCalls;
        contextTokens += session.contextTokens;
      }
    }

    return {
      tenantId: tid,
      sessionCost,
      sessionTokens,
      sessionToolCalls,
      contextTokens,
      dailyCost: state.dailyCost,
      dailyTokens: state.dailyTokens,
      dailyDate: state.dailyDate,
      monthlyCost: state.monthlyCost,
      monthlyTokens: state.monthlyTokens,
      monthlyDate: state.monthlyDate,
      globalDailyCost: globalDailyState.cost,
      globalDailyTokens: globalDailyState.tokens,
      globalDailyDate: globalDailyState.date,
      melted: state.melted,
      meltReason: state.meltReason,
      meltedAt: state.meltedAt,
      meltScope: state.meltScope,
      throttled: state.throttled,
      warned: state.warned,
      activeSessions: state.sessions.size,
      globalMelted: globalDailyState.melted,
    };
  }

  // ── 完全重置 ─────────────────────────────────────────────────

  /**
   * 完全重置所有状态（用于测试隔离）。
   * 清除所有租户状态、全局状态和快照。
   */
  reset(): void {
    this.stopSnapshotTimer();
    sharedTenantStates.clear();
    globalDailyState.date = '';
    globalDailyState.cost = 0;
    globalDailyState.tokens = 0;
    globalDailyState.melted = false;
    globalDailyState.meltReason = undefined;
    globalDailyState.meltedAt = undefined;
    this.snapshots = [];
  }

  // ============================================================================
  // 内部辅助方法
  // ============================================================================

  /**
   * 解析租户 ID —— 优先使用参数，其次使用当前租户上下文，最后使用默认值。
   */
  private resolveTenantId(tenantId?: string): string {
    if (tenantId) return tenantId;
    try {
      const current = getCurrentTenantId();
      if (current) return current;
    } catch {
      // 租户上下文不可用，使用默认值
    }
    return 'default';
  }

  /**
   * 获取或创建租户状态。
   */
  private getOrCreateTenantState(tenantId: string): TenantCostState {
    let state = sharedTenantStates.get(tenantId);
    if (!state) {
      const now = new Date();
      state = {
        tenantId,
        sessions: new Map(),
        dailyCost: 0,
        dailyTokens: 0,
        dailyDate: getDateString(now),
        monthlyCost: 0,
        monthlyTokens: 0,
        monthlyDate: getMonthString(now),
        melted: false,
        meltReason: undefined,
        meltedAt: undefined,
        meltScope: undefined,
        throttled: false,
        warned: false,
        lastModel: undefined,
        modelCostHistory: [],
        lastSnapshotAt: undefined,
      };
      sharedTenantStates.set(tenantId, state);
    }
    return state;
  }

  /**
   * 获取或创建会话状态。
   * 同时清理过期的会话。
   */
  private getOrCreateSession(
    state: TenantCostState,
    sessionId: string,
  ): SessionState {
    let session = state.sessions.get(sessionId);
    if (!session) {
      this.cleanupOldSessions(state);
      session = {
        sessionId,
        cost: 0,
        tokens: 0,
        toolCalls: 0,
        contextTokens: 0,
        requestTimestamps: [],
        retryTimestamps: [],
        recentToolCallTimestamps: [],
        lastActiveAt: Date.now(),
      };
      state.sessions.set(sessionId, session);
    }
    session.lastActiveAt = Date.now();
    return session;
  }

  /**
   * 清理过期的会话。
   */
  private cleanupOldSessions(state: TenantCostState): void {
    const now = Date.now();
    // 清理超时会话
    for (const [id, session] of state.sessions) {
      if (now - session.lastActiveAt > this.config.sessionMaxIdleMs) {
        state.sessions.delete(id);
      }
    }
    // 强制限制最大会话数
    if (state.sessions.size > this.config.maxSessionsPerTenant) {
      const sorted = [...state.sessions.entries()].sort(
        (a, b) => a[1].lastActiveAt - b[1].lastActiveAt,
      );
      const toRemove = sorted.slice(
        0,
        state.sessions.size - this.config.maxSessionsPerTenant,
      );
      for (const [id] of toRemove) {
        state.sessions.delete(id);
      }
    }
  }

  /**
   * 检查并执行周期滚动（每日/每月）。
   */
  private rolloverPeriodsIfNeeded(state: TenantCostState): void {
    const now = new Date();
    const today = getDateString(now);
    const thisMonth = getMonthString(now);

    // 每日滚动
    if (state.dailyDate !== today) {
      state.dailyCost = 0;
      state.dailyTokens = 0;
      state.dailyDate = today;
      // 如果熔断由每日级别触发，自动解除
      if (state.melted && (state.meltScope === 'daily' || state.meltScope === 'global_daily')) {
        state.melted = false;
        state.meltReason = undefined;
        state.meltedAt = undefined;
        state.meltScope = undefined;
        state.throttled = false;
        state.warned = false;
      }
    }

    // 每月滚动
    if (state.monthlyDate !== thisMonth) {
      state.monthlyCost = 0;
      state.monthlyTokens = 0;
      state.monthlyDate = thisMonth;
      // 如果熔断由每月级别触发，自动解除
      if (state.melted && state.meltScope === 'monthly') {
        state.melted = false;
        state.meltReason = undefined;
        state.meltedAt = undefined;
        state.meltScope = undefined;
        state.throttled = false;
        state.warned = false;
      }
    }

    // 全局每日滚动
    rolloverGlobalDailyIfNeeded();
  }

  /**
   * 攻击模式检测 —— 检测六种经济攻击模式。
   *
   * @returns 检测到的攻击模式，未检测到返回 null
   */
  private detectAttackPatterns(
    state: TenantCostState,
    session: SessionState,
    model: string,
    estimatedTokens: number,
    input: string | undefined,
    isRetry: boolean,
    now: number,
  ): BillAttackPattern | null {
    // 1. Token 洪水攻击
    if (estimatedTokens > this.config.tokenFloodThreshold) {
      return 'token_flood';
    }

    // 2. 并发请求爆发
    const burstCount = session.requestTimestamps.length;
    if (burstCount > this.config.concurrentBurstThreshold * 2) {
      return 'concurrent_burst';
    }

    // 3. 上下文窗口填充
    if (
      session.contextTokens > this.config.contextStuffingTokenThreshold &&
      estimatedTokens > 10_000
    ) {
      return 'context_stuffing';
    }

    // 4. 模型降级攻击
    if (state.modelCostHistory.length > 0) {
      const lastEntry = state.modelCostHistory[state.modelCostHistory.length - 1];
      if (lastEntry && lastEntry.model !== model) {
        const lastCost = estimateCost(1000, lastEntry.model, this.config);
        const currentCost = estimateCost(1000, model, this.config);
        if (currentCost > lastCost * this.config.modelDegradationCostMultiplier) {
          return 'model_degradation';
        }
      }
    }

    // 5. 重试风暴
    if (isRetry && session.retryTimestamps.length > this.config.retryStormThreshold) {
      return 'retry_storm';
    }

    // 6. 输入模式检测（已知昂贵查询模式）
    if (input) {
      const expensivePatterns = [
        /analyze.{0,20}(every|each|all).{0,30}(paragraph|line|sentence|file)/i,
        /search.{0,20}(all|every|each).{0,20}(page|result|link)/i,
        /(recursive|infinite|forever|endless).{0,10}(loop|search|call|query)/i,
        /process.{0,10}(massive|huge|enormous|entire).{0,20}(dataset|database|corpus)/i,
        /generate.{0,10}(all|every).{0,20}(combination|permutation|possibility)/i,
        /repeat.{0,10}(this|the above).{0,10}(until|forever|indefinitely)/i,
      ];
      for (const pattern of expensivePatterns) {
        if (pattern.test(input)) {
          return 'token_flood';
        }
      }
    }

    return null;
  }

  /**
   * 硬上限检查 —— 检查预估成本是否会超出任何层级的硬上限。
   *
   * @returns 超限时返回包含 scope/reason/limit/projected 的对象，未超限返回 null
   */
  private checkHardCaps(
    state: TenantCostState,
    session: SessionState,
    estimatedCost: number,
  ): { scope: string; reason: string; limit: number; projected: number } | null {
    // 每次请求成本上限
    if (estimatedCost > this.config.maxCostPerRequest) {
      return {
        scope: 'request',
        reason: `单次请求预估成本 $${estimatedCost.toFixed(4)} 超过硬上限 $${this.config.maxCostPerRequest.toFixed(2)}`,
        limit: this.config.maxCostPerRequest,
        projected: estimatedCost,
      };
    }

    // 每会话成本上限
    const projectedSession = session.cost + estimatedCost;
    if (projectedSession > this.config.maxCostPerSession) {
      return {
        scope: 'session',
        reason: `会话预估总成本 $${projectedSession.toFixed(4)} 超过硬上限 $${this.config.maxCostPerSession.toFixed(2)}`,
        limit: this.config.maxCostPerSession,
        projected: projectedSession,
      };
    }

    // 每租户每日成本上限
    const projectedDaily = state.dailyCost + estimatedCost;
    if (projectedDaily > this.config.maxCostPerTenantDaily) {
      return {
        scope: 'daily',
        reason: `租户当日预估总成本 $${projectedDaily.toFixed(4)} 超过硬上限 $${this.config.maxCostPerTenantDaily.toFixed(2)}`,
        limit: this.config.maxCostPerTenantDaily,
        projected: projectedDaily,
      };
    }

    // 每租户每月成本上限
    const projectedMonthly = state.monthlyCost + estimatedCost;
    if (projectedMonthly > this.config.maxCostPerTenantMonthly) {
      return {
        scope: 'monthly',
        reason: `租户当月预估总成本 $${projectedMonthly.toFixed(4)} 超过硬上限 $${this.config.maxCostPerTenantMonthly.toFixed(2)}`,
        limit: this.config.maxCostPerTenantMonthly,
        projected: projectedMonthly,
      };
    }

    // 全局每日成本上限
    const projectedGlobal = globalDailyState.cost + estimatedCost;
    if (projectedGlobal > this.config.maxCostGlobalDaily) {
      return {
        scope: 'global_daily',
        reason: `全局当日预估总成本 $${projectedGlobal.toFixed(4)} 超过硬上限 $${this.config.maxCostGlobalDaily.toFixed(2)}`,
        limit: this.config.maxCostGlobalDaily,
        projected: projectedGlobal,
      };
    }

    return null;
  }

  /**
   * 计算熔断器动作 —— 基于当前成本利用率确定动作。
   *
   * @returns 包含 action、maxUtilization 和 maxUtilizationScope 的对象
   */
  private computeCircuitBreakerAction(
    state: TenantCostState,
    session: SessionState,
  ): {
    action: BillGuardAction;
    maxUtilization: number;
    maxUtilizationScope: string;
  } {
    const sessionUtil = computeUtilization(
      session.cost,
      this.config.maxCostPerSession,
    );
    const dailyUtil = computeUtilization(
      state.dailyCost,
      this.config.maxCostPerTenantDaily,
    );
    const monthlyUtil = computeUtilization(
      state.monthlyCost,
      this.config.maxCostPerTenantMonthly,
    );
    const globalUtil = computeUtilization(
      globalDailyState.cost,
      this.config.maxCostGlobalDaily,
    );

    const utils: Array<{ scope: string; value: number }> = [
      { scope: 'session', value: sessionUtil },
      { scope: 'daily', value: dailyUtil },
      { scope: 'monthly', value: monthlyUtil },
      { scope: 'global_daily', value: globalUtil },
    ];

    const maxEntry = utils.reduce((max, cur) =>
      cur.value > max.value ? cur : max,
    );
    const maxUtilization = maxEntry.value;
    const maxUtilizationScope = maxEntry.scope;

    let action: BillGuardAction = 'ALLOW';
    if (maxUtilization >= this.config.meltThreshold) {
      action = 'MELT';
    } else if (maxUtilization >= this.config.throttleThreshold) {
      action = 'THROTTLE';
    } else if (maxUtilization >= this.config.warnThreshold) {
      action = 'WARN';
    }

    return { action, maxUtilization, maxUtilizationScope };
  }

  /**
   * 计算剩余预算 —— 取所有层级中最小的剩余值。
   */
  private computeRemainingBudget(
    state: TenantCostState,
    session: SessionState,
    estimatedCost: number,
  ): number {
    const remainingValues = [
      this.config.maxCostPerRequest - estimatedCost,
      this.config.maxCostPerSession - (session.cost + estimatedCost),
      this.config.maxCostPerTenantDaily - (state.dailyCost + estimatedCost),
      this.config.maxCostPerTenantMonthly - (state.monthlyCost + estimatedCost),
      this.config.maxCostGlobalDaily - (globalDailyState.cost + estimatedCost),
    ].filter(Number.isFinite);

    return remainingValues.length > 0 ? Math.min(...remainingValues) : Infinity;
  }

  /**
   * 应用熔断 —— 设置熔断状态并记录日志。
   */
  private applyMelt(
    state: TenantCostState,
    tenantId: string,
    reason: string,
    scope: string,
  ): void {
    state.melted = true;
    state.meltReason = reason;
    state.meltedAt = Date.now();
    state.meltScope = scope;
    state.throttled = true;

    if (this.config.enableAutoMelt) {
      try {
        getGlobalLogger().critical(
          'BillExplosionGuard',
          `AUTO-MELT: ${reason}（租户: ${tenantId}, 作用域: ${scope}）`,
          { tenantId, reason, scope },
        );
      } catch (err) {
        reportSilentFailure(err, 'billExplosionGuard:applyMelt');
      }
    }
  }

  /**
   * 咨询 CostGuard —— 二次经济攻击检测。
   *
   * @returns CostGuard 建议的动作（MELT/THROTTLE），无建议返回 null
   */
  private consultCostGuard(
    tenantId: string,
    model: string,
    estimatedTokens: number,
    source: string,
    input?: string,
  ): BillGuardAction | null {
    try {
      const costGuard = getCostGuard();
      const decision = costGuard.evaluateRequest({
        tokens: estimatedTokens,
        model,
        source,
        input,
      });
      if (decision.action === 'MELT') return 'MELT';
      if (decision.action === 'THROTTLE') return 'THROTTLE';
      if (decision.action === 'QUARANTINE') return 'THROTTLE';
      return null;
    } catch (err) {
      reportSilentFailure(err, 'billExplosionGuard:consultCostGuard');
      return null;
    }
  }

  /**
   * 构建成本检查结果。
   */
  private buildResult(
    allowed: boolean,
    action: BillGuardAction,
    reason: string,
    estimatedCost: number,
    remainingBudget: number,
    attackPattern: BillAttackPattern | undefined,
    limitScope: string | undefined,
    state: TenantCostState,
    session: SessionState,
    timestamp: string,
  ): CostCheckResult {
    return {
      allowed,
      action,
      reason,
      estimatedCost,
      remainingBudget,
      attackPattern,
      limitScope,
      currentCosts: {
        session: session.cost,
        daily: state.dailyCost,
        monthly: state.monthlyCost,
        globalDaily: globalDailyState.cost,
      },
      timestamp,
    };
  }

  /**
   * 记录安全审计事件。
   */
  private logSecurityEvent(
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    details: Record<string, unknown>,
  ): void {
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'security_scan',
        severity,
        source: 'BillExplosionGuard',
        message,
        details,
      });
    } catch (err) {
      reportSilentFailure(err, 'billExplosionGuard:logSecurityEvent');
    }
  }

  /**
   * 记录到防篡改审计链。
   */
  private logChainEvent(record: Record<string, unknown>): void {
    try {
      const chain = getAuditChainLedger();
      chain.append(record);
    } catch (err) {
      reportSilentFailure(err, 'billExplosionGuard:logChainEvent');
    }
  }

  /**
   * 记录指标。
   */
  private recordMetrics(
    operation: string,
    action: BillGuardAction,
    labels: Record<string, unknown>,
  ): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('billguard.operations', 1, {
        operation,
        action,
        ...Object.fromEntries(
          Object.entries(labels).map(([k, v]) => [k, String(v)]),
        ),
      });
      if (action === 'MELT') {
        metrics.incrementCounter('billguard.melts', 1, { operation });
      }
      if (action === 'THROTTLE') {
        metrics.incrementCounter('billguard.throttles', 1, { operation });
      }
    } catch (err) {
      reportSilentFailure(err, 'billExplosionGuard:recordMetrics');
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

const billExplosionGuardSingleton = createTenantAwareSingleton(
  () => new BillExplosionGuard(),
  { componentName: 'BillExplosionGuard' },
);

/**
 * 获取全局 BillExplosionGuard 单例（单租户）或租户作用域实例（多租户）。
 *
 * @param config - 部分配置（可选，首次传入时会重新配置）
 * @returns BillExplosionGuard 实例
 */
export function getBillExplosionGuard(
  config?: Partial<BillGuardConfig>,
): BillExplosionGuard {
  if (config) {
    const guard = billExplosionGuardSingleton.get();
    guard.reconfigure(config);
    return guard;
  }
  return billExplosionGuardSingleton.get();
}

/**
 * 重置 BillExplosionGuard 单例（用于测试隔离）。
 * 清除所有租户状态、全局状态和快照。
 */
export function resetBillExplosionGuard(): void {
  billExplosionGuardSingleton.reset();
  // 清除模块级共享状态
  sharedTenantStates.clear();
  globalDailyState.date = '';
  globalDailyState.cost = 0;
  globalDailyState.tokens = 0;
  globalDailyState.melted = false;
  globalDailyState.meltReason = undefined;
  globalDailyState.meltedAt = undefined;
}
