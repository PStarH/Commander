import type { AgentTeam, TeamMember, SharedTask, InboxMessage, ArtifactReference } from './types';
export declare class AgentTeamManager {
    private teamStore;
    private teamCounter;
    createTeam(name: string, members: TeamMember[], metadata?: Record<string, unknown>): AgentTeam;
    getTeam(id: string): AgentTeam | null;
    disbandTeam(id: string): boolean;
    /** Remove disbanded teams from the store to prevent unbounded growth */
    purgeDisbanded(): number;
    addMember(teamId: string, member: TeamMember): boolean;
    removeMember(teamId: string, agentId: string): boolean;
    updateMemberStatus(teamId: string, agentId: string, status: TeamMember['status']): boolean;
    addTask(teamId: string, task: Omit<SharedTask, 'id' | 'status' | 'createdAt'>): SharedTask | null;
    updateTask(teamId: string, taskId: string, updates: Partial<SharedTask>): boolean;
    assignTask(teamId: string, taskId: string, agentId: string): boolean;
    sendMessage(teamId: string, from: string, to: string | 'ALL', subject: string, body: string, priority?: InboxMessage['priority'], attachments?: ArtifactReference[]): InboxMessage | null;
    readMessages(teamId: string, agentId: string, limit?: number, includeRead?: boolean, priorityFilter?: InboxMessage['priority']): InboxMessage[];
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
    } | null;
    listTeams(status?: AgentTeam['status']): AgentTeam[];
}
export declare function getTeamManager(): AgentTeamManager;
export declare function resetTeamManager(): void;
//# sourceMappingURL=agentTeamManager.d.ts.map