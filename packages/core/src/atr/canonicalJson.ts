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

import { createHash } from 'crypto';

// ============================================================================
// Canonical JSON
// ============================================================================

/**
 * Serialize a value to canonical JSON: object keys sorted, recursive, stable
 * representation of all JSON-coercible values. Non-coercible values throw.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalJson: non-finite number ${value}`);
    }
    return value;
  }
  if (t === 'bigint') return (value as bigint).toString();
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
    const obj: Record<string, unknown> = { __type: 'Map' };
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
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

function stringCompare(a: unknown, b: unknown): number {
  return String(a).localeCompare(String(b));
}

function deepCompare(a: unknown, b: unknown): number {
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
export function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Normalize a goal string and hash it. The intent hash is part of every
 * idempotency key — same intent + same action = same key.
 *
 * Normalization: trim, lowercase, collapse whitespace. This is a heuristic;
 * callers needing stricter semantics should pre-normalize.
 */
export function hashIntent(goal: string): string {
  const normalized = goal.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

// ============================================================================
// Idempotency Key Generation
// ============================================================================

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
export function generateIdempotencyKey(input: IdempotencyKeyInput): string {
  const payload = {
    ext: input.externalSystem,
    tool: input.toolName,
    args: canonicalize(input.args),
    intent: input.intentHash,
    run: input.runId,
    step: input.stepId,
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
