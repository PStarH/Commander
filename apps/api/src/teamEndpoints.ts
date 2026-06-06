import { Router } from 'express';
import { getWorkCoordinator, type TeamStatus, type WorkItem } from '@commander/core';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && runId.length > 0 && runId.length < 128 && RUN_ID_PATTERN.test(runId);
}

export function createTeamRouter(): Router {
  const router = Router();

  router.get('/api/teams/:runId/status', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const coord = getWorkCoordinator();
    const status: TeamStatus = coord.getTeamStatus(runId);
    res.json(status);
  });

  router.get('/api/teams/:runId/work', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const coord = getWorkCoordinator();
    const items: WorkItem[] = coord.list({ runId });
    res.json({ runId, items, total: items.length });
  });

  router.get('/api/teams/:runId/agents', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const coord = getWorkCoordinator();
    const items = coord.list({ runId });
    const byAgent = new Map<string, { claimed: number; completed: number; failed: number; pending: number; totalTokens: number }>();
    for (const it of items) {
      const agentId = it.claimedBy ?? it.parentNodeId;
      const slot = byAgent.get(agentId) ?? { claimed: 0, completed: 0, failed: 0, pending: 0, totalTokens: 0 };
      if (it.status === 'PENDING') slot.pending++;
      else if (it.status === 'CLAIMED' || it.status === 'RUNNING') slot.claimed++;
      else if (it.status === 'COMPLETED') slot.completed++;
      else if (it.status === 'FAILED') slot.failed++;
      slot.totalTokens += it.tokenBudget;
      byAgent.set(agentId, slot);
    }
    const agents = Array.from(byAgent.entries()).map(([agentId, counts]) => ({
      agentId,
      ...counts,
      currentGoal: items.find(i => (i.claimedBy ?? i.parentNodeId) === agentId && (i.status === 'CLAIMED' || i.status === 'RUNNING'))?.goal,
    }));
    res.json({ runId, agents, total: agents.length });
  });

  router.post('/api/teams/:runId/reassign', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const workId = (req.body ?? {}).workId;
    if (typeof workId !== 'string' || workId.length === 0) {
      return res.status(400).json({ error: 'workId is required' });
    }
    const coord = getWorkCoordinator();
    const reassigned = coord.reassign(workId, 'manual reassign from API');
    if (!reassigned) {
      return res.status(404).json({ error: 'Work item not found or not in reassignable state' });
    }
    res.json({ status: 'reassigned', workId });
  });

  return router;
}
