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
  type UserRole,
  type SafeUser,
} from './userStore';
import { signAccessToken, signRefreshToken, verifyToken, type AuthUser } from './jwtMiddleware';
import {
  consume as consumeRefreshJti,
  revoke as revokeRefreshJti,
} from './refreshTokenStore';

/**
 * AUTH-6: a real bcrypt hash used only to spend comparable CPU on the
 * user-not-found login path, defeating timing-based username enumeration.
 * Computed once at module load (of a value no user can hold) so its work factor
 * matches the real comparison; it is never a valid credential.
 */
const DUMMY_PASSWORD_HASH = hashSync(`invalid:${process.pid}:no-such-user`, 10);

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

// ── Response helpers ────────────────────────────────────────────────────────

interface AuthResponseBody {
  token: string;
  refreshToken: string;
  user: SafeUser;
}

function buildAuthResponse(user: AuthUser): AuthResponseBody {
  // Look up the fresh user record so lastLoginAt / createdAt are current.
  const full = findUserById(user.id);
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
    refreshToken: signRefreshToken(user),
    user: safeUser,
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

export function createUserAuthRouter(): Router {
  const router = Router();

  // ── POST /api/auth/register ──────────────────────────────────────────────
  router.post('/api/auth/register', (req: Request, res: Response) => {
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
    const result = createUser({ username, email, password, role: 'viewer' });
    if ('error' in result) {
      res.status(409).json({ error: result.error });
      return;
    }

    const authUser: AuthUser = {
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
    };
    updateLastLogin(result.user.id);
    res.status(201).json(buildAuthResponse(authUser));
  });

  // ── POST /api/auth/login ─────────────────────────────────────────────────
  router.post('/api/auth/login', (req: Request, res: Response) => {
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
    const user = findUserByUsername(username);
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

    const authUser: AuthUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    updateLastLogin(user.id);
    res.json(buildAuthResponse(authUser));
  });

  // ── GET /api/auth/me ─────────────────────────────────────────────────────
  router.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
    const user = findUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: toSafeUserPublic(user) });
  });

  // ── POST /api/auth/refresh ───────────────────────────────────────────────
  // Rotates refresh tokens: validate jti → revoke old → mint new pair.
  router.post('/api/auth/refresh', (req: Request, res: Response) => {
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

    // Atomic consume: first concurrent refresh wins; replay / race → 401.
    if (!consumeRefreshJti(decoded.jti)) {
      res.status(401).json({ error: 'Refresh token revoked or unknown' });
      return;
    }

    // Ensure the user still exists (account may have been removed).
    const user = findUserById(decoded.id);
    if (!user) {
      res.status(401).json({ error: 'User no longer exists' });
      return;
    }

    const authUser: AuthUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    res.json(buildAuthResponse(authUser));
  });

  // ── POST /api/auth/logout ────────────────────────────────────────────────
  // Revokes the presented refresh jti (access token TTL still applies).
  router.post('/api/auth/logout', (req: Request, res: Response) => {
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
      revokeRefreshJti(decoded.jti);
    }
    res.json({ success: true });
  });

  // ── GET /api/auth/users  (admin only) ────────────────────────────────────
  router.get('/api/auth/users', requireAuth, requireRole(), (_req: Request, res: Response) => {
    res.json({ users: listUsers() });
  });

  // ── PUT /api/auth/users/:id/role  (admin only) ───────────────────────────
  router.put(
    '/api/auth/users/:id/role',
    requireAuth,
    requireRole(),
    (req: Request, res: Response) => {
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
      const targetUser = findUserById(id);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
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

      const updated = updateUserRole(id, parsed.data.role as UserRole);
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: updated });
    },
  );

  // ── POST /api/auth/users  (admin only) ───────────────────────────────────
  router.post('/api/auth/users', requireAuth, requireRole(), (req: Request, res: Response) => {
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
    if (parsed.data.role !== undefined && !hasRole(req.user!.role, parsed.data.role as UserRole)) {
      res.status(403).json({ error: 'You cannot create a user with a role above your own level' });
      return;
    }

    const result = createUser(parsed.data);
    if ('error' in result) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.status(201).json({ user: result.user });
  });

  // ── PATCH /api/auth/users/:id  (admin only) ───────────────────────────────
  router.patch('/api/auth/users/:id', requireAuth, requireRole(), (req: Request, res: Response) => {
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
    const targetUser = findUserById(id);
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Prevent removing admin role from the last admin.
    if (
      parsed.data.role !== undefined &&
      !hasRole(parsed.data.role, 'admin') &&
      targetUser.role === 'admin' &&
      countAdmins() <= 1
    ) {
      res.status(400).json({ error: 'Cannot demote the last admin account' });
      return;
    }

    // AUTH-5: an actor may only assign a role at or below their own level.
    if (parsed.data.role !== undefined && !hasRole(req.user!.role, parsed.data.role as UserRole)) {
      res.status(403).json({ error: 'You cannot assign a role above your own level' });
      return;
    }

    const updated = updateUser(id, parsed.data);
    if ('error' in updated) {
      res.status(409).json({ error: updated.error });
      return;
    }
    res.json({ user: updated });
  });

  // ── DELETE /api/auth/users/:id  (admin only) ──────────────────────────────
  router.delete(
    '/api/auth/users/:id',
    requireAuth,
    requireRole(),
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      if (req.user!.id === id) {
        res.status(400).json({ error: 'You cannot delete your own account' });
        return;
      }

      const result = deleteUser(id);
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
    (req: Request, res: Response) => {
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
      const updated = resetUserPassword(id, parsed.data.newPassword);
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: updated });
    },
  );

  return router;
}
