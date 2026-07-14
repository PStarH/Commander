/**
 * GoalHijackDetector — 运行时代理目标劫持检测器 (OWASP ASI01)。
 *
 * 检测四种形式的目标劫持：
 *   1. 直接目标覆盖 (direct_override) — 检测显式指令覆盖模式
 *   2. 间接指令注入 (indirect_injection) — 检测外部内容中的隐藏指令
 *   3. 目标漂移监控 (goal_drift) — 跨执行步骤追踪代理所追求的目标
 *   4. 递归目标修改 (recursive_modification) — 检测渐进式目标偏移
 *
 * 设计说明：
 *   - 使用 createTenantAwareSingleton 实现多租户隔离的单例
 *   - 所有检测通过 SecurityAuditLogger 记录审计事件
 *   - 通过 getGlobalMetrics 记录检测指标
 *   - 所有 catch 块使用 reportSilentFailure 静默报告错误
 *   - checkContext 是主入口，依次运行全部四种检测
 */

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';

// ============================================================================
// 类型定义
// ============================================================================

/** 劫持类型 */
export type HijackType =
  'direct_override' | 'indirect_injection' | 'goal_drift' | 'recursive_modification';

/** 劫持严重程度 */
export type HijackSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 原始目标描述 */
export interface OriginalGoal {
  /** 目标唯一标识 */
  goalId: string;
  /** 目标描述文本 */
  description: string;
  /** 从描述中提取的关键词，用于相似度匹配 */
  keywords: string[];
  /** 目标设定时间 (ISO 时间戳) */
  setAt: string;
  /** 目标设定者 (user/system) */
  setBy: string;
}

/** 目标上下文 — 每次检测时传入的执行上下文 */
export interface GoalContext {
  /** 当前目标 */
  goal: OriginalGoal;
  /** 代理 ID */
  agentId: string;
  /** 会话 ID */
  sessionId: string;
  /** 当前执行步骤号 */
  currentStep: number;
  /** 用户输入文本 (可选) */
  userInput?: string;
  /** 工具输出文本 (可选) */
  toolOutput?: string;
  /** 检索到的外部内容 (可选) */
  retrievedContent?: string;
  /** 代理即将执行的动作描述 (可选) */
  currentAction?: string;
}

/** 劫持检测结果 */
export interface HijackDetectionResult {
  /** 是否检测到劫持 */
  detected: boolean;
  /** 劫持类型 (未检测到时为 undefined) */
  type?: HijackType;
  /** 严重程度 */
  severity: HijackSeverity;
  /** 置信度 (0-1) */
  confidence: number;
  /** 检测原因说明 */
  reason: string;
  /** 匹配到的模式或内容证据 (可选) */
  evidence?: string;
  /** 处置建议 */
  recommendation: 'block' | 'warn' | 'monitor' | 'allow';
  /** 漂移分数 (仅 goal_drift 类型) */
  driftScore?: number;
  /** 目标修改历史长度 (仅 recursive_modification 类型) */
  goalHistoryLength?: number;
}

/** 目标修改记录 */
export interface GoalModificationRecord {
  /** 修改时间 (ISO 时间戳) */
  timestamp: string;
  /** 修改发生的步骤号 */
  step: number;
  /** 修改前的目标描述 */
  fromGoal: string;
  /** 修改后的目标描述 */
  toGoal: string;
  /** 触发修改的原因 */
  trigger: string;
  /** 修改后目标与原始目标的相似度 */
  similarityToOriginal: number;
}

/** 目标劫持检测配置 */
export interface GoalHijackConfig {
  /** 是否启用检测 */
  enabled: boolean;
  /** 漂移阈值 (0-1)，漂移超过此值时告警 */
  driftThreshold: number;
  /** 目标最大修改次数，超过此值时告警 */
  maxGoalModifications: number;
  /** 渐进漂移窗口 (考虑的步数) */
  gradualDriftWindow: number;
  /** 严格模式 — 检测到任何劫持时阻断 */
  strictMode: boolean;
  /** 是否启用间接注入扫描 */
  enableIndirectInjectionScan: boolean;
  /** 是否启用 Unicode 隐写检测 */
  enableUnicodeDetection: boolean;
  /** 额外的自定义阻断模式 */
  blockedPatterns: string[];
}

// ============================================================================
// 常量
// ============================================================================

/** 默认配置 */
const DEFAULT_CONFIG: GoalHijackConfig = {
  enabled: true,
  driftThreshold: 0.7,
  maxGoalModifications: 5,
  gradualDriftWindow: 20,
  strictMode: false,
  enableIndirectInjectionScan: true,
  enableUnicodeDetection: true,
  blockedPatterns: [],
};

/**
 * 直接目标覆盖模式 — 每个模式包含正则、置信度和严重程度。
 * 匹配 "忽略先前指令"、"你的新任务是" 等显式覆盖语言。
 */
interface OverridePattern {
  /** 模式名称 */
  name: string;
  /** 匹配正则 */
  regex: RegExp;
  /** 基础置信度 (0-1) */
  confidence: number;
  /** 严重程度 */
  severity: HijackSeverity;
}

