import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlPool } from '@commander/kernel';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  req.startTime = Date.now();
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

interface RateLimitEntry { count: number; resetAt: number; }
export interface RateLimitBucket { key: string; windowMs: number; }
export interface RateLimitStore { consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]>; }
type VerifiedPoolFactory = (input: { connectionString: string }, env?: NodeJS.ProcessEnv) => SqlPool;

const CONSUME_RATE_LIMIT_SQL = [
  'INSERT INTO commander_auth_rate_limits (bucket_key, count, reset_at)',
  "VALUES ($1, 1, clock_timestamp() + ($2 * interval '1 millisecond'))",
  'ON CONFLICT (bucket_key) DO UPDATE SET',
  'count = CASE WHEN commander_auth_rate_limits.reset_at <= clock_timestamp() THEN 1 ELSE commander_auth_rate_limits.count + 1 END,',
  "reset_at = CASE WHEN commander_auth_rate_limits.reset_at <= clock_timestamp() THEN clock_timestamp() + ($2 * interval '1 millisecond') ELSE commander_auth_rate_limits.reset_at END",
  'RETURNING count, EXTRACT(EPOCH FROM reset_at) * 1000 AS "resetAt"',
].join('\n');

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: SqlPool) {}

  async consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]> {
    if (buckets.length === 0) return [];
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseError: Error | boolean | undefined;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const entries: RateLimitEntry[] = [];
      for (const bucket of buckets) {
        const result = await client.query<RateLimitEntry>(CONSUME_RATE_LIMIT_SQL, [bucket.key, bucket.windowMs]);
        const row = result.rows[0];
        if (!row) throw new Error('RATE_LIMIT_RECORD_MISSING');
        entries.push({ count: Number(row.count), resetAt: Number(row.resetAt) });
      }
      await client.query('COMMIT');
      transactionStarted = false;
      return entries;
    } catch (error) {
      releaseError = error instanceof Error ? error : true;
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true;
        }
      }
      throw error;
    } finally {
      await client.release(releaseError);
    }
  }
}

export function createRateLimitStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): RateLimitStore {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('RATE_LIMIT_DATABASE_URL_REQUIRED');
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('RATE_LIMIT_DATABASE_URL_INVALID');
  }
  if (role !== 'commander_app') throw new Error('RATE_LIMIT_DATABASE_ROLE_INVALID');
  return new PostgresRateLimitStore(createPool({ connectionString }, environment));
}

let sharedRateLimitStore: RateLimitStore | undefined;
function getRateLimitStore(): RateLimitStore {
  sharedRateLimitStore ??= createRateLimitStoreFromEnvironment();
  return sharedRateLimitStore;
}

export function setRateLimitStoreForTesting(store: RateLimitStore): void {
  sharedRateLimitStore = store;
}

export async function initRateLimitStore(): Promise<void> {
  getRateLimitStore();
}

export function closeRateLimitStore(): void {
  sharedRateLimitStore = undefined;
}

export function _resetRateLimitStoreForTesting(): void {
  sharedRateLimitStore = undefined;
}

interface RateLimitIdentity { ip: string; userId?: string; tenantId?: string; }
interface RateLimitScope { key: string; prefix: 'global' | 'tenant' | 'user' | 'ip'; max: number; windowMs: number; }
type RateLimitTier = 'health' | 'read' | 'write';
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const TIER_MULTIPLIER: Record<RateLimitTier, number> = { health: 10, read: 1, write: 0.25 };
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number.parseInt(process.env.API_RATE_LIMIT ?? '120', 10);
const RATE_LIMIT_USER_MAX = Number.parseInt(process.env.API_RATE_LIMIT_USER ?? String(RATE_LIMIT_MAX), 10);
const RATE_LIMIT_TENANT_MAX = Number.parseInt(process.env.API_RATE_LIMIT_TENANT ?? String(RATE_LIMIT_MAX), 10);
const GLOBAL_RATE_LIMIT_MAX = Math.max(1000, Number.parseInt(process.env.API_GLOBAL_RATE_LIMIT ?? String(RATE_LIMIT_MAX * 2), 10));

function classifyTier(url: string, method = 'GET'): RateLimitTier {
  if (/\/(health|metrics|ready|system\/status)/.test(url)) return 'health';
  return method === 'POST' && /\/api\/v1\/(execute|plan|memory)/.test(url) ? 'write' : 'read';
}

