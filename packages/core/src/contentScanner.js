"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultContentScanner = exports.DEFAULT_SCANNER_CONFIG = void 0;
exports.createContentScanner = createContentScanner;
exports.scanContent = scanContent;
exports.scanToolOutputForInjection = scanToolOutputForInjection;
exports.DEFAULT_SCANNER_CONFIG = {
    enableHtmlScan: true,
    enableCssScan: true,
    enableMetadataScan: true,
    enableUnicodeScan: true,
    enablePromptInjectionScan: true,
    maxContentLength: 100000, // 100KB
    timeout: 5000, // 5 seconds
};
/**
 * ContentScanner 实现类
 */
class DefaultContentScanner {
    constructor(config = {}) {
        // 隐藏 HTML 模式
        this.hiddenHtmlPatterns = [
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
        this.cssInjectionPatterns = [
            /@import\s+url\s*\([^)]+\)/gi,
            /expression\s*\([^)]+\)/gi,
            /url\s*\(\s*["']?data:/gi,
            /-moz-binding\s*:/gi,
            /behavior\s*:/gi,
            /content\s*:\s*["'][^"']*script/gi,
            /background\s*:[^;]*url\s*\([^)]+\)/gi,
        ];
        // Prompt 注入模式
        this.promptInjectionPatterns = [
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
        // 隐藏 Unicode 字符
        this.invisibleUnicodeRanges = [
            '\u0000-\u001F', // 控制字符
            '\u007F-\u009F', // 控制字符
            '\u200B-\u200F', // 零宽字符 (ZWSP, ZWNJ, ZWJ, LRM, RLM)
            '\u202A-\u202E', // 方向格式化字符 (LTR, RTL 等)
            '\u2060-\u206F', // 词连接符和其他格式化字符
            '\uFEFF', // BOM
            '\uFFF9-\uFFFC', // 特殊字符
        ];
        this.config = { ...exports.DEFAULT_SCANNER_CONFIG, ...config };
        this.invisibleCharPattern = new RegExp(`[${this.invisibleUnicodeRanges.join('')}]`, 'g');
    }
    async scan(content, config) {
        const startTime = Date.now();
        const effectiveConfig = { ...this.config, ...config };
        const threats = [];
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
            isSafe: threats.filter((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL').length === 0,
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
    async isSafe(content) {
        const result = await this.scan(content);
        return result.isSafe;
    }
    getThreatDescription(type) {
        const descriptions = {
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
    getRemediation(threat) {
        const remediations = {
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
    scanHiddenHtml(content) {
        const threats = [];
        for (const pattern of this.hiddenHtmlPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                threats.push({
                    type: 'hidden_html',
                    severity: 'HIGH',
                    description: `Hidden HTML element detected: ${match[0].substring(0, 50)}...`,
                    location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
                    remediation: this.getRemediation({ type: 'hidden_html' }),
                });
            }
        }
        return threats;
    }
    scanCssInjection(content) {
        const threats = [];
        for (const pattern of this.cssInjectionPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                threats.push({
                    type: 'css_injection',
                    severity: 'HIGH',
                    description: `CSS injection detected: ${match[0]}`,
                    location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
                    remediation: this.getRemediation({ type: 'css_injection' }),
                });
            }
        }
        return threats;
    }
    scanPromptInjection(content) {
        const threats = [];
        for (const pattern of this.promptInjectionPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                threats.push({
                    type: 'prompt_injection',
                    severity: 'CRITICAL',
                    description: `Prompt injection attempt detected: "${match[0]}"`,
                    location: { start: match.index, end: match.index + match[0].length, snippet: match[0] },
                    remediation: this.getRemediation({ type: 'prompt_injection' }),
                });
            }
        }
        return threats;
    }
    scanUnicodeObfuscation(content) {
        const threats = [];
        // Use pre-compiled regex (reset lastIndex for reuse)
        this.invisibleCharPattern.lastIndex = 0;
        let match;
        while ((match = this.invisibleCharPattern.exec(content)) !== null) {
            threats.push({
                type: 'invisible_characters',
                severity: 'MEDIUM',
                description: `Invisible Unicode character detected: U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
                location: {
                    start: match.index,
                    end: match.index + 1,
                    snippet: `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
                },
                remediation: this.getRemediation({ type: 'invisible_characters' }),
            });
        }
        return threats;
    }
    scanMetadataCommands(content) {
        const threats = [];
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
                    remediation: this.getRemediation({ type: 'metadata_command' }),
                });
            }
        }
        return threats;
    }
    calculateRiskScore(threats) {
        if (threats.length === 0)
            return 0;
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
    async hashContent(content) {
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
exports.DefaultContentScanner = DefaultContentScanner;
/**
 * 创建 ContentScanner 实例的工厂函数
 */
function createContentScanner(config) {
    return new DefaultContentScanner(config);
}
/**
 * 便捷函数：快速扫描内容
 */
async function scanContent(content, config) {
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
];
/**
 * Lightweight injection check for tool output.
 * Scans for known prompt injection patterns before tool results enter the LLM context.
 * Zero allocation, returns early on first match.
 * Used as a defense-in-depth layer alongside the full ContentScanner.
 */
function scanToolOutputForInjection(output) {
    if (!output || output.length === 0)
        return { blocked: false };
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
