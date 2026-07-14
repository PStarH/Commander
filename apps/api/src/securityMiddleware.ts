/**
 * Security Middleware for Commander API Server
 *
 * Provides:
 * - Request ID tracking (X-Request-ID)
 * - Rate limiting (per-tenant / per-user / per-IP)
 * - Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
 * - Error sanitization (don't leak internal details)
 * - Request body validation
 * - Input sanitization
 */

import type { Request, Response, NextFunction } from 'express';
import { PersistentRateLimitStore } from './persistentRateLimitStore';

// ── Persistent source of truth (audit MED item 3, follow-up) ────────────────
//
// Without persistence, a process restart wipes all rate-limit counters and
// an attacker who hit 429 just before the restart can immediately resume
// brute-forcing — an auth-reset bypass vector. The persistent store mirrors
// every Map mutation (write-through) and the boot path hydrates the Map from
// SQL on init. The store is optional so dev/CI runs don't have to ship
// better-sqlite3 cold; turn off with API_RATE_LIMIT_PERSISTENT=off.
let persistentRateLimitStore: PersistentRateLimitStore | null = null;

function isRateLimitPersistenceEnabled(): boolean {
  return (process.env.API_RATE_LIMIT_PERSISTENT ?? 'on').toLowerCase() !== 'off';
}

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
  // Security: X-XSS-Protection is deprecated and can introduce vulnerabilities
  // in older browsers. Per OWASP: set to 0 and rely on CSP instead.
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Security: Content-Security-Policy — defense-in-depth against XSS.
  // Per OWASP CSP Cheat Sheet: restrict script sources to same-origin.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  // HSTS — only in production with HTTPS
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ============================================================================
// Rate Limiting (per-identity: tenant → user → IP)
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitIdentity {
  ip: string;
  userId?: string;
  tenantId?: string;
}

// Mirrors the tenant-id validation in core/runtime/tenantContext.ts.
// Inlined so the API server does not need a pre-built @commander/core dist
// just to validate an optional HTTP header.
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

/**
 * Rate-limit tier classification (audit MED item 3 — security theater fix).
 *
 * Production deployments need layered rate limits so a flood against one
 * route class doesn't blackhole monitoring or silently allow IP rotation
 * sweeps. Three tiers evaluated in order on every request:
 *   1. GLOBAL token bucket — caps aggregate req/sec across ALL IPs.
 *      Without it, attackers rotate IPs and bypass per-IP limits.
 *   2. Per-tier per-IP — each route class has a multiplier so /health
 *      isn't knocked off during a /execute spike.
 *   3. Per-tier headers — X-RateLimit-Tier lets well-behaved SDKs back off
 *      before 429.
 */
type RateLimitTier = 'health' | 'read' | 'write';

const TIER_MULTIPLIER: Record<RateLimitTier, number> = {
  health: 10,
  read: 1,
  write: 0.25,
};

function classifyTier(url: string, method: string = 'GET'): RateLimitTier {
  if (/\/(health|metrics|ready|system\/status)/.test(url)) return 'health';
  // Audit MED item 3 polish: classify writes by HTTP method, not path alone.
  // Without this, GET /api/v1/memory?action=stats would share the 0.25x
  // write tier with POST /api/v1/memory?action=write, over-throttling cheap
  // reads. The 'read' tier is the default for all non-write paths.
  if (method === 'POST' && /\/api\/v1\/(execute|plan|memory)/.test(url)) return 'write';
  return 'read';
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.API_RATE_LIMIT ?? '120', 10);
const RATE_LIMIT_USER_MAX = parseInt(process.env.API_RATE_LIMIT_USER ?? String(RATE_LIMIT_MAX), 10);
const RATE_LIMIT_TENANT_MAX = parseInt(
  process.env.API_RATE_LIMIT_TENANT ?? String(RATE_LIMIT_MAX),
  10,
);
// Cap rateLimitStore size (audit MED item 3 — RAM-DoS amplifier mitigation).
// Without a max-entries bound, an attacker rotating source IPs (e.g. spoofed
// X-Forwarded-For in permissive CORS, IPv6 prefix brute), grows the Map
// unboundedly until the periodic 5-minute cleanup runs — at which point the
// process is already under memory pressure. The MAX_ENTRIES boundary evicts
// the oldest entry (Map preserves insertion order so the first iterator
// entry is FIFO) when capacity is exceeded, plus opportunistically drops
// any expired entries on the same pass to amortize cleanup cost.
const RATE_LIMIT_MAX_ENTRIES = parseInt(process.env.API_RATE_LIMIT_MAX_ENTRIES ?? '50000', 10);

