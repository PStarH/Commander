import type {
  Project,
  Agent,
  Mission,
  ExecutionLog,
  WarRoomData,
  ProjectWarRoomSnapshot,
  SlimSnapshot,
  SlimMissionCard,
  SlimLogLine,
  CreateSlimSnapshotOptions,
  ProjectBattleReport,
  MissionStatus,
  MissionPriority,
} from './types';

const missionPriorityWeight: Record<MissionPriority, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const missionStatusWeight: Record<MissionStatus, number> = {
  BLOCKED: 4,
  RUNNING: 3,
  PLANNED: 2,
  DONE: 1,
};

/**
 * Creates a token-efficient slim snapshot from a full project snapshot.
 */
export function createSlimSnapshot(
  snapshot: ProjectWarRoomSnapshot,
  options: CreateSlimSnapshotOptions,
): SlimSnapshot {
  const maxMissionsPerBucket = options.maxMissionsPerBucket ?? 6;
  const maxLogs = options.maxLogs ?? 8;

  const toMissionCard = (m: Mission): SlimMissionCard => ({
    id: m.id,
    title: m.title,
    objective: m.objective,
    status: m.status,
    priority: m.priority,
    riskLevel: m.riskLevel,
    governanceMode: m.governanceMode,
    assignedAgentId: m.assignedAgentId,
    updatedAt: m.updatedAt,
  });

  const toLogLine = (l: ExecutionLog): SlimLogLine => ({
    id: l.id,
    level: l.level,
    message: l.message,
    createdAt: l.createdAt,
    missionId: l.missionId,
    agentId: l.agentId,
  });

  const running = snapshot.missions
    .filter((m) => m.status === 'RUNNING')
    .slice(0, maxMissionsPerBucket);
  const blocked = snapshot.missions
    .filter((m) => m.status === 'BLOCKED')
    .slice(0, maxMissionsPerBucket);
  const planned = snapshot.missions
    .filter((m) => m.status === 'PLANNED')
    .slice(0, maxMissionsPerBucket);
  const done = snapshot.missions.filter((m) => m.status === 'DONE').slice(0, maxMissionsPerBucket);

  const focusMission = options.focusMissionId
    ? snapshot.missions.find((m) => m.id === options.focusMissionId)
    : undefined;

  return {
    project: {
      id: snapshot.project.id,
      codename: snapshot.project.codename,
      objective: snapshot.project.objective,
      status: snapshot.project.status,
      updatedAt: snapshot.project.updatedAt,
    },
    focusMission: focusMission ? toMissionCard(focusMission) : undefined,
    missionBoard: {
      running: running.map(toMissionCard),
      blocked: blocked.map(toMissionCard),
      planned: planned.map(toMissionCard),
      done: done.map(toMissionCard),
    },
    battleMetrics: {
      health: snapshot.battleReport.health,
      runningMissionCount: snapshot.battleReport.runningMissionCount,
      blockedMissionCount: snapshot.battleReport.blockedMissionCount,
      completedMissionCount: snapshot.battleReport.completedMissionCount,
      highRiskMissionCount: snapshot.battleReport.highRiskMissionCount,
      manualGovernanceMissionCount: snapshot.battleReport.manualGovernanceMissionCount,
      logVolume24h: snapshot.battleReport.logVolume24h,
      completionRate: snapshot.battleReport.completionRate,
    },
    latestLogs: snapshot.latestLogs.slice(0, maxLogs).map(toLogLine),
  };
}

