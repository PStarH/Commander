/**
 * Canonical JSON + idempotency key generation.
 *
 * The whole point of idempotency is: same logical request → same key.
 * That requires a stable serialization that is invariant to:
 *   - key ordering in objects
 *   - Date / RegExp / Buffer / Map / Set instances
 *   - number precision
 *   - whitespace
 *
 * This module is the single source of truth for "how to hash an ATR request".
 */
/**
 * Serialize a value to canonical JSON: object keys sorted, recursive, stable
 * representation of all JSON-coercible values. Non-coercible values throw.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * SHA-256 of the canonical JSON representation.
 */
export declare function sha256OfCanonical(value: unknown): string;
/**
 * Normalize a goal string and hash it. The intent hash is part of every
 * idempotency key — same intent + same action = same key.
 *
 * Normalization: trim, lowercase, collapse whitespace. This is a heuristic;
 * callers needing stricter semantics should pre-normalize.
 */
export declare function hashIntent(goal: string): string;
export interface IdempotencyKeyInput {
    /** External system being touched (github, stripe, slack, db, fs, llm, mcp, shell) */
    externalSystem: string;
    /** Tool name */
    toolName: string;
    /** Tool arguments (will be canonicalized) */
    args: Record<string, unknown>;
    /** Intent hash from hashIntent() */
    intentHash: string;
    /** Originating run ID */
    runId: string;
    /** Step ID within the run (allows multiple calls of the same tool in one run) */
    stepId: string;
}
/**
 * Generate a deterministic idempotency key for a tool call.
 *
 * Formula: SHA256({
 *   ext: externalSystem,
 *   tool: toolName,
 *   args: canonicalJson(args),
 *   intent: intentHash,
 *   run: runId,
 *   step: stepId,
 * })
 *
 * Same input → same key → idempotent.
 */
export declare function generateIdempotencyKey(input: IdempotencyKeyInput): string;
//# sourceMappingURL=canonicalJson.d.ts.map