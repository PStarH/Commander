import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getApiKeyStore } from './apiKeyStore';

/**
 * Admin API key management endpoints.
 *
 * Allows admins to create and revoke programmatic API keys. Created keys are
 * returned exactly once in plaintext; only their SHA-256 hash is persisted.
 */

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required' });
    return;
  }
  next();
}

const createKeySchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(['read', 'write', 'admin'])).optional(),
});

export function createApiKeyRouter(): Router {
  const router = Router();
  const store = getApiKeyStore();

  // GET /api/admin/api-keys — list keys (no secrets)
  router.get('/api/admin/api-keys', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ keys: store.list() });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/api-keys — create a new key
  router.post('/api/admin/api-keys', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    try {
      const { record, key } = store.create(parsed.data.name, parsed.data.scopes);
      res.status(201).json({ key, record });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // DELETE /api/admin/api-keys/:id — revoke a key
  router.delete(
    '/api/admin/api-keys/:id',
    requireAuth,
    requireAdmin,
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      const revoked = store.revoke(id);
      if (!revoked) {
        res.status(404).json({ error: 'API key not found or already revoked' });
        return;
      }
      res.json({ status: 'revoked', record: revoked });
    },
  );

  return router;
}
