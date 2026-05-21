/** Current status of a project in the War Room. */
export type ProjectStatus = 'ACTIVE' | 'AT_RISK' | 'STABILIZING';
/** Operational status of an agent. */
export type AgentStatus = 'READY' | 'RUNNING' | 'BLOCKED' | 'OFFLINE';
/** Governance role assigned to an agent, defining its authority level. */
export type AgentGovernanceRole = 'COMMANDER' | 'SENATE' | 'EXECUTOR';
/** Lifecycle status of a mission. */
export type MissionStatus = 'PLANNED' | 'RUNNING' | 'BLOCKED' | 'DONE';
/** Priority level for mission execution and resource allocation. */
export type MissionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
/** Risk level associated with a mission's execution. */
export type MissionRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
/** Mode of governance for a mission, from fully autonomous to manual. */
export type MissionGovernanceMode = 'AUTO' | 'GUARDED' | 'MANUAL';
/** Standard log levels for execution tracking. */
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

/** Represents a high-level project within the Commander system. */
export interface Project {
  /** Unique project identifier. */
  id: string;
  /** Human-readable project name. */
  name: string;
  /** Short internal code name for the project. */
  codename: string;
  /** Primary objective or goal of the project. */
  objective: string;
  /** Current project status. */
  status: ProjectStatus;
  /** ISO timestamp of when the project was created. */
  createdAt: string;
  /** ISO timestamp of the last project update. */
  updatedAt: string;
}

/** Represents an AI agent participating in the system. */
export interface Agent {
  /** Unique agent identifier. */
  id: string;
  /** ID of the project this agent is assigned to. */
  projectId: string;
  /** Display name of the agent. */
  name: string;
  /** Unique callsign for the agent. */
  callsign: string;
  /** Designated functional role. */
  role: string;
  /** The LLM model powering this agent. */
  model: string;
  /** Current operational status. */
  status: AgentStatus;
  /** Area of expertise or functional specialty. */
  specialty: string;
  /** Assigned governance role. */
  governanceRole: AgentGovernanceRole;
  /** ISO timestamp of the last heartbeat received from this agent. */
  lastHeartbeatAt: string;
}

/** Persistent state and metadata for an agent. */
export interface AgentState {
  /** Associated project ID. */
  projectId: string;
  /** Target agent ID. */
  agentId: string;
  /** Optional summary of current agent state. */
  summary?: string;
  /** JSON string or text describing agent preferences. */
  preferences?: string;
  /** Arbitrary tags for filtering or categorization. */
  tags?: string[];
  /** ISO timestamp of the last state update. */
  updatedAt: string;
}

/** Defines a specific task or mission to be completed by an agent. */
export interface Mission {
  /** Unique mission identifier. */
  id: string;
  /** Associated project ID. */
  projectId: string;
  /** Short title of the mission. */
  title: string;
  /** Detailed objective of the mission. */
  objective: string;
  /** Current mission lifecycle status. */
  status: MissionStatus;
  /** Assigned priority level. */
  priority: MissionPriority;
  /** Estimated risk level. */
  riskLevel: MissionRiskLevel;
  /** Applied governance mode. */
  governanceMode: MissionGovernanceMode;
  /** ID of the agent assigned to this mission. */
  assignedAgentId: string;
  /** ISO timestamp of mission creation. */
  createdAt: string;
  /** ISO timestamp of the last mission update. */
  updatedAt: string;
  /** ISO timestamp of when the mission started. */
  startedAt?: string;
  /** ISO timestamp of mission completion. */
  completedAt?: string;
}

/** Individual log entry from an agent's execution. */
export interface ExecutionLog {
  /** Unique log identifier. */
  id: string;
  /** Associated project ID. */
  projectId: string;
  /** Associated mission ID. */
  missionId: string;
  /** ID of the agent that generated the log. */
  agentId: string;
  /** Log severity level. */
  level: LogLevel;
  /** The log message content. */
  message: string;
  /** ISO timestamp of log creation. */
  createdAt: string;
}

/** Consolidated data structure for a project's War Room. */
export interface WarRoomData {
  /** List of projects in the War Room. */
  projects: Project[];
  /** List of agents across all projects. */
  agents: Agent[];
  /** List of missions across all projects. */
  missions: Mission[];
  /** Consolidated execution logs. */
  logs: ExecutionLog[];
}

/** Statistical overview of an agent's workload and performance. */
export interface AgentWorkload {
  /** Target agent ID. */
  agentId: string;
  /** Agent display name. */
  agentName: string;
  /** Agent callsign. */
  callsign: string;
  /** Current agent status. */
  status: AgentStatus;
  /** Agent functional specialty. */
  specialty: string;
  /** Total number of missions assigned to this agent. */
  assignedMissionCount: number;
  /** Number of missions currently in progress or blocked. */
  activeMissionCount: number;
  /** Number of missions successfully completed. */
  completedMissionCount: number;
  /** ISO timestamp of the most recent log from this agent. */
  latestLogAt?: string;
}

/** Analytical report summarizing a project's operational health and progress. */
export interface ProjectBattleReport {
  /** ISO timestamp of report generation. */
  generatedAt: string;
  /** Overall health status of the project. */
  health: 'GREEN' | 'AMBER' | 'RED';
  /** Total number of agents assigned to the project. */
  totalAgents: number;
  /** Number of agents currently active (READY or RUNNING). */
  activeAgents: number;
  /** Total number of missions defined for the project. */
  totalMissions: number;
  /** Number of missions currently running. */
  runningMissionCount: number;
  /** Number of missions currently blocked. */
  blockedMissionCount: number;
  /** Number of missions marked as done. */
  completedMissionCount: number;
  /** Total log volume in the last 24 hours. */
  logVolume24h: number;
  /** Overall completion percentage (0-100). */
  completionRate: number;
  /** Number of high or critical risk missions. */
  highRiskMissionCount: number;
  /** Number of missions requiring manual governance/approval. */
  manualGovernanceMissionCount: number;
  /** Top performing agents by completed mission count. */
  topAgents: Array<{
    agentId: string;
    agentName: string;
    completedMissionCount: number;
  }>;
  /** Human-readable narrative summarizing the project state. */
  narrative: string;
}

/** A comprehensive point-in-time snapshot of a project's War Room state. */
export interface ProjectWarRoomSnapshot {
  /** The base project metadata. */
  project: Project;
  /** Workload and status details for all project agents. */
  agents: AgentWorkload[];
  /** Full list of project missions. */
  missions: Mission[];
  /** Most recent execution logs for the project. */
  latestLogs: ExecutionLog[];
  /** The latest generated battle report. */
  battleReport: ProjectBattleReport;
}

/** Classification for different types of project-level memory. */
export type ProjectMemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';

