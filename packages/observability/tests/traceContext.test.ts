import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  extractTraceContext,
  generateTraceId,
  generateSpanId,
  TraceContextParseError,
} from '../src/traceContext';

describe('parseTraceparent', () => {
  it('parses a valid traceparent header', () => {
    const result = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(result).toBeDefined();
    expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(result!.parentSpanId).toBe('b7ad6b7169203331');
    expect(result!.sampled).toBe(true);
  });

  it('parses unsampled traceparent', () => {
    const result = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
    expect(result!.sampled).toBe(false);
  });

  it('returns undefined for null', () => {
    expect(parseTraceparent(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTraceparent('')).toBeUndefined();
  });

  it('returns undefined for malformed header', () => {
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
  });

  it('returns undefined for all-zeros trace-id', () => {
    expect(
      parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01'),
    ).toBeUndefined();
  });

  it('returns undefined for all-zeros parent-id', () => {
    expect(
      parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'),
    ).toBeUndefined();
  });

  it('trims whitespace', () => {
    const result = parseTraceparent('  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01  ');
    expect(result).toBeDefined();
    expect(result!.raw).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });
});

describe('formatTraceparent', () => {
  it('formats a valid traceparent', () => {
    const result = formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', true);
    expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('formats unsampled traceparent', () => {
    const result = formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', false);
    expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
  });

  it('throws on invalid traceId', () => {
    expect(() => formatTraceparent('invalid', 'b7ad6b7169203331', true)).toThrow(
      TraceContextParseError,
    );
  });

  it('throws on invalid spanId', () => {
    expect(() => formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'invalid', true)).toThrow(
      TraceContextParseError,
    );
  });
});

describe('parseTracestate', () => {
  it('parses valid tracestate', () => {
    expect(parseTracestate('vendor1=value1,vendor2=value2')).toBe('vendor1=value1,vendor2=value2');
  });

  it('returns undefined for null', () => {
    expect(parseTracestate(null)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTracestate('')).toBeUndefined();
  });

  it('returns undefined for invalid tracestate', () => {
    expect(parseTracestate('!!!invalid!!!')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(parseTracestate('  vendor1=value1  ')).toBe('vendor1=value1');
  });
});

describe('extractTraceContext', () => {
  it('extracts from headers object', () => {
    const result = extractTraceContext({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(result).toBeDefined();
    expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('handles array headers', () => {
    const result = extractTraceContext({
      traceparent: ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
    });
    expect(result).toBeDefined();
  });

  it('returns undefined when header missing', () => {
    expect(extractTraceContext({})).toBeUndefined();
  });
});

describe('generateTraceId', () => {
  it('generates 32-char hex string', () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateSpanId', () => {
  it('generates 16-char hex string', () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
    expect(ids.size).toBe(100);
  });
});
