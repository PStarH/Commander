import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';
import { getGlobalLogger } from '@commander/core';
import { isProductionEnv, describeProdSignal } from './envSignal';
import { getApiKeyStore } from './apiKeyStore';
import { getAuthFailureStore } from './authFailureStore';

declare global {
  namespace Express {
    interface Request {
      apiKeyId?: string;
      apiScopes?: string[];
      /** Tenant associated with the authenticated API key. */
      tenantId?: string;
    }
  }
}

const PUBLIC_PATHS = new Set([
  '/health',
  '/ready',
  '/system/status',
  '/api/openapi.json',
  '/a2a/.well-known/agent-card',
  '/mcp/.well-known/mcp',
  // User-auth endpoints handle their own auth via JWT — must be reachable
  // without an API key so users can obtain their first token / rotate it.
  '/api/auth/login',
  '/api/auth/register',
  // Refresh/logout present a refresh token in the body (no access JWT / API key).
  // Must stay public to authMiddleware or deny-anon breaks the refresh flow.
  '/api/auth/refresh',
  '/api/auth/logout',
]);

interface StoredKey {
  name: string;
  scopes: string[];
  tenantId?: string;
}

const MAX_AUTH_FAILURES = parseInt(process.env.AUTH_MAX_FAILURES ?? '5', 10);
const LOCKOUT_DURATION_MS = parseInt(process.env.AUTH_LOCKOUT_MS ?? '300000', 10); // 5 min
const AUTH_FAILURE_WINDOW_MS = 60_000; // 1 minute sliding window

// Cleanup old entries every 5 minutes
setInterval(() => {
  getAuthFailureStore().cleanup(Date.now(), AUTH_FAILURE_WINDOW_MS).catch((err) => {
    process.stderr.write(`[Auth] Failed to cleanup auth failure entries: ${String(err)}\n`);
  });
}, 300_000).unref();

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** PostgreSQL is the sole authority for API-key authentication. */
async function findKey(token: string): Promise<StoredKey | null> {
  const storeRecord = await getApiKeyStore().findByHash(sha256(token));
  if (storeRecord) {
    return {
      name: storeRecord.name,
      scopes: storeRecord.scopes,
      tenantId: storeRecord.tenantId,
    };
  }
  return null;
}

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith('/health') || path.startsWith('/system');
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

async function recordAuthFailure(ip: string): Promise<void> {
  const authFailureStore = getAuthFailureStore();
  const now = Date.now();
  // Single atomic upsert: increment + window reset + lockout threshold are
  // decided inside PostgreSQL so concurrent failures across replicas cannot
  // race the lockout decision.
  const entry = await authFailureStore.recordFailure(
    ip,
    now,
    MAX_AUTH_FAILURES,
    AUTH_FAILURE_WINDOW_MS,
    LOCKOUT_DURATION_MS,
  );
  if (entry.count >= MAX_AUTH_FAILURES && entry.lockedUntil > now) {
    try {
      getGlobalLogger().warn(
        'AuthMiddleware',
        `IP ${ip} locked out after ${entry.count} failures`,
        {
          ip,
          count: entry.count,
          lockoutDurationSeconds: LOCKOUT_DURATION_MS / 1000,
        },
      );
    } catch {
      process.stderr.write(
        `[Auth] IP ${ip} locked out after ${entry.count} failures for ${LOCKOUT_DURATION_MS / 1000}s\n`,
      );
    }
  }
}

async function isLockedOut(ip: string): Promise<boolean> {
  const authFailureStore = getAuthFailureStore();
  const entry = await authFailureStore.get(ip);
  if (!entry) return false;
  return entry.lockedUntil > Date.now();
}