/**
 * Memory duration classification (Research finding from Langflow 2025)
 * - EPISODIC: Short-term, session-scoped memory (per-session, expires after session)
 * - LONG_TERM: Persistent memory that survives across sessions (decisions, lessons)
 */
export type MemoryDuration = 'EPISODIC' | 'LONG_TERM';

/** Individual item stored in the project's persistent memory. */
export interface ProjectMemoryItem {
  /** Unique memory item identifier. */
  id: string;
  /** Associated project ID. */
  projectId: string;
  /** Optional associated mission ID. */
  missionId?: string;
  /** Optional associated agent ID. */
  agentId?: string;
  /** The kind of memory being stored. */
  kind: ProjectMemoryKind;
  /** Short title or summary of the memory. */
  title: string;
  /** Full content of the memory item. */
  content: string;
  /** Tags for categorization and retrieval. */
  tags: string[];
  /** ISO timestamp of memory creation. */
  createdAt: string;
  /** Memory duration classification (v2) */
  duration?: MemoryDuration;
}

/** Statistical overview of project memory usage. */
export interface ProjectMemoryOverview {
  /** Total number of items in memory. */
  totalItems: number;
  /** Count of memory items grouped by kind. */
  kindCounts: Record<ProjectMemoryKind, number>;
  /** Most frequently used tags. */
  topTags: Array<{
    tag: string;
    count: number;
  }>;
  /** Number of memory items linked to specific missions. */
  missionLinkedCount: number;
  /** Number of memory items linked to specific agents. */
  agentLinkedCount: number;
  /** ISO timestamp of the most recent memory creation. */
  latestCreatedAt?: string;
}

/** Contextual data provided to a Commander run. */
export interface CommanderRunContext {
  /** Project ID for the run. */
  projectId: string;
  /** Current War Room snapshot. */
  snapshot: ProjectWarRoomSnapshot;
  /** List of recent memory items relevant to the run. */
  recentMemory: ProjectMemoryItem[];
  /** Optional ID of the agent performing the run. */
  agentId?: string;
  /** Optional ID of the mission the run is focused on. */
  missionId?: string;
}

/** The intended action or phase for a Commander invocation. */
export type CommanderRunIntent = 'PLAN' | 'PROPOSE' | 'EXECUTE' | 'REVIEW' | 'MONITOR';

/** The resulting disposition of an invocation request. */
export type CommanderInvocationDisposition =
  | 'ALLOW_EXECUTION'
  | 'REQUIRE_APPROVAL'
  | 'PROPOSE_ONLY'
  | 'DENY';

/** Atomic operations that an agent can perform within the system. */
export type CommanderOperation =
  | 'READ_CONTEXT'
  | 'WRITE_LOG'
  | 'UPDATE_MISSION_STATUS'
  | 'UPDATE_MISSION_FIELDS'
  | 'WRITE_MEMORY'
  | 'UPDATE_AGENT_STATE'
  | 'REQUEST_APPROVAL';

/** Lightweight representation of an agent for roster displays. */
export interface CommanderAgentCard {
  /** Agent identifier. */
  id: string;
  /** Project identifier. */
  projectId: string;
  /** Display name. */
  name: string;
  /** Agent callsign. */
  callsign: string;
  /** Current status. */
  status: AgentStatus;
  /** Functional specialty. */
  specialty: string;
  /** Assigned governance role. */
  governanceRole: AgentGovernanceRole;
  /** Optional LLM model identifier. */
  model?: string;
  /** Optional functional role description. */
  role?: string;
}

