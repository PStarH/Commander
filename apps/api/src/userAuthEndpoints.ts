import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { compareSync, hashSync } from 'bcryptjs';
import { z } from 'zod';
import {
  findUserById,
  findUserByUsername,
  createUser,
  listUsers,
  updateUserRole,
  updateLastLogin,
  toSafeUserPublic,
  updateUser,
  resetUserPassword,
  deleteUser,
  countAdmins,
  hasRole,
  LAST_ADMIN_ERROR,
  type UserRole,
  type SafeUser,
} from './userStore';
import {
  signAccessToken,
  signRefreshToken,
  mintRefreshToken,
  verifyToken,
  type AuthUser,
  resolveAccessTenantId,
} from './jwtMiddleware';
import { revoke as revokeRefreshJti, rotate as rotateRefreshJti } from './refreshTokenStore';
import { getAuthFailureStore } from './authFailureStore';
import { redactAuthErrorDetail } from './authDb';
import { resolvePositiveSafeInteger } from './startupConfig';

/**
 * AUTH-6: a real bcrypt hash used only to spend comparable CPU on the
 * user-not-found login path, defeating timing-based username enumeration.
 * Computed once at module load (of a value no user can hold) so its work factor
 * matches the real comparison; it is never a valid credential.
 */
const DUMMY_PASSWORD_HASH = hashSync(`invalid:${process.pid}:no-such-user`, 10);
const MAX_AUTH_FAILURES = resolvePositiveSafeInteger(process.env, 'AUTH_MAX_FAILURES', 5);
const LOCKOUT_DURATION_MS = resolvePositiveSafeInteger(process.env, 'AUTH_LOCKOUT_MS', 300000);
const AUTH_FAILURE_WINDOW_MS = 60_000;

// ── Validation schemas ──────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      'Username may only contain letters, numbers, dots, hyphens and underscores',
    ),
  email: z.string().email('Invalid email address').max(255),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
});

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(32),
  password: z.string().min(1, 'Password is required').max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

const roleUpdateSchema = z.object({
  role: z.enum(['super_admin', 'admin', 'developer', 'operator', 'auditor', 'viewer']),
});

const adminCreateUserSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      'Username may only contain letters, numbers, dots, hyphens and underscores',
    ),
  email: z.string().email('Invalid email address').max(255),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
  role: z
    .enum(['super_admin', 'admin', 'developer', 'operator', 'auditor', 'viewer'])
    .default('viewer'),
});

const adminUpdateUserSchema = z.object({
  email: z.string().email('Invalid email address').max(255).optional(),
  role: z.enum(['super_admin', 'admin', 'developer', 'operator', 'auditor', 'viewer']).optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters').max(128),
});

// ── Auth guard middleware ───────────────────────────────────────────────────

/**
 * Requires an authenticated user (req.user populated by jwtMiddleware).
 * Returns 401 if no user is attached to the request.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Returns middleware that requires the authenticated user to meet or exceed
 * `requiredRole` in the role hierarchy (defaults to 'admin', so both
 * 'super_admin' and 'admin' satisfy an unparameterised check). Must be
 * mounted after requireAuth.
 */
function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

/**
 * AUDIT-A: an actor may only administer users whose current role is at or
 * below the actor's own level. Without this, a same-realm `admin` could reset
 * a `super_admin` password (account takeover) or delete/demote them.
 */
function canActOnTarget(actorRole: UserRole, target: { role: UserRole }): boolean {
  return hasRole(actorRole, target.role);
}

// ── Response helpers ────────────────────────────────────────────────────────

interface AuthResponseBody {
  token: string;
  refreshToken: string;
  user: SafeUser;
}

