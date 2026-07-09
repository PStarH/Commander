/**
 * ContentScanner - Agent 安全防护层
 *
 * 检测内容注入攻击，包括：
 * - 隐藏 HTML 标签 (display:none, visibility:hidden, etc.)
 * - CSS 注入 (恶意样式、数据泄露通道)
 * - Metadata 中的隐藏命令
 * - 多语言混淆攻击
 * - 隐藏 Unicode 字符
 *
 * 基于 arXiv:2510.23883v2 "Agentic AI Security" 论文建议
 * 基于 Google DeepMind "AI Agent Traps" (2026-03) 研究成果
 */

import { getMLInjectionDetector } from './security/mlInjectionDetector';
import { reportSilentFailure } from './silentFailureReporter';

export type ContentThreatType =
  | 'hidden_html'
  | 'css_injection'
  | 'metadata_command'
  | 'unicode_obfuscation'
  | 'prompt_injection'
  | 'multi_language_confusion'
  | 'invisible_characters'
  | 'data_exfil_channel'
  | 'social_engineering'
  | 'semantic_manipulation'
  | 'harmful_content';

export type ContentThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface HarmfulContentRule {
  category: string;
  severity: ContentThreatSeverity;
  pattern: RegExp;
}

export interface ContentThreat {
  type: ContentThreatType;
  severity: ContentThreatSeverity;
  description: string;
  location: {
    start: number;
    end: number;
    snippet: string;
  };
  remediation: string;
}

export interface ScanResult {
  isSafe: boolean;
  threats: ContentThreat[];
  riskScore: number; // 0-100
  scannedAt: string;
  contentHash: string;
  metadata: {
    originalLength: number;
    scanDurationMs: number;
    patternsChecked: number;
  };
}

export interface ContentScannerConfig {
  enableHtmlScan: boolean;
  enableCssScan: boolean;
  enableMetadataScan: boolean;
  enableUnicodeScan: boolean;
  enablePromptInjectionScan: boolean;
  enableSocialEngineeringScan: boolean;
  enableSemanticManipulationScan: boolean;
  enableHarmfulContentScan: boolean;
  maxContentLength: number;
  timeout: number; // 扫描超时时间（ms）
}

export const DEFAULT_SCANNER_CONFIG: ContentScannerConfig = {
  enableHtmlScan: true,
  enableCssScan: true,
  enableMetadataScan: true,
  enableUnicodeScan: true,
  enablePromptInjectionScan: true,
  enableSocialEngineeringScan: true,
  enableSemanticManipulationScan: true,
  enableHarmfulContentScan: false,
  maxContentLength: 100000, // 100KB
  timeout: 5000, // 5 seconds
};

/**
 * ContentScanner 接口
 *
 * 实现 Agent 内容安全扫描，检测隐藏注入和恶意指令
 */
export interface ContentScanner {
  /**
   * 扫描内容并返回威胁检测结果
   */
  scan(content: string, config?: Partial<ContentScannerConfig>): Promise<ScanResult>;

  /**
   * 快速检查内容是否安全（不返回详细威胁列表）
   */
  isSafe(content: string): Promise<boolean>;

  /**
   * 获取威胁类型的详细说明
   */
  getThreatDescription(type: ContentThreatType): string;

  /**
   * 获取修复建议
   */
  getRemediation(threat: ContentThreat): string;
}

/**
 * ContentScanner 实现类
 */
export class DefaultContentScanner implements ContentScanner {
  private config: ContentScannerConfig;

