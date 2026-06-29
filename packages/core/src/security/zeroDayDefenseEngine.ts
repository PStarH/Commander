/**
 * ZeroDayDefenseEngine — 零日攻击防御引擎
 *
 * 防御「未知攻击」的核心模块——不依赖签名，而是基于行为基线和统计异常检测。
 *
 * 设计哲学：
 *   传统安全防御依赖已知签名（黑名单/规则），对零日攻击（未知漏洞利用、新型注入、
 *   协调攻击）束手无策。本引擎反过来思考：不为每一种攻击编写规则，而是为「正常」
 *   建立多维行为基线，任何显著偏离基线的行为都被视为潜在威胁。
 *
 * 核心能力：
 *   1. 多维度行为基线建模 —— 请求/Token/工具/API/用户五类基线
 *   2. 统计异常检测算法 —— Z-Score、EWMA 控制图、箱线图 IQR、马尔可夫链、频域分析
 *   3. 未知攻击模式推测 —— 协调攻击、慢攻击、分布式攻击、新型注入
 *   4. 自适应阈值学习 —— 滑动窗口、季节性调整、突发流量自适应
 *   5. 置信度评分系统 —— Dempster-Shafer 证据理论多信号融合
 *   6. 自动响应 —— LOG/MONITOR/THROTTLE/ISOLATE/MELT 分级处置
 *
 * 集成模块：
 *   - SecurityAuditLogger: 安全事件审计
 *   - SecurityMonitor: 实时安全监控告警
 *   - EnterpriseSecurityGateway: 企业安全网关态势联动
 *   - BillExplosionGuard: 账单爆炸防护关联（经济攻击维度）
 *   - GlobalLogger/GlobalMetrics: 日志与指标
 *
 * 使用方式：
 *   import { getZeroDayDefenseEngine } from './security/zeroDayDefenseEngine';
 *   const engine = getZeroDayDefenseEngine();
 *
 *   // 记录指标（每次请求/调用后）
 *   engine.recordMetric('request_rate', 'rps', currentRps, source);
 *   engine.recordMetric('token_usage', 'input_output_ratio', ratio);
 *
 *   // 周期性风险评估
 *   const assessment = engine.assessRisk();
 *   if (assessment.recommendedAction === 'ISOLATE') {
 *     // 执行隔离
 *   }
 */

import { getSecurityAuditLogger } from './securityAuditLogger';
import { getSecurityMonitor } from './securityMonitor';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getEnterpriseSecurityGateway } from './enterpriseSecurityGateway';
import { getBillExplosionGuard } from './billExplosionGuard';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 指标类型——对应五类行为基线维度。
 * - request_rate: 请求模式基线（频率、大小、时间分布、来源分布）
 * - token_usage: Token 使用模式基线（输入/输出比例、模型偏好、上下文长度）
 * - tool_call: 工具调用模式基线（调用序列、参数大小、输出大小、调用频率）
 * - api_pattern: API 调用模式基线（端点偏好、方法分布、响应时间）
 * - user_behavior: 用户行为基线（活跃时间、请求模式、地理分布）
 * - custom: 自定义指标
 */
export type MetricType =
  | 'request_rate'
  | 'token_usage'
  | 'tool_call'
  | 'api_pattern'
  | 'user_behavior'
  | 'custom';

/**
 * 自动响应推荐动作。
 * - LOG: 低风险——仅记录日志
 * - MONITOR: 中风险——增强监控
 * - THROTTLE: 高风险——限流 + 人工通知
 * - ISOLATE: 极高风险——自动隔离
 * - MELT: 极高风险——熔断（停止接受新请求）
 */
export type RecommendedAction = 'LOG' | 'MONITOR' | 'THROTTLE' | 'ISOLATE' | 'MELT';

/**
 * 推测出的零日攻击模式。
 * - none: 未检测到攻击模式
 * - coordinated: 协调攻击（多个低置信度异常信号同时出现）
 * - slow: 慢攻击（低频持续异常，单个不触发但累积危险）
 * - distributed: 分布式攻击（多源低频异常汇聚）
 * - novel_injection: 新型注入（语义异常但不符合已知模式）
 * - bill_explosion: 账单爆炸攻击（与 BillExplosionGuard 关联）
 */
export type DetectedAttackPattern =
  | 'none'
  | 'coordinated'
  | 'slow'
  | 'distributed'
  | 'novel_injection'
  | 'bill_explosion';

/**
 * 行为基线——单个指标的统计画像。
 */
export interface BehaviorBaseline {
  /** 指标名称（格式：type:name） */
  metricName: string;
  /** 滑动窗口内的样本值 */
  samples: number[];
  /** 样本均值 */
  mean: number;
  /** 样本标准差 */
  stdDev: number;
  /** 指数加权移动平均值（EWMA） */
  ewma: number;
  /** 最后更新时间戳（ms） */
  lastUpdate: number;
  /** 累计样本数 */
  sampleCount: number;
}

/**
 * 异常信号——单个指标的一次异常检测输出。
 */
export interface AnomalySignal {
  /** 指标名称 */
  metricName: string;
  /** 当前观测值 */
  value: number;
  /** Z-Score（偏离均值的标准差倍数） */
  zScore: number;
  /** EWMA 控制图偏离度（0-1，越接近 1 越异常） */
  ewmaDeviation: number;
  /** 箱线图 IQR 异常分值（0 表示在须内，>0 表示越界程度） */
  iqrScore: number;
  /** 独立置信度（0-1）——该信号确信为异常的程度 */
  confidence: number;
  /** 信号产生时间戳（ms） */
  timestamp: number;
  /** 人类可读的异常描述 */
  description: string;
}

/**
 * 零日风险评估结果——融合所有异常信号后的综合判断。
 */
export interface ZeroDayRiskAssessment {
  /** 最终风险评分（0-100） */
  riskScore: number;
  /** 评估整体置信度（0-1）——融合后结论的决断程度 */
  confidence: number;
  /** 参与评估的异常信号集合 */
  signals: AnomalySignal[];
  /** 推荐的自动响应动作 */
  recommendedAction: RecommendedAction;
  /** Dempster-Shafer 融合后对「正在遭受攻击」的信念值（0-1） */
  fusedBelief: number;
  /** 推测出的攻击模式 */
  detectedAttackPattern: DetectedAttackPattern;
}

/**
 * 引擎配置。
 */
export interface ZeroDayConfig {
  /** 滑动窗口最大样本数 */
  windowSize: number;
  /** Z-Score 异常阈值（偏离均值多少个标准差视为异常） */
  zScoreThreshold: number;
  /** EWMA 平滑系数 alpha（0-1，越大越敏感于近期变化） */
  ewmaAlpha: number;
  /** EWMA 控制限系数 k（控制限 = ewma ± k * 控制带） */
  ewmaK: number;
  /** 箱线图 IQR 须倍数（通常 1.5） */
  iqrCoefficient: number;
  /** 马尔可夫链低概率转移阈值（低于此概率视为序列异常） */
  markovAnomalyThreshold: number;
  /** 频域分析频谱偏离阈值（0-1） */
  frequencyAnomalyThreshold: number;
  /** 最小样本数（低于此数不执行异常检测） */
  minSamples: number;
  /** 风险评估回看窗口（ms）——只融合此窗口内的异常信号 */
  riskLookbackMs: number;
  /** 慢攻击累积异常分阈值（累积超过此值判定慢攻击） */
  slowAttackAccumulationThreshold: number;
  /** 慢攻击检测窗口（ms） */
  slowAttackWindowMs: number;
  /** 分布式攻击最小独立来源数 */
  distributedMinSources: number;
  /** 分布式攻击检测窗口（ms） */
  distributedWindowMs: number;
  /** 协调攻击最小并发异常信号数 */
  coordinatedMinSignals: number;
  /** 协调攻击单信号置信度上限（「低置信度」的定义） */
  coordinatedMaxIndividualConfidence: number;
  /** 新型注入最小语义异常信号数 */
  novelInjectionMinSemanticSignals: number;
  /** 风险等级阈值（riskScore 边界） */
  riskThresholds: {
    /** 低于此值为低风险 */
    low: number;
    /** 低于此值为中风险 */
    medium: number;
    /** 低于此值为高风险 */
    high: number;
    /** 高于等于此值为极高风险 */
    extreme: number;
  };
  /** 是否启用季节性调整（工作日/周末/节假日） */
  enableSeasonalAdjustment: boolean;
  /** 是否启用突发流量自适应（阈值放宽） */
  enableBurstAdaptation: boolean;
  /** 突发流量检测倍数（当前速率超过均值多少倍视为突发） */
  burstDetectionMultiplier: number;
  /** 突发模式下的阈值放宽因子（>1 放宽） */
  burstRelaxFactor: number;
  /** 基线自动更新间隔（ms） */
  baselineUpdateIntervalMs: number;
  /** 风险历史最大保留条数 */
  maxRiskHistory: number;
  /** 各指标类型在融合中的权重（0-1） */
  metricWeights: Record<MetricType, number>;
}

