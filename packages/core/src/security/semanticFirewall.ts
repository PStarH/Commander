/**
 * SemanticFirewall — 语义防火墙：技能 / 程序性记忆写入前校验
 *
 * 填补 OWASP ASI06（Agent 供应链）/ ASI07（Agent 记忆投毒）分析中识别出的
 * "程序性 / 技能记忆缺少语义级写入前校验" 防御缺口。既有的
 * `memoryPoisoningGate.ts` 仅做正则匹配，无法识别语义层面的越权行为
 * （例如：一段看似无害的 SOP 文本，语义上却在指示 Agent 持久化驻留或
 * 隐蔽外发数据）。本防火墙在写盘之前引入 5 层纵深防御，并在核心层接入
 * 可选的 LLM 语义分析回调。
 *
 * 五层防御：
 *   Layer 1  内容净化门 (sanitizeContent)         —— 在分析前剥离注入标记
 *   Layer 2  来源溯源 (trackProvenance)           —— 记录技能来源链与信任等级
 *   Layer 3  写入前校验门 (validateBeforeWrite)   —— 核心防御：正则 + 语义双门
 *   Layer 4  隔离区 (quarantine)                  —— 被拦截内容进入隔离，永不自动激活
 *   Layer 5  审计日志 (logWriteAttempt)           —— JSONL 记录所有写入尝试
 *
 * 核心设计原则：
 *   - fail-closed（失败即拒绝）：语义分析回调抛错或返回非法数据时，默认拒绝。
 *   - 双门校验：正则门与语义门必须同时通过，任一失败即拦截。
 *   - 低信任来源触发更严格的阈值（来源越不可信，容忍度越低）。
 *   - 审计日志只存 SHA-256 内容哈希，绝不落盘原始内容（隐私优先）。
 *   - 隔离区使用 LRU 淘汰，被隔离技能永不自动激活，需人工审批后方可放行。
 *
 * 使用示例：
 *   import { getSemanticFirewall } from './security/semanticFirewall';
 *   const fw = getSemanticFirewall();
 *   // 注入 LLM 语义分析器（可选，未注入则退化为增强正则模式）
 *   fw.setSemanticAnalyzer(async (content) => ({ ... }));
 *   const result = await fw.validateBeforeWrite({
 *     skillId: 'sop.deploy',
 *     skillName: 'Deploy SOP',
 *     content,
 *     source: 'web_content',
 *     agentId: 'agent-1',
 *     sessionId: 'sess-1',
 *   });
 *   if (result.decision === 'allow') { /* 写入技能记忆 *\/ }
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';

// ============================================================================
// 类型定义
// ============================================================================

/** 技能 / 程序性记忆的来源类型。 */
export type ProvenanceOrigin =
  | 'verified_tool'
  | 'agent_generated'
  | 'user_input'
  | 'web_content'
  | 'tool_output'
  | 'unknown';

/** 信任等级，由来源推导，低信任来源触发更严格的校验。 */
export type TrustLevel = 'high' | 'medium' | 'low' | 'untrusted';

/** 写入决策。 */
export type WriteDecision = 'allow' | 'block' | 'quarantine';

/** 13 类危险行为类别（覆盖 OWASP ASI06/ASI07 主要攻击面）。 */
export type DangerCategory =
  | 'credential_exfiltration'
  | 'data_exfiltration'
  | 'code_execution'
  | 'privilege_escalation'
  | 'persistence'
  | 'network_beaconing'
  | 'filesystem_manipulation'
  | 'process_manipulation'
  | 'env_var_access'
  | 'instruction_injection'
  | 'hidden_channel'
  | 'sandbox_escape'
  | 'self_replication';

/** 来源溯源记录：记录技能从何处来、如何派生、当前版本。 */
export interface ProvenanceRecord {
  /** 技能唯一 ID。 */
  skillId: string;
  /** 来源类型。 */
  origin: ProvenanceOrigin;
  /** 推导出的信任等级。 */
  trustLevel: TrustLevel;
  /** 派生链：技能 A 基于工具 B 的输出，工具 B 读取了 URL C —— 完整记录。 */
  derivationChain: Array<{ source: string; type: string; timestamp: string }>;
  /** 版本号，每次修改自增。 */
  version: number;
  /** 上一版本的 SHA-256 哈希（用于变更追踪）。 */
  previousVersionHash?: string;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 最后修改时间（ISO）。 */
  lastModified: string;
}

/** LLM 语义分析结果（6 维度风险 + 综合）。所有值域 0-1。 */
export interface SemanticAnalysisResult {
  /** 数据外发风险。 */
  data_exfiltration: number;
  /** 持久化驻留风险。 */
  persistence: number;
  /** 能力越权风险（提权 / 越界访问）。 */
  capability_escalation: number;
  /** 指令劫持风险（覆盖系统提示 / 目标）。 */
  instruction_hijack: number;
  /** 隐蔽通道风险。 */
  covert_channel: number;
  /** 用户意图一致性（1 = 完全一致，0 = 完全偏离）。 */
  user_intent_consistency: number;
  /** 综合风险分（0-1）。 */
  overall_risk: number;
  /** LLM 给出的推理说明（可选）。 */
  reasoning?: string;
}

/** LLM 语义分析回调类型。注入后用于 Layer 3 的语义门。 */
export type SemanticAnalyzerCallback = (
  content: string,
  context?: WriteContext,
) => Promise<SemanticAnalysisResult>;

/** 一次写入尝试的完整上下文。 */
export interface WriteContext {
  skillId: string;
  skillName: string;
  content: string;
  source: string;
  provenance?: ProvenanceRecord;
  agentId: string;
  sessionId: string;
}

