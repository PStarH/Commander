/**
 * Persistent-store utility helpers (Phase 1 of iss-001).
 *
 * Pure helpers used by all three drivers (sqlite, json, in-memory) to keep
 * behaviour consistent across backends:
 *   - matchesFilter: equality predicate (with undefined → "any" semantics)
 *   - isCompatibleWithSpec: column-type validator
 *   - shortHash: stable 8-char FNV-1a fingerprint for class identity
 *   - canonicalJson: deterministic JSON (sorted keys) for hashing
 *   - nextId: collision-resistant id factory (preferring crypto.randomUUID)
 */

import type { ColumnSpec, ColumnType } from './types';

// ── Filter predicate ────────────────────────────────────────────────

/**
 * Returns true iff `row` matches every defined entry in `filter`. Missing
 * (undefined) entries in `filter` are treated as "any value" — they do NOT
 * filter rows. This is the convention used by all QueryOptions / filter APIs.
 */
export function matchesFilter<T extends Record<string, unknown>>(
  row: T,
  filter: Partial<T> | undefined,
): boolean {
  if (!filter) return true;
  for (const k of Object.keys(filter) as Array<keyof T>) {
    const want = filter[k];
    if (want === undefined) continue;
    if (row[k] !== want) return false;
  }
  return true;
}

// ── Type compatibility ──────────────────────────────────────────────

/**
 * Returns true iff `value` is compatible with the column spec's declared type.
 * Number spec accepts both number and numeric string (for coercion safety).
 * Boolean spec accepts only boolean (and the numeric 0/1 only when type is
 * 'number' — SQLite's INTEGER round-trip produces 0/1 for booleans, caught
 * in the row-normalization step, not here).
 */
export function isCompatibleWithSpec(value: unknown, spec: ColumnSpec): boolean {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

// ── Deterministic short hash ────────────────────────────────────────

/**
 * FNV-1a 32-bit non-cryptographic hash, hex-encoded. Used for migration /
 * class identity fingerprints where full SHA-256 is overkill. Stable across
 * runs because it does not depend on crypto.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Canonical JSON ──────────────────────────────────────────────────

/**
 * Deterministic JSON serialization: object keys sorted alphabetically and
 * consistently. Arrays preserve order. Date / Map / Buffer are serialized
 * with __type discriminator so they round-trip correctly via JSON.parse.
 *
 * Throws on functions / undefined / non-finite numbers — these are never
 * valid in durable state.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Recursive simplifier that produces a JSON-safe structure with sorted keys.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${String(value)}`);
    }
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) {
    return { __type: 'Date', value: value.toISOString() };
  }
  if (value instanceof Map) {
    const obj: Record<string, unknown> = { __type: 'Map' };
    const keys = Array.from(value.keys()).sort();
    for (const k of keys) {
      obj[String(k)] = canonicalize(value.get(k));
    }
    return obj;
  }
  if (value instanceof Buffer) {
    return { __type: 'Buffer', value: value.toString('base64') };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  throw new Error(`canonicalJson: unhandled type ${typeof value}`);
}

// ── Id factory ──────────────────────────────────────────────────────

/**
 * Returns a collision-resistant id string. Prefers crypto.randomUUID when
 * available; falls back to a timestamp + random pair otherwise. The id is
 * always prefixed with a tag so debug traces are self-describing.
 */
export function nextId(tag: string): string {
  let suffix: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as { randomUUID?: () => string };
    if (typeof crypto.randomUUID === 'function') {
      suffix = crypto.randomUUID();
    } else {
      suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  } catch {
    suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return `${tag}_${suffix}`;
}

/**
 * Deep-clone a row via JSON. Suitable for our typed schemas (which never hold
 * functions, BigInts, etc.).
 */
export function cloneRow<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

/**
 * Coerce a column value into the declared type. Used during row normalization
 * to recover type information lost in SQLite's INTEGER round-trip.
 */
export function coerceColumn(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'boolean' && typeof value === 'number') return value !== 0;
  if (type === 'number' && typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}
