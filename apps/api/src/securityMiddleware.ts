/**
 * Security Middleware for Commander API Server
 *
 * Provides:
 * - Request ID tracking (X-Request-ID)
 * - Rate limiting (per-IP)
 * - Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
 * - Error sanitization (don't leak internal details)
 * - Request body validation
 * - Input sanitization
 */

import type { Request, Response, NextFunction } from 'express';

// ============================================================================
// Request ID Tracking
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
  req.startTime = Date.now();
  next();
}

// ============================================================================
// Security Headers
// ============================================================================

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS — only in production with HTTPS
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ============================================================================
// Rate Limiting (per-IP, in-memory)
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.API_RATE_LIMIT ?? '120', 10);

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt < now) rateLimitStore.delete(key);
  }
}, 300_000).unref();

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();

  let entry = rateLimitStore.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - entry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
    return;
  }

  next();
}

// ============================================================================
// Error Sanitization
// ============================================================================

interface SanitizedError {
  status: number;
  message: string;
  requestId?: string;
}

export function sanitizeError(err: Error, requestId?: string): SanitizedError {
  // Known error types — return safe messages
  if (err.name === 'ValifyError') {
    return { status: 400, message: 'Validation error', requestId };
  }
  if (err.message?.includes('JSON')) {
    return { status: 400, message: 'Invalid JSON in request body', requestId };
  }
  if (err.message?.includes('too large') || (err as Error & { type?: string }).type === 'entity.too.large') {
    return { status: 413, message: 'Request body too large', requestId };
  }

  // Unknown errors — don't leak internal details
  return {
    status: 500,
    message: 'Internal server error',
    requestId,
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const sanitized = sanitizeError(err, req.requestId);

  // Log the full error internally
  process.stderr.write(`[API Error] ${req.method} ${req.path} — ${err.message}\n${err.stack}\n`);

  res.status(sanitized.status).json({
    error: sanitized.message,
    requestId: sanitized.requestId,
  });
}

// ============================================================================
// Input Sanitization
// ============================================================================

/**
 * Sanitize string input — strip control characters and limit length.
 */
export function sanitizeString(input: unknown, maxLength = 10000): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control chars (keep \t, \n, \r)
    .slice(0, maxLength);
}

/**
 * Validate that a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate that a value is a valid UUID.
 */
export function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Validate that a value is a valid project ID (alphanumeric + hyphens).
 */
export function isValidProjectId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