/** Lightweight mission representation for board views. */
export interface SlimMissionCard {
  /** Mission identifier. */
  id: string;
  /** Mission title. */
  title: string;
  /** Mission objective. */
  objective: string;
  /** Current status. */
  status: MissionStatus;
  /** Assigned priority. */
  priority: MissionPriority;
  /** Risk level. */
  riskLevel: MissionRiskLevel;
  /** Governance mode. */
  governanceMode: MissionGovernanceMode;
  /** ID of the assigned agent. */
  assignedAgentId: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

/** Compressed log entry for feed displays. */
export interface SlimLogLine {
  /** Log identifier. */
  id: string;
  /** Log level. */
  level: LogLevel;
  /** Log message. */
  message: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Associated mission ID. */
  missionId: string;
  /** ID of the agent that generated the log. */
  agentId: string;
}

/** High-density snapshot optimized for UI rendering and token efficiency. */
export interface SlimSnapshot {
  /** Subset of project metadata. */
  project: Pick<Project, 'id' | 'codename' | 'objective' | 'status' | 'updatedAt'>;
  /** The mission currently in focus, if any. */
  focusMission?: SlimMissionCard;
  /** Missions categorized by status lane. */
  missionBoard: {
    running: SlimMissionCard[];
    blocked: SlimMissionCard[];
    planned: SlimMissionCard[];
    done: SlimMissionCard[];
  };
  /** Core metrics for health and progress tracking. */
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
  /** Most recent logs. */
  latestLogs?: SlimLogLine[];
}

/** Meta-information about a Commander run. */
export interface CommanderRunMeta {
  /** Unique run identifier. */
  runId: string;
  /** ISO timestamp of issuance. */
  issuedAt: string;
  /** Entity that initiated the run. */
  issuedBy?: {
    /** Kind of entity (Human, Agent, or System). */
    kind: 'HUMAN' | 'AGENT' | 'SYSTEM';
    /** ID of the issuer. */
    id?: string;
    /** Human-readable label for the issuer. */
    label?: string;
  };
}

/** A collection of memory items recommended for a specific context. */
export interface RecommendedMemorySlice {
  /** The selected memory items. */
  items: ProjectMemoryItem[];
  /**
   * Optional tags used when selecting this slice. This is a hint for callers
   * to understand为什么这些记忆被选中，而不是语义搜索的原始参数。
   */
  sourceTags?: string[];
}

/** Guidance provided to the orchestrator for a specific run. */
export interface CommanderRunGuidance {
  /** The invocation profile defining permissions and constraints. */
  invocationProfile?: AgentInvocationProfile;
  /** The recommended multi-agent strategy. */
  strategy?: MultiAgentStrategy;
}

/** Comprehensive context for V2 Commander runs, optimized for token usage and multi-agent flows. */
export interface CommanderRunContextV2 {
  /** Target project ID. */
  projectId: string;
  /** Metadata about the current run. */
  run: CommanderRunMeta;
  /** Optional focal points for the run. */
  focus?: {
    /** Focused agent ID. */
    agentId?: string;
    /** Focused mission ID. */
    missionId?: string;
    /** Intent of the run. */
    intent?: CommanderRunIntent;
  };
  /** Efficient snapshot of the project state. */
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
  /** Full roster of agents available for the project. */
  agentRoster: CommanderAgentCard[];
}

/** Configuration options for creating a slim snapshot. */
export interface CreateSlimSnapshotOptions {
  /** Optional ID of the mission to focus on. */
  focusMissionId?: string;
  /** Maximum number of missions to include per status bucket. */
  maxMissionsPerBucket?: number;
  /** Maximum number of logs to include. */
  maxLogs?: number;
}

/**
 * Creates a token-efficient slim snapshot from a full project snapshot.
 * 
 * @param snapshot The full project War Room snapshot.
 * @param options Options to control limits and focus.
 * @returns A compressed slim snapshot.
 */
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

/** Token budget configuration for an agent. */
export interface TokenBudget {
  /** Maximum number of tokens allowed. */
  maxTokens: number;
  /** Percentage (e.g., 80 for 80%) at which a warning is triggered. */
  warningThreshold: number;
  /** Estimated burn rate of tokens. */
  burnRate?: 'low' | 'medium' | 'high';
}

/** Permissions and operational constraints for a specific agent invocation. */
export interface AgentInvocationProfile {
  /** Target agent ID. */
  agentId: string;
  /** Intent of the run. */
  intent: CommanderRunIntent;
  /** Optional mission ID being executed. */
  missionId?: string;
  /** Resulting disposition for this invocation. */
  disposition: CommanderInvocationDisposition;
  /** Operations that the agent is allowed to perform. */
  allowedOperations: CommanderOperation[];
  /** Operations that are explicitly forbidden. */
  forbiddenOperations: CommanderOperation[];
  /** Approval requirements if applicable. */
  approval?: {
    /** Whether approval is mandatory. */
    required: boolean;
    /** Roles authorized to grant approval. */
    requiredRoles: AgentGovernanceRole[];
    /** Minimum number of approvals needed. */
    minApprovals: number;
  };
  /** Rationale behind the generated profile. */
  rationale: string[];
  /** Token budget control (v1) */
  tokenBudget?: TokenBudget;
}

/** Input for determining mission governance disposition. */
interface MissionGovernanceDispositionInput {
  /** The agent being evaluated. */
  agent: CommanderAgentCard;
  /** The mission being targeted. */
  mission?: SlimMissionCard;
  /** The intended action. */
  intent: CommanderRunIntent;
}

/** Disposition resulting from governance evaluation. */
interface MissionGovernanceDisposition {
  /** Final disposition for the invocation. */
  disposition: CommanderInvocationDisposition;
  /** Supporting rationale for the decision. */
  rationale: string[];
  /** Optional approval configuration. */
  approval?: AgentInvocationProfile['approval'];
}

/**
 * Determines the governance disposition for a mission based on risk and mode.
 * 
 * @param input Evaluation input including agent and mission details.
 */
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

/**
 * Generates the default invocation profile for an agent in a specific context.
 * 
 * @param input Details about the agent, mission, and intent.
 * @returns An invocation profile defining allowed operations and constraints.
 */
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

/** Available strategies for multi-agent coordination. */
export type MultiAgentStrategyKind =
  | 'SINGLE_AGENT'
  | 'GUARDED_EXECUTION'
  | 'SENATE_REVIEW'
  | 'MANUAL_APPROVAL_GATE'
  | 'FANOUT_PLAN';

/** Defines how agents collaborate to achieve a mission's goal. */
export interface MultiAgentStrategy {
  /** The specific kind of orchestration strategy. */
  kind: MultiAgentStrategyKind;
  /** Primary agent responsible for the mission. */
  primaryAgentId?: string;
  /** List of agents authorized to execute tasks. */
  executorAgentIds?: string[];
  /** List of agents assigned to review execution. */
  reviewerAgentIds?: string[];
  /** Approval requirements for this strategy. */
  approval?: {
    /** Whether approval is required before execution. */
    required: boolean;
    /** Roles authorized to grant approval. */
    requiredRoles: AgentGovernanceRole[];
    /** Minimum number of approvals needed. */
    minApprovals: number;
  };
  /** Rationale for choosing this specific strategy. */
  rationale: string[];
}

// Orchestration exports
export {
  /** Individual step in a sequential pipeline. */
  SequentialStep,
  /** Execution context shared across sequential steps. */
  SequentialContext,
  /** Result of a single sequential step execution. */
  SequentialStepResult,
  /** Lifecycle status of a sequential pipeline. */
  SequentialPipelineStatus,
  /** Defines a linear execution flow of multiple steps. */
  SequentialPipeline,
  /** Represents a specific execution instance of a sequential pipeline. */
  SequentialPipelineRun,
  /** Event emitted during pipeline execution. */
  SequentialEvent,
  /** Handler function for sequential events. */
  SequentialEventHandler,
  /** Fluent builder for constructing sequential pipelines. */
  SequentialPipelineBuilder,
  /** Metrics collected during orchestration. */
  OrchestrationMetrics,
  /** Calculates metrics for a given orchestration run. */
  calculateOrchestrationMetrics,
  /** Token usage statistics. */
  TokenUsage,
} from './orchestration';

// Memory exports (re-export from memory module)
// Note: MemoryKind (as ProjectMemoryKind) and MemoryDuration are already exported above
export {
  /** Priority level for memory retention and retrieval. */
  MemoryPriority,
  /** Short-term, session-scoped memory item. */
  EpisodicMemoryItem,
  /** Structure for querying the memory store. */
  MemorySearchQuery,
  /** Result of a memory search operation. */
  MemorySearchResult,
  /** Options for writing new memory items. */
  MemoryWriteOptions,
  /** Options for managing existing memory (pruning, updating). */
  MemoryManageOptions,
  /** Statistical overview of memory store health. */
  MemoryStats,
  /** Interface for memory persistence and retrieval. */
  MemoryStore,
  /** In-memory implementation of the memory store. */
  InMemoryMemoryStore,
  /** File-backed JSON implementation of the memory store. */
  JsonMemoryStore,
  /** Factory function for creating memory stores. */
  createMemoryStore,
  /** Converts a ProjectMemoryItem to an internal EpisodicMemoryItem. */
  fromProjectMemoryItem,
  /** Converts an internal memory item to a ProjectMemoryItem. */
  toProjectMemoryItem,
} from './memory';

/** Alias for ProjectMemoryKind for developer convenience. */
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
 * 
 * @param complexity Measured task complexity.
 * @param options Decision options.
 * @returns Object indicating if decomposition is recommended and the reason.
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
 * Get decomposition recommendation for a mission based on current run context.
 * 
 * @param mission The mission to evaluate.
 * @param context Current execution context.
 * @returns Recommendation including complexity analysis.
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
  /** Mode of orchestration (Single, Multi-agent, etc.) */
  OrchestrationMode,
  /** Decision made by the orchestrator regarding task execution. */
  OrchestrationDecision,
  /** Allocation of token budget across agents or phases. */
  TokenBudgetAllocation,
  /** Configuration for different model tiers (Low, Medium, High). */
  ModelTierConfig,
  /** Default configuration for model routing and selection. */
  DEFAULT_MODEL_CONFIG,
  
