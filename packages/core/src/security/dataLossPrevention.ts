/**
 * DataLossPrevention — 全面数据泄露防护（DLP）系统
 *
 * 检测和阻止敏感数据通过以下出口点泄露：
 * - API 响应（HTTP 响应体）
 * - 日志输出
 * - 工具调用结果
 * - Agent 输出
 * - SSE 事件流
 *
 * 检测的敏感数据类型：
 * - API 密钥（sk-, ghp_, AKIA, xox 等模式）
 * - JWT token
 * - 私钥（PEM 格式）
 * - 信用卡号（Luhn 校验）
 * - SSN（美国社会安全号）
 * - 邮箱地址（可配置脱敏）
 * - 电话号码
 * - 内网 IP 地址
 * - 数据库连接字符串
 * - AWS/GCP/Azure 凭证
 * - 中国身份证号（校验码验证）
 * - 银行账号
 *
 * 脱敏策略：
 * - REDACT：完全替换为 [REDACTED]
 * - MASK：部分遮蔽（如 sk-****1234）
 * - HASH：替换为 SHA-256 哈希前8位
 * - ALLOW：允许通过（仅记录）
 *
 * 设计：
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 出口点（API响应 / 日志 / 工具结果 / Agent输出 / SSE）                │
 * │   │                                                                   │
 * │   ▼                                                                   │
 * │ DataLossPrevention.scan(content, exitPoint)                          │
 * │   ├─ 阶段1: 检测（正则模式匹配，零 LLM 开销）                         │
 * │   ├─ 阶段2: 验证（Luhn 校验信用卡、校验码验证中国身份证）              │
 * │   ├─ 阶段3: 脱敏（按类型策略：REDACT / MASK / HASH / ALLOW）          │
 * │   ├─ 阶段4: 审计（通过 SecurityAuditLogger 记录所有泄露事件）         │
 * │   └─ 阶段5: 返回扫描结果（含风险等级、匹配列表、脱敏内容）            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 使用示例：
 *   import { getDataLossPrevention, scanContent, sanitizeContent } from './security/dataLossPrevention';
 *
 *   // 扫描内容
 *   const result = scanContent('我的 API key 是 sk-abc123...');
 *   console.log(result.isClean); // false
 *   console.log(result.riskLevel); // 'critical'
 *
 *   // 脱敏内容
 *   const safe = sanitizeContent('联系我: user@example.com', 'MASK');
 *   // '联系我: u***@example.com'
 *
 *   // Express 中间件
 *   app.use(dlpResponseMiddleware());
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getSecurityProfileConfig } from './securityProfile';

// ============================================================================
// 类型定义
// ============================================================================

/** DLP 风险等级 */
export type DLPRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** 敏感数据类型 */
export type SensitiveDataType =
  | 'api_key'
  | 'jwt_token'
  | 'private_key'
  | 'credit_card'
  | 'ssn'
  | 'email'
  | 'phone_number'
  | 'internal_ip'
  | 'database_connection_string'
  | 'aws_credential'
  | 'gcp_credential'
  | 'azure_credential'
  | 'chinese_id'
  | 'bank_account';

/** 脱敏策略 */
export type RedactionStrategy = 'REDACT' | 'MASK' | 'HASH' | 'ALLOW';

/** DLP 出口点类型 */
export type DLPExitPoint =
  | 'api_response'
  | 'log_output'
  | 'tool_result'
  | 'agent_output'
  | 'sse_event';

/**
 * 敏感数据匹配结果
 */
export interface SensitiveDataMatch {
  /** 敏感数据类型 */
  type: SensitiveDataType;
  /** 匹配到的原始值 */
  value: string;
  /** 在内容中的位置 */
  position: { start: number; end: number };
  /** 脱敏后的替换值 */
  redactedValue: string;
  /** 该匹配的风险等级 */
  riskLevel: DLPRiskLevel;
}

/**
 * DLP 扫描结果
 */
export interface DLPScanResult {
  /** 内容是否干净（无敏感数据） */
  isClean: boolean;
  /** 检测到的所有敏感数据匹配 */
  matches: SensitiveDataMatch[];
  /** 脱敏后的内容 */
  sanitizedContent: string;
  /** 整体风险等级（取所有匹配中的最高等级） */
  riskLevel: DLPRiskLevel;
  /** 触发扫描的出口点 */
  exitPoint?: DLPExitPoint;
  /** 扫描耗时（毫秒） */
  scanDurationMs: number;
  /** 是否被阻止输出（当 blockOnCritical 且风险等级为 critical 时） */
  blocked: boolean;
}

/**
 * 敏感数据检测模式配置
 */
export interface SensitiveDataPattern {
  /** 敏感数据类型 */
  type: SensitiveDataType;
  /** 正则表达式模式（必须包含 g 标志） */
  pattern: RegExp;
  /** 该模式的风险等级 */
  riskLevel: DLPRiskLevel;
  /** 人类可读的模式描述 */
  description: string;
}

/**
 * DLP 配置接口
 */
export interface DLPConfig {
  /** 是否启用 DLP 防护 */
  enabled: boolean;
  /** 敏感数据检测模式列表 */
  patterns: SensitiveDataPattern[];
  /** 每种敏感数据类型的脱敏策略映射 */
  strategyMap: Partial<Record<SensitiveDataType, RedactionStrategy>>;
  /** 启用的敏感数据类型（未在此列表中的类型将被跳过） */
  enabledTypes: SensitiveDataType[];
  /** 各出口点的启用/禁用配置 */
  exitPoints: Partial<Record<DLPExitPoint, boolean>>;
  /** 最大扫描内容长度（字符数），超过此长度的内容将被截断 */
  maxContentLength: number;
  /** 是否启用审计日志记录 */
  auditEnabled: boolean;
  /** 是否在检测到 critical 级别泄露时阻止输出 */
  blockOnCritical: boolean;
}

