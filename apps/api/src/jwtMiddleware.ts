import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { UserRole } from './userStore';
import { isProductionEnv } from './envSignal';
import { persist as persistRefreshJti } from './refreshTokenStore';
import { isEnterpriseProfile } from './profileSignal';

// ── Express type augmentation ───────────────────────────────────────────────
//
// Extends the Express Request with a `user` field populated by this middleware.
// `null` means "no JWT provided" (the request still proceeds — individual
// routes decide whether authentication is required). This merges with the
// existing `apiKeyId` / `apiScopes` augmentation in authMiddleware.ts.

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser | null;
    }
  }
}

/** The user identity extracted from a verified JWT. */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  /**
   * Tenant binding carried by the JWT (WS3 §3.1). Present on enterprise access
   * tokens; absent on legacy/dev tokens. The /v1 tenant guard treats this as
   * authoritative and never allows a client header to widen it.
   */
  tenantId?: string;
  /** Scopes carried by the JWT (e.g. runs:write, governance:read). */
  scopes?: string[];
}

/** JWT payload shape — the standard claims plus our custom user fields. */
export interface CommanderJwtPayload extends JwtPayload {
  id: string;
  username: string;
  role: UserRole;
  type?: 'access' | 'refresh';
  /** Unique id for refresh tokens — used for rotation / revocation. */
  jti?: string;
  /** WS3 §3.1 — tenant binding for enterprise access tokens. */
  tenant_id?: string;
  /** WS3 §3.1 — scopes for route-level authorization. */
  scopes?: string[];
}

// ── JWT configuration ───────────────────────────────────────────────────────

const DEV_SECRET = 'commander-dev-secret-change-in-production';

/**
 * The HMAC secret used to sign/verify JWTs.
 *
 * In production this MUST be set via the JWT_SECRET environment variable.
 * The dev fallback is only acceptable for local development — a warning is
 * emitted at module load when it is in use.
 */
export const JWT_SECRET: string = process.env.JWT_SECRET ?? DEV_SECRET;

if (!process.env.JWT_SECRET) {
  if (isProductionEnv()) {
    // Fail closed. With no secret, JWTs are signed/verified with a public source
    // constant, so anyone can forge a signed { role: 'super_admin' } access token
    // and, combined with header-based tenant selection, act as super_admin in any
    // tenant (KC-1). Mirror capabilityToken's boot refusal.
    throw new Error(
      '[jwtMiddleware] JWT_SECRET must be set in production. Refusing to start with the ' +
        'insecure dev default (an unset secret permits forged super_admin tokens).',
    );
  }
  process.stderr.write(
    '[jwtMiddleware] WARNING: JWT_SECRET is not set — using insecure dev default. ' +
      'Set JWT_SECRET before deploying to production.\n',
  );
}

const ACCESS_TOKEN_EXPIRES_IN = '24h';
const REFRESH_TOKEN_EXPIRES_IN = '7d';

/**
 * AUTH-01: tenant claim for access tokens minted by login/register/refresh/OIDC.
 * Prefer COMMANDER_DEFAULT_TENANT_ID; fall back to `local` (same ambient default
 * as authMiddleware). Per-user tenant binding can tighten this later without
 * changing the claim surface.
 */
export function resolveAccessTenantId(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.COMMANDER_DEFAULT_TENANT_ID;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'local';
}

// ── Token helpers ───────────────────────────────────────────────────────────

/** Signs a short-lived access token (24h) carrying the user identity. */
export function signAccessToken(user: AuthUser): string {
  const payload: CommanderJwtPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    type: 'access',
  };
  if (typeof user.tenantId === 'string' && user.tenantId.length > 0) {
    payload.tenant_id = user.tenantId;
  }
  if (Array.isArray(user.scopes) && user.scopes.length > 0) {
    payload.scopes = user.scopes;
  }
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    algorithm: 'HS256',
  });
}

/**
 * Signs a long-lived refresh token (7d) used to obtain new access tokens.
 * Each token carries a unique `jti` that is persisted so it can be rotated
 * and revoked (see refreshTokenStore / /api/auth/refresh).
 */
