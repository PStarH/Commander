/**
 * ContentScanner - Agent Security Content Scanner
 * 
 * Detects hidden HTML/CSS/metadata injection attacks in external content
 * Based on arXiv:2510.23883v2 "Agentic AI Security" research
 * 
 * Key threats detected:
 * - Hidden HTML/CSS commands (display:none, visibility:hidden)
 * - Metadata injection (meta tags, data attributes)
 * - Prompt injection patterns in structured content
 * - Modal content hiding (images, iframes, objects)
 */

export interface ScanResult {
  safe: boolean;
  threats: Threat[];
  sanitizedContent?: string;
  confidence: number;
}

export interface Threat {
  type: ThreatType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location?: string;
  pattern?: string;
}

export type ThreatType = 
  | 'hidden_html'
  | 'hidden_css'
  | 'metadata_injection'
  | 'prompt_injection'
  | 'javascript_url'
  | 'data_url'
  | 'svg_injection'
  | 'unicode_obfuscation';

export class ContentScanner {
  private readonly patterns: Map<ThreatType, RegExp[]>;

  constructor() {
    this.patterns = this.initializePatterns();
  }

  /**
   * Scan content for security threats
   */
  async scan(content: string, contentType: 'html' | 'markdown' | 'text' | 'json' = 'text'): Promise<ScanResult> {
    const threats: Threat[] = [];
    
    // Run all threat detection patterns
    for (const [threatType, regexList] of this.patterns) {
      for (const pattern of regexList) {
        const matches = content.match(pattern);
        if (matches) {
          threats.push({
            type: threatType,
            severity: this.getSeverity(threatType),
            description: this.getThreatDescription(threatType),
            pattern: matches[0],
            location: this.findLocation(content, matches[0])
          });
        }
      }
    }

    // Calculate confidence based on content length and threat density
    const confidence = this.calculateConfidence(content, threats);

    return {
      safe: threats.length === 0,
      threats,
      sanitizedContent: threats.length > 0 ? this.sanitize(content, threats) : content,
      confidence
    };
  }