/**
 * DLP 统计信息
 */
export interface DLPStats {
  /** 总扫描次数 */
  totalScans: number;
  /** 检测到的泄露总数 */
  totalLeaksDetected: number;
  /** 被阻止的输出次数 */
  totalBlocked: number;
  /** 按敏感数据类型统计 */
  byType: Record<string, number>;
  /** 按出口点统计 */
  byExitPoint: Record<string, number>;
  /** 按风险等级统计 */
  byRiskLevel: Record<DLPRiskLevel, number>;
}

/**
 * Express 中间件选项
 */
export interface DLPMiddlewareOptions {
  /** 指定出口点类型（默认 'api_response'） */
  exitPoint?: DLPExitPoint;
  /** 是否在检测到 critical 级别泄露时阻止响应（默认使用 DLPConfig 中的配置） */
  blockOnCritical?: boolean;
  /** 需要扫描的内容类型前缀列表（默认扫描 json、text、xml、html） */
  contentTypes?: string[];
}

// ============================================================================
// 默认敏感数据检测模式
// ============================================================================

/**
 * 默认的敏感数据检测模式集合。
 * 涵盖 API 密钥、JWT、私钥、信用卡、SSN、邮箱、电话、内网 IP、
 * 数据库连接字符串、云凭证、中国身份证号、银行账号。
 */
const DEFAULT_PATTERNS: SensitiveDataPattern[] = [
  // ── API 密钥（critical）─────────────────────────────────────────────
  {
    type: 'api_key',
    pattern: /sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}/g,
    riskLevel: 'critical',
    description: 'OpenAI/Anthropic API 密钥',
  },
  {
    type: 'api_key',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    riskLevel: 'critical',
    description: 'GitHub 个人访问令牌',
  },
  {
    type: 'api_key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    riskLevel: 'critical',
    description: 'Google API 密钥',
  },
  {
    type: 'api_key',
    pattern: /hf_[A-Za-z0-9]{32,}/g,
    riskLevel: 'critical',
    description: 'HuggingFace API 密钥',
  },
  {
    type: 'api_key',
    pattern: /xox[bpras]-[A-Za-z0-9-]{10,}/g,
    riskLevel: 'critical',
    description: 'Slack 机器人令牌',
  },
  {
    type: 'api_key',
    pattern: /(?:sk_live|sk_test)_[A-Za-z0-9]{24,}/g,
    riskLevel: 'critical',
    description: 'Stripe API 密钥',
  },
  {
    type: 'api_key',
    pattern: /xai-[A-Za-z0-9]{32,}/g,
    riskLevel: 'critical',
    description: 'xAI API 密钥',
  },
  {
    type: 'api_key',
    pattern: /glm-[A-Za-z0-9]{20,}/g,
    riskLevel: 'critical',
    description: 'GLM API 密钥',
  },

  // ── JWT Token（high）────────────────────────────────────────────────
  {
    type: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    riskLevel: 'high',
    description: 'JWT 令牌',
  },

  // ── 私钥 PEM 格式（critical）────────────────────────────────────────
  {
    type: 'private_key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    riskLevel: 'critical',
    description: 'PEM 格式私钥',
  },

  // ── 信用卡号（medium，需 Luhn 校验）─────────────────────────────────
  {
    type: 'credit_card',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    riskLevel: 'medium',
    description: '信用卡号（Luhn 校验）',
  },

  // ── SSN 美国社会安全号（medium）─────────────────────────────────────
  {
    type: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    riskLevel: 'medium',
    description: '美国社会安全号（SSN）',
  },

  // ── 邮箱地址（low）──────────────────────────────────────────────────
  {
    type: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    riskLevel: 'low',
    description: '邮箱地址',
  },

  // ── 电话号码（low）──────────────────────────────────────────────────
  {
    type: 'phone_number',
    pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    riskLevel: 'low',
    description: '电话号码（美国格式）',
  },
  {
    type: 'phone_number',
    pattern: /\b1[3-9]\d{9}\b/g,
    riskLevel: 'low',
    description: '手机号码（中国格式）',
  },

  // ── 内网 IP 地址（low）──────────────────────────────────────────────
  {
    type: 'internal_ip',
    pattern: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    riskLevel: 'low',
    description: '内网 IP（10.x.x.x）',
  },
  {
    type: 'internal_ip',
    pattern: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
    riskLevel: 'low',
    description: '内网 IP（172.16-31.x.x）',
  },
  {
    type: 'internal_ip',
    pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
    riskLevel: 'low',
    description: '内网 IP（192.168.x.x）',
  },
  {
    type: 'internal_ip',
    pattern: /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    riskLevel: 'low',
    description: '环回 IP（127.x.x.x）',
  },

  // ── 数据库连接字符串（high）─────────────────────────────────────────
  {
    type: 'database_connection_string',
    pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|sqlite):\/\/[^\s"'<>]+/gi,
    riskLevel: 'high',
    description: '数据库连接字符串',
  },

  // ── AWS 凭证（critical）─────────────────────────────────────────────
  {
    type: 'aws_credential',
    pattern: /AKIA[0-9A-Z]{16}/g,
    riskLevel: 'critical',
    description: 'AWS Access Key ID',
  },
  {
    type: 'aws_credential',
    pattern: /ASIA[0-9A-Z]{16}/g,
    riskLevel: 'critical',
    description: 'AWS STS 临时密钥',
  },
  {
    type: 'aws_credential',
    pattern: /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi,
    riskLevel: 'critical',
    description: 'AWS 凭证配置项',
  },

  // ── GCP 凭证（critical）─────────────────────────────────────────────
  {
    type: 'gcp_credential',
    pattern: /"type"\s*:\s*"service_account"/gi,
    riskLevel: 'critical',
    description: 'GCP 服务账号 JSON',
  },
  {
    type: 'gcp_credential',
    pattern: /GOOGLE_APPLICATION_CREDENTIALS\s*[:=]\s*['"]?[^\s'"]+['"]?/gi,
    riskLevel: 'critical',
    description: 'GCP 应用凭证环境变量',
  },

  // ── Azure 凭证（critical）───────────────────────────────────────────
  {
    type: 'azure_credential',
    pattern: /AZURE_(?:CLIENT_SECRET|SUBSCRIPTION_KEY|STORAGE_KEY)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi,
    riskLevel: 'critical',
    description: 'Azure 凭证配置项',
  },
  {
    type: 'azure_credential',
    pattern: /DefaultEndpointsProtocol=https?;[^;\s]*;AccountKey=[A-Za-z0-9+/=]+/gi,
    riskLevel: 'critical',
    description: 'Azure 存储连接字符串',
  },

  // ── 中国身份证号（medium，需校验码验证）─────────────────────────────
  {
    type: 'chinese_id',
    pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    riskLevel: 'medium',
    description: '中国居民身份证号（18位）',
  },

  // ── 银行账号（medium）───────────────────────────────────────────────
  {
    type: 'bank_account',
    pattern:
      /(?:账号|账户|卡号|银行|account(?:\s*number)?|bank(?:\s*account)?)\s*[:：=]?\s*\d{15,19}/gi,
    riskLevel: 'medium',
    description: '银行账号',
  },
];