export function signRefreshToken(user: AuthUser): string {
  const jti = randomUUID();
  const payload: CommanderJwtPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    type: 'refresh',
    jti,
  };
  // Refresh tokens do not carry tenant/scopes — they only mint new access
  // tokens, which are the tokens that authorize /v1 resource access.
  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    algorithm: 'HS256',
  });
  const decoded = jwt.decode(token) as CommanderJwtPayload | null;
  const exp =
    typeof decoded?.exp === 'number' ? decoded.exp : Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  persistRefreshJti(jti, user.id, exp);
  return token;
}

/**
 * Verifies a JWT and returns the decoded payload, or `null` if the token is
 * invalid / expired. Never throws — callers branch on the null return.
 */
export function verifyToken(token: string): CommanderJwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') {
      return null;
    }
    return decoded as CommanderJwtPayload;
  } catch {
    return null;
  }
}

// ── Paths exempt from JWT parsing ───────────────────────────────────────────
//
// These endpoints must be reachable without any token: health probes and the
// login/register flows that mint the very first token.

const JWT_PUBLIC_PATHS = new Set<string>([
  '/health',
  '/health/detailed',
  '/ready',
  '/metrics',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

function isJwtPublicPath(reqPath: string): boolean {
  if (JWT_PUBLIC_PATHS.has(reqPath)) {
    return true;
  }
  // Allow system status probes (same pattern as authMiddleware).
  return reqPath.startsWith('/health') || reqPath.startsWith('/system');
}

/**
 * /v1 sub-paths that are public metadata/health and must NOT be subject to the
 * enterprise fail-closed reversal (WS3 §3.2). These remain reachable without a
 * Bearer token so clients can discover the API surface and probe /v1 health.
 */
const V1_AUTH_EXEMPT_PATHS = new Set<string>(['/v1/openapi.json', '/v1/health']);

/**
 * Whether a path is a /v1 product path that requires an authenticated tenant
 * in the enterprise profile. Excludes the public metadata/health sub-paths.
 */
function isV1ProductPath(reqPath: string): boolean {
  if (reqPath !== '/v1' && !reqPath.startsWith('/v1/')) return false;
  return !V1_AUTH_EXEMPT_PATHS.has(reqPath);
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Extracts and verifies a JWT from the `Authorization: Bearer <token>` header.
 *
 * Behaviour:
 *  - Public paths (health, login, register) skip parsing entirely.
 *  - If a valid Bearer JWT is present, `req.user` is populated with the
 *    decoded identity (including tenant_id / scopes claims when present) and
 *    the request proceeds.
 *  - If the Bearer token is NOT a valid JWT (or no token is present),
 *    `req.user` is set to `null` and the request proceeds — this middleware
 *    normally does not block. Downstream routes (or the existing API-key
 *    authMiddleware) decide whether to reject unauthenticated requests.
 *  - WS3 §3.2 fail-closed reversal: in the enterprise profile, on /v1 product
 *    paths, an invalid/expired/non-access Bearer token is rejected here with
 *    401 INVALID_TOKEN before it can reach authMiddleware (which would
 *    otherwise mask the code with a generic "Invalid bearer token"). This
 *    reverses the legacy fail-open behaviour for /v1 enterprise only; all
 *    other paths and the standard profile keep fail-open for backward compat.
 *  - If the Authorization header is not a Bearer header (e.g. X-API-Key is
 *    used instead), `req.user` stays null and the existing API-key
 *    authMiddleware handles authentication.
 */
export function jwtMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Default: no authenticated user.
  req.user = null;

  if (isJwtPublicPath(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No Bearer token — fall through to the existing API-key authMiddleware.
    next();
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    next();
    return;
  }

  const decoded = verifyToken(token);
  if (decoded && decoded.type !== 'refresh') {
    // Valid access token — inject the user identity + enterprise claims.
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      tenantId: decoded.tenant_id,
      scopes: decoded.scopes,
    };
    next();
    return;
  }
  // Verification failed, or a refresh token was presented where an access
  // token is required. In the enterprise profile on /v1 product paths this
  // is fail-closed: reject immediately so the downstream /v1 tenant guard
  // never observes an unauthenticated Bearer. Elsewhere we preserve the
  // legacy fail-open behaviour (authMiddleware may still accept the token as
  // an API key, or reject per its own default-deny rules).
  if (isEnterpriseProfile() && isV1ProductPath(req.path)) {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Bearer token is invalid, expired, or not an access token.',
      },
    });
    return;
  }
  next();
}