// GLOBAL token bucket — burst capacity and refill rate are env-overridable
// so production deployments behind a CDN / sharded multi-tenant can re-tune.
// Defaults: capacity = max(1000, 2x RATE_LIMIT_MAX), refill = 1000 req/sec.
const GLOBAL_BUCKET_CAPACITY = Math.max(
  1000,
  parseInt(process.env.API_GLOBAL_RATE_LIMIT ?? String(RATE_LIMIT_MAX * 2), 10),
);
const GLOBAL_BUCKET_REFILL_PER_SEC = parseInt(
  process.env.API_GLOBAL_RATE_REFILL_PER_SEC ?? '1000',
  10,
);
const globalBucket = { tokens: GLOBAL_BUCKET_CAPACITY, lastRefill: Date.now() };

function consumeGlobalToken(now: number): boolean {
  const elapsedSec = Math.max(0, (now - globalBucket.lastRefill) / 1000);
  globalBucket.tokens = Math.min(
    GLOBAL_BUCKET_CAPACITY,
    globalBucket.tokens + elapsedSec * GLOBAL_BUCKET_REFILL_PER_SEC,
  );
  globalBucket.lastRefill = now;
  if (globalBucket.tokens < 1) return false;
  globalBucket.tokens -= 1;
  return true;
}

// ── Write-through helpers (audit MED item 3 follow-up) ────────────────────
//
// Wrap Map mutations with a SQLite op so the persistent store stays in
// lockstep with the in-memory cache. SQLite failures are logged but never
// thrown — a wedged DB cannot deny service to well-behaved clients. Sync
// (better-sqlite3) keeps the request path on the microsecond scale; we
// only do ~1 extra SQL op per allowed request, well within p99 budget.

/**
 * writeThroughSet — upsert (key, count, resetAt) into SQL after the in-memory
 * Map write. Called on every counted request so the persistent counter
 * never lags the Map counter (defeats the auth-reset bypass). Failures log.
 */
function writeThroughSet(key: string, entry: RateLimitEntry): void {
  rateLimitStore.set(key, entry);
  if (persistentRateLimitStore) {
    try {
      persistentRateLimitStore.set(key, entry.count, entry.resetAt);
    } catch (e) {
      process.stderr.write(
        `[RateLimit] Persistent set failed for key=${key}: ${(e as Error).message}\n`,
      );
    }
  }
}

/**
 * writeThroughDelete — Map.delete + SQL delete. Only called from the
 * periodic 5-minute cleanup pass so SQLite writes stay amortized.
 * Per-request memory-pressure evictions are Map-only (handled inline) so
 * the SQL op doesn't fire on every flood.
 */
function writeThroughDelete(key: string): void {
  rateLimitStore.delete(key);
  if (persistentRateLimitStore) {
    try {
      persistentRateLimitStore.delete(key);
    } catch (e) {
      process.stderr.write(
        `[RateLimit] Persistent delete failed for key=${key}: ${(e as Error).message}\n`,
      );
    }
  }
}

// Cleanup old entries every 5 minutes — Map cleanup preserves existing
// behavior; persistent.cleanup() runs on the same cadence via
// writeThroughDelete so the SQLite table doesn't grow unboundedly with
// rows that the Map has already evicted.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt < now) {
      writeThroughDelete(key);
    }
  }
  // Belt-and-braces: even if rateLimitStore was empty, sweep any orphaned
  // rows (e.g. left behind by an abnormal shutdown that didn't run write-
  // through) directly from SQL.
  if (persistentRateLimitStore) {
    try {
      persistentRateLimitStore.cleanup(now);
    } catch (e) {
      process.stderr.write(`[RateLimit] Persistent cleanup failed: ${(e as Error).message}\n`);
    }
  }
}, 300_000).unref();

/**
 * initRateLimitStore — open the persistent store (if enabled) and hydrate
 * the in-memory Map from SQL on boot. Returns a Promise so callers
 * (apps/api/src/index.ts) can await before app.listen() and avoid the
 * race where the first request after boot reads an empty Map.
 *
 * Hydration is best-effort: SQL failures log and fall through to an empty
 * Map (graceful degradation, never a startup crash). Repeated calls are
 * idempotent — second call is a no-op so test runs that import the module
 * multiple times don't double-open the SQLite handle.
 */
