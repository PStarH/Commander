import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  extractTraceContext,
  generateTraceId,
  generateSpanId,
  TraceContextParseError,
} from '../../src/observability/traceContext';

describe('W3C trace context propagation', () => {
  describe('parseTraceparent', () => {
    it('parses a well-formed traceparent header', () => {
      const ctx = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
      expect(ctx?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(ctx?.parentSpanId).toBe('b7ad6b7169203331');
      expect(ctx?.sampled).toBe(true);
      expect(ctx?.raw).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    it('handles unsampled flag (00)', () => {
      const ctx = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
      expect(ctx?.sampled).toBe(false);
    });

    it('returns undefined for malformed headers (per spec: ignore, do not throw)', () => {
      expect(parseTraceparent('garbage')).toBeUndefined();
      expect(parseTraceparent('00-0af7-b7ad-01')).toBeUndefined();
      expect(
        parseTraceparent('00-ZZZZ651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'),
      ).toBeUndefined();
      expect(parseTraceparent('')).toBeUndefined();
      expect(parseTraceparent(null)).toBeUndefined();
      expect(parseTraceparent(undefined)).toBeUndefined();
    });

    it('rejects reserved trace-id (all zeros)', () => {
      const zeros = '0'.repeat(32);
      expect(parseTraceparent(`00-${zeros}-b7ad6b7169203331-01`)).toBeUndefined();
    });

    it('rejects reserved parent-span-id (all zeros)', () => {
      const zeros = '0'.repeat(16);
      expect(parseTraceparent(`00-0af7651916cd43dd8448eb211c80319c-${zeros}-01`)).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
      const ctx = parseTraceparent('  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01  ');
      expect(ctx?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    });
  });

  describe('formatTraceparent', () => {
    it('round-trips with parseTraceparent', () => {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      const header = formatTraceparent(traceId, spanId, true);
      const ctx = parseTraceparent(header);
      expect(ctx?.traceId).toBe(traceId);
      expect(ctx?.parentSpanId).toBe(spanId);
      expect(ctx?.sampled).toBe(true);
    });

    it('emits the 00- prefix and dash separators', () => {
      const header = formatTraceparent(
        '0af7651916cd43dd8448eb211c80319c',
        'b7ad6b7169203331',
        true,
      );
      expect(header).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    it('throws TraceContextParseError for invalid input', () => {
      expect(() => formatTraceparent('short', 'b7ad6b7169203331', true)).toThrow(
        TraceContextParseError,
      );
      expect(() => formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'short', true)).toThrow(
        TraceContextParseError,
      );
    });
  });

  describe('parseTracestate', () => {
    it('passes through well-formed tracestate', () => {
      expect(parseTracestate('vendor1=foo,vendor2=bar')).toBe('vendor1=foo,vendor2=bar');
    });
    it('returns undefined for malformed tracestate', () => {
      expect(parseTracestate('garbage with spaces')).toBeUndefined();
    });
  });

  describe('extractTraceContext', () => {
    it('reads traceparent from a headers dict (string value)', () => {
      const ctx = extractTraceContext({
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      });
      expect(ctx?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    });
    it('reads traceparent from a headers dict (string[] value, takes first)', () => {
      const ctx = extractTraceContext({
        traceparent: ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'second-value'],
      });
      expect(ctx?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    });
    it('returns undefined when traceparent is missing', () => {
      expect(extractTraceContext({})).toBeUndefined();
    });
  });

  describe('generateTraceId / generateSpanId', () => {
    it('traceId is 32 hex chars', () => {
      const id = generateTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });
    it('spanId is 16 hex chars', () => {
      const id = generateSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
    it('generates unique values (probabilistic)', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()));
      expect(ids.size).toBe(50);
    });
  });
});