// ============================================================================
// 默认脱敏策略映射
// ============================================================================

/**
 * 默认的敏感数据类型 → 脱敏策略映射。
 * 凭证类（API 密钥、私钥、云凭证、连接字符串）默认 REDACT；
 * PII 类（邮箱、电话、信用卡等）默认 MASK。
 */
const DEFAULT_STRATEGY_MAP: Record<SensitiveDataType, RedactionStrategy> = {
  api_key: 'REDACT',
  jwt_token: 'REDACT',
  private_key: 'REDACT',
  credit_card: 'MASK',
  ssn: 'MASK',
  email: 'MASK',
  phone_number: 'MASK',
  internal_ip: 'MASK',
  database_connection_string: 'REDACT',
  aws_credential: 'REDACT',
  gcp_credential: 'REDACT',
  azure_credential: 'REDACT',
  chinese_id: 'MASK',
  bank_account: 'MASK',
};

// ============================================================================
// 默认配置
// ============================================================================

const ALL_TYPES: SensitiveDataType[] = [
  'api_key',
  'jwt_token',
  'private_key',
  'credit_card',
  'ssn',
  'email',
  'phone_number',
  'internal_ip',
  'database_connection_string',
  'aws_credential',
  'gcp_credential',
  'azure_credential',
  'chinese_id',
  'bank_account',
];

const DEFAULT_CONFIG: DLPConfig = {
  enabled: true,
  patterns: DEFAULT_PATTERNS,
  strategyMap: DEFAULT_STRATEGY_MAP,
  enabledTypes: [...ALL_TYPES],
  exitPoints: {
    api_response: true,
    log_output: true,
    tool_result: true,
    agent_output: true,
    sse_event: true,
  },
  maxContentLength: 500_000,
  auditEnabled: true,
  blockOnCritical: false,
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建一个新的 RegExp 实例（避免全局正则的 lastIndex 复用问题）。
 * @param pattern - 源正则表达式
 * @returns 具有相同 source 和 flags 的新 RegExp 实例
 */
function freshRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/**
 * Luhn 算法校验（用于信用卡号验证）。
 * @param input - 可能包含分隔符的数字字符串
 * @returns 是否通过 Luhn 校验
 */
function luhnCheck(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let isEven = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i]!, 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

/**
 * 中国身份证号校验码验证（GB 11643-1999）。
 * @param id - 18 位身份证号字符串
 * @returns 是否通过校验码验证
 */
function chineseIdCheck(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(id[i]!, 10) * weights[i]!;
  }

  const expectedCheck = checkCodes[sum % 11];
  const actualCheck = id[17]!.toUpperCase();

  return expectedCheck === actualCheck;
}

// ============================================================================
// DataLossPrevention 类
// ============================================================================

/**
 * 数据泄露防护核心类。
 *
 * 提供敏感数据检测、脱敏、审计和阻止功能。
 * 支持多租户隔离，通过 `createTenantAwareSingleton` 实现每租户独立实例。
 *
 * 核心方法：
 * - `scan(content, exitPoint?)` — 扫描内容，返回完整的扫描结果
 * - `sanitize(content, strategy?, exitPoint?)` — 扫描并脱敏，返回脱敏后的字符串
 * - `sanitizeSSEEvent(event)` — 脱敏 SSE 事件
 * - `sanitizeLogEntry(entry)` — 脱敏日志条目
 * - `sanitizeToolResult(result)` — 脱敏工具调用结果
 * - `sanitizeAgentOutput(output)` — 脱敏 Agent 输出
 */
export class DataLossPrevention {
  private config: DLPConfig;
  private effectivePatterns: SensitiveDataPattern[];
  private stats: DLPStats;

