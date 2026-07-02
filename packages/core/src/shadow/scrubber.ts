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

/**
 * Scrub a single string value — applies all PII patterns from UniversalSanitizer.
 */
export function redactPii(text: string): string {
  return sanitizer.sanitize(text, 'output').sanitized;
}

/**
 * Recursively scrub all string values in a body object.
 */
function scrubBodyValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactPii(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubBodyValue);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = scrubBodyValue(v);
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
