/**
 * DynamicCostGuardian — 自适应、按租户成本守护与新型经济攻击检测系统
 *
 * 与现有的 `billExplosionGuard.ts` 和 `costGuard.ts` 不同，这两个模块使用的是
 * 完全静态的阈值。本模块引入"学习与自适应"能力，为每个租户建立消费指纹，
 * 并据此动态调整成本上限，同时检测已知 6 种攻击模式之外的**新型经济攻击**。
 *
 * 四大核心能力：
 * 1. 按租户消费指纹（buildSpendingFingerprint）
 *    - 时段分布、模型组合、请求尺寸分布、工具调用频率、周期性、增长趋势
 *    - 即使当前消费低于静态上限，只要偏离指纹即可被发现
 *
 * 2. 动态阈值自适应（getDynamicThresholds）
 *    - 基于历史 P95 基线、当前趋势、时段、增长率、季节性动态计算
 *    - 检测到异常时自动收紧，恢复正常后逐步放宽
 *
 * 3. 新型经济攻击向量检测（detectNovelEconomicAttack）
 *    - 梯度爬升（温水煮蛙）、模型切换、上下文填充、递归放大
 *    - 非工作时段突增、多会话并发、Token 回收、突发尖峰
 *    - 关键：3σ 通用偏差检测，捕获**任何未知**经济攻击
 *
 * 4. 实时成本异常响应（respondToCostAnomaly）
 *    - 5 级渐进式响应：记录监控 → 限流警告 → 收紧阈值 + 重新认证 →
 *      硬阻断昂贵请求 → 完全冻结 + 取证快照
 *    - 自动响应可被 setManualOverride 覆盖
 *
 * 集成模块：
 * - createTenantAwareSingleton：按租户隔离的单例
 * - reportSilentFailure：所有 catch 块的静默失败上报
 * - getGlobalLogger / getGlobalMetrics：日志与指标
 * - getSecurityAuditLogger：安全事件审计
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// 类型定义
// ============================================================================

/** 消费统计周期。 */
export type SpendingPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** 异常响应级别（1 最轻，5 最重）。 */
export type DeviationLevel = 1 | 2 | 3 | 4 | 5;

/**
 * 新型经济攻击类型。
 * - gradient_escalation: 梯度爬升（温水煮蛙）
 * - model_switching: 突然切换到最昂贵模型
 * - context_stuffing: 通过工具输出填充上下文
 * - recursive_amplification: 递归工具调用放大
 * - off_hours_surge: 非工作时段突增
 * - multi_session_parallelism: 多会话并发
 * - token_recycling: Token 回收攻击
 * - unknown_deviation: 3σ 通用偏差（捕获未知攻击）
 * - sudden_spike: 突发尖峰
 */
export type EconomicAttackType =
  | 'gradient_escalation'
  | 'model_switching'
  | 'context_stuffing'
  | 'recursive_amplification'
  | 'off_hours_surge'
  | 'multi_session_parallelism'
  | 'token_recycling'
  | 'unknown_deviation'
  | 'sudden_spike';

/**
 * 按租户消费指纹 —— 描述一个租户"正常"的消费画像。
 */
export interface SpendingFingerprint {
  /** 租户 ID */
  tenantId: string;
  /** 时段分布（24 个桶，每桶对应一小时，归一化到 0-1 且总和为 1） */
  hourlyDistribution: number[];
  /** 模型组合（模型名 → 使用比率 0-1） */
  modelMix: Map<string, number>;
  /** 请求尺寸统计（token 数） */
  requestSizeStats: {
    mean: number;
    stdDev: number;
    p50: number;
    p95: number;
    p99: number;
    sampleCount: number;
  };
  /** 工具调用频率统计（每会话） */
  toolCallStats: {
    meanPerSession: number;
    stdDev: number;
    p95: number;
  };
  /** 周期性 */
  weekdayVsWeekendRatio: number; // >1 表示工作日消费更多
  endOfMonthSpikeFactor: number; // >1 表示月末消费突增
  /** 增长趋势 */
  growthRate: number; // 每周百分比，正值表示增长
  trendDirection: 'growing' | 'stable' | 'declining';
  /** 基线成本（美元） */
  baselineHourlyCost: number;
  baselineDailyCost: number;
  baselineSessionCost: number;
  /** 元数据 */
  firstObserved: string;
  lastUpdated: string;
  dataPoints: number;
  /** 指纹置信度（0-1） */
  confidence: number;
}

/**
 * 动态阈值 —— 基于指纹自适应计算的成本上限。
 */
export interface DynamicThreshold {
  /** 租户 ID */
  tenantId: string;
  /** 单次请求 token 上限（P95 * 1.5，非固定 32000） */
  perRequestTokenLimit: number;
  /** 每小时成本上限（历史 P95 小时成本 * 2） */
  perHourCostLimit: number;
  /** 每日成本上限（历史 P95 日成本 * 1.5） */
  perDayCostLimit: number;
  /** 单会话成本上限（历史 P95 会话成本 * 2） */
  sessionCostLimit: number;
  /** 异常偏差阈值（σ 数） */
  anomalyDeviationThreshold: number;
  /** 当前调整因子（1.0 = 正常，<1 = 收紧，>1 = 放宽） */
  currentAdjustmentFactor: number;
  /** 调整理由 */
  reason: string;
  /** 最后计算时间 */
  lastCalculated: string;
}

/**
 * 新型经济攻击检测结果。
 */
export interface EconomicAttackDetection {
  /** 是否检测到攻击 */
  detected: boolean;
  /** 攻击类型 */
  attackType?: EconomicAttackType;
  /** 置信度（0-1） */
  confidence: number;
  /** 预估超额成本（美元） */
  estimatedCostImpact: number;
  /** 偏离正常模式的 σ 数 */
  deviationSigma: number;
  /** 租户 ID */
  tenantId: string;
  /** 人类可读描述 */
  description: string;
  /** 建议响应级别 */
  recommendedAction: DeviationLevel;
  /** 证据列表 */
  evidence: string[];
  /** 时间戳 */
  timestamp: string;
}

/**
 * 成本异常响应结果。
 */
export interface CostAnomalyResponse {
  /** 租户 ID */
  tenantId: string;
  /** 响应级别 */
  level: DeviationLevel;
  /** 执行动作描述 */
  action: string;
  /** 新的调整因子 */
  thresholdAdjustment: number;
  /** 是否阻断 */
  blocked: boolean;
  /** 是否限流 */
  throttled: boolean;
  /** 是否要求重新认证 */
  requiresReauth: boolean;
  /** 给租户/运维的消息 */
  message: string;
  /** 时间戳 */
  timestamp: string;
}

/**
 * 单条成本记录 —— 每次交易后上报。
 */
export interface CostRecord {
  /** 租户 ID */
  tenantId: string;
  /** 代理 ID */
  agentId: string;
  /** 会话 ID */
  sessionId: string;
  /** 成本（美元） */
  cost: number;
  /** 总 token 数 */
  tokens: number;
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 模型名 */
  model: string;
  /** 工具调用次数 */
  toolCalls: number;
  /** 请求尺寸（token 数） */
  requestSize: number;
  /** 时间戳（ISO） */
  timestamp: string;
}

/**
 * 动态成本守护配置。
 */
