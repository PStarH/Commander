import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getApiKeyStore, type ApiKeyRecord } from './apiKeyStore';
import { hasRole, type UserRole } from './userStore';

/**
 * Admin API key management endpoints.
 *
 * Allows admins to create and revoke programmatic API keys. Created keys are
 * returned exactly once in plaintext; only their SHA-256 hash is persisted.
 *
 * Tenant scope (AUTH-02):
 *   - super_admin may mint/list/revoke keys for any tenant.
 *   - other admins may only operate within their JWT tenant claim
 *     (req.user.tenantId). Ambient req.tenantId / X-Tenant-ID is never used
 *     for privileged mint/list/revoke. No claim → 403 (fail-closed).
 *   - They cannot set body.tenantId to another tenant; list/revoke are
 *     filtered to their JWT tenant.
 *
 * Intentional residual — unscoped platform keys:
 *   - super_admin may omit body.tenantId; the resulting key has tenantId
 *     undefined (platform / break-glass). Tenant admins never see these keys
 *     (list filter is === principal tenant) and cannot revoke them (404).
 *   - Prefer passing an explicit tenantId for tenant-bound automation keys.
 *   - AUTH-01: login/register/refresh/OIDC access tokens always carry
 *     tenant_id via resolveAccessTenantId (COMMANDER_DEFAULT_TENANT_ID || local).
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

function isSuperAdmin(req: Request): boolean {
  return !!req.user && hasRole(req.user.role, 'super_admin');
}

/**
 * JWT tenant claim only — never ambient req.tenantId / X-Tenant-ID.
 * Privileged admin key ops must not trust client-forgable headers.
 */
function principalTenant(req: Request): string | undefined {
  const fromUser = req.user?.tenantId;
  if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
  return undefined;
}

function redactHash(record: ApiKeyRecord): Omit<ApiKeyRecord, 'hash'> {
  const { hash: _hash, ...rest } = record;
  return rest;
}

const createKeySchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(['read', 'write', 'admin'])).optional(),
  tenantId: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]{1,128}$/)
    .optional(),
});

export function createApiKeyRouter(): Router {
  const router = Router();
  const store = getApiKeyStore();

  // GET /api/admin/api-keys — list keys (no secrets); tenant-scoped for non-super_admin
  router.get('/api/admin/api-keys', requireAuth, requireRole(), (req: Request, res: Response) => {
    try {
      const all = store.list();
      if (isSuperAdmin(req)) {
        res.json({ keys: all });
        return;
      }
      const tenant = principalTenant(req);
      if (!tenant) {
        res.status(403).json({
          error: 'Tenant-bound identity required to list API keys',
        });
        return;
      }
      res.json({ keys: all.filter((k) => k.tenantId === tenant) });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/api-keys — create a new key (tenant forced for non-super_admin)
  router.post('/api/admin/api-keys', requireAuth, requireRole(), (req: Request, res: Response) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    let tenantId = parsed.data.tenantId;
    if (!isSuperAdmin(req)) {
      const principal = principalTenant(req);
      if (!principal) {
        res.status(403).json({
          error: 'Tenant-bound identity required to mint API keys',
          hint: 'Use a JWT/API key with a tenant binding, or a super_admin account.',
        });
        return;
      }
      if (tenantId && tenantId !== principal) {
        res.status(403).json({
          error: 'Cannot mint API keys for another tenant',
          hint: 'Only super_admin may set tenantId to a different tenant.',
        });
        return;
      }
      tenantId = principal;
    }

    try {
      const { record, key } = store.create(parsed.data.name, parsed.data.scopes, tenantId);
      res.status(201).json({ key, record: redactHash(record) });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // DELETE /api/admin/api-keys/:id — revoke a key (same-tenant unless super_admin)
  router.delete(
    '/api/admin/api-keys/:id',
    requireAuth,
    requireRole(),
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      // Locate first so we can enforce tenant before mutating.
      const existing = store.list().find((k) => k.id === id);
      if (!existing) {
        res.status(404).json({ error: 'API key not found or already revoked' });
        return;
      }
      if (!isSuperAdmin(req)) {
        const principal = principalTenant(req);
        if (!principal || existing.tenantId !== principal) {
          // 404 to avoid cross-tenant existence oracle
          res.status(404).json({ error: 'API key not found or already revoked' });
          return;
        }
      }
      const revoked = store.revoke(id);
      if (!revoked) {
        res.status(404).json({ error: 'API key not found or already revoked' });
        return;
      }
      res.json({ status: 'revoked', record: redactHash(revoked) });
    },
  );

  return router;
}