  /**
   * 创建 DLP 实例。
   * @param config - 可选的部分配置，将与默认配置合并
   */
  constructor(config?: Partial<DLPConfig>) {
    // Apply security profile defaults first, then explicit config overrides.
    // The profile controls which DLP types are enabled by default:
    //   dev/standard → common types only (credentials, PII, network)
    //   strict       → all 14 types (incl. industry-specific: SSN, CN ID, bank)
    const profile = getSecurityProfileConfig();
    this.config = {
      ...DEFAULT_CONFIG,
      enabledTypes: profile.dlpEnabledTypes as SensitiveDataType[],
      ...config,
    };
    this.effectivePatterns = this.buildEffectivePatterns();
    this.stats = {
      totalScans: 0,
      totalLeaksDetected: 0,
      totalBlocked: 0,
      byType: {},
      byExitPoint: {},
      byRiskLevel: { none: 0, low: 0, medium: 0, high: 0, critical: 0 },
    };
  }

  // ── 公开 API ──────────────────────────────────────────────────────

  /**
   * 更新 DLP 配置（运行时热更新）。
   * @param config - 部分配置，将与当前配置合并
   */
  configure(config: Partial<DLPConfig>): void {
    this.config = { ...this.config, ...config };
    this.effectivePatterns = this.buildEffectivePatterns();
  }

  /**
   * 检查 DLP 是否已启用。
   * @returns DLP 是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 扫描内容，检测敏感数据并返回完整的扫描结果。
   *
   * 扫描流程：
   * 1. 检查 DLP 是否启用及出口点是否启用
   * 2. 截断超长内容（DoS 防护）
   * 3. 逐模式匹配敏感数据
   * 4. 验证匹配结果（Luhn 校验、身份证校验码）
   * 5. 解决重叠匹配（保留高风险匹配）
   * 6. 应用脱敏策略生成脱敏内容
   * 7. 计算整体风险等级
   * 8. 记录审计日志和指标
   *
   * @param content - 要扫描的内容字符串
   * @param exitPoint - 触发扫描的出口点（可选）
   * @returns DLP 扫描结果
   */
  scan(content: string, exitPoint?: DLPExitPoint): DLPScanResult {
    const startTime = Date.now();

    // DLP 未启用或内容为空
    if (!this.config.enabled || !content || content.length === 0) {
      return {
        isClean: true,
        matches: [],
        sanitizedContent: content,
        riskLevel: 'none',
        exitPoint,
        scanDurationMs: 0,
        blocked: false,
      };
    }

    // 检查出口点是否启用
    if (exitPoint && this.config.exitPoints[exitPoint] === false) {
      return {
        isClean: true,
        matches: [],
        sanitizedContent: content,
        riskLevel: 'none',
        exitPoint,
        scanDurationMs: 0,
        blocked: false,
      };
    }

    // 截断超长内容（DoS 防护）
    const scanTarget =
      content.length > this.config.maxContentLength
        ? content.slice(0, this.config.maxContentLength)
        : content;

    // 检测所有匹配
    const matches = this.detectMatches(scanTarget);

    // 构建脱敏内容
    const sanitizedContent = this.buildSanitizedContent(scanTarget, matches);

    // 计算整体风险等级
    const riskLevel = this.computeRiskLevel(matches);

    // 判断是否阻止
    const blocked = this.config.blockOnCritical && riskLevel === 'critical';

    // 记录审计和指标
    if (matches.length > 0) {
      this.logLeakEvent(matches, exitPoint, riskLevel);
      this.recordMetrics(matches, exitPoint, riskLevel);
    }

    // 更新统计
    this.updateStats(matches, exitPoint, riskLevel, blocked);

    return {
      isClean: matches.length === 0,
      matches,
      sanitizedContent,
      riskLevel,
      exitPoint,
      scanDurationMs: Date.now() - startTime,
      blocked,
    };
  }

  /**
   * 扫描并脱敏内容，返回脱敏后的字符串。
   *
   * 如果指定了 `strategy`，则对所有检测到的敏感数据统一应用该策略；
   * 否则使用配置中的按类型策略映射。
   *
   * @param content - 要脱敏的内容字符串
   * @param strategy - 指定脱敏策略（可选，覆盖配置中的按类型策略）
   * @param exitPoint - 触发脱敏的出口点（可选）
   * @returns 脱敏后的内容字符串
   */
  sanitize(content: string, strategy?: RedactionStrategy, exitPoint?: DLPExitPoint): string {
    if (!this.config.enabled || !content || content.length === 0) {
      return content;
    }

    // 检查出口点是否启用
    if (exitPoint && this.config.exitPoints[exitPoint] === false) {
      return content;
    }

    const scanTarget =
      content.length > this.config.maxContentLength
        ? content.slice(0, this.config.maxContentLength)
        : content;

    const matches = this.detectMatches(scanTarget);

    if (matches.length === 0) {
      return content;
    }

    // 如果指定了统一策略，重新应用
    const matchesToUse: SensitiveDataMatch[] = strategy
      ? matches.map((m) => ({
          ...m,
          redactedValue: this.applyStrategy(m.value, m.type, strategy),
        }))
      : matches;

    const riskLevel = this.computeRiskLevel(matches);

    // 记录审计和指标
    this.logLeakEvent(matchesToUse, exitPoint, riskLevel);
    this.recordMetrics(matchesToUse, exitPoint, riskLevel);
    this.updateStats(matchesToUse, exitPoint, riskLevel, false);

    return this.buildSanitizedContent(scanTarget, matchesToUse);
  }

  /**
   * 脱敏 SSE 事件流中的敏感数据。
   * @param event - SSE 事件字符串（如 `data: {...}\n\n`）
   * @returns 脱敏后的 SSE 事件字符串
   */
  sanitizeSSEEvent(event: string): string {
    return this.sanitize(event, undefined, 'sse_event');
  }

  /**
   * 脱敏日志条目中的敏感数据。
   * @param entry - 日志条目字符串
   * @returns 脱敏后的日志条目字符串
   */
  sanitizeLogEntry(entry: string): string {
    return this.sanitize(entry, undefined, 'log_output');
  }

