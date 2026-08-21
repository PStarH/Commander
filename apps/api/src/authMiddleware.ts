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
      /** Tenant associated with the authenticated API key or static key mapping. */
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

// ── Timing-safe API key storage ──────────────────────────────────────────────
//
// SECURITY FIX: Previous implementation stored raw API keys in a Map and used
// Map.has() for lookup. While Map.has() is hash-based, the keys were stored in
// plaintext in memory, making them extractable via memory dumps. Additionally,
// the comparison path leaked timing information through early-exit branching.
//
// New approach:
// 1. Keys are SHA-256 hashed at parse time; plaintext is never retained.
// 2. Lookup uses timingSafeEqual on hashes — constant-time comparison.
// 3. Auth-failure lockout: after MAX_AUTH_FAILURES within the window, the
//    source IP is locked out for LOCKOUT_DURATION_MS, preventing brute-force.
// 4. All auth failures are logged to stderr for SIEM ingestion.

interface StoredKey {
  hash: Buffer; // SHA-256 hash of the raw key
  name: string;
  scopes: string[];
  tenantId?: string;
}

const MAX_AUTH_FAILURES = parseInt(process.env.AUTH_MAX_FAILURES ?? '5', 10);
const LOCKOUT_DURATION_MS = parseInt(process.env.AUTH_LOCKOUT_MS ?? '300000', 10); // 5 min
const AUTH_FAILURE_WINDOW_MS = 60_000; // 1 minute sliding window

const startupAuthFailureStore = getAuthFailureStore();

// Cleanup old entries every 5 minutes
setInterval(() => {
  startupAuthFailureStore.cleanup(Date.now(), AUTH_FAILURE_WINDOW_MS).catch((err) => {
    process.stderr.write('[Auth] Failed to cleanup auth failure entries: ' + String(err) + '\n');
  });
}, 300_000).unref();

function sha256(input: string): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

function parseApiKeys(raw: string | undefined): Map<string, StoredKey> {
  const keys = new Map<string, StoredKey>();
  if (!raw) return keys;
  for (const entry of raw.split(',')) {
    const [rawKey, configuredName, ...scopeParts] = entry.trim().split(':');
    if (rawKey) {
      const name = configuredName || rawKey.slice(0, 8);
      const scopeSpec = scopeParts.join(':');
      const scopes = scopeSpec ? scopeSpec.split(';').filter(Boolean) : ['read', 'write'];
      // Store only the hash — plaintext key is discarded after hashing
      keys.set(sha256(rawKey).toString('hex'), { hash: sha256(rawKey), name, scopes });
    }
  }
  return keys;
}

// Tenant-scoped static API keys: TENANT_API_KEYS=tenantId:key1,key2;tenantId2:key3
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function parseTenantApiKeys(raw: string | undefined): Map<string, StoredKey> {
  const keys = new Map<string, StoredKey>();
  if (!raw) return keys;
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const tenantId = parts[0];
    if (!TENANT_ID_RE.test(tenantId)) continue;
    const rawKeys = parts[1].split(',');
    for (const rawKey of rawKeys) {
      const key = rawKey.trim();
      if (!key) continue;
      keys.set(sha256(key).toString('hex'), {
        hash: sha256(key),
        name: tenantId + ':' + key.slice(0, 8),
        scopes: ['read', 'write'],
        tenantId,
      });
    }
  }
  return keys;
}

// ── API key parse cache ──────────────────────────────────────────────────────
//
// PERFORMANCE FIX: parseApiKeys() performs two SHA-256 hashes per configured
// key. Calling it on every request wastes CPU under load. We cache the parsed
// result at module scope and only re-parse when the raw API_KEYS env var
// changes value (e.g. hot-reload of configuration), so the expensive hashing
// happens at most once per distinct configuration.
let cachedApiKeys: Map<string, StoredKey> | null = null;
let cachedApiKeysRaw: string | undefined = undefined;
let cachedTenantApiKeysRaw: string | undefined = undefined;

function getCachedKeys(): Map<string, StoredKey> {
  const raw = process.env.API_KEYS;
  const tenantRaw = process.env.TENANT_API_KEYS;
  if (cachedApiKeys === null || raw !== cachedApiKeysRaw || tenantRaw !== cachedTenantApiKeysRaw) {
    cachedApiKeysRaw = raw;
    cachedTenantApiKeysRaw = tenantRaw;
    cachedApiKeys = parseApiKeys(raw);
    for (const [hash, tenantBinding] of parseTenantApiKeys(tenantRaw)) {
      const configured = cachedApiKeys.get(hash);
      cachedApiKeys.set(
        hash,
        configured ? { ...configured, tenantId: tenantBinding.tenantId } : tenantBinding,
      );
    }
  }
  return cachedApiKeys;
}

