import fs from 'fs';
import path from 'path';
import {
  Agent,
  ExecutionLog,
  Mission,
  MissionPriority,
  MissionStatus,
  MissionRiskLevel,
  MissionGovernanceMode,
  WarRoomData,
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
} from '@commander/core';

const DATA_FILE = path.resolve(__dirname, '../data/war-room.json');

interface CreateMissionInput {
  projectId: string;
  title: string;
  objective: string;
  assignedAgentId: string;
  priority: MissionPriority;
  riskLevel?: MissionRiskLevel;
  governanceMode?: MissionGovernanceMode;
}

interface UpdateMissionInput {
  title?: string;
  objective?: string;
  assignedAgentId?: string;
  priority?: MissionPriority;
  status?: MissionStatus;
  riskLevel?: MissionRiskLevel;
  governanceMode?: MissionGovernanceMode;
}

interface CreateLogInput {
  missionId: string;
  level: ExecutionLog['level'];
  message: string;
}

export interface GovernanceStats {
  totalMissions: number;
  highRiskMissions: number;
  manualGovernanceMissions: number;
  pendingApprovalMissions: number;
  completionRate: number;
  manualApprovalRate: number;
}

export class WarRoomStore {
  private data: WarRoomData;

  constructor(private readonly filePath = DATA_FILE) {
    this.data = this.load();
  }

  listProjects() {
    return [...this.data.projects];
  }

