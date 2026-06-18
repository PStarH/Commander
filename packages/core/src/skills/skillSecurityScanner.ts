import { getGlobalLogger } from '../logging';

export interface SecurityScanResult {
  passed: boolean;
  warnings: SecurityWarning[];
}

export interface SecurityWarning {
  severity: 'low' | 'medium' | 'high';
  category: string;
  message: string;
  match: string;
}

/**
 * Scan skill content for potentially dangerous patterns before creation/import.
 * Checks:
 *   - Shell injection (command injection via backticks, $(), |)
 *   - Path traversal (../, absolute paths that escape the sandbox)
 *   - Sensitive data exposure (API keys, tokens, passwords)
 *   - Dangerous imports/requires (child_process, fs with write, eval, exec)
 *   - Embedded scripts (javascript: URLs, data: URIs in suspicious contexts)
 */
export function scanSkillContent(
  name: string,
  content: string,
  tools: string[],
): SecurityScanResult {
  const warnings: SecurityWarning[] = [];
  const searchSpace = `${name} ${content} ${tools.join(' ')}`;

  // Shell injection patterns
  checkPatterns(searchSpace, SHELL_INJECTION_PATTERNS, warnings);

  // Path traversal
  checkPatterns(searchSpace, PATH_TRAVERSAL_PATTERNS, warnings);

  // Sensitive data exposure
  checkPatterns(searchSpace, SENSITIVE_DATA_PATTERNS, warnings);

  // Dangerous API references
  checkPatterns(searchSpace, DANGEROUS_API_PATTERNS, warnings);

  // Embedded executable content
  checkPatterns(searchSpace, EMBEDDED_EXEC_PATTERNS, warnings);

  return {
    passed: warnings.filter((w) => w.severity === 'high').length === 0,
    warnings,
  };
}

function checkPatterns(
  text: string,
  patterns: Array<{
    regex: RegExp;
    category: string;
    message: string;
    severity: 'low' | 'medium' | 'high';
  }>,
  warnings: SecurityWarning[],
): void {
  for (const p of patterns) {
    const match = text.match(p.regex);
    if (match) {
      warnings.push({
        severity: p.severity,
        category: p.category,
        message: p.message,
        match: match[0].length > 80 ? match[0].slice(0, 80) + '...' : match[0],
      });
    }
  }
}

// ============================================================================
// Pattern definitions
// ============================================================================