// ============================================================================
// 内部类型
// ============================================================================

/** 内部扩展基线——包含异常检测所需的额外状态 */
interface InternalBaseline extends BehaviorBaseline {
  /** 指标类型 */
  metricType: MetricType;
  /** 排序后的样本（用于 IQR 计算，缓存避免每次重排） */
  sortedSamples: number[];
  /** EWMA 方差估计（用于控制限计算） */
  ewmaVariance: number;
  /** 马尔可夫链转移计数：fromState -> (toState -> count) */
  transitionCounts: Map<string, Map<string, number>>;
  /** 该基线累计转移总数 */
  totalTransitions: number;
  /** 上一个离散状态（用于转移概率计算） */
  lastState: string | null;
  /** 基线频谱平坦度（用于频域异常比较） */
  baselineSpectralFlatness: number;
  /** 当前频谱平坦度 */
  currentSpectralFlatness: number;
  /** 慢攻击累积异常分（指数衰减） */
  anomalyAccumulator: number;
  /** 来源 -> 该来源贡献的异常分（用于分布式攻击检测） */
  sources: Map<string, number>;
  /** 最近一次异常时间戳（ms） */
  lastAnomalyTimestamp: number;
}

/** 攻击检测结果 */
interface AttackDetectionResult {
  /** 是否检测到该类攻击 */
  detected: boolean;
  /** 检测置信度（0-1） */
  confidence: number;
  /** 相关异常信号 */
  signals: AnomalySignal[];
  /** 检测描述 */
  description: string;
}

/** 风险历史条目 */
interface RiskHistoryEntry {
  timestamp: number;
  riskScore: number;
  confidence: number;
  action: RecommendedAction;
  attackPattern: DetectedAttackPattern;
}

/** Dempster-Shafer 基本概率分配（BPA） */
interface BPA {
  /** m({攻击})——确信为攻击的质量 */
  attack: number;
  /** m({非攻击})——确信非攻击的质量 */
  noAttack: number;
  /** m({攻击,非攻击})——不确定的质量 */
  unknown: number;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: ZeroDayConfig = {
  windowSize: 256,
  zScoreThreshold: 3.0,
  ewmaAlpha: 0.3,
  ewmaK: 3.0,
  iqrCoefficient: 1.5,
  markovAnomalyThreshold: 0.05,
  frequencyAnomalyThreshold: 0.4,
  minSamples: 20,
  riskLookbackMs: 5 * 60 * 1000,
  slowAttackAccumulationThreshold: 5.0,
  slowAttackWindowMs: 60 * 60 * 1000,
  distributedMinSources: 5,
  distributedWindowMs: 30 * 60 * 1000,
  coordinatedMinSignals: 3,
  coordinatedMaxIndividualConfidence: 0.5,
  novelInjectionMinSemanticSignals: 2,
  riskThresholds: {
    low: 30,
    medium: 60,
    high: 80,
    extreme: 80,
  },
  enableSeasonalAdjustment: true,
  enableBurstAdaptation: true,
  burstDetectionMultiplier: 3.0,
  burstRelaxFactor: 1.5,
  baselineUpdateIntervalMs: 5 * 60 * 1000,
  maxRiskHistory: 1000,
  metricWeights: {
    request_rate: 1.0,
    token_usage: 0.9,
    tool_call: 1.0,
    api_pattern: 0.8,
    user_behavior: 0.7,
    custom: 0.5,
  },
};

/** 指标键分隔符 */
const METRIC_KEY_SEP = '::';

// ============================================================================
// 统计学辅助函数（纯函数）
// ============================================================================

/**
 * 计算算术平均值。
 * @param values - 数值数组
 * @returns 平均值（空数组返回 0）
 */
function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * 计算总体标准差。
 * @param values - 数值数组
 * @param mean - 预计算均值（若未提供则内部计算）
 * @returns 标准差（不足 2 个样本返回 0）
 */
function computeStdDev(values: number[], mean?: number): number {
  if (values.length < 2) return 0;
  const m = mean ?? computeMean(values);
  let sqSum = 0;
  for (const v of values) {
    const diff = v - m;
    sqSum += diff * diff;
  }
  return Math.sqrt(sqSum / values.length);
}

/**
 * 计算分位数（线性插值法）。
 * @param sorted - 已升序排序的数组
 * @param q - 分位数（0-1）
 * @returns 分位数值
 */
function computePercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  const frac = pos - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac;
}

/**
 * 计算箱线图 IQR 异常分值。
 * @param sorted - 已升序排序的样本
 * @param value - 待检测值
 * @param coefficient - 须倍数（通常 1.5）
 * @returns 0 表示在须内（正常），>0 表示越界程度（归一化到 IQR）
 */
function computeIqrScore(sorted: number[], value: number, coefficient: number): number {
  if (sorted.length < 4) return 0;
  const q1 = computePercentile(sorted, 0.25);
  const q3 = computePercentile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr < 1e-9) return 0;
  const lowerFence = q1 - coefficient * iqr;
  const upperFence = q3 + coefficient * iqr;
  if (value >= lowerFence && value <= upperFence) return 0;
  if (value < lowerFence) return (lowerFence - value) / iqr;
  return (value - upperFence) / iqr;
}

/**
 * 更新 EWMA（指数加权移动平均）。
 * @param prevEwma - 上一个 EWMA 值
 * @param value - 新观测值
 * @param alpha - 平滑系数
 * @returns 新的 EWMA 值
 */
function updateEwma(prevEwma: number, value: number, alpha: number): number {
  return alpha * value + (1 - alpha) * prevEwma;
}

/**
 * 计算 EWMA 控制图偏离度。
 * 控制限宽度 = k * stdDev * sqrt(alpha / (2 - alpha) * (1 - (1-alpha)^(2t)))，
 * 此处简化为 k * sqrt(ewmaVariance) 的稳态近似。
 * @param value - 当前观测值
 * @param ewma - 当前 EWMA
 * @param ewmaVariance - EWMA 方差估计
 * @param k - 控制限系数
 * @returns 偏离度（0-1，>=1 表示越界）
 */
function computeEwmaDeviation(
  value: number,
  ewma: number,
  ewmaVariance: number,
  k: number,
): number {
  const sigma = Math.sqrt(ewmaVariance);
  if (sigma < 1e-9) return 0;
  const controlWidth = k * sigma;
  if (controlWidth < 1e-9) return 0;
  return Math.abs(value - ewma) / controlWidth;
}

/**
 * 将数值离散化为马尔可夫链状态（基于均值/标准差的分箱）。
 * @param value - 观测值
 * @param mean - 基线均值
 * @param stdDev - 基线标准差
 * @returns 离散状态字符串
 */
function discretizeState(value: number, mean: number, stdDev: number): string {
  if (stdDev < 1e-9) return 'c';
  const step = stdDev * 1.5;
  const offset = Math.round((value - mean) / step);
  const clamped = Math.max(-4, Math.min(4, offset));
  return `b${clamped}`;
}

/**
 * 计算简化的离散傅里叶变换（DFT）幅度谱。
 * 为控制计算复杂度，最多取最近 maxLen 个样本。
 * @param samples - 样本数组
 * @param maxLen - 最大参与计算的样本数
 * @returns 归一化幅度谱
 */
function computeDftMagnitude(samples: number[], maxLen: number = 64): number[] {
  const data = samples.length > maxLen ? samples.slice(-maxLen) : samples;
  const N = data.length;
  if (N < 2) return [];
  const spectrum: number[] = [];
  // 只计算前 N/2+1 个频率分量（实信号频谱对称）
  const half = Math.floor(N / 2) + 1;
  for (let k = 0; k < half; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      re += data[n]! * Math.cos(angle);
      im += data[n]! * Math.sin(angle);
    }
    spectrum.push(Math.sqrt(re * re + im * im) / N);
  }
  return spectrum;
}

/**
 * 计算频谱平坦度（Wiener 熵）。
 * 纯音 → 0（集中于单一频率）；白噪声 → 1（能量均匀分布）。
 * @param spectrum - 幅度谱
 * @returns 平坦度（0-1）
 */