  /**
   * 获取治理统计数据 (Governance Observer v1)
   */
  getGovernanceStats(projectId: string): GovernanceStats {
    const missions = this.data.missions.filter(m => m.projectId === projectId);
    const total = missions.length;
    const highRisk = missions.filter(m => m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL').length;
    const manualGovernance = missions.filter(m => m.governanceMode === 'MANUAL').length;
    const pendingApproval = missions.filter(
      m => m.governanceMode === 'MANUAL' && 
           (m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL') &&
           m.status !== 'DONE'
    ).length;
    const completed = missions.filter(m => m.status === 'DONE').length;
    const manualOnly = manualGovernance > 0 ? manualGovernance : 1;
    const manualApprovalRate = (manualGovernance / total) * 100;

    return {
      totalMissions: total,
      highRiskMissions: highRisk,
      manualGovernanceMissions: manualGovernance,
      pendingApprovalMissions: pendingApproval,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      manualApprovalRate,
    };
  }

  /**
   * 获取需要审批的任务列表
   */
  getPendingApprovals(projectId: string): Mission[] {
    return this.data.missions.filter(
      m => m.projectId === projectId &&
           m.governanceMode === 'MANUAL' &&
           (m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL') &&
           m.status !== 'DONE'
    );
  }

  getProjectSnapshot(projectId: string) {
    return getProjectWarRoomSnapshot(this.data, projectId);
  }

  listAgents(projectId: string): Agent[] {
    return this.data.agents.filter(agent => agent.projectId === projectId);
  }

  createMission(input: CreateMissionInput): Mission {
    const project = this.data.projects.find(item => item.id === input.projectId);
    if (!project) {
      throw new Error('PROJECT_NOT_FOUND');
    }

    const agent = this.assertProjectAgent(input.projectId, input.assignedAgentId);
    const now = new Date().toISOString();

    const riskLevel = input.riskLevel ?? getDefaultRiskLevel(input.priority);
    const governanceMode =
      input.governanceMode ?? getDefaultGovernanceMode(riskLevel, input.priority);

    const mission: Mission = {
      id: this.nextId('mission'),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      status: 'PLANNED',
      priority: input.priority,
      riskLevel,
      governanceMode,
      assignedAgentId: agent.id,
      createdAt: now,
      updatedAt: now,
    };

    this.data.missions.push(mission);
    project.updatedAt = now;

    this.data.logs.push({
      id: this.nextId('log'),
      projectId: input.projectId,
      missionId: mission.id,
      agentId: agent.id,
      level: 'INFO',
      message: `Mission created and assigned to ${agent.name}.`,
      createdAt: now,
    });

    this.persist();
    return mission;
  }

  updateMission(missionId: string, input: UpdateMissionInput, options?: { bypassGovernance?: boolean }): Mission {
    const mission = this.data.missions.find(item => item.id === missionId);
    if (!mission) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const bypassGovernance = options?.bypassGovernance ?? false;

    if (input.assignedAgentId) {
      this.assertProjectAgent(mission.projectId, input.assignedAgentId);
      mission.assignedAgentId = input.assignedAgentId;
    }

    if (typeof input.title === 'string') {
      mission.title = input.title;
    }

    if (typeof input.objective === 'string') {
      mission.objective = input.objective;
    }

    if (input.priority) {
      mission.priority = input.priority;
    }

    if (input.riskLevel) {
      mission.riskLevel = input.riskLevel;
    }

    if (input.governanceMode) {
      mission.governanceMode = input.governanceMode;
    }

    const previousStatus = mission.status;
    if (input.status) {
      // 对 MANUAL 治理模式下的高风险任务，普通状态变更不允许直接标记为 DONE，需显式审批
      const isHighRisk = mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
      if (
        !bypassGovernance &&
        input.status === 'DONE' &&
        mission.governanceMode === 'MANUAL' &&
        isHighRisk
      ) {
        throw new Error('MISSION_REQUIRES_APPROVAL');
      }

      mission.status = input.status;
    }

    const now = new Date().toISOString();
    mission.updatedAt = now;

    if (mission.status === 'RUNNING' && !mission.startedAt) {
      mission.startedAt = now;
    }

    if (mission.status === 'DONE' && previousStatus !== 'DONE') {
      mission.completedAt = now;
    } else if (mission.status !== 'DONE' && previousStatus === 'DONE') {
      delete mission.completedAt;
    }

    const project = this.data.projects.find(item => item.id === mission.projectId);
    if (project) {
      project.updatedAt = now;
    }

    if (input.status && input.status !== previousStatus) {
      this.data.logs.push({
        id: this.nextId('log'),
        projectId: mission.projectId,
        missionId: mission.id,
        agentId: mission.assignedAgentId,
        level: input.status === 'BLOCKED' ? 'WARN' : input.status === 'DONE' ? 'SUCCESS' : 'INFO',
        message: `Mission status changed from ${previousStatus} to ${input.status}.`,
        createdAt: now,
      });
    }

    this.persist();
    return mission;
  }

  createLog(input: CreateLogInput): ExecutionLog {
    const mission = this.data.missions.find(item => item.id === input.missionId);
    if (!mission) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const log: ExecutionLog = {
      id: this.nextId('log'),
      projectId: mission.projectId,
      missionId: mission.id,
      agentId: mission.assignedAgentId,
      level: input.level,
      message: input.message,
      createdAt: now,
    };

    mission.updatedAt = now;
    const agent = this.data.agents.find(item => item.id === mission.assignedAgentId);
    if (agent) {
      agent.lastHeartbeatAt = now;
    }

    const project = this.data.projects.find(item => item.id === mission.projectId);
    if (project) {
      project.updatedAt = now;
    }

    this.data.logs.push(log);
    this.persist();
    return log;
  }

  private assertProjectAgent(projectId: string, agentId: string): Agent {
    const agent = this.data.agents.find(item => {
      return item.projectId === projectId && item.id === agentId;
    });

    if (!agent) {
      throw new Error('AGENT_NOT_FOUND');
    }

    return agent;
  }

  private load(): WarRoomData {
    if (!fs.existsSync(this.filePath)) {
      const seed = createSeedWarRoomData();
      const normalizedSeed = normalizeWarRoomData(seed);
      this.write(normalizedSeed);
      return normalizedSeed;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as WarRoomData;
    const normalized = normalizeWarRoomData(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      this.write(normalized);
    }

    return normalized;
  }

  private persist() {
    this.write(this.data);
  }

  private write(data: WarRoomData) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private nextId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function getDefaultRiskLevel(priority: MissionPriority): MissionRiskLevel {
  switch (priority) {
    case 'CRITICAL':
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'MEDIUM';
    case 'LOW':
    default:
      return 'LOW';
  }
}

function getDefaultGovernanceMode(
  riskLevel: MissionRiskLevel,
  priority: MissionPriority
): MissionGovernanceMode {
  if (riskLevel === 'HIGH' || priority === 'CRITICAL') {
    return 'MANUAL';
  }

  if (riskLevel === 'MEDIUM') {
    return 'GUARDED';
  }

  return 'AUTO';
}

function normalizeWarRoomData(data: WarRoomData): WarRoomData {
  return {
    ...data,
    agents: data.agents.map(agent => ({
      ...agent,
      governanceRole:
        agent.governanceRole ??
        (agent.id === 'agent-builder'
          ? 'EXECUTOR'
          : agent.id === 'agent-scout' || agent.id === 'agent-sentinel'
            ? 'SENATE'
            : 'EXECUTOR'),
    })),
    missions: data.missions.map(mission => {
      const priority = mission.priority ?? 'MEDIUM';
      const riskLevel = mission.riskLevel ?? getDefaultRiskLevel(priority);
      const governanceMode = mission.governanceMode ?? getDefaultGovernanceMode(riskLevel, priority);
      return {
        ...mission,
        priority,
        riskLevel,
        governanceMode,
      };
    }),
  };
}
