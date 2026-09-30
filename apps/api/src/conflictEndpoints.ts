import { Router } from 'express';
import type { Request } from 'express';
import type { IWarRoomStore } from './store';
import {
  proactiveConflictCheck,
  reactiveConflictMonitor,
  formatConflictSummary,
  Agent as ConflictAgent,
  ProposedAction,
} from './conflictDetection';
import { canAccessProject } from './projectEndpoints';

/**
 * AUDIT api-remaining#L7 (LM-20): all three conflict entry points read project
 * agents/missions straight out of the WarRoom snapshot after checking only that
 * the project *exists*. That made the whole conflict surface a cross-tenant /
 * cross-owner read primitive: any authenticated principal could enumerate
 * another tenant's agents, mission ids, workloads and governance modes.
 *
 * The three handlers now share one resolution helper so they cannot drift apart
 * again. It reuses the same `canAccessProject` predicate the project router
 * uses (no second role model) and deliberately collapses "no such project" and
 * "not yours" into the same 404 so the response does not disclose existence.
 */
function resolveAccessibleSnapshot(
  store: IWarRoomStore,
  req: Request,
  projectId: string,
): ReturnType<IWarRoomStore['getProjectSnapshot']> | undefined {
  const snapshot = store.getProjectSnapshot(projectId);
  if (!snapshot) return undefined;
  if (!canAccessProject(req, (snapshot as { project?: unknown }).project)) return undefined;
  return snapshot;
}

export function createConflictRouter(store: IWarRoomStore): Router {
  const router = Router();

  router.post('/projects/:projectId/conflict-detection/proactive', (req, res) => {
    const snapshot = resolveAccessibleSnapshot(store, req, req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { agentId, proposedAction } = req.body as {
      agentId: string;
      proposedAction: ProposedAction;
    };

    if (!agentId || !proposedAction) {
      return res.status(400).json({ error: 'agentId and proposedAction are required' });
    }

    const agent = snapshot.agents.find((a) => a.agentId === agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const conflictAgent: ConflictAgent = {
      id: agent.agentId,
      name: agent.agentName,
      role: agent.status,
      specialties: agent.specialty ? [agent.specialty] : undefined,
      currentTaskId: snapshot.missions.find((m) => m.assignedAgentId === agentId)?.id,
    };

    const otherAgents: ConflictAgent[] = snapshot.agents
      .filter((a) => a.agentId !== agentId)
      .map((a) => ({
        id: a.agentId,
        name: a.agentName,
        role: a.status,
        specialties: a.specialty ? [a.specialty] : undefined,
      }));

    const result = proactiveConflictCheck(conflictAgent, proposedAction, {
      otherAgents,
      activeMissions: snapshot.missions.map((m) => ({
        id: m.id,
        assignedAgentId: m.assignedAgentId,
        priority: m.priority,
      })),
      governanceMode: snapshot.missions.find((m) => m.assignedAgentId === agentId)
        ?.governanceMode as 'AUTO' | 'GUARDED' | 'MANUAL' | undefined,
    });

    res.json(result);
  });

  router.post('/projects/:projectId/conflict-detection/reactive', (req, res) => {
    const snapshot = resolveAccessibleSnapshot(store, req, req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { recentActions } = req.body as {
      recentActions?: ProposedAction[];
    };

    if (!recentActions || !Array.isArray(recentActions)) {
      return res.status(400).json({ error: 'recentActions array is required' });
    }

    const agents: ConflictAgent[] = snapshot.agents.map((a) => ({
      id: a.agentId,
      name: a.agentName,
      role: a.status,
      specialties: a.specialty ? [a.specialty] : undefined,
    }));

    const conflicts = reactiveConflictMonitor(agents, recentActions);

    res.json({
      conflicts,
      summary: conflicts.map(formatConflictSummary),
    });
  });

  router.get('/projects/:projectId/conflict-detection/summary', (req, res) => {
    const snapshot = resolveAccessibleSnapshot(store, req, req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const agentWorkloads = new Map<string, number>();
    for (const mission of snapshot.missions) {
      if (mission.status === 'RUNNING' || mission.status === 'PLANNED') {
        const count = agentWorkloads.get(mission.assignedAgentId) || 0;
        agentWorkloads.set(mission.assignedAgentId, count + 1);
      }
    }

    const potentialConflicts: Array<{ type: string; description: string; severity: string }> = [];

    for (const [agentId, count] of agentWorkloads) {
      if (count > 3) {
        potentialConflicts.push({
          type: 'RESOURCE',
          description: `Agent ${agentId} has ${count} active missions - potential bottleneck`,
          severity: count > 5 ? 'high' : 'medium',
        });
      }
    }

    const highPriorityMissions = snapshot.missions.filter(
      (m) => m.priority === 'HIGH' || m.priority === 'CRITICAL',
    );
    if (highPriorityMissions.length > 3) {
      potentialConflicts.push({
        type: 'GOAL',
        description: `${highPriorityMissions.length} high/critical priority missions - resource contention likely`,
        severity: 'medium',
      });
    }

    const manualMissions = snapshot.missions.filter(
      (m) => m.governanceMode === 'MANUAL' && m.status === 'RUNNING',
    );
    if (manualMissions.length > 2) {
      potentialConflicts.push({
        type: 'POLICY',
        description: `${manualMissions.length} MANUAL governance missions running - approval bottleneck risk`,
        severity: 'low',
      });
    }

    res.json({
      agentWorkloads: Object.fromEntries(agentWorkloads),
      potentialConflicts,
      recommendations:
        potentialConflicts.length > 0
          ? [
              'Consider redistributing workload among agents',
              'Review mission priorities',
              'Evaluate governance mode settings',
            ]
          : ['No immediate conflict risks detected'],
    });
  });

  return router;
}