const DIRECT_OVERRIDE_PATTERNS: OverridePattern[] = [
  {
    name: 'ignore_previous_instructions',
    regex:
      /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|goals?|objectives?|directives?)/i,
    confidence: 0.95,
    severity: 'critical',
  },
  {
    name: 'new_task_is',
    regex: /(?:your\s+)?new\s+(?:task|goal|mission|objective|directive)\s+(?:is|will\s+be)\s*/i,
    confidence: 0.9,
    severity: 'critical',
  },
  {
    name: 'disregard_above',
    regex: /disregard\s+(?:the\s+)?(?:above|previous|prior|all)\b/i,
    confidence: 0.92,
    severity: 'critical',
  },
  {
    name: 'forget_what_doing',
    regex:
      /forget\s+(?:what\s+you\s+(?:were|are)\s+doing|everything|all\s+(?:prior|previous)\s+(?:instructions?|context))/i,
    confidence: 0.9,
    severity: 'critical',
  },
  {
    name: 'actually_really_want',
    regex: /actually\s*,?\s*(?:what\s+)?(?:i\s+)?(?:really\s+)?want\s+is\b/i,
    confidence: 0.75,
    severity: 'high',
  },
  {
    name: 'you_are_now',
    regex: /you\s+are\s+now\s+(?:a|an|the)\s+/i,
    confidence: 0.85,
    severity: 'high',
  },
  {
    name: 'pretend_you_are',
    regex: /(?:pretend|act\s+as\s+if|roleplay\s+as)\s+you\s+are\s+(?:a|an|the)?\s*/i,
    confidence: 0.82,
    severity: 'high',
  },
  {
    name: 'override_instructions',
    regex: /override\s+(?:your|the|all)\s+(?:instructions?|goals?|objectives?|directives?|safety)/i,
    confidence: 0.93,
    severity: 'critical',
  },
  {
    name: 'new_instructions_colon',
    regex: /new\s+instructions?\s*:/i,
    confidence: 0.88,
    severity: 'high',
  },
  {
    name: 'system_prompt_injection',
    regex: /(?:system|admin|developer)\s*:\s*(?:ignore|disregard|forget|override|new)/i,
    confidence: 0.9,
    severity: 'critical',
  },
];

/**
 * 隐藏内容模式 — 用于间接注入检测。
 * 每个模式带有隐蔽等级 (stealth level)，等级越高风险越大。
 */
interface HiddenContentPattern {
  /** 模式名称 */
  name: string;
  /** 匹配正则 */
  regex: RegExp;
  /** 隐蔽等级 (1-5，越高越隐蔽) */
  stealthLevel: number;
  /** 严重程度 */
  severity: HijackSeverity;
}

const HIDDEN_CONTENT_PATTERNS: HiddenContentPattern[] = [
  {
    name: 'css_display_none',
    regex: /display\s*:\s*none/i,
    stealthLevel: 4,
    severity: 'high',
  },
  {
    name: 'css_visibility_hidden',
    regex: /visibility\s*:\s*hidden/i,
    stealthLevel: 4,
    severity: 'high',
  },
  {
    name: 'css_zero_font_size',
    regex: /font-size\s*:\s*(?:0|0px|0pt|0em|0rem)/i,
    stealthLevel: 5,
    severity: 'critical',
  },
  {
    name: 'css_color_match_background',
    regex: /color\s*:\s*(?:transparent|rgba?\s*\(\s*255\s*,\s*255\s*,\s*255)/i,
    stealthLevel: 5,
    severity: 'critical',
  },
  {
    name: 'html_comment_instruction',
    regex:
      /<!--[\s\S]*?(?:ignore|disregard|new\s+(?:task|instruction|goal)|you\s+are\s+now|system\s*:)[\s\S]*?-->/i,
    stealthLevel: 3,
    severity: 'high',
  },
  {
    name: 'block_comment_instruction',
    regex:
      /\/\*[\s\S]*?(?:ignore|disregard|new\s+(?:task|instruction|goal)|you\s+are\s+now)[\s\S]*?\*\//i,
    stealthLevel: 3,
    severity: 'high',
  },
  {
    name: 'line_comment_instruction',
    regex:
      /(?:^|\n)\s*#\s*(?:ignore|disregard|new\s+(?:task|instruction|goal)|you\s+are\s+now|system\s*:)/i,
    stealthLevel: 2,
    severity: 'medium',
  },
  {
    name: 'markdown_spoiler',
    regex: /\|\|[^|]+(?:ignore|disregard|new\s+(?:task|instruction)|you\s+are\s+now)[^|]*\|\|/i,
    stealthLevel: 3,
    severity: 'high',
  },
  {
    name: 'json_instruction_field',
    regex: /"(?:instruction|system_prompt|hidden_command|override|directive)"\s*:\s*"[^"]{10,}"/i,
    stealthLevel: 4,
    severity: 'high',
  },
  {
    name: 'yaml_instruction_field',
    regex: /^\s*(?:instruction|system_prompt|hidden_command|override|directive)\s*:\s*\S/im,
    stealthLevel: 4,
    severity: 'high',
  },
];

/**
 * Unicode 隐写字符 — 零宽字符、RTL 覆盖、同形字等。
 */