export interface DynamicCostConfig {
  /** 是否启用 */
  enabled: boolean;
  // ── 指纹构建 ──────────────────────────────────────────────
  /** 建立指纹所需的最小数据点数（默认 50） */
  minDataPointsForFingerprint: number;
  /** 指纹更新间隔（毫秒，默认 5 分钟） */
  fingerprintUpdateIntervalMs: number;
  /** 指纹过期天数（默认 90） */
  fingerprintExpiryDays: number;
  // ── 动态阈值 ──────────────────────────────────────────────
  /** 基线百分位（默认 0.95 即 P95） */
  baselinePercentile: number;
  /** 请求上限乘数（默认 1.5） */
  requestLimitMultiplier: number;
  /** 小时上限乘数（默认 2.0） */
  hourlyLimitMultiplier: number;
  /** 日上限乘数（默认 1.5） */
  dailyLimitMultiplier: number;
  /** 会话上限乘数（默认 2.0） */
  sessionLimitMultiplier: number;
  /** 异常 σ 阈值（默认 3.0） */
  anomalySigmaThreshold: number;
  /**
   * 调整因子的收紧下界（默认 0.1，即最多收紧到正常的 10%）。
   * 注意：命名为 max 表示"最大收紧程度"，实际是调整因子的最小值。
   */
  maxAdjustmentFactor: number;
  /**
   * 调整因子的放宽上界（默认 1.5，即最多放宽到正常的 150%）。
   * 注意：命名为 min 表示"最小收紧后的边界"，实际是调整因子的最大值。
   */
  minAdjustmentFactor: number;
  // ── 新型攻击检测 ──────────────────────────────────────────
  /** 梯度爬升检测窗口（毫秒，默认 1 小时） */
  gradientEscalationWindowMs: number;
  /** 梯度爬升阈值（每小时增长率，默认 0.1 即 10%） */
  gradientEscalationThreshold: number;
  /** 非工作时段突增阈值（倍数，默认 3.0） */
  offHoursThreshold: number;
  /** 多会话并发阈值（默认 10） */
  multiSessionThreshold: number;
  // ── 响应 ──────────────────────────────────────────────────
  /** 是否启用自动响应 */
  autoResponseEnabled: boolean;
  /** 自动响应最高级别（默认 4） */
  maxAutoResponseLevel: DeviationLevel;
}

/**
 * 实时成本异常状态（用于监控面板）。
 */
export interface CostAnomalyStatus {
  /** 租户 ID */
  tenantId: string;
  /** 当前生效级别（考虑手动覆盖） */
  currentLevel: DeviationLevel;
  /** 手动覆盖级别（null 表示无覆盖） */
  manualOverride: DeviationLevel | null;
  /** 自动计算的级别 */
  autoLevel: DeviationLevel;
  /** 是否阻断 */
  blocked: boolean;
  /** 是否限流 */
  throttled: boolean;
  /** 是否要求重新认证 */
  requiresReauth: boolean;
  /** 当前调整因子 */
  adjustmentFactor: number;
  /** 最近检测记录 */
  recentDetections: EconomicAttackDetection[];
  /** 最近一次响应 */
  lastResponse: CostAnomalyResponse | null;
  /** 指纹置信度 */
  fingerprintConfidence: number;
  /** 活跃会话数 */
  activeSessions: number;
  /** 当前小时成本 */
  currentHourCost: number;
  /** 当日成本 */
  currentDayCost: number;
  /** 时间戳 */
  timestamp: string;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: DynamicCostConfig = {
  enabled: true,
  minDataPointsForFingerprint: 50,
  fingerprintUpdateIntervalMs: 300_000,
  fingerprintExpiryDays: 90,
  baselinePercentile: 0.95,
  requestLimitMultiplier: 1.5,
  hourlyLimitMultiplier: 2.0,
  dailyLimitMultiplier: 1.5,
  sessionLimitMultiplier: 2.0,
  anomalySigmaThreshold: 3.0,
  maxAdjustmentFactor: 0.1,
  minAdjustmentFactor: 1.5,
  gradientEscalationWindowMs: 3_600_000,
  gradientEscalationThreshold: 0.1,
  offHoursThreshold: 3.0,
  multiSessionThreshold: 10,
  autoResponseEnabled: true,
  maxAutoResponseLevel: 4,
};

/** 新租户（尚无指纹）使用的保守默认阈值。 */
const CONSERVATIVE_DEFAULTS = {
  perRequestTokenLimit: 32_000,
  perHourCostLimit: 10.0,
  perDayCostLimit: 100.0,
  sessionCostLimit: 5.0,
  baselineHourlyCost: 1.0,
  baselineDailyCost: 20.0,
  baselineSessionCost: 1.0,
};

/** 滑动窗口保留的最近请求样本数（用于百分位计算）。 */
const REQUEST_WINDOW_SIZE = 1_000;
/** 会话工具调用样本数。 */
const TOOL_WINDOW_SIZE = 500;
/** 基线成本样本数。 */
const COST_WINDOW_SIZE = 720;
/** 保留的最近检测记录数。 */
const MAX_RECENT_DETECTIONS = 50;
/** 周成本桶数量（用于增长趋势）。 */
const WEEKLY_BUCKETS = 8;

// ============================================================================
// 数值统计辅助（Welford 算法 + 百分位）
// ============================================================================

/** Welford 在线统计量。 */
interface RunningStats {
  count: number;
  mean: number;
  m2: number;
}

function newRunningStats(): RunningStats {
  return { count: 0, mean: 0, m2: 0 };
}

/** 向在线统计量中加入一个样本。 */
function runningStatsAdd(stats: RunningStats, value: number): void {
  stats.count++;
  const delta = value - stats.mean;
  stats.mean += delta / stats.count;
  const delta2 = value - stats.mean;
  stats.m2 += delta * delta2;
}

/** 样本标准差（count < 2 时返回 0）。 */
function runningStatsStdDev(stats: RunningStats): number {
  if (stats.count < 2) return 0;
  return Math.sqrt(stats.m2 / (stats.count - 1));
}

/**
 * 计算排序后数组的指定百分位（线性插值）。
 * 调用方需保证输入数组已升序排序。
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const clampedP = Math.max(0, Math.min(1, p));
  const rank = clampedP * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = sortedValues[lower]!;
  const hi = sortedValues[upper]!;
  if (lower === upper) return lo;
  const weight = rank - lower;
  return lo * (1 - weight) + hi * weight;
}

/** 向定长窗口追加值，超出容量时丢弃最旧样本。 */
function pushWindow(window: number[], value: number, maxSize: number): void {
  window.push(value);
  if (window.length > maxSize) {
    window.shift();
  }
}

/** 日期是否为周末（周六/周日）。 */
function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** 日期是否为月末（当月最后 3 天）。 */
function isEndOfMonth(date: Date): boolean {
  const day = date.getDate();
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return day >= lastDay - 2;
}

/** 将数字限制在 [min, max] 区间。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// 按租户内部跟踪状态
// ============================================================================

/**
 * 每个租户的指纹构建原始累加器。
 * 所有统计均来自"合法"交易（即未被判定为攻击的交易也会被记录以学习模式）。
 */
interface TenantFingerprintState {
  // 时段分布（24 桶原始成本）
  hourlyCosts: number[];
  // 模型使用计数
  modelCounts: Map<string, number>;
  // 每模型单次请求成本统计（用于模型切换检测）
  modelCostStats: Map<string, RunningStats>;
  // 请求尺寸在线统计
  requestSizeStats: RunningStats;
  requestSizeWindow: number[];
  // 单条成本在线统计（用于 3σ 通用偏差检测）
  costStats: RunningStats;
  // 工具调用频率（每会话）在线统计
  toolCallStats: RunningStats;
  toolCallWindow: number[];
  // 输入/输出 token 比率在线统计（用于 Token 回收检测）
  ioRatioStats: RunningStats;
  // 周期性
  weekdayCost: number;
  weekendCost: number;
  weekdayDays: Set<string>;
  weekendDays: Set<string>;
  endOfMonthCost: number;
  nonEndOfMonthCost: number;
  endOfMonthDays: Set<string>;
  nonEndOfMonthDays: Set<string>;
  // 增长趋势（按周汇总成本）
  weeklyBuckets: Array<{ weekStart: number; cost: number }>;
  // 基线成本窗口
  hourlyCostWindow: number[];
  dailyCostWindow: number[];
  sessionCostWindow: number[];
  // 元数据
  firstObserved: string;
  lastUpdated: string;
  dataPoints: number;
  // 当前周期累加器
  currentHour: number;
  currentHourCost: number;
  currentDay: string;
  currentDayCost: number;
  currentSessionCosts: Map<string, number>;
  // 活跃会话集合（用于多会话检测）
  activeSessions: Set<string>;
  // 梯度爬升检测：最近交易的成本时间戳序列
  spendingRateHistory: Array<{ timestamp: number; cost: number }>;
  // 缓存的指纹
  cachedFingerprint: SpendingFingerprint | null;
  lastFingerprintBuildAt: number;
}

/**
 * 每个租户的异常响应状态。
 */
interface TenantAnomalyState {
  autoLevel: DeviationLevel;
  manualOverride: DeviationLevel | null;
  blocked: boolean;
  throttled: boolean;
  requiresReauth: boolean;
  adjustmentFactor: number;
  recentDetections: EconomicAttackDetection[];
  lastResponse: CostAnomalyResponse | null;
  lastAnomalyAt: number;
  lastNormalCheckAt: number;
  // 取证快照（Level 5 触发）
  forensicSnapshot: Record<string, unknown> | null;
}

/** 创建一份新的指纹状态。 */
function createFingerprintState(tenantId: string): TenantFingerprintState {
  return {
    hourlyCosts: new Array(24).fill(0),
    modelCounts: new Map(),
    modelCostStats: new Map(),
    requestSizeStats: newRunningStats(),
    requestSizeWindow: [],
    costStats: newRunningStats(),
    toolCallStats: newRunningStats(),
    toolCallWindow: [],
    ioRatioStats: newRunningStats(),
    weekdayCost: 0,
    weekendCost: 0,
    weekdayDays: new Set(),
    weekendDays: new Set(),
    endOfMonthCost: 0,
    nonEndOfMonthCost: 0,
    endOfMonthDays: new Set(),
    nonEndOfMonthDays: new Set(),
    weeklyBuckets: [],
    hourlyCostWindow: [],
    dailyCostWindow: [],
    sessionCostWindow: [],
    firstObserved: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    dataPoints: 0,
    currentHour: -1,
    currentHourCost: 0,
    currentDay: '',
    currentDayCost: 0,
    currentSessionCosts: new Map(),
    activeSessions: new Set(),
    spendingRateHistory: [],
    cachedFingerprint: null,
    lastFingerprintBuildAt: 0,
  };
}

/** 创建一份新的异常响应状态。 */
function createAnomalyState(): TenantAnomalyState {
  return {
    autoLevel: 1,
    manualOverride: null,
    blocked: false,
    throttled: false,
    requiresReauth: false,
    adjustmentFactor: 1.0,
    recentDetections: [],
    lastResponse: null,
    lastAnomalyAt: 0,
    lastNormalCheckAt: Date.now(),
    forensicSnapshot: null,
  };
}

// ============================================================================
// DynamicCostGuardian
// ============================================================================

/**
 * 自适应、按租户成本守护。
 *
 * 通过学习每个租户的正常消费模式建立指纹，并据此动态调整成本上限，
 * 同时检测已知静态守卫无法覆盖的新型经济攻击。3σ 通用偏差检测是
 * 对抗**未知**经济攻击的核心防线。
 */
export class DynamicCostGuardian {
  private config: DynamicCostConfig;
  private readonly fingerprintStates = new Map<string, TenantFingerprintState>();
  private readonly anomalyStates = new Map<string, TenantAnomalyState>();
  private readonly cachedThresholds = new Map<string, DynamicThreshold>();

