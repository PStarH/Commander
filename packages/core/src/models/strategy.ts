import type {
  CommanderAgentCard,
  CommanderRunContextV2,
  SlimMissionCard,
  MultiAgentStrategy,
  AgentGovernanceRole,
  AgentStatus,
} from './types';

function pickSenateAgents(roster: CommanderAgentCard[], limit = 2): string[] {
  return roster
    .filter(agent => {
      return (
        agent.governanceRole === 'SENATE' &&
        (agent.status === 'READY' || agent.status === 'RUNNING')
      );
    })
    .slice(0, limit)
    .map(agent => agent.id);
}

function pickExecutorAgent(
  roster: CommanderAgentCard[],
  preferredAgentId?: string
): CommanderAgentCard | undefined {
  const preferred = preferredAgentId
    ? roster.find(agent => agent.id === preferredAgentId)
    : undefined;

  if (preferred && (preferred.status === 'READY' || preferred.status === 'RUNNING')) {
    return preferred;
  }

  return roster.find(agent => {
    return (
      agent.governanceRole === 'EXECUTOR' &&
      (agent.status === 'READY' || agent.status === 'RUNNING')
    );
  });
}

export function recommendStrategy(context: CommanderRunContextV2): MultiAgentStrategy {
  const rationale: string[] = [];

  const missionId = context.focus?.missionId ?? context.slimSnapshot.focusMission?.id;
  const focusMission = missionId
    ? context.slimSnapshot.focusMission?.id === missionId
      ? context.slimSnapshot.focusMission
      : [
          ...context.slimSnapshot.missionBoard.running,
          ...context.slimSnapshot.missionBoard.blocked,
          ...context.slimSnapshot.missionBoard.planned,
          ...context.slimSnapshot.missionBoard.done,
        ].find(mission => mission.id === missionId)
    : undefined;

  const intent = context.focus?.intent ?? 'EXECUTE';

  if (!focusMission) {
    const primary = pickExecutorAgent(context.agentRoster, context.focus?.agentId)?.id;
    rationale.push('No focus mission found; defaulting to single-agent planning.');
    return {
      kind: 'SINGLE_AGENT',
      primaryAgentId: primary,
      executorAgentIds: primary ? [primary] : [],
      reviewerAgentIds: [],
      approval: { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  const preferredExecutorId = context.focus?.agentId ?? focusMission.assignedAgentId;
  const executor = pickExecutorAgent(context.agentRoster, preferredExecutorId);
  const senate = pickSenateAgents(context.agentRoster);

  if (focusMission.governanceMode === 'MANUAL') {
    rationale.push('Mission governanceMode=MANUAL => execution must be approval-gated.');
    rationale.push(`Intent=${intent} will be treated as PROPOSE unless approved externally.`);
    return {
      kind: 'MANUAL_APPROVAL_GATE',
      primaryAgentId: executor?.id,
      executorAgentIds: executor ? [executor.id] : [],
      reviewerAgentIds: senate,
      approval: { required: true, requiredRoles: ['COMMANDER'], minApprovals: 1 },
      rationale,
    };
  }

  const highRisk = focusMission.riskLevel === 'HIGH' || focusMission.riskLevel === 'CRITICAL';
  if (focusMission.governanceMode === 'GUARDED' || highRisk) {
    rationale.push(
      focusMission.governanceMode === 'GUARDED'
        ? 'Mission governanceMode=GUARDED => pair executor with senate monitor/review.'
        : 'Mission riskLevel is HIGH/CRITICAL => guarded execution recommended.'
    );
    return {
      kind: 'GUARDED_EXECUTION',
      primaryAgentId: executor?.id,
      executorAgentIds: executor ? [executor.id] : [],
      reviewerAgentIds: senate,
      approval: { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  rationale.push('Mission governanceMode=AUTO and riskLevel LOW/MEDIUM => single-agent execution.');
  return {
    kind: 'SINGLE_AGENT',
    primaryAgentId: executor?.id,
    executorAgentIds: executor ? [executor.id] : [],
    reviewerAgentIds: [],
    approval: { required: false, requiredRoles: [], minApprovals: 0 },
    rationale,
  };
}
