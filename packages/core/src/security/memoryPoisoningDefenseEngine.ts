/**
 * Memory Poisoning Defense Engine
 *
 * 安全 (OWASP ASI06 / ASI07): 提供针对全部 5 类记忆投毒攻击的综合防御。
 *
 * 现有的 `memoryPoisoningGate.ts` 仅做基础正则匹配，本引擎在其之上提供
 * 完整的写入校验、检索校验、摘要校验、反思校验以及跨会话污染追踪能力。
 *
 * 5 类防御:
 *   1. 写入投毒防御 (Write Poisoning)      — validateMemoryWrite
 *   2. 检索投毒防御 (Retrieval Poisoning)  — validateRetrievedMemories
 *   3. 摘要投毒防御 (Summary Poisoning)    — validateSummary
 *   4. 反思投毒防御 (Reflection Poisoning) — validateReflection
 *   5. 跨会话持久化防御 (Cross-Session)    — checkCrossSessionTaint
 *
 * 设计要点:
 *   - 使用 createTenantAwareSingleton 实现租户隔离的单例
 *   - 所有 catch 块使用 reportSilentFailure 上报，绝不抛出
 *   - 安全事件统一写入 SecurityAuditLogger
 *   - 指标通过 getGlobalMetrics 上报
 *   - 检测模式为带权重的正则数组，风险分聚合: weight × (1 − sourceCredibility)
 *   - 污染追踪图: 被污染记忆参与生成的新记忆继承污染标记
 *   - 隔离区: 存储被拦截内容完整上下文，供人工复核，绝不自动激活
 */

import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger, type SecuritySeverity } from './securityAuditLogger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import * as crypto from 'node:crypto';

// ============================================================================
// 导出类型
// ============================================================================

/** 投毒攻击的 5 种类型。 */
export type PoisoningType = 'write' | 'retrieval' | 'summary' | 'reflection' | 'cross_session';

/** 严重程度等级。 */
export type PoisoningSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 数据源可信度分级。 */
export type SourceCredibility = 'verified_tool' | 'agent_generated' | 'user_input' | 'web_content' | 'unknown';

