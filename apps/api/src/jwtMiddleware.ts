import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { UserRole } from './userStore';
import { isProductionEnv } from './envSignal';
import { persist as persistRefreshJti } from './refreshTokenStore';

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
}

/** JWT payload shape — the standard claims plus our custom user fields. */
export interface CommanderJwtPayload extends JwtPayload {
  id: string;
  username: string;
  role: UserRole;
  type?: 'access' | 'refresh';
  /** Unique id for refresh tokens — used for rotation / revocation. */
  jti?: string;
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

// ── Token helpers ───────────────────────────────────────────────────────────

/** Signs a short-lived access token (24h) carrying the user identity. */
export function signAccessToken(user: AuthUser): string {
  const payload: CommanderJwtPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    type: 'access',
  };
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
  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    algorithm: 'HS256',
  });
  const decoded = jwt.decode(token) as CommanderJwtPayload | null;
  const exp = typeof decoded?.exp === 'number' ? decoded.exp : Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
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

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Extracts and verifies a JWT from the `Authorization: Bearer <token>` header.
 *
 * Behaviour:
 *  - Public paths (health, login, register) skip parsing entirely.
 *  - If a valid Bearer JWT is present, `req.user` is populated with the
 *    decoded identity and the request proceeds.
 *  - If the Bearer token is NOT a valid JWT (or no token is present),
 *    `req.user` is set to `null` and the request proceeds — this middleware
 *    never blocks. Downstream routes (or the existing API-key authMiddleware)
 *    decide whether to reject unauthenticated requests.
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
    // Valid access token — inject the user identity.
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
    };
  }
  // If verification failed, req.user remains null. The downstream
  // authMiddleware will attempt API-key validation, preserving backward
  // compatibility with existing API-key-based clients.
  next();
}
