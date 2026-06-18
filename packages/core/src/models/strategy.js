"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recommendStrategy = recommendStrategy;
function pickSenateAgents(roster, limit = 2) {
    return roster
        .filter((agent) => {
        return (agent.governanceRole === 'SENATE' &&
            (agent.status === 'READY' || agent.status === 'RUNNING'));
    })
        .slice(0, limit)
        .map((agent) => agent.id);
}
function pickExecutorAgent(roster, preferredAgentId) {
    const preferred = preferredAgentId
        ? roster.find((agent) => agent.id === preferredAgentId)
        : undefined;
    if (preferred && (preferred.status === 'READY' || preferred.status === 'RUNNING')) {
        return preferred;
    }
    return roster.find((agent) => {
        return (agent.governanceRole === 'EXECUTOR' &&
            (agent.status === 'READY' || agent.status === 'RUNNING'));
    });
}
function recommendStrategy(context) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const rationale = [];
    const missionId = (_b = (_a = context.focus) === null || _a === void 0 ? void 0 : _a.missionId) !== null && _b !== void 0 ? _b : (_c = context.slimSnapshot.focusMission) === null || _c === void 0 ? void 0 : _c.id;
    const focusMission = missionId
        ? ((_d = context.slimSnapshot.focusMission) === null || _d === void 0 ? void 0 : _d.id) === missionId
            ? context.slimSnapshot.focusMission
            : [
                ...context.slimSnapshot.missionBoard.running,
                ...context.slimSnapshot.missionBoard.blocked,
                ...context.slimSnapshot.missionBoard.planned,
                ...context.slimSnapshot.missionBoard.done,
            ].find((mission) => mission.id === missionId)
        : undefined;
    const intent = (_f = (_e = context.focus) === null || _e === void 0 ? void 0 : _e.intent) !== null && _f !== void 0 ? _f : 'EXECUTE';
    if (!focusMission) {
        const primary = (_h = pickExecutorAgent(context.agentRoster, (_g = context.focus) === null || _g === void 0 ? void 0 : _g.agentId)) === null || _h === void 0 ? void 0 : _h.id;
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
    const preferredExecutorId = (_k = (_j = context.focus) === null || _j === void 0 ? void 0 : _j.agentId) !== null && _k !== void 0 ? _k : focusMission.assignedAgentId;
    const executor = pickExecutorAgent(context.agentRoster, preferredExecutorId);
    const senate = pickSenateAgents(context.agentRoster);
    if (focusMission.governanceMode === 'MANUAL') {
        rationale.push('Mission governanceMode=MANUAL => execution must be approval-gated.');
        rationale.push(`Intent=${intent} will be treated as PROPOSE unless approved externally.`);
        return {
            kind: 'MANUAL_APPROVAL_GATE',
            primaryAgentId: executor === null || executor === void 0 ? void 0 : executor.id,
            executorAgentIds: executor ? [executor.id] : [],
            reviewerAgentIds: senate,
            approval: { required: true, requiredRoles: ['COMMANDER'], minApprovals: 1 },
            rationale,
        };
    }
    const highRisk = focusMission.riskLevel === 'HIGH' || focusMission.riskLevel === 'CRITICAL';
    if (focusMission.governanceMode === 'GUARDED' || highRisk) {
        rationale.push(focusMission.governanceMode === 'GUARDED'
            ? 'Mission governanceMode=GUARDED => pair executor with senate monitor/review.'
            : 'Mission riskLevel is HIGH/CRITICAL => guarded execution recommended.');
        return {
            kind: 'GUARDED_EXECUTION',
            primaryAgentId: executor === null || executor === void 0 ? void 0 : executor.id,
            executorAgentIds: executor ? [executor.id] : [],
            reviewerAgentIds: senate,
            approval: { required: false, requiredRoles: [], minApprovals: 0 },
            rationale,
        };
    }
    rationale.push('Mission governanceMode=AUTO and riskLevel LOW/MEDIUM => single-agent execution.');
    return {
        kind: 'SINGLE_AGENT',
        primaryAgentId: executor === null || executor === void 0 ? void 0 : executor.id,
        executorAgentIds: executor ? [executor.id] : [],
        reviewerAgentIds: [],
        approval: { required: false, requiredRoles: [], minApprovals: 0 },
        rationale,
    };
}