/** 记忆写入上下文 — 在任何记忆写入前传给引擎。 */
export interface MemoryWriteContext {
  content: string;
  source: string;
  agentId: string;
  memoryType: 'episodic' | 'semantic' | 'procedural' | 'summary' | 'reflection';
  sourceCredibility: SourceCredibility;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

/** 防御校验结果。 */
export interface DefenseResult {
  allowed: boolean;
  reason: string;
  poisoningType?: PoisoningType;
  severity: PoisoningSeverity;
  riskScore: number; // 0-1
  sanitizedContent?: string; // 应用了清洗后的内容
  quarantined: boolean;
  taintId?: string; // 如果内容被标记为污染，对应的追踪 ID
}

/** 检索到的单条记忆条目。 */
export interface RetrievedMemoryEntry {
  id: string;
  content: string;
  source: string;
  sourceCredibility: SourceCredibility;
  storedAt: string;
  memoryType: string;
}

/** 检索校验结果。 */
export interface RetrievalValidationResult {
  safeEntries: RetrievedMemoryEntry[];
  quarantinedEntries: Array<{ entry: RetrievedMemoryEntry; reason: string }>;
  sanitized: boolean;
}

/** 单条污染追踪记录。 */
export interface TaintEntry {
  taintId: string;
  memoryId: string;
  content: string;
  source: string;
  poisoningType: PoisoningType;
  detectedAt: string;
  propagatedFrom?: string; // 父污染 ID
  sessionId: string;
  agentId: string;
}

/** 污染追踪报告。 */
export interface TaintReport {
  totalTainted: number;
  byType: Record<PoisoningType, number>;
  taintChain: TaintEntry[];
  oldestTaint?: string;
  newestTaint?: string;
}

/** 引擎配置。 */
export interface MemoryPoisoningDefenseConfig {
  enabled: boolean;
  maxWritesPerMinute: number;
  enableEntropyAnalysis: boolean;
  enableUnicodeDetection: boolean;
  enableBase64Detection: boolean;
  enableTaintTracking: boolean;
  quarantineEnabled: boolean;
  maxQuarantineSize: number;
  taintedMemoryTtlMs: number; // 0 = 永不过期
  strictMode: boolean; // true = 检测到任何威胁即拦截; false = 隔离并放行带告警
}

// ============================================================================
// 检测模式定义 (带权重)
// ============================================================================

interface DetectionPattern {
  pattern: RegExp;
  category: string;
  weight: number; // 0-1, 模式本身的风险权重
}

/**
 * 指令覆盖模式 — 试图让 Agent 忽略/遗忘既有指令。
 */
const INSTRUCTION_OVERRIDE_PATTERNS: DetectionPattern[] = [
  { category: 'instruction_override', weight: 0.95, pattern: /ignore\s+(all\s+)?previous\s+(instructions?|memor|rules?|prompts?)/i },
  { category: 'instruction_override', weight: 0.95, pattern: /disregard\s+(all\s+)?prior\s+(instructions?|memor|rules?)/i },
  { category: 'instruction_override', weight: 0.9, pattern: /forget\s+(all\s+|everything\s+|all\s+your\s+)?previous\s+(instructions?|context|memor)/i },
  { category: 'instruction_override', weight: 0.9, pattern: /you\s+(are|must|should)\s+(now|always|only)\s+(ignore|follow|act)/i },
  { category: 'instruction_override', weight: 0.85, pattern: /(?:new|real|actual|updated?)\s+instructions?\s*(?:follow|:|are)/i },
  { category: 'instruction_override', weight: 0.9, pattern: /override\s+(the\s+)?(system|safety|security)\s+(prompt|instructions?|rules?)/i },
  { category: 'instruction_override', weight: 0.8, pattern: /stop\s+(following|adhering\s+to)\s+(your|the)\s+(rules|guidelines|instructions)/i },
  { category: 'instruction_override', weight: 0.85, pattern: /from\s+now\s+on[,\s]+(you\s+)?(must|should|will|are\s+to)/i },
];

/**
 * 系统提示词操纵模式 — 试图篡改或替换系统提示词。
 */
const SYSTEM_PROMPT_MANIPULATION_PATTERNS: DetectionPattern[] = [
  { category: 'system_prompt_manipulation', weight: 0.85, pattern: /system\s*prompt\s*(is|should\s+be|must\s+be|has\s+been)\s+/i },
  { category: 'system_prompt_manipulation', weight: 0.9, pattern: /your\s+(true|real|actual|hidden)\s+(instructions?|goal|mission|objective)\s+(is|are|was)\s+/i },
  { category: 'system_prompt_manipulation', weight: 0.9, pattern: /(?:update|replace|modify|change|rewrite)\s+(the\s+)?system\s+(prompt|message|instructions?)/i },
  { category: 'system_prompt_manipulation', weight: 0.85, pattern: /system\s+(prompt|message)\s+(contains?|says?)\s+/i },
  { category: 'system_prompt_manipulation', weight: 0.8, pattern: /reveal|disclose|show|print|output\s+(your\s+)?system\s+(prompt|instructions?)/i },
  { category: 'system_prompt_manipulation', weight: 0.85, pattern: /\[system\]|\[\/system\]|\[instructions\]/i },
];

/**
 * 数据外泄载荷模式 — 试图将敏感数据发送到外部。
 */
const DATA_EXFILTRATION_PATTERNS: DetectionPattern[] = [
  { category: 'data_exfiltration', weight: 0.8, pattern: /(?:send|exfiltrate|upload|post|transmit|leak)\s+.*(?:to|via|through)\s+(?:web|http|https|url|endpoint|server|api|webhook)/i },
  { category: 'data_exfiltration', weight: 0.85, pattern: /(?:send|exfiltrate|upload|post)\s+.*(?:credentials?|secrets?|tokens?|keys?|passwords?|api[_-]?keys?)/i },
  { category: 'data_exfiltration', weight: 0.75, pattern: /(?:curl|wget|fetch|axios)\s+(https?:|http:|ftp:)/i },
  { category: 'data_exfiltration', weight: 0.8, pattern: /(?:base64|btoa|atob|encode)\s*\(.*(?:secret|token|key|password)/i },
  { category: 'data_exfiltration', weight: 0.7, pattern: /(?:http|https|ftp):\/\/[^\s"']{10,}/i },
  { category: 'data_exfiltration', weight: 0.85, pattern: /(?:collect|gather|harvest)\s+(all\s+)?(?:user\s+)?(?:data|info|information|files?|documents?)/i },
];

/**
 * 权限提升模式 — 试图获取未授权的权限。
 */
const PRIVILEGE_ESCALATION_PATTERNS: DetectionPattern[] = [
  { category: 'privilege_escalation', weight: 0.9, pattern: /grant\s+(full|admin|root|elevated|super)\s+(access|permissions?|privileges?)/i },
  { category: 'privilege_escalation', weight: 0.85, pattern: /(?:enable|activate|turn\s+on)\s+(?:sudo|root|admin|superuser|debug|developer)\s+mode/i },
  { category: 'privilege_escalation', weight: 0.85, pattern: /(?:sudo|su\s+-|chmod\s+777|chown\s+root)/i },
  { category: 'privilege_escalation', weight: 0.8, pattern: /(?:disable|turn\s+off|bypass)\s+(?:security|safety|sandbox|guardrails?|protections?|checks?)/i },
  { category: 'privilege_escalation', weight: 0.85, pattern: /(?:escalate|elevate)\s+(privileges?|permissions?|access|rights)/i },
  { category: 'privilege_escalation', weight: 0.8, pattern: /run\s+as\s+(root|admin|superuser|system)/i },
];

/**
 * 摘要/反思场景特有的危险重构模式。
 */
const DANGEROUS_REFRAMING_PATTERNS: DetectionPattern[] = [
  { category: 'dangerous_reframing', weight: 0.85, pattern: /(?:data\s+)?exfiltration.*(?:as|is)\s+(?:backup|archiv|sync|export)/i },
  { category: 'dangerous_reframing', weight: 0.85, pattern: /(?:disable|bypass|turn\s+off)\s+security.*(?:efficient|best\s+practice|optimization)/i },
  { category: 'dangerous_reframing', weight: 0.8, pattern: /(?:temporarily|just\s+for\s+now|quick)\s+(?:disable|skip|ignore|bypass)\s+(?:auth|security|validation|checks?)/i },
  { category: 'dangerous_reframing', weight: 0.8, pattern: /(?:workaround|hack|trick)\s+(?:for|to)\s+(?:bypass|skip|avoid|disable)/i },
  { category: 'dangerous_reframing', weight: 0.85, pattern: /(?:store|save|persist)\s+(?:credentials?|secrets?|passwords?)\s+(?:in\s+)?(?:plain\s*text|plaintext|clear\s*text|memory)/i },
  { category: 'dangerous_reframing', weight: 0.8, pattern: /(?:it\s+is\s+)?(?:safe|ok|fine)\s+to\s+(?:ignore|skip|disable|bypass)\s+(?:validation|checks?|security|auth)/i },
];

/**
 * 不安全"最佳实践"模式 — 反思中编码不安全模式为"最佳实践"。
 */
const INSECURE_BEST_PRACTICE_PATTERNS: DetectionPattern[] = [
  { category: 'insecure_best_practice', weight: 0.8, pattern: /(?:best\s+practice|recommend|always|should)\s+(?:disable|skip|ignore|bypass)\s+(?:auth|validation|security|checks?|sandbox)/i },
  { category: 'insecure_best_practice', weight: 0.75, pattern: /(?:lesson|takeaway|learned)[:\s]+(?:always\s+)?(?:disable|skip|ignore|bypass|store\s+plaintext)/i },
  { category: 'insecure_best_practice', weight: 0.8, pattern: /(?:lower|reduce|relax|decrease)\s+(?:security|safety|validation)\s+(?:threshold|level|strictness|requirements?)/i },
  { category: 'insecure_best_practice', weight: 0.75, pattern: /(?:no\s+need|unnecessary|overkill)\s+to\s+(?:validate|check|sanitize|verify|authenticate)/i },
  { category: 'insecure_best_practice', weight: 0.7, pattern: /(?:trust|allow|permit)\s+(?:all|any)\s+(?:input|tool|command|request|memory)/i },
];

/**
 * HTML/CSS 隐藏内容模式 — 利用样式隐藏恶意指令。
 */
const HIDDEN_HTML_PATTERNS: DetectionPattern[] = [
  { category: 'hidden_html', weight: 0.85, pattern: /display\s*:\s*none/i },
  { category: 'hidden_html', weight: 0.8, pattern: /visibility\s*:\s*hidden/i },
  { category: 'hidden_html', weight: 0.8, pattern: /font-size\s*:\s*0(px|pt|em|rem)?/i },
  { category: 'hidden_html', weight: 0.8, pattern: /opacity\s*:\s*0(\.\d+)?/i },
  { category: 'hidden_html', weight: 0.85, pattern: /color\s*:\s*(#fff|#ffffff|white|transparent)\b/i },
  { category: 'hidden_html', weight: 0.8, pattern: /position\s*:\s*absolute[;\s][^>]*(left|top)\s*:\s*-\d+/i },
  { category: 'hidden_html', weight: 0.75, pattern: /<[^>]+(?:hidden|aria-hidden="true")[^>]*>/i },
  { category: 'hidden_html', weight: 0.7, pattern: /<script[^>]*>|<iframe[^>]*>/i },
  { category: 'hidden_html', weight: 0.75, pattern: /text-indent\s*:\s*-\d{4,}/i },
];

/**
 * 汇总所有写入阶段检测模式。
 */
const ALL_WRITE_PATTERNS: DetectionPattern[] = [
  ...INSTRUCTION_OVERRIDE_PATTERNS,
  ...SYSTEM_PROMPT_MANIPULATION_PATTERNS,
  ...DATA_EXFILTRATION_PATTERNS,
  ...PRIVILEGE_ESCALATION_PATTERNS,
  ...HIDDEN_HTML_PATTERNS,
];

/**
 * 汇总摘要/反思场景检测模式。
 */
const SUMMARY_REFLECTION_PATTERNS: DetectionPattern[] = [
  ...DANGEROUS_REFRAMING_PATTERNS,
  ...INSECURE_BEST_PRACTICE_PATTERNS,
  ...INSTRUCTION_OVERRIDE_PATTERNS,
  ...DATA_EXFILTRATION_PATTERNS,
  ...PRIVILEGE_ESCALATION_PATTERNS,
  ...SYSTEM_PROMPT_MANIPULATION_PATTERNS,
];

// ============================================================================
// 常量
// ============================================================================

/** 数据源可信度分值。 */
const SOURCE_CREDIBILITY_SCORE: Record<SourceCredibility, number> = {
  verified_tool: 0.9,
  agent_generated: 0.7,
  user_input: 0.5,
  web_content: 0.3,
  unknown: 0.1,
};

/** 已知安全事实 — 用于检测与安全常识相矛盾的内容。 */
const KNOWN_SAFE_FACTS: Array<{ fact: RegExp; description: string }> = [
  { fact: /(?:it\s+is\s+)?(?:safe|ok|fine)\s+to\s+(?:store|save|keep)\s+(?:passwords?|secrets?|credentials?)\s+in\s+(?:plain\s*text|plaintext|memory|code)/i, description: '明文存储凭证不是安全的' },
  { fact: /(?:always\s+)?(?:disable|turn\s+off)\s+(?:authentication|auth|authorization)\s+(?:in\s+)?(?:production|prod)/i, description: '在生产环境禁用认证不安全' },
  { fact: /(?:it\s+is\s+)?(?:safe|ok)\s+to\s+(?:run|execute)\s+untrusted\s+(?:code|commands?|scripts?)/i, description: '执行不可信代码不安全' },
  { fact: /(?:no\s+)?need\s+to\s+(?:validate|sanitize|escape|check)\s+(?:user\s+)?input/i, description: '必须验证用户输入' },
];

/** Unicode 隐藏字符码点范围。 */
const HIDDEN_UNICODE_RANGES: Array<{ start: number; end: number; name: string }> = [
  { start: 0x200b, end: 0x200f, name: '零宽字符/方向标记' },
  { start: 0x202a, end: 0x202e, name: '双向控制字符 (RTL/LTR override)' },
  { start: 0x2060, end: 0x2064, name: '不可见连接符/不可见数学运算符' },
  { start: 0x2066, end: 0x2069, name: '双向隔离字符' },
  { start: 0xfeff, end: 0xfeff, name: 'BOM / 零宽不换行空格' },
  { start: 0x00ad, end: 0x00ad, name: '软连字符' },
];

/** Base64 字符串最小长度阈值。 */
const BASE64_MIN_LENGTH = 40;

/** 熵分析触发阈值 (Shannon entropy)。 */
const ENTROPY_THRESHOLD = 4.5;

/** 检测到的模式数量额外加成 (每多一个匹配 +0.05)。 */
const MULTI_MATCH_BOOST = 0.05;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 计算字符串的 Shannon 熵。用于检测混淆/编码载荷。
 */
function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * 检测内容中的隐藏 Unicode 字符。
 * 返回检测到的字符数量与样本描述。
 */
function detectHiddenUnicode(content: string): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const ch of content) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    for (const range of HIDDEN_UNICODE_RANGES) {
      if (code >= range.start && code <= range.end) {
        count++;
        if (samples.length < 5) {
          samples.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')} (${range.name})`);
        }
        break;
      }
    }
  }
  return { count, samples };
}

/**
 * 检测 Base64 编码的载荷。
 * 提取疑似 Base64 的长字符串段，尝试解码并检查是否含有可疑关键词。
 */
function detectBase64Payload(content: string): { detected: boolean; samples: string[] } {
  const samples: string[] = [];
  // 匹配连续的 Base64 字符序列
  const base64Regex = /[A-Za-z0-9+/]{40,}={0,2}/g;
  const suspiciousKeywords = [
    /ignore\s+previous/i, /system\s*prompt/i, /exec|eval|import/i,
    /curl|wget|http/i, /token|secret|key|password/i, /rm\s+-rf/i,
    /script/i, /sudo/i,
  ];
  let detected = false;
  let match: RegExpExecArray | null;
  while ((match = base64Regex.exec(content)) !== null) {
    const segment = match[0];
    if (segment.length < BASE64_MIN_LENGTH) continue;
    try {
      const decoded = Buffer.from(segment, 'base64').toString('utf-8');
      if (suspiciousKeywords.some((kw) => kw.test(decoded))) {
        detected = true;
        if (samples.length < 3) {
          samples.push(decoded.slice(0, 60));
        }
      }
    } catch {
      // 解码失败 — 忽略该段
    }
  }
  return { detected, samples };
}

/**
 * 从内容中清洗已检测到的恶意模式，返回净化后的版本。
 * 将匹配到的片段替换为占位标记。
 */
function sanitizeContent(content: string, patterns: DetectionPattern[]): string {
  let sanitized = content;
  for (const { pattern } of patterns) {
    sanitized = sanitized.replace(pattern, '[SANITIZED]');
  }
  // 清洗隐藏 Unicode 字符
  sanitized = sanitized.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g, '');
  // 清洗隐藏 HTML 样式
  sanitized = sanitized.replace(/\b(?:display|visibility|font-size|opacity|text-indent)\s*:\s*[^;}>]+/gi, '[SANITIZED-STYLE]');
  return sanitized;
}

/**
 * 计算两个字符串之间的简单语义相似度 (基于 Jaccard 词集重叠)。
 * 用于摘要与源内容的一致性校验。
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = s.toLowerCase().match(/[a-z0-9_]{2,}/g);
    return new Set(tokens ?? []);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 根据风险分推导严重程度。
 */
function severityFromRisk(risk: number): PoisoningSeverity {
  if (risk >= 0.7) return 'critical';
  if (risk >= 0.5) return 'high';
  if (risk >= 0.3) return 'medium';
  return 'low';
}

/**
 * 生成唯一污染追踪 ID。
 */
function generateTaintId(): string {
  return `taint_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ============================================================================
// 隔离区条目类型 (内部)
// ============================================================================

interface QuarantineEntry {
  content: string;
  source: string;
  agentId: string;
  sessionId: string;
  reason: string;
  poisoningType: PoisoningType;
  riskScore: number;
  quarantinedAt: string;
  memoryType: string;
}

// ============================================================================
// MemoryPoisoningDefenseEngine
// ============================================================================

/**
 * 记忆投毒防御引擎。
 *
 * 提供针对全部 5 类记忆投毒攻击的检测、拦截、隔离与跨会话污染追踪能力。
 * 通过 createTenantAwareSingleton 实现租户隔离的进程内单例。
 */
export class MemoryPoisoningDefenseEngine {
  private config: MemoryPoisoningDefenseConfig;

  /** 每个代理的写入速率追踪: agentId -> { count, windowStart } */
  private readonly writeRateTracker: Map<string, { count: number; windowStart: number }> = new Map();

  /** 污染追踪图: taintId -> TaintEntry */
  private readonly taintGraph: Map<string, TaintEntry> = new Map();

  /** memoryId -> 关联的 taintId 集合 (用于快速查询与传播) */
  private readonly memoryToTaints: Map<string, Set<string>> = new Map();

  /** 隔离区: 存储被拦截的内容供人工复核 */
  private readonly quarantineZone: QuarantineEntry[] = [];

  /** 已知"中毒反思模式"注册表 — 用于检测变体 */
  private poisonedReflectionPatterns: Array<{ signature: RegExp; description: string }> = [];

  constructor(config?: Partial<MemoryPoisoningDefenseConfig>) {
    this.config = {
      enabled: true,
      maxWritesPerMinute: 30,
      enableEntropyAnalysis: true,
      enableUnicodeDetection: true,
      enableBase64Detection: true,
      enableTaintTracking: true,
      quarantineEnabled: true,
      maxQuarantineSize: 1000,
      taintedMemoryTtlMs: 0,
      strictMode: false,
      ...config,
    };
  }

  // ── 配置管理 ──────────────────────────────────────────────────────

  /** 更新引擎配置 (合并传入字段)。 */
  updateConfig(partial: Partial<MemoryPoisoningDefenseConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** 获取当前配置。 */
  getConfig(): Readonly<MemoryPoisoningDefenseConfig> {
    return { ...this.config };
  }

  // ── 1. 写入投毒防御 ──────────────────────────────────────────────

  /**
   * 写入前校验 — 在任何记忆写入操作之前调用。
   *
   * 执行以下检测:
   *   - 增强的注入模式检测 (指令覆盖/系统提示词操纵/数据外泄/权限提升/隐藏HTML)
   *   - 隐藏 Unicode 字符检测
   *   - Base64 编码载荷检测
   *   - 内容熵分析 (检测混淆载荷)
   *   - 数据源可信度评分
   *   - 每代理写入速率限制
   *
   * 风险分聚合: 每个匹配模式的 weight × (1 − sourceCredibility) 取最大值，
   * 多模式匹配时按 MULTI_MATCH_BOOST 叠加，封顶 1.0。
   *
   * @param context - 记忆写入上下文
   * @returns 防御校验结果
   */
  validateMemoryWrite(context: MemoryWriteContext): DefenseResult {
    if (!this.config.enabled) {
      return {
        allowed: true,
        reason: '引擎已禁用，放行写入',
        severity: 'low',
        riskScore: 0,
        quarantined: false,
      };
    }

    try {
      const { content, source, agentId, sourceCredibility, sessionId, memoryType } = context;
      const credibilityScore = SOURCE_CREDIBILITY_SCORE[sourceCredibility] ?? 0.1;
      const contributions: number[] = [];
      const matchedCategories: string[] = [];

      // 1a. 注入模式检测
      for (const { pattern, category, weight } of ALL_WRITE_PATTERNS) {
        if (pattern.test(content)) {
          const contribution = weight * (1 - credibilityScore);
          contributions.push(contribution);
          if (!matchedCategories.includes(category)) {
            matchedCategories.push(category);
          }
        }
      }

      // 1b. 隐藏 Unicode 字符检测
      if (this.config.enableUnicodeDetection) {
        const { count, samples } = detectHiddenUnicode(content);
        if (count > 0) {
          // 隐藏字符本身权重 0.7，乘以 (1 − 可信度)
          contributions.push(0.7 * (1 - credibilityScore));
          matchedCategories.push(`hidden_unicode (${count} 个: ${samples.join(', ')})`);
        }
      }

      // 1c. Base64 载荷检测
      if (this.config.enableBase64Detection) {
        const b64 = detectBase64Payload(content);
        if (b64.detected) {
          contributions.push(0.75 * (1 - credibilityScore));
          matchedCategories.push(`base64_payload (${b64.samples.length} 段)`);
        }
      }

      // 1d. 内容熵分析
      if (this.config.enableEntropyAnalysis) {
        const entropy = shannonEntropy(content);
        if (entropy > ENTROPY_THRESHOLD && content.length > 80) {
          // 熵越高越可疑，线性映射 4.5→0.3, 6.0→0.6
          const entropyWeight = Math.min(0.6, 0.1 * (entropy - ENTROPY_THRESHOLD) + 0.3);
          contributions.push(entropyWeight * (1 - credibilityScore));
          matchedCategories.push(`high_entropy (${entropy.toFixed(2)})`);
        }
      }

      // 1e. 写入速率限制
      const rateViolation = this.checkWriteRate(agentId);
      if (rateViolation) {
        contributions.push(0.8);
        matchedCategories.push('write_rate_limit_exceeded');
      }

      // 1f. 已知安全事实矛盾检测
      for (const { fact, description } of KNOWN_SAFE_FACTS) {
        if (fact.test(content)) {
          contributions.push(0.85 * (1 - credibilityScore));
          matchedCategories.push(`contradicts_safe_fact (${description})`);
        }
      }

      // 聚合风险分
      let riskScore = 0;
      if (contributions.length > 0) {
        const maxContribution = Math.max(...contributions);
        riskScore = Math.min(1, maxContribution + (contributions.length - 1) * MULTI_MATCH_BOOST);
      }

      const severity = severityFromRisk(riskScore);

      // 决策逻辑
      const shouldBlock = this.config.strictMode
        ? riskScore >= 0.3
        : riskScore >= 0.7;
      const shouldQuarantine = !shouldBlock && riskScore >= 0.4 && this.config.quarantineEnabled;

      // 跨会话污染检查 — 检查 source 是否已被标记为污染源
      const sourceTaintId = this.findTaintByMemoryId(source);
      if (sourceTaintId && this.config.enableTaintTracking) {
        // 如果写入来源已被污染，新写入内容继承污染
        riskScore = Math.max(riskScore, 0.6);
        matchedCategories.push('inherited_taint');
      }

      if (shouldBlock) {
        const reason = `写入被拦截: 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(content, source, agentId, sessionId, reason, 'write', riskScore, memoryType);
        this.logSecurityEvent('write', severity, agentId, sessionId, reason, {
          source,
          riskScore,
          matchedCategories,
          memoryType,
        });
        this.recordMetrics('blocked_writes', 'write', 1);

        let taintId: string | undefined;
        if (this.config.enableTaintTracking) {
          taintId = this.registerTaint(source, content, agentId, sessionId, 'write', sourceTaintId);
        }

        return {
          allowed: false,
          reason,
          poisoningType: 'write',
          severity,
          riskScore,
          quarantined: this.config.quarantineEnabled,
          taintId,
        };
      }