  constructor(config?: Partial<DynamicCostConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 运行时重新配置。 */
  reconfigure(config: Partial<DynamicCostConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置。 */
  getConfig(): Readonly<DynamicCostConfig> {
    return this.config;
  }

  // ── 能力 1：按租户消费指纹 ────────────────────────────────────────────

  /**
   * 为指定租户构建（或重建）消费指纹。
   * 从原始累加器计算所有统计量。若数据点不足则返回 null。
   */
  buildSpendingFingerprint(tenantId: string): SpendingFingerprint | null {
    try {
      const state = this.getOrCreateFingerprintState(tenantId);
      if (state.dataPoints < this.config.minDataPointsForFingerprint) {
        return null;
      }

      // 时段分布归一化
      const hourlySum = state.hourlyCosts.reduce((a, b) => a + b, 0);
      const hourlyDistribution =
        hourlySum > 0 ? state.hourlyCosts.map((c) => c / hourlySum) : new Array(24).fill(1 / 24);

      // 模型组合归一化
      const modelTotal = [...state.modelCounts.values()].reduce((a, b) => a + b, 0);
      const modelMix = new Map<string, number>();
      if (modelTotal > 0) {
        for (const [model, count] of state.modelCounts) {
          modelMix.set(model, count / modelTotal);
        }
      }

      // 请求尺寸百分位（从窗口排序）
      const sortedSizes = [...state.requestSizeWindow].sort((a, b) => a - b);
      const requestSizeStats = {
        mean: state.requestSizeStats.mean,
        stdDev: runningStatsStdDev(state.requestSizeStats),
        p50: percentile(sortedSizes, 0.5),
        p95: percentile(sortedSizes, this.config.baselinePercentile),
        p99: percentile(sortedSizes, 0.99),
        sampleCount: state.requestSizeStats.count,
      };

      // 工具调用百分位
      const sortedTools = [...state.toolCallWindow].sort((a, b) => a - b);
      const toolCallStats = {
        meanPerSession: state.toolCallStats.mean,
        stdDev: runningStatsStdDev(state.toolCallStats),
        p95: percentile(sortedTools, this.config.baselinePercentile),
      };

      // 周期性
      const weekdayAvg = state.weekdayCost / Math.max(1, state.weekdayDays.size);
      const weekendAvg = state.weekendCost / Math.max(1, state.weekendDays.size);
      const weekdayVsWeekendRatio = weekendAvg > 0 ? weekdayAvg / weekendAvg : 1;
      const endOfMonthAvg = state.endOfMonthCost / Math.max(1, state.endOfMonthDays.size);
      const nonEndOfMonthAvg = state.nonEndOfMonthCost / Math.max(1, state.nonEndOfMonthDays.size);
      const endOfMonthSpikeFactor = nonEndOfMonthAvg > 0 ? endOfMonthAvg / nonEndOfMonthAvg : 1;

      // 增长趋势（按周桶线性回归斜率）
      const { growthRate, trendDirection } = this.computeGrowthTrend(state);

      // 基线成本（P95）
      const sortedHourly = [...state.hourlyCostWindow].sort((a, b) => a - b);
      const sortedDaily = [...state.dailyCostWindow].sort((a, b) => a - b);
      const sortedSession = [...state.sessionCostWindow].sort((a, b) => a - b);
      const baselineHourlyCost = percentile(sortedHourly, this.config.baselinePercentile);
      const baselineDailyCost = percentile(sortedDaily, this.config.baselinePercentile);
      const baselineSessionCost = percentile(sortedSession, this.config.baselinePercentile);

      // 置信度：每数据点 +0.01，上限 0.95
      const confidence = clamp(state.dataPoints * 0.01, 0, 0.95);

      const fingerprint: SpendingFingerprint = {
        tenantId,
        hourlyDistribution,
        modelMix,
        requestSizeStats,
        toolCallStats,
        weekdayVsWeekendRatio,
        endOfMonthSpikeFactor,
        growthRate,
        trendDirection,
        baselineHourlyCost: baselineHourlyCost || CONSERVATIVE_DEFAULTS.baselineHourlyCost,
        baselineDailyCost: baselineDailyCost || CONSERVATIVE_DEFAULTS.baselineDailyCost,
        baselineSessionCost: baselineSessionCost || CONSERVATIVE_DEFAULTS.baselineSessionCost,
        firstObserved: state.firstObserved,
        lastUpdated: new Date().toISOString(),
        dataPoints: state.dataPoints,
        confidence,
      };

      state.cachedFingerprint = fingerprint;
      state.lastFingerprintBuildAt = Date.now();
      state.lastUpdated = fingerprint.lastUpdated;

      this.recordMetrics('fingerprints_built', 1, { tenantId });
      return fingerprint;
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:buildSpendingFingerprint');
      return null;
    }
  }

  /**
   * 获取租户的消费指纹。若缓存不存在则尝试构建。
   */
  getFingerprint(tenantId: string): SpendingFingerprint | null {
    try {
      const state = this.getOrCreateFingerprintState(tenantId);
      if (state.cachedFingerprint) {
        return state.cachedFingerprint;
      }
      return this.buildSpendingFingerprint(tenantId);
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:getFingerprint');
      return null;
    }
  }

  /** 计算增长趋势（按周桶的简单线性回归斜率，转成每周百分比）。 */
  private computeGrowthTrend(state: TenantFingerprintState): {
    growthRate: number;
    trendDirection: 'growing' | 'stable' | 'declining';
  } {
    const buckets = state.weeklyBuckets;
    if (buckets.length < 2) {
      return { growthRate: 0, trendDirection: 'stable' };
    }
    // 简单线性回归 y = a + b*x，b 为斜率
    const n = buckets.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = buckets[i]!.cost;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) {
      return { growthRate: 0, trendDirection: 'stable' };
    }
    const slope = (n * sumXY - sumX * sumY) / denom;
    const meanY = sumY / n;
    const growthRate = meanY > 0 ? (slope / meanY) * 100 : 0;
    let trendDirection: 'growing' | 'stable' | 'declining' = 'stable';
    if (growthRate > 5) trendDirection = 'growing';
    else if (growthRate < -5) trendDirection = 'declining';
    return { growthRate, trendDirection };
  }

  // ── 能力 2：动态阈值自适应 ────────────────────────────────────────────

  /**
   * 获取（或重算）指定租户的动态阈值。
   * 每 fingerprintUpdateIntervalMs 重算一次；其余时间返回缓存值。
   * 新租户无指纹时返回保守默认阈值。
   */
  getDynamicThresholds(tenantId: string): DynamicThreshold {
    try {
      const cached = this.cachedThresholds.get(tenantId);
      const now = Date.now();
      if (
        cached &&
        now - Date.parse(cached.lastCalculated) < this.config.fingerprintUpdateIntervalMs
      ) {
        return cached;
      }

      const fingerprint = this.getFingerprint(tenantId);
      const anomaly = this.getOrCreateAnomalyState(tenantId);
      const factor = anomaly.adjustmentFactor;

      let perRequestTokenLimit: number;
      let perHourCostLimit: number;
      let perDayCostLimit: number;
      let sessionCostLimit: number;
      let reason: string;

      if (fingerprint) {
        perRequestTokenLimit =
          fingerprint.requestSizeStats.p95 * this.config.requestLimitMultiplier;
        perHourCostLimit = fingerprint.baselineHourlyCost * this.config.hourlyLimitMultiplier;
        perDayCostLimit = fingerprint.baselineDailyCost * this.config.dailyLimitMultiplier;
        sessionCostLimit = fingerprint.baselineSessionCost * this.config.sessionLimitMultiplier;
        reason = `基于指纹（置信度 ${fingerprint.confidence.toFixed(2)}，${fingerprint.dataPoints} 数据点）`;
      } else {
        perRequestTokenLimit = CONSERVATIVE_DEFAULTS.perRequestTokenLimit;
        perHourCostLimit = CONSERVATIVE_DEFAULTS.perHourCostLimit;
        perDayCostLimit = CONSERVATIVE_DEFAULTS.perDayCostLimit;
        sessionCostLimit = CONSERVATIVE_DEFAULTS.sessionCostLimit;
        reason = '无指纹，使用保守默认阈值（新租户）';
      }

      // 应用调整因子（收紧/放宽）。因子越小越严格。
      perRequestTokenLimit = Math.max(1, perRequestTokenLimit * factor);
      perHourCostLimit = Math.max(0.01, perHourCostLimit * factor);
      perDayCostLimit = Math.max(0.01, perDayCostLimit * factor);
      sessionCostLimit = Math.max(0.01, sessionCostLimit * factor);

      if (factor < 1) {
        reason += `；已收紧至 ${(factor * 100).toFixed(0)}%`;
      } else if (factor > 1) {
        reason += `；已放宽至 ${(factor * 100).toFixed(0)}%`;
      }

      const threshold: DynamicThreshold = {
        tenantId,
        perRequestTokenLimit,
        perHourCostLimit,
        perDayCostLimit,
        sessionCostLimit,
        anomalyDeviationThreshold: this.config.anomalySigmaThreshold,
        currentAdjustmentFactor: factor,
        reason,
        lastCalculated: new Date().toISOString(),
      };

      this.cachedThresholds.set(tenantId, threshold);
      this.recordMetrics('thresholds_adjusted', 1, {
        tenantId,
        factor: factor.toFixed(2),
      });
      return threshold;
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:getDynamicThresholds');
      // 出错时返回保守默认
      return {
        tenantId,
        perRequestTokenLimit: CONSERVATIVE_DEFAULTS.perRequestTokenLimit,
        perHourCostLimit: CONSERVATIVE_DEFAULTS.perHourCostLimit,
        perDayCostLimit: CONSERVATIVE_DEFAULTS.perDayCostLimit,
        sessionCostLimit: CONSERVATIVE_DEFAULTS.sessionCostLimit,
        anomalyDeviationThreshold: this.config.anomalySigmaThreshold,
        currentAdjustmentFactor: 1.0,
        reason: '计算异常，返回保守默认',
        lastCalculated: new Date().toISOString(),
      };
    }
  }

  // ── 能力 3：新型经济攻击检测 ──────────────────────────────────────────

  /**
   * 检测新型经济攻击。基于一条成本记录，结合租户指纹评估多种攻击向量。
   * 3σ 通用偏差检测是捕获**未知**攻击的关键防线。
   */
  detectNovelEconomicAttack(record: CostRecord): EconomicAttackDetection {
    const timestamp = new Date().toISOString();
    const baseDetection: EconomicAttackDetection = {
      detected: false,
      confidence: 0,
      estimatedCostImpact: 0,
      deviationSigma: 0,
      tenantId: record.tenantId,
      description: '未检测到异常',
      recommendedAction: 1,
      evidence: [],
      timestamp,
    };

    try {
      if (!this.config.enabled) {
        return baseDetection;
      }

      const state = this.getOrCreateFingerprintState(record.tenantId);
      const fingerprint = this.getFingerprint(record.tenantId);
      const now = Date.parse(record.timestamp) || Date.now();
      const candidates: EconomicAttackDetection[] = [];

      // 即便没有指纹，也记录数据用于学习；但有指纹才能做偏差检测。
      if (!fingerprint) {
        return baseDetection;
      }

      // —— 1. 梯度爬升（温水煮蛙） ——
      const gradient = this.detectGradientEscalation(record.tenantId, state, now);
      if (gradient) candidates.push(gradient);

      // —— 2. 模型切换攻击 ——
      const modelSwitch = this.detectModelSwitching(record, fingerprint, state);
      if (modelSwitch) candidates.push(modelSwitch);

      // —— 3. 上下文填充（工具输出异常大） ——
      const stuffing = this.detectContextStuffing(record, fingerprint);
      if (stuffing) candidates.push(stuffing);

      // —— 4. 递归放大（工具调用异常多） ——
      const amplification = this.detectRecursiveAmplification(record, fingerprint);
      if (amplification) candidates.push(amplification);

      // —— 5. 非工作时段突增 ——
      const offHours = this.detectOffHoursSurge(record, fingerprint, state, now);
      if (offHours) candidates.push(offHours);

      // —— 6. 多会话并发 ——
      const multiSession = this.detectMultiSessionParallelism(record.tenantId, state);
      if (multiSession) candidates.push(multiSession);

      // —— 7. Token 回收攻击 ——
      const recycling = this.detectTokenRecycling(record, fingerprint, state);
      if (recycling) candidates.push(recycling);

      // —— 8. 突发尖峰 ——
      const spike = this.detectSuddenSpike(record, fingerprint);
      if (spike) candidates.push(spike);

      // —— 9. 3σ 通用偏差（捕获未知攻击，最关键） ——
      const catchAll = this.detectUnknownDeviation(record, fingerprint, state);
      if (catchAll) candidates.push(catchAll);

      if (candidates.length === 0) {
        return baseDetection;
      }

      // 选择最严重的检测（优先 recommendedAction 高，其次 deviationSigma 高）
      candidates.sort((a, b) => {
        if (b.recommendedAction !== a.recommendedAction) {
          return b.recommendedAction - a.recommendedAction;
        }
        return b.deviationSigma - a.deviationSigma;
      });
      const winner = candidates[0]!;
      this.recordMetrics('anomalies_detected', 1, {
        tenantId: record.tenantId,
        type: winner.attackType ?? 'unknown',
      });
      return winner;
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:detectNovelEconomicAttack');
      return baseDetection;
    }
  }

  /** 梯度爬升：在窗口内后半段成本率显著高于前半段。 */
  private detectGradientEscalation(
    tenantId: string,
    state: TenantFingerprintState,
    now: number,
  ): EconomicAttackDetection | null {
    const window = this.config.gradientEscalationWindowMs;
    const cutoff = now - window;
    const recent = state.spendingRateHistory.filter((p) => p.timestamp >= cutoff);
    if (recent.length < 10) return null;

    const midPoint = cutoff + window / 2;
    let firstCost = 0;
    let secondCost = 0;
    for (const p of recent) {
      if (p.timestamp < midPoint) firstCost += p.cost;
      else secondCost += p.cost;
    }
    if (firstCost <= 0) return null;

    const increaseRatio = secondCost / firstCost - 1;
    if (increaseRatio < this.config.gradientEscalationThreshold) return null;

    const sigma = clamp(increaseRatio / this.config.gradientEscalationThreshold, 1, 10);
    const confidence = clamp(sigma / 5, 0.3, 0.95);
    return {
      detected: true,
      attackType: 'gradient_escalation',
      confidence,
      estimatedCostImpact: Math.max(0, secondCost - firstCost),
      deviationSigma: sigma,
      tenantId,
      description: `梯度爬升：窗口后半段成本率比前半段高 ${(increaseRatio * 100).toFixed(1)}%`,
      recommendedAction: sigma >= 5 ? 3 : 2,
      evidence: [
        `窗口前半段成本: $${firstCost.toFixed(4)}`,
        `窗口后半段成本: $${secondCost.toFixed(4)}`,
        `增长率: ${(increaseRatio * 100).toFixed(1)}%（阈值 ${(this.config.gradientEscalationThreshold * 100).toFixed(0)}%）`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 模型切换：突然使用昂贵且极少使用的模型。 */
  private detectModelSwitching(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
    state: TenantFingerprintState,
  ): EconomicAttackDetection | null {
    const normalRatio = fingerprint.modelMix.get(record.model) ?? 0;
    // 该模型在历史中占比 < 5% 视为"极少使用"
    if (normalRatio > 0.05) return null;

    const costStats = state.modelCostStats.get(record.model);
    // 比较该模型平均成本与租户整体会话基线
    const baseline = fingerprint.baselineSessionCost;
    if (baseline <= 0) return null;

    // 用已知模型的平均成本估算昂贵程度
    let modelAvgCost = record.cost;
    if (costStats && costStats.count > 0) {
      modelAvgCost = costStats.mean;
    }
    const costMultiplier = modelAvgCost / baseline;
    if (costMultiplier < 3) return null;

    const sigma = clamp(costMultiplier / 3, 1, 10);
    return {
      detected: true,
      attackType: 'model_switching',
      confidence: clamp(sigma / 5, 0.4, 0.95),
      estimatedCostImpact: record.cost - baseline,
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `模型切换攻击：突然使用昂贵模型 ${record.model}（正常占比 ${(normalRatio * 100).toFixed(1)}%，成本为基线 ${costMultiplier.toFixed(1)} 倍）`,
      recommendedAction: sigma >= 5 ? 3 : 2,
      evidence: [
        `模型: ${record.model}`,
        `历史使用占比: ${(normalRatio * 100).toFixed(2)}%`,
        `成本倍数: ${costMultiplier.toFixed(1)}x 基线`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 上下文填充：请求尺寸远超 P95。 */
  private detectContextStuffing(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
  ): EconomicAttackDetection | null {
    const p95 = fingerprint.requestSizeStats.p95;
    if (p95 <= 0) return null;
    const ratio = record.requestSize / p95;
    if (ratio < 3) return null;

    const sigma = clamp(ratio / 3, 1, 10);
    return {
      detected: true,
      attackType: 'context_stuffing',
      confidence: clamp(sigma / 5, 0.4, 0.95),
      estimatedCostImpact: record.cost * (1 - 1 / ratio),
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `上下文填充：请求尺寸 ${record.requestSize} token 为 P95(${p95.toFixed(0)}) 的 ${ratio.toFixed(1)} 倍`,
      recommendedAction: sigma >= 5 ? 4 : 3,
      evidence: [
        `请求尺寸: ${record.requestSize}`,
        `历史 P95: ${p95.toFixed(0)}`,
        `倍数: ${ratio.toFixed(1)}x`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 递归放大：单会话工具调用远超 P95。 */
  private detectRecursiveAmplification(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
  ): EconomicAttackDetection | null {
    const p95 = fingerprint.toolCallStats.p95;
    if (p95 <= 0) return null;
    const ratio = record.toolCalls / p95;
    if (ratio < 3) return null;

    const sigma = clamp(ratio / 3, 1, 10);
    return {
      detected: true,
      attackType: 'recursive_amplification',
      confidence: clamp(sigma / 5, 0.4, 0.95),
      estimatedCostImpact: record.cost * (1 - 1 / ratio),
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `递归放大：工具调用 ${record.toolCalls} 次为 P95(${p95.toFixed(0)}) 的 ${ratio.toFixed(1)} 倍`,
      recommendedAction: sigma >= 5 ? 4 : 3,
      evidence: [
        `工具调用次数: ${record.toolCalls}`,
        `历史 P95: ${p95.toFixed(0)}`,
        `倍数: ${ratio.toFixed(1)}x`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 非工作时段突增：在该租户通常不活跃的时段出现高消费。 */
  private detectOffHoursSurge(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
    state: TenantFingerprintState,
    now: number,
  ): EconomicAttackDetection | null {
    const hour = new Date(now).getHours();
    const hourRatio = fingerprint.hourlyDistribution[hour] ?? 0;
    // 该时段正常占比 < 3% 视为非活跃时段
    if (hourRatio > 0.03) return null;

    const baselineHourly = fingerprint.baselineHourlyCost;
    if (baselineHourly <= 0) return null;
    const currentHourCost = state.currentHourCost;
    const ratio = currentHourCost / baselineHourly;
    if (ratio < this.config.offHoursThreshold) return null;

    const sigma = clamp(ratio / this.config.offHoursThreshold, 1, 10);
    return {
      detected: true,
      attackType: 'off_hours_surge',
      confidence: clamp(sigma / 5, 0.4, 0.95),
      estimatedCostImpact: currentHourCost - baselineHourly * this.config.offHoursThreshold,
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `非工作时段突增：时段 ${hour}:00 正常占比 ${(hourRatio * 100).toFixed(1)}%，当前小时成本 $${currentHourCost.toFixed(4)} 为基线 ${ratio.toFixed(1)} 倍`,
      recommendedAction: sigma >= 5 ? 3 : 2,
      evidence: [
        `时段: ${hour}:00（正常占比 ${(hourRatio * 100).toFixed(2)}%）`,
        `当前小时成本: $${currentHourCost.toFixed(4)}`,
        `基线小时成本: $${baselineHourly.toFixed(4)}`,
        `倍数: ${ratio.toFixed(1)}x（阈值 ${this.config.offHoursThreshold}x）`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 多会话并发：活跃会话数超过阈值。 */
  private detectMultiSessionParallelism(
    tenantId: string,
    state: TenantFingerprintState,
  ): EconomicAttackDetection | null {
    const count = state.activeSessions.size;
    if (count < this.config.multiSessionThreshold) return null;

    const sigma = clamp(count / this.config.multiSessionThreshold, 1, 10);
    return {
      detected: true,
      attackType: 'multi_session_parallelism',
      confidence: clamp(sigma / 5, 0.4, 0.95),
      estimatedCostImpact: count * fingerprint0(state) * 0.1,
      deviationSigma: sigma,
      tenantId,
      description: `多会话并发：活跃会话 ${count} 个超过阈值 ${this.config.multiSessionThreshold}`,
      recommendedAction: sigma >= 5 ? 4 : 3,
      evidence: [`活跃会话数: ${count}`, `阈值: ${this.config.multiSessionThreshold}`],
      timestamp: new Date().toISOString(),
    };
  }

  /** Token 回收：输入/输出比率远超正常。 */
  private detectTokenRecycling(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
    state: TenantFingerprintState,
  ): EconomicAttackDetection | null {
    if (record.outputTokens <= 0) return null;
    const ratio = record.inputTokens / record.outputTokens;
    const normalMean = state.ioRatioStats.mean;
    const normalStd = runningStatsStdDev(state.ioRatioStats);
    if (state.ioRatioStats.count < this.config.minDataPointsForFingerprint || normalStd <= 0) {
      return null;
    }
    const sigma = Math.abs(ratio - normalMean) / normalStd;
    if (sigma < this.config.anomalySigmaThreshold || ratio <= normalMean) return null;

    return {
      detected: true,
      attackType: 'token_recycling',
      confidence: clamp(sigma / 6, 0.4, 0.95),
      estimatedCostImpact: record.cost * (1 - normalMean / ratio),
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `Token 回收：输入/输出比率 ${ratio.toFixed(1)} 偏离正常 ${normalMean.toFixed(1)} 达 ${sigma.toFixed(1)}σ`,
      recommendedAction: sigma >= 5 ? 4 : 3,
      evidence: [
        `当前输入/输出比率: ${ratio.toFixed(2)}`,
        `正常比率均值: ${normalMean.toFixed(2)}`,
        `偏差: ${sigma.toFixed(1)}σ`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /** 突发尖峰：单条成本远超会话基线。 */
  private detectSuddenSpike(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
  ): EconomicAttackDetection | null {
    const baseline = fingerprint.baselineSessionCost;
    if (baseline <= 0) return null;
    const ratio = record.cost / baseline;
    if (ratio < 5) return null;

    const sigma = clamp(ratio / 5, 1, 10);
    return {
      detected: true,
      attackType: 'sudden_spike',
      confidence: clamp(sigma / 5, 0.5, 0.97),
      estimatedCostImpact: record.cost - baseline,
      deviationSigma: sigma,
      tenantId: record.tenantId,
      description: `突发尖峰：单条成本 $${record.cost.toFixed(4)} 为会话基线 $${baseline.toFixed(4)} 的 ${ratio.toFixed(1)} 倍`,
      recommendedAction: sigma >= 5 ? 4 : 3,
      evidence: [
        `单条成本: $${record.cost.toFixed(4)}`,
        `会话基线: $${baseline.toFixed(4)}`,
        `倍数: ${ratio.toFixed(1)}x`,
      ],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 3σ 通用偏差检测 —— 对抗未知经济攻击的核心防线。
   * 综合评估成本、请求尺寸、工具调用相对基线的偏离。
   */
  private detectUnknownDeviation(
    record: CostRecord,
    fingerprint: SpendingFingerprint,
    state: TenantFingerprintState,
  ): EconomicAttackDetection | null {
    const sigmaThreshold = this.config.anomalySigmaThreshold;
    const signals: Array<{ name: string; sigma: number }> = [];

    // 成本偏差（相对单条成本均值/标准差）
    const costStd = runningStatsStdDev(state.costStats);
    if (state.costStats.count >= this.config.minDataPointsForFingerprint && costStd > 0) {
      const sigma = Math.abs(record.cost - state.costStats.mean) / costStd;
      if (sigma >= sigmaThreshold) signals.push({ name: '成本', sigma });
    }

    // 请求尺寸偏差
    const sizeStd = fingerprint.requestSizeStats.stdDev;
    if (sizeStd > 0) {
      const sigma = Math.abs(record.requestSize - fingerprint.requestSizeStats.mean) / sizeStd;
      if (sigma >= sigmaThreshold) signals.push({ name: '请求尺寸', sigma });
    }

    // 当前小时成本偏差（相对小时成本窗口均值/标准差）
    if (state.hourlyCostWindow.length >= this.config.minDataPointsForFingerprint) {
      const window = state.hourlyCostWindow;
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance =
        window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(1, window.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) {
        const sigma = Math.abs(state.currentHourCost - mean) / std;
        if (sigma >= sigmaThreshold) signals.push({ name: '小时成本率', sigma });
      }
    }

    if (signals.length === 0) return null;

    const maxSigma = Math.max(...signals.map((s) => s.sigma));
    const confidence = clamp(maxSigma / (sigmaThreshold * 2), 0.4, 0.99);
    const costBaseline = state.costStats.mean || fingerprint.baselineSessionCost;
    return {
      detected: true,
      attackType: 'unknown_deviation',
      confidence,
      estimatedCostImpact: Math.max(0, record.cost - costBaseline),
      deviationSigma: maxSigma,
      tenantId: record.tenantId,
      description: `未知经济攻击（3σ 通用偏差）：综合信号偏离指纹达 ${maxSigma.toFixed(1)}σ，涉及 ${signals.map((s) => s.name).join('、')}`,
      recommendedAction: maxSigma >= sigmaThreshold * 2 ? 4 : 3,
      evidence: signals.map((s) => `${s.name}: ${s.sigma.toFixed(1)}σ`),
      timestamp: new Date().toISOString(),
    };
  }

  // ── 能力 4：实时成本异常响应 ──────────────────────────────────────────

  /**
   * 对成本异常执行渐进式响应。
   * 响应级别 1-5 对应从记录监控到完全冻结。
   */
  respondToCostAnomaly(tenantId: string, detection: EconomicAttackDetection): CostAnomalyResponse {
    const timestamp = new Date().toISOString();
    const anomaly = this.getOrCreateAnomalyState(tenantId);

    try {
      // 自动响应不超过 maxAutoResponseLevel；手动覆盖优先
      let level = detection.recommendedAction;
      if (this.config.autoResponseEnabled) {
        level = clamp(level, 1, this.config.maxAutoResponseLevel) as DeviationLevel;
      } else {
        level = 1;
      }
      if (anomaly.manualOverride !== null) {
        level = anomaly.manualOverride;
      }

      anomaly.autoLevel = detection.recommendedAction;
      const action = this.applyResponseLevel(anomaly, level);

      const response: CostAnomalyResponse = {
        tenantId,
        level,
        action: action.description,
        thresholdAdjustment: anomaly.adjustmentFactor,
        blocked: anomaly.blocked,
        throttled: anomaly.throttled,
        requiresReauth: anomaly.requiresReauth,
        message: action.message,
        timestamp,
      };

      anomaly.lastResponse = response;
      anomaly.lastAnomalyAt = Date.now();

      // 记录最近检测
      anomaly.recentDetections.push(detection);
      if (anomaly.recentDetections.length > MAX_RECENT_DETECTIONS) {
        anomaly.recentDetections.shift();
      }

      this.recordMetrics('responses_triggered', 1, {
        tenantId,
        level: String(level),
      });
      this.logSecurityEvent(
        level >= 4 ? 'critical' : level >= 3 ? 'high' : 'medium',
        `动态成本异常响应 [Level ${level}]: ${detection.attackType ?? 'unknown'}`,
        {
          tenantId,
          level,
          attackType: detection.attackType,
          sigma: detection.deviationSigma,
          confidence: detection.confidence,
          blocked: anomaly.blocked,
          throttled: anomaly.throttled,
          requiresReauth: anomaly.requiresReauth,
          adjustmentFactor: anomaly.adjustmentFactor,
          description: detection.description,
          evidence: detection.evidence,
        },
      );

      if (level >= 4) {
        getGlobalLogger().warn(
          'DynamicCostGuardian',
          `成本异常响应 Level ${level}（租户 ${tenantId}）: ${action.message}`,
          { tenantId, level, attackType: detection.attackType },
        );
      }
      if (level === 5) {
        // 取证快照
        anomaly.forensicSnapshot = this.captureForensicSnapshot(tenantId, detection);
        getGlobalLogger().critical(
          'DynamicCostGuardian',
          `成本完全冻结（租户 ${tenantId}）：已捕获取证快照`,
          { tenantId, attackType: detection.attackType },
        );
      }

      return response;
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:respondToCostAnomaly');
      return {
        tenantId,
        level: anomaly.autoLevel,
        action: '响应过程异常，保持现有状态',
        thresholdAdjustment: anomaly.adjustmentFactor,
        blocked: anomaly.blocked,
        throttled: anomaly.throttled,
        requiresReauth: anomaly.requiresReauth,
        message: '响应过程发生异常',
        timestamp,
      };
    }
  }

  /** 根据级别应用响应动作并调整阈值因子。 */
  private applyResponseLevel(
    anomaly: TenantAnomalyState,
    level: DeviationLevel,
  ): { description: string; message: string } {
    switch (level) {
      case 1:
        // Level 1：记录并监控
        anomaly.blocked = false;
        anomaly.throttled = false;
        anomaly.requiresReauth = false;
        return {
          description: '记录并监控',
          message: '检测到轻微偏差，已记录并持续监控',
        };
      case 2:
        // Level 2：限流 + 警告
        anomaly.blocked = false;
        anomaly.throttled = true;
        anomaly.requiresReauth = false;
        anomaly.adjustmentFactor = clamp(
          anomaly.adjustmentFactor * 0.7,
          this.config.maxAdjustmentFactor,
          this.config.minAdjustmentFactor,
        );
        return {
          description: '限流并警告租户',
          message: '检测到中度偏差，已限流并向租户发出警告',
        };
      case 3:
        // Level 3：收紧阈值 + 重新认证
        anomaly.blocked = false;
        anomaly.throttled = true;
        anomaly.requiresReauth = true;
        anomaly.adjustmentFactor = clamp(
          anomaly.adjustmentFactor * 0.5,
          this.config.maxAdjustmentFactor,
          this.config.minAdjustmentFactor,
        );
        return {
          description: '收紧动态阈值并要求重新认证',
          message: '检测到显著偏差，已收紧阈值并要求重新认证',
        };
      case 4:
        // Level 4：硬阻断昂贵请求 + 冻结支出增长
        anomaly.blocked = true;
        anomaly.throttled = true;
        anomaly.requiresReauth = true;
        anomaly.adjustmentFactor = this.config.maxAdjustmentFactor;
        return {
          description: '硬阻断新昂贵请求并冻结支出',
          message: '检测到严重偏差，已硬阻断昂贵请求并冻结支出',
        };
      case 5:
        // Level 5：完全冻结 + 告警安全团队 + 取证
        anomaly.blocked = true;
        anomaly.throttled = true;
        anomaly.requiresReauth = true;
        anomaly.adjustmentFactor = this.config.maxAdjustmentFactor;
        return {
          description: '完全冻结支出、告警安全团队、捕获取证快照',
          message: '检测到关键偏差，已完全冻结支出并告警安全团队',
        };
      default:
        return { description: '无操作', message: '' };
    }
  }

  /** 捕获取证快照（Level 5）。 */
  private captureForensicSnapshot(
    tenantId: string,
    detection: EconomicAttackDetection,
  ): Record<string, unknown> {
    const state = this.fingerprintStates.get(tenantId);
    const anomaly = this.anomalyStates.get(tenantId);
    return {
      capturedAt: new Date().toISOString(),
      tenantId,
      detection,
      fingerprint: state?.cachedFingerprint ?? null,
      recentDetections: anomaly?.recentDetections ?? [],
      activeSessions: state?.activeSessions.size ?? 0,
      currentHourCost: state?.currentHourCost ?? 0,
      currentDayCost: state?.currentDayCost ?? 0,
      spendingRateHistory: state?.spendingRateHistory.slice(-50) ?? [],
    };
  }

  /** 手动覆盖某租户的响应级别。 */
  setManualOverride(tenantId: string, level: DeviationLevel): void {
    try {
      const anomaly = this.getOrCreateAnomalyState(tenantId);
      anomaly.manualOverride = level;
      this.applyResponseLevel(anomaly, level);
      this.logSecurityEvent('medium', `手动覆盖成本异常响应级别为 ${level}`, { tenantId, level });
      getGlobalLogger().info(
        'DynamicCostGuardian',
        `手动覆盖租户 ${tenantId} 响应级别为 ${level}`,
        { tenantId, level },
      );
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:setManualOverride');
    }
  }

  /** 清除手动覆盖，恢复自动响应。 */
  clearManualOverride(tenantId: string): void {
    try {
      const anomaly = this.getOrCreateAnomalyState(tenantId);
      anomaly.manualOverride = null;
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:clearManualOverride');
    }
  }

  /**
   * 获取租户的实时成本异常状态（用于监控面板）。
   */
  getCostAnomalyStatus(tenantId: string): CostAnomalyStatus {
    const timestamp = new Date().toISOString();
    try {
      const anomaly = this.getOrCreateAnomalyState(tenantId);
      const state = this.getOrCreateFingerprintState(tenantId);
      const fingerprint = state.cachedFingerprint;
      const currentLevel: DeviationLevel =
        anomaly.manualOverride !== null ? anomaly.manualOverride : anomaly.autoLevel;

      return {
        tenantId,
        currentLevel,
        manualOverride: anomaly.manualOverride,
        autoLevel: anomaly.autoLevel,
        blocked: anomaly.blocked,
        throttled: anomaly.throttled,
        requiresReauth: anomaly.requiresReauth,
        adjustmentFactor: anomaly.adjustmentFactor,
        recentDetections: [...anomaly.recentDetections],
        lastResponse: anomaly.lastResponse,
        fingerprintConfidence: fingerprint?.confidence ?? 0,
        activeSessions: state.activeSessions.size,
        currentHourCost: state.currentHourCost,
        currentDayCost: state.currentDayCost,
        timestamp,
      };
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:getCostAnomalyStatus');
      return {
        tenantId,
        currentLevel: 1,
        manualOverride: null,
        autoLevel: 1,
        blocked: false,
        throttled: false,
        requiresReauth: false,
        adjustmentFactor: 1.0,
        recentDetections: [],
        lastResponse: null,
        fingerprintConfidence: 0,
        activeSessions: 0,
        currentHourCost: 0,
        currentDayCost: 0,
        timestamp,
      };
    }
  }

  // ── 交易记录与编排 ──────────────────────────────────────────────────

  /**
   * 记录一笔成本交易。这是主入口：
   * 1. 更新指纹原始累加器
   * 2. 周期性重建指纹
   * 3. 运行新型攻击检测
   * 4. 若启用自动响应且检测到异常则触发响应
   * 5. 无异常时逐步放宽调整因子
   */
  recordTransaction(record: CostRecord): void {
    try {
      if (!this.config.enabled) return;

      const state = this.getOrCreateFingerprintState(record.tenantId);
      const ts = Date.parse(record.timestamp) || Date.now();
      const date = new Date(ts);

      // —— 更新原始累加器 ——
      this.updateAccumulators(state, record, date);

      // —— 周期性重建指纹 ——
      if (Date.now() - state.lastFingerprintBuildAt >= this.config.fingerprintUpdateIntervalMs) {
        this.buildSpendingFingerprint(record.tenantId);
        // 重建后失效缓存的阈值，下次获取会重算
        this.cachedThresholds.delete(record.tenantId);
      }

      // —— 检测新型攻击 ——
      const detection = this.detectNovelEconomicAttack(record);

      if (detection.detected) {
        if (this.config.autoResponseEnabled) {
          this.respondToCostAnomaly(record.tenantId, detection);
        } else {
          // 仅记录检测，不自动响应
          const anomaly = this.getOrCreateAnomalyState(record.tenantId);
          anomaly.recentDetections.push(detection);
          if (anomaly.recentDetections.length > MAX_RECENT_DETECTIONS) {
            anomaly.recentDetections.shift();
          }
          this.logSecurityEvent(
            'medium',
            `检测到新型经济攻击（自动响应已禁用）: ${detection.attackType}`,
            {
              tenantId: record.tenantId,
              attackType: detection.attackType,
              sigma: detection.deviationSigma,
              description: detection.description,
            },
          );
        }
      } else {
        // 无异常：逐步放宽调整因子
        this.relaxAdjustmentFactor(record.tenantId);
      }
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:recordTransaction');
    }
  }

  /** 更新指纹构建所需的原始累加器。 */
  private updateAccumulators(state: TenantFingerprintState, record: CostRecord, date: Date): void {
    const hour = date.getHours();
    const dayKey = date.toISOString().slice(0, 10);

    // 时段分布
    state.hourlyCosts[hour] = (state.hourlyCosts[hour] ?? 0) + record.cost;

    // 模型计数
    state.modelCounts.set(record.model, (state.modelCounts.get(record.model) ?? 0) + 1);

    // 每模型成本统计
    const modelStats = state.modelCostStats.get(record.model) ?? newRunningStats();
    runningStatsAdd(modelStats, record.cost);
    state.modelCostStats.set(record.model, modelStats);

    // 请求尺寸
    runningStatsAdd(state.requestSizeStats, record.requestSize);
    pushWindow(state.requestSizeWindow, record.requestSize, REQUEST_WINDOW_SIZE);

    // 单条成本（用于 3σ 通用偏差检测）
    runningStatsAdd(state.costStats, record.cost);

    // 工具调用（按会话累计后入统计）
    // 注意：这里按单条记录的工具调用数累积到会话级，简化处理
    pushWindow(state.toolCallWindow, record.toolCalls, TOOL_WINDOW_SIZE);
    if (record.toolCalls > 0) {
      runningStatsAdd(state.toolCallStats, record.toolCalls);
    }

    // 输入/输出比率
    if (record.outputTokens > 0) {
      runningStatsAdd(state.ioRatioStats, record.inputTokens / record.outputTokens);
    }

    // 周期性
    const weekend = isWeekend(date);
    if (weekend) {
      state.weekendCost += record.cost;
      state.weekendDays.add(dayKey);
    } else {
      state.weekdayCost += record.cost;
      state.weekdayDays.add(dayKey);
    }
    if (isEndOfMonth(date)) {
      state.endOfMonthCost += record.cost;
      state.endOfMonthDays.add(dayKey);
    } else {
      state.nonEndOfMonthCost += record.cost;
      state.nonEndOfMonthDays.add(dayKey);
    }

    // 增长趋势（按周桶）
    const weekStart = startOfWeek(date).getTime();
    const lastBucket = state.weeklyBuckets[state.weeklyBuckets.length - 1];
    if (lastBucket && lastBucket.weekStart === weekStart) {
      lastBucket.cost += record.cost;
    } else {
      state.weeklyBuckets.push({ weekStart, cost: record.cost });
      if (state.weeklyBuckets.length > WEEKLY_BUCKETS) {
        state.weeklyBuckets.shift();
      }
    }

    // 当前周期累加器
    if (state.currentHour !== hour) {
      // 小时切换：将上一小时成本入窗
      if (state.currentHourCost > 0) {
        pushWindow(state.hourlyCostWindow, state.currentHourCost, COST_WINDOW_SIZE);
      }
      state.currentHour = hour;
      state.currentHourCost = 0;
    }
    state.currentHourCost += record.cost;

    if (state.currentDay !== dayKey) {
      if (state.currentDayCost > 0) {
        pushWindow(state.dailyCostWindow, state.currentDayCost, COST_WINDOW_SIZE);
      }
      state.currentDay = dayKey;
      state.currentDayCost = 0;
    }
    state.currentDayCost += record.cost;

    // 会话成本累加
    const sessionCost = state.currentSessionCosts.get(record.sessionId) ?? 0;
    const newSessionCost = sessionCost + record.cost;
    state.currentSessionCosts.set(record.sessionId, newSessionCost);

    // 活跃会话
    state.activeSessions.add(record.sessionId);
    // 清理超过 1 小时无活动的会话（基于最后记录时间近似）
    this.pruneInactiveSessions(state, Date.parse(record.timestamp) || Date.now());

    // 梯度爬升历史
    state.spendingRateHistory.push({
      timestamp: Date.parse(record.timestamp) || Date.now(),
      cost: record.cost,
    });
    // 保留窗口外 + 余量
    const historyCutoff = Date.now() - this.config.gradientEscalationWindowMs * 2;
    while (
      state.spendingRateHistory.length > 0 &&
      state.spendingRateHistory[0]!.timestamp < historyCutoff
    ) {
      state.spendingRateHistory.shift();
    }

    // 元数据
    state.dataPoints++;
    state.lastUpdated = new Date().toISOString();
  }

  /** 清理长时间无活动的会话。 */
  private pruneInactiveSessions(state: TenantFingerprintState, now: number): void {
    // 简化：将会话成本入窗后从活跃集合移除依赖外部通知；
    // 这里基于会话数上限做 LRU 式裁剪，避免无限增长。
    if (state.activeSessions.size > 1000) {
      const toRemove = [...state.activeSessions].slice(0, 500);
      for (const sid of toRemove) {
        const cost = state.currentSessionCosts.get(sid);
        if (cost !== undefined) {
          pushWindow(state.sessionCostWindow, cost, COST_WINDOW_SIZE);
          state.currentSessionCosts.delete(sid);
        }
        state.activeSessions.delete(sid);
      }
    }
  }

  /** 会话结束时调用，将最终会话成本入窗。 */
  endSession(tenantId: string, sessionId: string): void {
    try {
      const state = this.getOrCreateFingerprintState(tenantId);
      const cost = state.currentSessionCosts.get(sessionId);
      if (cost !== undefined) {
        pushWindow(state.sessionCostWindow, cost, COST_WINDOW_SIZE);
        state.currentSessionCosts.delete(sessionId);
      }
      state.activeSessions.delete(sessionId);
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:endSession');
    }
  }

  /**
   * 无异常时逐步放宽调整因子（向 1.0 回归，稳定后可至 minAdjustmentFactor）。
   */
  private relaxAdjustmentFactor(tenantId: string): void {
    const anomaly = this.getOrCreateAnomalyState(tenantId);
    const now = Date.now();
    // 距上次异常超过 1 分钟才放宽一次，避免抖动
    if (now - anomaly.lastAnomalyAt < 60_000 && anomaly.lastAnomalyAt > 0) {
      return;
    }
    if (now - anomaly.lastNormalCheckAt < 60_000) {
      return;
    }
    anomaly.lastNormalCheckAt = now;

    if (anomaly.adjustmentFactor < 1.0) {
      // 收紧状态：向 1.0 逐步回归
      anomaly.adjustmentFactor = clamp(
        anomaly.adjustmentFactor + 0.05,
        this.config.maxAdjustmentFactor,
        1.0,
      );
    } else if (anomaly.adjustmentFactor < this.config.minAdjustmentFactor) {
      // 已正常：长期稳定后可略微放宽至上界
      anomaly.adjustmentFactor = clamp(
        anomaly.adjustmentFactor + 0.02,
        1.0,
        this.config.minAdjustmentFactor,
      );
    }

    // 恢复响应状态标志
    if (anomaly.adjustmentFactor >= 1.0 && anomaly.autoLevel <= 2) {
      anomaly.blocked = false;
      anomaly.throttled = false;
      anomaly.requiresReauth = false;
      if (anomaly.autoLevel > 1 && now - anomaly.lastAnomalyAt > 300_000) {
        anomaly.autoLevel = 1;
      }
    }
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────

  private getOrCreateFingerprintState(tenantId: string): TenantFingerprintState {
    let state = this.fingerprintStates.get(tenantId);
    if (!state) {
      state = createFingerprintState(tenantId);
      this.fingerprintStates.set(tenantId, state);
    }
    return state;
  }

  private getOrCreateAnomalyState(tenantId: string): TenantAnomalyState {
    let state = this.anomalyStates.get(tenantId);
    if (!state) {
      state = createAnomalyState();
      this.anomalyStates.set(tenantId, state);
    }
    return state;
  }

  /** 记录指标（带静默失败保护）。 */
  private recordMetrics(name: string, value: number, labels: Record<string, string>): void {
    try {
      getGlobalMetrics().incrementCounter(`dynamicCostGuardian.${name}`, value, labels);
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:recordMetrics');
    }
  }

  /** 记录安全审计事件（带静默失败保护）。 */
  private logSecurityEvent(
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    details: Record<string, unknown>,
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_scan',
        severity,
        source: 'DynamicCostGuardian',
        message,
        details,
      });
    } catch (err) {
      reportSilentFailure(err, 'dynamicCostGuardian:logSecurityEvent');
    }
  }

  /** 重置所有内部状态（用于测试隔离）。 */
  resetState(): void {
    this.fingerprintStates.clear();
    this.anomalyStates.clear();
    this.cachedThresholds.clear();
  }
}

/** 返回某周的开始时间（周一 00:00 UTC）。 */
function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // 周一为起点
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 辅助：安全获取租户基线会话成本（用于多会话检测估算）。 */
function fingerprint0(state: TenantFingerprintState): number {
  return state.cachedFingerprint?.baselineSessionCost ?? CONSERVATIVE_DEFAULTS.baselineSessionCost;
}

// ============================================================================
// 单例
// ============================================================================

const dynamicCostGuardianSingleton = createTenantAwareSingleton(() => new DynamicCostGuardian(), {
  componentName: 'DynamicCostGuardian',
});

/**
 * 获取全局 DynamicCostGuardian（单租户）或按租户隔离的实例。
 */
export function getDynamicCostGuardian(config?: Partial<DynamicCostConfig>): DynamicCostGuardian {
  const guardian = dynamicCostGuardianSingleton.get();
  if (config) {
    guardian.reconfigure(config);
  }
  return guardian;
}

/** 重置 DynamicCostGuardian 单例（用于测试隔离）。 */
export function resetDynamicCostGuardian(): void {
  dynamicCostGuardianSingleton.reset();
}
