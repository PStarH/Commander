import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OIDCAuthPlugin, createOIDCPluginFromEnv, type AuthRole } from '@commander/core';
import {
  findUserByEmail,
  createUser,
  updateLastLogin,
  updateUser,
  toSafeUserPublic,
  hasRole,
  type UserRole,
} from './userStore';
import { signAccessToken, signRefreshToken } from './jwtMiddleware';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

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
 * Validate OIDC issuer: must be https URL; optional host allowlist via
 * OIDC_ISSUER_HOST_ALLOWLIST (comma-separated).
 */
export function validateOidcIssuer(issuer: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'issuer must be a valid URL';
  }
  if (url.protocol !== 'https:') {
    return 'issuer must use https';
  }
  const allowlist =
    process.env.OIDC_ISSUER_HOST_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (allowlist.length > 0 && !allowlist.includes(url.hostname)) {
    return 'issuer hostname must be one of: ' + allowlist.join(', ');
  }
  return undefined;
}

// ============================================================================
// OIDC Configuration persistence
// ============================================================================

const CONFIG_DIR = path.resolve(process.cwd(), '.commander');
const CONFIG_FILE = path.join(CONFIG_DIR, 'oidc-config.json');

export interface OIDCRuntimeConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  roleClaim: string;
  adminRoles: string[];
  operatorRoles: string[];
  redirectUri: string;
}

function loadConfigFromFile(): Partial<OIDCRuntimeConfig> | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Partial<OIDCRuntimeConfig>;
  } catch (err) {
    process.stderr.write(
      '[oidcAuthEndpoints] Failed to read ' + CONFIG_FILE + ': ' + String(err) + '\n',
    );
    return null;
  }
}

function saveConfigToFile(config: OIDCRuntimeConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(
      '[oidcAuthEndpoints] Failed to write ' + CONFIG_FILE + ': ' + String(err) + '\n',
    );
  }
}

function buildWebOrigin(): string {
  const webPort = process.env.WEB_PORT ?? '5173';
  return process.env.WEB_ORIGIN ?? 'http://localhost:' + webPort;
}

/**
 * Resolve effective OIDC configuration. Environment variables take precedence
 * over the persisted file, so operators can override settings without touching
 * the UI-managed config.
 */
export function getOIDCConfig(): OIDCRuntimeConfig | null {
  const envPlugin = createOIDCPluginFromEnv();
  const file = loadConfigFromFile();
  const effective = file ?? {};

  const issuer = process.env.OIDC_ISSUER ?? effective.issuer;
  const clientId = process.env.OIDC_CLIENT_ID ?? effective.clientId;
  if (!issuer || !clientId) return null;

  return {
    enabled:
      process.env.OIDC_ENABLED === 'true'
        ? true
        : process.env.OIDC_ENABLED === 'false'
          ? false
          : (effective.enabled ?? true),
    issuer,
    clientId,
    roleClaim: process.env.OIDC_ROLE_CLAIM ?? effective.roleClaim ?? 'roles',
    adminRoles: process.env.OIDC_ADMIN_ROLES
      ? process.env.OIDC_ADMIN_ROLES.split(',').map((s) => s.trim())
      : (effective.adminRoles ?? ['admin']),
    operatorRoles: process.env.OIDC_OPERATOR_ROLES
      ? process.env.OIDC_OPERATOR_ROLES.split(',').map((s) => s.trim())
      : (effective.operatorRoles ?? ['operator', 'developer']),
    redirectUri: effective.redirectUri ?? buildWebOrigin() + '/login',
  };
}

function buildPublicConfig(config: OIDCRuntimeConfig) {
  return {
    enabled: config.enabled,
    issuer: config.issuer,
    clientId: config.clientId,
    roleClaim: config.roleClaim,
    adminRoles: config.adminRoles,
    operatorRoles: config.operatorRoles,
    redirectUri: config.redirectUri,
  };
}

// ============================================================================
// Validation schemas
// ============================================================================

const exchangeSchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  issuer: z
    .string()
    .url()
    .max(512)
    .superRefine((issuer, ctx) => {
      const err = validateOidcIssuer(issuer);
      if (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      }
    }),
  clientId: z.string().min(1).max(512),
  roleClaim: z.string().min(1).max(128).default('roles'),
  adminRoles: z.array(z.string().min(1)).default(['admin']),
  operatorRoles: z.array(z.string().min(1)).default(['operator', 'developer']),
  redirectUri: z.string().min(1).max(512),
});

