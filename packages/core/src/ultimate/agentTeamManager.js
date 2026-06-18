"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentTeamManager = void 0;
exports.getTeamManager = getTeamManager;
exports.resetTeamManager = resetTeamManager;
/** Maximum inbox messages per team before oldest are evicted */
const MAX_INBOX_PER_TEAM = 1000;
class AgentTeamManager {
    constructor() {
        this.teamStore = new Map();
        this.teamCounter = 0;
    }
    createTeam(name, members, metadata = {}) {
        const id = `team_${Date.now()}_${++this.teamCounter}`;
        const team = {
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
    getTeam(id) {
        var _a;
        return (_a = this.teamStore.get(id)) !== null && _a !== void 0 ? _a : null;
    }
    disbandTeam(id) {
        const team = this.teamStore.get(id);
        if (!team)
            return false;
        team.status = 'DISBANDED';
        return true;
    }
    /** Remove disbanded teams from the store to prevent unbounded growth */
    purgeDisbanded() {
        let removed = 0;
        for (const [id, team] of this.teamStore) {
            if (team.status === 'DISBANDED') {
                this.teamStore.delete(id);
                removed++;
            }
        }
        return removed;
    }
    addMember(teamId, member) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return false;
        team.members.push(member);
        return true;
    }
    removeMember(teamId, agentId) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return false;
        const idx = team.members.findIndex((m) => m.agentId === agentId);
        if (idx === -1)
            return false;
        team.members.splice(idx, 1);
        return true;
    }
    updateMemberStatus(teamId, agentId, status) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return false;
        const member = team.members.find((m) => m.agentId === agentId);
        if (!member)
            return false;
        member.status = status;
        return true;
    }
    addTask(teamId, task) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return null;
        const newTask = {
            id: `task_${Date.now()}_${team.sharedTaskList.length + 1}`,
            ...task,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
        };
        team.sharedTaskList.push(newTask);
        return newTask;
    }
    updateTask(teamId, taskId, updates) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return false;
        const task = team.sharedTaskList.find((t) => t.id === taskId);
        if (!task)
            return false;
        Object.assign(task, updates);
        if (updates.status === 'COMPLETED') {
            task.completedAt = new Date().toISOString();
        }
        return true;
    }
    assignTask(teamId, taskId, agentId) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return false;
        const task = team.sharedTaskList.find((t) => t.id === taskId);
        if (!task)
            return false;
        task.assignedTo = agentId;
        task.status = 'IN_PROGRESS';
        return true;
    }
    sendMessage(teamId, from, to, subject, body, priority = 'NORMAL', attachments) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return null;
        const message = {
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
    readMessages(teamId, agentId, limit = 50, includeRead = false, priorityFilter) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return [];
        let messages = team.inbox.filter((m) => {
            const isForAgent = m.to === 'ALL' || m.to === agentId;
            const isUnread = includeRead || !m.readAt;
            const matchesPriority = !priorityFilter || m.priority === priorityFilter;
            return isForAgent && isUnread && matchesPriority;
        });
        const now = new Date().toISOString();
        for (const msg of messages) {
            if (!msg.readAt)
                msg.readAt = now;
        }
        // Sort by priority (URGENT > HIGH > NORMAL > LOW) then by time
        const priorityOrder = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
        messages.sort((a, b) => {
            var _a, _b;
            const pa = (_a = priorityOrder[a.priority]) !== null && _a !== void 0 ? _a : 2;
            const pb = (_b = priorityOrder[b.priority]) !== null && _b !== void 0 ? _b : 2;
            if (pa !== pb)
                return pa - pb;
            return b.createdAt.localeCompare(a.createdAt);
        });
        return messages.slice(-limit);
    }
    getTeamStatus(teamId) {
        const team = this.teamStore.get(teamId);
        if (!team)
            return null;
        let activeMembers = 0, busyMembers = 0, blockedMembers = 0;
        for (const m of team.members) {
            if (m.status === 'IDLE')
                activeMembers++;
            else if (m.status === 'BUSY')
                busyMembers++;
            else if (m.status === 'BLOCKED')
                blockedMembers++;
        }
        let pendingTasks = 0, inProgressTasks = 0, completedTasks = 0, blockedTasks = 0;
        for (const t of team.sharedTaskList) {
            if (t.status === 'PENDING')
                pendingTasks++;
            else if (t.status === 'IN_PROGRESS')
                inProgressTasks++;
            else if (t.status === 'COMPLETED')
                completedTasks++;
            else if (t.status === 'BLOCKED')
                blockedTasks++;
        }
        let unreadMessages = 0;
        for (const m of team.inbox) {
            if (!m.readAt)
                unreadMessages++;
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
    listTeams(status) {
        const teams = Array.from(this.teamStore.values());
        return status ? teams.filter((t) => t.status === status) : teams;
    }
}
exports.AgentTeamManager = AgentTeamManager;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const teamManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new AgentTeamManager());
function getTeamManager() {
    return teamManagerSingleton.get();
}
function resetTeamManager() {
    teamManagerSingleton.reset();
}