  /** Represents an allocated portion of the token budget. */
  AllocatedBudget,
  /** A quality gate interface for verifying execution results. */
  QualityGate,
  /** Executor for running quality gate checks. */
  QualityGateExecutor,
  /** Result of a quality gate verification. */
  QualityGateResult,
} from './ultimate';
/** Orchestrator that adapts its behavior based on task complexity and feedback. */
export { AdaptiveOrchestrator } from './adaptiveOrchestrator';
/** Allocator for managing and distributing token budgets. */
export { TokenBudgetAllocator } from './tokenBudgetAllocator';

// ============================================================================
// Ultimate Multi-Agent Orchestration System (v2)
// The world's most advanced multi-agent orchestration platform
// ============================================================================
export {
  /** The main entry point for the Ultimate orchestration framework. */
  UltimateOrchestrator,
  /** Deliberates on a task to produce an execution plan. */
  deliberate,
  /** Atomizes complex tasks into smaller, manageable subtasks. */
  RecursiveAtomizer,
  /** Routes tasks to appropriate topologies based on requirements. */
  TopologyRouter,
  /** Executes subtasks using assigned agents. */
  SubAgentExecutor,
  /** Synthesizes results from multiple agents into a unified output. */
  MultiAgentSynthesizer,
  /** Core system for managing execution artifacts. */
  ArtifactSystem,
  /** Retrieves the singleton artifact system instance. */
  getArtifactSystem,
  /** Resets the artifact system state. */
  resetArtifactSystem,
  /** Registry of agent capabilities and tools. */
  CapabilityRegistry,
  /** Retrieves the singleton capability registry instance. */
  getCapabilityRegistry,
  /** Manages persistent teams of agents. */
  AgentTeamManager,
  /** Retrieves the singleton agent team manager instance. */
  getTeamManager,
  /** Retrieves effort scaling rules for orchestration. */
  getEffortRules,
  /** Classifies the effort level required for a task. */
  classifyEffortLevel,
  /** Selects the optimal topology for a given effort level. */
  selectTopologyForEffort,
} from './ultimate/index';

export type {
  /** Supported orchestration topologies (Single, Parallel, etc.). */
  OrchestrationTopology,
  /** Directed Acyclic Graph representation of a task plan. */
  TaskDAG,
  /** Individual node in a task DAG. */
  TaskDAGNode,
  /** Directed edge in a task DAG defining dependencies. */
  TaskDAGEdge,
  /** Plan resulting from the deliberation phase. */
  DeliberationPlan,
  /** Node in a hierarchical task tree. */
  TaskTreeNode,
  /** Reference to a stored artifact. */
  ArtifactReference,
  /** Represents a collaborative team of agents. */
  AgentTeam,
  /** Individual member of an agent team. */
  TeamMember,
  /** A task shared among multiple agents. */
  SharedTask,
  /** Message in an agent's asynchronous inbox. */
  InboxMessage,
  /** Vector representing agent capabilities for matching. */
  CapabilityVector,
  /** Definition of a specific agent capability. */
  AgentCapability,
  /** Level of effort required for task completion. */
  EffortLevel,
  /** Rules defining how resources scale with effort level. */
  EffortScalingRules,
  /** Token budget for LLM thinking/reasoning steps. */
  ThinkingBudget,
  /** Strategy for synthesizing multi-agent outputs. */
  SynthesisStrategy,
  /** Configuration for the synthesis process. */
  SynthesisConfig,
  /** Configuration for quality gate verification. */
  QualityGateConfig,
  /** Execution context for the Ultimate orchestrator. */
  UltimateExecutionContext,
  /** Result of an Ultimate orchestration run. */
  UltimateExecutionResult,
  /** Metrics collected during Ultimate orchestration. */
  UltimateMetrics,
  /** Error occurred during execution. */
  ExecutionError,
  /** Configuration for the Ultimate Orchestrator. */
  UltimateOrchestratorConfig,
} from './ultimate/index';

export {
  /** Default thinking budget for orchestration. */
  DEFAULT_THINKING_BUDGET,
  /** Default configuration for result synthesis. */
  DEFAULT_SYNTHESIS_CONFIG,
  /** Default configuration for the Ultimate framework. */
  DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// ============================================================================
// Tools — Web Search, File System, Code Execution
// ============================================================================
export {
  /** Tool for performing web searches. */
  WebSearchTool,
  /** Tool for fetching content from URLs. */
  WebFetchTool,
  /** Tool for reading files from the local filesystem. */
  FileReadTool,
  /** Tool for writing files to the local filesystem. */
  FileWriteTool,
  /** Tool for editing files via string replacement. */
  FileEditTool,
  /** Tool for searching file contents via regex. */
  FileSearchTool,
  /** Tool for listing files in a directory. */
  FileListTool,
  /** Tool for executing Python code in a sandbox. */
  PythonExecuteTool,
  /** Tool for executing shell commands. */
  ShellExecuteTool,
  /** Factory to create all standard tools. */
  createAllTools,
  /** A meta-tool that can orchestrate other tools. */
  MetaTool,
  /** Retrieves built-in meta-tool specifications. */
  getBuiltinMetaSpecs,
  /** Finds a matching meta-tool specification for a task. */
  findMatchingMetaSpec,
  /** Registry for managing and retrieving tools. */
  ToolRegistry,
  /** Categorization of available tools. */
  TOOL_CATEGORIES,
} from './tools/index';
export type { 
  /** Specification for a meta-tool. */
  MetaToolSpec, 
  /** Individual step in a meta-tool execution. */
  MetaToolStep, 
  /** Definition of an agent for tool-based orchestration. */
  AgentDef 
} from './tools/index';

// ============================================================================
// Agent Loop — Persistent multi-agent execution
// ============================================================================
/** Controller for running a persistent multi-agent execution loop. */
export { CommanderAgentLoop } from './agentLoop';
/** Configuration for the agent execution loop. */
export type { AgentLoopConfig } from './agentLoop';

// Goal module — multi-agent goal-driven execution loop
export { GoalOrchestrator } from './goal/goalOrchestrator';
export type {
  GoalNode, GoalConfig, GoalResult, RoundLedger, RoundDecision,
  ManagerDecomposition, ManagerReview, CriticOutput,
  CritiqueResult, CritiqueFinding, CritiqueCategory,
} from './goal/types';

/**
 * Recommends a multi-agent orchestration strategy based on context and mission risk.
 * 
 * @param context Current execution context and project snapshot.
 * @returns A recommended orchestration strategy.
 */
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
  /** Scanner for identifying sensitive or forbidden content in messages. */
  ContentScanner,
  /** Default implementation of the ContentScanner interface. */
  DefaultContentScanner,
  /** Factory function for creating a content scanner instance. */
  createContentScanner,
  /** Utility function for scanning content with default settings. */
  scanContent,
} from './contentScanner';

