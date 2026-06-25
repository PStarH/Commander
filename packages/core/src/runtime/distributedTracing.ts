/**
 * Distributed Tracing — Request ID Propagation
 *
 * Propagates request IDs across all layers:
 * - HTTP requests → Agent Runtime → Tool Execution → LLM Calls
 * - Message Bus events
 * - Log entries
 * - Trace spans
 *
 * Enables:
 * - End-to-end request tracing
 * - Performance bottleneck identification
 * - Error root cause analysis
 * - Cross-service correlation
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { AsyncLocalStorage } from 'async_hooks';
import { getGlobalLogger } from '../logging';
import type { IncomingMessage, ServerResponse } from 'http';

declare module 'http' {
  interface IncomingMessage {
    requestId?: string;
    traceContext?: TraceContext;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface TraceContext {
  /** Unique request ID (UUID) */
  requestId: string;
  /** Parent span ID (for nested operations) */
  parentSpanId?: string;
  /** Current span ID */
  spanId: string;
  /** Trace ID (shared across all spans in a request) */
  traceId: string;
  /** Baggage items (propagated across service boundaries) */
  baggage: Record<string, string>;
  /** Start time of the current span */
  startTime: number;
}

export interface SpanOptions {
  /** Operation name */
  operation: string;
  /** Component name */
  component: string;
  /** Additional attributes */
  attributes?: Record<string, unknown>;
}

// ============================================================================
// AsyncLocalStorage for Trace Context
// ============================================================================

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Get the current trace context from AsyncLocalStorage.
 * Returns undefined if not in a traced context.
 */
export function getCurrentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Run a function within a trace context.
 * All code within the function will have access to the trace context.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Create a new trace context for a request.
 */
export function createTraceContext(requestId?: string): TraceContext {
  const traceId = requestId ?? crypto.randomUUID();
  const spanId = crypto.randomUUID();
  return {
    requestId: traceId,
    traceId,
    spanId,
    baggage: {},
    startTime: Date.now(),
  };
}

/**
 * Create a child span within the current trace context.
 */
export function createChildSpan(_options: SpanOptions): TraceContext | undefined {
  const parent = getCurrentTraceContext();
  if (!parent) return undefined;

  return {
    requestId: parent.requestId,
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    spanId: crypto.randomUUID(),
    baggage: { ...parent.baggage },
    startTime: Date.now(),
  };
}

// ============================================================================
// Trace-Aware Logging
// ============================================================================

/**
 * Log with trace context.
 * Automatically includes requestId, traceId, spanId in log entries.
 */
export function traceLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  component: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const trace = getCurrentTraceContext();
  const logger = getGlobalLogger();

  const enrichedContext = {
    ...context,
    ...(trace
      ? {
          requestId: trace.requestId,
          traceId: trace.traceId,
          spanId: trace.spanId,
          parentSpanId: trace.parentSpanId,
        }
      : {}),
  };

  if (level === 'error') {
    (logger.error as (c: string, m: string, ctx?: Record<string, unknown>) => void)(
      component,
      message,
      enrichedContext,
    );
  } else {
    logger[level](component, message, enrichedContext);
  }
}

// ============================================================================
// HTTP Header Propagation
// ============================================================================

const TRACE_HEADERS = {
  requestId: 'x-request-id',
  traceId: 'x-trace-id',
  spanId: 'x-span-id',
  baggage: 'x-baggage',
} as const;

/**
 * Extract trace context from HTTP headers.
 */
export function extractTraceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): TraceContext | undefined {
  const requestId = headers[TRACE_HEADERS.requestId] as string;
  if (!requestId) return undefined;

  const traceId = (headers[TRACE_HEADERS.traceId] as string) ?? requestId;
  const spanId = crypto.randomUUID();
  let baggage: Record<string, string> = {};

  try {
    const baggageHeader = headers[TRACE_HEADERS.baggage] as string;
    if (baggageHeader) {
      baggage = JSON.parse(baggageHeader);
    }
  } catch (err) {
    reportSilentFailure(err, 'distributedTracing:172');
    /* ignore malformed baggage */
  }

  return {
    requestId,
    traceId,
    spanId,
    baggage,
    startTime: Date.now(),
  };
}

/**
 * Inject trace context into HTTP headers.
 */
export function injectTraceIntoHeaders(
  headers: Record<string, string>,
  context?: TraceContext,
): void {
  const trace = context ?? getCurrentTraceContext();
  if (!trace) return;

  headers[TRACE_HEADERS.requestId] = trace.requestId;
  headers[TRACE_HEADERS.traceId] = trace.traceId;
  headers[TRACE_HEADERS.spanId] = trace.spanId;

  if (Object.keys(trace.baggage).length > 0) {
    headers[TRACE_HEADERS.baggage] = JSON.stringify(trace.baggage);
  }
}

// ============================================================================
// Message Bus Integration
// ============================================================================

/**
 * Enrich a message bus event with trace context.
 */
export function enrichWithTrace<T>(event: T): T & { trace?: TraceContext } {
  const trace = getCurrentTraceContext();
  if (!trace) return event as T & { trace?: TraceContext };
  return { ...event, trace };
}

/**
 * Extract trace context from a message bus event.
 */
export function extractTraceFromEvent(event: { trace?: TraceContext }): TraceContext | undefined {
  return event.trace;
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Express middleware that sets up trace context for each request.
 */
export function traceMiddleware(
  req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  const rawRequestId = req.headers['x-request-id'] ?? req.requestId ?? crypto.randomUUID();
  const requestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
  const context = extractTraceFromHeaders(req.headers) ?? createTraceContext(requestId);

  // Store in request for downstream use
  req.traceContext = context;

  // Run the rest of the request in the trace context
  runWithTrace(context, () => {
    next();
  });
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Get the current request ID, or generate one if not in a trace context.
 */
export function getRequestId(): string {
  const trace = getCurrentTraceContext();
  return trace?.requestId ?? crypto.randomUUID();
}

/**
 * Get the current trace ID, or generate one if not in a trace context.
 */
export function getTraceId(): string {
  const trace = getCurrentTraceContext();
  return trace?.traceId ?? crypto.randomUUID();
}

/**
 * Add baggage item to the current trace context.
 */
export function setBaggage(key: string, value: string): void {
  const trace = getCurrentTraceContext();
  if (trace) {
    trace.baggage[key] = value;
  }
}

/**
 * Get baggage item from the current trace context.
 */
export function getBaggage(key: string): string | undefined {
  const trace = getCurrentTraceContext();
  return trace?.baggage[key];
}
