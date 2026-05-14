import type { AgentTeam, TeamMember, SharedTask, InboxMessage, ArtifactReference } from './types';
import { getArtifactSystem } from './artifactSystem';

const TEAM_STORE = new Map<string, AgentTeam>();

let teamCounter = 0;

export class AgentTeamManager {
  createTeam(
    name: string,
    members: TeamMember[],
    metadata: Record<string, unknown> = {},
  ): AgentTeam {
    const id = `team_${Date.now()}_${++teamCounter}`;
    const team: AgentTeam = {
      id,
      name,
      members,
      sharedTaskList: [],
      inbox: [],
      status: 'FORMING',
      createdAt: new Date().toISOString(),
      metadata,
    };
    TEAM_STORE.set(id, team);
    team.status = 'ACTIVE';
    return team;
  }

  getTeam(id: string): AgentTeam | null {
    return TEAM_STORE.get(id) ?? null;
  }

  disbandTeam(id: string): boolean {
    const team = TEAM_STORE.get(id);
    if (!team) return false;
    team.status = 'DISBANDED';
    return true;
  }

  addMember(teamId: string, member: TeamMember): boolean {
    const team = TEAM_STORE.get(teamId);
    if (!team) return false;
    team.members.push(member);
    return true;
  }

  removeMember(teamId: string, agentId: string): boolean {
    const team = TEAM_STORE.get(teamId);
    if (!team) return false;
    const idx = team.members.findIndex(m => m.agentId === agentId);
    if (idx === -1) return false;
    team.members.splice(idx, 1);
    return true;
  }

  updateMemberStatus(teamId: string, agentId: string, status: TeamMember['status']): boolean {
    const team = TEAM_STORE.get(teamId);
    if (!team) return false;
    const member = team.members.find(m => m.agentId === agentId);
    if (!member) return false;
    member.status = status;
    return true;
  }

  addTask(teamId: string, task: Omit<SharedTask, 'id' | 'status' | 'createdAt'>): SharedTask | null {
    const team = TEAM_STORE.get(teamId);
    if (!team) return null;
    const newTask: SharedTask = {
      id: `task_${Date.now()}_${team.sharedTaskList.length + 1}`,
      ...task,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    team.sharedTaskList.push(newTask);
    return newTask;
  }

  updateTask(teamId: string, taskId: string, updates: Partial<SharedTask>): boolean {
    const team = TEAM_STORE.get(teamId);
    if (!team) return false;
    const task = team.sharedTaskList.find(t => t.id === taskId);
    if (!task) return false;
    Object.assign(task, updates);
    if (updates.status === 'COMPLETED') {
      task.completedAt = new Date().toISOString();
    }
    return true;
  }

  assignTask(teamId: string, taskId: string, agentId: string): boolean {
    const team = TEAM_STORE.get(teamId);
    if (!team) return false;
    const task = team.sharedTaskList.find(t => t.id === taskId);
    if (!task) return false;
    task.assignedTo = agentId;
    task.status = 'IN_PROGRESS';
    return true;
  }

  sendMessage(
    teamId: string,
    from: string,
    to: string | 'ALL',
    subject: string,
    body: string,
    priority: InboxMessage['priority'] = 'NORMAL',
    attachments?: ArtifactReference[],
  ): InboxMessage | null {
    const team = TEAM_STORE.get(teamId);
    if (!team) return null;

    const message: InboxMessage = {
      id: `msg_${Date.now()}_${team.inbox.length + 1}`,
      from,
      to,
      subject,
      body,
      attachments,
      priority,
      createdAt: new Date().toISOString(),
    };

    team.inbox.push(message);

    if (team.inbox.length > 1000) {
      team.inbox.splice(0, team.inbox.length - 1000);
    }

    return message;
  }

  readMessages(
    teamId: string,
    agentId: string,
    limit = 50,
    includeRead = false,
  ): InboxMessage[] {
    const team = TEAM_STORE.get(teamId);
    if (!team) return [];

    const messages = team.inbox.filter(m => {
      const isForAgent = m.to === 'ALL' || m.to === agentId;
      const isUnread = includeRead || !m.readAt;
      return isForAgent && isUnread;
    });

    const now = new Date().toISOString();
    for (const msg of messages) {
      if (!msg.readAt) msg.readAt = now;
    }

    return messages.slice(-limit);
  }

  getTeamStatus(teamId: string): {
    totalMembers: number;
    activeMembers: number;
    busyMembers: number;
    blockedMembers: number;
    pendingTasks: number;
    inProgressTasks: number;
    completedTasks: number;
    blockedTasks: number;
    unreadMessages: number;
  } | null {
    const team = TEAM_STORE.get(teamId);
    if (!team) return null;

    return {
      totalMembers: team.members.length,
      activeMembers: team.members.filter(m => m.status === 'IDLE').length,
      busyMembers: team.members.filter(m => m.status === 'BUSY').length,
      blockedMembers: team.members.filter(m => m.status === 'BLOCKED').length,
      pendingTasks: team.sharedTaskList.filter(t => t.status === 'PENDING').length,
      inProgressTasks: team.sharedTaskList.filter(t => t.status === 'IN_PROGRESS').length,
      completedTasks: team.sharedTaskList.filter(t => t.status === 'COMPLETED').length,
      blockedTasks: team.sharedTaskList.filter(t => t.status === 'BLOCKED').length,
      unreadMessages: team.inbox.filter(m => !m.readAt).length,
    };
  }

  listTeams(status?: AgentTeam['status']): AgentTeam[] {
    const teams = Array.from(TEAM_STORE.values());
    return status ? teams.filter(t => t.status === status) : teams;
  }
}

let globalTeamManager: AgentTeamManager | null = null;

export function getTeamManager(): AgentTeamManager {
  if (!globalTeamManager) {
    globalTeamManager = new AgentTeamManager();
  }
  return globalTeamManager;
}
