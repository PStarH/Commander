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
   * to understand why these memories were selected, as a supplement to raw semantic search arguments.
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
  /** Most recently available raw memory list (kept for backward compatibility). */
  recentMemory: ProjectMemoryItem[];
  /**
   * Memory slice recommended for this invocation, filtered by the current focus (agent/mission/intent).
   * Token-budget-sensitive orchestrators should prefer this over raw recentMemory.
   */
  recommendedMemory: RecommendedMemorySlice;
  /**
   * Guidance directly provided by the Commander framework layer to avoid redundant computation
   * by the orchestrator / SDK.
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

/** Alias for ProjectMemoryKind for developer convenience. */
export type MemoryKind = ProjectMemoryKind;
