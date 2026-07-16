import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';
import { isProductionEnv, describeProdSignal } from './envSignal';
import { getApiKeyStore } from './apiKeyStore';

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

const authFailureTracker = new Map<
  string,
  { count: number; firstFailureAt: number; lockedUntil: number }
>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailureTracker) {
    if (entry.lockedUntil < now && entry.firstFailureAt < now - AUTH_FAILURE_WINDOW_MS) {
      authFailureTracker.delete(ip);
    }
  }
}, 300_000).unref();

function sha256(input: string): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

function parseApiKeys(raw: string | undefined): Map<string, StoredKey> {
  const keys = new Map<string, StoredKey>();
  if (!raw) return keys;
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length >= 1 && parts[0]) {
      const rawKey = parts[0];
      const name = parts[1] ?? rawKey.slice(0, 8);
      const scopes = parts[2]?.split(';') ?? ['read', 'write'];
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
        name: `${tenantId}:${key.slice(0, 8)}`,
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
    for (const [hash, stored] of parseTenantApiKeys(tenantRaw)) {
      cachedApiKeys.set(hash, stored);
    }
  }
  return cachedApiKeys;
}

/**
 * Timing-safe key lookup. Hashes the provided token and compares against
 * all stored hashes using crypto.timingSafeEqual. The loop always iterates
 * over ALL entries (no early exit) to prevent timing side-channels.
 */
function findKey(token: string, storedKeys: Map<string, StoredKey>): StoredKey | null {
  const tokenHash = sha256(token);
  let match: StoredKey | null = null;
  // Iterate over ALL keys — no early exit to maintain constant time
  for (const stored of storedKeys.values()) {
    try {
      if (
        stored.hash.length === tokenHash.length &&
        crypto.timingSafeEqual(stored.hash, tokenHash)
      ) {
        match = stored;
        // Do NOT break — continue iterating to prevent timing leak
      }
    } catch {
      // Length mismatch or other error — continue
    }
  }
  // Fallback to the persistent API key store (created via /api/admin/api-keys).
  if (!match) {
    const storeRecord = getApiKeyStore().findByHash(tokenHash.toString('hex'));
    if (storeRecord) {
      match = {
        hash: Buffer.from(storeRecord.hash, 'hex'),
        name: storeRecord.name,
        scopes: storeRecord.scopes,
        tenantId: storeRecord.tenantId,
      };
    }
  }
  return match;
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

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  let entry = authFailureTracker.get(ip);
  if (!entry || entry.firstFailureAt < now - AUTH_FAILURE_WINDOW_MS) {
    entry = { count: 0, firstFailureAt: now, lockedUntil: 0 };
  }
  entry.count++;
  if (entry.count >= MAX_AUTH_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    process.stderr.write(
      `[Auth] IP ${ip} locked out after ${entry.count} failures for ${LOCKOUT_DURATION_MS / 1000}s\n`,
    );
  }
  authFailureTracker.set(ip, entry);
}

function isLockedOut(ip: string): boolean {
  const entry = authFailureTracker.get(ip);
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
  // eslint-disable-next-line no-console
  console.warn(
    `[authMiddleware] AUTH_DISABLED=true in production (signal=${describeProdSignal()}) — admin endpoints (e.g. /api/v1/hub) are publicly accessible. This is a security risk; remove the env var before deployment.`,
  );
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
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
    return next();
  }

  const path = req.path;
  if (isPublicPath(path)) {
    return next();
  }

  // If jwtMiddleware already authenticated the request via a valid JWT
  // (req.user is set), skip API-key validation entirely. This keeps the two
  // auth mechanisms compatible: JWT users are not subject to API-key checks.
  if (req.user) {
    return next();
  }

  const clientIp = getClientIp(req);

  // Check lockout BEFORE processing auth — fail fast for locked IPs
  if (isLockedOut(clientIp)) {
    const entry = authFailureTracker.get(clientIp)!;
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Too many authentication failures. Try again later.',
      retryAfter,
    });
    return;
  }

  const apiKeys = getCachedKeys();
  const authHeader = readHeader(req.headers.authorization);
  const apiKeyHeader = readHeader(req.headers['x-api-key']);

  let keyId: string | null = null;
  let matchedScopes: string[] = [];
  let matchedKey: StoredKey | null = null;

  if (apiKeyHeader) {
    const matched = findKey(apiKeyHeader, apiKeys);
    if (!matched) {
      recordAuthFailure(clientIp);
      process.stderr.write(`[Auth] Invalid API key from IP=${clientIp} path=${path}\n`);
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const matched = findKey(token, apiKeys);
    if (!matched) {
      recordAuthFailure(clientIp);
      process.stderr.write(`[Auth] Invalid bearer token from IP=${clientIp} path=${path}\n`);
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    keyId = matched.name;
    matchedScopes = matched.scopes;
    matchedKey = matched;
  } else if (
    apiKeys.size > 0 ||
    isProductionEnv() ||
    getApiKeyStore().list().length > 0 ||
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
  }

  next();
}
