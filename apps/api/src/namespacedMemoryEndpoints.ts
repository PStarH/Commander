import { Router } from 'express';
import { NamespacedMemoryStore } from './namespacedMemoryStore';

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

export function createNamespacedMemoryRouter(): Router {
  const router = Router();
  const namespacedStore = new NamespacedMemoryStore();

  router.post('/api/namespaced-memory/:namespace/write', (req, res) => {
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
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' });
    }
    // Security: Role comes from authenticated context, not request body.
    const role = getAuthenticatedRole(req);
    const result = namespacedStore.write(
      {
        namespace,
        projectId: projectId ?? 'default',
        kind: kind ?? 'SUMMARY',
        title: title ?? key,
        content: memContent ?? value,
        tags: tags ?? [],
      },
      { agentId: agentId ?? 'api', role, namespace },
    );
    if (!result) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.json({ status: 'ok', namespace, id: result.id });
  });

  router.get('/api/namespaced-memory/:namespace/read/:id', (req, res) => {
    const { namespace, id } = req.params;
    // Security: Role from authenticated context, not user-controlled query param.
    const role = getAuthenticatedRole(req);
    const agentId = (req.query.agentId as string) ?? 'api';
    const item = namespacedStore.read(id, { agentId, role, namespace });
    if (!item) {
      return res.status(404).json({ error: 'Not found or permission denied' });
    }
    res.json(item);
  });

  router.get('/api/namespaced-memory/:namespace/search', (req, res) => {
    const { namespace } = req.params;
    const q = (req.query.q as string) ?? '';
    // Security: Role from authenticated context, not user-controlled query param.
    const role = getAuthenticatedRole(req);
    const agentId = (req.query.agentId as string) ?? 'api';
    const projectId = (req.query.projectId as string) ?? 'default';
    const results = namespacedStore.search(
      { projectId, query: q, namespaces: [namespace] },
      { agentId, role, namespace },
    );
    res.json({ namespace, query: q, items: results.items, total: results.total });
  });

  router.get('/api/namespaced-memory/:namespace/stats', (req, res) => {
    const { namespace } = req.params;
    res.json(namespacedStore.getNamespaceStats(namespace));
  });

  router.get('/api/namespaced-memory/:namespace/audit', (req, res) => {
    const { namespace } = req.params;
    const limit = parseInt(req.query.limit as string) ?? 50;
    const audit = namespacedStore.getAuditLog({ namespace, limit });
    res.json({ namespace, entries: audit, count: audit.length });
  });

  router.get('/api/namespaced-memory/acl', (_req, res) => {
    res.json({ rules: namespacedStore.getACLRules() });
  });

  return router;
}
