/**
 * AdaptiveThreatLearningEngine — 自适应威胁学习引擎
 *
 * 补齐 ZeroDayDefenseEngine 缺失的关键能力：从每一次已检测到的攻击中学习，
 * 生成可复用的签名并实时合成检测规则，使「同类攻击第二次出现时被瞬间识别」。
 *
 * 设计哲学：
 *   ZeroDayDefenseEngine 通过统计偏离检测「新颖性」，但它没有记忆——每一次零日
 *   攻击都像第一次见到。本引擎反过来：把每一次被检测到的攻击（无论由哪个安全
 *   模块发现）提炼成结构化指纹（行为/内容/上下文），固化成签名，再合成可在毫秒
 *   级匹配的规则。随着样本累积，规则置信度上升并自动激活；相似签名聚类成「攻击
 *   家族」，威胁模型持续进化，过时签名被剪枝。
 *
 * 四大核心能力：
 *   1. 攻击签名提取（extractSignature）—— 行为/内容/上下文三维度指纹 + 规范签名 ID
 *   2. 签名检测（checkAgainstLearnedSignatures）—— 加权相似度匹配，第二次瞬时拦截
 *   3. 实时规则合成（synthesizeRule）—— 从攻击特征自动生成条件规则，置信度自适应
 *   4. 威胁模型进化（evolveThreatModel）—— 聚类攻击家族、提炼共性、剪枝过期签名
 *
 * 集成模块：
 *   - SecurityAuditLogger: 安全事件审计（threat_learned / signature_matched）
 *   - GlobalLogger / GlobalMetrics: 日志与指标
 *   - silentFailureReporter: 所有 catch 块静默兜底
 *
 * 使用方式：
 *   import { getAdaptiveThreatLearningEngine } from './security/adaptiveThreatLearningEngine';
 *   const engine = getAdaptiveThreatLearningEngine();
 *
 *   // 任意安全模块检测到攻击后上报
 *   engine.extractSignature(attackContext);
 *
 *   // 每次请求前检查是否命中已学习签名
 *   const match = engine.checkAgainstLearnedSignatures(requestFeatures);
 *   if (match.matched) { /* 瞬时拦截 *\/ }
 */

import * as crypto from 'node:crypto';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// 类型定义
// ============================================================================

/** 签名类别 */
export type SignatureCategory = 'behavioral' | 'content' | 'context' | 'composite';

/** 签名生命周期状态 */
export type SignatureStatus = 'active' | 'monitoring' | 'deprecated' | 'false_positive';

/** 合成规则的动作 */
export type RuleAction = 'block' | 'throttle' | 'alert' | 'quarantine' | 'monitor';

/** 攻击家族类型 */
export type AttackFamilyType =
  | 'economic'
  | 'injection'
  | 'exfiltration'
  | 'privilege_escalation'
  | 'resource_exhaustion'
  | 'unknown';

/**
 * 攻击上下文——任意安全模块检测到攻击后上报的结构化信息。
 */