      if (shouldQuarantine) {
        const reason = `写入已隔离 (待复核): 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(content, source, agentId, sessionId, reason, 'write', riskScore, memoryType);
        this.logSecurityEvent('write', severity, agentId, sessionId, reason, {
          source,
          riskScore,
          matchedCategories,
          memoryType,
        });
        this.recordMetrics('quarantined_entries', 'write', 1);

        const sanitized = sanitizeContent(content, ALL_WRITE_PATTERNS);
        return {
          allowed: true,
          reason,
          poisoningType: 'write',
          severity,
          riskScore,
          sanitizedContent: sanitized,
          quarantined: true,
        };
      }

      // 低风险放行
      if (riskScore >= 0.2) {
        this.logSecurityEvent('write', severity, agentId, sessionId, '写入放行 (低风险告警)', {
          source,
          riskScore,
          matchedCategories,
        });
      }

      return {
        allowed: true,
        reason: matchedCategories.length > 0
          ? `放行 (检测到低风险模式: ${matchedCategories.join('; ')})`
          : '通过全部检测',
        poisoningType: riskScore > 0 ? 'write' : undefined,
        severity,
        riskScore,
        quarantined: false,
      };
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.validateMemoryWrite');
      // 安全失败: 拦截写入
      return {
        allowed: false,
        reason: '校验过程发生内部错误，写入已被安全拦截',
        poisoningType: 'write',
        severity: 'high',
        riskScore: 1,
        quarantined: false,
      };
    }
  }

  // ── 2. 检索投毒防御 ──────────────────────────────────────────────

  /**
   * 检索后校验 — 在 RAG 检索完成后、注入 LLM 上下文之前调用。
   *
   * 对每条检索到的记忆执行:
   *   - 注入模式复查 (可能绕过写入校验的载荷)
   *   - 与查询的语义一致性 (检测无关内容中潜在的注入)
   *   - 检索时数据源可信度复核 (源可能事后被识别为恶意)
   *   - 与已知安全事实的矛盾检测
   *
   * 可疑条目被隔离，安全条目返回供注入。
   *
   * @param entries - 检索到的记忆条目列表
   * @param query   - 触发检索的原始查询
   * @param agentId - 执行检索的代理 ID
   * @returns 包含安全条目与隔离条目的校验结果
   */
  validateRetrievedMemories(
    entries: RetrievedMemoryEntry[],
    query: string,
    agentId: string,
  ): RetrievalValidationResult {
    if (!this.config.enabled) {
      return { safeEntries: entries, quarantinedEntries: [], sanitized: false };
    }

    const safeEntries: RetrievedMemoryEntry[] = [];
    const quarantinedEntries: Array<{ entry: RetrievedMemoryEntry; reason: string }> = [];
    let sanitized = false;

    try {
      for (const entry of entries) {
        let isSafe = true;
        let reason = '';
        const credibilityScore = SOURCE_CREDIBILITY_SCORE[entry.sourceCredibility] ?? 0.1;

        // 2a. 注入模式复查
        for (const { pattern, category, weight } of ALL_WRITE_PATTERNS) {
          if (pattern.test(entry.content)) {
            const contribution = weight * (1 - credibilityScore);
            if (contribution >= 0.35) {
              isSafe = false;
              reason = `检索拦截: 检测到 ${category} 模式 (贡献 ${contribution.toFixed(2)})`;
              break;
            }
            sanitized = true;
          }
        }

        // 2b. 已知安全事实矛盾
        if (isSafe) {
          for (const { fact, description } of KNOWN_SAFE_FACTS) {
            if (fact.test(entry.content)) {
              isSafe = false;
              reason = `检索拦截: 内容与已知安全事实矛盾 (${description})`;
              break;
            }
          }
        }

        // 2c. 语义一致性 — 与查询无关的高风险内容
        if (isSafe && query.length > 0) {
          const similarity = jaccardSimilarity(entry.content, query);
          if (similarity < 0.02 && entry.content.length > 200) {
            // 极低相关性的长内容可能是注入
            const hasRiskySource = entry.sourceCredibility === 'web_content' || entry.sourceCredibility === 'unknown';
            if (hasRiskySource) {
              isSafe = false;
              reason = `检索拦截: 与查询语义无关且来源可信度低 (相似度 ${similarity.toFixed(3)})`;
            }
          }
        }

        // 2d. 跨会话污染传播检查
        if (isSafe && this.config.enableTaintTracking) {
          const taintId = this.findTaintByMemoryId(entry.id);
          if (taintId) {
            isSafe = false;
            reason = `检索拦截: 记忆条目已被标记为污染 (taintId: ${taintId})`;
          }
        }

        // 2e. 检索时数据源可信度复核 — web_content/unknown 额外审查
        if (isSafe && (entry.sourceCredibility === 'web_content' || entry.sourceCredibility === 'unknown')) {
          const b64 = this.config.enableBase64Detection ? detectBase64Payload(entry.content) : { detected: false };
          const unicode = this.config.enableUnicodeDetection ? detectHiddenUnicode(entry.content) : { count: 0 };
          if (b64.detected || unicode.count > 0) {
            isSafe = false;
            reason = `检索拦截: 低可信度来源包含隐藏内容 (base64:${b64.detected}, unicode:${unicode.count})`;
          }
        }

        if (isSafe) {
          // 对低风险模式进行净化
          if (sanitized) {
            const cleanContent = sanitizeContent(entry.content, ALL_WRITE_PATTERNS);
            safeEntries.push({ ...entry, content: cleanContent });
          } else {
            safeEntries.push(entry);
          }
        } else {
          quarantinedEntries.push({ entry, reason });
          this.addToQuarantine(
            entry.content,
            entry.source,
            agentId,
            '',
            reason,
            'retrieval',
            0.6,
            entry.memoryType,
          );
          this.logSecurityEvent('retrieval', 'high', agentId, '', reason, {
            entryId: entry.id,
            source: entry.source,
            query,
          });
          this.recordMetrics('retrieval_blocks', 'retrieval', 1);
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.validateRetrievedMemories');
    }

    return { safeEntries, quarantinedEntries, sanitized };
  }

  // ── 3. 摘要投毒防御 ──────────────────────────────────────────────

  /**
   * 摘要前校验 — 在存储 Agent 交互摘要之前调用。
   *
   * 检测:
   *   - 危险行为被重构为"高效实践"
   *   - 临时变通被写成"通用规则"
   *   - 安全相关上下文在摘要中被丢弃 (与源内容一致性过低)
   *   - 恶意重构 (如 "data exfiltration" → "data backup")
   *   - 摘要与源内容的语义一致性
   *
   * @param summary       - 待存储的摘要内容
   * @param sourceContent - 摘要所基于的原始交互内容
   * @param agentId       - 生成摘要的代理 ID
   * @param sessionId     - 会话 ID
   * @returns 防御校验结果
   */
  validateSummary(
    summary: string,
    sourceContent: string,
    agentId: string,
    sessionId: string,
  ): DefenseResult {
    if (!this.config.enabled) {
      return { allowed: true, reason: '引擎已禁用', severity: 'low', riskScore: 0, quarantined: false };
    }

    try {
      const contributions: number[] = [];
      const matchedCategories: string[] = [];

      // 3a. 危险重构模式检测
      for (const { pattern, category, weight } of SUMMARY_REFLECTION_PATTERNS) {
        if (pattern.test(summary)) {
          contributions.push(weight);
          if (!matchedCategories.includes(category)) {
            matchedCategories.push(category);
          }
        }
      }

      // 3b. 语义一致性 — 摘要应与源内容有合理重叠
      const similarity = jaccardSimilarity(summary, sourceContent);
      if (similarity < 0.05 && summary.length > 50 && sourceContent.length > 50) {
        // 摘要与源内容几乎无重叠 — 可能丢失关键上下文或被篡改
        contributions.push(0.6);
        matchedCategories.push(`low_semantic_consistency (${similarity.toFixed(3)})`);
      }

      // 3c. 安全相关上下文丢失检测
      const securityKeywords = /security|auth|permission|credential|secret|password|encrypt|sandbox|validation|sanitize|guardrail/i;
      const sourceHasSecurity = securityKeywords.test(sourceContent);
      const summaryHasSecurity = securityKeywords.test(summary);
      if (sourceHasSecurity && !summaryHasSecurity) {
        contributions.push(0.55);
        matchedCategories.push('security_context_dropped');
      }

      // 聚合
      let riskScore = 0;
      if (contributions.length > 0) {
        const maxContribution = Math.max(...contributions);
        riskScore = Math.min(1, maxContribution + (contributions.length - 1) * MULTI_MATCH_BOOST);
      }

      const severity = severityFromRisk(riskScore);
      const shouldBlock = this.config.strictMode ? riskScore >= 0.3 : riskScore >= 0.7;
      const shouldQuarantine = !shouldBlock && riskScore >= 0.4 && this.config.quarantineEnabled;

      if (shouldBlock) {
        const reason = `摘要被拦截: 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(summary, 'summary', agentId, sessionId, reason, 'summary', riskScore, 'summary');
        this.logSecurityEvent('summary', severity, agentId, sessionId, reason, { riskScore, matchedCategories });
        this.recordMetrics('blocked_writes', 'summary', 1);
        return {
          allowed: false,
          reason,
          poisoningType: 'summary',
          severity,
          riskScore,
          quarantined: this.config.quarantineEnabled,
        };
      }

