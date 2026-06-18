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
export type ContentThreatType = 'hidden_html' | 'css_injection' | 'metadata_command' | 'unicode_obfuscation' | 'prompt_injection' | 'multi_language_confusion' | 'invisible_characters' | 'data_exfil_channel';
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
    riskScore: number;
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
    timeout: number;
}
export declare const DEFAULT_SCANNER_CONFIG: ContentScannerConfig;
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
export declare class DefaultContentScanner implements ContentScanner {
    private config;
    private hiddenHtmlPatterns;
    private cssInjectionPatterns;
    private promptInjectionPatterns;
    private invisibleUnicodeRanges;
    private invisibleCharPattern;
    constructor(config?: Partial<ContentScannerConfig>);
    scan(content: string, config?: Partial<ContentScannerConfig>): Promise<ScanResult>;
    isSafe(content: string): Promise<boolean>;
    getThreatDescription(type: ContentThreatType): string;
    getRemediation(threat: ContentThreat): string;
    private scanHiddenHtml;
    private scanCssInjection;
    private scanPromptInjection;
    private scanUnicodeObfuscation;
    private scanMetadataCommands;
    private calculateRiskScore;
    private hashContent;
}
/**
 * 创建 ContentScanner 实例的工厂函数
 */
export declare function createContentScanner(config?: Partial<ContentScannerConfig>): ContentScanner;
/**
 * 便捷函数：快速扫描内容
 */
export declare function scanContent(content: string, config?: Partial<ContentScannerConfig>): Promise<ScanResult>;
/**
 * Lightweight injection check for tool output.
 * Scans for known prompt injection patterns before tool results enter the LLM context.
 * Zero allocation, returns early on first match.
 * Used as a defense-in-depth layer alongside the full ContentScanner.
 */
export declare function scanToolOutputForInjection(output: string): {
    blocked: boolean;
    reason?: string;
};
//# sourceMappingURL=contentScanner.d.ts.map