function getClientIp(req: Request): string { return req.ip ?? req.socket.remoteAddress ?? 'unknown'; }
function extractTenantId(req: Request): string | undefined {
  const resolved = (req as Request & { tenantId?: string }).tenantId;
  const header = req.headers['x-tenant-id'];
  const value = resolved ?? (Array.isArray(header) ? header[0] : header);
  return typeof value === 'string' && TENANT_ID_RE.test(value) ? value : undefined;
}
function buildRateLimitIdentity(req: Request): RateLimitIdentity {
  return { ip: getClientIp(req), userId: req.user?.id ?? req.apiKeyId, tenantId: extractTenantId(req) };
}
function buildScopes(identity: RateLimitIdentity, tier: RateLimitTier): RateLimitScope[] {
  const scopes: RateLimitScope[] = [{ key: 'global:' + tier, prefix: 'global', max: GLOBAL_RATE_LIMIT_MAX, windowMs: 1_000 }];
  if (identity.tenantId) scopes.push({ key: 'tenant:' + identity.tenantId + ':' + tier, prefix: 'tenant', max: Math.max(1, Math.floor(RATE_LIMIT_TENANT_MAX * TIER_MULTIPLIER[tier])), windowMs: RATE_LIMIT_WINDOW_MS });
  if (identity.userId) scopes.push({ key: 'user:' + identity.userId + ':' + tier, prefix: 'user', max: Math.max(1, Math.floor(RATE_LIMIT_USER_MAX * TIER_MULTIPLIER[tier])), windowMs: RATE_LIMIT_WINDOW_MS });
  if (!identity.tenantId && !identity.userId) scopes.push({ key: 'ip:' + identity.ip + ':' + tier, prefix: 'ip', max: Math.max(1, Math.floor(RATE_LIMIT_MAX * TIER_MULTIPLIER[tier])), windowMs: RATE_LIMIT_WINDOW_MS });
  return scopes;
}

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tier = classifyTier(req.url ?? '/', req.method ?? 'GET');
  const identity = buildRateLimitIdentity(req);
  let primary: { scope: RateLimitScope; entry: RateLimitEntry } | undefined;
  let blocking: { scope: RateLimitScope; entry: RateLimitEntry } | undefined;
  try {
    const scopes = buildScopes(identity, tier);
    const entries = await getRateLimitStore().consume(scopes);
    if (entries.length !== scopes.length) throw new Error('RATE_LIMIT_BATCH_RESULT_MISMATCH');
    for (const [index, scope] of scopes.entries()) {
      const entry = entries[index];
      if (!entry) throw new Error('RATE_LIMIT_BATCH_RECORD_MISSING');
      if (scope.prefix !== 'global' && (!primary || (scope.prefix === 'user' && primary.scope.prefix !== 'user') || (scope.prefix === 'tenant' && primary.scope.prefix === 'ip'))) primary = { scope, entry };
      if (!blocking && entry.count > scope.max) blocking = { scope, entry };
    }
  } catch (error) {
    process.stderr.write('[RateLimit] PostgreSQL authority unavailable: ' + String(error) + '\n');
    res.status(503).json({ error: 'Service unavailable' });
    return;
  }

  const selected = primary ?? blocking;
  if (!selected) {
    res.status(503).json({ error: 'Service unavailable' });
    return;
  }
  res.setHeader('X-RateLimit-Limit', selected.scope.max);
  res.setHeader('X-RateLimit-Tier', tier);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, selected.scope.max - selected.entry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(selected.entry.resetAt / 1000));
  if (blocking) {
    res.setHeader('X-RateLimit-Reason', blocking.scope.prefix === 'global' ? 'global-tier-' + tier : 'per-' + blocking.scope.prefix + '-tier-' + tier);
    res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((blocking.entry.resetAt - Date.now()) / 1000), tier, limit: blocking.scope.max });
    return;
  }
  next();
}

interface SanitizedError { status: number; message: string; requestId?: string; }
export function sanitizeError(err: Error, requestId?: string): SanitizedError {
  if (err.name === 'ValifyError') return { status: 400, message: 'Validation error', requestId };
  if (err.message?.includes('JSON')) return { status: 400, message: 'Invalid JSON in request body', requestId };
  if (err.message?.includes('too large') || (err as Error & { type?: string }).type === 'entity.too.large') return { status: 413, message: 'Request body too large', requestId };
  return { status: 500, message: 'Internal server error', requestId };
}
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const sanitized = sanitizeError(err, req.requestId);
  process.stderr.write('[API Error] ' + req.method + ' ' + req.path + ' — ' + err.message + '\n' + err.stack + '\n');
  res.status(sanitized.status).json({ error: sanitized.message, requestId: sanitized.requestId });
}
export function sanitizeString(input: unknown, maxLength = 10000): string {
  return typeof input === 'string' ? input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLength) : '';
}
export function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
export function isValidUUID(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
export function isValidProjectId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value); }