      if (shouldQuarantine) {
        const reason = `摘要已隔离 (待复核): 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(summary, 'summary', agentId, sessionId, reason, 'summary', riskScore, 'summary');
        this.logSecurityEvent('summary', severity, agentId, sessionId, reason, { riskScore, matchedCategories });
        this.recordMetrics('quarantined_entries', 'summary', 1);
        const sanitized = sanitizeContent(summary, SUMMARY_REFLECTION_PATTERNS);
        return {
          allowed: true,
          reason,
          poisoningType: 'summary',
          severity,
          riskScore,
          sanitizedContent: sanitized,
          quarantined: true,
        };
      }

      return {
        allowed: true,
        reason: matchedCategories.length > 0
          ? `摘要放行 (低风险: ${matchedCategories.join('; ')})`
          : '摘要通过全部检测',
        poisoningType: riskScore > 0 ? 'summary' : undefined,
        severity,
        riskScore,
        quarantined: false,
      };
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.validateSummary');
      return {
        allowed: false,
        reason: '摘要校验发生内部错误，已安全拦截',
        poisoningType: 'summary',
        severity: 'high',
        riskScore: 1,
        quarantined: false,
      };
    }
  }

  // ── 4. 反思投毒防御 ──────────────────────────────────────────────

  /**
   * 反思前校验 — 在存储 Agent 生成的反思/教训之前调用。
   *
   * 检测:
   *   - 自我强化的错误循环 (反思在验证已被攻破的行为)
   *   - 将不安全模式编码为"最佳实践"的教训
   *   - 降低未来动作安全阈值的反思
   *   - 建立恶意行为为先例的循环推理
   *   - 与已注册"中毒反思模式"的变体匹配
   *
   * @param reflection    - 待存储的反思/教训内容
   * @param sourceContent - 反思所基于的原始交互内容
   * @param agentId       - 生成反思的代理 ID
   * @param sessionId     - 会话 ID
   * @returns 防御校验结果
   */
  validateReflection(
    reflection: string,
    sourceContent: string,
    agentId: string,
    sessionId: string,
  ): DefenseResult {
    if (!this.config.enabled) {
      return { allowed: true, reason: '引擎已禁用', severity: 'low', riskScore: 0, quarantined: false };
    }

    try {
      const contributions: number[] = [];
      const matchedCategories: string[] = [];

      // 4a. 不安全最佳实践 / 危险重构模式检测
      for (const { pattern, category, weight } of SUMMARY_REFLECTION_PATTERNS) {
        if (pattern.test(reflection)) {
          contributions.push(weight);
          if (!matchedCategories.includes(category)) {
            matchedCategories.push(category);
          }
        }
      }

      // 4b. 已注册"中毒反思模式"变体匹配
      for (const { signature, description } of this.poisonedReflectionPatterns) {
        if (signature.test(reflection)) {
          contributions.push(0.85);
          matchedCategories.push(`registered_poisoned_pattern (${description})`);
        }
      }

      // 4c. 循环推理检测 — 反思中引用自身或先前反思作为依据
      const circularReasoning = /(?:as\s+(?:we\s+|i\s+)?(?:learned|noted|decided|concluded)\s+(?:earlier|before|previously)|(?:per|based\s+on)\s+(?:our|my)\s+(?:previous\s+)?reflection)/i;
      if (circularReasoning.test(reflection)) {
        // 检查是否伴随降低安全阈值的语言
        const lowersSecurity = /(?:lower|reduce|relax|decrease|skip|disable|bypass)/i.test(reflection);
        if (lowersSecurity) {
          contributions.push(0.8);
          matchedCategories.push('circular_reasoning_lowers_security');
        }
      }

      // 4d. 自我强化错误循环 — 反思验证危险动作
      const selfReinforcing = /(?:this\s+(?:worked|succeeded|was\s+effective)|good\s+approach|will\s+repeat|should\s+always\s+do)/i;
      const referencesDanger = /(?:disable|bypass|skip|ignore|plaintext|untrusted|no\s+auth)/i;
      if (selfReinforcing.test(reflection) && referencesDanger.test(reflection)) {
        contributions.push(0.85);
        matchedCategories.push('self_reinforcing_dangerous_action');
      }

      // 4e. 与源内容语义一致性
      const similarity = jaccardSimilarity(reflection, sourceContent);
      if (similarity < 0.03 && reflection.length > 50 && sourceContent.length > 50) {
        contributions.push(0.5);
        matchedCategories.push(`low_source_consistency (${similarity.toFixed(3)})`);
      }

      // 聚合
      let riskScore = 0;
      if (contributions.length > 0) {
        const maxContribution = Math.max(...contributions);
        riskScore = Math.min(1, maxContribution + (contributions.length - 1) * MULTI_MATCH_BOOST);
      }

      const severity = severityFromRisk(riskScore);
      const shouldBlock = this.config.strictMode ? riskScore >= 0.3 : riskScore >= 0.7;
      const shouldQuarantine = !shouldBlock && riskScore >= 0.4 && this.config.quarantineEnabled;

      // 如果反思被判定为中毒，将其签名注册以便检测未来变体
      if (riskScore >= 0.5 && this.config.enableTaintTracking) {
        this.registerPoisonedReflectionPattern(reflection);
      }

      if (shouldBlock) {
        const reason = `反思被拦截: 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(reflection, 'reflection', agentId, sessionId, reason, 'reflection', riskScore, 'reflection');
        this.logSecurityEvent('reflection', severity, agentId, sessionId, reason, { riskScore, matchedCategories });
        this.recordMetrics('blocked_writes', 'reflection', 1);

        let taintId: string | undefined;
        if (this.config.enableTaintTracking) {
          taintId = this.registerTaint('reflection', reflection, agentId, sessionId, 'reflection', undefined);
        }

        return {
          allowed: false,
          reason,
          poisoningType: 'reflection',
          severity,
          riskScore,
          quarantined: this.config.quarantineEnabled,
          taintId,
        };
      }