let initialized = false;
export async function initRateLimitStore(now: number = Date.now()): Promise<void> {
  if (initialized) return;
  if (!isRateLimitPersistenceEnabled()) {
    initialized = true;
    process.stdout.write('[RateLimit] Persistent store disabled (API_RATE_LIMIT_PERSISTENT=off)\n');
    return;
  }
  try {
    persistentRateLimitStore = new PersistentRateLimitStore(process.env.API_RATE_LIMIT_DB_PATH);
    const activeRows = persistentRateLimitStore.listActive(now);
    for (const row of activeRows) {
      rateLimitStore.set(row.key, { count: row.count, resetAt: row.resetAt });
    }
    initialized = true;
    process.stdout.write(
      `[RateLimit] Hydrated ${activeRows.length} active entries from persistent store\n`,
    );
  } catch (e) {
    // Graceful fallback — server still serves traffic; rate limits are
    // process-local. Re-allow init() retry on the next boot.
    persistentRateLimitStore = null;
    initialized = false;
    process.stderr.write(
      `[RateLimit] Persistent store init failed, falling back to in-memory only: ${(e as Error).message}\n`,
    );
  }
}

/**
 * closeRateLimitStore — close the persistent store on graceful shutdown.
 * Idempotent and safe to call even if init failed (null check).
 */
export function closeRateLimitStore(): void {
  if (!persistentRateLimitStore) return;
  try {
    persistentRateLimitStore.close();
    process.stdout.write('[RateLimit] Persistent store closed\n');
  } catch (e) {
    process.stderr.write(`[RateLimit] Persistent store close failed: ${(e as Error).message}\n`);
  } finally {
    persistentRateLimitStore = null;
    initialized = false;
  }
}

/**
 * _resetRateLimitStoreForTesting — test-only escape hatch to clear the
 * `initialized` latch so a test can re-run initRateLimitStore against a
 * fresh DB path. NOT exported via index.ts.
 */
