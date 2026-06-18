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
export declare function scanSkillContent(name: string, content: string, tools: string[]): SecurityScanResult;
/**
 * Decide whether to block creation based on scan result.
 * Returns a reject reason string if the skill should be rejected, or null if allowed.
 */
export declare function rejectReason(scanResult: SecurityScanResult, skillName?: string): string | null;
//# sourceMappingURL=skillSecurityScanner.d.ts.map