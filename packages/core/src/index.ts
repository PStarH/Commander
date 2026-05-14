export type ProjectStatus = 'ACTIVE' | 'AT_RISK' | 'STABILIZING';
export type AgentStatus = 'READY' | 'RUNNING' | 'BLOCKED' | 'OFFLINE';
export type AgentGovernanceRole = 'COMMANDER' | 'SENATE' | 'EXECUTOR';
export type MissionStatus = 'PLANNED' | 'RUNNING' | 'BLOCKED' | 'DONE';
export type MissionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MissionRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MissionGovernanceMode = 'AUTO' | 'GUARDED' | 'MANUAL';
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export interface Project {
  id: string;
  name: string;
  codename: string;
  objective: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  callsign: string;
  role: string;
  model: string;
  status: AgentStatus;
  specialty: string;
  governanceRole: AgentGovernanceRole;
  lastHeartbeatAt: string;
}

export interface AgentState {
  projectId: string;
  agentId: string;
  summary?: string;
  preferences?: string;
  tags?: string[];
  updatedAt: string;
}

export interface Mission {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  governanceMode: MissionGovernanceMode;
  assignedAgentId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionLog {
  id: string;
  projectId: string;
  missionId: string;
  agentId: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface WarRoomData {
  projects: Project[];
  agents: Agent[];
  missions: Mission[];
  logs: ExecutionLog[];
}

export interface AgentWorkload {
  agentId: string;
  agentName: string;
  callsign: string;
  status: AgentStatus;
  specialty: string;
  assignedMissionCount: number;
  activeMissionCount: number;
  completedMissionCount: number;
  latestLogAt?: string;
}

export interface ProjectBattleReport {
  generatedAt: string;
  health: 'GREEN' | 'AMBER' | 'RED';
  totalAgents: number;
  activeAgents: number;
  totalMissions: number;
  runningMissionCount: number;
  blockedMissionCount: number;
  completedMissionCount: number;
  logVolume24h: number;
  completionRate: number;
  highRiskMissionCount: number;
  manualGovernanceMissionCount: number;
  topAgents: Array<{
    agentId: string;
    agentName: string;
    completedMissionCount: number;
  }>;
  narrative: string;
}

export interface ProjectWarRoomSnapshot {
  project: Project;
  agents: AgentWorkload[];
  missions: Mission[];
  latestLogs: ExecutionLog[];
  battleReport: ProjectBattleReport;
}

export type ProjectMemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';

/**
 * Memory duration classification (Research finding from Langflow 2025)
 * - EPISODIC: Short-term, session-scoped memory (per-session, expires after session)
 * - LONG_TERM: Persistent memory that survives across sessions (decisions, lessons)
 */
export type MemoryDuration = 'EPISODIC' | 'LONG_TERM';

export interface ProjectMemoryItem {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: ProjectMemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  /** Memory duration classification (v2) */
  duration?: MemoryDuration;
}

export interface ProjectMemoryOverview {
  totalItems: number;
  kindCounts: Record<ProjectMemoryKind, number>;
  topTags: Array<{
    tag: string;
    count: number;
  }>;
  missionLinkedCount: number;
  agentLinkedCount: number;
  latestCreatedAt?: string;
}

export interface CommanderRunContext {
  projectId: string;
  snapshot: ProjectWarRoomSnapshot;
  recentMemory: ProjectMemoryItem[];
  agentId?: string;
  missionId?: string;
}

export type CommanderRunIntent = 'PLAN' | 'PROPOSE' | 'EXECUTE' | 'REVIEW' | 'MONITOR';

export type CommanderInvocationDisposition =
  | 'ALLOW_EXECUTION'
  | 'REQUIRE_APPROVAL'
  | 'PROPOSE_ONLY'
  | 'DENY';

export type CommanderOperation =
  | 'READ_CONTEXT'
  | 'WRITE_LOG'
  | 'UPDATE_MISSION_STATUS'
  | 'UPDATE_MISSION_FIELDS'
  | 'WRITE_MEMORY'
  | 'UPDATE_AGENT_STATE'
  | 'REQUEST_APPROVAL';

export interface CommanderAgentCard {
  id: string;
  projectId: string;
  name: string;
  callsign: string;
  status: AgentStatus;
  specialty: string;
  governanceRole: AgentGovernanceRole;
  model?: string;
  role?: string;
}

export interface SlimMissionCard {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  governanceMode: MissionGovernanceMode;
  assignedAgentId: string;
  updatedAt: string;
}

export interface SlimLogLine {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
  missionId: string;
  agentId: string;
}

export interface SlimSnapshot {
  project: Pick<Project, 'id' | 'codename' | 'objective' | 'status' | 'updatedAt'>;
  focusMission?: SlimMissionCard;
  missionBoard: {
    running: SlimMissionCard[];
    blocked: SlimMissionCard[];
    planned: SlimMissionCard[];
    done: SlimMissionCard[];
  };
  battleMetrics: Pick<
    ProjectBattleReport,
    | 'health'
    | 'runningMissionCount'
    | 'blockedMissionCount'
    | 'completedMissionCount'
    | 'highRiskMissionCount'
    | 'manualGovernanceMissionCount'
    | 'logVolume24h'
    | 'completionRate'
  >;
  latestLogs?: SlimLogLine[];
}

export interface CommanderRunMeta {
  runId: string;
  issuedAt: string;
  issuedBy?: {
    kind: 'HUMAN' | 'AGENT' | 'SYSTEM';
    id?: string;
    label?: string;
  };
}

export interface RecommendedMemorySlice {
  items: ProjectMemoryItem[];
  /**
   * Optional tags used when selecting this slice. This is a hint for callers
   * to understand为什么这些记忆被选中，而不是语义搜索的原始参数。
   */
  sourceTags?: string[];
}

export interface CommanderRunGuidance {
  invocationProfile?: AgentInvocationProfile;
  strategy?: MultiAgentStrategy;
}

export interface CommanderRunContextV2 {
  projectId: string;
  run: CommanderRunMeta;
  focus?: {
    agentId?: string;
    missionId?: string;
    intent?: CommanderRunIntent;
  };
  slimSnapshot: SlimSnapshot;
  /**
   * 最近可用的原始记忆列表（向后兼容保留）。
   */
  recentMemory: ProjectMemoryItem[];
  /**
   * 根据当前 focus（agent/mission/intent）裁剪后，推荐给本次调用使用的记忆切片。
   * Token 预算敏感的 orchestrator 应优先使用该字段，而不是直接全部塞 recentMemory。
   */
  recommendedMemory: RecommendedMemorySlice;
  /**
   * Commander 框架层直接给出的调用建议，避免 orchestrator / SDK 再重复计算。
   */
  guidance?: CommanderRunGuidance;
  agentRoster: CommanderAgentCard[];
}

export interface CreateSlimSnapshotOptions {
  focusMissionId?: string;
  maxMissionsPerBucket?: number;
  maxLogs?: number;
}

export function createSlimSnapshot(
  snapshot: ProjectWarRoomSnapshot,
  options: CreateSlimSnapshotOptions
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

  const running = snapshot.missions.filter(m => m.status === 'RUNNING').slice(0, maxMissionsPerBucket);
  const blocked = snapshot.missions.filter(m => m.status === 'BLOCKED').slice(0, maxMissionsPerBucket);
  const planned = snapshot.missions.filter(m => m.status === 'PLANNED').slice(0, maxMissionsPerBucket);
  const done = snapshot.missions.filter(m => m.status === 'DONE').slice(0, maxMissionsPerBucket);

  const focusMission = options.focusMissionId
    ? snapshot.missions.find(m => m.id === options.focusMissionId)
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
      objective: 'Persist one project with agents, missions, and logs so the war room survives refreshes.',
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

export function getProjectWarRoomSnapshot(
  data: WarRoomData,
  projectId: string,
  now = new Date()
): ProjectWarRoomSnapshot | null {
  const project = data.projects.find(item => item.id === projectId);
  if (!project) {
    return null;
  }

  const projectAgents = data.agents.filter(agent => agent.projectId === projectId);
  const projectMissions = data.missions
    .filter(mission => mission.projectId === projectId)
    .sort(sortMissions);
  const projectLogs = data.logs
    .filter(log => log.projectId === projectId)
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

  const agentWorkloads = projectAgents
    .map(agent => {
      const assignedMissions = projectMissions.filter(
        mission => mission.assignedAgentId === agent.id
      );
      const completedMissionCount = assignedMissions.filter(
        mission => mission.status === 'DONE'
      ).length;
      const activeMissionCount = assignedMissions.filter(mission => {
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
        latestLogAt: projectLogs.find(log => log.agentId === agent.id)?.createdAt,
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
    battleReport: generateProjectBattleReport(project, projectAgents, projectMissions, projectLogs, now),
  };
}

export function generateProjectBattleReport(
  project: Project,
  agents: Agent[],
  missions: Mission[],
  logs: ExecutionLog[],
  now = new Date()
): ProjectBattleReport {
  const runningMissionCount = missions.filter(mission => mission.status === 'RUNNING').length;
  const blockedMissionCount = missions.filter(mission => mission.status === 'BLOCKED').length;
  const completedMissionCount = missions.filter(mission => mission.status === 'DONE').length;
  const totalMissions = missions.length;
  const highRiskMissionCount = missions.filter(mission => {
    return mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
  }).length;
  const manualGovernanceMissionCount = missions.filter(mission => {
    return mission.governanceMode === 'MANUAL';
  }).length;
  const totalAgents = agents.length;
  const activeAgents = agents.filter(agent => {
    return agent.status === 'READY' || agent.status === 'RUNNING';
  }).length;
  const completionRate = totalMissions === 0 ? 0 : Math.round((completedMissionCount / totalMissions) * 100);

  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const logVolume24h = logs.filter(log => new Date(log.createdAt).getTime() >= dayAgo).length;

  const topAgents = agents
    .map(agent => {
      const completedByAgent = missions.filter(mission => {
        return mission.assignedAgentId === agent.id && mission.status === 'DONE';
      }).length;

      return {
        agentId: agent.id,
        agentName: agent.name,
        completedMissionCount: completedByAgent,
      };
    })
    .filter(agent => agent.completedMissionCount > 0)
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

export interface TokenBudget {
  maxTokens: number;
  warningThreshold: number; // 百分比，如 80 表示 80% 时警告
  burnRate?: 'low' | 'medium' | 'high';
}

export interface AgentInvocationProfile {
  agentId: string;
  intent: CommanderRunIntent;
  missionId?: string;
  disposition: CommanderInvocationDisposition;
  allowedOperations: CommanderOperation[];
  forbiddenOperations: CommanderOperation[];
  approval?: {
    required: boolean;
    requiredRoles: AgentGovernanceRole[];
    minApprovals: number;
  };
  rationale: string[];
  /** Token 预算控制 (v1) */
  tokenBudget?: TokenBudget;
}

interface MissionGovernanceDispositionInput {
  agent: CommanderAgentCard;
  mission?: SlimMissionCard;
  intent: CommanderRunIntent;
}

interface MissionGovernanceDisposition {
  disposition: CommanderInvocationDisposition;
  rationale: string[];
  approval?: AgentInvocationProfile['approval'];
}

function getMissionGovernanceDisposition(
  input: MissionGovernanceDispositionInput
): MissionGovernanceDisposition {
  const rationale: string[] = [];
  const mission = input.mission;

  if (!mission) {
    rationale.push('No mission bound => PROPOSE/PLAN only by default.');
    return { disposition: 'PROPOSE_ONLY', rationale };
  }

  if (mission.governanceMode === 'MANUAL') {
    rationale.push('governanceMode=MANUAL => proposals allowed; execution requires COMMANDER approval.');
    return {
      disposition: 'REQUIRE_APPROVAL',
      rationale,
      approval: { required: true, requiredRoles: ['COMMANDER'], minApprovals: 1 },
    };
  }

  const highRisk = mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
  if (highRisk && input.agent.governanceRole === 'EXECUTOR' && input.intent === 'EXECUTE') {
    rationale.push(
      'HIGH/CRITICAL risk + EXECUTE intent => require approval or downgrade to proposal externally.'
    );
    return {
      disposition: 'REQUIRE_APPROVAL',
      rationale,
      approval: { required: true, requiredRoles: ['COMMANDER', 'SENATE'], minApprovals: 1 },
    };
  }

  if (mission.governanceMode === 'GUARDED' && input.intent === 'EXECUTE') {
    rationale.push(
      'governanceMode=GUARDED + EXECUTE intent => allow execution but expect senate monitoring.'
    );
    return { disposition: 'ALLOW_EXECUTION', rationale };
  }

  return {
    disposition: input.intent === 'EXECUTE' ? 'ALLOW_EXECUTION' : 'PROPOSE_ONLY',
    rationale,
  };
}

export function getDefaultInvocationProfile(input: {
  agent: CommanderAgentCard;
  mission?: SlimMissionCard;
  intent: CommanderRunIntent;
}): AgentInvocationProfile {
  const governance = getMissionGovernanceDisposition(input);
  const rationale = [...governance.rationale];

  const baseAllowed: CommanderOperation[] = ['READ_CONTEXT', 'WRITE_LOG'];
  const baseForbidden: CommanderOperation[] = [
    'UPDATE_MISSION_STATUS',
    'UPDATE_MISSION_FIELDS',
    'WRITE_MEMORY',
    'UPDATE_AGENT_STATE',
    'REQUEST_APPROVAL',
  ];

  if (governance.disposition === 'ALLOW_EXECUTION' && input.intent === 'EXECUTE') {
    return {
      agentId: input.agent.id,
      intent: input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: [
        'READ_CONTEXT',
        'WRITE_LOG',
        'UPDATE_MISSION_STATUS',
        'UPDATE_MISSION_FIELDS',
        'WRITE_MEMORY',
        'UPDATE_AGENT_STATE',
      ],
      forbiddenOperations: ['REQUEST_APPROVAL'],
      approval: governance.approval ?? { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  if (governance.disposition === 'REQUIRE_APPROVAL') {
    rationale.push('Restricting to proposal-safe operations until approval is granted by external system.');
    return {
      agentId: input.agent.id,
      intent: input.intent === 'EXECUTE' ? 'PROPOSE' : input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
      forbiddenOperations: ['UPDATE_MISSION_STATUS', 'UPDATE_MISSION_FIELDS', 'UPDATE_AGENT_STATE'],
      approval:
        governance.approval ?? {
          required: true,
          requiredRoles: ['COMMANDER'],
          minApprovals: 1,
        },
      rationale,
    };
  }

  if (governance.disposition === 'PROPOSE_ONLY') {
    return {
      agentId: input.agent.id,
      intent: input.intent === 'EXECUTE' ? 'PROPOSE' : input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY'],
      forbiddenOperations: [
        'UPDATE_MISSION_STATUS',
        'UPDATE_MISSION_FIELDS',
        'UPDATE_AGENT_STATE',
        'REQUEST_APPROVAL',
      ],
      approval: governance.approval ?? { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  return {
    agentId: input.agent.id,
    intent: input.intent,
    missionId: input.mission?.id,
    disposition: 'DENY',
    allowedOperations: ['READ_CONTEXT'],
    forbiddenOperations: [
      'WRITE_LOG',
      'UPDATE_MISSION_STATUS',
      'UPDATE_MISSION_FIELDS',
      'WRITE_MEMORY',
      'UPDATE_AGENT_STATE',
      'REQUEST_APPROVAL',
    ],
    approval: {
      required: true,
      requiredRoles: ['COMMANDER'],
      minApprovals: 1,
    },
    rationale: [...rationale, 'Default deny.'],
  };
}

function getProjectHealth(
  blockedMissionCount: number,
  runningMissionCount: number
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

export type MultiAgentStrategyKind =
  | 'SINGLE_AGENT'
  | 'GUARDED_EXECUTION'
  | 'SENATE_REVIEW'
  | 'MANUAL_APPROVAL_GATE'
  | 'FANOUT_PLAN';

export interface MultiAgentStrategy {
  kind: MultiAgentStrategyKind;
  primaryAgentId?: string;
  executorAgentIds?: string[];
  reviewerAgentIds?: string[];
  approval?: {
    required: boolean;
    requiredRoles: AgentGovernanceRole[];
    minApprovals: number;
  };
  rationale: string[];
}

// Orchestration exports
export {
  SequentialStep,
  SequentialContext,
  SequentialStepResult,
  SequentialPipelineStatus,
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialEvent,
  SequentialEventHandler,
  SequentialPipelineBuilder,
  OrchestrationMetrics,
  calculateOrchestrationMetrics,
  TokenUsage,
} from './orchestration';

// Memory exports (re-export from memory module)
// Note: MemoryKind (as ProjectMemoryKind) and MemoryDuration are already exported above
export {
  MemoryPriority,
  EpisodicMemoryItem,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteOptions,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
  InMemoryMemoryStore,
  SqliteMemoryStore,
  createMemoryStore,
  fromProjectMemoryItem,
  toProjectMemoryItem,
} from './memory';

// MemoryKind alias for convenience (ProjectMemoryKind is the canonical name)
export type MemoryKind = ProjectMemoryKind;

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

// Task Complexity Measurement (based on ACONIC research)
// Reference: research-notes.md - Agent Task Decomposition Methods

/**
 * Task complexity metrics for decomposition decisions.
 * Based on ACONIC framework: constraint graph properties (treewidth + graph size).
 */
export interface TaskComplexity {
  /** Intrinsic complexity - higher means harder to solve directly */
  treewidth: number;
  /** Size of the constraint graph (number of constraints/dependencies) */
  graphSize: number;
  /** Maximum depth of task dependencies */
  dependencyDepth: number;
  /** Estimated number of subtasks if decomposed */
  estimatedSubtasks: number;
  /** Complexity classification */
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Task dependency edge for building dependency graph.
 */
export interface TaskDependency {
  from: string;
  to: string;
  type: 'SEQUENTIAL' | 'PARALLEL' | 'CONDITIONAL';
  strength: 'WEAK' | 'MEDIUM' | 'STRONG';
}

/**
 * Task node for complexity analysis.
 */
export interface TaskNode {
  id: string;
  /** Number of input constraints/requirements */
  inputCount: number;
  /** Number of output constraints/deliverables */
  outputCount: number;
  /** Estimated cognitive load (1-10) */
  cognitiveLoad: number;
  /** Whether task requires external resources */
  requiresExternalResources: boolean;
  /** Dependencies on other tasks */
  dependencies: string[];
}

/**
 * Options for complexity measurement.
 */
export interface TaskComplexityOptions {
  /** Maximum dependency depth before forcing decomposition */
  maxDependencyDepth?: number;
  /** Threshold for treewidth to trigger decomposition */
  treewidthThreshold?: number;
  /** Maximum estimated subtasks before overengineering warning */
  maxSubtasks?: number;
}

const DEFAULT_COMPLEXITY_OPTIONS: Required<TaskComplexityOptions> = {
  maxDependencyDepth: 4,
  treewidthThreshold: 3,
  maxSubtasks: 5,
};

/**
 * Measure task complexity based on dependency graph.
 * 
 * Algorithm:
 * 1. Build constraint graph from task dependencies
 * 2. Calculate treewidth approximation (using DFS-based heuristic)
 * 3. Measure dependency depth via longest path
 * 4. Estimate subtask count based on graph structure
 */
export function measureTaskComplexity(
  task: TaskNode,
  allTasks: TaskNode[],
  options: TaskComplexityOptions = {}
): TaskComplexity {
  const opts = { ...DEFAULT_COMPLEXITY_OPTIONS, ...options };

  // Build dependency graph
  const graph = buildDependencyGraph(task, allTasks);
  
  // Calculate treewidth approximation (simplified heuristic)
  // Real treewidth calculation is NP-hard, so we use degree-based approximation
  const treewidth = approximateTreewidth(graph);
  
  // Calculate dependency depth (longest path from root to this task)
  const dependencyDepth = calculateDependencyDepth(task.id, allTasks);
  
  // Estimate number of subtasks
  const estimatedSubtasks = estimateSubtasks(task, graph);
  
  // Calculate graph size
  const graphSize = graph.nodes.size + graph.edges.length;
  
  // Determine complexity level
  const level = classifyComplexityLevel(
    treewidth,
    graphSize,
    dependencyDepth,
    opts
  );

  return {
    treewidth,
    graphSize,
    dependencyDepth,
    estimatedSubtasks,
    level,
  };
}

/**
 * Decision: Should this task be decomposed into subtasks?
 */
export function shouldDecompose(
  complexity: TaskComplexity,
  options: TaskComplexityOptions = {}
): { decompose: boolean; reason: string } {
  const opts = { ...DEFAULT_COMPLEXITY_OPTIONS, ...options };

  // Critical complexity always decompose
  if (complexity.level === 'CRITICAL') {
    return {
      decompose: true,
      reason: `Complexity level CRITICAL: treewidth=${complexity.treewidth}, depth=${complexity.dependencyDepth}`,
    };
  }

  // High treewidth suggests complex constraint satisfaction
  if (complexity.treewidth > opts.treewidthThreshold) {
    return {
      decompose: true,
      reason: `Treewidth ${complexity.treewidth} exceeds threshold ${opts.treewidthThreshold}`,
    };
  }

  // Deep dependency chains benefit from decomposition
  if (complexity.dependencyDepth > opts.maxDependencyDepth) {
    return {
      decompose: true,
      reason: `Dependency depth ${complexity.dependencyDepth} exceeds max ${opts.maxDependencyDepth}`,
    };
  }

  // Low complexity - no decomposition needed
  if (complexity.level === 'LOW') {
    return {
      decompose: false,
      reason: `Complexity level LOW: direct execution recommended`,
    };
  }

  // Medium complexity - check if decomposition helps
  if (complexity.level === 'MEDIUM') {
    // Only decompose if it reduces complexity significantly
    const benefitRatio = complexity.estimatedSubtasks > 0
      ? complexity.graphSize / complexity.estimatedSubtasks
      : 0;
    
    if (benefitRatio > 2) {
      return {
        decompose: true,
        reason: `Medium complexity with clear decomposition benefit (ratio: ${benefitRatio.toFixed(1)})`,
      };
    }
    
    return {
      decompose: false,
      reason: `Medium complexity but decomposition overhead exceeds benefit`,
    };
  }

  // High complexity - decompose unless subtasks are too many
  if (complexity.level === 'HIGH') {
    if (complexity.estimatedSubtasks > opts.maxSubtasks) {
      return {
        decompose: false,
        reason: `High complexity but ${complexity.estimatedSubtasks} subtasks risks overengineering (max: ${opts.maxSubtasks})`,
      };
    }
    
    return {
      decompose: true,
      reason: `High complexity: decomposition into ${complexity.estimatedSubtasks} subtasks recommended`,
    };
  }

  return {
    decompose: false,
    reason: 'Default: no decomposition',
  };
}

/**
 * Get decomposition recommendation for a mission.
 */
export function getMissionDecompositionRecommendation(
  mission: SlimMissionCard,
  context: CommanderRunContextV2
): { decompose: boolean; complexity: TaskComplexity; reason: string } {
  // Convert mission to task node (simplified)
  const taskNode: TaskNode = {
    id: mission.id,
    inputCount: context.slimSnapshot.missionBoard.running.length + 
                context.slimSnapshot.missionBoard.blocked.length,
    outputCount: 1, // Single mission objective
    cognitiveLoad: estimateCognitiveLoad(mission),
    requiresExternalResources: mission.governanceMode === 'MANUAL',
    dependencies: extractDependencies(mission, context),
  };

  // Get all active tasks
  const allTasks = extractAllTasks(context);

  // Measure complexity
  const complexity = measureTaskComplexity(taskNode, allTasks);

  // Get decomposition decision
  const decision = shouldDecompose(complexity);

  return {
    decompose: decision.decompose,
    complexity,
    reason: decision.reason,
  };
}

// Internal helper functions

interface DependencyGraph {
  nodes: Set<string>;
  edges: Array<{ from: string; to: string; weight: number }>;
}

function buildDependencyGraph(task: TaskNode, allTasks: TaskNode[]): DependencyGraph {
  const nodes = new Set<string>([task.id]);
  const edges: Array<{ from: string; to: string; weight: number }> = [];

  // Add dependencies
  for (const depId of task.dependencies) {
    nodes.add(depId);
    edges.push({ from: depId, to: task.id, weight: 1 });
  }

  // Add related tasks (same dependency chain)
  for (const otherTask of allTasks) {
    if (task.dependencies.includes(otherTask.id) || otherTask.dependencies.includes(task.id)) {
      nodes.add(otherTask.id);
      for (const depId of otherTask.dependencies) {
        nodes.add(depId);
        edges.push({ from: depId, to: otherTask.id, weight: 1 });
      }
    }
  }

  return { nodes, edges };
}

function approximateTreewidth(graph: DependencyGraph): number {
  // Simplified treewidth approximation using maximum degree
  // Real treewidth calculation requires tree decomposition algorithm
  
  const degrees = new Map<string, number>();
  
  for (const edge of graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }

  let maxDegree = 0;
  for (const degree of degrees.values()) {
    maxDegree = Math.max(maxDegree, degree);
  }

  // Treewidth approximation: max degree / 2 (conservative estimate)
  // This is a loose bound; actual treewidth is often lower
  return Math.ceil(maxDegree / 2);
}

function calculateDependencyDepth(taskId: string, allTasks: TaskNode[]): number {
  const task = allTasks.find(t => t.id === taskId);
  if (!task || task.dependencies.length === 0) {
    return 0;
  }

  let maxDepth = 0;
  for (const depId of task.dependencies) {
    const depth = calculateDependencyDepth(depId, allTasks);
    maxDepth = Math.max(maxDepth, depth + 1);
  }

  return maxDepth;
}

function estimateSubtasks(task: TaskNode, graph: DependencyGraph): number {
  // Estimate based on cognitive load and dependency structure
  const baseEstimate = Math.ceil(task.cognitiveLoad / 3);
  const dependencyFactor = Math.ceil(task.dependencies.length / 2);
  
  // Cap at graph size to avoid overestimation
  return Math.min(baseEstimate + dependencyFactor, graph.nodes.size);
}

function classifyComplexityLevel(
  treewidth: number,
  graphSize: number,
  dependencyDepth: number,
  opts: Required<TaskComplexityOptions>
): TaskComplexity['level'] {
  // Weighted scoring
  const treewidthScore = treewidth * 2;
  const graphScore = graphSize > 10 ? 2 : graphSize > 5 ? 1 : 0;
  const depthScore = dependencyDepth > 3 ? 2 : dependencyDepth > 1 ? 1 : 0;
  
  const totalScore = treewidthScore + graphScore + depthScore;

  if (totalScore >= 6) return 'CRITICAL';
  if (totalScore >= 4) return 'HIGH';
  if (totalScore >= 2) return 'MEDIUM';
  return 'LOW';
}

function estimateCognitiveLoad(mission: SlimMissionCard): number {
  // Estimate cognitive load based on mission properties
  let load = 3; // Base load
  
  if (mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL') {
    load += 3;
  } else if (mission.riskLevel === 'MEDIUM') {
    load += 1;
  }
  
  if (mission.governanceMode === 'MANUAL') {
    load += 2;
  } else if (mission.governanceMode === 'GUARDED') {
    load += 1;
  }
  
  if (mission.priority === 'CRITICAL') {
    load += 2;
  } else if (mission.priority === 'HIGH') {
    load += 1;
  }
  
  return Math.min(load, 10);
}

function extractDependencies(mission: SlimMissionCard, context: CommanderRunContextV2): string[] {
  // Extract dependencies from context (blocked missions that might be related)
  const dependencies: string[] = [];
  
  // Blocked missions could be dependencies
  for (const blocked of context.slimSnapshot.missionBoard.blocked) {
    if (blocked.id !== mission.id) {
      dependencies.push(blocked.id);
    }
  }
  
  return dependencies;
}

function extractAllTasks(context: CommanderRunContextV2): TaskNode[] {
  const tasks: TaskNode[] = [];
  
  // Convert all missions to task nodes (simplified)
  const allMissions = [
    ...context.slimSnapshot.missionBoard.running,
    ...context.slimSnapshot.missionBoard.blocked,
    ...context.slimSnapshot.missionBoard.planned,
  ];
  
  for (const mission of allMissions) {
    tasks.push({
      id: mission.id,
      inputCount: 1,
      outputCount: 1,
      cognitiveLoad: estimateCognitiveLoad(mission),
      requiresExternalResources: mission.governanceMode === 'MANUAL',
      dependencies: [],
    });
  }
  
  return tasks;
}

// Ultimate Framework exports (legacy)
export {
  OrchestrationMode,
  OrchestrationDecision,
  TokenBudgetAllocation,
  ModelTierConfig,
  DEFAULT_MODEL_CONFIG,
  
  AllocatedBudget,
  QualityGate,
  QualityGateExecutor,
  QualityGateResult,
} from './ultimate';
export { AdaptiveOrchestrator } from './adaptiveOrchestrator';
export { TokenBudgetAllocator } from './tokenBudgetAllocator';

// ============================================================================
// Ultimate Multi-Agent Orchestration System (v2)
// The world's most advanced multi-agent orchestration platform
// ============================================================================
export {
  UltimateOrchestrator,
  deliberate,
  RecursiveAtomizer,
  TopologyRouter,
  SubAgentExecutor,
  MultiAgentSynthesizer,
  ArtifactSystem,
  getArtifactSystem,
  resetArtifactSystem,
  CapabilityRegistry,
  getCapabilityRegistry,
  AgentTeamManager,
  getTeamManager,
  getEffortRules,
  classifyEffortLevel,
  selectTopologyForEffort,
} from './ultimate/index';

export type {
  OrchestrationTopology,
  TaskDAG,
  TaskDAGNode,
  TaskDAGEdge,
  DeliberationPlan,
  TaskTreeNode,
  ArtifactReference,
  AgentTeam,
  TeamMember,
  SharedTask,
  InboxMessage,
  CapabilityVector,
  AgentCapability,
  EffortLevel,
  EffortScalingRules,
  ThinkingBudget,
  SynthesisStrategy,
  SynthesisConfig,
  QualityGateConfig,
  UltimateExecutionContext,
  UltimateExecutionResult,
  UltimateMetrics,
  ExecutionError,
  UltimateOrchestratorConfig,
} from './ultimate/index';

export {
  DEFAULT_THINKING_BUDGET,
  DEFAULT_SYNTHESIS_CONFIG,
  DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// ============================================================================
// Tools — Web Search, File System, Code Execution
// ============================================================================
export {
  WebSearchTool,
  WebFetchTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FileSearchTool,
  FileListTool,
  PythonExecuteTool,
  ShellExecuteTool,
  createAllTools,
} from './tools/index';

// ============================================================================
// Agent Loop — Persistent multi-agent execution
// ============================================================================
export { CommanderAgentLoop } from './agentLoop';
export type { AgentLoopConfig } from './agentLoop';

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

function sortMissions(left: Mission, right: Mission): number {
  return (
    missionStatusWeight[right.status] - missionStatusWeight[left.status] ||
    missionPriorityWeight[right.priority] - missionPriorityWeight[left.priority] ||
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

// ContentScanner exports - Agent Security Layer
export {
  ContentScanner,
  DefaultContentScanner,
  createContentScanner,
  scanContent,
} from './contentScanner';

// Ultimate Framework - Additional Components (Phase 1)
export { ThreeLayerMemory } from './threeLayerMemory';
export { ReflectionEngine, createReflectionEngine } from './reflectionEngine';
export { ConsensusChecker, createConsensusChecker } from './consensusCheck';
export { InspectorAgent, createInspector } from './inspectorAgent';
export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// Logging & Metrics (Phase 2)
export { Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics } from './logging';

// Error Handler (Phase 2)
export { ErrorHandler, CommanderError, TaskComplexityError, OrchestrationError, BudgetExhaustedError, MemoryError, ConsensusError, InspectionError } from './errorHandler';

export { initializeFramework, getFramework, createExecutionPlan, allocateBudget, recordMemory, queryMemory, startReflection, completeReflection, runConsensusCheck, updateComponentHealth, runInspection } from "./frameworkIntegration";

// Hallucination Detector
export { HallucinationDetector, getHallucinationDetector } from './hallucinationDetector';
export type { HallucinationSignal, HallucinationReport } from './hallucinationDetector';

// ============================================================================
// Runtime System — Agent Execution Engine (Phase 3)
// ============================================================================
export type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  CacheConfig,
  CacheUsage,
  ToolDefinition,
  ToolCall,
  ToolResult,
  Tool,
  ModelTier,
  ModelConfig,
  RoutingDecision,
  AgentExecutionContext,
  AgentExecutionStep,
  AgentExecutionResult,
  AgentRuntimeConfig,
  MessageBusTopic,
  MessagePriority,
  BusMessage,
  MessageHandler,
  TraceEvent,
  ExecutionTrace,
  HTMLReportSection,
  HTMLReport,
  ExecutionExperience,
  OptimizationSuggestion,
  StrategyPerformance,
} from './runtime/types';
export {
  ModelRouter,
  getModelRouter,
  resetModelRouter,
  MessageBus,
  getMessageBus,
  resetMessageBus,
  ExecutionTraceRecorder,
  getTraceRecorder,
  resetTraceRecorder,
  AgentRuntime,
  MockEmbeddingFunction,
  cosineSimilarity,
  l2Distance,
  InMemoryEmbeddingStore,
  calculateMemoryScore,
  OpenAIProvider,
  AnthropicProvider,
} from './runtime';
export type { EmbeddingFunction } from './runtime';

// ============================================================================
// HTML Reporting — Human-readable reports (Phase 3)
// ============================================================================
export {
  HTMLReportRenderer,
  getHTMLReportRenderer,
  createWarRoomHTMLReport,
} from './reporting';

// ============================================================================
// Self-Evolution Engine — Meta-learning & optimization (Phase 3)
// ============================================================================
export {
  MetaLearner,
  getMetaLearner,
  resetMetaLearner,
} from './selfEvolution';

// ============================================================================
// TELOS Framework — Token-Efficient Low-waste Orchestration System (Phase 4)
// ============================================================================
export type {
  TELOSBudget,
  TokenCheckResult,
  CostRecord,
  CostSummary,
  BudgetAlert,
  TELOSPlanContext,
  TELOSAgentAssignment,
  TELOSOrchestrationMode,
  ProviderEndpoint,
  ProviderHealth,
  ProviderSelection,
  StreamChunk,
  StreamCallback,
  StreamController,
  TELOSConfig,
} from './telos/types';
export { DEFAULT_TELOS_CONFIG } from './telos/types';
export {
  TokenSentinel,
  getTokenSentinel,
  resetTokenSentinel,
  estimateTokenCount,
  estimateMessagesTokens,
  calculateCost,
  ProviderPool,
  getProviderPool,
  resetProviderPool,
  TELOSOrchestrator,
  HeuristicEvaluator,
  EvalSuite,
  getHeuristicEvaluator,
  resetHeuristicEvaluator,
  EVALUATION_DIMENSIONS,
  DEFAULT_EVAL_CRITERIA,
} from './telos';

// ============================================================================
// MCP — Model Context Protocol (Agent ↔ Tool communication standard)
// ============================================================================
export type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPContentItem,
  MCPToolResult,
  MCPResourceContents,
  MCPJsonSchema,
  MCPTransport,
  MCPClientConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2AMessage,
} from './mcp';
export {
  MCPClient,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  createMCPClient,
  MCPServer,
  MCP_ERROR_CODES,
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from './mcp';

