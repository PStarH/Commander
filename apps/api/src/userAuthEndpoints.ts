import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { compareSync, hashSync } from 'bcryptjs';
import { z } from 'zod';
import {
  findUserById,
  findUserByUsername,
  findUserTenantMembership,
  createUser,
  listUsers,
  updateUserRole,
  updateLastLogin,
  toSafeUserPublic,
  updateUser,
  resetUserPassword,
  deleteUser,
  hasRole,
  type UserRole,
  type SafeUser,
} from './userStore';
import { signAccessToken, signRefreshToken, verifyToken, type AuthUser } from './jwtMiddleware';
import { getRefreshTokenRepository, type RefreshTokenRepository } from './refreshTokenStore';

/**
 * AUTH-6: a real bcrypt hash used only to spend comparable CPU on the
 * user-not-found login path, defeating timing-based username enumeration.
 * Computed once at module load (of a value no user can hold) so its work factor
 * matches the real comparison; it is never a valid credential.
 */
const DUMMY_PASSWORD_HASH = hashSync('invalid:' + process.pid + ':no-such-user', 10);

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
  tenantId: z.string().min(1, 'tenantId is required').max(128),
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
 * requiredRole in the role hierarchy (defaults to 'admin', so both
 * 'super_admin' and 'admin' satisfy an unparameterised check). Must be
 * mounted after requireAuth.
 */
function requireRole(requiredRole: UserRole = 'admin') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || !req.user.tenantId) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    try {
      const membership = await findUserTenantMembership(req.user.id, req.user.tenantId);
      if (!membership || !hasRole(membership.role, requiredRole)) {
        res.status(403).json({ error: 'Insufficient privileges' });
        return;
      }
      req.user.role = membership.role;
    } catch {
      res.status(503).json({ error: 'Authentication service unavailable' });
      return;
    }
    next();
  };
}

// ── Response helpers ────────────────────────────────────────────────────────

interface AuthResponseBody {
  token: string;
  refreshToken: string;
  user: SafeUser;
}