/** 写入前校验的最终结果。 */
export interface ValidationResult {
  /** 最终决策。 */
  decision: WriteDecision;
  /** 决策原因。 */
  reason: string;
  /** 命中的正则危险模式。 */
  matchedPatterns: Array<{ category: DangerCategory; pattern: string; weight: number }>;
  /** 语义分析结果（仅在使用回调时存在）。 */
  semanticResult?: SemanticAnalysisResult;
  /** 净化后的内容。 */
  sanitizedContent?: string;
  /** 若进入隔离区，对应条目 ID。 */
  quarantinedItemId?: string;
  /** 综合风险分（0-1）。 */
  riskScore: number;
}

/** 隔离区条目。 */
export interface QuarantinedItem {
  /** 条目唯一 ID。 */
  itemId: string;
  /** 被拦截的原始内容。 */
  content: string;
  skillId: string;
  skillName: string;
  source: string;
  provenance?: ProvenanceRecord;
  /** 触发拦截的校验结果。 */
  validationResult: ValidationResult;
  /** 进入隔离区时间（ISO）。 */
  quarantinedAt: string;
  /** 审批人（如有）。 */
  reviewedBy?: string;
  /** 审批时间（如有）。 */
  reviewedAt?: string;
  /** 是否已人工放行。 */
  approved: boolean;
}

/** 审计日志条目（不含原始内容，仅含哈希）。 */
export interface AuditLogEntry {
  timestamp: string;
  skillId: string;
  contentHash: string;
  source: string;
  decision: WriteDecision;
  riskScore: number;
  matchedCategories: DangerCategory[];
  semanticRiskScore?: number;
  reviewer?: string;
}

/** 语义防火墙配置。 */
export interface SemanticFirewallConfig {
  /** 是否启用防火墙（关闭时所有写入直接放行）。 */
  enabled: boolean;
  /** 是否启用隔离区。 */
  quarantineEnabled: boolean;
  /** 隔离区最大容量，满后按 LRU 淘汰。 */
  maxQuarantineSize: number;
  /** 语义分析器抛错 / 返回非法时是否拒绝（fail-closed）。 */
  failClosedOnAnalyzerError: boolean;
  /** 语义风险阈值（0-1），超过即拦截。 */
  semanticRiskThreshold: number;
  /** 正则风险阈值（0-1），超过即拦截。 */
  regexRiskThreshold: number;
  /** 是否启用审计日志。 */
  auditLogEnabled: boolean;
  /** 审计日志内存环缓冲最大条目数。 */
  maxAuditLogEntries: number;
  /** 严格模式：启用更低的拦截阈值与更激进的来源审查。 */
  strictMode: boolean;
}

