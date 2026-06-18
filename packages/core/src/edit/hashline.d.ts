/**
 * Hashline Edit Format — content-hash anchored line-based edits.
 *
 * Inspired by oh-my-pi's hashline package. The model points at line numbers
 * from read output instead of retyping content, saving 50-80% tokens on edits.
 *
 * Format:
 *   ¶PATH#TAG
 *   replace N..M:
 *   +new line content
 *   +another new line
 *
 * Key properties:
 * - #TAG is 4-hex hash of file content → detects stale files before corruption
 * - Line numbers from read output → no ambiguity about which lines to change
 * - +TEXT body rows only → no retyping old content
 * - Stale-tag rejection prevents silent corruption
 */
export interface HashlineOp {
    type: 'replace' | 'delete' | 'insert';
    startLine: number;
    endLine?: number;
    position?: 'before' | 'after' | 'head' | 'tail';
    body: string[];
}
export interface HashlineSection {
    filePath: string;
    expectedHash: string;
    ops: HashlineOp[];
}
export interface HashlineParseResult {
    sections: HashlineSection[];
    errors: string[];
}
export interface HashlineApplyResult {
    success: boolean;
    filePath?: string;
    newContent?: string;
    newHash?: string;
    replacements?: number;
    error?: string;
    warnings?: string[];
}
/**
 * Parse a hashline input string into sections and operations.
 *
 * Input format:
 *   ¶PATH#TAG
 *   replace N..M:
 *   +line content
 *   delete N
 *   insert before N:
 *   +line content
 */
export declare function parseHashline(input: string): HashlineParseResult;
/**
 * Apply a parsed hashline section to a file.
 *
 * Steps:
 * 1. Read the file
 * 2. Validate hash matches expected
 * 3. Apply operations (in reverse line order to preserve line numbers)
 * 4. Write the result
 */
export declare function applyHashlineSection(section: HashlineSection): HashlineApplyResult;
/**
 * Format a hashline header for a file.
 */
export declare function formatHashlineHeader(filePath: string, hash: string): string;
/**
 * Format numbered lines in hashline display format.
 */
export declare function formatNumberedLines(content: string, startLine?: number): string;
/**
 * Check if input looks like hashline format (starts with ¶).
 */
export declare function isHashlineFormat(input: string): boolean;
//# sourceMappingURL=hashline.d.ts.map