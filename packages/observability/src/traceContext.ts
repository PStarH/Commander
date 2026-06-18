/**
 * P-obs-1: W3C Trace Context propagation.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 *
 * The `traceparent` header carries a single trace from one process to
 * another. Format (version 00):
 *
 *   version-traceid-parentid-flags
 *   00-<32 hex>-<16 hex>-<2 hex>
 *
 * - version: 2 hex chars (currently "00")
 * - trace-id: 32 hex chars (16 bytes) — global trace identifier
 * - parent-id (a.k.a. span-id): 16 hex chars (8 bytes) — caller span
 * - flags: 2 hex chars — bit 0 = sampled (01), bit 1 = random-trace-id (02)
 *
 * The optional `tracestate` header is a comma-separated list of
 * vendor-specific key=value pairs. Commander doesn't generate them but
 * does pass them through when present (operator-visible).
 *
 * Why this matters: when an HTTP request arrives with `traceparent`,
 * we extract the trace-id and continue the trace instead of starting
 * a new one. When we make an outbound LLM/tool call, we emit
 * `traceparent` so the receiver can correlate. Without this, every
 * service boundary looks like a new trace in the OTel backend.
 */

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_RE = /^[a-z0-9][a-z0-9_\-*/=]{0,256}(?:,[a-z0-9][a-z0-9_\-*/=]{0,256})*$/i;

export interface TraceContext {
  /** 32-char hex string. Globally unique per trace. */
  traceId: string;
  /** 16-char hex string. The caller span. */
  parentSpanId: string;
  /** Bit 0 of the flags byte. */
  sampled: boolean;
  /** Raw header for round-tripping to outbound calls. */
  raw: string;
}

export class TraceContextParseError extends Error {
  constructor(reason: string) {
    super(`Invalid W3C traceparent: ${reason}`);
  }
}

export function parseTraceparent(header: string | null | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const m = TRACEPARENT_RE.exec(trimmed);
  if (!m) {
    // Per spec, ignore malformed headers (don't throw) so a bad
    // upstream doesn't kill the request.
    return undefined;
  }
  const [, _version, traceId, parentSpanId, flagsHex] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Reserved trace-id (all zeros) is invalid.
  if (traceId === '0'.repeat(32)) return undefined;
  // Reserved parent-id (all zeros) is invalid.
  if (parentSpanId === '0'.repeat(16)) return undefined;
  const flags = parseInt(flagsHex, 16);
  return {
    traceId,
    parentSpanId,
    sampled: (flags & 0x01) === 0x01,
    raw: trimmed,
  };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  // Validate inputs — refuse to emit malformed values.
  if (!/^[0-9a-f]{32}$/.test(traceId)) {
    throw new TraceContextParseError(`traceId must be 32 hex chars, got '${traceId}'`);
  }
  if (!/^[0-9a-f]{16}$/.test(spanId)) {
    throw new TraceContextParseError(`spanId must be 16 hex chars, got '${spanId}'`);
  }
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${flags}`;
}

export function parseTracestate(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (!TRACESTATE_RE.test(trimmed)) return undefined;
  return trimmed;
}

/** Extract trace context from an IncomingMessage's headers. */
export function extractTraceContext(
  headers: Record<string, string | string[] | undefined>,
): TraceContext | undefined {
  const raw = headers['traceparent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return parseTraceparent(value);
}

/**
 * Generate a new 32-char hex trace ID. Uses crypto.randomBytes
 * when available; falls back to Math.random for environments
 * without crypto (browsers, some test runners).
 */
export function generateTraceId(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback: not cryptographically strong, but valid hex.
  let id = '';
  while (id.length < 32) {
    id += Math.floor(Math.random() * 0xffffffff).toString(16);
  }
  return id.slice(0, 32);
}

/** Generate a new 16-char hex span ID. */
export function generateSpanId(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let id = '';
  while (id.length < 16) {
    id += Math.floor(Math.random() * 0xffffffff).toString(16);
  }
  return id.slice(0, 16);
}
