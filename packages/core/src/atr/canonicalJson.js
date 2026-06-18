"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalJson = canonicalJson;
exports.sha256OfCanonical = sha256OfCanonical;
exports.hashIntent = hashIntent;
exports.generateIdempotencyKey = generateIdempotencyKey;
const crypto_1 = require("crypto");
// ============================================================================
// Canonical JSON
// ============================================================================
/**
 * Serialize a value to canonical JSON: object keys sorted, recursive, stable
 * representation of all JSON-coercible values. Non-coercible values throw.
 */
function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
function canonicalize(value) {
    if (value === null || value === undefined)
        return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean')
        return value;
    if (t === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`canonicalJson: non-finite number ${value}`);
        }
        return value;
    }
    if (t === 'bigint')
        return value.toString();
    if (t === 'function' || t === 'symbol') {
        throw new Error(`canonicalJson: cannot serialize ${t}`);
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value instanceof Date) {
        return { __type: 'Date', value: value.toISOString() };
    }
    if (value instanceof RegExp) {
        return { __type: 'RegExp', value: value.toString() };
    }
    if (value instanceof Map) {
        const obj = { __type: 'Map' };
        const keys = Array.from(value.keys()).sort(stringCompare);
        for (const k of keys) {
            obj[String(k)] = canonicalize(value.get(k));
        }
        return obj;
    }
    if (value instanceof Set) {
        return {
            __type: 'Set',
            value: Array.from(value).map(canonicalize).sort(deepCompare),
        };
    }
    if (Buffer.isBuffer(value)) {
        return { __type: 'Buffer', value: value.toString('base64') };
    }
    // Plain object
    if (t === 'object') {
        const obj = value;
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = canonicalize(obj[key]);
        }
        return sorted;
    }
    throw new Error(`canonicalJson: unsupported type ${t}`);
}
function stringCompare(a, b) {
    return String(a).localeCompare(String(b));
}
function deepCompare(a, b) {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
// ============================================================================
// Hashing
// ============================================================================
/**
 * SHA-256 of the canonical JSON representation.
 */
function sha256OfCanonical(value) {
    return (0, crypto_1.createHash)('sha256').update(canonicalJson(value)).digest('hex');
}
/**
 * Normalize a goal string and hash it. The intent hash is part of every
 * idempotency key — same intent + same action = same key.
 *
 * Normalization: trim, lowercase, collapse whitespace. This is a heuristic;
 * callers needing stricter semantics should pre-normalize.
 */
function hashIntent(goal) {
    const normalized = goal.trim().toLowerCase().replace(/\s+/g, ' ');
    return (0, crypto_1.createHash)('sha256').update(normalized).digest('hex');
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
function generateIdempotencyKey(input) {
    const payload = {
        ext: input.externalSystem,
        tool: input.toolName,
        args: canonicalize(input.args),
        intent: input.intentHash,
        run: input.runId,
        step: input.stepId,
    };
    return (0, crypto_1.createHash)('sha256').update(canonicalJson(payload)).digest('hex');
}