/**
 * Timing-safe key lookup. Hashes the provided token once, then performs an
 * O(1) Map lookup by hex digest. The matched candidate is verified with
 * crypto.timingSafeEqual to guard against timing side-channels.
 */
async function findKey(
  token: string,
  storedKeys: Map<string, StoredKey>,
): Promise<StoredKey | null> {
  const tokenHash = sha256(token);
  const storeRecord = await getApiKeyStore().findByHash(tokenHash.toString('hex'));
  if (storeRecord) {
    return {
      hash: Buffer.from(storeRecord.hash, 'hex'),
      name: storeRecord.name,
      scopes: storeRecord.scopes,
      tenantId: storeRecord.tenantId,
    };
  }

  // Environment keys remain an explicitly configured development mechanism,
  // but a healthy PostgreSQL authority is required before they can authenticate.
  const stored = storedKeys.get(tokenHash.toString('hex'));
  if (stored) {
    try {
      if (
        stored.hash.length === tokenHash.length &&
        crypto.timingSafeEqual(stored.hash, tokenHash)
      ) {
        return stored;
      }
    } catch {
      // Length mismatch or other error — fall through
    }
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
  let entry = await authFailureStore.get(ip);
  if (!entry || entry.lastFailureAt < now - AUTH_FAILURE_WINDOW_MS) {
    entry = { count: 0, firstFailureAt: now, lastFailureAt: now, lockedUntil: 0 };
  }
  entry.count++;
  entry.lastFailureAt = now;
  if (entry.count >= MAX_AUTH_FAILURES && entry.lockedUntil === 0) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    try {
      getGlobalLogger().warn(
        'AuthMiddleware',
        'IP ' + ip + ' locked out after ' + entry.count + ' failures',
        {
          ip,
          count: entry.count,
          lockoutDurationSeconds: LOCKOUT_DURATION_MS / 1000,
        },
      );
    } catch {
      process.stderr.write(
        '[Auth] IP ' +
          ip +
          ' locked out after ' +
          entry.count +
          ' failures for ' +
          LOCKOUT_DURATION_MS / 1000 +
          's\n',
      );
    }
  }
  await authFailureStore.set(ip, entry);
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
      '[authMiddleware] AUTH_DISABLED=true in production (signal=' +
        describeProdSignal() +
        ') — admin endpoints (e.g. /api/v1/hub) are publicly accessible. This is a security risk; remove the env var before deployment.',
    );
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    await authMiddlewareInternal(req, res, next);
  } catch {
    process.stderr.write('[Auth] Authentication authority unavailable\n');
    if (!res.headersSent) {
      res.status(503).json({ error: 'Authentication service unavailable' });
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
      process.stderr.write('[Auth] Failed to read lockout entry: ' + String(err) + '\n');
      res.status(429).json({
        error: 'Too many authentication failures. Try again later.',
      });
      return;
    }
  }

  const apiKeys = getCachedKeys();
  const authHeader = readHeader(req.headers.authorization);
  const apiKeyHeader = readHeader(req.headers['x-api-key']);

  let keyId: string | null = null;
  let matchedScopes: string[] = [];
  let matchedKey: StoredKey | null = null;

  if (apiKeyHeader) {
    const matched = await findKey(apiKeyHeader, apiKeys);
    if (!matched) {
      await recordAuthFailure(clientIp);
      try {
        getGlobalLogger().warn('AuthMiddleware', 'Invalid API key', { ip: clientIp, path });
      } catch {
        process.stderr.write('[Auth] Invalid API key from IP=' + clientIp + ' path=' + path + '\n');
      }
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const matched = await findKey(token, apiKeys);
    if (!matched) {
      await recordAuthFailure(clientIp);
      try {
        getGlobalLogger().warn('AuthMiddleware', 'Invalid bearer token', { ip: clientIp, path });
      } catch {
        process.stderr.write(
          '[Auth] Invalid bearer token from IP=' + clientIp + ' path=' + path + '\n',
        );
      }
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (
    apiKeys.size > 0 ||
    isProductionEnv() ||
    (await getApiKeyStore().list()).length > 0 ||
    // Non-production with no keys previously fell open. Require an explicit
    // opt-in so local/dev deploys are not anonymously writable by default.
    process.env.COMMANDER_ALLOW_ANON !== '1'
  ) {
    // Default-deny: require authentication whenever any API key is configured —
    // in the env cache OR the persistent store — or whenever we are in
    // production. Outside production, anonymous access is only allowed when
    // COMMANDER_ALLOW_ANON=1 is set explicitly (dev escape hatch).
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