// ============================================================================
// Router
// ============================================================================

export function createOIDCAuthRouter(): Router {
  const router = Router();

  /**
   * GET /api/auth/oidc/config
   *
   * Public endpoint that advertises whether OIDC SSO is enabled and the
   * non-sensitive provider details the UI needs to initiate login.
   */
  router.get('/api/auth/oidc/config', (_req: Request, res: Response) => {
    const config = getOIDCConfig();
    if (!config) {
      res.json({ enabled: false, issuer: null, clientId: null, redirectUri: null });
      return;
    }
    res.json(buildPublicConfig(config));
  });

  /**
   * POST /api/auth/oidc/exchange
   *
   * Exchanges a verified OIDC ID token for Commander JWT credentials.
   * Creates a local account on first login if the email does not exist.
   */
  router.post('/api/auth/oidc/exchange', async (req: Request, res: Response) => {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.issues });
      return;
    }

    const config = getOIDCConfig();
    if (!config || !config.enabled) {
      res.status(400).json({ error: 'OIDC is not configured or disabled' });
      return;
    }

    const plugin = new OIDCAuthPlugin({
      issuer: config.issuer,
      clientId: config.clientId,
      roleClaim: config.roleClaim,
      adminRoles: config.adminRoles,
      operatorRoles: config.operatorRoles,
    });

    let result;
    try {
      result = await plugin.authenticate(parsed.data.idToken);
    } catch (err) {
      process.stderr.write(
        '[oidcAuthEndpoints] OIDC exchange error: ' + String(err) + '\n',
      );
      res.status(401).json({ error: 'OIDC token validation failed' });
      return;
    }

    if (!result) {
      res.status(401).json({ error: 'Invalid OIDC token' });
      return;
    }

    // Find or provision a local user. The local account stores the OIDC email
    // so future logins map to the same user record.
    let localUser = findUserByEmail(result.username);
    if (!localUser) {
      const created = createUser({
        username: result.username,
        email: result.username,
        // Random local password; authentication always happens via OIDC.
        password: randomUUID(),
        role: result.role as UserRole,
      });
      if ('error' in created) {
        res.status(409).json({ error: created.error });
        return;
      }
      localUser = findUserByEmail(result.username);
    } else {
      // If the OIDC provider changed the user's role, keep it in sync.
      if (localUser.role !== result.role) {
        updateUser(localUser.id, { role: result.role as UserRole });
        localUser = findUserByEmail(result.username);
      }
    }

    if (!localUser) {
      res.status(500).json({ error: 'Failed to resolve local user' });
      return;
    }

    updateLastLogin(localUser.id);

    const authUser = {
      id: localUser.id,
      username: localUser.username,
      role: localUser.role as AuthRole,
    };

    res.json({
      token: signAccessToken(authUser),
      refreshToken: signRefreshToken(authUser),
      user: toSafeUserPublic(localUser),
    });
  });

  /**
   * GET /api/auth/oidc/settings
   *
   * Returns the persisted OIDC configuration (admin only).
   */
  router.get(
    '/api/auth/oidc/settings',
    requireAuth,
    requireRole('admin'),
    (_req: Request, res: Response) => {
      const config = getOIDCConfig();
      if (!config) {
        res.json({
          enabled: false,
          issuer: '',
          clientId: '',
          roleClaim: 'roles',
          adminRoles: ['admin'],
          operatorRoles: ['operator', 'developer'],
          redirectUri: buildWebOrigin() + '/login',
        });
        return;
      }
      res.json(buildPublicConfig(config));
    },
  );

  /**
   * PUT /api/auth/oidc/settings
   *
   * Persists OIDC configuration from the admin UI. Environment variables still
   * take precedence at runtime, but the saved file is used when env vars are
   * not set.
   */
  router.put(
    '/api/auth/oidc/settings',
    requireAuth,
    requireRole('admin'),
    (req: Request, res: Response) => {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', details: parsed.error.issues });
        return;
      }

      const toSave = { ...parsed.data };
      // Env is authoritative for adminRoles when set.
      if (process.env.OIDC_ADMIN_ROLES) {
        toSave.adminRoles = process.env.OIDC_ADMIN_ROLES.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      saveConfigToFile(toSave);
      res.json({ status: 'saved', config: buildPublicConfig(toSave) });
    },
  );

  return router;
}