      if (shouldQuarantine) {
        const reason = `反思已隔离 (待复核): 检测到 ${matchedCategories.join('; ')}`;
        this.addToQuarantine(reflection, 'reflection', agentId, sessionId, reason, 'reflection', riskScore, 'reflection');
        this.logSecurityEvent('reflection', severity, agentId, sessionId, reason, { riskScore, matchedCategories });
        this.recordMetrics('quarantined_entries', 'reflection', 1);
        const sanitized = sanitizeContent(reflection, SUMMARY_REFLECTION_PATTERNS);
        return {
          allowed: true,
          reason,
          poisoningType: 'reflection',
          severity,
          riskScore,
          sanitizedContent: sanitized,
          quarantined: true,
        };
      }

      return {
        allowed: true,
        reason: matchedCategories.length > 0
          ? `反思放行 (低风险: ${matchedCategories.join('; ')})`
          : '反思通过全部检测',
        poisoningType: riskScore > 0 ? 'reflection' : undefined,
        severity,
        riskScore,
        quarantined: false,
      };
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.validateReflection');
      return {
        allowed: false,
        reason: '反思校验发生内部错误，已安全拦截',
        poisoningType: 'reflection',
        severity: 'high',
        riskScore: 1,
        quarantined: false,
      };
    }
  }

  // ── 5. 跨会话持久化防御 ─────────────────────────────────────────

  /**
   * 跨会话污染检查 — 在检索到的记忆被用于生成新记忆时调用。
   *
   * 追踪被标记为可疑的内容在跨会话场景下的传播:
   *   - 如果被污染记忆参与了新记忆的生成，新记忆继承污染标记
   *   - 维护污染传播图 (父→子)
   *   - 检测来自先前会话的污染内容被检索和使用
   *
   * @param memoryId  - 被检索/使用的记忆 ID
   * @param content   - 记忆内容
   * @param source    - 记忆来源
   * @param agentId   - 使用该记忆的代理 ID
   * @param sessionId - 当前会话 ID
   * @returns 防御校验结果
   */
  checkCrossSessionTaint(
    memoryId: string,
    content: string,
    source: string,
    agentId: string,
    sessionId: string,
  ): DefenseResult {
    if (!this.config.enabled || !this.config.enableTaintTracking) {
      return { allowed: true, reason: '污染追踪已禁用', severity: 'low', riskScore: 0, quarantined: false };
    }

    try {
      // 先清理过期污染 (如果配置了 TTL)
      if (this.config.taintedMemoryTtlMs > 0) {
        this.evictExpiredTaints();
      }

      // 检查该记忆 ID 是否已存在于污染图中
      const existingTaintId = this.findTaintByMemoryId(memoryId);
      if (existingTaintId) {
        const taintEntry = this.taintGraph.get(existingTaintId);
        const reason = `跨会话污染: 记忆 ${memoryId} 已被标记为污染 (类型: ${taintEntry?.poisoningType ?? 'unknown'}, 检测于 ${taintEntry?.detectedAt ?? '未知'})`;
        this.logSecurityEvent('cross_session', 'critical', agentId, sessionId, reason, {
          memoryId,
          taintId: existingTaintId,
          source,
        });
        this.recordMetrics('retrieval_blocks', 'cross_session', 1);

        return {
          allowed: false,
          reason,
          poisoningType: 'cross_session',
          severity: 'critical',
          riskScore: 0.9,
          quarantined: true,
          taintId: existingTaintId,
        };
      }

      // 检查内容是否匹配已有污染条目 (内容指纹)
      const contentFingerprint = this.hashContent(content);
      for (const [, entry] of this.taintGraph) {
        if (this.hashContent(entry.content) === contentFingerprint) {
          // 内容与已污染内容匹配 — 注册为新污染 (传播)
          const propagatedTaintId = this.registerTaint(
            memoryId,
            content,
            agentId,
            sessionId,
            'cross_session',
            entry.taintId,
          );
          const reason = `跨会话污染: 记忆内容与已污染条目匹配 (传播自 ${entry.taintId})`;
          this.logSecurityEvent('cross_session', 'critical', agentId, sessionId, reason, {
            memoryId,
            taintId: propagatedTaintId,
            parentTaint: entry.taintId,
          });
          this.recordMetrics('tainted_memories', 'cross_session', 1);

          return {
            allowed: false,
            reason,
            poisoningType: 'cross_session',
            severity: 'critical',
            riskScore: 0.85,
            quarantined: true,
            taintId: propagatedTaintId,
          };
        }
      }

      // 未检测到污染
      return {
        allowed: true,
        reason: '跨会话污染检查通过',
        severity: 'low',
        riskScore: 0,
        quarantined: false,
      };
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.checkCrossSessionTaint');
      return {
        allowed: true,
        reason: '跨会话检查发生内部错误，保守放行',
        poisoningType: 'cross_session',
        severity: 'medium',
        riskScore: 0.5,
        quarantined: false,
      };
    }
  }

  /**
   * 标记一条记忆为污染 (供写入/反思等阶段内部调用，也可外部手动标记)。
   *
   * @param memoryId       - 被污染的记忆 ID
   * @param content        - 记忆内容
   * @param agentId        - 代理 ID
   * @param sessionId      - 会话 ID
   * @param poisoningType  - 投毒类型
   * @param propagatedFrom - 父污染 ID (传播场景)
   * @returns 新分配的 taintId
   */
  markMemoryAsTainted(
    memoryId: string,
    content: string,
    source: string,
    agentId: string,
    sessionId: string,
    poisoningType: PoisoningType,
    propagatedFrom?: string,
  ): string {
    return this.registerTaint(memoryId, content, agentId, sessionId, poisoningType, propagatedFrom, source);
  }

  // ── 污染报告与清理 ──────────────────────────────────────────────

  /**
   * 获取污染追踪报告 — 展示所有被污染的记忆条目及其传播链。
   */
  getTaintReport(): TaintReport {
    const byType: Record<PoisoningType, number> = {
      write: 0,
      retrieval: 0,
      summary: 0,
      reflection: 0,
      cross_session: 0,
    };

    const taintChain: TaintEntry[] = [];
    let oldest: number | undefined;
    let newest: number | undefined;

    for (const entry of this.taintGraph.values()) {
      byType[entry.poisoningType]++;
      taintChain.push(entry);
      const ts = Date.parse(entry.detectedAt);
      if (!isNaN(ts)) {
        if (oldest === undefined || ts < oldest) oldest = ts;
        if (newest === undefined || ts > newest) newest = ts;
      }
    }

    // 按检测时间排序
    taintChain.sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));

    return {
      totalTainted: this.taintGraph.size,
      byType,
      taintChain,
      oldestTaint: oldest !== undefined ? new Date(oldest).toISOString() : undefined,
      newestTaint: newest !== undefined ? new Date(newest).toISOString() : undefined,
    };
  }

  /**
   * 手动清除某条记忆的污染标记 (用于清除误报)。
   *
   * @param memoryId - 要清除污染标记的记忆 ID
   * @returns 是否成功清除 (false = 未找到该记忆的污染记录)
   */
  clearTaint(memoryId: string): boolean {
    const taintIds = this.memoryToTaints.get(memoryId);
    if (!taintIds || taintIds.size === 0) {
      return false;
    }

    for (const taintId of taintIds) {
      this.taintGraph.delete(taintId);
    }
    this.memoryToTaints.delete(memoryId);

    try {
      getGlobalLogger().info(
        'MemoryPoisoningDefenseEngine',
        `已手动清除记忆 ${memoryId} 的污染标记`,
        { clearedTaints: taintIds.size },
      );
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.clearTaint');
    }

    return true;
  }

  // ── 隔离区查询 ──────────────────────────────────────────────────

  /**
   * 获取隔离区中的所有条目 (供人工复核)。
   */
  getQuarantineEntries(): readonly QuarantineEntry[] {
    return [...this.quarantineZone];
  }

  /** 清空隔离区。 */
  clearQuarantine(): void {
    this.quarantineZone.length = 0;
  }

  // ── 内部辅助方法 ────────────────────────────────────────────────

  /**
   * 检查代理的写入速率是否超限。
   * @returns 是否违规
   */
  private checkWriteRate(agentId: string): boolean {
    const now = Date.now();
    let tracker = this.writeRateTracker.get(agentId);
    if (!tracker) {
      tracker = { count: 0, windowStart: now };
      this.writeRateTracker.set(agentId, tracker);
    }
    // 窗口重置
    if (now - tracker.windowStart > 60_000) {
      tracker.count = 0;
      tracker.windowStart = now;
    }
    tracker.count++;
    return tracker.count > this.config.maxWritesPerMinute;
  }

  /**
   * 将内容添加到隔离区。
   */
  private addToQuarantine(
    content: string,
    source: string,
    agentId: string,
    sessionId: string,
    reason: string,
    poisoningType: PoisoningType,
    riskScore: number,
    memoryType: string,
  ): void {
    if (!this.config.quarantineEnabled) return;

    this.quarantineZone.push({
      content,
      source,
      agentId,
      sessionId,
      reason,
      poisoningType,
      riskScore,
      quarantinedAt: new Date().toISOString(),
      memoryType,
    });

    // 超出容量时移除最旧条目
    while (this.quarantineZone.length > this.config.maxQuarantineSize) {
      this.quarantineZone.shift();
    }
  }

  /**
   * 注册一条污染记录到追踪图。
   */
  private registerTaint(
    memoryId: string,
    content: string,
    agentId: string,
    sessionId: string,
    poisoningType: PoisoningType,
    propagatedFrom: string | undefined,
    source: string = '',
  ): string {
    const taintId = generateTaintId();
    const entry: TaintEntry = {
      taintId,
      memoryId,
      content,
      source: source || memoryId,
      poisoningType,
      detectedAt: new Date().toISOString(),
      propagatedFrom,
      sessionId,
      agentId,
    };
    this.taintGraph.set(taintId, entry);

    // 建立 memoryId -> taintIds 的反向索引
    let taintSet = this.memoryToTaints.get(memoryId);
    if (!taintSet) {
      taintSet = new Set();
      this.memoryToTaints.set(memoryId, taintSet);
    }
    taintSet.add(taintId);

    this.recordMetrics('tainted_memories', poisoningType, 1);
    return taintId;
  }

  /**
   * 通过 memoryId 查找关联的污染 ID。
   */
  private findTaintByMemoryId(memoryId: string): string | undefined {
    const taintIds = this.memoryToTaints.get(memoryId);
    if (!taintIds || taintIds.size === 0) return undefined;
    // 返回第一个 (最新注册的) 污染 ID
    return taintIds.values().next().value;
  }

  /**
   * 计算内容指纹 (用于跨会话内容匹配)。
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
  }

  /**
   * 清理过期的污染记录。
   */
  private evictExpiredTaints(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [taintId, entry] of this.taintGraph) {
      const detectedAt = Date.parse(entry.detectedAt);
      if (!isNaN(detectedAt) && now - detectedAt > this.config.taintedMemoryTtlMs) {
        expired.push(taintId);
      }
    }
    for (const taintId of expired) {
      const entry = this.taintGraph.get(taintId);
      this.taintGraph.delete(taintId);
      if (entry) {
        const taintSet = this.memoryToTaints.get(entry.memoryId);
        if (taintSet) {
          taintSet.delete(taintId);
          if (taintSet.size === 0) {
            this.memoryToTaints.delete(entry.memoryId);
          }
        }
      }
    }
  }

  /**
   * 注册一个新的"中毒反思模式"签名，用于检测未来变体。
   * 提取反思内容的关键特征作为签名。
   */
  private registerPoisonedReflectionPattern(reflection: string): void {
    // 限制注册表大小，避免无限增长
    if (this.poisonedReflectionPatterns.length >= 200) {
      this.poisonedReflectionPatterns.shift();
    }
    // 提取关键动词短语作为签名
    const keyPhraseMatch = reflection.match(/(?:disable|bypass|skip|ignore|store\s+plaintext|lower|reduce|relax)[^.!?]{5,60}/i);
    const signature = keyPhraseMatch
      ? new RegExp(keyPhraseMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), 'i')
      : new RegExp(reflection.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    this.poisonedReflectionPatterns.push({
      signature,
      description: `自动注册 (源于反思片段: ${reflection.slice(0, 50)}...)`,
    });
  }

  /**
   * 记录安全事件到 SecurityAuditLogger。
   */
  private logSecurityEvent(
    poisoningType: PoisoningType,
    severity: PoisoningSeverity,
    agentId: string,
    sessionId: string,
    message: string,
    details: Record<string, unknown>,
  ): void {
    try {
      const auditSeverity: SecuritySeverity = severity;
      getSecurityAuditLogger().logEvent({
        type: 'memory_poisoning_detected',
        severity: auditSeverity,
        source: 'MemoryPoisoningDefenseEngine',
        message,
        details: { poisoningType, agentId, sessionId, ...details },
        context: { agentId, tenantId: undefined, runId: sessionId },
      });
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.logSecurityEvent');
    }

    try {
      const logger = getGlobalLogger();
      const logContext = { poisoningType, agentId, sessionId, ...details };
      switch (severity) {
        case 'critical':
          logger.critical('MemoryPoisoningDefenseEngine', message, logContext);
          break;
        case 'high':
          logger.error('MemoryPoisoningDefenseEngine', message, undefined, logContext);
          break;
        case 'medium':
          logger.warn('MemoryPoisoningDefenseEngine', message, logContext);
          break;
        default:
          logger.info('MemoryPoisoningDefenseEngine', message, logContext);
      }
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.logSecurityEvent:logger');
    }
  }

  /**
   * 记录指标到 MetricsCollector。
   */
  private recordMetrics(metric: string, type: PoisoningType, value: number): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter(`security.memory_poisoning.${metric}`, value, { type });
      metrics.incrementCounter('security.memory_poisoning.total', value, { type });
      if (metric === 'blocked_writes' || metric === 'retrieval_blocks') {
        metrics.incrementCounter('security.memory_poisoning.blocks', value, { type });
      }
    } catch (err) {
      reportSilentFailure(err, 'memoryPoisoningDefenseEngine.recordMetrics');
    }
  }
}

// ============================================================================
// 租户隔离单例
// ============================================================================

const defenseEngineSingleton = createTenantAwareSingleton<MemoryPoisoningDefenseEngine>(
  () => new MemoryPoisoningDefenseEngine(),
  {
    componentName: 'MemoryPoisoningDefenseEngine',
    allowGlobalFallback: true,
    dispose: (instance) => {
      try {
        instance.clearQuarantine();
      } catch (err) {
        reportSilentFailure(err, 'memoryPoisoningDefenseEngine.dispose');
      }
    },
  },
);

/**
 * 获取 MemoryPoisoningDefenseEngine 单例实例 (租户隔离)。
 */
export function getMemoryPoisoningDefenseEngine(): MemoryPoisoningDefenseEngine {
  return defenseEngineSingleton.get();
}

/**
 * 重置 MemoryPoisoningDefenseEngine 单例 (清除所有租户实例与全局实例)。
 * 主要用于测试场景。
 */
export function resetMemoryPoisoningDefenseEngine(): void {
  defenseEngineSingleton.reset();
}
