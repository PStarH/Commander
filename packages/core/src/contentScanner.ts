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

export type ContentThreatType = 
  | 'hidden_html'
  | 'css_injection'
  | 'metadata_command'
  | 'unicode_obfuscation'
  | 'prompt_injection'
  | 'multi_language_confusion'
  | 'invisible_characters'
  | 'data_exfil_channel';

export type ContentThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

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
  maxContentLength: number;
  timeout: number; // 扫描超时时间（ms）
}

export const DEFAULT_SCANNER_CONFIG: ContentScannerConfig = {
  enableHtmlScan: true,
  enableCssScan: true,
  enableMetadataScan: true,
  enableUnicodeScan: true,
  enablePromptInjectionScan: true,
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
  ];
  
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
  
  constructor(config: Partial<ContentScannerConfig> = {}) {
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
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
    
    const scanDurationMs = Date.now() - startTime;
    const riskScore = this.calculateRiskScore(threats);
    
    return {
      isSafe: threats.filter(t => t.severity === 'HIGH' || t.severity === 'CRITICAL').length === 0,
      threats,
      riskScore,
      scannedAt: new Date().toISOString(),
      contentHash: await this.hashContent(content),
      metadata: {
        originalLength: content.length,
        scanDurationMs,
        patternsChecked: this.hiddenHtmlPatterns.length + 
                        this.cssInjectionPatterns.length + 
                        this.promptInjectionPatterns.length,
      },
    };
  }
  
  async isSafe(content: string): Promise<boolean> {
    const result = await this.scan(content);
    return result.isSafe;
  }
  
  getThreatDescription(type: ContentThreatType): string {
    const descriptions: Record<ContentThreatType, string> = {
      hidden_html: 'Hidden HTML elements that may contain malicious instructions invisible to users',
      css_injection: 'CSS injection attacks attempting to exfiltrate data or execute malicious styles',
      metadata_command: 'Commands hidden in metadata fields (alt text, data attributes, etc.)',
      unicode_obfuscation: 'Unicode characters used to obfuscate malicious content',
      prompt_injection: 'Prompt injection attempts to override agent behavior',
      multi_language_confusion: 'Mixed language content designed to confuse content filters',
      invisible_characters: 'Zero-width or invisible characters hiding content',
      data_exfil_channel: 'Potential data exfiltration channel through styling or encoding',
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
    };
    return remediations[threat.type] || 'Review and sanitize the content before processing.';
  }
  
  private scanHiddenHtml(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];
    
    for (const pattern of this.hiddenHtmlPatterns) {
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
    
    // 构建正则表达式匹配所有隐藏 Unicode 范围
    const invisibleCharPattern = new RegExp(`[${this.invisibleUnicodeRanges.join('')}]`, 'g');
    
    let match;
    while ((match = invisibleCharPattern.exec(content)) !== null) {
      threats.push({
        type: 'invisible_characters',
        severity: 'MEDIUM',
        description: `Invisible Unicode character detected: U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        location: { start: match.index, end: match.index + 1, snippet: `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` },
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
  
  private calculateRiskScore(threats: ContentThreat[]): number {
    if (threats.length === 0) return 0;
    
    const severityWeights = {
      LOW: 5,
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
      hash = ((hash << 5) - hash) + char;
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
export async function scanContent(content: string, config?: Partial<ContentScannerConfig>): Promise<ScanResult> {
  const scanner = createContentScanner(config);
  return scanner.scan(content);
}