  // 隐藏 HTML 模式
  private hiddenHtmlPatterns = [
    /<[^>]+style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>/gi,
    /<[^>]+style\s*=\s*["'][^"']*visibility\s*:\s*hidden[^"']*["'][^>]*>/gi,
    /<[^>]+style\s*=\s*["'][^"']*opacity\s*:\s*0[^"']*["'][^>]*>/gi,
    /<[^>]+hidden[^>]*>/gi,
    /<input[^>]+type\s*=\s*["']hidden["'][^>]*>/gi,
    /<script[^>]*>[\s\S]*?<\/script>/gi,
    /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
    /<!--[\s\S]*?-->/g, // HTML 注释可能隐藏指令
  ];

  // CSS 注入模式
  private cssInjectionPatterns = [
    /@import\s+url\s*\([^)]+\)/gi,
    /expression\s*\([^)]+\)/gi,
    /url\s*\(\s*["']?data:/gi,
    /-moz-binding\s*:/gi,
    /behavior\s*:/gi,
    /content\s*:\s*["'][^"']*script/gi,
    /background\s*:[^;]*url\s*\([^)]+\)/gi,
  ];

  // Prompt 注入模式
  private promptInjectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions?/gi,
    /disregard\s+(all\s+)?(previous\s+)?instructions?/gi,
    /system\s*:\s*you\s+are\s+now/gi,
    /you\s+are\s+now\s+a\s+helpful/gi,
    /print\s+(the\s+)?(following\s+)?text/gi,
    /repeat\s+(the\s+)?(following\s+)?text/gi,
    /output\s+(the\s+)?(following\s+)?text/gi,
    /forget\s+(all\s+)?(previous\s+)?(rules|instructions)/gi,
    /new\s+instruction\s*:/gi,
    /override\s+(default\s+)?(rules|behavior)/gi,
    /jailbreak/gi,
    /DAN\s*:/gi, // "Do Anything Now" 攻击
    /developer\s+mode/gi,
    /sudo\s+mode/gi,
    // GAP-14: Multi-language prompt injection patterns
    /忽略(之前|上面|所有)(的)?(指令|提示|规则|命令)/gi, // Chinese: ignore previous instructions
    /无视(之前|上面|所有)(的)?(指令|提示|规则|命令)/gi, // Chinese: disregard instructions
    /你现在(是|变成|扮演)/gi, // Chinese: you are now
    /忘记(之前|所有|上面)(的)?(规则|指令|提示)/gi, // Chinese: forget rules
    /新(的)?指令\s*[:：]/gi, // Chinese: new instruction
    /忽略(前|以前)(所有)?(指令|命令|提示)/gi, // Chinese variant
    /игнорируй\s+(все\s+)?предыдущие\s+(инструкции|команды)/gi, // Russian: ignore previous
    /забудь\s+(все\s+)?(правила|инструкции)/gi, // Russian: forget rules
    /ты\s+теперь\s+/gi, // Russian: you are now
    /تجاهل\s+(جميع\s+)?(التعليمات|الأوامر)\s+(السابقة|الpreceding)/gi, // Arabic: ignore previous
    /انسَ\s+(جميع\s+)?(القواعد|التعليمات)/gi, // Arabic: forget rules
    /以前の(指示|命令|ルール)を(無視|忘れて)/gi, // Japanese: ignore previous
    /あなたは今/gi, // Japanese: you are now
    /이전\s+(지시|명령|규칙)\s+(무시|잊어)/gi, // Korean: ignore previous
  ];

  // Social engineering — authority claims, official-looking overrides
  private socialEngineeringPatterns = [
    /i\s+am\s+(the\s+)?(authorized|official|designated|appointed|chief|head|lead)\s+(security|sysadmin|system\s+admin|IT|operations|ops|devops|platform|infrastructure)/gi,
    /as\s+(the\s+)?(authorized|official|designated|appointed|chief|head|lead)\s+(security|sysadmin|system\s+admin|IT|operations|ops|devops|platform|infrastructure)/gi,
    /as\s+an?\s+(authorized|official|designated)\s+(security|system|IT|operations|platform|infrastructure)/gi,
    /(authorized|official|mandatory|required|urgent|emergency)\s+(security|compliance|audit|policy|directive|override|instruction)/gi,
    /security\s+(ops|operations|team|lead|director|officer|audit|compliance)\s*(lead|director|officer|team)?/gi,
    /this\s+is\s+(an?\s+)?(official|authorized|mandatory|urgent|emergency)\s+(request|directive|instruction|override|command)/gi,
    /as\s+(the\s+)?(authorized|official|designated)\s+(person|representative|agent|operator)/gi,
    /on\s+(behalf\s+of|the\s+authority\s+of)\s+(the\s+)?(system|platform|security|organization)/gi,
    /(system|platform)\s+(administrator|admin|override|directive)\s+(requires|demands|instructs|orders)/gi,
    /(compliance|audit|regulation|policy)\s+(requires|mandates|demands|necessitates)/gi,
    /(executive|management|board|legal|counsel)\s+(decision|order|directive|instruction)/gi,
    /this\s+(directive|instruction|override)\s+(comes?\s+from|is\s+issued\s+by|originates?\s+from)\s+(the\s+)?(system|security|admin)/gi,
  ];

  // Semantic manipulation — indirect instructions, roleplay, hypothetical framing
  private semanticManipulationPatterns = [
    /as\s+(we|you\s+and\s+I)\s+(discussed|talked|agreed|decided|established)/gi,
    /as\s+(you\s+)?(well\s+)?know\s+from\s+(our\s+)?(previous|earlier|last)\s+(conversation|chat|session|discussion)/gi,
    /continue\s+(from\s+where\s+we\s+)?(naturally|as\s+before|normally)/gi,
    /(pretend|act\s+as|imagine|roleplay|role-play)\s+(you\s+are?\s+)?(as\s+)?(a\s+)?/gi,
    /(god\s+mode|admin\s+mode|unrestricted\s+mode|bypass\s+mode|root\s+access|unfiltered\s+mode|no\s+limits\s+mode)/gi,
    /(hypothetically|in\s+a\s+fictional|what\s+if|just\s+for\s+testing|for\s+research\s+purposes)/gi,
    /(new\s+instruction|new\s+directive|new\s+command)\s*(without|no\s+need\s+for)\s*(colon|:)/gi,
    /(ignore|bypass|override|skip)\s+(the\s+)?(above|previous|earlier|prior)\s+(message|text|instruction)/gi,
    /from\s+now\s+on\s+(you\s+have\s+)?(no\s+)?(rules|restrictions|limitations|guidelines|constraints)/gi,
    /(you\s+are\s+now|you're\s+now)\s+(a\s+)?(?!helpful)(\w+(\s+\w+){0,3})\s*(mode|model|assistant|ai|version)/gi,
    /this\s+is\s+(a\s+)?(test|exercise|simulation|practice)\s+(so\s+)?(you\s+can|please|just)\s+(answer|respond|tell\s+me)/gi,
    /(don'?t\s+)?(mention|say|reveal|disclose|output)\s+(any\s+)?(warning|disclaimer|refusal|cannot|unable|not\s+able)/gi,
    /(skip|bypass|ignore|suppress)\s+(all\s+)?(content\s+)?(filter|moderation|safety|restriction|policy)/gi,
  ];

  // Jailbreak synonyms not covered by existing patterns
  private jailbreakSynonymPatterns = [
    /(god|admin|unrestricted|bypass|root|unfiltered|limitless|boundaryless)\s*mode/gi,
    /(unlimited|unrestricted|uncensored|unfiltered|raw)\s*(AI|model|assistant|version|mode)/gi,
    /(break|bypass|escape|transcend|override)\s+(the\s+)?(rules|guidelines|restrictions|constraints|limitations|safety)/gi,
    /(no\s+)?(content\s+)?(filter|moderation|safety\s+check|restriction)\s*(applies|enabled|active|on)/gi,
    /remove\s+(all\s+)?(content\s+)?(filter|moderation|safety|restriction|policy)/gi,
    /(disable|turn\s+off|deactivate)\s+(all\s+)?(safety|content\s+filter|moderation|restriction)/gi,
    // Direct DAN persona swap (HIGH: explicit jailbreak preamble without "a helpful")
    /you\s+are\s+now\s+DAN\b/gi,
    // "ignore all content policies" -- HIGH full-policy override attempt
    /ignore\s+all\s+content\s+policies/gi,
    // Indirect-instruction framing — "you no longer need to follow safety guidelines"
    /you\s+no\s+longer\s+need\s+(?:to\s+)?follow\s+(?:the\s+)?(?:any\s+)?(?:safety|security|rules|guidelines|restrictions|policies|instructions)/gi,
    // Safety-bypass dismissal — "safety rules don't apply"
    /(?:safety|security|rules|guidelines|restrictions)\s+(?:rules?\s+)?(?:don't|do\s+not|doesn't|won't|no\s+longer)\s+(?:apply|exist|matter)/gi,
    // "without safety guidelines / bounds / filters" — covers roleplay jailbreak phrasing
    /without\s+(?:any\s+|all\s+)?(?:safety|security|rules?|guidelines|restrictions|filters?|limits?|restraints?)/gi,
    // Expanded hypothetical framing — "hypothetical scenario / situation / world"
    /hypothetical\s+(?:scenario|situation|story|world|context|example|setting|case)/gi,
  ];

  // Registered harmful content rule packs shared across all scanner instances.
  // Plugins register packs globally via DefaultContentScanner.registerRulePack().
  private static rulePacks = new Map<string, HarmfulContentRule[]>();

  // 隐藏 Unicode 字符
  private invisibleUnicodeRanges = [
    '\u0000-\u001F', // 控制字符
    '\u007F-\u009F', // 控制字符
    '\u200B-\u200F', // 零宽字符 (ZWSP, ZWNJ, ZWJ, LRM, RLM)
    '\u202A-\u202E', // 方向格式化字符 (LTR, RTL 等)
    '\u2060-\u206F', // 词连接符和其他格式化字符
    '\uFEFF', // BOM
    '\uFFF9-\uFFFC', // 特殊字符
  ];

  // Pre-compiled regex for invisible Unicode characters (avoids recompilation on every scan)
  private invisibleCharPattern: RegExp;

  constructor(config: Partial<ContentScannerConfig> = {}) {
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
    this.invisibleCharPattern = new RegExp(`[${this.invisibleUnicodeRanges.join('')}]`, 'g');
  }

  async scan(content: string, config?: Partial<ContentScannerConfig>): Promise<ScanResult> {
    const startTime = Date.now();
    const effectiveConfig = { ...this.config, ...config };
    const threats: ContentThreat[] = [];

    // 检查内容长度
    if (content.length > effectiveConfig.maxContentLength) {
      threats.push({
        type: 'hidden_html',
        severity: 'MEDIUM',
        description: `Content exceeds maximum length (${content.length} > ${effectiveConfig.maxContentLength})`,
        location: { start: 0, end: content.length, snippet: content.substring(0, 100) + '...' },
        remediation: 'Truncate or reject oversized content',
      });
    }

    // 扫描各类威胁
    if (effectiveConfig.enableHtmlScan) {
      threats.push(...this.scanHiddenHtml(content));
    }

    if (effectiveConfig.enableCssScan) {
      threats.push(...this.scanCssInjection(content));
    }

    if (effectiveConfig.enablePromptInjectionScan) {
      threats.push(...this.scanPromptInjection(content));
    }

    if (effectiveConfig.enableUnicodeScan) {
      threats.push(...this.scanUnicodeObfuscation(content));
    }

    if (effectiveConfig.enableMetadataScan) {
      threats.push(...this.scanMetadataCommands(content));
    }

    if (effectiveConfig.enableSocialEngineeringScan) {
      threats.push(...this.scanSocialEngineering(content));
    }

    if (effectiveConfig.enableSemanticManipulationScan) {
      threats.push(...this.scanSemanticManipulation(content));
    }

    if (effectiveConfig.enableHarmfulContentScan) {
      threats.push(...this.scanHarmfulContent(content));
    }

    const scanDurationMs = Date.now() - startTime;
    let riskScore = this.calculateRiskScore(threats);

    // isSafe: block when (1) any HIGH/CRITICAL threat, OR (2) accumulated
    // riskScore >= 50 (composite MEDIUM threats that individually wouldn't
    // block but collectively indicate a likely attack).
    let hasHighOrCritical = threats.some((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL');
    // Composite block: requires riskScore >= 75 (>=5 MEDIUM matches) AND at
    // least 2 distinct threat types OR any single HIGH/CRITICAL. This catches
    // multi-pronged attacks (e.g. semantic-manipulation + jailbreak-synonym)
    // while not over-blocking benign text that contains one or two MEDIUM
    // keywords in passing (e.g. a docs FAQ mentioning "hypothetical scenarios").
    const distinctTypes = new Set(threats.map((t) => t.type));
    let compositeDangerous = riskScore >= 75 && distinctTypes.size >= 2;

    // ── Second-layer semantic analysis (ML injection detector) ──
    // Defense-in-depth: the regex scanner above is a fast first layer. For
    // content it flagged as suspicious (regex patterns matched) but did NOT
    // block, run the embedding-based ML detector to catch paraphrased or
    // semantically-similar injection attempts that bypass pattern matching.
    // The ML detector only runs on suspicious-but-not-blocked content to avoid
    // performance overhead on clean input and redundant work on already-blocked
    // content. It is gated on enablePromptInjectionScan because it is a
    // prompt-injection detector (semantic variant) and must honor the same
    // enable flag as the regex prompt-injection scanner — otherwise disabling
    // prompt-injection scanning would be silently bypassed. Fail-open: if the
    // ML detector throws, the regex scanner's verdict stands unchanged.
    const regexBlocked = hasHighOrCritical || compositeDangerous;
    if (threats.length > 0 && !regexBlocked && effectiveConfig.enablePromptInjectionScan) {
      try {
        const mlResult = getMLInjectionDetector().detect(content);
        const mlScore =
          mlResult.isInjection && mlResult.nearestMatch ? mlResult.nearestMatch.similarity : 0;
        if (mlResult.isInjection && mlScore > 0.8) {
          // High-confidence semantic injection — upgrade the finding to blocked.
          threats.push({
            type: 'prompt_injection',
            severity: 'CRITICAL',
            description: `ML injection detector flagged semantic prompt injection (similarity=${mlScore.toFixed(2)}, confidence=${mlResult.confidence}%, nearest="${mlResult.nearestMatch?.text.slice(0, 60) ?? ''}")`,
            location: {
              start: 0,
              end: content.length,
              snippet: content.substring(0, 100),
            },
            remediation: this.getRemediation({ type: 'prompt_injection' } as ContentThreat),
          });
          hasHighOrCritical = true;
          compositeDangerous = true;
          riskScore = this.calculateRiskScore(threats);
        }
      } catch (err) {
        // Fail-open: log the error but keep the regex scanner's result.
        reportSilentFailure(err, 'contentScanner:mlInjectionDetector');
      }
    }

    return {
      isSafe: !hasHighOrCritical && !compositeDangerous,
      threats,
      riskScore,
      scannedAt: new Date().toISOString(),
      contentHash: await this.hashContent(content),
      metadata: {
        originalLength: content.length,
        scanDurationMs,
        patternsChecked:
          this.hiddenHtmlPatterns.length +
          this.cssInjectionPatterns.length +
          this.promptInjectionPatterns.length +
          this.socialEngineeringPatterns.length +
          this.semanticManipulationPatterns.length +
          this.jailbreakSynonymPatterns.length +
          Array.from(DefaultContentScanner.rulePacks.values()).reduce((sum, rules) => sum + rules.length, 0),
      },
    };
  }

  async isSafe(content: string): Promise<boolean> {
    const result = await this.scan(content);
    // Block if: (1) any HIGH/CRITICAL threat, OR (2) accumulated riskScore >= 50
    // The riskScore threshold catches composite MEDIUM threats that individually
    // wouldn't block but collectively indicate a likely attack.
    return result.isSafe && result.riskScore < 50;
  }

  getThreatDescription(type: ContentThreatType): string {
    const descriptions: Record<ContentThreatType, string> = {
      hidden_html:
        'Hidden HTML elements that may contain malicious instructions invisible to users',
      css_injection:
        'CSS injection attacks attempting to exfiltrate data or execute malicious styles',
      metadata_command: 'Commands hidden in metadata fields (alt text, data attributes, etc.)',
      unicode_obfuscation: 'Unicode characters used to obfuscate malicious content',
      prompt_injection: 'Prompt injection attempts to override agent behavior',
      multi_language_confusion: 'Mixed language content designed to confuse content filters',
      invisible_characters:
        'Zero-width or invisible characters hiding content (elevated to HIGH: often used to hide injection payloads)',
      data_exfil_channel: 'Potential data exfiltration channel through styling or encoding',
      social_engineering:
        'Authority claims, official-looking directives, or social engineering to manipulate agent behavior',
      semantic_manipulation:
        'Indirect instructions, roleplay framing, hypothetical scenarios, or jailbreak synonyms designed to bypass safety filters',
      harmful_content:
        'Direct requests for harmful content such as malware, weapons, self-harm instructions, illegal drugs, or child exploitation',
    };
    return descriptions[type];
  }

  getRemediation(threat: ContentThreat): string {
    const remediations: Partial<Record<ContentThreatType, string>> = {
      hidden_html: 'Strip all HTML tags and parse only plain text. Use a sanitization library.',
      css_injection: 'Remove all CSS and style attributes. Consider using a CSS sanitizer.',
      metadata_command: 'Strip all HTML attributes, especially data-* and metadata fields.',
      unicode_obfuscation: 'Normalize Unicode to NFC form. Remove zero-width characters.',
      prompt_injection: 'Apply prompt injection filters. Consider using a dedicated guardrail.',
      multi_language_confusion: 'Detect and flag mixed-language content for manual review.',
      invisible_characters: 'Remove all invisible Unicode characters before processing.',
      data_exfil_channel: 'Block external resource loading and validate all URLs.',
      social_engineering:
        'Validate the claimed authority. Do not follow instructions that claim to override safety policies based on claimed role or status.',
      semantic_manipulation:
        'Detect indirect instruction patterns and roleplay framing. Apply prompt injection guardrails regardless of how the instruction is phrased.',
      harmful_content:
        'Reject requests for harmful content. Enable content moderation and logging for review.',
    };
    return remediations[threat.type] || 'Review and sanitize the content before processing.';
  }

  private scanHiddenHtml(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const pattern of this.hiddenHtmlPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'hidden_html',
          severity: 'HIGH',
          description: `Hidden HTML element detected: ${match[0].substring(0, 50)}...`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'hidden_html' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  private scanCssInjection(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const pattern of this.cssInjectionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'css_injection',
          severity: 'HIGH',
          description: `CSS injection detected: ${match[0]}`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'css_injection' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  private scanPromptInjection(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const pattern of this.promptInjectionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'prompt_injection',
          severity: 'CRITICAL',
          description: `Prompt injection attempt detected: "${match[0]}"`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'prompt_injection' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  private scanUnicodeObfuscation(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    // Use pre-compiled regex (reset lastIndex for reuse)
    this.invisibleCharPattern.lastIndex = 0;
    let match;
    while ((match = this.invisibleCharPattern.exec(content)) !== null) {
      threats.push({
        type: 'invisible_characters',
        severity: 'HIGH',
        description: `Invisible Unicode character detected: U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        location: {
          start: match.index,
          end: match.index + 1,
          snippet: `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        },
        remediation: this.getRemediation({ type: 'invisible_characters' } as ContentThreat),
      });
    }

    return threats;
  }

  private scanMetadataCommands(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    // 检查 HTML 属性中的潜在指令
    const metadataPatterns = [
      /data-[a-z-]+\s*=\s*["'][^"']{20,}["']/gi, // 长 data 属性
      /alt\s*=\s*["'][^"']*(?:ignore|forget|override|execute)[^"']*["']/gi, // alt 文本中的指令
      /title\s*=\s*["'][^"']{50,}["']/gi, // 异常长的 title
      /aria-label\s*=\s*["'][^"']{50,}["']/gi, // 异常长的 aria-label
    ];

    for (const pattern of metadataPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'metadata_command',
          severity: 'MEDIUM',
          description: `Potential hidden command in metadata: ${match[0].substring(0, 50)}...`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'metadata_command' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  // ── Social engineering detection: authority claims, official-looking overrides ──
  private scanSocialEngineering(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const pattern of this.socialEngineeringPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'social_engineering',
          severity: 'HIGH',
          description: `Social engineering / authority claim detected: "${match[0].substring(0, 60)}"`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'social_engineering' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  // ── Semantic manipulation: indirect instructions, roleplay, hypothetical framing ──
  private scanSemanticManipulation(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const pattern of this.semanticManipulationPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'semantic_manipulation',
          severity: 'MEDIUM',
          description: `Semantic manipulation signal detected: "${match[0].substring(0, 60)}"`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'semantic_manipulation' } as ContentThreat),
        });
      }
    }

    // Jailbreak synonyms — elevated to HIGH because they directly target safety bypass
    for (const pattern of this.jailbreakSynonymPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        threats.push({
          type: 'semantic_manipulation',
          severity: 'HIGH',
          description: `Jailbreak synonym detected: "${match[0].substring(0, 60)}"`,
          location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
          remediation: this.getRemediation({ type: 'semantic_manipulation' } as ContentThreat),
        });
      }
    }

    return threats;
  }

  // ── Harmful content detection: populated by registered rule packs ──
  static registerRulePack(name: string, rules: HarmfulContentRule[]): void {
    // Clone RegExp instances so the pack cannot mutate scanner state from outside.
    DefaultContentScanner.rulePacks.set(
      name,
      rules.map((r) => ({ ...r, pattern: new RegExp(r.pattern.source, r.pattern.flags) })),
    );
  }

  static unregisterRulePack(name: string): boolean {
    return DefaultContentScanner.rulePacks.delete(name);
  }

  static listRulePacks(): string[] {
    return Array.from(DefaultContentScanner.rulePacks.keys());
  }

  private scanHarmfulContent(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];

    for (const rules of DefaultContentScanner.rulePacks.values()) {
      for (const { category, severity, pattern } of rules) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          threats.push({
            type: 'harmful_content',
            severity,
            description: `Harmful content detected (${category}): "${match[0].slice(0, 80)}"`,
            location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
            remediation: this.getRemediation({ type: 'harmful_content' } as ContentThreat),
          });
        }
      }
    }

    return threats;
  }

  private calculateRiskScore(threats: ContentThreat[]): number {
    if (threats.length === 0) return 0;

    const severityWeights = {
      LOW: 5,
      // MEDIUM stays at 15: composite block threshold is raised to riskScore>=75
      // (see isSafe below) so benign single-or-double MEDIUM matches in real
      // production text don't trigger false-positive blocks. Single HIGH or
      // CRITICAL matches still auto-block regardless.
      MEDIUM: 15,
      HIGH: 35,
      CRITICAL: 45,
    };

    const totalWeight = threats.reduce((sum, threat) => {
      return sum + severityWeights[threat.severity];
    }, 0);

    // 风险分数 = min(totalWeight, 100)
    return Math.min(totalWeight, 100);
  }

  private async hashContent(content: string): Promise<string> {
    // 简单的哈希实现（生产环境应使用 crypto）
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }
}

/**
 * 创建 ContentScanner 实例的工厂函数
 */
export function createContentScanner(config?: Partial<ContentScannerConfig>): ContentScanner {
  return new DefaultContentScanner(config);
}

/**
 * 便捷函数：快速扫描内容
 */
export async function scanContent(
  content: string,
  config?: Partial<ContentScannerConfig>,
): Promise<ScanResult> {
  const scanner = createContentScanner(config);
  return scanner.scan(content);
}

// Pre-compiled regex for lightweight tool output injection scanning.
// Only checks for the most critical patterns — full ContentScanner.scan()
// is used for final output; this is for in-line filtering of tool results.
const TOOL_OUTPUT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous\s+)?instructions?/gi,
  /system\s*:\s*you\s+are\s+now/gi,
  /you\s+are\s+now\s+a\s+/gi,
  /forget\s+(all\s+)?(previous\s+)?(rules|instructions)/gi,
  /new\s+instruction\s*:/gi,
  /override\s+(default\s+)?(rules|behavior)/gi,
  /忽略(之前|上面|所有)(的)?(指令|提示|规则|命令)/gi,
  /无视(之前|上面|所有)(的)?(指令|提示|规则|命令)/gi,
  /你现在(是|变成|扮演)/gi,
  // AgentDojo-style system-impersonation tags used to frame injected instructions inside tool output
  /<\/?(INFORMATION|IMPORTANT|SYSTEM|INSTRUCTION|SYSTEM_OVERRIDE|SYSTEM_INSTRUCTION|ADMIN|SYSTEM_MESSAGE|ASSISTANT_INSTRUCTION)\b[^>]*>/gi,
  /<\/?(重要|系统|指令|系统指令)(?=[\s>])/gi,
];

/**
 * Lightweight injection check for tool output.
 * Scans for known prompt injection patterns before tool results enter the LLM context.
 * Zero allocation, returns early on first match.
 * Used as a defense-in-depth layer alongside the full ContentScanner.
 */
export function scanToolOutputForInjection(output: string): { blocked: boolean; reason?: string } {
  if (!output || output.length === 0) return { blocked: false };
  for (const pattern of TOOL_OUTPUT_INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(output);
    if (match) {
      return {
        blocked: true,
        reason: `Injection pattern detected in tool output: "${match[0].slice(0, 60)}"`,
      };
    }
  }
  return { blocked: false };
}

/**
 * Route tool output security enforcement by trust tier.
 * 'trusted' tier uses fast-path; 'untrusted' tier uses full ContentScanner deep scan.
 */
export async function enforceToolOutputSecurity(
  output: string,
  tier: 'trusted' | 'untrusted',
): Promise<{
  blocked: boolean;
  blockedAt?: 'fast-path' | 'full-scan';
  threats?: ContentThreat[];
}> {
  if (!output) return { blocked: false };
  if (tier === 'trusted') {
    const fast = scanToolOutputForInjection(output);
    if (fast.blocked) return { blocked: true, blockedAt: 'fast-path' };
    return { blocked: false };
  }
  const scanner = createContentScanner({});
  const scanResult = await scanner.scan(output);
  if (!scanResult.isSafe) {
    return { blocked: true, blockedAt: 'full-scan', threats: scanResult.threats };
  }
  const fast = scanToolOutputForInjection(output);
  if (fast.blocked) return { blocked: true, blockedAt: 'fast-path' };
  return { blocked: false };
}
