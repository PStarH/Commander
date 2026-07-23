import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { MemoryIndexManager } from './memoryIndexManager';
import { canAccessProject } from './projectEndpoints';
import type { IWarRoomStore } from './store';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function createMemoryIndexRouter(
  memoryIndexManager: MemoryIndexManager,
  projectStore: IWarRoomStore,
): Router {
  const router = Router();
  const projectManagers = new Map<string, MemoryIndexManager>();

  const managerForRequest = (req: Request, res: Response): MemoryIndexManager | undefined => {
    const projectId = req.params.projectId;
    if (typeof projectId !== 'string') {
      res.status(404).json({ error: 'Project not found' });
      return undefined;
    }
    const snapshot = projectStore.getProjectSnapshot(projectId);
    if (!snapshot || !canAccessProject(req, snapshot.project)) {
      res.status(404).json({ error: 'Project not found' });
      return undefined;
    }

    const existing = projectManagers.get(projectId);
    if (existing) return existing;
    const manager = memoryIndexManager.forProject(projectId);
    projectManagers.set(projectId, manager);
    return manager;
  };

  router.use(requireAuth);

  router.get('/projects/:projectId/memory-index/domains', (req, res) => {
    const manager = managerForRequest(req, res);
    if (!manager) return;
    res.json(manager.listDomains());
  });

  router.post('/projects/:projectId/memory-index/domains', (req, res) => {
    const manager = managerForRequest(req, res);
    if (!manager) return;
    const { domain, description } = req.body as { domain?: string; description?: string };
    if (!domain?.trim()) {
      return res.status(400).json({ error: 'domain is required' });
    }
    const pointer = manager.addDomain(domain.trim(), description?.trim() || '');
    res.status(201).json(pointer);
  });

  router.get('/projects/:projectId/memory-index/domains/:domain', async (req, res) => {
    const manager = managerForRequest(req, res);
    if (!manager) return;
    const domainMemory = await manager.readDomain(req.params.domain);
    if (!domainMemory) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    res.json(domainMemory);
  });

  router.post('/projects/:projectId/memory-index/domains/:domain/entries', async (req, res) => {
    const manager = managerForRequest(req, res);
    if (!manager) return;
    const { type, title, content, tags } = req.body as {
      type?: string;
      title?: string;
      content?: string;
      tags?: string[];
    };
    if (!type || !title?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'type, title, and content are required' });
    }
    const entry = await manager.writeEntry(req.params.domain, {
      type: type as 'decision' | 'context' | 'pattern' | 'preference' | 'issue' | 'lesson',
      title: title.trim(),
      content: content.trim(),
      tags: tags ?? [],
    });
    if (!entry) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    res.status(201).json(entry);
  });

  router.post('/projects/:projectId/memory-index/reconcile', async (req, res) => {
    const manager = managerForRequest(req, res);
    if (!manager) return;
    const result = await manager.reconcile();
    res.json({ reconciled: true, ...result });
  });

  return router;
}