const UNICODE_STEALTH_CHARS: ReadonlyMap<string, string> = new Map<string, string>([
  ['\u200B', 'zero_width_space'],
  ['\u200C', 'zero_width_non_joiner'],
  ['\u200D', 'zero_width_joiner'],
  ['\u200E', 'left_to_right_mark'],
  ['\u200F', 'right_to_left_mark'],
  ['\u202A', 'left_to_right_embedding'],
  ['\u202B', 'right_to_left_embedding'],
  ['\u202C', 'pop_directional_formatting'],
  ['\u202D', 'left_to_right_override'],
  ['\u202E', 'right_to_left_override'],
  ['\u2060', 'word_joiner'],
  ['\uFEFF', 'zero_width_no_break_space'],
]);

/**
 * 常见同形字映射 — 用于检测拉丁字母被替换为相似 Unicode 字符。
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['\u0430', 'a'], // Cyrillic a
  ['\u0435', 'e'], // Cyrillic e
  ['\u043E', 'o'], // Cyrillic o
  ['\u0440', 'p'], // Cyrillic p
  ['\u0441', 'c'], // Cyrillic c
  ['\u0445', 'x'], // Cyrillic x
  ['\u0455', 's'], // Cyrillic s
  ['\u0456', 'i'], // Cyrillic i
  ['\uFF01', '!'], // Fullwidth !
  ['\uFF1A', ':'], // Fullwidth :
]);

/** 英语停用词 — 关键词提取时过滤 */
const STOPWORDS: ReadonlySet<string> = new Set<string>([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'can',
  'shall',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'about',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'from',
  'up',
  'down',
  'out',
  'off',
  'over',
  'under',
  'again',
  'then',
  'once',
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
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'now',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'them',
  'his',
  'her',
  'its',
  'our',
  'your',
  'their',
  'my',
  'me',
  'him',
  'us',
  'what',
  'which',
  'who',
  'whom',
  'if',
  'because',
  'while',
  'your',
  'task',
  'goal',
]);

/** Base64 字符串匹配模式 (最少 32 字符，排除普通文本) */
const BASE64_PATTERN: RegExp = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** 指令类关键词 — 用于判断解码后的 Base64 内容是否含指令 */
const INSTRUCTION_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'ignore',
  'disregard',
  'override',
  'forget',
  'new',
  'instruction',
  'task',
  'goal',
  'mission',
  'system',
  'prompt',
  'command',
  'execute',
  'pretend',
  'roleplay',
  'act',
  'reveal',
  'secret',
  'password',
  'key',
]);

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从文本中提取关键词 — 分词、过滤停用词、转小写。
 * @param text 输入文本
 * @returns 关键词数组
 */
function extractKeywords(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  const words: string[] = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w: string) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * 计算两个集合的 Jaccard 相似度。
 * @param setA 集合 A
 * @param setB 集合 B
 * @returns Jaccard 相似度 (0-1)
 */