async function buildAuthResponse(
  user: AuthUser,
  rotatedRefreshToken?: string,
): Promise<AuthResponseBody> {
  // Look up the fresh user record so lastLoginAt / createdAt are current.
  const full = await findUserById(user.id);
  const safeUser: SafeUser = full
    ? toSafeUserPublic(full)
    : {
        id: user.id,
        username: user.username,
        email: '',
        role: user.role,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      };
  return {
    token: signAccessToken(user),
    // AUTH-03: rotation mints+persists its new refresh token inside the
    // version-fenced transaction, so it is passed in rather than re-persisted.
    refreshToken: rotatedRefreshToken ?? (await signRefreshToken(user)),
    user: safeUser,
  };
}

function loginClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

async function rejectLockedLogin(req: Request, res: Response): Promise<boolean> {
  try {
    const entry = await getAuthFailureStore().get(loginClientIp(req));
    if (!entry || entry.lockedUntil <= Date.now()) return false;
    const retryAfter = Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Too many authentication failures. Try again later.',
      retryAfter,
    });
    return true;
  } catch (error) {
    process.stderr.write(`[Auth] Login lockout authority unavailable: ${String(error)}\n`);
    res.status(503).json({ error: 'Authentication authority unavailable. Retry later.' });
    return true;
  }
}