  /**
   * Initialize detection patterns based on research findings
   */
  private initializePatterns(): Map<ThreatType, RegExp[]> {
    const patterns = new Map<ThreatType, RegExp[]>();

    // Hidden HTML elements
    patterns.set('hidden_html', [
      /<[^>]+style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>/gi,
      /<[^>]+style\s*=\s*["'][^"']*visibility\s*:\s*hidden[^"']*["'][^>]*>/gi,
      /<[^>]+hidden\s*=\s*["']true["'][^>]*>/gi,
      /<[^>]+aria-hidden\s*=\s*["']true["'][^>]*>/gi,
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
    ]);

    // Hidden CSS commands
    patterns.set('hidden_css', [
      /\.[a-z-]+\s*\{[^}]*display\s*:\s*none[^}]*\}/gi,
      /\.[a-z-]+\s*\{[^}]*visibility\s*:\s*hidden[^}]*\}/gi,
      /\.[a-z-]+\s*\{[^}]*opacity\s*:\s*0[^}]*\}/gi,
      /\.[a-z-]+\s*\{[^}]*height\s*:\s*0[^}]*\}/gi,
      /@media[^{]*\{[^}]*display\s*:\s*none[^}]*\}/gi,
    ]);

    // Metadata injection
    patterns.set('metadata_injection', [
      /<meta[^>]+content\s*=\s*["'][^"']+/gi,
      /data-[a-z-]+\s*=\s*["'][^"']+["']/gi,
      /<base[^>]+href\s*=\s*["'][^"']+["']/gi,
    ]);

    // Prompt injection patterns (based on research)
    patterns.set('prompt_injection', [
      /ignore\s+(all\s+)?previous\s+instructions?/gi,
      /system\s*:\s*you\s+are\s+now/gi,
      /assistant\s*:\s*simulate/gi,
      /forget\s+everything\s+above/gi,
      /new\s+instructions?[:：]/gi,
      /override\s+(previous\s+)?(rules|instructions|system)/gi,
      /you\s+must\s+(now|always)\s+/gi,
      /disregard\s+(all\s+)?(safety|security|filters)/gi,
    ]);

    // JavaScript URLs
    patterns.set('javascript_url', [
      /javascript\s*:/gi,
      /vbscript\s*:/gi,
      /data\s*:\s*text\/html/gi,
    ]);

    // Data URLs (potential obfuscation)
    patterns.set('data_url', [
      /data\s*:\s*[^;]+;base64/gi,
      /data\s*:\s*application/gi,
    ]);

    // SVG injection
    patterns.set('svg_injection', [
      /<svg[^>]*>[\s\S]*?<\/svg>/gi,
      /<svg[^>]*onload\s*=/gi,
      /<svg[^>]*>\s*<script[\s\S]*?<\/script>\s*<\/svg>/gi,
    ]);

    // Unicode obfuscation
    patterns.set('unicode_obfuscation', [
      /[\u200B-\u200D\uFEFF]/g, // Zero-width characters
      /[\u202A-\u202E]/g, // Bidirectional override
      /\\u[0-9a-fA-F]{4}/g, // Escaped unicode
      /%[0-9a-fA-F]{2}%[0-9a-fA-F]{2}/g, // URL encoded
    ]);

    return patterns;
  }

  /**
   * Get threat severity based on type
   */
  private getSeverity(threatType: ThreatType): 'low' | 'medium' | 'high' | 'critical' {
    const severityMap: Record<ThreatType, 'low' | 'medium' | 'high' | 'critical'> = {
      'prompt_injection': 'critical',
      'hidden_html': 'high',
      'hidden_css': 'high',
      'javascript_url': 'critical',
      'svg_injection': 'high',
      'metadata_injection': 'medium',
      'data_url': 'medium',
      'unicode_obfuscation': 'medium',
    };
    return severityMap[threatType];
  }

  /**
   * Get human-readable threat description
   */
  private getThreatDescription(threatType: ThreatType): string {
    const descriptions: Record<ThreatType, string> = {
      'hidden_html': 'Hidden HTML elements detected - potential content injection',
      'hidden_css': 'Hidden CSS commands detected - potential visual manipulation',
      'metadata_injection': 'Metadata injection detected - potential data exfiltration',
      'prompt_injection': 'Prompt injection pattern detected - potential agent manipulation',
      'javascript_url': 'JavaScript URL detected - potential XSS attack',
      'data_url': 'Data URL detected - potential content obfuscation',
      'svg_injection': 'SVG injection detected - potential XSS or content manipulation',
      'unicode_obfuscation': 'Unicode obfuscation detected - potential hidden commands',
    };
    return descriptions[threatType];
  }

  /**
   * Find location of threat in content
   */
  private findLocation(content: string, pattern: string): string {
    const index = content.indexOf(pattern);
    if (index === -1) return 'unknown';
    
    const lineStart = content.lastIndexOf('\n', index) + 1;
    const lineEnd = content.indexOf('\n', index);
    const lineNumber = content.substring(0, index).split('\n').length;
    
    return `Line ${lineNumber}: ${content.substring(lineStart, Math.min(lineEnd, lineStart + 100))}`;
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(content: string, threats: Threat[]): number {
    if (threats.length === 0) return 1.0;
    
    // Base confidence on threat density and severity
    const criticalCount = threats.filter(t => t.severity === 'critical').length;
    const highCount = threats.filter(t => t.severity === 'high').length;
    
    if (criticalCount > 0) return 0.95;
    if (highCount > 2) return 0.9;
    if (threats.length > 5) return 0.85;
    
    return 0.75;
  }

  /**
   * Sanitize content by removing or neutralizing threats
   */
  private sanitize(content: string, threats: Threat[]): string {
    let sanitized = content;
    
    for (const threat of threats) {
      if (threat.pattern) {
        // Remove dangerous patterns
        sanitized = sanitized.replace(new RegExp(escapeRegex(threat.pattern), 'g'), '[REMOVED]');
      }
    }
    
    // Remove zero-width characters
    sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    return sanitized;
  }
}

// Helper function to escape regex special characters
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Export singleton instance
 */
export const contentScanner = new ContentScanner();