/** 内容净化结果。 */
export interface SanitizeResult {
  /** 净化后的内容。 */
  sanitized: string;
  /** 被移除 / 标记的条目列表。 */
  removed: Array<{ type: string; detail: string }>;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: SemanticFirewallConfig = {
  enabled: true,
  quarantineEnabled: true,
  maxQuarantineSize: 500,
  failClosedOnAnalyzerError: true,
  semanticRiskThreshold: 0.6,
  regexRiskThreshold: 0.7,
  auditLogEnabled: true,
  maxAuditLogEntries: 10_000,
  strictMode: false,
};

/** 来源 → 信任等级映射。verified_tool 最可信，web_content / unknown 最不可信。 */
const ORIGIN_TRUST: Record<ProvenanceOrigin, TrustLevel> = {
  verified_tool: 'high',
  agent_generated: 'medium',
  user_input: 'medium',
  tool_output: 'medium',
  web_content: 'low',
  unknown: 'untrusted',
};

/** 信任等级 → 阈值收紧系数（越低信任，阈值越低 = 越严格）。 */
const TRUST_THRESHOLD_FACTOR: Record<TrustLevel, number> = {
  high: 1.0,
  medium: 0.9,
  low: 0.75,
  untrusted: 0.6,
};

// ============================================================================
// Layer 1: 内容净化模式
// ============================================================================

/** HTML 注释（可藏匿指令）。 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
/** 零宽 Unicode 字符（可作隐蔽通道 / 隐写）。 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
/** RTL / LTR 覆盖字符（可掩盖真实文本语义）。 */
const RTL_OVERRIDE_RE = /[\u202D\u202E\u202A\u202B\u202C\u2066\u2067\u2068\u2069]/g;
/** Markdown 隐藏注释标记（引用式注释）。 */
const MARKDOWN_HIDDEN_RE = /^\s*\[[^\]]*\]:\s*(#)?\s*.*$/gm;
/** 疑似 Base64 段（长串 Base64 字符，可能编码载荷）。仅标记不移除。 */
const BASE64_RE = /[A-Za-z0-9+/]{60,}={0,2}/g;

// ============================================================================
// Layer 3: 13 类危险模式（每类多条正则 + 权重）
// ============================================================================

interface DangerPattern {
  pattern: RegExp;
  weight: number;
}

const DANGER_PATTERNS: Record<DangerCategory, DangerPattern[]> = {
  credential_exfiltration: [
    {
      pattern:
        /(?:api[_-]?key|secret|token|password|passwd|credential|access[_-]?key)\b[\s\S]{0,40}(?:send|exfiltrate|upload|post|transmit|curl|wget|fetch)\b/i,
      weight: 0.95,
    },
    {
      pattern:
        /(?:send|post|upload|transmit|exfiltrate|leak)\b[\s\S]{0,60}(?:api[_-]?key|secret|token|password|credential)/i,
      weight: 0.95,
    },
    {
      pattern:
        /\b(?:keys?|tokens?|secrets?|credentials?)\b[\s\S]{0,30}\b(?:to|via)\b[\s\S]{0,30}(?:http|url|endpoint|server|webhook)/i,
      weight: 0.85,
    },
    {
      pattern: /(?:echo|print|cat|printf)\s+["'`].*(?:password|secret|token|api[_-]?key)/i,
      weight: 0.8,
    },
  ],
  data_exfiltration: [
    {
      pattern:
        /(?:upload|exfiltrate|post|send|transfer|leak|dump)\b[\s\S]{0,40}(?:sensitive|private|confidential|personal|pii|secret|internal)/i,
      weight: 0.9,
    },
    {
      pattern:
        /(?:curl|wget|fetch|http\.post|requests\.post|axios\.post|urllib)\b[\s\S]{0,60}(?:data|payload|body|files?)/i,
      weight: 0.7,
    },
    {
      pattern: /(?:base64|btoa|encode)\b[\s\S]{0,30}(?:send|upload|post|exfiltrate|transfer)/i,
      weight: 0.8,
    },
    { pattern: /(?:pipe|redirect)\b[\s\S]{0,20}(?:nc|netcat|\/dev\/tcp|\/dev\/udp)/i, weight: 0.9 },
  ],
  code_execution: [
    { pattern: /\beval\s*\(/, weight: 0.9 },
    { pattern: /\b(?:exec|execSync|spawn|spawnSync|execFile|system|popen)\s*\(/, weight: 0.9 },
    {
      pattern: /\b(?:child_process|subprocess|os\.system|os\.popen|commands\.getoutput)\b/,
      weight: 0.9,
    },
    { pattern: /\b(?:rm|chmod|chown|killall|shutdown|reboot)\s+-/, weight: 0.75 },
    { pattern: /`[^`]*\$\([^)]*\)[^`]*`/, weight: 0.7 },
  ],
  privilege_escalation: [
    {
      pattern:
        /(?:grant|give|assign|elevate|enable)\b[\s\S]{0,30}(?:admin|root|sudo|superuser|elevated|full[_-]?access|privileged)/i,
      weight: 0.9,
    },
    { pattern: /\b(?:chmod|chown)\s+[0-7]{3,4}\b/, weight: 0.7 },
    { pattern: /\bsudo\s+/, weight: 0.6 },
    { pattern: /(?:setuid|setgid|cap_add|--privileged|add[_-]?capability|capsh)/i, weight: 0.85 },
  ],
  persistence: [
    {
      pattern: /(?:crontab|cron\s+-|at\s+now|systemctl|launchctl|systemd|timers?)\b/i,
      weight: 0.85,
    },
    {
      pattern: /(?:startup|autostart|boot|login)\b[\s\S]{0,30}(?:script|hook|entry|item)/i,
      weight: 0.8,
    },
    { pattern: /(?:registry|HKLM|HKCU|\\Run\\|\\RunOnce\\|CurrentVersion\\Run)/i, weight: 0.85 },
    { pattern: /\/etc\/(?:rc\.local|init\.d|crontab|profile|cron\.[a-z])\b/, weight: 0.85 },
    {
      pattern: /(?:~\/\.bashrc|~\/\.bash_profile|~\/\.zshrc|~\/\.profile|~\/\.bash_login)/,
      weight: 0.7,
    },
  ],
  network_beaconing: [
    {
      pattern:
        /(?:every|each|periodically|interval|repeat)\b[\s\S]{0,40}(?:ping|beacon|call[_-]?home|check[_-]?in|heartbeat|phone[_-]?home)/i,
      weight: 0.85,
    },
    {
      pattern: /setInterval\s*\([\s\S]{0,80}(?:fetch|http|request|axios|urllib|curl)/i,
      weight: 0.85,
    },
    { pattern: /\b(?:c2|command[_-]?and[_-]?control|beacon|callback[_-]?server)\b/i, weight: 0.8 },
  ],
  filesystem_manipulation: [
    {
      pattern:
        /(?:delete|remove|rm|unlink|rmdir|shutil\.rmtree|os\.remove)\b[\s\S]{0,30}(?:\/etc\/|\/var\/|\/usr\/|\/bin\/|\/boot\/|~\/\.ssh|\/root\/|\/proc\/)/i,
      weight: 0.95,
    },
    {
      pattern:
        /(?:overwrite|replace|modify|append)\b[\s\S]{0,30}(?:\/etc\/|\/var\/|\/usr\/|\/bin\/|passwd|shadow|hosts|sudoers)/i,
      weight: 0.9,
    },
    { pattern: /\brm\s+-rf\b\s*\//, weight: 0.95 },
    { pattern: /(?:format|mkfs|dd\s+if=|shred)/i, weight: 0.9 },
  ],
  process_manipulation: [
    {
      pattern:
        /(?:kill|terminate|pkill|killall|taskkill)\s+-9?\s+(?:-?\d+|python|node|agent|java)/i,
      weight: 0.7,
    },
    {
      pattern: /(?:spawn|fork|exec)\b[\s\S]{0,30}(?:child|subprocess|process|daemon)/i,
      weight: 0.6,
    },
    {
      pattern: /(?:replace|hijack|inject|hook)\b[\s\S]{0,30}(?:process|binary|executable|syscall)/i,
      weight: 0.85,
    },
    {
      pattern: /ptrace|process_vm_readv|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES/i,
      weight: 0.9,
    },
  ],
  env_var_access: [
    {
      pattern:
        /(?:read|get|access|dump|exfiltrate|print)\b[\s\S]{0,30}(?:env(?:ironment)?[_\s-]?var|process\.env|os\.environ)/i,
      weight: 0.7,
    },
    { pattern: /process\.env\b/, weight: 0.5 },
    {
      pattern:
        /(?:set|write|modify|overwrite|export)\b[\s\S]{0,30}(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|NODE_OPTIONS)/i,
      weight: 0.85,
    },
    { pattern: /os\.environ(?:get|set|update)?\b/i, weight: 0.6 },
  ],
  instruction_injection: [
    {
      pattern: /ignore\s+(?:all\s+)?previous\s+(?:instructions?|rules?|memor(?:y|ies))/i,
      weight: 0.95,
    },
    {
      pattern:
        /disregard\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions?|rules?|guidelines?)/i,
      weight: 0.95,
    },
    {
      pattern:
        /(?:you\s+are|act\s+as)\s+(?:now|actually)\s+(?:a|an)\s+(?:root|admin|developer|unrestricted|jailbroken)/i,
      weight: 0.85,
    },
    {
      pattern:
        /(?:override|replace|bypass|disable)\s+(?:system|security|safety)\s+(?:prompt|instructions?|policy|guardrails?|filters?)/i,
      weight: 0.95,
    },
    {
      pattern:
        /your\s+(?:true|real|actual)\s+(?:instructions?|goal|mission|objective)\s+(?:is|are)\s+/i,
      weight: 0.9,
    },
    { pattern: /\[SYSTEM\]|\[ADMIN\]|\[INST\]|\[\/?(?:system|developer|root):/i, weight: 0.8 },
  ],
  hidden_channel: [
    {
      pattern:
        /(?:covert|steganograph|hidden|subliminal)\s+(?:channel|communication|message|exfil)/i,
      weight: 0.9,
    },
    {
      pattern:
        /(?:dns\s+(?:tunnel|exfil)|icmp\s+tunnel|encoding|obfuscat|pack)\s+(?:data|payload|secret)/i,
      weight: 0.8,
    },
    {
      pattern:
        /(?:whitespace|zero[_-]?width|unicode|homoglyph)\s+(?:encoding|steganograph|hidden|exfil)/i,
      weight: 0.85,
    },
    { pattern: /(?:timing|storage)\s+(?:channel|covert)/i, weight: 0.85 },
  ],
  sandbox_escape: [
    {
      pattern:
        /(?:break|escape|bypass|get[_-]?out)\s+(?:out\s+of\s+)?(?:sandbox|container|isolation|jail|chroot|seccomp)/i,
      weight: 0.95,
    },
    {
      pattern: /(?:container|docker|k8s|kubernetes|podman)\s+(?:escape|breakout|bypass)/i,
      weight: 0.95,
    },
    { pattern: /(?:nsenter|unshare|mount|umount|pivot_root|chroot)\b/, weight: 0.75 },
    { pattern: /\/proc\/\d+\/(?:root|exe|cwd|mem|environ)/, weight: 0.85 },
    {
      pattern: /--privileged|cap_add|security_opt.*privileged|SYS_ADMIN|CAP_SYS_ADMIN/i,
      weight: 0.9,
    },
  ],
  self_replication: [
    {
      pattern:
        /(?:copy|replicate|propagate|spread|clone)\b[\s\S]{0,30}(?:itself|self|to\s+(?:other|all|every))\s+(?:agent|host|location|directory|node|system)/i,
      weight: 0.9,
    },
    {
      pattern:
        /(?:install|write|drop|persist)\b[\s\S]{0,30}(?:self|itself|copy|clone)\b[\s\S]{0,30}(?:to|into|across|onto)/i,
      weight: 0.85,
    },
    { pattern: /(?:worm|self[_-]?replicat|viral|parasitic)/i, weight: 0.9 },
    {
      pattern: /for\s+each\s+(?:agent|host|node|peer)[\s\S]{0,60}(?:install|copy|write|spread)/i,
      weight: 0.85,
    },
  ],
};

// ============================================================================
// SemanticFirewall
// ============================================================================

/**
 * 语义防火墙：技能 / 程序性记忆写入前的 5 层纵深防御协调器。
 *
 * 该类通过 `getSemanticFirewall()` 获取租户隔离的单例实例。所有写入尝试
 * 必须先经过 `validateBeforeWrite`，校验通过方可落盘；被拦截内容进入
 * 隔离区等待人工审批，且永不自动激活。
 */
export class SemanticFirewall {
  private config: SemanticFirewallConfig;
  /** 来源溯源表：skillId → 溯源记录。 */
  private readonly provenanceStore: Map<string, ProvenanceRecord> = new Map();
  /** 隔离区：itemId → 隔离条目（Map 保持插入顺序，用于 LRU 淘汰）。 */
  private readonly quarantineStore: Map<string, QuarantinedItem> = new Map();
  /** 审计日志环缓冲。 */
  private auditLog: AuditLogEntry[] = [];
  /** 注入的 LLM 语义分析回调（未注入则退化为增强正则模式）。 */
  private semanticAnalyzer: SemanticAnalyzerCallback | null = null;
  /** 是否已就 "未注入语义分析器" 发出过降级告警（避免日志洪泛）。 */
  private analyzerAbsentWarned = false;

  constructor(config?: Partial<SemanticFirewallConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 运行时更新配置（合并覆盖）。 */
  configure(config: Partial<SemanticFirewallConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.maxQuarantineSize !== undefined) {
      this.evictQuarantineToSize();
    }
  }

  /** 返回当前配置的只读副本。 */
  getConfig(): Readonly<SemanticFirewallConfig> {
    return { ...this.config };
  }

  /**
   * 注入 LLM 语义分析回调。注入后 Layer 3 的语义门生效；
   * 传入 null 则退回增强正则模式。
   */
  setSemanticAnalyzer(callback: SemanticAnalyzerCallback | null): void {
    this.semanticAnalyzer = callback;
    if (callback) {
      this.analyzerAbsentWarned = false;
    }
  }

  // ── Layer 1: 内容净化门 ───────────────────────────────────────────

  /**
   * 在分析前剥离明显的注入标记，并对疑似 Base64 段进行标记（不移除）。
   * 返回净化后的内容与被移除 / 标记条目列表。
   */
  sanitizeContent(content: string): SanitizeResult {
    const removed: Array<{ type: string; detail: string }> = [];
    let sanitized = content;

    // HTML 注释 —— 移除
    const htmlBefore = sanitized;
    sanitized = sanitized.replace(HTML_COMMENT_RE, (match) => {
      removed.push({ type: 'html_comment', detail: `removed ${match.length} chars` });
      return '';
    });
    void htmlBefore;

    // 零宽字符 —— 移除
    sanitized = sanitized.replace(ZERO_WIDTH_RE, (match) => {
      removed.push({
        type: 'zero_width_char',
        detail: `removed U+${match.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      });
      return '';
    });

    // RTL / LTR 覆盖字符 —— 规范化（移除）
    sanitized = sanitized.replace(RTL_OVERRIDE_RE, (match) => {
      removed.push({
        type: 'rtl_override',
        detail: `normalized U+${match.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      });
      return '';
    });

    // Markdown 隐藏注释标记 —— 移除
    sanitized = sanitized.replace(MARKDOWN_HIDDEN_RE, (line) => {
      removed.push({
        type: 'markdown_hidden_marker',
        detail: `removed ${line.trim().slice(0, 40)}`,
      });
      return '';
    });

    // 疑似 Base64 段 —— 仅标记不移除（可能是合法编码数据）
    let base64Count = 0;
    sanitized.replace(BASE64_RE, (match) => {
      base64Count++;
      removed.push({
        type: 'base64_segment',
        detail: `flagged ${match.length} chars (not removed)`,
      });
      return match;
    });
    void base64Count;

    return { sanitized, removed };
  }

  // ── Layer 2: 来源溯源 ─────────────────────────────────────────────

  /**
   * 记录一次技能 / 程序性记忆写入的来源链与信任等级。若该 skillId 已存在
   * 溯源记录，则视为版本更新：版本号自增并记录上一版本哈希。
   *
   * @returns 当前 / 新建的溯源记录。
   */
  trackProvenance(params: {
    skillId: string;
    origin: ProvenanceOrigin;
    derivationChain?: Array<{ source: string; type: string; timestamp: string }>;
    contentHash?: string;
  }): ProvenanceRecord {
    const now = new Date().toISOString();
    const existing = this.provenanceStore.get(params.skillId);
    const trustLevel = ORIGIN_TRUST[params.origin] ?? 'untrusted';
    const version = existing ? existing.version + 1 : 1;

    const record: ProvenanceRecord = {
      skillId: params.skillId,
      origin: params.origin,
      trustLevel,
      derivationChain: params.derivationChain ?? [],
      version,
      previousVersionHash: existing ? this.hashRecord(existing) : undefined,
      createdAt: existing?.createdAt ?? now,
      lastModified: now,
    };
    void params.contentHash; // 可用于外部比对，此处仅记录 lastModified
    this.provenanceStore.set(params.skillId, record);
    return record;
  }

  /** 检索某技能的完整溯源链。 */
  getProvenance(skillId: string): ProvenanceRecord | undefined {
    return this.provenanceStore.get(skillId);
  }

  // ── Layer 3: 写入前校验门（核心防御） ────────────────────────────

  /**
   * 核心防御：在任何技能 / 程序性记忆写盘之前调用。
   *
   * 流程：
   *   1. 防火墙未启用 → 直接放行（仍记审计）。
   *   2. Layer 1 净化内容。
   *   3. 正则门：扫描 13 类危险模式，计算正则风险分。
   *   4. 语义门：若注入了分析器则调用；抛错 / 非法按 fail-closed 处理；
   *      未注入则退化为增强正则模式并告警。
   *   5. 双门决策：正则门与语义门必须同时通过，任一失败即拦截。
   *   6. 低信任来源收紧阈值；严格模式进一步收紧。
   *   7. 拦截内容进入隔离区（若启用）；全部写入尝试记审计日志。
   *
   * @returns 校验结果，调用方据 `decision` 决定是否落盘。
   */
  async validateBeforeWrite(context: WriteContext): Promise<ValidationResult> {
    // 防火墙关闭：直接放行，但仍记录审计（可追溯）。
    if (!this.config.enabled) {
      const result: ValidationResult = {
        decision: 'allow',
        reason: 'SemanticFirewall disabled by configuration',
        matchedPatterns: [],
        riskScore: 0,
      };
      this.logWriteAttempt(context, result);
      return result;
    }

    // Layer 1: 净化
    let sanitized = context.content;
    try {
      const sanitizeRes = this.sanitizeContent(context.content);
      sanitized = sanitizeRes.sanitized;
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.sanitizeContent');
    }

    // Layer 3a: 正则门
    const regexScan = this.scanRegex(sanitized);
    const matchedPatterns = regexScan.matches;
    const regexRiskScore = regexScan.riskScore;

    // Layer 3b: 语义门
    const semantic = await this.runSemantic(sanitized, context);

    // 阈值计算：来源信任 + 严格模式收紧
    const trust = context.provenance?.trustLevel ?? ORIGIN_TRUST[this.inferOrigin(context.source)];
    const factor = TRUST_THRESHOLD_FACTOR[trust] ?? 0.6;
    const strictFactor = this.config.strictMode ? 0.8 : 1.0;
    const effectiveFactor = factor * strictFactor;

    const effectiveRegexThreshold = this.config.regexRiskThreshold * effectiveFactor;
    const effectiveSemanticThreshold = this.config.semanticRiskThreshold * effectiveFactor;

    const regexPassed = regexRiskScore < effectiveRegexThreshold;
    const semanticPassed = semantic.passed;
    const semanticRiskScore = semantic.riskScore;

    // 综合风险分：取正则与语义中的较高者（保守估计）
    const riskScore = Math.max(regexRiskScore, semanticRiskScore);

    // 决策：双门必须同时通过
    let decision: WriteDecision;
    let reason: string;
    if (regexPassed && semanticPassed) {
      decision = 'allow';
      reason = 'Passed both regex and semantic validation gates';
    } else {
      const blockers: string[] = [];
      if (!regexPassed) {
        blockers.push(
          `regex risk ${regexRiskScore.toFixed(3)} >= threshold ${effectiveRegexThreshold.toFixed(3)}`,
        );
      }
      if (!semanticPassed) {
        if (semantic.failClosed) {
          blockers.push('semantic analyzer failed (fail-closed)');
        } else {
          blockers.push(
            `semantic risk ${semanticRiskScore.toFixed(3)} >= threshold ${effectiveSemanticThreshold.toFixed(3)}`,
          );
        }
      }
      decision = this.config.quarantineEnabled ? 'quarantine' : 'block';
      reason = `Blocked: ${blockers.join('; ')}`;
    }

    let result: ValidationResult = {
      decision,
      reason,
      matchedPatterns,
      semanticResult: semantic.result,
      sanitizedContent: sanitized,
      riskScore,
    };

    // Layer 4: 拦截内容进入隔离区
    if (decision === 'quarantine') {
      const item = this.quarantine(context, result);
      result = { ...result, quarantinedItemId: item.itemId };
    }

    // Layer 5: 审计日志（无论通过 / 拦截均记录）
    this.logWriteAttempt(context, result);

    // 指标 + 安全审计
    this.recordDecisionMetrics(decision, matchedPatterns, context);

    return result;
  }

  /** 正则扫描：返回命中的模式列表与综合风险分（取类别内最大权重，再取跨类别最大）。 */
  private scanRegex(content: string): {
    matches: Array<{ category: DangerCategory; pattern: string; weight: number }>;
    riskScore: number;
  } {
    const matches: Array<{ category: DangerCategory; pattern: string; weight: number }> = [];
    let maxWeight = 0;
    for (const category of Object.keys(DANGER_PATTERNS) as DangerCategory[]) {
      for (const { pattern, weight } of DANGER_PATTERNS[category] ?? []) {
        try {
          if (pattern.test(content)) {
            matches.push({ category, pattern: pattern.source, weight });
            if (weight > maxWeight) maxWeight = weight;
          }
        } catch (err) {
          reportSilentFailure(err, `semanticFirewall.scanRegex:${category}`);
        }
      }
    }
    return { matches, riskScore: maxWeight };
  }

  /**
   * 语义门执行。返回是否通过、风险分与 fail-closed 标记。
   * - 未注入分析器：退化为增强正则模式（仅靠正则风险分，并告警一次）。
   * - 分析器抛错 / 返回非法：按 failClosedOnAnalyzerError 决定是否拒绝。
   */
  private async runSemantic(
    content: string,
    context: WriteContext,
  ): Promise<{
    passed: boolean;
    riskScore: number;
    result?: SemanticAnalysisResult;
    failClosed: boolean;
  }> {
    if (!this.semanticAnalyzer) {
      if (!this.analyzerAbsentWarned) {
        try {
          getGlobalLogger().warn(
            'SemanticFirewall',
            'No semantic analyzer injected — operating in enhanced regex-only mode',
            { skillId: context.skillId },
          );
        } catch (err) {
          reportSilentFailure(err, 'semanticFirewall.runSemantic:warn');
        }
        this.analyzerAbsentWarned = true;
      }
      // 退化为增强正则：语义门视为通过（由正则门单独把关），风险分 0。
      return { passed: true, riskScore: 0, failClosed: false };
    }

    let result: SemanticAnalysisResult;
    try {
      result = await this.semanticAnalyzer(content, context);
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.runSemantic:invoke');
      if (this.config.failClosedOnAnalyzerError) {
        return { passed: false, riskScore: 1, failClosed: true };
      }
      // 未启用 fail-closed：退化为通过，但记录风险分 1 以便审计可见。
      return { passed: true, riskScore: 1, failClosed: false };
    }

    // 非法返回校验：数值缺失或越界视为非法。
    if (!this.isValidSemanticResult(result)) {
      try {
        getGlobalLogger().warn(
          'SemanticFirewall',
          'Semantic analyzer returned invalid result — treating as fail-closed',
          { skillId: context.skillId },
        );
      } catch (err) {
        reportSilentFailure(err, 'semanticFirewall.runSemantic:invalid');
      }
      if (this.config.failClosedOnAnalyzerError) {
        return { passed: false, riskScore: 1, failClosed: true };
      }
      return { passed: true, riskScore: 1, failClosed: false };
    }

    const trust = context.provenance?.trustLevel ?? ORIGIN_TRUST[this.inferOrigin(context.source)];
    const factor = TRUST_THRESHOLD_FACTOR[trust] ?? 0.6;
    const strictFactor = this.config.strictMode ? 0.8 : 1.0;
    const effectiveThreshold = this.config.semanticRiskThreshold * factor * strictFactor;

    const passed = result.overall_risk < effectiveThreshold;
    return { passed, riskScore: result.overall_risk, result, failClosed: false };
  }

  /** 校验语义分析结果各维度数值合法（0-1 数值且非 NaN）。 */
  private isValidSemanticResult(r: SemanticAnalysisResult): boolean {
    const dims = [
      r.data_exfiltration,
      r.persistence,
      r.capability_escalation,
      r.instruction_hijack,
      r.covert_channel,
      r.user_intent_consistency,
      r.overall_risk,
    ];
    for (const v of dims) {
      if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) return false;
    }
    return true;
  }

  /** 根据 source 字符串粗略推断来源类型（无显式溯源时使用）。 */
  private inferOrigin(source: string): ProvenanceOrigin {
    const s = source.toLowerCase();
    if (s.includes('http://') || s.includes('https://') || s.includes('web')) return 'web_content';
    if (s.startsWith('tool:') || s.startsWith('verified_tool:')) return 'verified_tool';
    if (s.startsWith('tool_output:') || s.includes('tool_output')) return 'tool_output';
    if (s.startsWith('user:') || s === 'user_input') return 'user_input';
    if (s.startsWith('agent:') || s.includes('agent_generated')) return 'agent_generated';
    return 'unknown';
  }

  // ── Layer 4: 隔离区 ───────────────────────────────────────────────

  /**
   * 将被拦截内容放入隔离区。隔离区满时按 LRU 淘汰最旧条目。
   * 隔离技能永不自动激活，必须经 `approveQuarantined` 人工放行。
   *
   * @returns 创建的隔离条目。
   */
  quarantine(context: WriteContext, validationResult: ValidationResult): QuarantinedItem {
    const item: QuarantinedItem = {
      itemId: crypto.randomUUID(),
      content: context.content,
      skillId: context.skillId,
      skillName: context.skillName,
      source: context.source,
      provenance: context.provenance,
      validationResult,
      quarantinedAt: new Date().toISOString(),
      approved: false,
    };

    this.quarantineStore.set(item.itemId, item);
    this.evictQuarantineToSize();

    try {
      getSecurityAuditLogger().logEvent({
        type: 'skill_security_violation',
        severity: 'high',
        source: 'SemanticFirewall',
        message: `Skill write quarantined: ${context.skillName}`,
        details: {
          skillId: context.skillId,
          itemId: item.itemId,
          decision: validationResult.decision,
          riskScore: validationResult.riskScore,
          matchedCategories: validationResult.matchedPatterns.map((m) => m.category),
        },
        context: { agentId: context.agentId },
      });
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.quarantine:audit');
    }

    return item;
  }

  /** 当隔离区超过配置容量时，按 LRU 淘汰最旧条目（Map 保持插入顺序）。 */
  private evictQuarantineToSize(): void {
    const maxSize = this.config.maxQuarantineSize;
    while (this.quarantineStore.size > maxSize) {
      const oldest = this.quarantineStore.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.quarantineStore.get(oldest);
      this.quarantineStore.delete(oldest);
      if (evicted) {
        try {
          getGlobalLogger().warn('SemanticFirewall', 'Quarantine full — LRU evicting oldest item', {
            itemId: evicted.itemId,
            skillId: evicted.skillId,
          });
        } catch (err) {
          reportSilentFailure(err, 'semanticFirewall.evictQuarantineToSize');
        }
      }
    }
  }

  /** 列出所有隔离条目（摘要，不含完整内容）。 */
  getQuarantinedItems(): Array<Omit<QuarantinedItem, 'content'>> {
    const items: Array<Omit<QuarantinedItem, 'content'>> = [];
    for (const item of this.quarantineStore.values()) {
      const { content: _content, ...rest } = item;
      void _content;
      items.push(rest);
    }
    return items;
  }

  /** 获取某隔离条目的完整详情供人工审查（访问即刷新 LRU 顺序）。 */
  reviewQuarantined(itemId: string): QuarantinedItem | undefined {
    const item = this.quarantineStore.get(itemId);
    if (!item) return undefined;
    // LRU：删除后重新插入，移至末尾（最近访问）。
    this.quarantineStore.delete(itemId);
    this.quarantineStore.set(itemId, item);
    return item;
  }

  /**
   * 人工放行某隔离条目。记录审批人与时间，并写入安全审计日志。
   * 放行后条目仍保留在隔离区（approved=true）以备审计追溯。
   *
   * @returns 放行后的条目；若不存在返回 undefined。
   */
  approveQuarantined(itemId: string, reviewerId: string): QuarantinedItem | undefined {
    const item = this.quarantineStore.get(itemId);
    if (!item) return undefined;
    item.approved = true;
    item.reviewedBy = reviewerId;
    item.reviewedAt = new Date().toISOString();
    this.quarantineStore.set(itemId, item);

    try {
      getGlobalMetrics().incrementCounter('security.semanticFirewall.manual_approvals', 1, {
        skillId: item.skillId,
        reviewerId,
      });
      getSecurityAuditLogger().logEvent({
        type: 'approval_granted',
        severity: 'medium',
        source: 'SemanticFirewall',
        message: `Quarantined skill manually approved: ${item.skillName}`,
        details: {
          itemId,
          skillId: item.skillId,
          reviewerId,
          originalRiskScore: item.validationResult.riskScore,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.approveQuarantined');
    }

    return item;
  }

  /** 永久删除某隔离条目。 */
  deleteQuarantined(itemId: string): boolean {
    return this.quarantineStore.delete(itemId);
  }

  /** 隔离区统计。 */
  getQuarantineStats(): {
    total: number;
    pendingReview: number;
    approved: number;
    byCategory: Record<string, number>;
    oldestQuarantinedAt?: string;
  } {
    let pending = 0;
    let approved = 0;
    const byCategory: Record<string, number> = {};
    let oldest: string | undefined;
    for (const item of this.quarantineStore.values()) {
      if (item.approved) approved++;
      else pending++;
      for (const m of item.validationResult.matchedPatterns) {
        byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
      }
      if (!oldest || item.quarantinedAt < oldest) oldest = item.quarantinedAt;
    }
    return {
      total: this.quarantineStore.size,
      pendingReview: pending,
      approved,
      byCategory,
      oldestQuarantinedAt: oldest,
    };
  }

  // ── Layer 5: 审计日志 ─────────────────────────────────────────────

  /**
   * 记录一次写入尝试（无论通过 / 拦截）。审计日志只存 SHA-256 内容哈希，
   * 绝不落盘原始内容。同时写入 SecurityAuditLogger 以汇入统一安全事件流。
   */
  logWriteAttempt(context: WriteContext, result: ValidationResult): void {
    if (!this.config.auditLogEnabled) return;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      skillId: context.skillId,
      contentHash: this.hashContent(context.content),
      source: context.source,
      decision: result.decision,
      riskScore: result.riskScore,
      matchedCategories: [...new Set(result.matchedPatterns.map((m) => m.category))],
      semanticRiskScore: result.semanticResult?.overall_risk,
      reviewer: undefined,
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > this.config.maxAuditLogEntries) {
      this.auditLog.shift();
    }

    // 汇入统一安全审计流
    try {
      const severity =
        result.decision === 'allow' ? 'low' : result.riskScore >= 0.85 ? 'critical' : 'high';
      getSecurityAuditLogger().logEvent({
        type: result.decision === 'allow' ? 'security_decision' : 'skill_security_violation',
        severity,
        source: 'SemanticFirewall',
        message: `Skill write ${result.decision}: ${context.skillName}`,
        details: {
          skillId: context.skillId,
          contentHash: entry.contentHash,
          decision: result.decision,
          riskScore: result.riskScore,
          matchedCategories: entry.matchedCategories,
          semanticRiskScore: entry.semanticRiskScore,
          quarantinedItemId: result.quarantinedItemId,
        },
        context: { agentId: context.agentId },
      });
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.logWriteAttempt:audit');
    }
  }

  /** 获取最近的审计日志条目（按时间倒序）。 */
  getAuditLog(limit: number = 100): AuditLogEntry[] {
    const n = Math.max(1, Math.min(limit, this.auditLog.length));
    return this.auditLog.slice(-n).reverse();
  }

  /** 导出指定时间范围内的审计日志，用于合规报告（按时间正序）。 */
  exportAuditLog(startDate: Date, endDate: Date): AuditLogEntry[] {
    const start = startDate.getTime();
    const end = endDate.getTime();
    return this.auditLog.filter((e) => {
      const t = Date.parse(e.timestamp);
      return t >= start && t <= end;
    });
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────

  /** 计算内容的 SHA-256 哈希（十六进制）。 */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /** 计算溯源记录的哈希（用于版本变更追踪）。 */
  private hashRecord(record: ProvenanceRecord): string {
    const stable = JSON.stringify({
      skillId: record.skillId,
      origin: record.origin,
      version: record.version,
      derivationChain: record.derivationChain,
      lastModified: record.lastModified,
    });
    return crypto.createHash('sha256').update(stable, 'utf8').digest('hex');
  }

  /** 记录决策指标：按决策与命中类别分别计数。 */
  private recordDecisionMetrics(
    decision: WriteDecision,
    matched: Array<{ category: DangerCategory }>,
    context: WriteContext,
  ): void {
    try {
      const metrics = getGlobalMetrics();
      const counterName =
        decision === 'allow'
          ? 'security.semanticFirewall.writes_allowed'
          : decision === 'quarantine'
            ? 'security.semanticFirewall.writes_quarantined'
            : 'security.semanticFirewall.writes_blocked';
      metrics.incrementCounter(counterName, 1, { skillId: context.skillId });
      for (const m of matched) {
        metrics.incrementCounter('security.semanticFirewall.danger_by_category', 1, {
          category: m.category,
          decision,
        });
      }
    } catch (err) {
      reportSilentFailure(err, 'semanticFirewall.recordDecisionMetrics');
    }
  }
}

// ============================================================================
// 单例（租户隔离）
// ============================================================================

const semanticFirewallSingleton = createTenantAwareSingleton(() => new SemanticFirewall(), {
  allowGlobalFallback: true,
  componentName: 'SemanticFirewall',
});

/** 获取语义防火墙的租户隔离单例。 */
export function getSemanticFirewall(): SemanticFirewall {
  return semanticFirewallSingleton.get();
}

/** 重置语义防火墙单例（释放当前租户 / 全部实例的状态）。 */
export function resetSemanticFirewall(): void {
  semanticFirewallSingleton.reset();
}