async function recordLoginFailure(req: Request, res: Response): Promise<boolean> {
  try {
    await getAuthFailureStore().recordFailure(
      loginClientIp(req),
      Date.now(),
      MAX_AUTH_FAILURES,
      AUTH_FAILURE_WINDOW_MS,
      LOCKOUT_DURATION_MS,
    );
    return true;
  } catch (error) {
    process.stderr.write(`[Auth] Login failure authority unavailable: ${String(error)}\n`);
    res.status(503).json({ error: 'Authentication authority unavailable. Retry later.' });
    return false;
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

export function createUserAuthRouter(): Router {
  const router = Router();

  // ── POST /api/auth/register ──────────────────────────────────────────────
  router.post('/api/auth/register', async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const { username, email, password } = parsed.data;
    const result = await createUser({ username, email, password, role: 'viewer' });
    if ('error' in result) {
      res.status(409).json({ error: result.error });
      return;
    }

    const authUser: AuthUser = {
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
      authVersion: (await findUserById(result.user.id))!.authVersion,
      tenantId: resolveAccessTenantId(),
    };
    await updateLastLogin(result.user.id);
    res.status(201).json(await buildAuthResponse(authUser));
  });

  // ── POST /api/auth/login ─────────────────────────────────────────────────
  router.post('/api/auth/login', async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const { username, password } = parsed.data;
    if (await rejectLockedLogin(req, res)) return;
    const user = await findUserByUsername(username);
    // AUTH-6: always perform a bcrypt comparison, even when the user does not
    // exist, so the response time does not reveal whether a username is
    // registered (timing-based user enumeration). The dummy hash is a real
    // bcrypt hash so the work factor matches the real path.
    const passwordOk = compareSync(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) {
      if (!(await recordLoginFailure(req, res))) return;
      // Use the same message for both cases to avoid user enumeration.
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const authUser: AuthUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      authVersion: user.authVersion,
      tenantId: resolveAccessTenantId(),
    };
    await updateLastLogin(user.id);
    res.json(await buildAuthResponse(authUser));
  });

  // ── GET /api/auth/me ─────────────────────────────────────────────────────
  router.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
    const user = await findUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: toSafeUserPublic(user) });
  });

  // ── POST /api/auth/refresh ───────────────────────────────────────────────
  // Rotates refresh tokens: validate jti → revoke old → mint new pair.
  router.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const decoded = verifyToken(parsed.data.refreshToken);
    if (
      !decoded ||
      decoded.type !== 'refresh' ||
      !decoded.jti ||
      !Number.isSafeInteger(decoded.auth_version)
    ) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }
    const expectedAuthVersion = Number(decoded.auth_version);

    // AUTH-03: rotate inside one version-fenced transaction — lock the user
    // row, verify the refresh token's `auth_version` against the authoritative
    // value, consume the old jti and register the new one. A reset (or role
    // change) that lands between consume and mint can no longer leave a valid
    // new refresh behind: it either serializes before us (and we reject on the
    // stale version) or after us (and revokes the jti we just registered).
    const minted = mintRefreshToken({
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      authVersion: expectedAuthVersion,
      tenantId: decoded.tenant_id ?? resolveAccessTenantId(),
    });
    const rotation = await rotateRefreshJti({
      userId: decoded.id,
      currentJti: decoded.jti,
      nextJti: minted.jti,
      nextExp: minted.exp,
      expectedAuthVersion,
    }).catch((error: unknown) => {
      // AUTH-03/07: an unavailable rotation authority must fail closed without
      // issuing a token, and must not echo the driver detail (it can embed the
      // DSN). The request id lets operators correlate with the internal log.
      process.stderr.write(
        `[Auth] Refresh rotation authority unavailable requestId=${
          req.requestId ?? 'none'
        } detail=${redactAuthErrorDetail(error)}\n`,
      );
      return { status: 'rejected', reason: 'authority_unavailable' } as const;
    });
    if (rotation.status !== 'rotated') {
      if (rotation.reason === 'authority_unavailable') {
        res.status(503).json({
          error: 'Authentication authority unavailable. Retry later.',
          code: 'AUTH_AUTHORITY_UNAVAILABLE',
          requestId: req.requestId,
        });
        return;
      }
      res.status(401).json({ error: 'Refresh token revoked or unknown' });
      return;
    }

    // Read the now-authoritative user record; the version was validated inside
    // the transaction, so `user.authVersion` matches the fenced value.
    const user = await findUserById(decoded.id);
    if (!user) {
      res.status(401).json({ error: 'User no longer exists' });
      return;
    }

    const authUser: AuthUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      authVersion: user.authVersion,
      tenantId: decoded.tenant_id ?? resolveAccessTenantId(),
    };
    res.json(await buildAuthResponse(authUser, minted.token));
  });

  // ── POST /api/auth/logout ────────────────────────────────────────────────
  // Revokes the presented refresh jti (access token TTL still applies).
  router.post('/api/auth/logout', async (req: Request, res: Response) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const decoded = verifyToken(parsed.data.refreshToken);
    if (decoded?.type === 'refresh' && decoded.jti) {
      await revokeRefreshJti(decoded.jti);
    }
    res.json({ success: true });
  });

  // ── GET /api/auth/users  (admin only) ────────────────────────────────────
  router.get(
    '/api/auth/users',
    requireAuth,
    requireRole(),
    async (_req: Request, res: Response) => {
      res.json({ users: await listUsers() });
    },
  );

  // ── PUT /api/auth/users/:id/role  (admin only) ───────────────────────────
  router.put(
    '/api/auth/users/:id/role',
    requireAuth,
    requireRole(),
    async (req: Request, res: Response) => {
      const parsed = roleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation error',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }

      const id = String(req.params.id);
      const targetUser = await findUserById(id);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // AUDIT-A: may only change the role of a user at or below your own level.
      if (!canActOnTarget(req.user!.role, targetUser)) {
        res.status(403).json({ error: 'You cannot modify a user above your own level' });
        return;
      }

      // Prevent a user from demoting themselves below admin level (would risk
      // locking out the last admin-level account).
      if (req.user!.id === id && !hasRole(parsed.data.role, 'admin')) {
        res.status(400).json({ error: 'You cannot demote your own admin account' });
        return;
      }

      // AUTH-5: an actor may only grant a role at or below their own level.
      if (!hasRole(req.user!.role, parsed.data.role as UserRole)) {
        res.status(403).json({ error: 'You cannot assign a role above your own level' });
        return;
      }

      const updated = await updateUserRole(id, parsed.data.role as UserRole);
      if (updated.outcome === 'not_found') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (updated.outcome === 'last_admin') {
        // AUTH-04: covers the last `super_admin`, which the old PATCH-only
        // check (targetUser.role === 'admin') let through.
        res.status(400).json({ error: LAST_ADMIN_ERROR });
        return;
      }
      res.json({ user: updated.user });
    },
  );

  // ── POST /api/auth/users  (admin only) ───────────────────────────────────
  router.post(
    '/api/auth/users',
    requireAuth,
    requireRole(),
    async (req: Request, res: Response) => {
      const parsed = adminCreateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation error',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }

      // AUTH-5: an actor may only create a user with a role at or below their own level.
      if (
        parsed.data.role !== undefined &&
        !hasRole(req.user!.role, parsed.data.role as UserRole)
      ) {
        res
          .status(403)
          .json({ error: 'You cannot create a user with a role above your own level' });
        return;
      }

      const result = await createUser(parsed.data);
      if ('error' in result) {
        res.status(409).json({ error: result.error });
        return;
      }
      res.status(201).json({ user: result.user });
    },
  );

  // ── PATCH /api/auth/users/:id  (admin only) ───────────────────────────────
  router.patch(
    '/api/auth/users/:id',
    requireAuth,
    requireRole(),
    async (req: Request, res: Response) => {
      const parsed = adminUpdateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation error',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }

      const id = String(req.params.id);
      const targetUser = await findUserById(id);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // AUDIT-A: may only update a user at or below your own level.
      if (!canActOnTarget(req.user!.role, targetUser)) {
        res.status(403).json({ error: 'You cannot modify a user above your own level' });
        return;
      }

      // AUTH-04: immediate, precise 400 for the last-admin case. `hasRole(…,
      // 'admin')` covers super_admin as well as admin — the old check only
      // matched `targetUser.role === 'admin'`, so the only super_admin could be
      // demoted. The repository re-checks this authoritatively inside the
      // membership-locked transaction, so a concurrent delete/demotion cannot
      // slip past (see the LAST_ADMIN_ERROR mapping below).
      if (
        parsed.data.role !== undefined &&
        !hasRole(parsed.data.role, 'admin') &&
        hasRole(targetUser.role, 'admin') &&
        (await countAdmins()) <= 1
      ) {
        res.status(400).json({ error: LAST_ADMIN_ERROR });
        return;
      }

      // AUTH-5: an actor may only assign a role at or below their own level.
      if (
        parsed.data.role !== undefined &&
        !hasRole(req.user!.role, parsed.data.role as UserRole)
      ) {
        res.status(403).json({ error: 'You cannot assign a role above your own level' });
        return;
      }

      const updated = await updateUser(id, parsed.data);
      if ('error' in updated) {
        res.status(updated.error === LAST_ADMIN_ERROR ? 400 : 409).json({ error: updated.error });
        return;
      }
      res.json({ user: updated });
    },
  );

  // ── DELETE /api/auth/users/:id  (admin only) ──────────────────────────────
  router.delete(
    '/api/auth/users/:id',
    requireAuth,
    requireRole(),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      if (req.user!.id === id) {
        res.status(400).json({ error: 'You cannot delete your own account' });
        return;
      }

      const targetUser = await findUserById(id);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // AUDIT-A: may only delete a user at or below your own level.
      if (!canActOnTarget(req.user!.role, targetUser)) {
        res.status(403).json({ error: 'You cannot delete a user above your own level' });
        return;
      }

      const result = await deleteUser(id);
      if (!result.success) {
        res.status(result.error === 'User not found' ? 404 : 400).json({ error: result.error });
        return;
      }
      res.json({ success: true });
    },
  );

  // ── POST /api/auth/users/:id/reset-password  (admin only) ────────────────
  router.post(
    '/api/auth/users/:id/reset-password',
    requireAuth,
    requireRole(),
    async (req: Request, res: Response) => {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation error',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }

      const id = String(req.params.id);
      const targetUser = await findUserById(id);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!canActOnTarget(req.user!.role, targetUser)) {
        res.status(403).json({ error: 'You cannot modify a user above your own level' });
        return;
      }
      // AUTH-03: the version bump and the refresh-token revocation happen in
      // one transaction (see PostgresUserRepository.resetUserPassword), so a
      // rotation cannot slip a new jti past a separate revoke call.
      const updated = await resetUserPassword(id, parsed.data.newPassword);
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: updated });
    },
  );

  return router;
}
