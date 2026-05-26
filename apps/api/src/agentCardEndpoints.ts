import { Router } from 'express';
import { AgentCardRegistry } from './agentCard';

export function createAgentCardRouter(registry?: AgentCardRegistry): Router {
  const router = Router();
  const reg = registry ?? new AgentCardRegistry();

  router.get('/agent-cards', (_req, res) => {
    res.json(reg.listAll());
  });

  router.get('/agent-cards/:id', (req, res) => {
    const card = reg.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Agent card not found' });
    res.json(card);
  });

  router.post('/agent-cards', (req, res) => {
    const card = req.body;
    if (!card?.id || !card?.name) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    reg.register(card);
    res.status(201).json(card);
  });

  return router;
}