function computeSpectralFlatness(spectrum: number[]): number {
  if (spectrum.length === 0) return 1;
  let sum = 0;
  let logSum = 0;
  let validCount = 0;
  for (const m of spectrum) {
    if (m < 1e-12) continue;
    sum += m;
    logSum += Math.log(m);
    validCount++;
  }
  if (validCount === 0 || sum < 1e-12) return 1;
  const arithMean = sum / spectrum.length;
  const geoMean = Math.exp(logSum / validCount);
  if (arithMean < 1e-12) return 1;
  return Math.max(0, Math.min(1, geoMean / arithMean));
}

/**
 * 将数值限制在 [min, max] 范围内。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 逻辑斯蒂函数——将任意实数映射到 (0,1)。
 * @param x - 输入
 * @returns (0,1) 之间的值
 */
function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

// ============================================================================
// Dempster-Shafer 证据理论融合
// ============================================================================

/**
 * 将单个异常信号转换为基本概率分配（BPA）。
 * @param signal - 异常信号
 * @param weight - 该指标类型的融合权重
 * @returns BPA（attack/noAttack/unknown 质量之和为 1）
 */
function signalToBpa(signal: AnomalySignal, weight: number): BPA {
  const w = clamp(weight, 0, 1);
  const c = clamp(signal.confidence, 0, 1);
  return {
    attack: c * w,
    noAttack: (1 - c) * w,
    unknown: 1 - w,
  };
}

/**
 * Dempster 组合规则——融合两个 BPA。
 * 处理冲突：K = m1({A})*m2({N}) + m1({N})*m2({A})，归一化消除冲突。
 * @param a - 第一个 BPA
 * @param b - 第二个 BPA
 * @returns 融合后的 BPA
 */
function combineBpa(a: BPA, b: BPA): BPA {
  const conflict = a.attack * b.noAttack + a.noAttack * b.attack;
  const denom = 1 - conflict;
  if (denom < 1e-12) {
    // 完全冲突——返回最大不确定
    return { attack: 0, noAttack: 0, unknown: 1 };
  }
  const attack = (a.attack * b.attack + a.attack * b.unknown + a.unknown * b.attack) / denom;
  const noAttack =
    (a.noAttack * b.noAttack + a.noAttack * b.unknown + a.unknown * b.noAttack) / denom;
  const unknown = (a.unknown * b.unknown) / denom;
  // 数值稳定化：确保归一
  const total = attack + noAttack + unknown;
  if (total < 1e-12) return { attack: 0, noAttack: 0, unknown: 1 };
  return {
    attack: attack / total,
    noAttack: noAttack / total,
    unknown: unknown / total,
  };
}

/**
 * 融合多个 BPA（左折叠 combineBpa）。
 * @param bpas - BPA 数组
 * @returns 融合后的 BPA；空数组返回全不确定
 */
function fuseBpas(bpas: BPA[]): BPA {
  if (bpas.length === 0) return { attack: 0, noAttack: 0, unknown: 1 };
  let acc = bpas[0]!;
  for (let i = 1; i < bpas.length; i++) {
    acc = combineBpa(acc, bpas[i]!);
  }
  return acc;
}

// ============================================================================
// ZeroDayDefenseEngine
// ============================================================================

export class ZeroDayDefenseEngine {
  private config: ZeroDayConfig;
  /** 所有指标的基线：metricKey -> InternalBaseline */
  private baselines: Map<string, InternalBaseline> = new Map();
  /** 最近产生的异常信号（用于风险评估） */
  private recentSignals: AnomalySignal[] = [];
  /** 风险评分历史 */
  private riskHistory: RiskHistoryEntry[] = [];
  /** 最近一次基线自动更新时间 */
  private lastBaselineUpdate: number = 0;
  /** 当前是否处于突发流量模式 */
  private burstMode: boolean = false;
  /** 最近一次突发模式检测时间 */
  private lastBurstCheck: number = 0;

  constructor(config?: Partial<ZeroDayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastBaselineUpdate = Date.now();
  }

  // ── 配置管理 ──────────────────────────────────────────────────────

