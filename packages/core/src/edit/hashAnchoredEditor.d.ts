/**
 * HashAnchoredEditor — Content-hash-anchored file edits.
 *
 * Inspired by OhMyPi's hashline-anchored edits: instead of line numbers (which
 * drift), edits are anchored to content hashes. The LLM reads a file, gets
 * per-line content hashes, then references those hashes in edit operations.
 *
 * Key properties:
 * - Content hashes are SHA-256 truncated to 6 hex chars per line
 * - Edit format: @CONTENT_HASH→replacement (single-line) or
 *   @HASH1,HASH2→multi-line replacement
 * - 61% token reduction vs. retyping old content
 * - Drift-proof: hashes stay valid even when line numbers shift
 * - Collision detection: warns if two different lines share a hash
 *
 * File read output (enhanced):
 *   ¶src/config.ts#A1B2
 *     1:import { foo } from 'bar';                                #D4E5F6
 *     2:                                                          #A1B2C3
 *     3:const port = 3000;                                        #F7G8H9
 *
 * Edit format:
 *   ¶src/config.ts#A1B2
 *   @F7G8H9→const port = 8080;
 *
 * Multi-line edit:
 *   ¶src/config.ts#A1B2
 *   @F7G8H9,I0J1K2→
 *   const port = 8080;
 *   const host = '0.0.0.0';
 */
/** A content hash for a specific segment of text */
export interface ContentHashAnchor {
    /** 6-char hex hash */
    hash: string;
    /** The content this hash identifies */
    content: string;
    /** Line number in the file (1-indexed, for display only) */
    lineNumber: number;
    /** End line number for multi-line blocks (inclusive) */
    endLineNumber?: number;
}
/** A single hash-anchored edit */
export interface HashEditOp {
    /** Content hashes identifying the text to replace */
    hashes: string[];
    /** Replacement text (empty = delete) */
    replacement: string;
}
/** A parsed hash-edit file section */
export interface HashEditSection {
    filePath: string;
    /** File-level hash for staleness detection */
    expectedFileHash: string;
    ops: HashEditOp[];
}
/** Result of parsing hash-edit input */
export interface HashEditParseResult {
    sections: HashEditSection[];
    errors: string[];
}
/** Result of applying a hash-edit section */
export interface HashEditApplyResult {
    success: boolean;
    filePath?: string;
    newContent?: string;
    newHash?: string;
    replacements?: number;
    error?: string;
    warnings?: string[];
    /** Anchors that were not found (stale hashes) */
    unresolvedAnchors?: string[];
}
/**
 * Compute a content hash for a single line of text.
 * Uses SHA-256 truncated to CONTENT_HASH_LENGTH hex chars.
 * The hash includes the line content normalized (trailing whitespace stripped).
 */
export declare function computeLineHash(content: string): string;
/**
 * Compute content hashes for all lines in a file.
 * Returns an array of ContentHashAnchors, one per line.
 * Also detects hash collisions and returns warnings.
 */
export declare function computeFileAnchors(filePath: string, content: string): {
    anchors: ContentHashAnchor[];
    warnings: string[];
};
/**
 * Find an anchor by hash in a file's anchors array.
 * Returns the anchor or undefined if not found.
 */
export declare function findAnchor(anchors: ContentHashAnchor[], hash: string): ContentHashAnchor | undefined;
/**
 * Find a contiguous range of anchors matching a list of hashes.
 * Returns the anchors in order, or undefined if any hash is not found
 * or if the anchors are not contiguous.
 */
export declare function findAnchorRange(anchors: ContentHashAnchor[], hashes: string[]): ContentHashAnchor[] | undefined;
/**
 * Format file content with hashline header + numbered lines + per-line hashes.
 * Use this in file_read output to expose content hashes to the LLM.
 */
export declare function formatAnchoredOutput(filePath: string, content: string, options?: {
    offset?: number;
    limit?: number;
    maxChars?: number;
    includeHashes?: boolean;
}): string;
/**
 * Parse hash-anchored edit input.
 *
 * Format:
 *   ¶PATH#FILE_HASH
 *   @CONTENT_HASH→replacement text
 *   @HASH1,HASH2→
 *   multi-line
 *   replacement
 *
 * Returns parsed sections with errors for malformed input.
 */
export declare function parseHashEdit(input: string): HashEditParseResult;
/**
 * Apply a parsed hash-edit section to a file.
 *
 * Steps:
 * 1. Read the file
 * 2. Validate file-level hash
 * 3. Compute content anchors
 * 4. Resolve content hashes to line positions
 * 5. Apply replacements (in reverse order to preserve line positions)
 * 6. Atomic write
 */
export declare function applyHashEdit(section: HashEditSection): HashEditApplyResult;
/**
 * Check if input looks like hash-edit format (starts with ¶ and contains @hash→).
 */
export declare function isHashEditFormat(input: string): boolean;
/**
 * Parse AND apply hash-edit input in one call.
 * Returns combined results for all sections.
 */
export declare function parseAndApplyHashEdit(input: string): string;
//# sourceMappingURL=hashAnchoredEditor.d.ts.map