async function buildAuthResponse(
  user: AuthUser,
  refreshTokens: Pick<RefreshTokenRepository, 'insert'>,
): Promise<AuthResponseBody> {
  // Look up the fresh user record so lastLoginAt / createdAt are current.
  const full = await findUserById(user.id);
  if (!full) throw new Error('AUTH_USER_NOT_FOUND');
  const safeUser = toSafeUserPublic(full);
  const refreshToken = await signRefreshToken(user, refreshTokens);
  return {
    token: signAccessToken(user),
    refreshToken,
    user: safeUser,
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

export interface UserAuthRouterOptions {
  refreshTokens?: RefreshTokenRepository;
}

export function createUserAuthRouter(options: UserAuthRouterOptions = {}): Router {
  const router = Router();
  const refreshTokens = options.refreshTokens ?? getRefreshTokenRepository();

  function authorityUnavailable(res: Response): void {
    res.status(503).json({ error: 'Authentication service unavailable' });
  }

  async function targetIsInPrincipalTenant(
    req: Request,
    res: Response,
    userId: string,
  ): Promise<boolean> {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'Tenant-bound authentication required' });
      return false;
    }
    try {
      if (await findUserTenantMembership(userId, tenantId)) return true;
      res.status(404).json({ error: 'User not found' });
      return false;
    } catch {
      authorityUnavailable(res);
      return false;
    }
  }

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

    res.status(403).json({ error: 'Tenant-bound administrator provisioning is required' });
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

    const { username, password, tenantId } = parsed.data;
    let user;
    try {
      user = await findUserByUsername(username);
    } catch {
      authorityUnavailable(res);
      return;
    }
    // AUTH-6: always perform a bcrypt comparison, even when the user does not
    // exist, so the response time does not reveal whether a username is
    // registered (timing-based user enumeration). The dummy hash is a real
    // bcrypt hash so the work factor matches the real path.
    const passwordOk = compareSync(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) {
      // Use the same message for both cases to avoid user enumeration.
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    let membership;
    try {
      membership = await findUserTenantMembership(user.id, tenantId);
    } catch {
      authorityUnavailable(res);
      return;
    }
    if (!membership) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const userId = user.id;

    try {
      const response = await refreshTokens.withUserSessionLock(userId, async (session) => {
        const currentUser = await findUserById(userId);
        if (!currentUser || !compareSync(password, currentUser.passwordHash)) return undefined;
        const currentMembership = await findUserTenantMembership(currentUser.id, tenantId);
        if (!currentMembership) return undefined;
        const authUser: AuthUser = {
          id: currentUser.id,
          username: currentUser.username,
          role: currentMembership.role,
          tenantId: currentMembership.tenantId,
        };
        await updateLastLogin(currentUser.id);
        return buildAuthResponse(authUser, session);
      });
      if (!response) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      res.json(response);
    } catch {
      authorityUnavailable(res);
    }
  });

  // ── GET /api/auth/me ─────────────────────────────────────────────────────
  router.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
    let user;
    try {
      user = await findUserById(req.user!.id);
    } catch {
      authorityUnavailable(res);
      return;
    }
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!req.user!.tenantId) {
      res.status(401).json({ error: 'Tenant-bound authentication required' });
      return;
    }
    try {
      if (!(await findUserTenantMembership(user.id, req.user!.tenantId))) {
        res.status(401).json({ error: 'Tenant membership is no longer authorized' });
        return;
      }
    } catch {
      authorityUnavailable(res);
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
    if (!decoded || decoded.type !== 'refresh' || !decoded.jti) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    if (!decoded.tenant_id) {
      res.status(401).json({ error: 'Refresh token tenant is required' });
      return;
    }
    const refreshJti = decoded.jti;
    const refreshTenantId = decoded.tenant_id;
    try {
      const response = await refreshTokens.withUserSessionLock(decoded.id, async (session) => {
        // The lock also covers the replacement insert: a concurrent password reset
        // either revokes this replacement or prevents it from being issued.
        const consumed = await session.consume(refreshJti);
        if (!consumed) return { error: 'Refresh token revoked or unknown' };

        const user = await findUserById(decoded.id);
        if (!user) return { error: 'User no longer exists' };
        const membership = await findUserTenantMembership(user.id, refreshTenantId);
        if (!membership) return { error: 'Refresh token tenant is no longer authorized' };
        const authUser: AuthUser = {
          id: user.id,
          username: user.username,
          role: membership.role,
          tenantId: membership.tenantId,
        };
        return { body: await buildAuthResponse(authUser, session) };
      });
      if ('error' in response) {
        res.status(401).json({ error: response.error });
        return;
      }
      res.json(response.body);
    } catch {
      authorityUnavailable(res);
    }
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
      try {
        await refreshTokens.revoke(decoded.jti);
      } catch {
        authorityUnavailable(res);
        return;
      }
    }
    res.json({ success: true });
  });

  // ── GET /api/auth/users  (admin only) ────────────────────────────────────
  router.get('/api/auth/users', requireAuth, requireRole(), async (req: Request, res: Response) => {
    try {
      res.json({ users: await listUsers(req.user!.tenantId!) });
    } catch {
      authorityUnavailable(res);
    }
  });

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
      let targetUser;
      try {
        targetUser = await findUserById(id);
      } catch {
        authorityUnavailable(res);
        return;
      }
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!(await targetIsInPrincipalTenant(req, res, id))) return;

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

      let updated;
      try {
        updated = await updateUserRole(id, req.user!.tenantId!, parsed.data.role as UserRole);
      } catch {
        authorityUnavailable(res);
        return;
      }
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: updated });
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

      let result;
      try {
        if (!req.user!.tenantId) {
          res.status(403).json({ error: 'Tenant-bound authentication required' });
          return;
        }
        result = await createUser({ ...parsed.data, tenantId: req.user!.tenantId });
      } catch {
        authorityUnavailable(res);
        return;
      }
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
      let targetUser;
      try {
        targetUser = await findUserById(id);
      } catch {
        authorityUnavailable(res);
        return;
      }
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!(await targetIsInPrincipalTenant(req, res, id))) return;

      // AUTH-5: an actor may only assign a role at or below their own level.
      if (
        parsed.data.role !== undefined &&
        !hasRole(req.user!.role, parsed.data.role as UserRole)
      ) {
        res.status(403).json({ error: 'You cannot assign a role above your own level' });
        return;
      }

      let updated;
      try {
        updated = await updateUser(id, req.user!.tenantId!, parsed.data);
      } catch {
        authorityUnavailable(res);
        return;
      }
      if ('error' in updated) {
        res.status(409).json({ error: updated.error });
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
      if (!(await targetIsInPrincipalTenant(req, res, id))) return;

      let result;
      try {
        result = await deleteUser(id, req.user!.tenantId!);
      } catch {
        authorityUnavailable(res);
        return;
      }
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
      if (!(await targetIsInPrincipalTenant(req, res, id))) return;
      let updated;
      try {
        updated = await refreshTokens.withUserSessionLock(id, async (session) => {
          await session.revokeAllForUser(id);
          return resetUserPassword(id, parsed.data.newPassword);
        });
      } catch {
        authorityUnavailable(res);
        return;
      }
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: updated });
    },
  );

  return router;
}
