import type { AgentTeam, TeamMember, SharedTask, InboxMessage, ArtifactReference } from './types';
import { getArtifactSystem } from './artifactSystem';

/** Maximum inbox messages per team before oldest are evicted */
const MAX_INBOX_PER_TEAM = 1000;

export class AgentTeamManager {
  private teamStore = new Map<string, AgentTeam>();
  private teamCounter = 0;

  createTeam(
    name: string,
    members: TeamMember[],
    metadata: Record<string, unknown> = {},
  ): AgentTeam {
    const id = `team_${Date.now()}_${++this.teamCounter}`;
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
    this.teamStore.set(id, team);
    team.status = 'ACTIVE';
    return team;
  }

  getTeam(id: string): AgentTeam | null {
    return this.teamStore.get(id) ?? null;
  }

  disbandTeam(id: string): boolean {
    const team = this.teamStore.get(id);
    if (!team) return false;
    team.status = 'DISBANDED';
    return true;
  }

  /** Remove disbanded teams from the store to prevent unbounded growth */
  purgeDisbanded(): number {
    let removed = 0;
    for (const [id, team] of this.teamStore) {
      if (team.status === 'DISBANDED') {
        this.teamStore.delete(id);
        removed++;
      }
    }
    return removed;
  }

  addMember(teamId: string, member: TeamMember): boolean {
    const team = this.teamStore.get(teamId);
    if (!team) return false;
    team.members.push(member);
    return true;
  }

  removeMember(teamId: string, agentId: string): boolean {
    const team = this.teamStore.get(teamId);
    if (!team) return false;
    const idx = team.members.findIndex((m) => m.agentId === agentId);
    if (idx === -1) return false;
    team.members.splice(idx, 1);
    return true;
  }

  updateMemberStatus(teamId: string, agentId: string, status: TeamMember['status']): boolean {
    const team = this.teamStore.get(teamId);
    if (!team) return false;
    const member = team.members.find((m) => m.agentId === agentId);
    if (!member) return false;
    member.status = status;
    return true;
  }

  addTask(
    teamId: string,
    task: Omit<SharedTask, 'id' | 'status' | 'createdAt'>,
  ): SharedTask | null {
    const team = this.teamStore.get(teamId);
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
    const team = this.teamStore.get(teamId);
    if (!team) return false;
    const task = team.sharedTaskList.find((t) => t.id === taskId);
    if (!task) return false;
    Object.assign(task, updates);
    if (updates.status === 'COMPLETED') {
      task.completedAt = new Date().toISOString();
    }
    return true;
  }

  assignTask(teamId: string, taskId: string, agentId: string): boolean {
    const team = this.teamStore.get(teamId);
    if (!team) return false;
    const task = team.sharedTaskList.find((t) => t.id === taskId);
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
    const team = this.teamStore.get(teamId);
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

    if (team.inbox.length > MAX_INBOX_PER_TEAM) {
      team.inbox.splice(0, team.inbox.length - MAX_INBOX_PER_TEAM);
    }

    return message;
  }

  readMessages(
    teamId: string,
    agentId: string,
    limit = 50,
    includeRead = false,
    priorityFilter?: InboxMessage['priority'],
  ): InboxMessage[] {
    const team = this.teamStore.get(teamId);
    if (!team) return [];

    const messages = team.inbox.filter((m) => {
      const isForAgent = m.to === 'ALL' || m.to === agentId;
      const isUnread = includeRead || !m.readAt;
      const matchesPriority = !priorityFilter || m.priority === priorityFilter;
      return isForAgent && isUnread && matchesPriority;
    });

    const now = new Date().toISOString();
    for (const msg of messages) {
      if (!msg.readAt) msg.readAt = now;
    }

    // Sort by priority (URGENT > HIGH > NORMAL > LOW) then by time
    const priorityOrder = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    messages.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return b.createdAt.localeCompare(a.createdAt);
    });

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
    const team = this.teamStore.get(teamId);
    if (!team) return null;

    let activeMembers = 0,
      busyMembers = 0,
      blockedMembers = 0;
    for (const m of team.members) {
      if (m.status === 'IDLE') activeMembers++;
      else if (m.status === 'BUSY') busyMembers++;
      else if (m.status === 'BLOCKED') blockedMembers++;
    }

    let pendingTasks = 0,
      inProgressTasks = 0,
      completedTasks = 0,
      blockedTasks = 0;
    for (const t of team.sharedTaskList) {
      if (t.status === 'PENDING') pendingTasks++;
      else if (t.status === 'IN_PROGRESS') inProgressTasks++;
      else if (t.status === 'COMPLETED') completedTasks++;
      else if (t.status === 'BLOCKED') blockedTasks++;
    }

    let unreadMessages = 0;
    for (const m of team.inbox) {
      if (!m.readAt) unreadMessages++;
    }

    return {
      totalMembers: team.members.length,
      activeMembers,
      busyMembers,
      blockedMembers,
      pendingTasks,
      inProgressTasks,
      completedTasks,
      blockedTasks,
      unreadMessages,
    };
  }

  listTeams(status?: AgentTeam['status']): AgentTeam[] {
    const teams = Array.from(this.teamStore.values());
    return status ? teams.filter((t) => t.status === status) : teams;
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const teamManagerSingleton = createTenantAwareSingleton(() => new AgentTeamManager());

export function getTeamManager(): AgentTeamManager {
  return teamManagerSingleton.get();
}

export function resetTeamManager(): void {
  teamManagerSingleton.reset();
}