// Configuration Validation
export {
  /** Creates a validation schema for configuration objects. */
  createSchema, 
  /** Validates a configuration object against a schema. */
  validateConfig, 
  /** Merges user configuration with default values. */
  mergeWithDefaults,
  /** Validates the main runtime configuration. */
  validateRuntimeConfig, 
  /** Validates the HTTP server configuration. */
  validateHttpServerConfig, 
  /** Validates an individual configuration field. */
  validateField,
} from './runtime/configValidator';
export type {
  /** Supported field types for configuration. */
  FieldType, 
  /** Definition of a single configuration field. */
  ConfigField, 
  /** Full schema for a configuration object. */
  ConfigSchema, 
  /** Result of a configuration validation operation. */
  ConfigValidationResult, 
  /** Individual error found during configuration validation. */
  ConfigValidationError,
} from './runtime/configValidator';

// Authentication & Authorization
export {
  /** Manager for handling authentication and authorization roles. */
  AuthManager, 
  /** Retrieves the singleton authentication manager instance. */
  getAuthManager, 
  /** Resets the authentication manager state. */
  resetAuthManager, 
  /** Defined hierarchy of authorization roles. */
  ROLE_HIERARCHY,
} from './runtime/authManager';
export type {
  /** Valid authorization roles in the system. */
  AuthRole, 
  /** Represents an authenticated user. */
  AuthUser, 
  /** Entry for an API key in the authorization store. */
  ApiKeyEntry,
} from './runtime/authManager';

// Webhook Dispatcher
export {
  /** Dispatcher for sending asynchronous webhook notifications. */
  WebhookDispatcher, 
  /** Retrieves the singleton webhook dispatcher instance. */
  getWebhookDispatcher, 
  /** Resets the webhook dispatcher state. */
  resetWebhookDispatcher,
} from './runtime/webhookDispatcher';
export type {
  /** Configuration for a specific webhook endpoint. */
  WebhookConfig, 
  /** Represents an event to be dispatched via webhook. */
  WebhookEvent, 
  /** Tracking information for a webhook delivery attempt. */
  WebhookDelivery,
} from './runtime/webhookDispatcher';

// OpenTelemetry Exporter
export {
  /** Exporter for sending execution traces to OpenTelemetry collectors. */
  OpenTelemetryExporter, 
  /** Retrieves the singleton OTel exporter instance. */
  getOTelExporter, 
  /** Resets the OTel exporter state. */
  resetOTelExporter,
} from './runtime/openTelemetryExporter';
export type {
  /** Configuration for the OpenTelemetry exporter. */
  OTelExporterConfig, 
  /** Represents an individual trace span. */
  OTelSpan,
} from './runtime/openTelemetryExporter';

// Ultimate Framework - Additional Components (Phase 1)
/** High-performance three-layer memory system (Episodic, Working, Long-term). */
export { ThreeLayerMemory } from './threeLayerMemory';

// Logging & Metrics (Phase 2)
export {
  /** Parses structured output from LLMs using defined schemas. */
  parseStructuredOutput,
  /** Validates that LLM output conforms to a required structure. */
  validateStructuredOutput,
} from './runtime/structuredOutput';
export { 
  /** Manages context window limits and token compaction. */
  ContextWindowManager, 
  /** Estimates total tokens in a message history. */
  estimateTotalTokens 
} from './runtime/contextWindow';
export type { 
  /** Configuration for context window management. */
  ContextWindowConfig, 
  /** Action to take when context window limits are reached. */
  WindowAction 
} from './runtime/contextWindow';

 export { 
   /** System logger for structured diagnostic output. */
   Logger, 
   /** Collector for Prometheus-compatible metrics. */
   MetricsCollector, 
   /** Retrieves the global logger instance. */
   getGlobalLogger, 
   /** Retrieves the global metrics collector instance. */
   getGlobalMetrics 
 } from './logging';

// Error Handler (Phase 2)
export { 
  /** Global error handler for the Commander framework. */
  ErrorHandler, 
  /** Base class for all Commander-specific errors. */
  CommanderError, 
  /** Error indicating task complexity issues. */
  TaskComplexityError, 
  /** Error occurred during multi-agent orchestration. */
  OrchestrationError, 
  /** Error indicating that the token budget has been exhausted. */
  BudgetExhaustedError, 
  /** Error occurred during memory operations. */
  MemoryError, 
  /** Error occurred during consensus checking. */
  ConsensusError, 
  /** Error occurred during agent inspection. */
  InspectionError 
} from './errorHandler';

export { 
  /** Initializes the full Commander framework with default settings. */
  initializeFramework, 
  /** Retrieves the active framework instance. */
  getFramework, 
  /** Creates an execution plan for a specific goal. */
  createExecutionPlan, 
  /** Allocates token budget for a run. */
  allocateBudget, 
  /** Records an item into the project's memory. */
  recordMemory, 
  /** Queries project memory for relevant information. */
  queryMemory, 
  /** Starts a post-execution reflection session. */
  startReflection, 
  /** Completes an active reflection session. */
  completeReflection, 
  /** Runs a consensus check across multiple agent outputs. */
  runConsensusCheck, 
  /** Updates the health status of a framework component. */
  updateComponentHealth, 
  /** Runs an inspection on an agent's state or behavior. */
  runInspection 
} from "./frameworkIntegration";

// Hallucination Detector
export { 
  /** Detector for identifying potential hallucinations in LLM responses. */
  HallucinationDetector, 
  /** Retrieves the global hallucination detector instance. */
  getHallucinationDetector 
} from './hallucinationDetector';
export type { 
  /** Signal used to detect potential hallucinations. */
  HallucinationSignal, 
  /** Detailed report of detected hallucinations. */
  HallucinationReport 
} from './hallucinationDetector';

