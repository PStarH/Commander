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
const SENSITIVE_FIELD_NAME =
  /password|passwd|passcode|secret|token|authorization|credential|private[_-]?key|access[_-]?key|api[_-]?key|otp/i;

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

/**
 * Scrub secrets from a request URL path + query before mirroring to shadow.
 * Query keys matching SENSITIVE_FIELD_NAME (token, api_key, …) are replaced;
 * remaining values still run through PII redaction. Path segments that look
 * like bearer/API keys are also redacted.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;
  try {
    // Support path-only URLs from Express (e.g. "/api/foo?token=sk-…")
    const base = 'http://shadow.invalid';
    const parsed = new URL(url, base);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_FIELD_NAME.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      } else {
        const v = parsed.searchParams.get(key);
        if (v) parsed.searchParams.set(key, redactPii(v));
      }
    }
    // Path: redact high-entropy token-like segments (sk-…, ghp_…, long hex/base64)
    const scrubbedPath = parsed.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (/^(sk|pk|rk|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9._-]{8,}$/i.test(seg)) {
          return '[REDACTED]';
        }
        if (/^[A-Za-z0-9_-]{32,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) {
          return '[REDACTED]';
        }
        return redactPii(seg);
      })
      .join('/');
    parsed.pathname = scrubbedPath;
    // Return relative form when input was path-only
    if (url.startsWith('/') || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return parsed.toString();
  } catch {
    // Last resort: strip obvious query secrets via regex
    return url.replace(
      /([?&](?:access_token|api[_-]?key|token|secret|password|authorization)=)[^&]*/gi,
      '$1[REDACTED]',
    );
  }
}

export function scrubRequest(
  req: { headers: Record<string, string>; body?: unknown; url?: string },
  ignoreFields: string[],
): { headers: Record<string, string>; body?: unknown; url?: string } {
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
  const scrubbedUrl = typeof req.url === 'string' ? scrubUrl(req.url) : undefined;
  return { headers: scrubbedHeaders, body: scrubbedBody, url: scrubbedUrl };
}