export function createSeedWarRoomData(now = new Date()): WarRoomData {
  const createdAt = now.toISOString();
  const oneHour = 60 * 60 * 1000;

  const project: Project = {
    id: 'project-war-room',
    name: 'Agent War Room',
    codename: 'Operation Glassboard',
    objective:
      'Ship the first AI teammate command center where humans direct agents, watch execution in real time, and publish battle reports.',
    status: 'ACTIVE',
    createdAt,
    updatedAt: createdAt,
  };

  const agents: Agent[] = [
    {
      id: 'agent-scout',
      projectId: project.id,
      name: 'Scout',
      callsign: 'INTEL-7',
      role: 'Research Strategist',
      model: 'gpt-4.1',
      status: 'RUNNING',
      specialty: 'Requirement digestion and signal gathering',
      governanceRole: 'SENATE',
      lastHeartbeatAt: new Date(now.getTime() - oneHour / 2).toISOString(),
    },
    {
      id: 'agent-builder',
      projectId: project.id,
      name: 'Builder',
      callsign: 'STACK-3',
      role: 'Implementation Operator',
      model: 'gpt-4.1-mini',
      status: 'READY',
      specialty: 'API and UI delivery across the monorepo',
      governanceRole: 'EXECUTOR',
      lastHeartbeatAt: new Date(now.getTime() - oneHour).toISOString(),
    },
    {
      id: 'agent-sentinel',
      projectId: project.id,
      name: 'Sentinel',
      callsign: 'WATCH-2',
      role: 'QA and Risk Monitor',
      model: 'o4-mini',
      status: 'BLOCKED',
      specialty: 'Execution verification and release risk review',
      governanceRole: 'SENATE',
      lastHeartbeatAt: new Date(now.getTime() - oneHour * 3).toISOString(),
    },
  ];

  const missions: Mission[] = [
    {
      id: 'mission-command-brief',
      projectId: project.id,
      title: 'Define command schema for projects, agents, and missions',
      objective: 'Lock the vertical-slice domain model before the API and dashboard diverge.',
      status: 'DONE',
      priority: 'HIGH',
      riskLevel: 'MEDIUM',
      governanceMode: 'GUARDED',
      assignedAgentId: 'agent-scout',
      createdAt: new Date(now.getTime() - oneHour * 18).toISOString(),
      updatedAt: new Date(now.getTime() - oneHour * 12).toISOString(),
      startedAt: new Date(now.getTime() - oneHour * 17).toISOString(),
      completedAt: new Date(now.getTime() - oneHour * 12).toISOString(),
    },
    {
      id: 'mission-api-spine',
      projectId: project.id,
      title: 'Stand up mission persistence and control endpoints',
      objective:
        'Persist one project with agents, missions, and logs so the war room survives refreshes.',
      status: 'RUNNING',
      priority: 'CRITICAL',
      riskLevel: 'HIGH',
      governanceMode: 'MANUAL',
      assignedAgentId: 'agent-builder',
      createdAt: new Date(now.getTime() - oneHour * 8).toISOString(),
      updatedAt: new Date(now.getTime() - oneHour * 2).toISOString(),
      startedAt: new Date(now.getTime() - oneHour * 7).toISOString(),
    },
    {
      id: 'mission-dashboard',
      projectId: project.id,
      title: 'Render dashboard for operators',
      objective: 'Show agents, mission board, and execution feed on a single page.',
      status: 'RUNNING',
      priority: 'HIGH',
      riskLevel: 'MEDIUM',
      governanceMode: 'GUARDED',
      assignedAgentId: 'agent-scout',
      createdAt: new Date(now.getTime() - oneHour * 6).toISOString(),
      updatedAt: new Date(now.getTime() - oneHour * 1.5).toISOString(),
      startedAt: new Date(now.getTime() - oneHour * 5).toISOString(),
    },
    {
      id: 'mission-release-gate',
      projectId: project.id,
      title: 'Verify build and expose remaining release blockers',
      objective: 'Catch missing tooling and surface TODOs before demo time.',
      status: 'BLOCKED',
      priority: 'MEDIUM',
      riskLevel: 'HIGH',
      governanceMode: 'GUARDED',
      assignedAgentId: 'agent-sentinel',
      createdAt: new Date(now.getTime() - oneHour * 4).toISOString(),
      updatedAt: new Date(now.getTime() - oneHour * 1.2).toISOString(),
      startedAt: new Date(now.getTime() - oneHour * 3).toISOString(),
    },
  ];

  const logs: ExecutionLog[] = [
    {
      id: 'log-1',
      projectId: project.id,
      missionId: 'mission-command-brief',
      agentId: 'agent-scout',
      level: 'SUCCESS',
      message: 'Mapped the initial data model for project, mission, agent, and battle report.',
      createdAt: new Date(now.getTime() - oneHour * 12).toISOString(),
    },
    {
      id: 'log-2',
      projectId: project.id,
      missionId: 'mission-api-spine',
      agentId: 'agent-builder',
      level: 'INFO',
      message: 'Preparing file-backed persistence so state survives server restarts.',
      createdAt: new Date(now.getTime() - oneHour * 2).toISOString(),
    },
    {
      id: 'log-3',
      projectId: project.id,
      missionId: 'mission-dashboard',
      agentId: 'agent-scout',
      level: 'INFO',
      message: 'Composing a unified operator view for agent roster, missions, and log feed.',
      createdAt: new Date(now.getTime() - oneHour * 1.5).toISOString(),
    },
    {
      id: 'log-4',
      projectId: project.id,
      missionId: 'mission-release-gate',
      agentId: 'agent-sentinel',
      level: 'WARN',
      message: 'Tooling verification is waiting on package installation in the local environment.',
      createdAt: new Date(now.getTime() - oneHour).toISOString(),
    },
  ];

  return {
    projects: [project],
    agents,
    missions,
    logs,
  };
}