// ============================================================================
// Runtime System — Agent Execution Engine (Phase 3)
// ============================================================================
export type {
  /** Individual message in an LLM conversation. */
  LLMMessage,
  /** Request sent to an LLM provider. */
  LLMRequest,
  /** Response received from an LLM provider. */
  LLMResponse,
  /** Interface for implementing an LLM model provider. */
  LLMProvider,
  /** Configuration for tool result caching. */
  CacheConfig,
  /** Statistics on cache usage for a run. */
  CacheUsage,
  /** Metadata defining a tool's parameters and purpose. */
  ToolDefinition,
  /** Request to call a specific tool. */
  ToolCall,
  /** Result returned by a tool execution. */
  ToolResult,
  /** Interface for implementing a system tool. */
  Tool,
  /** Classification of model tiers by capability. */
  ModelTier,
  /** Configuration for a specific LLM model. */
  ModelConfig,
  /** Decision made by the model router. */
  RoutingDecision,
  /** Execution context for an individual agent run. */
  AgentExecutionContext,
  /** Single step within an agent's execution loop. */
  AgentExecutionStep,
  /** Final result of an agent's execution run. */
  AgentExecutionResult,
  /** Main configuration for the agent runtime. */
  AgentRuntimeConfig,
  /** Topics available on the internal message bus. */
  MessageBusTopic,
  /** Priorities for messages on the bus. */
  MessagePriority as BusMessagePriority,
  /** Message transmitted over the internal bus. */
  BusMessage,
  /** Handler function for bus messages. */
  MessageHandler,
  /** Individual event within an execution trace. */
  TraceEvent,
  /** Full trace of an agent's execution. */
  ExecutionTrace,
  /** Individual section within an HTML report. */
  HTMLReportSection,
  /** Data structure for generating an HTML report. */
  HTMLReport,
  /** Summary of the experience gained during a run. */
  ExecutionExperience,
  /** Suggestion for optimizing future runs. */
  OptimizationSuggestion,
  /** Performance metrics for an orchestration strategy. */
  StrategyPerformance,
} from './runtime/types';
export {
   /** Routes requests to the optimal LLM provider and model. */
   ModelRouter,
   /** Retrieves the singleton model router instance. */
   getModelRouter,
   /** Resets the model router state. */
   resetModelRouter,
   /** Internal message bus for inter-agent communication. */
   MessageBus,
   /** Retrieves the singleton message bus instance. */
   getMessageBus,
   /** Resets the message bus state. */
   resetMessageBus,
   /** Recorder for capturing detailed execution traces. */
   ExecutionTraceRecorder,
   /** Retrieves the singleton trace recorder instance. */
   getTraceRecorder,
   /** Resets the trace recorder state. */
   resetTraceRecorder,
   /** Core runtime engine for agent execution. */
   AgentRuntime,
   /** Mock implementation of an embedding function for testing. */
   MockEmbeddingFunction,
   /** Calculates cosine similarity between two vectors. */
   cosineSimilarity,
   /** Calculates L2 distance between two vectors. */
   l2Distance,
   /** Simple in-memory store for vector embeddings. */
   InMemoryEmbeddingStore,
   /** Calculates a relevance score for a memory item. */
   calculateMemoryScore,
   /** Provider for OpenAI models. */
   OpenAIProvider,
   /** Provider for Anthropic Claude models. */
   AnthropicProvider,
   /** Provider for Google Gemini models. */
   GoogleProvider,
   /** Provider for OpenRouter aggregator. */
   OpenRouterProvider,
   /** Provider for DeepSeek models. */
   DeepSeekProvider,
   /** Provider for Zhipu GLM models. */
   GLMProvider,
   /** Provider for MiMo models. */
   MiMoProvider,
   /** Provider for Xiaomi models. */
   XiaomiProvider,
   /** Runtime implementation for interacting with remote MCP servers. */
   MCPRemoteRuntime,
   /** Stream implementation for Server-Sent Events. */
   SSEStream,
   /** Selects the most relevant tools for a given task. */
   selectTools,
   /** Calculates relevance scores for tools based on task description. */
   getToolRelevanceScores,
   /** Retrieves the category for a specific tool. */
   getToolCategory,
   /** Determines if an LLM response meets confidence thresholds. */
   isConfidentResponse,
   /** Determines if a response provides significant new information. */
   hasInformationGain,
   /** Tracker for identifying recurring patterns in agent behavior. */
   PatternTracker,
   /** Retrieves the singleton pattern tracker instance. */
   getPatternTracker,
   /** Resets the pattern tracker state. */
   resetPatternTracker,
   /** Plans speculative execution of multiple steps to reduce latency. */
   planSpeculativeExecution,
   /** Determines if a speculative execution plan is safe to run. */
   isSpeculativelySafe,
} from './runtime';
export type { 
  /** Interface for vector embedding functions. */
  EmbeddingFunction, 
  /** Configuration for automated tool retrieval. */
  ToolRetrievalConfig, 
  /** Configuration for entropy-based response gating. */
  EntropyGatingConfig, 
  /** Configuration for speculative execution. */
  SpeculativeExecutionConfig 
} from './runtime';

// ============================================================================
// HTML Reporting — Human-readable reports (Phase 3)
// ============================================================================
export {
  /** Renderer for generating professional HTML reports from execution traces. */
  HTMLReportRenderer,
  /** Retrieves the singleton HTML report renderer instance. */
  getHTMLReportRenderer,
  /** Utility function to create a project War Room report. */
  createWarRoomHTMLReport,
} from './reporting';

// ============================================================================
// Self-Evolution Engine — Meta-learning & optimization (Phase 3)
// ============================================================================
export { 
  /** Engine for analyzing past runs and generating optimization strategies. */
  MetaLearner, 
  /** Retrieves the singleton meta-learner instance. */
  getMetaLearner, 
  /** Resets the meta-learner state. */
  resetMetaLearner 
} from './selfEvolution/metaLearner';
export { 
  /** Engine for post-run reflection and lesson extraction. */
  ReflectionEngine, 
  /** Factory for creating reflection engines. */
  createReflectionEngine, 
  /** Retrieves the global reflection engine instance. */
  getGlobalReflectionEngine 
} from './reflectionEngine';
export { 
  /** Checker for verifying consensus among multiple agent outputs. */
  ConsensusChecker, 
  /** Factory for creating consensus checkers. */
  createConsensusChecker 
} from './consensusCheck';