  /**
   * 更新引擎配置（合并式）。
   * @param config - 部分配置
   */
  configure(config: Partial<ZeroDayConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      riskThresholds: { ...this.config.riskThresholds, ...config.riskThresholds },
      metricWeights: { ...this.config.metricWeights, ...config.metricWeights },
    };
    try {
      getGlobalLogger().info('ZeroDayDefenseEngine', '配置已更新', {
        zScoreThreshold: this.config.zScoreThreshold,
        enableSeasonalAdjustment: this.config.enableSeasonalAdjustment,
        enableBurstAdaptation: this.config.enableBurstAdaptation,
      });
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:configure');
    }
  }

  /**
   * 获取当前配置副本。
   * @returns 当前配置
   */
  getConfig(): ZeroDayConfig {
    return {
      ...this.config,
      riskThresholds: { ...this.config.riskThresholds },
      metricWeights: { ...this.config.metricWeights },
    };
  }

  // ── 核心指标记录与异常检测 ──────────────────────────────────────────

  /**
   * 记录指标值并更新基线，同时执行多算法异常检测。
   *
   * 处理流程：
   *   1. 获取/创建该指标的基线
   *   2. 将新值加入滑动窗口（超出窗口则丢弃最旧）
   *   3. 更新统计量（均值、标准差、EWMA、方差）
   *   4. 执行五种异常检测算法
   *   5. 融合各算法结果为单一置信度
   *   6. 若判定为异常，生成 AnomalySignal 并存入近期信号池
   *   7. 更新马尔可夫链转移计数与频谱基线
   *
   * @param type - 指标类型（对应五类行为基线维度）
   * @param name - 指标名称（如 'rps'、'input_output_ratio'）
   * @param value - 观测值
   * @param source - 请求来源标识（可选，用于分布式攻击检测）
   * @returns 若检测到异常则返回 AnomalySignal，否则返回 null
   */
  recordMetric(
    type: MetricType,
    name: string,
    value: number,
    source?: string,
  ): AnomalySignal | null {
    const metricKey = `${type}${METRIC_KEY_SEP}${name}`;
    const now = Date.now();
    const baseline = this.getOrCreateBaseline(type, metricKey, value, now);

    // ── 1. 更新样本窗口 ──
    baseline.samples.push(value);
    if (baseline.samples.length > this.config.windowSize) {
      baseline.samples.shift();
    }
    baseline.sampleCount++;
    baseline.lastUpdate = now;

    // ── 2. 重算统计量 ──
    baseline.mean = computeMean(baseline.samples);
    baseline.stdDev = computeStdDev(baseline.samples, baseline.mean);
    baseline.ewma = updateEwma(baseline.ewma, value, this.config.ewmaAlpha);
    // EWMA 方差递推更新
    const ewmaDiff = value - baseline.ewma;
    baseline.ewmaVariance =
      (1 - this.config.ewmaAlpha) * baseline.ewmaVariance +
      this.config.ewmaAlpha * ewmaDiff * ewmaDiff;

    // 重排序缓存（IQR 用）
    baseline.sortedSamples = [...baseline.samples].sort((a, b) => a - b);

    // ── 3. 样本不足时不检测 ──
    if (baseline.samples.length < this.config.minSamples) {
      this.updateMarkovChain(baseline, value);
      return null;
    }

    // ── 4. 五种异常检测算法 ──
    const zScore = baseline.stdDev > 1e-9 ? (value - baseline.mean) / baseline.stdDev : 0;
    const ewmaDeviation = computeEwmaDeviation(
      value,
      baseline.ewma,
      baseline.ewmaVariance,
      this.config.ewmaK,
    );
    const iqrScore = computeIqrScore(
      baseline.sortedSamples,
      value,
      this.config.iqrCoefficient * this.currentRelaxFactor(),
    );
    const markovAnomaly = this.detectMarkovAnomaly(baseline, value);
    const frequencyAnomaly = this.detectFrequencyAnomaly(baseline);

    // ── 5. 融合为单一置信度 ──
    const confidence = this.fuseDetectionConfidence({
      zScore,
      ewmaDeviation,
      iqrScore,
      markovAnomaly,
      frequencyAnomaly,
    });

    // ── 6. 生成异常信号（仅当置信度超过阈值） ──
    let signal: AnomalySignal | null = null;
    if (confidence > 0.5) {
      const relax = this.currentRelaxFactor();
      const description = this.describeAnomaly(
        metricKey,
        value,
        zScore,
        ewmaDeviation,
        iqrScore,
        markovAnomaly,
        frequencyAnomaly,
      );
      signal = {
        metricName: metricKey,
        value,
        zScore,
        ewmaDeviation: clamp(ewmaDeviation, 0, 1),
        iqrScore: clamp(iqrScore, 0, 10),
        confidence,
        timestamp: now,
        description,
      };
      this.recentSignals.push(signal);
      this.trimRecentSignals();
      baseline.lastAnomalyTimestamp = now;
      baseline.anomalyAccumulator += confidence;

      // 来源记录（分布式攻击检测用）
      if (source) {
        baseline.sources.set(source, (baseline.sources.get(source) ?? 0) + confidence);
      }

      // 记录指标
      this.recordAnomalyMetric(type, confidence, relax);
    }

    // ── 7. 更新马尔可夫链与频谱基线 ──
    this.updateMarkovChain(baseline, value);
    this.updateFrequencyBaseline(baseline);

    return signal;
  }

  // ── 风险评估 ──────────────────────────────────────────────────────

  /**
   * 评估当前整体风险——融合所有近期异常信号与攻击模式检测结果。
   *
   * 处理流程：
   *   1. 收集风险回看窗口内的异常信号
   *   2. 运行三类未知攻击模式检测（慢攻击/分布式/新型注入）
   *   3. 检测协调攻击（多低置信度信号并发）与账单爆炸关联
   *   4. 将所有信号通过 Dempster-Shafer 证据理论融合
   *   5. 计算风险评分（0-100）与推荐动作
   *   6. 执行自动响应（LOG/MONITOR/THROTTLE/ISOLATE/MELT）
   *   7. 记录到风险历史
   *
   * @returns 综合风险评估结果
   */
  assessRisk(): ZeroDayRiskAssessment {
    const now = Date.now();
    const lookbackStart = now - this.config.riskLookbackMs;

    // ── 1. 收集窗口内信号 ──
    const activeSignals = this.recentSignals.filter((s) => s.timestamp >= lookbackStart);

    // ── 2. 攻击模式检测 ──
    const slowResult = this.detectSlowAttack();
    const distributedResult = this.detectDistributedAttack();
    const novelResult = this.detectNovelInjection();
    const billResult = this.detectBillExplosionCorrelation();

    // ── 3. 协调攻击检测 ──
    const coordinatedResult = this.detectCoordinatedAttack(activeSignals);

    // ── 4. 汇总所有信号 ──
    const allSignals: AnomalySignal[] = [
      ...activeSignals,
      ...slowResult.signals,
      ...distributedResult.signals,
      ...novelResult.signals,
      ...billResult.signals,
      ...coordinatedResult.signals,
    ];

    // 去重（按 metricName+timestamp）
    const dedupedSignals = this.deduplicateSignals(allSignals);

    // ── 5. Dempster-Shafer 融合 ──
    const bpas = dedupedSignals.map((s) => {
      const type = this.extractMetricType(s.metricName);
      const weight = this.config.metricWeights[type] ?? 0.5;
      return signalToBpa(s, weight);
    });
    const fused = fuseBpas(bpas);
    const fusedBelief = fused.attack;

    // ── 6. 计算风险评分 ──
    // 风险 = 确信攻击的信念 + 不确定的一半（不确定性本身也是风险）
    const rawRisk = (fused.attack + 0.5 * fused.unknown) * 100;

    // 攻击模式加成
    let attackPattern: DetectedAttackPattern = 'none';
    let patternBoost = 0;
    const detectedPatterns: Array<{ pattern: DetectedAttackPattern; boost: number }> = [];
    if (coordinatedResult.detected) detectedPatterns.push({ pattern: 'coordinated', boost: 10 });
    if (slowResult.detected) detectedPatterns.push({ pattern: 'slow', boost: 8 });
    if (distributedResult.detected) detectedPatterns.push({ pattern: 'distributed', boost: 12 });
    if (novelResult.detected) detectedPatterns.push({ pattern: 'novel_injection', boost: 15 });
    if (billResult.detected) detectedPatterns.push({ pattern: 'bill_explosion', boost: 10 });

    for (const dp of detectedPatterns) {
      patternBoost = Math.max(patternBoost, dp.boost);
      // 选择最严重的攻击模式
      if (dp.boost >= patternBoost) attackPattern = dp.pattern;
    }

    const riskScore = clamp(Math.round(rawRisk + patternBoost), 0, 100);
    const confidence = clamp(1 - fused.unknown, 0, 1);

    // ── 7. 推荐动作 ──
    const recommendedAction = this.scoreToAction(riskScore);

    // ── 8. 执行自动响应 ──
    this.executeAutoResponse(riskScore, recommendedAction, attackPattern, dedupedSignals);

    // ── 9. 记录历史 ──
    const historyEntry: RiskHistoryEntry = {
      timestamp: now,
      riskScore,
      confidence,
      action: recommendedAction,
      attackPattern,
    };
    this.riskHistory.push(historyEntry);
    if (this.riskHistory.length > this.config.maxRiskHistory) {
      this.riskHistory.shift();
    }

    // ── 10. 记录指标 ──
    try {
      const metrics = getGlobalMetrics();
      metrics.setGauge('zeroday.risk_score', riskScore, { attack_pattern: attackPattern });
      metrics.setGauge('zeroday.fused_belief', fusedBelief, {});
      metrics.setGauge('zeroday.signal_count', dedupedSignals.length, {});
      metrics.setGauge('zeroday.assessment_confidence', confidence, {});
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:assessRiskMetrics');
    }

    return {
      riskScore,
      confidence,
      signals: dedupedSignals,
      recommendedAction,
      fusedBelief,
      detectedAttackPattern: attackPattern,
    };
  }

  // ── 未知攻击模式检测 ──────────────────────────────────────────────

  /**
   * 检测慢攻击——低频持续异常，单个不触发但累积危险。
   *
   * 慢攻击的特征：攻击者刻意压低速率，每个单独请求/行为都落在正常阈值内，
   * 但持续偏离基线，长时间累积后形成实质威胁（如缓慢的数据外渗、低频探测）。
   *
   * 检测方法：
   *   1. 遍历所有基线的异常累积分（指数衰减）
   *   2. 若某基线累积分超过阈值，且单次异常都不够强（低频），判定为慢攻击
   *   3. 衰减窗口内的累积分
   *
   * @returns 慢攻击检测结果
   */
  detectSlowAttack(): AttackDetectionResult {
    const now = Date.now();
    const windowStart = now - this.config.slowAttackWindowMs;
    const signals: AnomalySignal[] = [];
    let maxAccumulator = 0;
    let worstMetric = '';

    for (const [metricKey, baseline] of this.baselines) {
      // 指数衰减累积分（时间越久远衰减越多）
      const elapsed = now - baseline.lastAnomalyTimestamp;
      if (baseline.lastAnomalyTimestamp < windowStart) {
        // 超出窗口，清零累积
        baseline.anomalyAccumulator = 0;
        continue;
      }
      const decayFactor = Math.exp(-elapsed / (this.config.slowAttackWindowMs / 3));
      const effectiveAccumulator = baseline.anomalyAccumulator * decayFactor;

      if (effectiveAccumulator > maxAccumulator) {
        maxAccumulator = effectiveAccumulator;
        worstMetric = metricKey;
      }

      // 单次异常都不强（< 0.7）但累积很高 → 慢攻击特征
      if (
        effectiveAccumulator >= this.config.slowAttackAccumulationThreshold &&
        baseline.lastAnomalyTimestamp >= windowStart
      ) {
        const confidence = clamp(
          effectiveAccumulator / (this.config.slowAttackAccumulationThreshold * 2),
          0,
          0.9,
        );
        signals.push({
          metricName: metricKey,
          value: effectiveAccumulator,
          zScore: 0,
          ewmaDeviation: 0,
          iqrScore: 0,
          confidence,
          timestamp: now,
          description: `慢攻击：指标 ${metricKey} 累积异常分 ${effectiveAccumulator.toFixed(2)} 超过阈值 ${this.config.slowAttackAccumulationThreshold}（单次均未强触发）`,
        });
      }
    }

    const detected = signals.length > 0;
    const confidence = detected
      ? clamp(maxAccumulator / (this.config.slowAttackAccumulationThreshold * 2), 0, 0.9)
      : 0;

    if (detected) {
      try {
        getGlobalLogger().warn(
          'ZeroDayDefenseEngine',
          `检测到慢攻击（最严重指标: ${worstMetric}）`,
          {
            maxAccumulator: maxAccumulator.toFixed(2),
            threshold: this.config.slowAttackAccumulationThreshold,
          },
        );
      } catch (err) {
        reportSilentFailure(err, 'zeroDayDefenseEngine:detectSlowAttack');
      }
    }

    return {
      detected,
      confidence,
      signals,
      description: detected
        ? `检测到慢攻击：${signals.length} 个指标存在低频持续累积异常`
        : '未检测到慢攻击',
    };
  }

  /**
   * 检测分布式攻击——多源低频异常汇聚。
   *
   * 分布式攻击的特征：攻击者从大量不同来源发起低频请求，每个来源的行为
   * 都不触发单源阈值，但多源汇聚后形成协同威胁（如分布式探测、慢速 DDoS）。
   *
   * 检测方法：
   *   1. 汇总窗口内各来源贡献的异常分
   *   2. 统计独立来源数与总异常分
   *   3. 若来源数 >= 阈值且每源贡献低（单源不构成威胁），判定为分布式攻击
   *
   * @returns 分布式攻击检测结果
   */
  detectDistributedAttack(): AttackDetectionResult {
    const now = Date.now();
    const windowStart = now - this.config.distributedWindowMs;
    const sourceScores: Map<string, number> = new Map();

    // 汇总所有基线中各来源的异常分
    for (const baseline of this.baselines.values()) {
      for (const [src, score] of baseline.sources) {
        sourceScores.set(src, (sourceScores.get(src) ?? 0) + score);
      }
    }

    // 过滤窗口内活跃的来源（按基线最近异常时间近似）
    const activeSources = Array.from(sourceScores.entries()).filter(([, score]) => score > 0);
    const sourceCount = activeSources.length;
    const totalScore = activeSources.reduce((sum, [, s]) => sum + s, 0);
    const avgScorePerSource = sourceCount > 0 ? totalScore / sourceCount : 0;

    const signals: AnomalySignal[] = [];
    const detected =
      sourceCount >= this.config.distributedMinSources &&
      avgScorePerSource < 2.0 && // 每源贡献低（单源不构成威胁）
      totalScore >= this.config.distributedMinSources;

    if (detected) {
      const confidence = clamp(
        (sourceCount / (this.config.distributedMinSources * 2)) * 0.5 +
          clamp(totalScore / 20, 0, 0.4),
        0,
        0.9,
      );
      signals.push({
        metricName: 'distributed_aggregate',
        value: sourceCount,
        zScore: 0,
        ewmaDeviation: 0,
        iqrScore: 0,
        confidence,
        timestamp: now,
        description: `分布式攻击：${sourceCount} 个独立来源在窗口内汇聚异常分 ${totalScore.toFixed(2)}（平均每源 ${avgScorePerSource.toFixed(2)}）`,
      });

      try {
        getGlobalLogger().warn('ZeroDayDefenseEngine', '检测到分布式攻击', {
          sourceCount,
          totalScore: totalScore.toFixed(2),
          avgScorePerSource: avgScorePerSource.toFixed(2),
          windowStart: new Date(windowStart).toISOString(),
        });
      } catch (err) {
        reportSilentFailure(err, 'zeroDayDefenseEngine:detectDistributedAttack');
      }
    }

    return {
      detected,
      confidence: detected
        ? clamp(sourceCount / (this.config.distributedMinSources * 2), 0, 0.9)
        : 0,
      signals,
      description: detected
        ? `检测到分布式攻击：${sourceCount} 个来源汇聚低频异常`
        : '未检测到分布式攻击',
    };
  }

  /**
   * 检测新型注入——语义异常但不符合已知模式。
   *
   * 新型注入的特征：行为在语义层面异常（如异常的 token 输入/输出比例、
   * 异常的工具参数大小、未见过的状态转移序列），但不匹配任何已知攻击签名。
   * 这是零日攻击最典型的表现。
   *
   * 检测方法：
   *   1. 识别语义类指标（token_usage、tool_call）的强异常信号
   *   2. 检测从未见过的马尔可夫状态转移（概率极低或为零）
   *   3. 检测频谱突变（行为节律改变）
   *   4. 若语义异常信号数 >= 阈值且无已知攻击模式匹配，判定为新型注入
   *
   * @returns 新型注入检测结果
   */
  detectNovelInjection(): AttackDetectionResult {
    const now = Date.now();
    const lookbackStart = now - this.config.riskLookbackMs;
    const signals: AnomalySignal[] = [];

    // 语义类指标：token_usage、tool_call
    const semanticTypes: MetricType[] = ['token_usage', 'tool_call', 'api_pattern'];

    for (const [metricKey, baseline] of this.baselines) {
      if (!semanticTypes.includes(baseline.metricType)) continue;

      // 检测未见过的状态转移（novel transition）
      const novelTransitionScore = this.computeNovelTransitionScore(baseline);

      // 检测频谱突变
      const spectralShift = Math.abs(
        baseline.currentSpectralFlatness - baseline.baselineSpectralFlatness,
      );

      // 近期是否有强异常
      const recentAnomaly = baseline.lastAnomalyTimestamp >= lookbackStart;

      if (
        (novelTransitionScore > 0.6 || spectralShift > this.config.frequencyAnomalyThreshold) &&
        recentAnomaly
      ) {
        const confidence = clamp(Math.max(novelTransitionScore, spectralShift) * 0.85, 0, 0.9);
        signals.push({
          metricName: metricKey,
          value: baseline.ewma,
          zScore: 0,
          ewmaDeviation: 0,
          iqrScore: 0,
          confidence,
          timestamp: now,
          description: `新型注入嫌疑：指标 ${metricKey} 出现未见状态转移（评分 ${novelTransitionScore.toFixed(2)}）或频谱突变（偏移 ${spectralShift.toFixed(2)}），无已知模式匹配`,
        });
      }
    }

    const detected = signals.length >= this.config.novelInjectionMinSemanticSignals;
    const confidence = detected
      ? clamp(signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length, 0, 0.9)
      : 0;

    if (detected) {
      try {
        getGlobalLogger().warn('ZeroDayDefenseEngine', '检测到新型注入嫌疑', {
          signalCount: signals.length,
          confidence: confidence.toFixed(2),
        });
      } catch (err) {
        reportSilentFailure(err, 'zeroDayDefenseEngine:detectNovelInjection');
      }
    }

    return {
      detected,
      confidence,
      signals,
      description: detected
        ? `检测到新型注入嫌疑：${signals.length} 个语义类指标异常且无已知模式匹配`
        : '未检测到新型注入',
    };
  }

  // ── 基线管理 ──────────────────────────────────────────────────────

  /**
   * 更新所有基线——应用自适应阈值学习。
   *
   * 执行：
   *   1. 季节性调整（工作日/周末/节假日模式）
   *   2. 突发流量自适应检测（促销/发布期间阈值放宽）
   *   3. 修剪过期样本与来源记录
   *   4. 重算频谱基线
   *   5. 衰减慢攻击累积分
   *
   * 通常由外部定时器周期性调用。
   */
  updateBaselines(): void {
    const now = Date.now();
    const elapsedSinceUpdate = now - this.lastBaselineUpdate;
    this.lastBaselineUpdate = now;

    // ── 1. 季节性调整 ──
    if (this.config.enableSeasonalAdjustment) {
      this.applySeasonalAdjustment(now);
    }

    // ── 2. 突发流量自适应 ──
    if (this.config.enableBurstAdaptation) {
      this.detectBurstMode(now);
    }

    try {
      getGlobalMetrics().setGauge('zeroday.baseline_update_interval_ms', elapsedSinceUpdate, {});
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:updateBaselinesInterval');
    }

    // ── 3. 修剪与重算 ──
    const slowWindowStart = now - this.config.slowAttackWindowMs;

    for (const baseline of this.baselines.values()) {
      // 衰减累积分
      if (baseline.lastAnomalyTimestamp < slowWindowStart) {
        baseline.anomalyAccumulator = 0;
      }

      // 清理过期来源记录
      for (const src of baseline.sources.keys()) {
        // 保留有近期贡献的来源；这里简化为保留非零记录
        if ((baseline.sources.get(src) ?? 0) <= 0) {
          baseline.sources.delete(src);
        }
      }

      // 重算频谱基线（取稳态平坦度作为基线参考）
      if (baseline.samples.length >= this.config.minSamples) {
        const spectrum = computeDftMagnitude(baseline.samples);
        const flatness = computeSpectralFlatness(spectrum);
        // 平滑更新基线频谱平坦度
        baseline.baselineSpectralFlatness =
          baseline.baselineSpectralFlatness === 0
            ? flatness
            : 0.8 * baseline.baselineSpectralFlatness + 0.2 * flatness;
      }

      // 重排序缓存
      baseline.sortedSamples = [...baseline.samples].sort((a, b) => a - b);
    }

    // 清理过期近期信号
    const lookbackStart = now - this.config.riskLookbackMs;
    this.recentSignals = this.recentSignals.filter((s) => s.timestamp >= lookbackStart);

    try {
      getGlobalMetrics().setGauge('zeroday.baseline_count', this.baselines.size, {});
      getGlobalMetrics().setGauge('zeroday.burst_mode', this.burstMode ? 1 : 0, {});
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:updateBaselines');
    }
  }

  /**
   * 获取当前所有基线状态（只读副本）。
   * @returns 基线名称到 BehaviorBaseline 的映射
   */
  getBaselines(): Map<string, BehaviorBaseline> {
    const result = new Map<string, BehaviorBaseline>();
    for (const [key, baseline] of this.baselines) {
      result.set(key, {
        metricName: baseline.metricName,
        samples: [...baseline.samples],
        mean: baseline.mean,
        stdDev: baseline.stdDev,
        ewma: baseline.ewma,
        lastUpdate: baseline.lastUpdate,
        sampleCount: baseline.sampleCount,
      });
    }
    return result;
  }

  /**
   * 获取风险评分历史。
   * @param limit - 最大返回条数（默认 100）
   * @returns 按时间倒序的风险历史条目
   */
  getRiskHistory(limit: number = 100): RiskHistoryEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, this.riskHistory.length));
    return [...this.riskHistory].reverse().slice(0, safeLimit);
  }

  /**
   * 重置引擎所有状态（基线、信号、历史），保留配置。
   */
  reset(): void {
    this.baselines.clear();
    this.recentSignals = [];
    this.riskHistory = [];
    this.lastBaselineUpdate = Date.now();
    this.burstMode = false;
    this.lastBurstCheck = 0;
    try {
      getGlobalLogger().info('ZeroDayDefenseEngine', '引擎状态已重置');
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:reset');
    }
  }

  // ── 内部：基线创建与获取 ──────────────────────────────────────────

  /**
   * 获取或创建指标基线。
   */
  private getOrCreateBaseline(
    type: MetricType,
    metricKey: string,
    initialValue: number,
    now: number,
  ): InternalBaseline {
    let baseline = this.baselines.get(metricKey);
    if (!baseline) {
      baseline = {
        metricName: metricKey,
        samples: [],
        mean: initialValue,
        stdDev: 0,
        ewma: initialValue,
        lastUpdate: now,
        sampleCount: 0,
        metricType: type,
        sortedSamples: [],
        ewmaVariance: 0,
        transitionCounts: new Map(),
        totalTransitions: 0,
        lastState: null,
        baselineSpectralFlatness: 0,
        currentSpectralFlatness: 1,
        anomalyAccumulator: 0,
        sources: new Map(),
        lastAnomalyTimestamp: 0,
      };
      this.baselines.set(metricKey, baseline);
    }
    return baseline;
  }

  // ── 内部：异常检测算法 ────────────────────────────────────────────

  /**
   * 融合五种检测算法的结果为单一置信度（0-1）。
   * 各算法归一化后加权求和，再经 sigmoid 压缩到 (0,1)。
   */
  private fuseDetectionConfidence(args: {
    zScore: number;
    ewmaDeviation: number;
    iqrScore: number;
    markovAnomaly: number;
    frequencyAnomaly: number;
  }): number {
    const { zScore, ewmaDeviation, iqrScore, markovAnomaly, frequencyAnomaly } = args;
    const relax = this.currentRelaxFactor();

    // 各算法归一化异常分（0-1）
    const zNorm = clamp(Math.abs(zScore) / (this.config.zScoreThreshold * relax), 0, 1);
    const ewmaNorm = clamp(ewmaDeviation, 0, 1);
    const iqrNorm = clamp(iqrScore / 3, 0, 1);
    const markovNorm = clamp(markovAnomaly, 0, 1);
    const freqNorm = clamp(frequencyAnomaly, 0, 1);

    // 加权融合（Z-Score 与 EWMA 权重更高，因为更通用）
    const weights = { z: 0.3, ewma: 0.25, iqr: 0.15, markov: 0.15, freq: 0.15 };
    const weightedSum =
      zNorm * weights.z +
      ewmaNorm * weights.ewma +
      iqrNorm * weights.iqr +
      markovNorm * weights.markov +
      freqNorm * weights.freq;

    // sigmoid 映射，使多算法同时报警时置信度快速上升
    return clamp(sigmoid((weightedSum - 0.5) * 6), 0, 1);
  }

  /**
   * 马尔可夫链异常检测——计算当前转移的异常分。
   * @returns 异常分（0-1，1 表示完全未见过的转移）
   */
  private detectMarkovAnomaly(baseline: InternalBaseline, value: number): number {
    if (baseline.lastState === null || baseline.totalTransitions < this.config.minSamples) {
      return 0;
    }
    const currentState = discretizeState(value, baseline.mean, baseline.stdDev);
    const fromMap = baseline.transitionCounts.get(baseline.lastState);
    if (!fromMap) return 0;
    const transitionCount = fromMap.get(currentState) ?? 0;
    const totalFrom = this.sumTransitionCounts(fromMap);
    if (totalFrom === 0) return 0;
    const probability = transitionCount / totalFrom;
    // 概率越低异常分越高；低于阈值的视为异常
    if (probability >= this.config.markovAnomalyThreshold) return 0;
    // 归一化：probability=0 → 1, probability=threshold → 0.5
    return clamp(1 - probability / this.config.markovAnomalyThreshold, 0, 1);
  }

  /**
   * 频率异常检测——比较当前频谱平坦度与基线的偏离。
   * @returns 异常分（0-1）
   */
  private detectFrequencyAnomaly(baseline: InternalBaseline): number {
    if (baseline.samples.length < this.config.minSamples) return 0;
    const spectrum = computeDftMagnitude(baseline.samples);
    const currentFlatness = computeSpectralFlatness(spectrum);
    baseline.currentSpectralFlatness = currentFlatness;
    if (baseline.baselineSpectralFlatness < 1e-9) return 0;
    const shift = Math.abs(currentFlatness - baseline.baselineSpectralFlatness);
    return clamp(shift / this.config.frequencyAnomalyThreshold, 0, 1);
  }

  /**
   * 更新马尔可夫链转移计数。
   */
  private updateMarkovChain(baseline: InternalBaseline, value: number): void {
    const currentState = discretizeState(value, baseline.mean, baseline.stdDev);
    if (baseline.lastState !== null) {
      let fromMap = baseline.transitionCounts.get(baseline.lastState);
      if (!fromMap) {
        fromMap = new Map();
        baseline.transitionCounts.set(baseline.lastState, fromMap);
      }
      fromMap.set(currentState, (fromMap.get(currentState) ?? 0) + 1);
      baseline.totalTransitions++;
    }
    baseline.lastState = currentState;
  }

  /**
   * 更新频谱基线（仅在样本足够时）。
   */
  private updateFrequencyBaseline(baseline: InternalBaseline): void {
    if (baseline.samples.length < this.config.minSamples) return;
    const spectrum = computeDftMagnitude(baseline.samples);
    baseline.currentSpectralFlatness = computeSpectralFlatness(spectrum);
    if (baseline.baselineSpectralFlatness < 1e-9) {
      baseline.baselineSpectralFlatness = baseline.currentSpectralFlatness;
    }
  }

  /**
   * 计算未见状态转移评分（用于新型注入检测）。
   */
  private computeNovelTransitionScore(baseline: InternalBaseline): number {
    if (baseline.lastState === null || baseline.totalTransitions < this.config.minSamples) {
      return 0;
    }
    const fromMap = baseline.transitionCounts.get(baseline.lastState);
    if (!fromMap) return 1; // 当前状态从未作为起点出现过
    // 检查从当前状态出发的转移多样性是否异常低
    const totalFrom = this.sumTransitionCounts(fromMap);
    if (totalFrom === 0) return 0;
    // 若最近转移概率极低 → novel
    const maxProbability = Math.max(...Array.from(fromMap.values())) / totalFrom;
    // 转移过于确定（单一转移占主导）也可能是异常
    return clamp(1 - maxProbability, 0, 1) * 0.5 + (fromMap.size === 1 ? 0.3 : 0);
  }

  // ── 内部：攻击模式检测辅助 ────────────────────────────────────────

  /**
   * 检测协调攻击——多个低置信度异常信号同时出现。
   */
  private detectCoordinatedAttack(activeSignals: AnomalySignal[]): AttackDetectionResult {
    const now = Date.now();
    const lowConfidenceSignals = activeSignals.filter(
      (s) => s.confidence <= this.config.coordinatedMaxIndividualConfidence,
    );

    // 按指标类型分组，检查是否多维度同时出现低置信度异常
    const typeSet = new Set<string>();
    for (const s of lowConfidenceSignals) {
      typeSet.add(this.extractMetricType(s.metricName));
    }

    const detected =
      lowConfidenceSignals.length >= this.config.coordinatedMinSignals && typeSet.size >= 2; // 至少跨 2 个维度

    const signals: AnomalySignal[] = [];
    if (detected) {
      const confidence = clamp(
        (lowConfidenceSignals.length / (this.config.coordinatedMinSignals * 2)) * 0.7 +
          (typeSet.size / 5) * 0.2,
        0,
        0.9,
      );
      signals.push({
        metricName: 'coordinated_aggregate',
        value: lowConfidenceSignals.length,
        zScore: 0,
        ewmaDeviation: 0,
        iqrScore: 0,
        confidence,
        timestamp: now,
        description: `协调攻击：${lowConfidenceSignals.length} 个低置信度异常信号（置信度≤${this.config.coordinatedMaxIndividualConfidence}）跨 ${typeSet.size} 个维度同时出现`,
      });
    }

    return {
      detected,
      confidence: detected
        ? clamp(lowConfidenceSignals.length / (this.config.coordinatedMinSignals * 2), 0, 0.9)
        : 0,
      signals,
      description: detected
        ? `检测到协调攻击：${lowConfidenceSignals.length} 个低置信度信号跨维度并发`
        : '未检测到协调攻击',
    };
  }

  /**
   * 检测账单爆炸关联——与 BillExplosionGuard 联动。
   * 当账单防护已触发限流/熔断，且行为异常信号同时存在时，推测为经济型零日攻击。
   */
  private detectBillExplosionCorrelation(): AttackDetectionResult {
    const now = Date.now();
    try {
      const billGuard = getBillExplosionGuard();
      const report = billGuard.getCostReport();
      const status = report?.status;

      const melted = status?.melted === true || status?.globalMelted === true;
      const throttled = status?.throttled === true;
      const highUtilization =
        report?.daily?.utilization !== undefined && report.daily.utilization > 0.8;

      // 账单防护触发 + 近期有行为异常 → 经济型零日攻击
      const hasRecentAnomaly = this.recentSignals.some(
        (s) => now - s.timestamp < this.config.riskLookbackMs,
      );

      const detected = (melted || (throttled && highUtilization)) && hasRecentAnomaly;

      const signals: AnomalySignal[] = [];
      if (detected) {
        const confidence = clamp((melted ? 0.6 : 0.4) + (highUtilization ? 0.2 : 0), 0, 0.9);
        signals.push({
          metricName: 'bill_explosion_correlation',
          value: report?.daily?.utilization ?? 0,
          zScore: 0,
          ewmaDeviation: 0,
          iqrScore: 0,
          confidence,
          timestamp: now,
          description: `账单爆炸关联：BillExplosionGuard 状态=${melted ? 'MELT' : 'THROTTLE'}，日成本利用率=${(report?.daily?.utilization ?? 0).toFixed(2)}，且行为异常信号并存，推测经济型零日攻击`,
        });
      }

      return {
        detected,
        confidence: detected ? 0.7 : 0,
        signals,
        description: detected ? '检测到账单爆炸关联（经济型零日攻击嫌疑）' : '未检测到账单爆炸关联',
      };
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:detectBillExplosion');
      return {
        detected: false,
        confidence: 0,
        signals: [],
        description: '账单爆炸关联检测失败（BillExplosionGuard 不可用）',
      };
    }
  }

  // ── 内部：自适应阈值学习 ──────────────────────────────────────────

  /**
   * 应用季节性调整——根据工作日/周末/节假日调整基线敏感度。
   * 周末与节假日流量模式不同，阈值应相应调整。
   */
  private applySeasonalAdjustment(now: number): void {
    const date = new Date(now);
    const dayOfWeek = date.getDay(); // 0=周日, 6=周六
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    // 简单节假日判断（元旦、国庆等固定日期）
    const monthDay = `${date.getMonth() + 1}-${date.getDate()}`;
    const isHoliday = [
      '1-1',
      '1-2',
      '1-3',
      '10-1',
      '10-2',
      '10-3',
      '10-4',
      '10-5',
      '10-6',
      '10-7',
    ].includes(monthDay);

    // 周末/节假日：流量通常更低、模式更简单 → 异常更易显现，阈值收紧
    // 此处通过调整慢攻击累积阈值与协调攻击灵敏度体现（已在 currentRelaxFactor 间接使用）
    this.seasonalFactor = isWeekend || isHoliday ? 0.9 : 1.0;

    try {
      getGlobalMetrics().setGauge('zeroday.seasonal_factor', this.seasonalFactor, {
        weekend: isWeekend ? '1' : '0',
        holiday: isHoliday ? '1' : '0',
      });
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:seasonal');
    }
  }

  /** 当前季节性因子（1.0=正常，<1 收紧） */
  private seasonalFactor: number = 1.0;

  /**
   * 检测突发流量模式——促销/发布期间阈值放宽，避免误报。
   */
  private detectBurstMode(now: number): void {
    if (now - this.lastBurstCheck < 60_000) return; // 每分钟检测一次
    this.lastBurstCheck = now;

    // 用 request_rate 类指标的均值速率估算当前流量
    let totalRecent = 0;
    let totalMean = 0;
    let count = 0;
    for (const baseline of this.baselines.values()) {
      if (baseline.metricType !== 'request_rate') continue;
      const recentSlice = baseline.samples.slice(-10);
      const recentMean = computeMean(recentSlice);
      totalRecent += recentMean;
      totalMean += baseline.mean;
      count++;
    }

    if (count === 0 || totalMean < 1e-9) {
      this.burstMode = false;
      return;
    }

    const ratio = totalRecent / totalMean;
    const wasBurst = this.burstMode;
    this.burstMode = ratio >= this.config.burstDetectionMultiplier;

    if (this.burstMode !== wasBurst) {
      try {
        getGlobalLogger().info(
          'ZeroDayDefenseEngine',
          `突发流量模式${this.burstMode ? '启用' : '关闭'}`,
          {
            ratio: ratio.toFixed(2),
            multiplier: this.config.burstDetectionMultiplier,
          },
        );
        getSecurityAuditLogger().logEvent({
          type: 'config_change',
          severity: 'low',
          source: 'ZeroDayDefenseEngine',
          message: `突发流量自适应：${this.burstMode ? '启用阈值放宽' : '恢复正常阈值'}（流量倍数 ${ratio.toFixed(2)}）`,
          details: { burstMode: this.burstMode, ratio },
        });
      } catch (err) {
        reportSilentFailure(err, 'zeroDayDefenseEngine:burstMode');
      }
    }
  }

  /**
   * 当前阈值放宽因子——突发模式下放宽，季节性收紧。
   * @returns 放宽因子（>1 放宽阈值，<1 收紧）
   */
  private currentRelaxFactor(): number {
    let factor = this.seasonalFactor;
    if (this.burstMode) {
      factor *= this.config.burstRelaxFactor;
    }
    return factor;
  }

  // ── 内部：自动响应 ────────────────────────────────────────────────

  /**
   * 根据风险评分映射为推荐动作。
   * - 0-30: LOG（低风险——记录日志）
   * - 30-60: MONITOR（中风险——增强监控）
   * - 60-80: THROTTLE（高风险——限流 + 人工通知）
   * - 80-100: ISOLATE/MELT（极高风险——自动隔离 + 熔断）
   */
  private scoreToAction(riskScore: number): RecommendedAction {
    const t = this.config.riskThresholds;
    if (riskScore < t.low) return 'LOG';
    if (riskScore < t.medium) return 'MONITOR';
    if (riskScore < t.high) return 'THROTTLE';
    // 极高风险：若风险极高（>=95）且检测到账单爆炸 → MELT，否则 ISOLATE
    if (riskScore >= 95) return 'MELT';
    return 'ISOLATE';
  }

  /**
   * 执行自动响应——根据推荐动作联动各安全子系统。
   */
  private executeAutoResponse(
    riskScore: number,
    action: RecommendedAction,
    attackPattern: DetectedAttackPattern,
    signals: AnomalySignal[],
  ): void {
    const now = Date.now();
    const signalSummary = signals
      .slice(0, 5)
      .map((s) => `${s.metricName}(${s.confidence.toFixed(2)})`)
      .join(', ');

    try {
      switch (action) {
        case 'LOG': {
          // 低风险——仅记录日志
          getSecurityAuditLogger().logEvent({
            type: 'security_scan',
            severity: 'low',
            source: 'ZeroDayDefenseEngine',
            message: `零日风险评估：低风险（评分 ${riskScore}）`,
            details: { riskScore, attackPattern, signals: signalSummary },
          });
          break;
        }
        case 'MONITOR': {
          // 中风险——增强监控
          getSecurityMonitor().logAlert({
            type: 'zeroday_elevated',
            severity: 'medium',
            source: 'ZeroDayDefenseEngine',
            message: `零日风险升高（评分 ${riskScore}，模式 ${attackPattern}）`,
            details: { riskScore, attackPattern, signals: signalSummary },
            recommendation: '增强监控，关注后续异常信号累积趋势',
          });
          getGlobalMetrics().incrementCounter('zeroday.response.monitor', 1, {
            pattern: attackPattern,
          });
          break;
        }
        case 'THROTTLE': {
          // 高风险——限流 + 人工通知
          getSecurityAuditLogger().logEvent({
            type: 'security_scan',
            severity: 'high',
            source: 'ZeroDayDefenseEngine',
            message: `零日风险高风险（评分 ${riskScore}，模式 ${attackPattern}）——触发限流建议`,
            details: { riskScore, attackPattern, signals: signalSummary, action: 'THROTTLE' },
          });
          getSecurityMonitor().logAlert({
            type: 'zeroday_high_risk',
            severity: 'high',
            source: 'ZeroDayDefenseEngine',
            message: `零日高风险：评分 ${riskScore}，模式 ${attackPattern}，建议立即限流并人工介入`,
            details: { riskScore, attackPattern, signals: signalSummary },
            recommendation: '立即限流相关来源，通知安全团队人工核查',
          });
          // 联动企业安全网关态势
          this.recordGatewayPosture(action, riskScore, attackPattern);
          getGlobalMetrics().incrementCounter('zeroday.response.throttle', 1, {
            pattern: attackPattern,
          });
          break;
        }
        case 'ISOLATE':
        case 'MELT': {
          // 极高风险——自动隔离 + 熔断
          getSecurityAuditLogger().logEvent({
            type: 'security_decision',
            severity: 'critical',
            source: 'ZeroDayDefenseEngine',
            message: `零日风险极高风险（评分 ${riskScore}，模式 ${attackPattern}）——执行 ${action}`,
            details: { riskScore, attackPattern, signals: signalSummary, action, timestamp: now },
          });
          getSecurityMonitor().logAlert({
            type: 'zeroday_critical',
            severity: 'critical',
            source: 'ZeroDayDefenseEngine',
            message: `零日极高风险：评分 ${riskScore}，模式 ${attackPattern}，已执行 ${action}`,
            details: { riskScore, attackPattern, signals: signalSummary, action },
            recommendation: '立即隔离受影响来源，熔断可疑流量，启动应急响应',
          });
          // 联动企业安全网关与账单防护
          this.recordGatewayPosture(action, riskScore, attackPattern);
          getGlobalMetrics().incrementCounter(`zeroday.response.${action.toLowerCase()}`, 1, {
            pattern: attackPattern,
          });
          break;
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:executeAutoResponse');
    }
  }

  /**
   * 记录企业安全网关态势（用于高风险响应联动）。
   */
  private recordGatewayPosture(
    action: RecommendedAction,
    riskScore: number,
    attackPattern: DetectedAttackPattern,
  ): void {
    try {
      const gateway = getEnterpriseSecurityGateway();
      const posture = gateway.getSecurityPosture();
      getGlobalLogger().warn('ZeroDayDefenseEngine', '企业安全网关态势联动', {
        action,
        riskScore,
        attackPattern,
        gatewayStatus: posture.overallStatus,
        activeThreats: posture.activeThreats,
        costProtectionActive: posture.costProtectionActive,
      });
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:gatewayPosture');
    }
  }

  // ── 内部：工具方法 ────────────────────────────────────────────────

  /**
   * 修剪近期信号池（防止无限增长）。
   */
  private trimRecentSignals(): void {
    const lookbackStart = Date.now() - this.config.riskLookbackMs;
    // 保留窗口内的信号，且总数不超过 windowSize * 4
    const maxSignals = this.config.windowSize * 4;
    this.recentSignals = this.recentSignals.filter((s) => s.timestamp >= lookbackStart);
    if (this.recentSignals.length > maxSignals) {
      this.recentSignals = this.recentSignals.slice(-maxSignals);
    }
  }

  /**
   * 对信号去重（按 metricName + timestamp + value）。
   */
  private deduplicateSignals(signals: AnomalySignal[]): AnomalySignal[] {
    const seen = new Set<string>();
    const result: AnomalySignal[] = [];
    for (const s of signals) {
      const key = `${s.metricName}|${s.timestamp}|${s.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(s);
    }
    return result;
  }

  /**
   * 从指标键提取指标类型。
   */
  private extractMetricType(metricKey: string): MetricType {
    const idx = metricKey.indexOf(METRIC_KEY_SEP);
    if (idx === -1) return 'custom';
    const type = metricKey.slice(0, idx) as MetricType;
    const validTypes: MetricType[] = [
      'request_rate',
      'token_usage',
      'tool_call',
      'api_pattern',
      'user_behavior',
      'custom',
    ];
    return validTypes.includes(type) ? type : 'custom';
  }

  /**
   * 汇总某状态的所有转移计数。
   */
  private sumTransitionCounts(fromMap: Map<string, number>): number {
    let total = 0;
    for (const count of fromMap.values()) total += count;
    return total;
  }

  /**
   * 生成人类可读的异常描述。
   */
  private describeAnomaly(
    metricKey: string,
    value: number,
    zScore: number,
    ewmaDeviation: number,
    iqrScore: number,
    markovAnomaly: number,
    frequencyAnomaly: number,
  ): string {
    const parts: string[] = [];
    parts.push(`指标 ${metricKey} 当前值 ${value.toFixed(4)}`);
    if (Math.abs(zScore) >= this.config.zScoreThreshold * this.currentRelaxFactor()) {
      parts.push(`Z-Score=${zScore.toFixed(2)}（超 ${this.config.zScoreThreshold}σ）`);
    }
    if (ewmaDeviation >= 1) {
      parts.push(`EWMA 偏离=${ewmaDeviation.toFixed(2)}（越控制限）`);
    }
    if (iqrScore > 0) {
      parts.push(`IQR 越界=${iqrScore.toFixed(2)}×IQR`);
    }
    if (markovAnomaly > 0.5) {
      parts.push(`序列转移异常=${markovAnomaly.toFixed(2)}`);
    }
    if (frequencyAnomaly > this.config.frequencyAnomalyThreshold * 0.5) {
      parts.push(`频谱偏移=${frequencyAnomaly.toFixed(2)}`);
    }
    return parts.join('；');
  }

  /**
   * 记录异常检测指标。
   */
  private recordAnomalyMetric(type: MetricType, confidence: number, relaxFactor: number): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('zeroday.anomalies_detected', 1, { type });
      metrics.setGauge('zeroday.last_anomaly_confidence', confidence, { type });
      metrics.setGauge('zeroday.relax_factor', relaxFactor, {});
    } catch (err) {
      reportSilentFailure(err, 'zeroDayDefenseEngine:recordAnomalyMetric');
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

const zeroDaySingleton = createTenantAwareSingleton(() => new ZeroDayDefenseEngine(), {
  componentName: 'ZeroDayDefenseEngine',
});

/**
 * 获取全局 ZeroDayDefenseEngine 单例（单租户）或租户作用域实例（多租户）。
 *
 * @param config - 部分配置（可选，首次传入时会合并到引擎配置）
 * @returns ZeroDayDefenseEngine 实例
 */
export function getZeroDayDefenseEngine(config?: Partial<ZeroDayConfig>): ZeroDayDefenseEngine {
  const engine = zeroDaySingleton.get();
  if (config) {
    engine.configure(config);
  }
  return engine;
}

/**
 * 重置 ZeroDayDefenseEngine 单例（用于测试隔离）。
 * 清除所有租户实例，释放内存中的基线与信号。
 */
export function resetZeroDayDefenseEngine(): void {
  zeroDaySingleton.reset();
}