const SHELL_INJECTION_PATTERNS = [
  {
    regex: /\$\(.+?\)/g,
    category: 'shell_injection',
    severity: 'high' as const,
    message: 'Command substitution via $() detected — may allow arbitrary shell execution',
  },
  {
    regex: /`[^`]+`/g,
    category: 'shell_injection',
    severity: 'high' as const,
    message: 'Backtick command execution detected',
  },
  {
    regex: /\|\s*(bash|sh|zsh|cmd|powershell)\b/gi,
    category: 'shell_injection',
    severity: 'high' as const,
    message: 'Piped shell execution detected',
  },
  {
    regex: /\bexec\s*\(/gi,
    category: 'shell_injection',
    severity: 'high' as const,
    message: 'exec() call detected — potential arbitrary command execution',
  },
  {
    regex: /\bspawn\s*\(/gi,
    category: 'shell_injection',
    severity: 'high' as const,
    message: 'spawn() call detected — potential arbitrary process creation',
  },
];

const PATH_TRAVERSAL_PATTERNS = [
  {
    regex: /\.\.\/\.\.\/(?:\.\.\/)*/g,
    category: 'path_traversal',
    severity: 'high' as const,
    message: 'Path traversal detected (multiple ../) — may escape skill directory',
  },
  {
    regex: /\b(?:fs\.)?(?:write|unlink|rm|chmod|chown)\s*\(/gi,
    category: 'path_traversal',
    severity: 'medium' as const,
    message: 'File system mutation call detected — verify it targets allowed paths',
  },
  {
    regex: /\/(?:etc|usr|bin|boot|dev|proc|sys)\//g,
    category: 'path_traversal',
    severity: 'medium' as const,
    message: 'Reference to system directory — potentially dangerous path',
  },
];

const SENSITIVE_DATA_PATTERNS = [
  {
    regex:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}/gi,
    category: 'sensitive_data',
    severity: 'high' as const,
    message: 'Potential API key or secret detected in skill content',
  },
  {
    regex: /(?:sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,})/g,
    category: 'sensitive_data',
    severity: 'high' as const,
    message: 'OpenAI-style API key pattern detected',
  },
  {
    regex: /(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{36}/g,
    category: 'sensitive_data',
    severity: 'high' as const,
    message: 'GitHub token pattern detected',
  },
  {
    regex: /-----BEGIN\s+(?:\w+\s+)?PRIVATE\s+KEY-----/g,
    category: 'sensitive_data',
    severity: 'high' as const,
    message: 'Private key block detected',
  },
  {
    regex: /\bpassword\s*[:=]\s*['"][^'"]{3,}/gi,
    category: 'sensitive_data',
    severity: 'high' as const,
    message: 'Potential password detected',
  },
  {
    regex: /\btoken\s*[:=]\s*['"][A-Za-z0-9_\-\.]{16,}/gi,
    category: 'sensitive_data',
    severity: 'medium' as const,
    message: 'Potential auth token detected',
  },
];

const DANGEROUS_API_PATTERNS = [
  {
    regex: /\brequire\s*\(\s*['"]child_process['"]\s*\)/g,
    category: 'dangerous_api',
    severity: 'high' as const,
    message: 'Direct child_process require — use SkillExecutor instead',
  },
  {
    regex: /\bfrom\s+['"]child_process['"]/g,
    category: 'dangerous_api',
    severity: 'high' as const,
    message: 'Import of child_process — use SkillExecutor instead',
  },
  {
    regex: /\beval\s*\(/gi,
    category: 'dangerous_api',
    severity: 'high' as const,
    message: 'eval() call detected — security risk',
  },
  {
    regex: /\bFunction\s*\(/g,
    category: 'dangerous_api',
    severity: 'medium' as const,
    message: 'Function() constructor detected — potential code injection',
  },
  {
    regex: /\bnew\s+Function\s*\(/g,
    category: 'dangerous_api',
    severity: 'medium' as const,
    message: 'new Function() detected — potential code injection',
  },
];

const EMBEDDED_EXEC_PATTERNS = [
  {
    regex: /javascript\s*:/gi,
    category: 'embedded_exec',
    severity: 'medium' as const,
    message: 'javascript: URI detected — potential XSS vector',
  },
  {
    regex: /data:\s*text\/html\s*;/gi,
    category: 'embedded_exec',
    severity: 'medium' as const,
    message: 'data:text/html URI detected — potential XSS vector',
  },
  {
    regex: /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    category: 'embedded_exec',
    severity: 'medium' as const,
    message: 'HTML script tag detected in skill content',
  },
];

/**
 * Decide whether to block creation based on scan result.
 * Returns a reject reason string if the skill should be rejected, or null if allowed.
 */
export function rejectReason(scanResult: SecurityScanResult, skillName?: string): string | null {
  const highWarnings = scanResult.warnings.filter((w) => w.severity === 'high');
  if (highWarnings.length > 0) {
    return `Skill content rejected: ${highWarnings.length} high-severity security issue(s) found:\n${highWarnings
      .map((w) => `  [${w.category}] ${w.message} (matched: "${w.match}")`)
      .join('\n')}`;
  }

  const mediumWarnings = scanResult.warnings.filter((w) => w.severity === 'medium');
  if (mediumWarnings.length > 0) {
    getGlobalLogger().warn(
      'SkillSecurityScanner',
      `Skill "${skillName ?? 'unknown'}" has ${mediumWarnings.length} medium-severity warning(s)`,
      {
        warnings: mediumWarnings.map((w) => `${w.category}: ${w.message}`),
      },
    );
  }

  return null;
}