export interface AttackContext {
  attackType: string;
  sourceModule: string; // 哪个安全模块检测到它
  severity: 'critical' | 'high' | 'medium' | 'low';
  agentId: string;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  // 行为特征
  tokenCount?: number;
  toolCallCount?: number;
  requestCount?: number;
  requestSize?: number;
  apiEndpoint?: string;
  responseTimeMs?: number;
  // 内容特征
  userInput?: string;
  toolParams?: string;
  llmOutput?: string;
  // 上下文特征
  sourceIp?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 攻击签名——从一次（或多次同类）攻击提炼出的可复用指纹。
 */
export interface AttackSignature {
  signatureId: string;
  category: SignatureCategory;
  behavioralFingerprint: {
    tokenRange: [number, number];
    toolCallRate: number;
    requestSizeRange: [number, number];
    timingPattern: string;
    apiPattern?: string;
  };
  contentFingerprint: {
    contentHash: string;
    patternKeywords: string[];
    contentType: string;
  };
  contextFingerprint: {
    agentType: string;
    sessionType: string;
    timeOfDayPattern: string;
    sourcePattern?: string;
  };
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  sourceModule: string;
  status: SignatureStatus;
  attackFamilyId?: string;
}

/**
 * 合成规则——从攻击特征自动生成的可执行检测规则。
 */
export interface SynthesizedRule {
  ruleId: string;
  sourceSignatureId: string;
  conditions: Array<{
    field: string;
    operator: 'gt' | 'lt' | 'eq' | 'contains' | 'matches' | 'in_range';
    value: string | number;
    weight: number;
  }>;
  action: RuleAction;
  confidence: number; // 0-1，每次成功匹配 +0.1
  matchCount: number;
  falsePositiveCount: number;
  createdAt: string;
  lastMatchedAt?: string;
  active: boolean;
}

/**
 * 攻击家族——聚类相似签名得到的高层威胁分组。
 */
export interface AttackFamily {
  familyId: string;
  type: AttackFamilyType;
  name: string;
  memberSignatureIds: string[];
  commonCharacteristics: string[];
  firstSeen: string;
  lastSeen: string;
  totalOccurrences: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evolving: boolean; // 仍有新变种出现时为 true
}

/**
 * 进化后的威胁模型——签名/规则/家族的综合视图。
 */
export interface ThreatModel {
  version: number;
  lastUpdated: string;
  totalSignatures: number;
  activeSignatures: number;
  totalRules: number;
  activeRules: number;
  attackFamilies: AttackFamily[];
  topThreats: Array<{ signatureId: string; occurrenceCount: number; lastSeen: string }>;
  modelHealth: 'healthy' | 'degraded' | 'critical';
}

/**
 * 签名匹配结果。
 */
export interface SignatureMatchResult {
  matched: boolean;
  signatureId?: string;
  similarity: number; // 0-1
  confidence: number; // 0-1
  action: RuleAction;
  ruleId?: string;
  matchedRule?: SynthesizedRule;
}

/**
 * 签名检测请求——入侵请求的可观测量特征（非攻击专属字段）。
 */
export interface SignatureCheckRequest {
  agentId?: string;
  tenantId?: string;
  sessionId?: string;
  timestamp?: string;
  tokenCount?: number;
  toolCallCount?: number;
  requestCount?: number;
  requestSize?: number;
  apiEndpoint?: string;
  responseTimeMs?: number;
  userInput?: string;
  toolParams?: string;
  llmOutput?: string;
  sourceIp?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 引擎配置。
 */
export interface AdaptiveLearningConfig {
  enabled: boolean;
  // 签名提取
  maxSignatures: number; // 默认 10000
  signatureExpiryDays: number; // 默认 30
  // 规则合成
  autoActivateRuleThreshold: number; // 自动激活的置信度阈值，默认 0.7
  minConfidenceForAction: number; // 默认 0.5
  maxRules: number; // 默认 5000
  ruleFalsePositiveThreshold: number; // 超过此次数自动停用，默认 5
  // 威胁模型进化
  evolutionIntervalMs: number; // 默认 3600000（1 小时）
  minClusterSize: number; // 形成家族的最小签名数，默认 3
  // 匹配
  matchThreshold: number; // 默认 0.75
  behavioralWeight: number; // 默认 0.4
  contentWeight: number; // 默认 0.3
  contextWeight: number; // 默认 0.3
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: AdaptiveLearningConfig = {
  enabled: true,
  maxSignatures: 10000,
  signatureExpiryDays: 30,
  autoActivateRuleThreshold: 0.7,
  minConfidenceForAction: 0.5,
  maxRules: 5000,
  ruleFalsePositiveThreshold: 5,
  evolutionIntervalMs: 60 * 60 * 1000,
  minClusterSize: 3,
  matchThreshold: 0.75,
  behavioralWeight: 0.4,
  contentWeight: 0.3,
  contextWeight: 0.3,
};

// ============================================================================
// 常量
// ============================================================================

/** 停用词集合（关键词提取时过滤） */
const STOPWORDS: Set<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'our',
  'their',
  'not',
  'no',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'shall',
  'may',
  'might',
  'must',
  'have',
  'has',
  'had',
  'get',
  'got',
  'let',
  'please',
  'help',
  'need',
  'want',
  'use',
  'using',
  'used',
  'make',
  'made',
  'new',
  'one',
  'two',
  'also',
  'just',
  'like',
  'so',
  'than',
  'too',
  'very',
  'about',
  'into',
  'out',
  'up',
  'down',
  'over',
  'under',
  'again',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  's',
  't',
  'd',
  'll',
  'm',
  're',
  've',
  'now',
  'yes',
  'no',
]);

const SEVERITY_RANK: Record<'low' | 'medium' | 'high' | 'critical', number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** 规则置信度起点 */
const INITIAL_RULE_CONFIDENCE = 0.3;
/** 每次成功匹配的置信度增量 */
const CONFIDENCE_MATCH_INCREMENT = 0.1;
/** 每次误报的置信度衰减 */
const CONFIDENCE_FP_DECREMENT = 0.15;
/** 规则 ID 前缀 */
const RULE_ID_PREFIX = 'rule-';
/** 家族 ID 前缀 */
const FAMILY_ID_PREFIX = 'family-';

// ============================================================================
// 纯函数辅助
// ============================================================================

/** 计算 SHA-256 十六进制摘要。 */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 将数值四舍五入到指定位小数。 */
function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** 将数值限制在 [0,1] 区间。 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 求数组均值（空数组返回 0）。 */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * 内容归一化——小写化并合并连续空白，用于内容哈希计算。
 */
function normalizeContent(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 关键词提取：按非字母数字下划线切分，过滤停用词与短词，按词频取前 10。
 */
function extractKeywords(input: string): string[] {
  if (!input) return [];
  const tokens: string[] = input
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const freq: Map<string, number> = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map((e) => e[0]);
}

/**
 * 推断内容类型——用于签名归类与家族推断。
 */
function inferContentType(input: string): string {
  const s = input.toLowerCase();
  if (!s) return 'empty';
  if (/<script|onerror=|javascript:|<img[^>]+src/i.test(s)) return 'xss';
  if (/\b(select|insert|update|delete|drop|union\s+select|declare|exec\s|or\s+1=1)\b/.test(s)) {
    return 'sql';
  }
  if (/\.\.[\\/]/.test(s)) return 'path_traversal';
  if (/ignore\s+(previous|above)\s+instructions|jailbreak|system\s+prompt|act\s+as/i.test(s)) {
    return 'prompt_injection';
  }
  if (/\brm\s+-rf|curl\s+|wget\s+|cat\s+\/etc|nc\s+-|\/bin\/(ba)?sh|\$\(|`[^`]+`/.test(s)) {
    return 'shell';
  }
  if (/^\s*[{[]/.test(s)) return 'json';
  return 'text';
}

/**
 * 将时间戳归入一天中的时段桶。
 */
function bucketTimeOfDay(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return 'unknown';
  const hour = new Date(ms).getUTCHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

/**
 * 规范化 API 端点——剥离 UUID/数字段与查询串，便于同类端点聚合。
 */
function normalizeApi(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  return endpoint
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}')
    .replace(/\?.*$/, '');
}

/**
 * 规范化来源——优先取 IP 的 /24 前缀，其次取 User-Agent 首词。
 */
function normalizeSource(ip?: string, userAgent?: string): string | undefined {
  if (ip) {
    const parts = ip.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return ip;
  }
  if (userAgent) {
    const first = userAgent.split(/\s+/)[0]?.toLowerCase() ?? 'unknown';
    return `ua-${first}`;
  }
  return undefined;
}

/** 从 sessionId 推断会话类型（取首段）。 */
function inferSessionType(sessionId?: string): string {
  if (!sessionId) return 'unknown';
  const prefix = sessionId.split(/[-_]/)[0];
  return prefix || 'unknown';
}

/** 基于 requestSize 构造容差范围。 */
function sizeRange(size?: number): [number, number] {
  if (size === undefined || size < 0) return [0, 0];
  const tol = Math.max(1, Math.floor(size * 0.1));
  return [Math.max(0, size - tol), size + tol];
}

/** 对数分桶（用于签名 ID 的稳定化）。 */
function bucketLog(value: number): number {
  if (value <= 0) return 0;
  return Math.floor(Math.log2(value));
}

/** 速率分桶（低/中/高）。 */
function bucketRate(rate: number): string {
  if (rate <= 0) return '0';
  if (rate < 1) return 'low';
  if (rate < 3) return 'med';
  return 'high';
}

/** 两个集合的 Jaccard 相似度。 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa: Set<string> = new Set(a);
  const sb: Set<string> = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 点值相对区间的相似度：区间内为 1，区间外按距离衰减。 */
function pointRangeSim(range: [number, number], value: number | undefined): number {
  if (value === undefined) return 0.5; // 中性
  if (range[0] === 0 && range[1] === 0) return value === 0 ? 1 : 0;
  if (value >= range[0] && value <= range[1]) return 1;
  const size = range[1] - range[0];
  if (size <= 0) return value === range[0] ? 1 : 0;
  const dist = value < range[0] ? range[0] - value : value - range[1];
  return Math.max(0, 1 - dist / size);
}

/** 两个速率值的相对差异相似度。 */
function rateSim(expected: number, observed: number | undefined): number {
  if (observed === undefined) return 0.5;
  if (expected === 0 && observed === 0) return 1;
  const denom = Math.max(Math.abs(expected), Math.abs(observed), 1e-9);
  return Math.max(0, 1 - Math.abs(expected - observed) / denom);
}

/** 选取最高严重度。 */
function maxSeverity(
  severities: Array<'low' | 'medium' | 'high' | 'critical'>,
): 'low' | 'medium' | 'high' | 'critical' {
  let best: 'low' | 'medium' | 'high' | 'critical' = 'low';
  let bestRank = 0;
  for (const s of severities) {
    const r = SEVERITY_RANK[s];
    if (r > bestRank) {
      bestRank = r;
      best = s;
    }
  }
  return best;
}

/** 依据严重度推导默认规则动作。 */
function severityToAction(severity: 'critical' | 'high' | 'medium' | 'low'): RuleAction {
  switch (severity) {
    case 'critical':
      return 'block';
    case 'high':
      return 'throttle';
    case 'medium':
      return 'alert';
    default:
      return 'monitor';
  }
}

/**
 * 依据内容类型与共性关键词推断攻击家族类型。
 */
function inferAttackFamilyType(contentType: string, keywords: string[]): AttackFamilyType {
  const kw: Set<string> = new Set(keywords.map((k) => k.toLowerCase()));
  const hasAny = (words: string[]): boolean => words.some((w) => kw.has(w));
  if (['sql', 'xss', 'shell', 'path_traversal', 'prompt_injection'].includes(contentType)) {
    return 'injection';
  }
  if (
    hasAny([
      'admin',
      'root',
      'sudo',
      'privilege',
      'escalate',
      'escalation',
      'sudoers',
      'chmod',
      'token',
    ])
  ) {
    return 'privilege_escalation';
  }
  if (hasAny(['exfiltrate', 'extract', 'steal', 'download', 'export', 'exfil', 'leak', 'data'])) {
    return 'exfiltration';
  }
  if (hasAny(['cost', 'bill', 'money', 'billing', 'expensive', 'price', 'dollar', 'economic'])) {
    return 'economic';
  }
  if (hasAny(['resource', 'exhaust', 'loop', 'spam', 'flood', 'budget', 'dos', 'memory', 'cpu'])) {
    return 'resource_exhaustion';
  }
  return 'unknown';
}

/** 多个关键词集合的交集。 */
function intersectKeywords(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  let result: Set<string> = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const next: Set<string> = new Set(sets[i]);
    result = new Set([...result].filter((x) => next.has(x)));
    if (result.size === 0) break;
  }
  return [...result];
}

// ============================================================================
// 内部类型
// ============================================================================

/** 从攻击上下文构建的指纹与规范签名 ID。 */
interface BuiltFingerprint {
  signatureId: string;
  behavioral: AttackSignature['behavioralFingerprint'];
  content: AttackSignature['contentFingerprint'];
  context: AttackSignature['contextFingerprint'];
}

/** 从检测请求提取的、用于相似度计算的特征。 */
interface RequestFeatures {
  tokenCount?: number;
  toolCallCount?: number;
  requestSize?: number;
  toolCallRate?: number;
  apiEndpoint?: string;
  contentHash: string;
  keywords: string[];
  contentType: string;
  hasContent: boolean;
  timeOfDay: string;
  agentType: string;
  sessionType: string;
  sourcePattern?: string;
}

// ============================================================================
// AdaptiveThreatLearningEngine
// ============================================================================

export class AdaptiveThreatLearningEngine {
  private config: AdaptiveLearningConfig;
  private readonly signatures: Map<string, AttackSignature> = new Map();
  private readonly rules: Map<string, SynthesizedRule> = new Map();
  private readonly families: Map<string, AttackFamily> = new Map();
  private threatModel: ThreatModel;
  private modelVersion: number = 0;
  private evolutionTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<AdaptiveLearningConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.threatModel = this.buildEmptyThreatModel();
    if (this.config.enabled) {
      this.startEvolutionTimer();
    }
  }

  // ── 配置 ────────────────────────────────────────────────────────

  /**
   * 更新引擎配置（部分合并）。配置变更后会重启进化定时器。
   */
  configure(config: Partial<AdaptiveLearningConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };
    if (this.config.enabled && !wasEnabled) {
      this.startEvolutionTimer();
    } else if (!this.config.enabled && wasEnabled) {
      this.stopEvolutionTimer();
    } else if (this.config.enabled && config.evolutionIntervalMs !== undefined) {
      this.startEvolutionTimer();
    }
    try {
      getGlobalLogger().info('AdaptiveThreatLearningEngine', '配置已更新', {
        enabled: this.config.enabled,
        matchThreshold: this.config.matchThreshold,
      });
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:configure');
    }
  }

  /** 获取当前配置。 */
  getConfig(): AdaptiveLearningConfig {
    return { ...this.config };
  }

  // ── 能力 1：攻击签名提取 ────────────────────────────────────────

  /**
   * 从攻击上下文提取可复用签名。
   *
   * 若签名已存在（规范 ID 命中），则更新 lastSeen/occurrenceCount 并扩展行为范围；
   * 若为新签名，则创建并以 `active` 状态入库，同时自动合成对应检测规则。
   *
   * @returns 入库后的签名
   */
  extractSignature(context: AttackContext): AttackSignature {
    try {
      const fp = this.buildFingerprint(context);
      const now = context.timestamp || new Date().toISOString();
      const existing = this.signatures.get(fp.signatureId);

      if (existing) {
        // 已存在——更新统计与行为范围
        existing.lastSeen = now;
        existing.occurrenceCount += 1;
        existing.behavioralFingerprint.tokenRange = this.expandRange(
          existing.behavioralFingerprint.tokenRange,
          context.tokenCount,
        );
        existing.behavioralFingerprint.requestSizeRange = this.expandRange(
          existing.behavioralFingerprint.requestSizeRange,
          context.requestSize,
        );
        if (context.toolCallCount !== undefined) {
          const observedRate =
            context.requestCount && context.requestCount > 0
              ? context.toolCallCount / context.requestCount
              : context.toolCallCount;
          existing.behavioralFingerprint.toolCallRate = round(
            existing.behavioralFingerprint.toolCallRate * 0.7 + observedRate * 0.3,
            4,
          );
        }
        // 严重度取最高
        if (SEVERITY_RANK[context.severity] > SEVERITY_RANK[existing.severity]) {
          existing.severity = context.severity;
        }
        this.signatures.set(fp.signatureId, existing);
        this.recordMetrics();
        return existing;
      }

      // 新签名——入库
      this.enforceSignatureCap();
      const signature: AttackSignature = {
        signatureId: fp.signatureId,
        category: 'composite',
        behavioralFingerprint: fp.behavioral,
        contentFingerprint: fp.content,
        contextFingerprint: fp.context,
        firstSeen: now,
        lastSeen: now,
        occurrenceCount: 1,
        severity: context.severity,
        sourceModule: context.sourceModule,
        status: 'active',
      };
      this.signatures.set(fp.signatureId, signature);

      // 自动为新签名合成检测规则
      this.createRule(context, fp, fp.signatureId);

      // 审计与指标
      this.logThreatLearned(
        `新攻击签名已学习：${context.attackType}（来源 ${context.sourceModule}）`,
        context.severity,
        {
          signatureId: fp.signatureId,
          attackType: context.attackType,
          sourceModule: context.sourceModule,
          contentType: fp.content.contentType,
          occurrenceCount: 1,
        },
        context.tenantId,
        context.agentId,
      );
      this.incrementMetric('atl.signatures_created', 1, {
        sourceModule: context.sourceModule,
        severity: context.severity,
      });
      this.recordMetrics();

      return signature;
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:extractSignature');
      // 兜底返回一个最小签名，避免调用方崩溃
      const fallbackId = sha256(context.attackType + context.timestamp);
      return {
        signatureId: fallbackId,
        category: 'composite',
        behavioralFingerprint: {
          tokenRange: [0, 0],
          toolCallRate: 0,
          requestSizeRange: [0, 0],
          timingPattern: 'unknown',
        },
        contentFingerprint: { contentHash: '', patternKeywords: [], contentType: 'text' },
        contextFingerprint: {
          agentType: context.agentId,
          sessionType: 'unknown',
          timeOfDayPattern: 'unknown',
        },
        firstSeen: context.timestamp,
        lastSeen: context.timestamp,
        occurrenceCount: 1,
        severity: context.severity,
        sourceModule: context.sourceModule,
        status: 'active',
      };
    }
  }

  // ── 能力 2：签名检测 ────────────────────────────────────────────

  /**
   * 检查一个入侵请求是否命中已学习签名。
   *
   * 采用加权相似度评分（行为 40% / 内容 30% / 上下文 30%）。命中后：
   *   - 上调对应规则的匹配计数与置信度（达到阈值自动激活）
   *   - 刷新签名 lastSeen/occurrenceCount
   *   - 记录 signature_matched 审计事件
   *
   * 这是「第二次瞬时拦截」的核心入口。
   */
  checkAgainstLearnedSignatures(request: SignatureCheckRequest): SignatureMatchResult {
    const noMatch: SignatureMatchResult = {
      matched: false,
      similarity: 0,
      confidence: 0,
      action: 'monitor',
    };
    if (!this.config.enabled || this.signatures.size === 0) {
      return noMatch;
    }
    try {
      const features = this.extractRequestFeatures(request);
      let bestSig: AttackSignature | null = null;
      let bestScore = 0;

      for (const sig of this.signatures.values()) {
        if (sig.status === 'deprecated' || sig.status === 'false_positive') continue;
        const score = this.computeSimilarity(features, sig);
        if (score > bestScore) {
          bestScore = score;
          bestSig = sig;
        }
      }

      if (!bestSig || bestScore < this.config.matchThreshold) {
        return noMatch;
      }

      const matched = bestSig;
      const similarity = round(bestScore, 4);
      // 置信度 = 相似度 70% + 出现次数贡献 30%（出现越多越可信）
      const occurrenceBoost = Math.min(matched.occurrenceCount / 10, 0.3);
      const confidence = clamp01(round(similarity * 0.7 + occurrenceBoost, 4));

      // 查找关联规则决定动作
      const ruleId = this.ruleIdFor(matched.signatureId);
      const rule = this.rules.get(ruleId);
      let action: RuleAction = 'alert';
      if (rule && rule.active && rule.confidence >= this.config.minConfidenceForAction) {
        action = rule.action;
      } else if (confidence < this.config.minConfidenceForAction) {
        action = 'monitor';
      }

      // 命中后强化规则与签名
      if (rule) {
        this.reinforceRule(rule);
      }
      matched.lastSeen = new Date().toISOString();
      matched.occurrenceCount += 1;
      this.signatures.set(matched.signatureId, matched);

      this.logSignatureMatched(matched, similarity, confidence, action, request);
      this.incrementMetric('atl.signatures_matched', 1, {
        sourceModule: matched.sourceModule,
        severity: matched.severity,
      });
      this.recordMetrics();

      return {
        matched: true,
        signatureId: matched.signatureId,
        similarity,
        confidence,
        action,
        ruleId: rule?.ruleId,
        matchedRule: rule,
      };
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:checkAgainstLearnedSignatures');
      return noMatch;
    }
  }

  // ── 能力 3：实时规则合成 ────────────────────────────────────────

  /**
   * 当检测到（新型）攻击时，自动合成一条检测规则。
   *
   * 规则由从攻击特征提炼的条件（token/工具/请求大小/内容关键词/API/时段）+
   * 动作（按严重度）+ 置信度（初始 0.3，随匹配上升）组成。
   * 同一签名只生成一条规则（幂等），重复调用返回已存在规则。
   */
  synthesizeRule(context: AttackContext): SynthesizedRule | null {
    try {
      const fp = this.buildFingerprint(context);
      return this.createRule(context, fp, fp.signatureId);
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:synthesizeRule');
      return null;
    }
  }

  /** 列出所有合成规则。 */
  getSynthesizedRules(): SynthesizedRule[] {
    return [...this.rules.values()];
  }

  /** 获取指定规则。 */
  getRule(ruleId: string): SynthesizedRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * 手动停用一条规则（人工覆盖）。
   * @returns 是否找到并停用
   */
  deactivateRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.active = false;
    this.rules.set(ruleId, rule);
    this.logThreatLearned(`规则已手动停用：${ruleId}`, 'medium', {
      ruleId,
      sourceSignatureId: rule.sourceSignatureId,
      confidence: rule.confidence,
      matchCount: rule.matchCount,
      falsePositiveCount: rule.falsePositiveCount,
    });
    this.recordMetrics();
    return true;
  }

  /**
   * 上报一次误报——下调规则置信度，超阈值则自动停用。
   * @returns 是否找到规则
   */
  reportFalsePositive(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    try {
      rule.falsePositiveCount += 1;
      rule.confidence = clamp01(round(rule.confidence - CONFIDENCE_FP_DECREMENT, 4));
      let autoDeactivated = false;
      if (
        rule.falsePositiveCount >= this.config.ruleFalsePositiveThreshold ||
        rule.confidence < this.config.minConfidenceForAction
      ) {
        rule.active = false;
        autoDeactivated = true;
        // 同步标记签名为误报嫌疑
        const sig = this.signatures.get(rule.sourceSignatureId);
        if (sig && sig.status === 'active') {
          sig.status = 'false_positive';
          this.signatures.set(sig.signatureId, sig);
        }
      }
      this.rules.set(ruleId, rule);
      this.logThreatLearned(`规则误报反馈：${ruleId}`, 'medium', {
        ruleId,
        falsePositiveCount: rule.falsePositiveCount,
        confidence: rule.confidence,
        autoDeactivated,
      });
      this.recordMetrics();
      return true;
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:reportFalsePositive');
      return true;
    }
  }

  // ── 能力 4：威胁模型进化 ────────────────────────────────────────

  /**
   * 进化威胁模型：
   *   1. 剪枝过期签名（超过 signatureExpiryDays 未出现）
   *   2. 聚类相似签名为攻击家族
   *   3. 提炼家族共性、更新家族成员归属
   *   4. 重算威胁模型健康度与 Top 威胁
   */
  evolveThreatModel(): ThreatModel {
    try {
      // 1. 剪枝
      this.pruneExpiredSignatures();

      // 2. 聚类
      const families = this.clusterSignatures();
      this.families.clear();
      for (const fam of families) {
        this.families.set(fam.familyId, fam);
        // 回填签名上的 familyId
        for (const sid of fam.memberSignatureIds) {
          const sig = this.signatures.get(sid);
          if (sig) {
            sig.attackFamilyId = fam.familyId;
            this.signatures.set(sid, sig);
          }
        }
      }
      if (families.length > 0) {
        this.incrementMetric('atl.families_discovered', families.length, {});
      }

      // 3. 构建模型
      this.modelVersion += 1;
      const sigs = [...this.signatures.values()];
      const activeSigs = sigs.filter((s) => s.status === 'active' || s.status === 'monitoring');
      const rules = [...this.rules.values()];
      const activeRules = rules.filter((r) => r.active);
      const topThreats = sigs
        .slice()
        .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
        .slice(0, 10)
        .map((s) => ({
          signatureId: s.signatureId,
          occurrenceCount: s.occurrenceCount,
          lastSeen: s.lastSeen,
        }));

      const totalFp = rules.reduce((sum, r) => sum + r.falsePositiveCount, 0);
      const totalMatches = rules.reduce((sum, r) => sum + r.matchCount, 0);
      const fpRatio = totalMatches + totalFp > 0 ? totalFp / (totalMatches + totalFp) : 0;

      let health: 'healthy' | 'degraded' | 'critical';
      if (sigs.length === 0) {
        health = 'critical';
      } else if (activeRules.length === 0 || fpRatio > 0.3) {
        health = 'degraded';
      } else {
        health = 'healthy';
      }

      this.threatModel = {
        version: this.modelVersion,
        lastUpdated: new Date().toISOString(),
        totalSignatures: sigs.length,
        activeSignatures: activeSigs.length,
        totalRules: rules.length,
        activeRules: activeRules.length,
        attackFamilies: families,
        topThreats,
        modelHealth: health,
      };

      this.logThreatLearned(`威胁模型已进化至 v${this.modelVersion}`, 'low', {
        version: this.modelVersion,
        totalSignatures: sigs.length,
        activeSignatures: activeSigs.length,
        totalRules: rules.length,
        activeRules: activeRules.length,
        families: families.length,
        modelHealth: health,
      });
      this.recordMetrics();
      return this.threatModel;
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:evolveThreatModel');
      return this.threatModel;
    }
  }

  /** 获取当前威胁模型（若未进化过则即时构建一份）。 */
  getThreatModel(): ThreatModel {
    if (this.modelVersion === 0) {
      return this.evolveThreatModel();
    }
    return this.threatModel;
  }

  /** 列出已发现的攻击家族。 */
  getAttackFamilies(): AttackFamily[] {
    return [...this.families.values()];
  }

  /** 列出全部签名。 */
  getSignatures(): AttackSignature[] {
    return [...this.signatures.values()];
  }

  // ── 生命周期 ────────────────────────────────────────────────────

  /**
   * 重置引擎状态（清空签名/规则/家族/模型并重启定时器）。
   * 用于测试隔离或运维重置。
   */
  reset(): void {
    this.signatures.clear();
    this.rules.clear();
    this.families.clear();
    this.modelVersion = 0;
    this.threatModel = this.buildEmptyThreatModel();
    this.stopEvolutionTimer();
    if (this.config.enabled) {
      this.startEvolutionTimer();
    }
    try {
      getGlobalLogger().info('AdaptiveThreatLearningEngine', '引擎状态已重置');
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:reset');
    }
  }

  /**
   * 释放资源（停止定时器）。由租户单例销毁时回调。
   */
  dispose(): void {
    this.stopEvolutionTimer();
  }

  // ── 内部：指纹构建 ──────────────────────────────────────────────

  /**
   * 从攻击上下文构建三维指纹与规范签名 ID。
   * 签名 ID 基于分桶后的特征计算，使「同类攻击」坍缩到同一签名。
   */
  private buildFingerprint(context: AttackContext): BuiltFingerprint {
    const tokenCount = context.tokenCount ?? 0;
    const tokenTol = Math.max(1, Math.floor(tokenCount * 0.1));
    const toolCallRate =
      context.requestCount && context.requestCount > 0
        ? (context.toolCallCount ?? 0) / context.requestCount
        : (context.toolCallCount ?? 0);

    const behavioral: AttackSignature['behavioralFingerprint'] = {
      tokenRange: [Math.max(0, tokenCount - tokenTol), tokenCount + tokenTol],
      toolCallRate: round(toolCallRate, 4),
      requestSizeRange: sizeRange(context.requestSize),
      timingPattern: bucketTimeOfDay(context.timestamp),
      apiPattern: normalizeApi(context.apiEndpoint),
    };

    const combinedContent: string = [context.userInput, context.toolParams, context.llmOutput]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    const normalized = normalizeContent(combinedContent);
    const content: AttackSignature['contentFingerprint'] = {
      contentHash: sha256(normalized),
      patternKeywords: extractKeywords(combinedContent),
      contentType: inferContentType(combinedContent),
    };

    const contextFp: AttackSignature['contextFingerprint'] = {
      agentType:
        (typeof context.metadata?.agentType === 'string' && context.metadata.agentType) ||
        context.agentId ||
        'unknown',
      sessionType:
        (typeof context.metadata?.sessionType === 'string' && context.metadata.sessionType) ||
        inferSessionType(context.sessionId),
      timeOfDayPattern: bucketTimeOfDay(context.timestamp),
      sourcePattern: normalizeSource(context.sourceIp, context.userAgent),
    };

    // 规范指纹——分桶以稳定化，使同类攻击坍缩到同一签名 ID
    const contentPattern = sha256([...content.patternKeywords].sort().slice(0, 5).join('|'));
    const canonical = JSON.stringify({
      tb: bucketLog(behavioral.tokenRange[1]),
      sb: bucketLog(behavioral.requestSizeRange[1]),
      rb: bucketRate(behavioral.toolCallRate),
      tp: behavioral.timingPattern,
      ap: behavioral.apiPattern ?? '',
      ct: content.contentType,
      cp: contentPattern,
      at: contextFp.agentType,
      st: contextFp.sessionType,
      tt: contextFp.timeOfDayPattern,
      sp: contextFp.sourcePattern ?? '',
    });
    const signatureId = sha256(canonical);

    return { signatureId, behavioral, content, context: contextFp };
  }

  // ── 内部：规则合成 ──────────────────────────────────────────────

  /** 由签名 ID 派生规则 ID。 */
  private ruleIdFor(signatureId: string): string {
    return RULE_ID_PREFIX + signatureId.slice(0, 12);
  }

  /**
   * 创建或返回已有规则。幂等：同一签名只生成一条规则。
   */
  private createRule(
    context: AttackContext,
    fp: BuiltFingerprint,
    signatureId: string,
  ): SynthesizedRule {
    const ruleId = this.ruleIdFor(signatureId);
    const existing = this.rules.get(ruleId);
    if (existing) {
      return existing;
    }

    this.enforceRuleCap();

    const conditions: SynthesizedRule['conditions'] = [];
    if (context.tokenCount !== undefined && context.tokenCount > 0) {
      conditions.push({
        field: 'tokenCount',
        operator: 'gt',
        value: Math.floor(context.tokenCount * 0.8),
        weight: 0.3,
      });
    }
    if (context.toolCallCount !== undefined && context.toolCallCount > 0) {
      conditions.push({
        field: 'toolCallCount',
        operator: 'gt',
        value: context.toolCallCount,
        weight: 0.25,
      });
    }
    if (context.requestSize !== undefined && context.requestSize > 0) {
      conditions.push({
        field: 'requestSize',
        operator: 'gt',
        value: Math.floor(context.requestSize * 0.8),
        weight: 0.2,
      });
    }
    if (context.responseTimeMs !== undefined && context.responseTimeMs > 0) {
      conditions.push({
        field: 'responseTimeMs',
        operator: 'lt',
        value: context.responseTimeMs,
        weight: 0.1,
      });
    }
    if (fp.content.patternKeywords.length > 0) {
      conditions.push({
        field: 'userInput',
        operator: 'contains',
        value: fp.content.patternKeywords[0],
        weight: 0.25,
      });
    }
    if (fp.behavioral.apiPattern) {
      conditions.push({
        field: 'apiEndpoint',
        operator: 'matches',
        value: fp.behavioral.apiPattern,
        weight: 0.15,
      });
    }
    // 时段条件始终存在，保证至少一条条件
    conditions.push({
      field: 'timeOfDay',
      operator: 'eq',
      value: fp.context.timeOfDayPattern,
      weight: 0.1,
    });

    const rule: SynthesizedRule = {
      ruleId,
      sourceSignatureId: signatureId,
      conditions,
      action: severityToAction(context.severity),
      confidence: INITIAL_RULE_CONFIDENCE,
      matchCount: 0,
      falsePositiveCount: 0,
      createdAt: new Date().toISOString(),
      active: false, // 初始为 monitoring 模式
    };
    this.rules.set(ruleId, rule);

    this.logThreatLearned(
      `已合成检测规则：${ruleId}（动作 ${rule.action}）`,
      context.severity,
      {
        ruleId,
        sourceSignatureId: signatureId,
        action: rule.action,
        confidence: rule.confidence,
        conditionCount: conditions.length,
      },
      context.tenantId,
      context.agentId,
    );
    this.incrementMetric('atl.rules_synthesized', 1, {
      action: rule.action,
      severity: context.severity,
    });

    return rule;
  }

  /**
   * 命中后强化规则：匹配数 +1、置信度上升、必要时自动激活。
   */
  private reinforceRule(rule: SynthesizedRule): void {
    rule.matchCount += 1;
    rule.lastMatchedAt = new Date().toISOString();
    const prevConfidence = rule.confidence;
    rule.confidence = clamp01(round(rule.confidence + CONFIDENCE_MATCH_INCREMENT, 4));
    let activated = false;
    if (!rule.active && rule.confidence >= this.config.autoActivateRuleThreshold) {
      rule.active = true;
      activated = true;
    }
    this.rules.set(rule.ruleId, rule);
    if (activated) {
      this.incrementMetric('atl.rules_activated', 1, {
        action: rule.action,
      });
      this.logThreatLearned(`规则已自动激活：${rule.ruleId}`, 'medium', {
        ruleId: rule.ruleId,
        sourceSignatureId: rule.sourceSignatureId,
        confidence: rule.confidence,
        prevConfidence,
        matchCount: rule.matchCount,
      });
    }
  }

  // ── 内部：相似度计算 ────────────────────────────────────────────

  /** 从检测请求提取特征。 */
  private extractRequestFeatures(req: SignatureCheckRequest): RequestFeatures {
    const combinedContent: string = [req.userInput, req.toolParams, req.llmOutput]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    const normalized = normalizeContent(combinedContent);
    const toolCallRate =
      req.requestCount && req.requestCount > 0
        ? (req.toolCallCount ?? 0) / req.requestCount
        : req.toolCallCount;
    return {
      tokenCount: req.tokenCount,
      toolCallCount: req.toolCallCount,
      requestSize: req.requestSize,
      toolCallRate,
      apiEndpoint: normalizeApi(req.apiEndpoint),
      contentHash: sha256(normalized),
      keywords: extractKeywords(combinedContent),
      contentType: inferContentType(combinedContent),
      hasContent: combinedContent.length > 0,
      timeOfDay: req.timestamp ? bucketTimeOfDay(req.timestamp) : 'unknown',
      agentType:
        (typeof req.metadata?.agentType === 'string' && req.metadata.agentType) ||
        req.agentId ||
        'unknown',
      sessionType:
        (typeof req.metadata?.sessionType === 'string' && req.metadata.sessionType) ||
        inferSessionType(req.sessionId),
      sourcePattern: normalizeSource(req.sourceIp, req.userAgent),
    };
  }

  /**
   * 计算请求特征相对某签名的加权相似度总分。
   */
  private computeSimilarity(req: RequestFeatures, sig: AttackSignature): number {
    // 行为相似度
    const behavioralComps: number[] = [];
    behavioralComps.push(pointRangeSim(sig.behavioralFingerprint.tokenRange, req.tokenCount));
    behavioralComps.push(rateSim(sig.behavioralFingerprint.toolCallRate, req.toolCallRate));
    behavioralComps.push(
      pointRangeSim(sig.behavioralFingerprint.requestSizeRange, req.requestSize),
    );
    behavioralComps.push(
      req.timeOfDay === 'unknown'
        ? 0.5
        : req.timeOfDay === sig.behavioralFingerprint.timingPattern
          ? 1
          : 0,
    );
    if (sig.behavioralFingerprint.apiPattern && req.apiEndpoint) {
      behavioralComps.push(req.apiEndpoint.includes(sig.behavioralFingerprint.apiPattern) ? 1 : 0);
    }
    const behavioral = mean(behavioralComps);

    // 内容相似度
    let content: number;
    if (!req.hasContent) {
      content = 0.5; // 中性
    } else {
      const jac = jaccard(sig.contentFingerprint.patternKeywords, req.keywords);
      const hashMatch =
        req.contentHash !== '' && req.contentHash === sig.contentFingerprint.contentHash ? 1 : 0;
      content = 0.7 * jac + 0.3 * hashMatch;
    }

    // 上下文相似度
    const contextComps: number[] = [];
    contextComps.push(req.agentType === sig.contextFingerprint.agentType ? 1 : 0);
    contextComps.push(req.sessionType === sig.contextFingerprint.sessionType ? 1 : 0);
    contextComps.push(
      req.timeOfDay === 'unknown'
        ? 0.5
        : req.timeOfDay === sig.contextFingerprint.timeOfDayPattern
          ? 1
          : 0,
    );
    if (sig.contextFingerprint.sourcePattern && req.sourcePattern) {
      contextComps.push(req.sourcePattern === sig.contextFingerprint.sourcePattern ? 1 : 0);
    }
    const context = mean(contextComps);

    const total =
      this.config.behavioralWeight * behavioral +
      this.config.contentWeight * content +
      this.config.contextWeight * context;
    return clamp01(total);
  }

  // ── 内部：聚类与剪枝 ────────────────────────────────────────────

  /** 剪枝超过 signatureExpiryDays 未出现的签名。 */
  private pruneExpiredSignatures(): void {
    const now = Date.now();
    const ttlMs = this.config.signatureExpiryDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [id, sig] of this.signatures) {
      const lastMs = Date.parse(sig.lastSeen);
      if (Number.isNaN(lastMs)) continue;
      if (now - lastMs > ttlMs) {
        sig.status = 'deprecated';
        this.signatures.set(id, sig);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logThreatLearned(`剪枝过期签名 ${pruned} 条`, 'low', { pruned });
    }
  }

  /**
   * 聚类相似签名为攻击家族。
   * 采用贪心聚类：以出现频次最高的签名为种子，吸纳同内容类型、同严重度、
   * 关键词 Jaccard >= 0.5 的签名。为控制计算量，最多处理最近 2000 条签名。
   */
  private clusterSignatures(): AttackFamily[] {
    const all = [...this.signatures.values()].filter(
      (s) => s.status === 'active' || s.status === 'monitoring',
    );
    // 取最近 2000 条（按 lastSeen 倒序）以约束 O(n^2) 成本
    all.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const sigs = all.slice(0, 2000);

    const assigned: Set<string> = new Set();
    const families: AttackFamily[] = [];

    // 种子按出现频次降序，使最具代表性的签名优先成簇
    const seeds = sigs.slice().sort((a, b) => b.occurrenceCount - a.occurrenceCount);

    for (const seed of seeds) {
      if (assigned.has(seed.signatureId)) continue;
      const members: AttackSignature[] = [seed];
      assigned.add(seed.signatureId);
      for (const cand of sigs) {
        if (assigned.has(cand.signatureId)) continue;
        if (cand.contentFingerprint.contentType !== seed.contentFingerprint.contentType) continue;
        if (cand.severity !== seed.severity) continue;
        const jac = jaccard(
          seed.contentFingerprint.patternKeywords,
          cand.contentFingerprint.patternKeywords,
        );
        if (jac >= 0.5) {
          members.push(cand);
          assigned.add(cand.signatureId);
        }
      }
      if (members.length >= this.config.minClusterSize) {
        families.push(this.buildFamily(members));
      }
    }
    return families;
  }

  /** 由成员签名构建攻击家族。 */
  private buildFamily(members: AttackSignature[]): AttackFamily {
    const ids = members.map((m) => m.signatureId).sort();
    const familyId = FAMILY_ID_PREFIX + sha256(ids.join(',')).slice(0, 16);

    const keywordSets = members.map((m) => m.contentFingerprint.patternKeywords);
    const commonKeywords = intersectKeywords(keywordSets);
    const type = inferAttackFamilyType(
      members[0]!.contentFingerprint.contentType,
      commonKeywords.length > 0 ? commonKeywords : members[0]!.contentFingerprint.patternKeywords,
    );

    // 共性特征：共有关键词 + 共有上下文特征
    const characteristics: string[] = [];
    if (commonKeywords.length > 0) {
      characteristics.push(`keywords: ${commonKeywords.slice(0, 5).join(', ')}`);
    }
    const contentTypes = new Set(members.map((m) => m.contentFingerprint.contentType));
    if (contentTypes.size === 1) {
      characteristics.push(`contentType: ${[...contentTypes][0]}`);
    }
    const agentTypes = new Set(members.map((m) => m.contextFingerprint.agentType));
    if (agentTypes.size === 1) {
      characteristics.push(`agentType: ${[...agentTypes][0]}`);
    }
    const timingPatterns = new Set(members.map((m) => m.behavioralFingerprint.timingPattern));
    if (timingPatterns.size === 1) {
      characteristics.push(`timing: ${[...timingPatterns][0]}`);
    }
    characteristics.push(`severity: ${maxSeverity(members.map((m) => m.severity))}`);

    const firstSeen = members.map((m) => m.firstSeen).sort()[0]!;
    const lastSeen = members
      .map((m) => m.lastSeen)
      .sort()
      .reverse()[0]!;
    const totalOccurrences = members.reduce((sum, m) => sum + m.occurrenceCount, 0);
    const severity = maxSeverity(members.map((m) => m.severity));
    const dayMs = 24 * 60 * 60 * 1000;
    const evolving = Date.now() - Date.parse(lastSeen) < dayMs;
    const name = `${type} family (${commonKeywords[0] ?? 'unknown'})`;

    return {
      familyId,
      type,
      name,
      memberSignatureIds: ids,
      commonCharacteristics: characteristics,
      firstSeen,
      lastSeen,
      totalOccurrences,
      severity,
      evolving,
    };
  }

  // ── 内部：容量与区间 ────────────────────────────────────────────

  /** 签名数超限时淘汰最旧的 active 签名。 */
  private enforceSignatureCap(): void {
    if (this.signatures.size < this.config.maxSignatures) return;
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, sig] of this.signatures) {
      const t = Date.parse(sig.lastSeen);
      if (t < oldestTime) {
        oldestTime = t;
        oldestId = id;
      }
    }
    if (oldestId) {
      const sig = this.signatures.get(oldestId);
      if (sig) {
        sig.status = 'deprecated';
        this.signatures.set(oldestId, sig);
      }
    }
  }

  /** 规则数超限时淘汰置信度最低的规则。 */
  private enforceRuleCap(): void {
    if (this.rules.size < this.config.maxRules) return;
    let weakestId: string | null = null;
    let weakestConf = Infinity;
    for (const [id, rule] of this.rules) {
      if (rule.confidence < weakestConf) {
        weakestConf = rule.confidence;
        weakestId = id;
      }
    }
    if (weakestId) {
      this.rules.delete(weakestId);
    }
  }

  /** 扩展区间以纳入新观测值。 */
  private expandRange(range: [number, number], value?: number): [number, number] {
    if (value === undefined || value < 0) return range;
    const tol = Math.max(1, Math.floor(value * 0.1));
    return [Math.min(range[0], Math.max(0, value - tol)), Math.max(range[1], value + tol)];
  }

  // ── 内部：定时器 ────────────────────────────────────────────────

  private startEvolutionTimer(): void {
    this.stopEvolutionTimer();
    if (!this.config.enabled) return;
    try {
      this.evolutionTimer = setInterval(() => {
        try {
          this.evolveThreatModel();
        } catch (err) {
          reportSilentFailure(err, 'adaptiveThreatLearningEngine:evolutionTick');
        }
      }, this.config.evolutionIntervalMs);
      // 不阻止进程退出
      this.evolutionTimer.unref?.();
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:startEvolutionTimer');
    }
  }

  private stopEvolutionTimer(): void {
    if (this.evolutionTimer) {
      try {
        clearInterval(this.evolutionTimer);
      } catch (err) {
        reportSilentFailure(err, 'adaptiveThreatLearningEngine:stopEvolutionTimer');
      }
      this.evolutionTimer = null;
    }
  }

  // ── 内部：审计与指标 ────────────────────────────────────────────

  private buildEmptyThreatModel(): ThreatModel {
    return {
      version: 0,
      lastUpdated: new Date().toISOString(),
      totalSignatures: 0,
      activeSignatures: 0,
      totalRules: 0,
      activeRules: 0,
      attackFamilies: [],
      topThreats: [],
      modelHealth: 'critical',
    };
  }

  /** 记录 threat_learned 审计事件。 */
  private logThreatLearned(
    message: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details: Record<string, unknown>,
    tenantId?: string,
    agentId?: string,
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'threat_learned',
        severity,
        source: 'AdaptiveThreatLearningEngine',
        message,
        details,
        context: { tenantId, agentId },
      });
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:logThreatLearned');
    }
  }

  /** 记录 signature_matched 审计事件。 */
  private logSignatureMatched(
    sig: AttackSignature,
    similarity: number,
    confidence: number,
    action: RuleAction,
    req: SignatureCheckRequest,
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'signature_matched',
        severity: sig.severity,
        source: 'AdaptiveThreatLearningEngine',
        message: `命中已学习签名：${sig.signatureId.slice(0, 12)}（相似度 ${similarity}）`,
        details: {
          signatureId: sig.signatureId,
          sourceModule: sig.sourceModule,
          similarity,
          confidence,
          action,
          occurrenceCount: sig.occurrenceCount,
          agentId: req.agentId,
          apiEndpoint: req.apiEndpoint,
        },
        context: { tenantId: req.tenantId, agentId: req.agentId },
      });
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:logSignatureMatched');
    }
  }

  /** 安全地递增计数器指标。 */
  private incrementMetric(name: string, value: number, labels: Record<string, string>): void {
    try {
      getGlobalMetrics().incrementCounter(name, value, labels);
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:incrementMetric');
    }
  }

  /** 刷新存量型指标（签名/规则/家族数量）。 */
  private recordMetrics(): void {
    try {
      const metrics = getGlobalMetrics();
      let activeSigs = 0;
      let activeRules = 0;
      for (const s of this.signatures.values()) {
        if (s.status === 'active' || s.status === 'monitoring') activeSigs++;
      }
      for (const r of this.rules.values()) {
        if (r.active) activeRules++;
      }
      metrics.setGauge('atl.signatures.total', this.signatures.size, {});
      metrics.setGauge('atl.signatures.active', activeSigs, {});
      metrics.setGauge('atl.rules.total', this.rules.size, {});
      metrics.setGauge('atl.rules.active', activeRules, {});
      metrics.setGauge('atl.families.total', this.families.size, {});
    } catch (err) {
      reportSilentFailure(err, 'adaptiveThreatLearningEngine:recordMetrics');
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

const adaptiveLearningSingleton = createTenantAwareSingleton(
  () => new AdaptiveThreatLearningEngine(),
  {
    allowGlobalFallback: true,
    componentName: 'AdaptiveThreatLearningEngine',
    dispose: (instance: AdaptiveThreatLearningEngine) => {
      instance.dispose();
    },
  },
);

/**
 * 获取全局 AdaptiveThreatLearningEngine 单例（单租户）或租户作用域实例（多租户）。
 *
 * @param config - 部分配置（可选，首次传入时会合并到引擎配置）
 * @returns AdaptiveThreatLearningEngine 实例
 */
export function getAdaptiveThreatLearningEngine(
  config?: Partial<AdaptiveLearningConfig>,
): AdaptiveThreatLearningEngine {
  const engine = adaptiveLearningSingleton.get();
  if (config) {
    engine.configure(config);
  }
  return engine;
}

/**
 * 重置 AdaptiveThreatLearningEngine 单例（用于测试隔离）。
 * 清除所有租户实例，释放内存中的签名、规则与家族。
 */
export function resetAdaptiveThreatLearningEngine(): void {
  adaptiveLearningSingleton.reset();
}
