import { Router } from 'express';
import { NamespacedMemoryStore } from './namespacedMemoryStore';

export function createNamespacedMemoryRouter(): Router {
  const router = Router();
  const namespacedStore = new NamespacedMemoryStore();

  router.post('/api/namespaced-memory/:namespace/write', (req, res) => {
    const { namespace } = req.params;
    const { key, value, role, agentId, projectId, kind, title, content: memContent, tags } = req.body ?? {};
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' });
    }
    const result = namespacedStore.write(
      { namespace, projectId: projectId ?? 'default', kind: kind ?? 'SUMMARY', title: title ?? key, content: memContent ?? value, tags: tags ?? [] },
      { agentId: agentId ?? 'api', role: role ?? 'system', namespace },
    );
    if (!result) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.json({ status: 'ok', namespace, id: result.id });
  });

  router.get('/api/namespaced-memory/:namespace/read/:id', (req, res) => {
    const { namespace, id } = req.params;
    const role = (req.query.role as string) ?? 'reader';
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
    const role = (req.query.role as string) ?? 'reader';
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
