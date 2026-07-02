import { describe, expect, it } from 'vitest';
import {
  RESERVED_TRACE_CONTEXT_KEY,
  buildInboxTraceContext,
  extractInboxTraceContext,
  extractTraceContext,
  generateNewTraceContext,
  injectTraceContext,
} from '../../../src/observability/traceContextBridge';
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
} from '../../../src/observability/traceContext';

const VALID_TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe('traceContextBridge', () => {
  describe('buildInboxTraceContext / parseTraceparent roundtrip', () => {
    it('produces a parseable traceparent', () => {
      const ctx = buildInboxTraceContext({
        traceId: generateTraceId(),
        parentSpanId: generateSpanId(),
        sampled: true,
        raw: '',
      });
      expect(ctx.traceparent).toMatch(VALID_TRACEPARENT_REGEX);
      // Round-trip: parse it back and confirm fields.
      const parsed = parseTraceparent(ctx.traceparent);
      expect(parsed).toBeDefined();
      expect(parsed?.sampled).toBe(true);
    });

    it('propagates tracestate when supplied (canonical form)', () => {
      const ctx = buildInboxTraceContext(
        {
          traceId: generateTraceId(),
          parentSpanId: generateSpanId(),
          sampled: false,
          raw: '',
        },
        'vendor=abc123',
      );
      expect(ctx.tracestate).toBe('vendor=abc123');
    });

    it('drops malformed tracestate (silent ignore per W3C)', () => {
      const ctx = buildInboxTraceContext(
        {
          traceId: generateTraceId(),
          parentSpanId: generateSpanId(),
          sampled: true,
          raw: '',
        },
        '<invalid tracestate>',
      );
      expect(ctx.tracestate).toBeUndefined();
    });
  });

  describe('extractInboxTraceContext', () => {
    it('returns undefined when traceparent is malformed', () => {
      expect(extractInboxTraceContext('not-a-traceparent')).toBeUndefined();
      expect(extractInboxTraceContext('')).toBeUndefined();
      expect(extractInboxTraceContext(undefined)).toBeUndefined();
    });

    it('returns InboxTraceContext when traceparent is valid', () => {
      const tp = formatTraceparent(generateTraceId(), generateSpanId(), true);
      const ctx = extractInboxTraceContext(tp, 'vendor=z');
      expect(ctx).toBeDefined();
      expect(ctx?.traceparent).toBe(tp);
      expect(ctx?.tracestate).toBe('vendor=z');
    });
  });

  describe('injectTraceContext', () => {
    it('returns payload untouched when traceContext is undefined', () => {
      const payload = { foo: 'bar' };
      expect(injectTraceContext(payload, undefined)).toBe(payload);
    });

    it('returns undefined when payload is undefined and traceContext is undefined', () => {
      expect(injectTraceContext(undefined, undefined)).toBeUndefined();
    });

    it("writes trace context into a shallow copy without mutating the caller's dict", () => {
      const payload = { foo: 'bar' };
      const result = injectTraceContext(payload, { traceparent: 'invalid' });
      // Malformed: helper still writes it (validation happens on extract),
      // original is untouched.
      expect(payload).toEqual({ foo: 'bar' });
      expect(result).not.toBe(payload);
      expect(result?.[RESERVED_TRACE_CONTEXT_KEY]).toEqual({ traceparent: 'invalid' });
    });

    it("does not overwrite an existing same-key entry silently — keeps the caller's value", () => {
      // FLAW-fix guard: a user payload that already carries a value under
      // the reserved key wins over our injected context. This avoids
      // destroying user data when a downstream consumer happened to
      // choose the same key namespace.
      const existing = { traceparent: '00-existing' };
      const payload = { foo: 'bar', [RESERVED_TRACE_CONTEXT_KEY]: existing };
      const result = injectTraceContext(payload, {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      });
      expect(result?.[RESERVED_TRACE_CONTEXT_KEY]).toEqual(existing);
    });
  });

  describe('extractTraceContext (from payload)', () => {
    it('returns undefined + shallow copy when key is absent', () => {
      const { traceContext, cleaned } = extractTraceContext({ foo: 'bar' });
      expect(traceContext).toBeUndefined();
      expect(cleaned).toEqual({ foo: 'bar' });
    });

    it('returns parsed context + strips reserved key from cleaned payload', () => {
      const tp = formatTraceparent(generateTraceId(), generateSpanId(), true);
      const { traceContext, cleaned } = extractTraceContext({
        foo: 'bar',
        [RESERVED_TRACE_CONTEXT_KEY]: { traceparent: tp, tracestate: 'vendor=z' },
      });
      expect(traceContext).toEqual({ traceparent: tp, tracestate: 'vendor=z' });
      expect(cleaned).toEqual({ foo: 'bar' }); // __traceContext is stripped
      expect((cleaned as Record<string, unknown>)[RESERVED_TRACE_CONTEXT_KEY]).toBeUndefined();
    });

    it('does NOT propagate malformed trace context — strips and warned by absence', () => {
      const { traceContext, cleaned } = extractTraceContext({
        foo: 'bar',
        [RESERVED_TRACE_CONTEXT_KEY]: { traceparent: 'malformed-traceparent-value' },
      });
      expect(traceContext).toBeUndefined();
      expect(cleaned).toEqual({ foo: 'bar' });
    });

    it('returns undefined cleanly when payload is undefined', () => {
      const { traceContext, cleaned } = extractTraceContext(undefined);
      expect(traceContext).toBeUndefined();
      expect(cleaned).toEqual({});
    });
  });

  describe('generateNewTraceContext', () => {
    it('produces a valid W3C traceparent header', () => {
      const ctx = generateNewTraceContext(true);
      expect(ctx.traceparent).toMatch(VALID_TRACEPARENT_REGEX);
    });

    it('two invocations produce distinct trace IDs', () => {
      const a = generateNewTraceContext(true).traceparent;
      const b = generateNewTraceContext(true).traceparent;
      expect(a).not.toBe(b);
    });
  });

  describe('reserved key contract', () => {
    it("RESERVED_TRACE_CONTEXT_KEY is exactly 'cmdr_trace_context'", () => {
      expect(RESERVED_TRACE_CONTEXT_KEY).toBe('cmdr_trace_context');
    });
  });
});
