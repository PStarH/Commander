import { Router } from 'express';
import type { MemoryIndexManager } from './memoryIndexManager';

export function createMemoryIndexRouter(memoryIndexManager: MemoryIndexManager): Router {
  const router = Router();

  router.get('/projects/:projectId/memory-index/domains', (_req, res) => {
    res.json(memoryIndexManager.listDomains());
  });

  router.post('/projects/:projectId/memory-index/domains', (req, res) => {
    const { domain, description } = req.body as { domain?: string; description?: string };
    if (!domain?.trim()) {
      return res.status(400).json({ error: 'domain is required' });
    }
    const pointer = memoryIndexManager.addDomain(domain.trim(), description?.trim() || '');
    res.status(201).json(pointer);
  });

  router.get('/projects/:projectId/memory-index/domains/:domain', (req, res) => {
    const domainMemory = memoryIndexManager.readDomain(req.params.domain);
    if (!domainMemory) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    res.json(domainMemory);
  });

  router.post('/projects/:projectId/memory-index/domains/:domain/entries', async (req, res) => {
    const { type, title, content, tags } = req.body as {
      type?: string;
      title?: string;
      content?: string;
      tags?: string[];
    };
    if (!type || !title?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'type, title, and content are required' });
    }
    const entry = await memoryIndexManager.writeEntry(req.params.domain, {
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

  router.post('/projects/:projectId/memory-index/reconcile', (_req, res) => {
    const result = memoryIndexManager.reconcile();
    res.json({ reconciled: true, ...result });
  });

  return router;
}
