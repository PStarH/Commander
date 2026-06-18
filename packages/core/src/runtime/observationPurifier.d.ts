/**
 * Observation Purifier — Content-aware stripping for tool outputs.
 *
 * Replaces blind truncation with format-specific compression that preserves
 * semantic meaning:
 *   - HTML → Markdown-ish text (strip scripts/styles, collapse whitespace)
 *   - JSON → minified JSON, optionally extract relevant sections
 *   - Stack traces → keep first/last frames, deduplicate repeated frames
 *   - Generic → route by tool name or fall back to head-tail truncation
 *
 * Never drops error signals. Falls back to the original output if purification
 * would lose information.
 */
export interface PurifyOptions {
    /** Maximum characters to return after purification. 0 = no limit. */
    maxChars?: number;
    /** For JSON: extract only this top-level key if present. */
    jsonKey?: string;
    /** For stack traces: number of frames to keep at top and bottom. */
    stackFrames?: number;
}
/** Detect whether content looks like HTML. */
export declare function looksLikeHtml(content: string): boolean;
/** Detect whether content looks like JSON. */
export declare function looksLikeJson(content: string): boolean;
/** Detect whether content looks like a stack trace. */
export declare function looksLikeStackTrace(content: string): boolean;
/** Quick check if output contains an error signal that must be preserved. */
export declare function containsErrorSignal(content: string): boolean;
/**
 * Strip HTML tags and convert common constructs to markdown.
 * Preserves links, headings, lists, and tables (crudely).
 */
export declare function purifyHtml(content: string, maxChars?: number): string;
/**
 * Minify JSON and optionally extract a specific top-level key.
 */
export declare function purifyJson(content: string, options?: PurifyOptions): string;
/**
 * Deduplicate and truncate stack traces.
 */
export declare function purifyStackTrace(content: string, options?: PurifyOptions): string;
/**
 * Route output to the appropriate purifier based on content shape.
 */
export declare function purifyObservation(content: string, toolName?: string, options?: PurifyOptions): string;
/**
 * Purify a batch of tool results, preserving error outputs.
 */
export declare function purifyToolResults(results: Array<{
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
}>): Array<{
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
}>;
//# sourceMappingURL=observationPurifier.d.ts.map