// Module-load one-shot warning if AUTH_DISABLED=true in production.
// Gated by a module-level flag so the warning fires exactly once per
// process even though authMiddleware is invoked per-request. Without
// this gate, every authenticated request would re-emit the warning,
// spamming stdout under any load.
let _warnedAuthDisabledInProd = false;
if (isProductionEnv() && process.env.AUTH_DISABLED === 'true' && !_warnedAuthDisabledInProd) {
  _warnedAuthDisabledInProd = true;
  try {
    getGlobalLogger().warn(
      'AuthMiddleware',
      'AUTH_DISABLED=true in production — admin endpoints are publicly accessible. This is a security risk; remove the env var before deployment.',
      { signal: describeProdSignal() },
    );
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[authMiddleware] AUTH_DISABLED=true in production (signal=${describeProdSignal()}) — admin endpoints (e.g. /api/v1/hub) are publicly accessible. This is a security risk; remove the env var before deployment.`,
    );
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    await authMiddlewareInternal(req, res, next);
  } catch (err) {
    process.stderr.write(`[Auth] Unhandled error in auth middleware: ${String(err)}\n`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

async function authMiddlewareInternal(req: Request, res: Response, next: NextFunction) {
  // Security: In production, AUTH_DISABLED must never be honored.
  // Per security best practice: authentication bypass is a critical risk;
  // fail hard rather than silently allowing unauthenticated access.
  if (process.env.AUTH_DISABLED === 'true') {
    if (isProductionEnv()) {
      return res.status(500).json({
        error:
          'Authentication is disabled in production. Remove AUTH_DISABLED=true before deployment.',
      });
    }
    // Non-production: AUTH_DISABLED alone is no longer a free bypass.
    // Require explicit COMMANDER_ALLOW_ANON=1 (same escape hatch as no-keys mode).
    if (process.env.COMMANDER_ALLOW_ANON !== '1') {
      return res.status(401).json({
        error: 'Authentication required',
        hint: 'AUTH_DISABLED requires COMMANDER_ALLOW_ANON=1 outside production',
      });
    }
    // JWT tenant_id is authoritative even when AUTH_DISABLED — a stale/default
    // req.tenantId must not override the verified access-token claim (AUTH-2).
    if (typeof req.user?.tenantId === 'string' && req.user.tenantId.length > 0) {
      req.tenantId = req.user.tenantId;
    } else if (!req.tenantId) {
      // Anon bypass still needs a tenant ALS binding — MemoryStoreFacade and
      // other tenant-scoped services fail closed without one. Prefer an explicit
      // COMMANDER_DEFAULT_TENANT_ID; fall back to "local" (never "__default__",
      // which is reserved by runWithTenant).
      req.tenantId = process.env.COMMANDER_DEFAULT_TENANT_ID || 'local';
    }
    return next();
  }

  const path = req.path;
  if (isPublicPath(path)) {
    return next();
  }

  // If jwtMiddleware already authenticated the request via a valid JWT
  // (req.user is set), skip API-key validation entirely. This keeps the two
  // auth mechanisms compatible: JWT users are not subject to API-key checks.
  // Promote JWT tenant_id → req.tenantId so tenantContextMiddleware treats it
  // as the authenticated principal (AUTH-2 / B4) — otherwise ambient
  // X-Tenant-ID would be evaluated as "no principal" and either trusted
  // (non-prod) or rejected wholesale (prod), breaking JWT tenant binding.
  if (req.user) {
    // Always overwrite — JWT tenant_id is the authenticated principal (AUTH-2).
    // A pre-set req.tenantId (e.g. anon default) must not win over the claim.
    if (typeof req.user.tenantId === 'string' && req.user.tenantId.length > 0) {
      req.tenantId = req.user.tenantId;
    }
    return next();
  }

  const clientIp = getClientIp(req);

  // Check lockout BEFORE processing auth — fail fast for locked IPs
  if (await isLockedOut(clientIp)) {
    try {
      const authFailureStore = getAuthFailureStore();
      const entry = await authFailureStore.get(clientIp);
      const lockedUntil = entry?.lockedUntil ?? 0;
      const retryAfter = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many authentication failures. Try again later.',
        retryAfter,
      });
      return;
    } catch (err) {
      process.stderr.write(`[Auth] Failed to read lockout entry: ${String(err)}\n`);
      res.status(429).json({
        error: 'Too many authentication failures. Try again later.',
      });
      return;
    }
  }

  const authHeader = readHeader(req.headers.authorization);
  const apiKeyHeader = readHeader(req.headers['x-api-key']);

  let keyId: string | null = null;
  let matchedScopes: string[] = [];
  let matchedKey: StoredKey | null = null;

  if (apiKeyHeader) {
    const matched = await findKey(apiKeyHeader);
    if (!matched) {
      await recordAuthFailure(clientIp);
      try {
        getGlobalLogger().warn('AuthMiddleware', 'Invalid API key', { ip: clientIp, path });
      } catch {
        process.stderr.write(`[Auth] Invalid API key from IP=${clientIp} path=${path}\n`);
      }
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const matched = await findKey(token);
    if (!matched) {
      await recordAuthFailure(clientIp);
      try {
        getGlobalLogger().warn('AuthMiddleware', 'Invalid bearer token', { ip: clientIp, path });
      } catch {
        process.stderr.write(`[Auth] Invalid bearer token from IP=${clientIp} path=${path}\n`);
      }
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (
    isProductionEnv() ||
    (await getApiKeyStore().list()).length > 0 ||
    // Non-production with no keys previously fell open. Require an explicit
    // opt-in so local/dev deploys are not anonymously writable by default.
    process.env.COMMANDER_ALLOW_ANON !== '1'
  ) {
    // Default-deny: require authentication whenever PostgreSQL contains an
    // API key or when running in production. Outside production, anonymous
    // access is only allowed when COMMANDER_ALLOW_ANON=1 is set explicitly.
    res.status(401).json({
      error: 'Authentication required',
      hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
    });
    return;
  }

  if (keyId) {
    req.apiKeyId = keyId;
    req.apiScopes = matchedScopes;
    if (matchedKey?.tenantId) {
      req.tenantId = matchedKey.tenantId;
    }
  } else if (!req.tenantId) {
    // COMMANDER_ALLOW_ANON fall-through: bind a default tenant so downstream
    // tenant-scoped stores (memory, etc.) have an ALS context.
    req.tenantId = process.env.COMMANDER_DEFAULT_TENANT_ID || 'local';
  }

  next();
}