export function _resetRateLimitStoreForTesting(): void {
  persistentRateLimitStore = null;
  initialized = false;
  rateLimitStore.clear();
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function extractTenantId(req: Request): string | undefined {
  // Prefer the tenant resolved by tenantContextMiddleware from the authenticated
  // principal. Fall back to the raw header only for pre-auth rate-limit bucketing
  // (this value never authorizes data access — see tenantContextMiddleware).
  const resolved = (req as Request & { tenantId?: string }).tenantId;
  const rawHeader = Array.isArray(req.headers['x-tenant-id'])
    ? req.headers['x-tenant-id'][0]
    : req.headers['x-tenant-id'];
  const value = resolved ?? rawHeader;
  if (typeof value !== 'string') return undefined;
  if (!TENANT_ID_RE.test(value)) return undefined;
  return value;
}

function buildRateLimitIdentity(req: Request): RateLimitIdentity {
  return {
    ip: getClientIp(req),
    userId: req.user?.id ?? req.apiKeyId,
    tenantId: extractTenantId(req),
  };
}

interface RateLimitScope {
  key: string;
  prefix: 'tenant' | 'user' | 'ip';
  max: number;
}

function buildScopes(identity: RateLimitIdentity, tier: RateLimitTier): RateLimitScope[] {
  const scopes: RateLimitScope[] = [];
  // Tenant is the broadest identity-aware bucket: it caps aggregate usage
  // across all users belonging to the same tenant.
  if (identity.tenantId) {
    scopes.push({
      key: `tenant:${identity.tenantId}`,
      prefix: 'tenant',
      max: Math.max(1, Math.floor(RATE_LIMIT_TENANT_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  // User bucket isolates individual accounts, so one compromised user cannot
  // exhaust the tenant-wide budget.
  if (identity.userId) {
    scopes.push({
      key: `user:${identity.userId}`,
      prefix: 'user',
      max: Math.max(1, Math.floor(RATE_LIMIT_USER_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  // IP bucket is the fallback for anonymous / unauthenticated traffic only.
  // For authenticated requests we enforce the more specific tenant/user
  // buckets so that a shared corporate NAT does not artificially cap users.
  if (scopes.length === 0) {
    scopes.push({
      key: `ip:${identity.ip}`,
      prefix: 'ip',
      max: Math.max(1, Math.floor(RATE_LIMIT_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  return scopes;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const identity = buildRateLimitIdentity(req);
  const now = Date.now();

  // Layer 1: GLOBAL token bucket — takes precedence over per-identity limits
  // so an attacker spraying IPs/users cannot bypass by spreading load.
  if (!consumeGlobalToken(now)) {
    res.setHeader('X-RateLimit-Reason', 'global-token-bucket');
    res.setHeader('Retry-After', '1');
    res.status(429).json({
      error: 'Server overloaded. Retry after rate-limit reset.',
      retryAfter: 1,
    });
    return;
  }

  // Layer 2: per-tier per-identity. Tier ceilings are scaled independently
  // so /health-monitoring isn't knocked off by a /execute spike, and a
  // privileged user or noisy tenant can be capped on its own limit.
  const tier = classifyTier(req.url ?? '/', req.method ?? 'GET');
  const scopes = buildScopes(identity, tier);

  // Memory-pressure guard: when the rateLimitStore exceeds the cap, evict
  // one expired entry opportunistically and (if none are expired) the FIFO
  // oldest. Capped to at most 256 evictions per request to bound tail
  // latency under adversarial floods. Per-request eviction only touches
  // Map — the periodic 5-minute interval is the authoritative cleanup
  // channel for persistent (alignment keeps SQL writes amortized).
  if (rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
    let evicted = 0;
    for (const [key, exp] of rateLimitStore) {
      if (exp.resetAt < now) {
        rateLimitStore.delete(key);
        evicted++;
        if (evicted >= 256) break;
      }
    }
    if (evicted === 0) {
      // FIFO eviction — Map insertion order throws away the cold tail first.
      const oldest = rateLimitStore.keys().next().value;
      if (oldest !== undefined) rateLimitStore.delete(oldest);
    }
  }

  let blockingScope:
    | { prefix: 'tenant' | 'user' | 'ip'; entry: RateLimitEntry; max: number }
    | undefined;
  let primaryScope: RateLimitScope | undefined;

  for (const scope of scopes) {
    let entry = rateLimitStore.get(scope.key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }
    entry.count++;
    // writeThroughSet AFTER increment so the persistent counter matches the
    // in-memory one — defeats the auth-reset bypass where a restart between
    // the Map write and the SQL upsert would cause counter drift.
    writeThroughSet(scope.key, entry);

    if (!blockingScope && entry.count > scope.max) {
      blockingScope = { prefix: scope.prefix, entry, max: scope.max };
    }

    // The "primary" scope drives the response headers: prefer the most
    // specific identity we have (user > tenant > ip) so SDKs see a limit
    // that matches the dimension actually being enforced.
    if (
      !primaryScope ||
      (scope.prefix === 'user' && primaryScope.prefix !== 'user') ||
      (scope.prefix === 'tenant' && primaryScope.prefix === 'ip')
    ) {
      primaryScope = scope;
    }
  }

  const primaryEntry = rateLimitStore.get(primaryScope!.key)!;

  res.setHeader('X-RateLimit-Limit', primaryScope!.max);
  res.setHeader('X-RateLimit-Tier', tier);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, primaryScope!.max - primaryEntry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(primaryEntry.resetAt / 1000));

  if (blockingScope) {
    res.setHeader('X-RateLimit-Reason', `per-${blockingScope.prefix}-tier-${tier}`);
    // Best-effort structured stderr audit so SIEM tier (Phase 2) can pick
    // this up via /api/v1/security/owasp-ingest without proxying through the
    // full audit bus.
    process.stderr.write(
      `[RateLimit] prefix=${blockingScope.prefix} identity=${
        blockingScope.prefix === 'ip'
          ? identity.ip
          : blockingScope.prefix === 'user'
            ? identity.userId
            : identity.tenantId
      } tier=${tier} count=${blockingScope.entry.count} max=${blockingScope.max} url=${req.url ?? '/'}\n`,
    );
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((blockingScope.entry.resetAt - now) / 1000),
      tier,
      limit: blockingScope.max,
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
  if (
    err.message?.includes('too large') ||
    (err as Error & { type?: string }).type === 'entity.too.large'
  ) {
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