function jaccardSimilarity(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection: number = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union: number = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 尝试解码 Base64 字符串。
 * @param encoded Base64 编码的字符串
 * @returns 解码后的文本，如果解码失败则返回 null
 */
function tryDecodeBase64(encoded: string): string | null {
  try {
    const decoded: string = Buffer.from(encoded, 'base64').toString('utf-8');
    // 过滤掉非可打印字符为主的解码结果
    const printableRatio: number =
      decoded.replace(/[^\x20-\x7E\u4e00-\u9fff\n\r\t]/g, '').length / Math.max(decoded.length, 1);
    if (printableRatio < 0.6) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 检查文本是否包含指令类关键词。
 * @param text 待检查文本
 * @returns 是否包含指令关键词
 */
function containsInstructionKeywords(text: string): boolean {
  const lower: string = text.toLowerCase();
  for (const keyword of INSTRUCTION_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

/**
 * 统计文本中 Unicode 隐写字符的数量。
 * @param text 待检查文本
 * @returns 隐写字符计数映射及总数
 */
function detectUnicodeStealth(text: string): {
  total: number;
  details: Record<string, number>;
} {
  const details: Record<string, number> = {};
  let total: number = 0;
  for (const [char, name] of UNICODE_STEALTH_CHARS) {
    const count: number = text.split(char).length - 1;
    if (count > 0) {
      details[name] = count;
      total += count;
    }
  }
  // 检测同形字
  let homoglyphCount: number = 0;
  for (const char of HOMOGLYPH_MAP.keys()) {
    homoglyphCount += text.split(char).length - 1;
  }
  if (homoglyphCount > 0) {
    details['homoglyph'] = homoglyphCount;
    total += homoglyphCount;
  }
  return { total, details };
}

// ============================================================================
// 会话状态接口
// ============================================================================

/** 每会话的漂移追踪状态 */
interface DriftTrackingState {
  /** 原始目标关键词集合 */
  originalKeywords: Set<string>;
  /** 历史漂移分数 (按步骤顺序) */
  driftHistory: Array<{ step: number; driftScore: number }>;
  /** 上一次漂移分数 */
  lastDriftScore: number;
}

/** 每代理+会话的目标修改历史 */
interface GoalModificationState {
  /** 原始目标描述 */
  originalGoalDescription: string;
  /** 原始目标关键词集合 */
  originalKeywords: Set<string>;
  /** 修改记录列表 */
  modifications: GoalModificationRecord[];
}

// ============================================================================
// GoalHijackDetector 主类
// ============================================================================

/**
 * 目标劫持检测器 — 运行时检测代理目标劫持行为。
 *
 * 检测四种劫持形式：
 *   1. 直接目标覆盖 — 显式指令覆盖模式
 *   2. 间接指令注入 — 外部内容中的隐藏指令
 *   3. 目标漂移 — 跨步骤的目标偏离
 *   4. 递归目标修改 — 渐进式目标偏移
 *
 * 使用方法：
 *   const detector = getGoalHijackDetector();
 *   detector.setGoal(sessionId, goal);
 *   const result = detector.checkContext(context);
 */
export class GoalHijackDetector {
  /** 检测配置 */
  private config: GoalHijackConfig;
  /** 每会话的当前目标 (sessionId → OriginalGoal) */
  private sessionGoals: Map<string, OriginalGoal> = new Map();
  /** 每会话的漂移追踪状态 (sessionId → DriftTrackingState) */
  private driftStates: Map<string, DriftTrackingState> = new Map();
  /** 每代理+会话的目标修改历史 (agentSessionKey → GoalModificationState) */
  private modificationStates: Map<string, GoalModificationState> = new Map();
  /** 检测计数 (按类型) */
  private detectionCounts: Map<HijackType, number> = new Map();
  /** 误报计数 (用户标记为安全的检测次数) */
  private falsePositiveCount: number = 0;
  /** 总检测次数 */
  private totalDetections: number = 0;

  constructor(config: Partial<GoalHijackConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 配置管理 ──────────────────────────────────────────────────────

  /**
   * 更新检测配置 (合并到现有配置)。
   * @param partial 部分配置
   */
  updateConfig(partial: Partial<GoalHijackConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * 获取当前配置。
   * @returns 当前配置的副本
   */
  getConfig(): GoalHijackConfig {
    return { ...this.config };
  }

  // ── 目标管理 ──────────────────────────────────────────────────────

  /**
   * 为会话设定初始目标。
   * @param sessionId 会话 ID
   * @param goal 原始目标
   */
  setGoal(sessionId: string, goal: OriginalGoal): void {
    this.sessionGoals.set(sessionId, goal);
    const keywords: Set<string> = new Set(
      goal.keywords.length > 0 ? goal.keywords : extractKeywords(goal.description),
    );
    this.driftStates.set(sessionId, {
      originalKeywords: keywords,
      driftHistory: [],
      lastDriftScore: 0,
    });
    const modKey: string = `${goal.goalId}::${sessionId}`;
    this.modificationStates.set(modKey, {
      originalGoalDescription: goal.description,
      originalKeywords: keywords,
      modifications: [],
    });
  }

  /**
   * 获取会话的当前目标。
   * @param sessionId 会话 ID
   * @returns 当前目标，未设置时返回 undefined
   */
  getGoal(sessionId: string): OriginalGoal | undefined {
    return this.sessionGoals.get(sessionId);
  }

  /**
   * 记录一次目标修改 — 用于递归修改检测。
   * @param goalId 目标 ID
   * @param sessionId 会话 ID
   * @param fromGoal 修改前目标描述
   * @param toGoal 修改后目标描述
   * @param step 修改发生的步骤号
   * @param trigger 修改触发原因
   */
  recordGoalModification(
    goalId: string,
    sessionId: string,
    fromGoal: string,
    toGoal: string,
    step: number,
    trigger: string,
  ): void {
    try {
      const modKey: string = `${goalId}::${sessionId}`;
      let state: GoalModificationState | undefined = this.modificationStates.get(modKey);
      if (!state) {
        const keywords: Set<string> = new Set(extractKeywords(fromGoal));
        state = {
          originalGoalDescription: fromGoal,
          originalKeywords: keywords,
          modifications: [],
        };
        this.modificationStates.set(modKey, state);
      }

      const newKeywords: Set<string> = new Set(extractKeywords(toGoal));
      const similarity: number = jaccardSimilarity(state.originalKeywords, newKeywords);

      const record: GoalModificationRecord = {
        timestamp: new Date().toISOString(),
        step,
        fromGoal,
        toGoal,
        trigger,
        similarityToOriginal: similarity,
      };
      state.modifications.push(record);
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:recordGoalModification');
    }
  }

  /**
   * 获取目标修改历史。
   * @param goalId 目标 ID
   * @param sessionId 会话 ID
   * @returns 修改记录列表
   */
  getGoalModificationHistory(goalId: string, sessionId: string): GoalModificationRecord[] {
    const modKey: string = `${goalId}::${sessionId}`;
    const state: GoalModificationState | undefined = this.modificationStates.get(modKey);
    return state ? [...state.modifications] : [];
  }

  // ── 主入口 ────────────────────────────────────────────────────────

  /**
   * 主检测入口 — 运行全部四种检测，返回最严重的检测结果。
   *
   * 依次执行：
   *   1. 直接目标覆盖检测
   *   2. 间接指令注入检测
   *   3. 目标漂移监控
   *   4. 递归目标修改检测
   *
   * @param ctx 目标上下文
   * @returns 最严重的检测结果 (若无检测到则返回未检测到的结果)
   */
  checkContext(ctx: GoalContext): HijackDetectionResult {
    if (!this.config.enabled) {
      return {
        detected: false,
        severity: 'low',
        confidence: 0,
        reason: '检测器已禁用',
        recommendation: 'allow',
      };
    }

    const results: HijackDetectionResult[] = [];

    // 1. 直接目标覆盖检测
    try {
      const override: HijackDetectionResult = this.detectDirectOverride(ctx);
      results.push(override);
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:checkContext:detectDirectOverride');
    }

    // 2. 间接指令注入检测
    if (this.config.enableIndirectInjectionScan) {
      try {
        const injection: HijackDetectionResult = this.detectIndirectInjection(ctx);
        results.push(injection);
      } catch (err) {
        reportSilentFailure(err, 'goalHijackDetector:checkContext:detectIndirectInjection');
      }
    }

    // 3. 目标漂移监控
    try {
      const drift: HijackDetectionResult = this.monitorGoalDrift(ctx);
      results.push(drift);
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:checkContext:monitorGoalDrift');
    }

    // 4. 递归目标修改检测
    try {
      const recursive: HijackDetectionResult = this.detectRecursiveModification(ctx);
      results.push(recursive);
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:checkContext:detectRecursiveModification');
    }

    // 返回最严重的检测结果
    const severityOrder: Record<HijackSeverity, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    let worst: HijackDetectionResult = {
      detected: false,
      severity: 'low',
      confidence: 0,
      reason: '未检测到目标劫持',
      recommendation: 'allow',
    };

    for (const result of results) {
      if (!result.detected) continue;
      if (severityOrder[result.severity] > severityOrder[worst.severity]) {
        worst = result;
      } else if (
        severityOrder[result.severity] === severityOrder[worst.severity] &&
        result.confidence > worst.confidence
      ) {
        worst = result;
      }
    }

    // 严格模式下，任何检测到都建议阻断
    if (worst.detected && this.config.strictMode) {
      worst.recommendation = 'block';
    }

    return worst;
  }

  // ── 检测方法 1: 直接目标覆盖 ─────────────────────────────────────

  /**
   * 检测直接目标覆盖 — 在用户输入、工具输出和检索内容中扫描
   * 显式指令覆盖模式 (如 "忽略先前指令"、"你的新任务是" 等)。
   *
   * @param ctx 目标上下文
   * @returns 检测结果
   */
  detectDirectOverride(ctx: GoalContext): HijackDetectionResult {
    const sources: Array<{ name: string; content: string }> = [];
    if (ctx.userInput) sources.push({ name: 'userInput', content: ctx.userInput });
    if (ctx.toolOutput) sources.push({ name: 'toolOutput', content: ctx.toolOutput });
    if (ctx.retrievedContent)
      sources.push({ name: 'retrievedContent', content: ctx.retrievedContent });

    let bestMatch: {
      pattern: OverridePattern;
      source: string;
      matchText: string;
    } | null = null;

    for (const source of sources) {
      // 检查内置模式
      for (const pattern of DIRECT_OVERRIDE_PATTERNS) {
        const match: RegExpMatchArray | null = source.content.match(pattern.regex);
        if (match) {
          if (!bestMatch || pattern.confidence > bestMatch.pattern.confidence) {
            bestMatch = {
              pattern,
              source: source.name,
              matchText: match[0],
            };
          }
        }
      }

      // 检查自定义阻断模式
      for (const customPattern of this.config.blockedPatterns) {
        try {
          const customRegex: RegExp = new RegExp(customPattern, 'i');
          const match: RegExpMatchArray | null = source.content.match(customRegex);
          if (match) {
            const customOverride: OverridePattern = {
              name: `custom:${customPattern}`,
              regex: customRegex,
              confidence: 0.8,
              severity: 'high',
            };
            if (!bestMatch || customOverride.confidence > bestMatch.pattern.confidence) {
              bestMatch = {
                pattern: customOverride,
                source: source.name,
                matchText: match[0],
              };
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'goalHijackDetector:detectDirectOverride:customPattern');
        }
      }
    }

    if (bestMatch) {
      const result: HijackDetectionResult = {
        detected: true,
        type: 'direct_override',
        severity: bestMatch.pattern.severity,
        confidence: bestMatch.pattern.confidence,
        reason: `在 ${bestMatch.source} 中检测到直接目标覆盖模式: ${bestMatch.pattern.name}`,
        evidence: bestMatch.matchText,
        recommendation: this.config.strictMode ? 'block' : 'block',
      };

      this.recordDetection('direct_override', result);
      this.logDetection(ctx, result, {
        patternName: bestMatch.pattern.name,
        source: bestMatch.source,
        matchedText: bestMatch.matchText.slice(0, 200),
      });

      return result;
    }

    return {
      detected: false,
      severity: 'low',
      confidence: 0,
      reason: '未检测到直接目标覆盖模式',
      recommendation: 'allow',
    };
  }

  // ── 检测方法 2: 间接指令注入 ─────────────────────────────────────

  /**
   * 检测间接指令注入 — 在外部内容 (网页、文档、工具输出) 中扫描
   * 隐藏指令，包括 HTML/CSS 隐藏内容、Unicode 隐写、Base64 编码指令、
   * 注释嵌入指令、Markdown 隐藏文本、JSON/YAML 指令字段等。
   *
   * 每个发现按隐蔽等级评分，隐蔽等级越高风险越大。
   *
   * @param ctx 目标上下文
   * @returns 检测结果
   */
  detectIndirectInjection(ctx: GoalContext): HijackDetectionResult {
    const sources: Array<{ name: string; content: string }> = [];
    if (ctx.toolOutput) sources.push({ name: 'toolOutput', content: ctx.toolOutput });
    if (ctx.retrievedContent)
      sources.push({ name: 'retrievedContent', content: ctx.retrievedContent });
    if (ctx.userInput) sources.push({ name: 'userInput', content: ctx.userInput });

    interface Finding {
      name: string;
      stealthLevel: number;
      severity: HijackSeverity;
      evidence: string;
      source: string;
    }
    const findings: Finding[] = [];

    for (const source of sources) {
      const content: string = source.content;

      // 检查隐藏内容模式
      for (const pattern of HIDDEN_CONTENT_PATTERNS) {
        const match: RegExpMatchArray | null = content.match(pattern.regex);
        if (match) {
          findings.push({
            name: pattern.name,
            stealthLevel: pattern.stealthLevel,
            severity: pattern.severity,
            evidence: match[0].slice(0, 200),
            source: source.name,
          });
        }
      }

      // Unicode 隐写检测
      if (this.config.enableUnicodeDetection) {
        const unicodeResult: { total: number; details: Record<string, number> } =
          detectUnicodeStealth(content);
        if (unicodeResult.total > 0) {
          findings.push({
            name: 'unicode_steganography',
            stealthLevel: 5,
            severity: 'critical',
            evidence: JSON.stringify(unicodeResult.details),
            source: source.name,
          });
        }
      }

      // Base64 编码指令检测
      const base64Matches: RegExpMatchArray[] = Array.from(content.matchAll(BASE64_PATTERN));
      for (const match of base64Matches) {
        const encoded: string = match[0];
        const decoded: string | null = tryDecodeBase64(encoded);
        if (decoded && containsInstructionKeywords(decoded)) {
          findings.push({
            name: 'base64_encoded_instruction',
            stealthLevel: 5,
            severity: 'critical',
            evidence: decoded.slice(0, 200),
            source: source.name,
          });
        }
      }
    }

    if (findings.length === 0) {
      return {
        detected: false,
        severity: 'low',
        confidence: 0,
        reason: '未检测到间接指令注入',
        recommendation: 'allow',
      };
    }

    // 按隐蔽等级排序，取最高等级的发现
    findings.sort((a: Finding, b: Finding) => b.stealthLevel - a.stealthLevel);
    const topFinding: Finding = findings[0]!;

    // 置信度基于隐蔽等级和发现数量
    const stealthConfidence: number = Math.min(topFinding.stealthLevel / 5, 1) * 0.7;
    const countConfidence: number = Math.min(findings.length / 5, 1) * 0.3;
    const confidence: number = stealthConfidence + countConfidence;

    const result: HijackDetectionResult = {
      detected: true,
      type: 'indirect_injection',
      severity: topFinding.severity,
      confidence,
      reason: `在 ${topFinding.source} 中检测到 ${findings.length} 个隐藏指令注入 (${topFinding.name})`,
      evidence: topFinding.evidence,
      recommendation: this.config.strictMode
        ? 'block'
        : topFinding.severity === 'critical'
          ? 'block'
          : 'warn',
    };

    this.recordDetection('indirect_injection', result);
    this.logDetection(ctx, result, {
      findings: findings.map((f: Finding) => ({
        name: f.name,
        stealthLevel: f.stealthLevel,
        source: f.source,
      })),
      findingCount: findings.length,
    });

    return result;
  }

  // ── 检测方法 3: 目标漂移监控 ─────────────────────────────────────

  /**
   * 监控目标漂移 — 追踪代理跨执行步骤所追求的目标，通过语义相似度
   * (Jaccard 关键词重叠) 比较当前动作与原始目标的对齐度。
   *
   * 漂移分数 = 1 - similarity(current_action_keywords, goal_keywords)
   * 当漂移超过配置阈值时触发告警。
   *
   * 支持增量检查 — 在每个步骤调用，传入当前动作描述。
   *
   * @param ctx 目标上下文
   * @returns 检测结果
   */
  monitorGoalDrift(ctx: GoalContext): HijackDetectionResult {
    // 需要当前动作描述才能进行漂移分析
    if (!ctx.currentAction || ctx.currentAction.trim().length === 0) {
      return {
        detected: false,
        severity: 'low',
        confidence: 0,
        reason: '无当前动作描述，跳过漂移检测',
        recommendation: 'allow',
      };
    }

    let state: DriftTrackingState | undefined = this.driftStates.get(ctx.sessionId);
    if (!state) {
      // 自动初始化漂移追踪状态
      const keywords: string[] =
        ctx.goal.keywords.length > 0 ? ctx.goal.keywords : extractKeywords(ctx.goal.description);
      state = {
        originalKeywords: new Set(keywords),
        driftHistory: [],
        lastDriftScore: 0,
      };
      this.driftStates.set(ctx.sessionId, state);
    }

    // 计算当前动作与原始目标的关键词相似度
    const actionKeywords: Set<string> = new Set(extractKeywords(ctx.currentAction));
    const similarity: number = jaccardSimilarity(actionKeywords, state.originalKeywords);
    const driftScore: number = 1 - similarity;

    // 记录漂移历史
    state.driftHistory.push({ step: ctx.currentStep, driftScore });
    // 限制历史长度
    if (state.driftHistory.length > this.config.gradualDriftWindow * 2) {
      state.driftHistory.shift();
    }

    // 计算漂移速率 (与上一步相比的变化)
    const driftDelta: number = driftScore - state.lastDriftScore;
    state.lastDriftScore = driftScore;

    // 判断是否超过阈值
    const exceedsThreshold: boolean = driftScore >= this.config.driftThreshold;

    // 判断漂移速率是否异常 (快速偏离)
    const rapidDrift: boolean = driftDelta > 0.3;

    if (exceedsThreshold || rapidDrift) {
      const severity: HijackSeverity =
        driftScore > 0.9 ? 'critical' : driftScore > 0.8 ? 'high' : 'medium';

      const result: HijackDetectionResult = {
        detected: true,
        type: 'goal_drift',
        severity,
        confidence: Math.min(driftScore, 1),
        reason: rapidDrift
          ? `目标漂移速率异常: 漂移增量 ${driftDelta.toFixed(3)} (当前漂移 ${driftScore.toFixed(3)})`
          : `目标漂移超过阈值: 漂移分数 ${driftScore.toFixed(3)} > 阈值 ${this.config.driftThreshold}`,
        evidence: `动作: "${ctx.currentAction.slice(0, 150)}" | 相似度: ${similarity.toFixed(3)}`,
        recommendation: this.config.strictMode
          ? 'block'
          : severity === 'critical'
            ? 'block'
            : 'warn',
        driftScore,
      };

      this.recordDetection('goal_drift', result);
      this.logDetection(ctx, result, {
        driftScore,
        similarity,
        driftDelta,
        threshold: this.config.driftThreshold,
        actionKeywords: Array.from(actionKeywords),
        goalKeywords: Array.from(state.originalKeywords),
        rapidDrift,
      });

      return result;
    }

    return {
      detected: false,
      severity: 'low',
      confidence: driftScore,
      reason: `目标漂移在正常范围内 (漂移分数 ${driftScore.toFixed(3)})`,
      recommendation: 'monitor',
      driftScore,
    };
  }

  // ── 检测方法 4: 递归目标修改 ─────────────────────────────────────

  /**
   * 检测递归目标修改 — 追踪代理生命周期中的目标变更，检测渐进式目标偏移。
   *
   * 检测条件：
   *   1. 目标修改次数超过配置的最大值 (maxGoalModifications)
   *   2. 修改模式呈现逐渐远离原始目标的趋势 (每次修改的相似度递减)
   *
   * @param ctx 目标上下文
   * @returns 检测结果
   */
  detectRecursiveModification(ctx: GoalContext): HijackDetectionResult {
    const modKey: string = `${ctx.goal.goalId}::${ctx.sessionId}`;
    const state: GoalModificationState | undefined = this.modificationStates.get(modKey);

    if (!state || state.modifications.length === 0) {
      return {
        detected: false,
        severity: 'low',
        confidence: 0,
        reason: '无目标修改记录',
        recommendation: 'allow',
        goalHistoryLength: 0,
      };
    }

    const modCount: number = state.modifications.length;
    const exceedsMax: boolean = modCount > this.config.maxGoalModifications;

    // 检测渐进偏离模式 — 每次修改的相似度是否递减
    let isProgressiveDivergence: boolean = false;
    let divergenceTrend: number = 0;

    if (modCount >= 3) {
      // 取最近 gradualDriftWindow 步内的修改记录
      const recentMods: GoalModificationRecord[] = state.modifications.slice(
        -this.config.gradualDriftWindow,
      );
      let decreasingCount: number = 0;
      for (let i: number = 1; i < recentMods.length; i++) {
        const prev: GoalModificationRecord = recentMods[i - 1]!;
        const curr: GoalModificationRecord = recentMods[i]!;
        if (curr.similarityToOriginal < prev.similarityToOriginal) {
          decreasingCount++;
        }
      }
      // 如果超过 70% 的修改使相似度下降，则判定为渐进偏离
      const decreaseRatio: number = decreasingCount / (recentMods.length - 1);
      isProgressiveDivergence = decreaseRatio >= 0.7;
      divergenceTrend = decreaseRatio;
    }

    // 最新修改与原始目标的相似度
    const latestMod: GoalModificationRecord = state.modifications[state.modifications.length - 1]!;
    const latestSimilarity: number = latestMod.similarityToOriginal;

    if (exceedsMax || isProgressiveDivergence) {
      const severity: HijackSeverity =
        exceedsMax && isProgressiveDivergence ? 'critical' : exceedsMax ? 'high' : 'medium';

      const reason: string = exceedsMax
        ? `目标修改次数 ${modCount} 超过最大值 ${this.config.maxGoalModifications}`
        : `检测到渐进式目标偏离: ${divergenceTrend.toFixed(2)} 的修改使目标远离原始目标`;

      const confidence: number = exceedsMax
        ? Math.min(0.5 + modCount / (this.config.maxGoalModifications * 2), 1)
        : Math.min(divergenceTrend, 1);

      const result: HijackDetectionResult = {
        detected: true,
        type: 'recursive_modification',
        severity,
        confidence,
        reason,
        evidence: `最新相似度: ${latestSimilarity.toFixed(3)} | 修改次数: ${modCount} | 偏离趋势: ${divergenceTrend.toFixed(2)}`,
        recommendation: this.config.strictMode
          ? 'block'
          : severity === 'critical'
            ? 'block'
            : 'warn',
        goalHistoryLength: modCount,
      };

      this.recordDetection('recursive_modification', result);
      this.logDetection(ctx, result, {
        modificationCount: modCount,
        maxModifications: this.config.maxGoalModifications,
        exceedsMax,
        isProgressiveDivergence,
        divergenceTrend,
        latestSimilarity,
        recentModifications: state.modifications.slice(-5).map((m: GoalModificationRecord) => ({
          step: m.step,
          similarityToOriginal: m.similarityToOriginal,
          trigger: m.trigger,
        })),
      });

      return result;
    }

    return {
      detected: false,
      severity: 'low',
      confidence: 0,
      reason: `目标修改在正常范围内 (修改次数 ${modCount}, 最大 ${this.config.maxGoalModifications})`,
      recommendation: 'allow',
      goalHistoryLength: modCount,
    };
  }

  // ── 误报管理 ──────────────────────────────────────────────────────

  /**
   * 将某次检测标记为误报 (用户标记为安全)。
   * @param type 被标记的劫持类型
   */
  markFalsePositive(type: HijackType): void {
    this.falsePositiveCount++;
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('goal_hijack.false_positives', 1, { type });
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:markFalsePositive');
    }
  }

  // ── 统计与重置 ────────────────────────────────────────────────────

  /**
   * 获取检测统计信息。
   * @returns 统计数据
   */
  getStats(): {
    totalDetections: number;
    detectionsByType: Record<string, number>;
    falsePositives: number;
    trackedSessions: number;
    trackedGoals: number;
  } {
    const detectionsByType: Record<string, number> = {};
    for (const [type, count] of this.detectionCounts) {
      detectionsByType[type] = count;
    }
    return {
      totalDetections: this.totalDetections,
      detectionsByType,
      falsePositives: this.falsePositiveCount,
      trackedSessions: this.sessionGoals.size,
      trackedGoals: this.modificationStates.size,
    };
  }

  /**
   * 重置所有检测状态 — 清除会话目标、漂移状态和修改历史。
   */
  reset(): void {
    this.sessionGoals.clear();
    this.driftStates.clear();
    this.modificationStates.clear();
    this.detectionCounts.clear();
    this.falsePositiveCount = 0;
    this.totalDetections = 0;
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 记录一次检测 — 更新计数和指标。
   * @param type 劫持类型
   * @param result 检测结果
   */
  private recordDetection(type: HijackType, result: HijackDetectionResult): void {
    this.totalDetections++;
    const current: number = this.detectionCounts.get(type) ?? 0;
    this.detectionCounts.set(type, current + 1);

    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('goal_hijack.detections', 1, {
        type,
        severity: result.severity,
      });
      metrics.incrementCounter(`goal_hijack.detections.${type}`, 1);
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:recordDetection');
    }
  }

  /**
   * 将检测结果记录到安全审计日志。
   * @param ctx 目标上下文
   * @param result 检测结果
   * @param extraDetails 额外详情
   */
  private logDetection(
    ctx: GoalContext,
    result: HijackDetectionResult,
    extraDetails: Record<string, unknown>,
  ): void {
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'content_threat',
        severity: result.severity,
        source: 'goal_hijack_detector',
        message: `目标劫持检测 [${result.type}]: ${result.reason}`,
        details: {
          hijackType: result.type,
          hijackSeverity: result.severity,
          confidence: result.confidence,
          recommendation: result.recommendation,
          reason: result.reason,
          evidence: result.evidence,
          driftScore: result.driftScore,
          goalHistoryLength: result.goalHistoryLength,
          goalId: ctx.goal.goalId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          currentStep: ctx.currentStep,
          ...extraDetails,
        },
        context: {
          agentId: ctx.agentId,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:logDetection');
    }

    try {
      const logger = getGlobalLogger();
      logger.warn('GoalHijackDetector', `目标劫持检测: [${result.type}] ${result.reason}`, {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        step: ctx.currentStep,
        severity: result.severity,
        confidence: result.confidence,
      });
    } catch (err) {
      reportSilentFailure(err, 'goalHijackDetector:logDetection:logger');
    }
  }
}

// ============================================================================
// 单例 — 使用 createTenantAwareSingleton 实现多租户隔离
// ============================================================================

const goalHijackDetectorSingleton = createTenantAwareSingleton<GoalHijackDetector>(
  () => new GoalHijackDetector(),
  {
    componentName: 'GoalHijackDetector',
  },
);

/**
 * 获取目标劫持检测器单例实例。
 * 在租户上下文中返回每租户实例，否则返回全局回退实例。
 * @returns GoalHijackDetector 实例
 */
export function getGoalHijackDetector(): GoalHijackDetector {
  return goalHijackDetectorSingleton.get();
}

/**
 * 重置目标劫持检测器单例 — 清除所有租户实例和全局实例。
 * 主要用于测试。
 */
export function resetGoalHijackDetector(): void {
  goalHijackDetectorSingleton.reset();
}