function getProjectHealth(
  blockedMissionCount: number,
  runningMissionCount: number,
): ProjectBattleReport['health'] {
  if (blockedMissionCount > 0) {
    return 'AMBER';
  }

  if (runningMissionCount === 0) {
    return 'RED';
  }

  return 'GREEN';
}

function buildBattleNarrative(input: {
  project: Project;
  totalAgents: number;
  activeAgents: number;
  totalMissions: number;
  runningMissionCount: number;
  blockedMissionCount: number;
  completedMissionCount: number;
  completionRate: number;
  logVolume24h: number;
  highRiskMissionCount: number;
  manualGovernanceMissionCount: number;
  topAgents: ProjectBattleReport['topAgents'];
}): string {
  const {
    project,
    totalAgents,
    activeAgents,
    totalMissions,
    runningMissionCount,
    blockedMissionCount,
    completedMissionCount,
    completionRate,
    logVolume24h,
    highRiskMissionCount,
    manualGovernanceMissionCount,
    topAgents,
  } = input;

  const topAgentLine = topAgents[0]
    ? `本周由 ${topAgents[0].agentName} 领跑，累计完成 ${topAgents[0].completedMissionCount} 个任务。`
    : '本周还没有任何 Agent 完成任务，整体节奏还在预热中。';

  const governanceLine =
    highRiskMissionCount > 0
      ? `治理态势：当前有 ${highRiskMissionCount} 个高风险任务，需人工审批 ${manualGovernanceMissionCount} 个。`
      : '治理态势：当前暂无高风险任务，审批队列为空。';

  return [
    `作战代号「${project.codename}」当前有 ${activeAgents}/${totalAgents} 名 Agent 在线，${runningMissionCount} 个任务在执行中。`,
    `截至目前，共完成 ${completedMissionCount}/${totalMissions} 个任务（完成率 ${completionRate}%），其中有 ${blockedMissionCount} 个任务处于阻塞状态。`,
    `过去 24 小时内记录了 ${logVolume24h} 条执行日志，方便指挥官回放 Agent 行为与风控信号。`,
    governanceLine,
    topAgentLine,
  ].join(' ');
}

