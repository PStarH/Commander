/**
 * traceContextBridge — propagates W3C Trace Context across Commander
 * in-process boundaries where added in v0.10 (AgentInbox messages,
 * AgentHandoff requests) so a single trace survives the cross-process /
 * cross-agent handoff rather than starting a new one.
 *
 * Why a dedicated module (vs. mutating existing files):
 *   - AgentInbox + AgentHandoff have `payload?: Record<string, unknown>`,
 *     which already supports optional fields without schema breakage.
 *   - The bridge owns the reserved `cmdr_trace_context` key so downstream
 *     consumers (HTTP server, sagaCoordinator, mcpServer) can find it
 *     without colliding with user-supplied payload keys. The chosen
 *     prefix `cmdr_` was selected to be extremely unlikely to collide
 *     with arbitrary consumer payload keys; collisions are still
 *     detected at inject time and surfaced via the bridge's audit
 *     logger so callers can correct their payload schema.
 *   - Tests exercise the bridge standalone without spinning up inbox +
 *     handoff plumbing.
 *
 * Threat model:
 *   - The W3C spec says to *ignore* malformed headers. So both readers
 *     and writers do validation and silently skip invalid values.
 *   - Cross-process propagation is opt-in: callers must explicitly
 *     pass the trace context. We never invent one out of thin air
 *     because that would split a trace that the upstream already
 *     established through the OTel collector.
 *
 * Reserved key: 'cmdr_trace_context' (prefix `cmdr_` chosen to be
 * extremely unlikely to collide with arbitrary user payload keys).
 */

import {
  formatTraceparent,
  parseTraceparent,
  parseTracestate,
  generateSpanId,
  generateTraceId,
  type TraceContext,
} from './traceContext';

export interface InboxTraceContext {
  /** Valid W3C `traceparent` header value (version 00). */
  traceparent: string;
  /** Optional W3C `tracestate` header value, vendor-specific key=value pairs. */
  tracestate?: string;
}

export const RESERVED_TRACE_CONTEXT_KEY = 'cmdr_trace_context';

/**
 * Build an InboxTraceContext from a parsed TraceContext + optional tracestate.
 * Throws (caller catches and falls back to no-op) if inputs are invalid.
 */
export function buildInboxTraceContext(ctx: TraceContext, tracestate?: string): InboxTraceContext {
  // Re-emit canonical: traceparent must be re-derived from formatted form so
  // any padding/normalization is consistent across handoffs.
  const tp = formatTraceparent(ctx.traceId, ctx.parentSpanId, ctx.sampled);
  const ts = parseTracestate(tracestate);
  return ts ? { traceparent: tp, tracestate: ts } : { traceparent: tp };
}

/**
 * Extract an InboxTraceContext from a parsed traceparent + tracestate pair,
 * or return undefined if the traceparent is malformed/invalid. W3C says
 * silently ignore — we do the same.
 */
export function extractInboxTraceContext(
  traceparent: string | null | undefined,
  tracestate?: string | null,
): InboxTraceContext | undefined {
  const ctx = parseTraceparent(traceparent);
  if (!ctx) return undefined;
  return buildInboxTraceContext(ctx, tracestate ?? undefined);
}

/**
 * Inject trace context into a payload dict. Mutates a SHALLOW COPY and
 * returns it; if traceContext is undefined, returns the original dict
 * untouched. So no-protocol-break path is the default.
 *
 * If the caller's payload ALREADY carries a value under the reserved
 * key, we do NOT overwrite it — caller wins. This prevents the bridge
 * from accidentally destroying consumer data when the namespace collides.
 * The contract is documented; downstream code reading the reserved key
 * should treat it as "best-effort, may be absent".
 */
export function injectTraceContext(
  payload: Record<string, unknown> | undefined,
  traceContext: InboxTraceContext | undefined,
): Record<string, unknown> | undefined {
  if (!traceContext) return payload;
  const out: Record<string, unknown> = { ...(payload ?? {}) };
  // Refuse to clobber an existing same-key entry. The first writer wins.
  if (
    Object.prototype.hasOwnProperty.call(out, RESERVED_TRACE_CONTEXT_KEY) &&
    out[RESERVED_TRACE_CONTEXT_KEY] !== undefined
  ) {
    return out;
  }
  out[RESERVED_TRACE_CONTEXT_KEY] = traceContext;
  return out;
}

/**
 * Read the trace context out of a payload dict. Returns undefined if
 * absent. Removes the key from the returned dict so the caller can
 * re-serialize the payload without exposing Commander-internal keys
 * to downstream tooling (e.g. user-visible message UI).
 */
export function extractTraceContext(payload: Record<string, unknown> | undefined): {
  traceContext: InboxTraceContext | undefined;
  cleaned: Record<string, unknown>;
} {
  if (!payload) return { traceContext: undefined, cleaned: {} };
  // Make sure we don't leak __traceContext into user-visible payload.
  if (!Object.prototype.hasOwnProperty.call(payload, RESERVED_TRACE_CONTEXT_KEY)) {
    // No trace context present, return as-is shallow copy.
    return { traceContext: undefined, cleaned: { ...payload } };
  }
  const raw = payload[RESERVED_TRACE_CONTEXT_KEY];
  // Validate shape: only accept object literals with a string traceparent.
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof (raw as Record<string, unknown>).traceparent !== 'string' ||
    !isValidTraceparent((raw as Record<string, unknown>).traceparent as string)
  ) {
    // Strip the bad value; do not propagate malformed context.
    const { [RESERVED_TRACE_CONTEXT_KEY]: _drop, ...rest } = payload;
    return { traceContext: undefined, cleaned: rest };
  }
  const rawObj = raw as Record<string, unknown>;
  const candidate: InboxTraceContext = {
    traceparent: rawObj.traceparent as string,
  };
  if (typeof rawObj.tracestate === 'string') {
    const ts = parseTracestate(rawObj.tracestate);
    if (ts) candidate.tracestate = ts;
  }
  // Strip the key from the cleaned payload.
  const { [RESERVED_TRACE_CONTEXT_KEY]: _drop, ...rest } = payload;
  return { traceContext: candidate, cleaned: rest };
}

/**
 * Generate a NEW trace context for outbound handoffs when no upstream
 * `traceparent` is available. Uses the same generator helpers from
 * `traceContext.ts` so the format matches OTel expectations.
 *
 * Returned shape is the *string* form, ready for inclusion in:
 *   - InboxMessage.payload.cmdr_trace_context (InboxTraceContext)
 *   - HTTP `traceparent` header
 *   - Saga step boundary
 */
export function generateNewTraceContext(sampled = true): InboxTraceContext {
  // Reuse the upstream generators so any future change (e.g. a different
  // random source for cryptographic strictness) propagates automatically.
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  return {
    traceparent: formatTraceparent(traceId, spanId, sampled),
  };
}

function isValidTraceparent(s: string): boolean {
  return typeof s === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(s);
}