/** Agent specialized in inspecting and auditing other agents' behavior. */
export { InspectorAgent, createInspector } from './inspectorAgent';
/** Analyzer for measuring task complexity and recommending decomposition. */
export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// ============================================================================
// Runtime Enhancements — Agent Execution Improvements
// ============================================================================
/** Detects cycles or infinite loops in agent reasoning or tool calls. */
export { CycleDetector } from './runtime/cycleDetector';
export { 
  /** Tool approval configuration. */
  ToolApproval, 
  /** Request for human or automated tool approval. */
  ApprovalRequest, 
  /** Result of an approval request. */
  ApprovalResult, 
  /** Level of approval required (Auto, Manual, etc.). */
  ApprovalLevel, 
  /** Policy defining approval requirements for tools. */
  ApprovalPolicy, 
  /** Standard set of default approval policies. */
  DEFAULT_APPROVAL_POLICIES 
} from './runtime/toolApproval';
export { 
  /** Engine for running evolutionary workflows that improve over time. */
  EvolutionaryWorkflowEngine, 
  /** Directed Acyclic Graph representing an evolutionary workflow. */
  WorkflowDAG, 
  /** Individual node in a workflow DAG. */
  WorkflowNode, 
  /** dependency edge in a workflow DAG. */
  WorkflowEdge, 
  /** Result of an evolutionary workflow run. */
  EvolutionResult, 
  /** Options for the evolutionary workflow engine. */
  EvolutionOptions 
} from './runtime/evolutionaryWorkflowEngine';
/** HTTP server providing a REST API and real-time streaming for Commander. */
export { CommanderHttpServer, createHttpServer } from './runtime/httpServer';
/** Base class for implementing communication channel adapters (Slack, Discord, etc.). */
export { BaseChannelAdapter } from './runtime/channelAdapter';

// Unified Verification Pipeline — tiered zero-cost-first verification
export { 
  /** Tiered pipeline for verifying task completion and quality. */
  UnifiedVerificationPipeline, 
  /** Detects the type of task for optimized verification. */
  detectTaskType 
} from './runtime/unifiedVerification';
export type { 
  /** Signal used for task verification. */
  VerificationSignal, 
  /** Detailed report of verification results. */
  VerificationReport, 
  /** Context provided to the Unified Verification Pipeline. */
  UVPTaskContext, 
  /** Configuration for the verification pipeline. */
  UVPConfig, 
  /** Supported task types for verification. */
  TaskType 
} from './runtime/unifiedVerification';

// Token Budget Governor — central token optimization coordinator
export { 
  /** Central coordinator for token budget enforcement and optimization. */
  TokenGovernor, 
  /** Retrieves the singleton token governor instance. */
  getTokenGovernor, 
  /** Resets the token governor state. */
  resetTokenGovernor 
} from './runtime/tokenGovernor';
export type { 
  /** Strategy for token optimization. */
  OptimizationStrategy, 
  /** Current state of a token budget. */
  BudgetState, 
  /** Decision made by the token governor. */
  GovernorDecision, 
  /** Configuration for the token governor. */
  GovernorConfig, 
  /** Categorization of tasks for budget allocation. */
  TaskCategory 
} from './runtime/tokenGovernor';

// Tool Calling Infrastructure — surpasses all 5 competitors
export { 
  /** Cache for storing and retrieving tool execution results. */
  ToolResultCache 
} from './runtime/toolResultCache';
export type { 
  /** Configuration for the tool result cache. */
  ToolCacheConfig, 
  /** Statistics on tool cache performance. */
  ToolCacheStats 
} from './runtime/toolResultCache';
export { 
  /** Manages tool output to ensure it fits within context limits. */
  ToolOutputManager 
} from './runtime/toolOutputManager';
export type { 
  /** Configuration for the tool output manager. */
  ToolOutputConfig, 
  /** Represents a managed tool output. */
  ManagedOutput, 
  /** Budget state for a single execution turn. */
  TurnBudgetState 
} from './runtime/toolOutputManager';
export { 
  /** Orchestrates complex tool execution plans with dependency management. */
  ToolOrchestrator 
} from './runtime/toolOrchestrator';
export type { 
  /** Configuration for the tool orchestrator. */
  OrchestratorConfig, 
  /** Result of an orchestrated tool execution. */
  OrchestratedResult, 
  /** Execution plan for multiple tools. */
  ToolExecutionPlan, 
  /** Context for a tool execution step. */
  ToolExecutionContext 
} from './runtime/toolOrchestrator';
export { 
  /** Manager for controlling tool availability based on rules. */
  ToolAvailabilityManager, 
  /** Evaluates an availability expression. */
  evaluate, 
  /** Boolean AND operator for availability rules. */
  allOf, 
  /** Boolean OR operator for availability rules. */
  anyOf, 
  /** Boolean NOT operator for availability rules. */
  not, 
  /** Always true availability rule. */
  always, 
  /** Always false availability rule. */
  never, 
  /** Rule that limits tool use in early execution steps. */
  earlySteps, 
  /** Rule that checks if the token budget is relaxed. */
  budgetRelaxed, 
  /** Rule that checks if the budget is not critical. */
  budgetNotCritical, 
  /** Expression to check task type. */
  taskType as taskTypeExpr, 
  /** Rule that checks if a tool has not yet been used. */
  notYetUsed, 
  /** Rule that checks if a task requires a specific tool. */
  requiresTool, 
  /** Rule that limits tool use after a maximum number of errors. */
  maxErrors, 
  /** Factory for creating default tool availability rules. */
  createDefaultRules 
} from './runtime/toolAvailability';
export type { 
  /** Context provided to availability rules. */
  AvailabilityContext, 
  /** DSL expression for defining tool availability. */
  AvailabilityExpression, 
  /** Individual rule for tool availability. */
  ToolAvailabilityRule 
} from './runtime/toolAvailability';
export { 
  /** Planner for generating optimal tool execution sequences. */
  ToolPlanner 
} from './runtime/toolPlanner';
export type { 
  /** Generated plan for tool execution. */
  ExecutionPlan, 
  /** Individual stage in a tool execution plan. */
  ExecutionStage, 
  /** Dependency edge between tool stages. */
  DependencyEdge, 
  /** Potential resource conflict in a plan. */
  ResourceConflict 
} from './runtime/toolPlanner';
export type {
  /** Interface for channel communication adapters. */
  ChannelAdapter,
  /** Configuration for a communication channel. */
  ChannelConfig,
  /** Message transmitted via a channel. */
  ChannelMessage,
  /** Current status of a channel connection. */
  ChannelStatus,
  /** Attachment in a channel message. */
  ChannelAttachment,
  /** Options for sending channel messages. */
  SendOptions,
  /** Role of a message sender (Agent, User, etc.). */
  MessageRole,
} from './runtime/channelAdapter';

// ============================================================================
// Topology & Workflow Optimization
// ============================================================================
export { 
  /** Optimizer that uses reflexion to improve orchestration topologies. */
  ReflexionTopologicalOptimizer as TopologyOptimizer, 
  /** Diagnostic information for a topology optimization run. */
  TopologyDiagnostics, 
  /** Proposal for optimizing a task topology. */
  OptimizationProposal, 
  /** Specific action to take for topology optimization. */
  OptimizationAction 
} from './ultimate/topologyOptimizer';
export { 
  /** Adapter for integrating runtime execution with workflow definitions. */
  RuntimeWorkflowAdapter, 
  /** Result of an adaptive workflow execution. */
  AdaptiveExecutionResult 
} from './ultimate/runtimeWorkflowAdapter';

