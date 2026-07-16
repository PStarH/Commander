// packages/core/src/shadow/scrubber.ts
// PII scrubber for shadow traffic — delegates to UniversalSanitizer for
// pattern matching, ensuring the shadow layer benefits from the same
// defense primitive as all other cross-trust-boundary data.

import { UniversalSanitizer } from '../security/securityPrimitives';

const sanitizer = new UniversalSanitizer();

/** Fields that are ALWAYS redacted regardless of ignoreFields config. */
const FORCED_REDACT_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
];

export const DEFAULT_IGNORE_FIELDS = ['Authorization', 'x-api-key', 'x-auth-token', 'cookie'];

/** JSON object keys whose values are always replaced (case-insensitive). */
const SENSITIVE_FIELD_NAME = /password|secret|token|authorization|api[_-]?key/i;

/**
 * Scrub a single string value — applies all PII patterns from UniversalSanitizer.
 */
export function redactPii(text: string): string {
  return sanitizer.sanitize(text, 'output').sanitized;
}

/**
 * Recursively scrub body values: sensitive field names → [REDACTED],
 * then PII patterns on remaining strings. JSON strings are parsed first.
 */
function scrubBodyValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return JSON.stringify(scrubBodyValue(parsed));
      } catch {
        // not valid JSON — fall through to regex scrub
      }
    }
    return redactPii(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubBodyValue);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_FIELD_NAME.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = scrubBodyValue(v);
      }
    }
    return result;
  }
  return value;
}

export function scrubRequest(
  req: { headers: Record<string, string>; body?: unknown },
  ignoreFields: string[],
): { headers: Record<string, string>; body?: unknown } {
  const lowerIgnore = ignoreFields.map((f) => f.toLowerCase());
  const scrubbedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    // FORCED_REDACT_HEADERS are always redacted — not user-overridable
    if (FORCED_REDACT_HEADERS.includes(lowerKey) || lowerIgnore.includes(lowerKey)) {
      scrubbedHeaders[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      scrubbedHeaders[key] = redactPii(value);
    } else {
      scrubbedHeaders[key] = value;
    }
  }
  // Scrub body recursively — fixes ATK-001 and ATK-014
  const scrubbedBody = req.body !== undefined ? scrubBodyValue(req.body) : undefined;
  return { headers: scrubbedHeaders, body: scrubbedBody };
}