export function generateProjectBattleReport(
  project: Project,
  agents: Agent[],
  missions: Mission[],
  logs: ExecutionLog[],
  now = new Date(),
): ProjectBattleReport {
  const runningMissionCount = missions.filter((mission) => mission.status === 'RUNNING').length;
  const blockedMissionCount = missions.filter((mission) => mission.status === 'BLOCKED').length;
  const completedMissionCount = missions.filter((mission) => mission.status === 'DONE').length;
  const totalMissions = missions.length;
  const highRiskMissionCount = missions.filter((mission) => {
    return mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
  }).length;
  const manualGovernanceMissionCount = missions.filter((mission) => {
    return mission.governanceMode === 'MANUAL';
  }).length;
  const totalAgents = agents.length;
  const activeAgents = agents.filter((agent) => {
    return agent.status === 'READY' || agent.status === 'RUNNING';
  }).length;
  const completionRate =
    totalMissions === 0 ? 0 : Math.round((completedMissionCount / totalMissions) * 100);

  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const logVolume24h = logs.filter((log) => new Date(log.createdAt).getTime() >= dayAgo).length;

  const topAgents = agents
    .map((agent) => {
      const completedByAgent = missions.filter((mission) => {
        return mission.assignedAgentId === agent.id && mission.status === 'DONE';
      }).length;

      return {
        agentId: agent.id,
        agentName: agent.name,
        completedMissionCount: completedByAgent,
      };
    })
    .filter((agent) => agent.completedMissionCount > 0)
    .sort((left, right) => {
      return right.completedMissionCount - left.completedMissionCount;
    })
    .slice(0, 3);

  const health = getProjectHealth(blockedMissionCount, runningMissionCount);
  const narrative = buildBattleNarrative({
    project,
    totalAgents,
    activeAgents,
    totalMissions,
    runningMissionCount,
    blockedMissionCount,
    completedMissionCount,
    completionRate,
    logVolume24h,
    highRiskMissionCount,
    manualGovernanceMissionCount,
    topAgents,
  });

  return {
    generatedAt: now.toISOString(),
    health,
    totalAgents,
    activeAgents,
    totalMissions,
    runningMissionCount,
    blockedMissionCount,
    completedMissionCount,
    logVolume24h,
    completionRate,
    highRiskMissionCount,
    manualGovernanceMissionCount,
    topAgents,
    narrative,
  };
}

export function getProjectWarRoomSnapshot(
  data: WarRoomData,
  projectId: string,
  now = new Date(),
): ProjectWarRoomSnapshot | null {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) {
    return null;
  }

  const projectAgents = data.agents.filter((agent) => agent.projectId === projectId);
  const projectMissions = data.missions
    .filter((mission) => mission.projectId === projectId)
    .sort(sortMissions);
  const projectLogs = data.logs
    .filter((log) => log.projectId === projectId)
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

  const agentWorkloads = projectAgents
    .map((agent) => {
      const assignedMissions = projectMissions.filter(
        (mission) => mission.assignedAgentId === agent.id,
      );
      const completedMissionCount = assignedMissions.filter(
        (mission) => mission.status === 'DONE',
      ).length;
      const activeMissionCount = assignedMissions.filter((mission) => {
        return mission.status === 'RUNNING' || mission.status === 'BLOCKED';
      }).length;

      return {
        agentId: agent.id,
        agentName: agent.name,
        callsign: agent.callsign,
        status: agent.status,
        specialty: agent.specialty,
        assignedMissionCount: assignedMissions.length,
        activeMissionCount,
        completedMissionCount,
        latestLogAt: projectLogs.find((log) => log.agentId === agent.id)?.createdAt,
      };
    })
    .sort((left, right) => {
      return (
        right.activeMissionCount - left.activeMissionCount ||
        right.completedMissionCount - left.completedMissionCount ||
        left.agentName.localeCompare(right.agentName)
      );
    });

  return {
    project,
    agents: agentWorkloads,
    missions: projectMissions,
    latestLogs: projectLogs.slice(0, 12),
    battleReport: generateProjectBattleReport(
      project,
      projectAgents,
      projectMissions,
      projectLogs,
      now,
    ),
  };
}

function sortMissions(left: Mission, right: Mission): number {
  return (
    missionStatusWeight[right.status] - missionStatusWeight[left.status] ||
    missionPriorityWeight[right.priority] - missionPriorityWeight[left.priority] ||
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}