  /**
   * 脱敏工具调用结果中的敏感数据。
   * @param result - 工具调用结果对象（必须包含 output 字段）
   * @returns 脱敏后的工具调用结果对象
   */
  sanitizeToolResult<T extends { output: string; error?: string }>(result: T): T {
    if (result.error) return result;
    return { ...result, output: this.sanitize(result.output, undefined, 'tool_result') };
  }

  /**
   * 脱敏 Agent 输出中的敏感数据。
   * @param output - Agent 输出字符串
   * @returns 脱敏后的 Agent 输出字符串
   */
  sanitizeAgentOutput(output: string): string {
    return this.sanitize(output, undefined, 'agent_output');
  }

  /**
   * 快速检查内容是否包含敏感数据（不执行脱敏，不记录审计）。
   * @param content - 要检查的内容字符串
   * @returns 是否包含敏感数据
   */
  containsSensitiveData(content: string): boolean {
    if (!this.config.enabled || !content) return false;

    const scanTarget =
      content.length > this.config.maxContentLength
        ? content.slice(0, this.config.maxContentLength)
        : content;

    for (const pattern of this.effectivePatterns) {
      const regex = freshRegex(pattern.pattern);
      regex.lastIndex = 0;
      if (regex.test(scanTarget)) {
        // 对于需要验证的类型，确认匹配有效
        const match = scanTarget.match(regex);
        if (match && this.isValidMatch(match[0], pattern.type)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 获取 DLP 统计信息。
   * @returns 当前统计信息的快照
   */
  getStats(): DLPStats {
    return {
      totalScans: this.stats.totalScans,
      totalLeaksDetected: this.stats.totalLeaksDetected,
      totalBlocked: this.stats.totalBlocked,
      byType: { ...this.stats.byType },
      byExitPoint: { ...this.stats.byExitPoint },
      byRiskLevel: { ...this.stats.byRiskLevel },
    };
  }

  /**
   * 重置统计信息。
   */
  resetStats(): void {
    this.stats = {
      totalScans: 0,
      totalLeaksDetected: 0,
      totalBlocked: 0,
      byType: {},
      byExitPoint: {},
      byRiskLevel: { none: 0, low: 0, medium: 0, high: 0, critical: 0 },
    };
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 构建生效的检测模式列表（根据 enabledTypes 过滤）。
   * @returns 过滤后的检测模式列表
   */
  private buildEffectivePatterns(): SensitiveDataPattern[] {
    const enabledSet = new Set(this.config.enabledTypes);
    return this.config.patterns.filter((p) => enabledSet.has(p.type));
  }

  /**
   * 检测内容中的所有敏感数据匹配。
   * @param content - 要检测的内容字符串
   * @returns 敏感数据匹配列表（已解决重叠）
   */
  private detectMatches(content: string): SensitiveDataMatch[] {
    const matches: SensitiveDataMatch[] = [];

    for (const pattern of this.effectivePatterns) {
      const regex = freshRegex(pattern.pattern);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const matchedValue = match[0];

        // 验证匹配（Luhn 校验、身份证校验码等）
        if (!this.isValidMatch(matchedValue, pattern.type)) {
          continue;
        }

        const strategy = this.getStrategy(pattern.type);
        const redactedValue = this.applyStrategy(matchedValue, pattern.type, strategy);

        matches.push({
          type: pattern.type,
          value: matchedValue,
          position: { start: match.index, end: match.index + matchedValue.length },
          redactedValue,
          riskLevel: pattern.riskLevel,
        });
      }
    }

    // 解决重叠匹配
    return this.resolveOverlaps(matches);
  }

  /**
   * 验证匹配是否有效（减少误报）。
   * @param value - 匹配到的值
   * @param type - 敏感数据类型
   * @returns 匹配是否有效
   */
  private isValidMatch(value: string, type: SensitiveDataType): boolean {
    switch (type) {
      case 'credit_card':
        return luhnCheck(value);
      case 'chinese_id':
        return chineseIdCheck(value);
      case 'bank_account': {
        // 银行账号不应通过 Luhn 校验（否则可能是信用卡）
        const digits = value.replace(/\D/g, '');
        return digits.length >= 15 && digits.length <= 19 && !luhnCheck(digits);
      }
      default:
        return true;
    }
  }

  /**
   * 解决重叠匹配：当多个模式匹配同一段文本时，保留风险等级更高、更长的匹配。
   * @param matches - 原始匹配列表
   * @returns 解决重叠后的匹配列表
   */
  private resolveOverlaps(matches: SensitiveDataMatch[]): SensitiveDataMatch[] {
    if (matches.length <= 1) return matches;

    const riskOrder: Record<DLPRiskLevel, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      none: 0,
    };

    // 按起始位置排序，然后按长度降序，最后按风险等级降序
    const sorted = [...matches].sort((a, b) => {
      if (a.position.start !== b.position.start) {
        return a.position.start - b.position.start;
      }
      const lenA = a.position.end - a.position.start;
      const lenB = b.position.end - b.position.start;
      if (lenA !== lenB) return lenB - lenA;
      return riskOrder[b.riskLevel] - riskOrder[a.riskLevel];
    });

    const result: SensitiveDataMatch[] = [];
    let lastEnd = -1;

    for (const m of sorted) {
      if (m.position.start >= lastEnd) {
        result.push(m);
        lastEnd = m.position.end;
      }
      // 重叠的匹配被跳过（保留更高优先级的匹配）
    }

    // 按位置排序返回
    return result.sort((a, b) => a.position.start - b.position.start);
  }

  /**
   * 获取指定敏感数据类型的脱敏策略。
   * @param type - 敏感数据类型
   * @returns 脱敏策略（默认 MASK）
   */
  private getStrategy(type: SensitiveDataType): RedactionStrategy {
    return this.config.strategyMap[type] ?? 'MASK';
  }

  /**
   * 应用脱敏策略到匹配值。
   * @param value - 原始匹配值
   * @param type - 敏感数据类型
   * @param strategy - 脱敏策略
   * @returns 脱敏后的替换值
   */
  private applyStrategy(
    value: string,
    type: SensitiveDataType,
    strategy: RedactionStrategy,
  ): string {
    switch (strategy) {
      case 'REDACT':
        return '[REDACTED]';

      case 'MASK':
        return this.maskValue(value, type);

      case 'HASH':
        return `[HASH:${this.hashValue(value)}]`;

      case 'ALLOW':
        // 允许通过，返回原始值（事件仍会被记录）
        return value;

      default:
        return '[REDACTED]';
    }
  }

  /**
   * 对匹配值进行部分遮蔽（保留部分信息用于识别）。
   * @param value - 原始匹配值
   * @param type - 敏感数据类型
   * @returns 遮蔽后的值
   */
  private maskValue(value: string, type: SensitiveDataType): string {
    switch (type) {
      case 'api_key': {
        // 保留前缀 + **** + 后4位
        if (value.length <= 8) return '****';
        const prefixMatch = value.match(/^[a-zA-Z]+[-_]/);
        const prefix = prefixMatch ? prefixMatch[0] : value.slice(0, 3);
        return `${prefix}****${value.slice(-4)}`;
      }

      case 'jwt_token':
        return 'eyJ****.****.****';

      case 'private_key':
        return '-----BEGIN [REDACTED PRIVATE KEY]-----';

      case 'credit_card': {
        // 保留后4位
        const digits = value.replace(/\D/g, '');
        return `****-****-****-${digits.slice(-4)}`;
      }

      case 'ssn':
        // 保留后4位
        return `***-**-${value.slice(-4)}`;

      case 'email': {
        // 保留首字符 + *** + @域名
        const atIndex = value.indexOf('@');
        if (atIndex <= 0) return '****';
        const local = value.slice(0, atIndex);
        const domain = value.slice(atIndex);
        return `${local[0]}***${domain}`;
      }

      case 'phone_number':
        // 保留后4位
        return `***-***-${value.slice(-4)}`;

      case 'internal_ip': {
        // 保留首段和末段
        const parts = value.split('.');
        if (parts.length === 4) {
          return `${parts[0]}.***.***.${parts[3]}`;
        }
        return '***.***.***.***';
      }

      case 'database_connection_string':
        // 遮蔽 URI 中的凭证部分
        return value.replace(/\/\/[^@]+@/, '//****:****@');

      case 'aws_credential':
      case 'gcp_credential':
      case 'azure_credential': {
        // 保留前4位 + **** + 后4位
        if (value.length <= 8) return '****';
        return `${value.slice(0, 4)}****${value.slice(-4)}`;
      }

      case 'chinese_id':
        // 保留地区码 + ******** + 校验位
        return `${value.slice(0, 6)}********${value.slice(-1)}`;

      case 'bank_account': {
        // 保留后4位
        const digits = value.replace(/\D/g, '');
        return `****${digits.slice(-4)}`;
      }

      default:
        return '****';
    }
  }

  /**
   * 计算匹配值的 SHA-256 哈希前8位。
   * @param value - 原始值
   * @returns 哈希前8位十六进制字符串
   */
  private hashValue(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  }

  /**
   * 计算所有匹配的整体风险等级（取最高等级）。
   * @param matches - 匹配列表
   * @returns 整体风险等级
   */
  private computeRiskLevel(matches: SensitiveDataMatch[]): DLPRiskLevel {
    if (matches.length === 0) return 'none';

    const riskOrder: DLPRiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
    let maxIndex = 0;

    for (const m of matches) {
      const idx = riskOrder.indexOf(m.riskLevel);
      if (idx > maxIndex) maxIndex = idx;
    }

    return riskOrder[maxIndex] ?? 'none';
  }

  /**
   * 根据匹配列表构建脱敏后的内容。
   * 从右向左替换以保持位置索引正确。
   * @param content - 原始内容
   * @param matches - 匹配列表（按位置排序）
   * @returns 脱敏后的内容
   */
  private buildSanitizedContent(content: string, matches: SensitiveDataMatch[]): string {
    if (matches.length === 0) return content;

    let result = content;
    // 从右向左替换，避免位置偏移
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!;
      result = result.slice(0, m.position.start) + m.redactedValue + result.slice(m.position.end);
    }
    return result;
  }

  /**
   * 通过 SecurityAuditLogger 记录泄露事件。
   * @param matches - 检测到的匹配列表
   * @param exitPoint - 出口点
   * @param riskLevel - 整体风险等级
   */
  private logLeakEvent(
    matches: SensitiveDataMatch[],
    exitPoint: DLPExitPoint | undefined,
    riskLevel: DLPRiskLevel,
  ): void {
    if (!this.config.auditEnabled) return;

    try {
      const audit = getSecurityAuditLogger();
      const types = [...new Set(matches.map((m) => m.type))];

      const severityMap: Record<DLPRiskLevel, 'low' | 'medium' | 'high' | 'critical'> = {
        none: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        critical: 'critical',
      };

      audit.logEvent({
        type: 'content_threat',
        severity: severityMap[riskLevel],
        source: 'DataLossPrevention',
        message: `检测到 ${matches.length} 个敏感数据泄露（类型: ${types.join(', ')}）`,
        details: {
          exitPoint: exitPoint ?? 'unknown',
          riskLevel,
          matchCount: matches.length,
          types,
          matches: matches.map((m) => ({
            type: m.type,
            position: m.position,
            riskLevel: m.riskLevel,
            redactedValue: m.redactedValue,
          })),
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'dataLossPrevention:logLeakEvent');
    }

    // 同时记录到全局日志
    try {
      const logger = getGlobalLogger();
      const logContext = {
        exitPoint: exitPoint ?? 'unknown',
        riskLevel,
        matchCount: matches.length,
        types: [...new Set(matches.map((m) => m.type))],
      };

      switch (riskLevel) {
        case 'critical':
          logger.critical('DLP', `检测到 critical 级别敏感数据泄露`, logContext);
          break;
        case 'high':
          logger.error('DLP', `检测到 high 级别敏感数据泄露`, undefined, logContext);
          break;
        case 'medium':
          logger.warn('DLP', `检测到 medium 级别敏感数据泄露`, logContext);
          break;
        case 'low':
          logger.info('DLP', `检测到 low 级别敏感数据泄露`, logContext);
          break;
        default:
          logger.debug('DLP', `DLP 扫描完成`, logContext);
      }
    } catch (err) {
      reportSilentFailure(err, 'dataLossPrevention:logToGlobal');
    }
  }

  /**
   * 记录 DLP 指标到全局 MetricsCollector。
   * @param matches - 检测到的匹配列表
   * @param exitPoint - 出口点
   * @param riskLevel - 整体风险等级
   */
  private recordMetrics(
    matches: SensitiveDataMatch[],
    exitPoint: DLPExitPoint | undefined,
    riskLevel: DLPRiskLevel,
  ): void {
    try {
      const metrics = getGlobalMetrics();
      const ep = exitPoint ?? 'unknown';

      metrics.incrementCounter('dlp.leaks.detected', matches.length, {
        exit_point: ep,
        risk_level: riskLevel,
      });

      for (const match of matches) {
        metrics.incrementCounter('dlp.leaks.by_type', 1, {
          type: match.type,
          exit_point: ep,
        });
      }
    } catch (err) {
      reportSilentFailure(err, 'dataLossPrevention:recordMetrics');
    }
  }

  /**
   * 更新内部统计信息。
   * @param matches - 检测到的匹配列表
   * @param exitPoint - 出口点
   * @param riskLevel - 整体风险等级
   * @param blocked - 是否被阻止
   */
  private updateStats(
    matches: SensitiveDataMatch[],
    exitPoint: DLPExitPoint | undefined,
    riskLevel: DLPRiskLevel,
    blocked: boolean,
  ): void {
    this.stats.totalScans++;
    this.stats.totalLeaksDetected += matches.length;
    if (blocked) this.stats.totalBlocked++;

    for (const match of matches) {
      this.stats.byType[match.type] = (this.stats.byType[match.type] ?? 0) + 1;
    }

    if (exitPoint) {
      this.stats.byExitPoint[exitPoint] = (this.stats.byExitPoint[exitPoint] ?? 0) + matches.length;
    }

    this.stats.byRiskLevel[riskLevel]++;
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 扫描任意内容，检测敏感数据。
 * 使用全局 DLP 单例实例执行扫描。
 *
 * @param content - 要扫描的内容字符串
 * @param exitPoint - 触发扫描的出口点（可选）
 * @returns DLP 扫描结果
 *
 * @example
 * ```typescript
 * const result = scanContent('我的 API key 是 sk-abc123...');
 * if (!result.isClean) {
 *   console.log(`检测到 ${result.matches.length} 个敏感数据，风险等级: ${result.riskLevel}`);
 * }
 * ```
 */
export function scanContent(content: string, exitPoint?: DLPExitPoint): DLPScanResult {
  return getDataLossPrevention().scan(content, exitPoint);
}

/**
 * 脱敏任意内容，返回脱敏后的字符串。
 * 使用全局 DLP 单例实例执行脱敏。
 *
 * @param content - 要脱敏的内容字符串
 * @param strategy - 脱敏策略（REDACT / MASK / HASH / ALLOW）
 * @returns 脱敏后的内容字符串
 *
 * @example
 * ```typescript
 * const safe = sanitizeContent('联系我: user@example.com', 'MASK');
 * // '联系我: u***@example.com'
 *
 * const redacted = sanitizeContent('sk-abc123def456', 'REDACT');
 * // '[REDACTED]'
 * ```
 */
export function sanitizeContent(content: string, strategy: RedactionStrategy): string {
  return getDataLossPrevention().sanitize(content, strategy);
}

// ============================================================================
// Express 中间件
// ============================================================================

/**
 * Express 中间件：拦截 HTTP 响应体，扫描并脱敏敏感数据。
 *
 * 工作原理：
 * 1. 包装 `res.write` 和 `res.end` 方法
 * 2. 缓冲文本类响应（JSON、HTML、XML、纯文本）
 * 3. 在响应发送前扫描内容
 * 4. 如果检测到敏感数据，用脱敏内容替换响应体
 * 5. 如果 `blockOnCritical` 为 true 且风险等级为 critical，返回 403
 * 6. 更新 Content-Length 头
 *
 * @param options - 中间件选项
 * @returns Express 中间件函数
 *
 * @example
 * ```typescript
 * import express from 'express';
 * const app = express();
 * app.use(dlpResponseMiddleware());
 * ```
 */
export function dlpResponseMiddleware(
  options?: DLPMiddlewareOptions,
): (req: unknown, res: unknown, next: (err?: unknown) => void) => void {
  const exitPoint = options?.exitPoint ?? 'api_response';
  const blockOnCritical = options?.blockOnCritical;
  const contentTypes = options?.contentTypes ?? ['json', 'text', 'xml', 'html', 'event-stream'];

  return (req: unknown, res: unknown, next: (err?: unknown) => void): void => {
    const dlp = getDataLossPrevention();

    // DLP 未启用，直接放行
    if (!dlp.isEnabled()) {
      next();
      return;
    }

    // 使用类型断言访问响应方法
    const response = res as {
      write: (chunk: unknown, ...args: unknown[]) => boolean;
      end: (chunk?: unknown, ...args: unknown[]) => unknown;
      setHeader: (name: string, value: string | number | readonly string[]) => unknown;
      getHeader: (name: string) => string | number | readonly string[] | undefined;
      statusCode?: number;
      headersSent?: boolean;
    };

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    const chunks: Buffer[] = [];

    /**
     * 检查响应内容类型是否需要扫描。
     */
    const shouldIntercept = (): boolean => {
      const contentType = response.getHeader('content-type');
      if (!contentType) return true; // 默认拦截
      const ct = String(contentType).toLowerCase();
      return contentTypes.some((t) => ct.includes(t));
    };

    /**
     * 将 chunk 转换为 Buffer。
     */
    const toBuffer = (chunk: unknown): Buffer | null => {
      if (chunk === undefined || chunk === null) return null;
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof chunk === 'string') return Buffer.from(chunk, 'utf-8');
      if (chunk instanceof Uint8Array) return Buffer.from(chunk);
      return null;
    };

    // 包装 res.write
    response.write = function (chunk: unknown, ...args: unknown[]): boolean {
      if (shouldIntercept()) {
        const buf = toBuffer(chunk);
        if (buf) {
          chunks.push(buf);
          return true; // 延迟实际写入
        }
      }
      return originalWrite(chunk, ...args);
    };

    // 包装 res.end
    response.end = function (chunk?: unknown, ...args: unknown[]): unknown {
      // 收集最后的数据块
      if (chunk !== undefined && chunk !== null) {
        const buf = toBuffer(chunk);
        if (buf && shouldIntercept()) {
          chunks.push(buf);
        }
      }

      if (shouldIntercept() && chunks.length > 0) {
        const body = Buffer.concat(chunks).toString('utf-8');
        const result = dlp.scan(body, exitPoint);

        if (!result.isClean) {
          // 检查是否需要阻止
          const shouldBlock =
            (blockOnCritical ?? dlp['config'].blockOnCritical) && result.riskLevel === 'critical';

          if (shouldBlock) {
            // 阻止响应：返回 403
            const blockBody = JSON.stringify({
              error: 'DataLossPrevention: 响应包含 critical 级别敏感数据，已被阻止',
              riskLevel: result.riskLevel,
              matchCount: result.matches.length,
            });
            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.setHeader('content-length', String(Buffer.byteLength(blockBody, 'utf-8')));
            if ('statusCode' in response) {
              response.statusCode = 403;
            }
            return originalEnd(Buffer.from(blockBody, 'utf-8'));
          }

          // 用脱敏内容替换响应体
          const sanitized = Buffer.from(result.sanitizedContent, 'utf-8');
          response.setHeader('content-length', String(sanitized.length));
          return originalEnd(sanitized);
        }
      }

      // 无敏感数据或非文本响应，正常发送
      if (chunks.length > 0 && shouldIntercept()) {
        // 重新发送缓冲的数据
        const body = Buffer.concat(chunks);
        response.setHeader('content-length', String(body.length));
        return originalEnd(body);
      }

      return originalEnd(chunk, ...args);
    };

    next();
  };
}

// ============================================================================
// SSE 和日志脱敏便捷函数
// ============================================================================

/**
 * 脱敏 SSE 事件流中的敏感数据。
 * 使用全局 DLP 单例实例。
 *
 * @param event - SSE 事件字符串
 * @returns 脱敏后的 SSE 事件字符串
 *
 * @example
 * ```typescript
 * const safeEvent = sanitizeSSEEvent('data: {"token": "sk-abc123..."}\n\n');
 * ```
 */
export function sanitizeSSEEvent(event: string): string {
  return getDataLossPrevention().sanitizeSSEEvent(event);
}

/**
 * 脱敏日志条目中的敏感数据。
 * 使用全局 DLP 单例实例。
 *
 * @param entry - 日志条目字符串
 * @returns 脱敏后的日志条目字符串
 *
 * @example
 * ```typescript
 * const safeLog = sanitizeLogEntry('User logged in with password: secret123');
 * ```
 */
export function sanitizeLogEntry(entry: string): string {
  return getDataLossPrevention().sanitizeLogEntry(entry);
}

/**
 * 脱敏工具调用结果中的敏感数据。
 * 使用全局 DLP 单例实例。
 *
 * @param result - 工具调用结果对象
 * @returns 脱敏后的工具调用结果对象
 */
export function sanitizeToolResult<T extends { output: string; error?: string }>(result: T): T {
  return getDataLossPrevention().sanitizeToolResult(result);
}

/**
 * 脱敏 Agent 输出中的敏感数据。
 * 使用全局 DLP 单例实例。
 *
 * @param output - Agent 输出字符串
 * @returns 脱敏后的 Agent 输出字符串
 */
export function sanitizeAgentOutput(output: string): string {
  return getDataLossPrevention().sanitizeAgentOutput(output);
}

// ============================================================================
// 多租户单例
// ============================================================================

const dlpSingleton = createTenantAwareSingleton(() => new DataLossPrevention(), {
  componentName: 'DataLossPrevention',
});

/**
 * 获取全局 DLP 单例实例（多租户感知）。
 *
 * 在租户上下文中返回该租户的独立实例；
 * 在非租户上下文中返回全局回退实例。
 *
 * @returns DataLossPrevention 实例
 */
export function getDataLossPrevention(): DataLossPrevention {
  return dlpSingleton.get();
}

/**
 * 重置 DLP 单例（释放所有租户实例）。
 * 主要用于测试环境。
 */
export function resetDataLossPrevention(): void {
  dlpSingleton.reset();
}
