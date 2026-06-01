import { Router } from 'express';
import type { IWarRoomStore } from './store';
import type { ConfidenceReporter, ConfidenceReport, ConfidenceAlert } from './confidenceReporter';
import { DEFAULT_THRESHOLDS } from './confidenceReporter';

export function createConfidenceRouter(store: IWarRoomStore, confidenceReporter: ConfidenceReporter): Router {
  const router = Router();

  router.get('/projects/:projectId/missions/:missionId/confidence', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const mission = snapshot.missions.find(m => m.id === req.params.missionId);
    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }
    const report: ConfidenceReport = confidenceReporter.generateMissionReport(req.params.missionId);
    res.json(report);
  });

  router.get('/projects/:projectId/agents/:agentId/confidence', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const agent = snapshot.agents.find(a => a.agentId === req.params.agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const { missionId } = req.query;
    const report: ConfidenceReport = confidenceReporter.generateAgentReport(
      req.params.projectId,
      req.params.agentId,
      missionId as string | undefined,
    );
    res.json(report);
  });

  router.get('/projects/:projectId/missions/:missionId/confidence/alerts', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const mission = snapshot.missions.find(m => m.id === req.params.missionId);
    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }
    const alerts: ConfidenceAlert[] = confidenceReporter.checkForAlerts(req.params.missionId);
    res.json({
      missionId: req.params.missionId,
      alertCount: alerts.length,
      thresholds: DEFAULT_THRESHOLDS,
      alerts,
    });
  });

  router.get('/api/confidence/thresholds', (_req, res) => {
    res.json({
      thresholds: DEFAULT_THRESHOLDS,
      description: {
        low: 'Below this threshold = critical alert, requires immediate review',
        warning: 'Below this threshold = warning, may need validation',
        target: 'Target confidence level for optimal decisions',
      },
    });
  });

  return router;
}
