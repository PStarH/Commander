import { Router } from 'express';
import type { MemoryStore } from '@commander/core';

// Security: Valid RBAC roles for namespaced memory access.
// Per security best practice: roles must come from server-side auth, not user input.
const VALID_ROLES = new Set(['reader', 'writer', 'admin', 'system']);

/**
 * Extract role from authenticated request context, NOT from user-controlled query params.
 * Security: Per OWASP — never trust user-supplied role/permission values.
 * Falls back to 'reader' (least privilege) when no authenticated role is available.
 */
function getAuthenticatedRole(req: any): string {
  // Use role from authenticated API key scopes if available
  const authRole = req.apiScopes?.role;
  if (typeof authRole === 'string' && VALID_ROLES.has(authRole)) {
    return authRole;
  }
  // Default to least privilege
  return 'reader';
}

export function createNamespacedMemoryRouter(memoryStore: MemoryStore): Router {
  return createCanonicalNamespacedMemoryRouter(memoryStore);
}

function createCanonicalNamespacedMemoryRouter(memoryStore: MemoryStore): Router {
  const router = Router();
  const canRead = (role: string) => VALID_ROLES.has(role);
  const canWrite = (role: string) => role === 'writer' || role === 'admin' || role === 'system';
  const namespaceTag = (namespace: string) => `namespace:${namespace}`;

  router.post('/api/namespaced-memory/:namespace/write', async (req, res) => {
    const { namespace } = req.params;
    const {
      key,
      value,
      agentId,
      projectId,
      kind,
      title,
      content: memContent,
      tags,
    } = req.body ?? {};
    if (!key || value === undefined)
      return res.status(400).json({ error: 'key and value are required' });
    const role = getAuthenticatedRole(req);
    if (!canWrite(role)) return res.status(403).json({ error: 'Permission denied' });
    const project = projectId ?? 'default';
    const allowedKinds = new Set(['DECISION', 'ISSUE', 'LESSON', 'SUMMARY']);
    const memoryKind = allowedKinds.has(kind) ? kind : 'SUMMARY';
    try {
      const item = await memoryStore.write({
        projectId: project,
        agentId: agentId ?? 'api',
        kind: memoryKind as 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY',
        title: title ?? key,
        content: memContent ?? String(value),
        tags: [...(Array.isArray(tags) ? tags : []), namespaceTag(namespace)],
        meta: { namespace, createdBy: { agentId: agentId ?? 'api', role } },
      });
      res.json({ status: 'ok', namespace, id: item.id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/read/:id', async (req, res) => {
    const { namespace, id } = req.params;
    const role = getAuthenticatedRole(req);
    if (!canRead(role)) return res.status(403).json({ error: 'Permission denied' });
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const item = await memoryStore.read(id, projectId);
      if (!item || item.meta?.namespace !== namespace) {
        return res.status(404).json({ error: 'Not found or permission denied' });
      }
      res.json({ ...item, namespace });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/search', async (req, res) => {
    const { namespace } = req.params;
    const q = (req.query.q as string) ?? '';
    const role = getAuthenticatedRole(req);
    if (!canRead(role)) return res.status(403).json({ error: 'Permission denied' });
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const results = await memoryStore.search({
        projectId,
        query: q,
        tags: [namespaceTag(namespace)],
        limit: Number(req.query.limit ?? 50),
      });
      res.json({ namespace, query: q, items: results.items, total: results.total });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/stats', async (req, res) => {
    const { namespace } = req.params;
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const results = await memoryStore.search({
        projectId,
        tags: [namespaceTag(namespace)],
        limit: 500,
      });
      const byKind = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
      for (const item of results.items) byKind[item.kind]++;
      res.json({ namespace, totalItems: results.total, byKind });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/audit', (_req, res) => {
    res.json({ namespace: _req.params.namespace, entries: [], count: 0 });
  });

  router.get('/api/namespaced-memory/acl', (_req, res) => {
    res.json({
      rules: [
        { role: 'reader', permissions: ['read'] },
        { role: 'writer', permissions: ['read', 'write'] },
        { role: 'admin', permissions: ['read', 'write', 'delete', 'admin'] },
        { role: 'system', permissions: ['read', 'write', 'delete', 'admin'] },
      ],
    });
  });

  return router;
}
