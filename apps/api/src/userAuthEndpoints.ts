import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { compareSync } from 'bcryptjs';
import { z } from 'zod';
import {
  findUserById,
  findUserByUsername,
  createUser,
  listUsers,
  updateUserRole,
  updateLastLogin,
  toSafeUserPublic,
  type UserRole,
  type SafeUser,
} from './userStore';
import { signAccessToken, signRefreshToken, verifyToken, type AuthUser } from './jwtMiddleware';

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
  role: z.enum(['admin', 'operator', 'viewer']),
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
 * Requires the authenticated user to have the 'admin' role.
 * Must be mounted after requireAuth.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required' });
    return;
  }
  next();
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
    if (!user || !compareSync(password, user.passwordHash)) {
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
    if (!decoded || decoded.type !== 'refresh') {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
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

  // ── GET /api/auth/users  (admin only) ────────────────────────────────────
  router.get('/api/auth/users', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json({ users: listUsers() });
  });

  // ── PUT /api/auth/users/:id/role  (admin only) ───────────────────────────
  router.put(
    '/api/auth/users/:id/role',
    requireAuth,
    requireAdmin,
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

      // Prevent an admin from demoting themselves (would lock out the last admin).
      if (req.user!.id === id && parsed.data.role !== 'admin') {
        res.status(400).json({ error: 'You cannot demote your own admin account' });
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

  return router;
}