// ============================================================================
// Plugin System — Hooks & Extensions (师夷长技)
// ============================================================================
export { 
  /** Central manager for registering and firing lifecycle hooks and plugins. */
  HookManager, 
  /** Retrieves the singleton hook manager instance. */
  getHookManager, 
  /** Resets the hook manager state. */
  resetHookManager, 
  /** Factory for creating a standard logging plugin. */
  createLoggingPlugin 
} from './pluginManager';
export type { 
  /** Interface for implementing a Commander framework plugin. */
  CommanderPlugin, 
  /** Supported hook points in the framework lifecycle. */
  HookPoint, 
  /** Context for the beforeToolCall hook. */
  BeforeToolCallContext, 
  /** Context for the afterToolCall hook. */
  AfterToolCallContext, 
  /** Context for the beforeLLMCall hook. */
  BeforeLLMCallContext, 
  /** Context for the afterLLMCall hook. */
  AfterLLMCallContext, 
  /** Context for the agentStart hook. */
  AgentStartContext, 
  /** Context for the agentComplete hook. */
  AgentCompleteContext, 
  /** Context for the error hook. */
  ErrorContext 
} from './pluginManager';

// ============================================================================
// TELOS Framework — Token-Efficient Low-waste Orchestration System (Phase 4)
// ============================================================================
export type {
  /** Token budget configuration for TELOS. */
  TELOSBudget,
  /** Result of a token budget check. */
  TokenCheckResult,
  /** Record of the cost for a single LLM call. */
  CostRecord,
  /** Summary of total costs for a run. */
  CostSummary,
  /** Alert triggered when budget thresholds are reached. */
  BudgetAlert,
  /** Context provided to the TELOS planner. */
  TELOSPlanContext,
  /** Assignment of an agent to a task within TELOS. */
  TELOSAgentAssignment,
  /** Supported orchestration modes in TELOS. */
  TELOSOrchestrationMode,
  /** Endpoint for an LLM provider in the TELOS pool. */
  ProviderEndpoint,
  /** Health status of a provider endpoint. */
  ProviderHealth,
  /** Result of a provider selection operation. */
  ProviderSelection,
  /** Chunk of data in a streaming LLM response. */
  StreamChunk,
  /** Callback function for processing stream chunks. */
  StreamCallback,
  /** Controller for managing active LLM streams. */
  StreamController,
  /** Main configuration for the TELOS framework. */
  TELOSConfig,
} from './telos/types';
export { 
  /** Default configuration for the TELOS framework. */
  DEFAULT_TELOS_CONFIG 
} from './telos/types';
export {
  /** Sentinel for monitoring and enforcing token budgets. */
  TokenSentinel,
  /** Retrieves the singleton token sentinel instance. */
  getTokenSentinel,
  /** Resets the token sentinel state. */
  resetTokenSentinel,
  /** Estimates the token count for a text string. */
  estimateTokenCount,
  /** Estimates the token count for a message history. */
  estimateMessagesTokens,
  /** Calculates the financial cost of a run. */
  calculateCost,
  /** Pool for managing multiple LLM provider endpoints. */
  ProviderPool,
  /** Retrieves the singleton provider pool instance. */
  getProviderPool,
  /** Resets the provider pool state. */
  resetProviderPool,
  /** Main orchestrator for the TELOS framework. */
  TELOSOrchestrator,
  /** Evaluator that uses heuristics to select the best provider. */
  HeuristicEvaluator,
  /** Suite of evaluation criteria for provider selection. */
  EvalSuite,
  /** Retrieves the singleton heuristic evaluator instance. */
  getHeuristicEvaluator,
  /** Resets the heuristic evaluator state. */
  resetHeuristicEvaluator,
  /** Standard dimensions for evaluating model/provider quality. */
  EVALUATION_DIMENSIONS,
  /** Default criteria used for provider evaluation. */
  DEFAULT_EVAL_CRITERIA,
} from './telos';

// ============================================================================
// MCP — Model Context Protocol (Agent ↔ Tool communication standard)
// ============================================================================
export type {
  /** Definition of a tool exported via MCP. */
  MCPTool,
  /** Definition of a resource exported via MCP. */
  MCPResource,
  /** Definition of a prompt template exported via MCP. */
  MCPPrompt,
  /** Individual content item in an MCP response. */
  MCPContentItem,
  /** Result of an MCP tool execution. */
  MCPToolResult,
  /** Contents of an MCP resource. */
  MCPResourceContents,
  /** JSON schema used in MCP definitions. */
  MCPJsonSchema,
  /** Interface for implementing an MCP transport. */
  MCPTransport,
  /** Configuration for an MCP client. */
  MCPClientConfig,
  /** Standard JSON-RPC request. */
  JSONRPCRequest,
  /** Standard JSON-RPC response. */
  JSONRPCResponse,
  /** Standardized card representing an agent in A2A communication. */
  A2AAgentCard,
  /** JSON-RPC request specialized for Agent-to-Agent communication. */
  A2AJsonRpcRequest,
  /** JSON-RPC response specialized for Agent-to-Agent communication. */
  A2AJsonRpcResponse,
  /** Represents a task transmitted via the A2A protocol. */
  A2ATask,
  /** Lifecycle state of an A2A task. */
  A2ATaskState,
  /** Message exchanged between agents using the A2A protocol. */
  A2AMessage,
} from './mcp';
export {
  /** Client for interacting with MCP servers. */
  MCPClient,
  /** Transport implementation for MCP using standard input/output. */
  StdioClientTransport,
  /** Transport implementation for MCP using streaming HTTP. */
  StreamableHTTPClientTransport,
  /** Factory function for creating MCP clients. */
  createMCPClient,
  /** Base class for implementing an MCP server. */
  MCPServer,
  /** Standard error codes defined by the MCP protocol. */
  MCP_ERROR_CODES,
  /** Determines if an A2A task can transition between states. */
  canTransition,
  /** Well-known path for retrieving an agent's A2A card. */
  AGENT_CARD_WELL_KNOWN_PATH,
  /** Standard header for A2A protocol version. */
  A2A_VERSION_HEADER,
  /** Current version of the A2A protocol. */
  A2A_PROTOCOL_VERSION,
  /** Standard error messages for the A2A protocol. */
  A2A_ERROR,
  /** Supported methods in the A2A protocol. */
  A2A_METHODS,
} from './mcp';
export {
  SwarmOrchestrator,
  FusionEngine,
  SwarmConfig,
  DEFAULT_SWARM_CONFIG,
  SwarmNode,
  SwarmManager,
  SwarmTopology,
  FusionConflict,
  FusionReport,
  SwarmResult,
  SwarmStatus,
} from './swarm';

