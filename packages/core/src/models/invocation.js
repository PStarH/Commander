"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultInvocationProfile = getDefaultInvocationProfile;
/**
 * Determines the governance disposition for a mission based on risk and mode.
 */
function getMissionGovernanceDisposition(input) {
    const rationale = [];
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
        rationale.push('HIGH/CRITICAL risk + EXECUTE intent => require approval or downgrade to proposal externally.');
        return {
            disposition: 'REQUIRE_APPROVAL',
            rationale,
            approval: { required: true, requiredRoles: ['COMMANDER', 'SENATE'], minApprovals: 1 },
        };
    }
    if (mission.governanceMode === 'GUARDED' && input.intent === 'EXECUTE') {
        rationale.push('governanceMode=GUARDED + EXECUTE intent => allow execution but expect senate monitoring.');
        return { disposition: 'ALLOW_EXECUTION', rationale };
    }
    return {
        disposition: input.intent === 'EXECUTE' ? 'ALLOW_EXECUTION' : 'PROPOSE_ONLY',
        rationale,
    };
}
/**
 * Generates the default invocation profile for an agent in a specific context.
 */
function getDefaultInvocationProfile(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    const governance = getMissionGovernanceDisposition(input);
    const rationale = [...governance.rationale];
    const baseAllowed = ['READ_CONTEXT', 'WRITE_LOG'];
    const baseForbidden = [
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
            missionId: (_a = input.mission) === null || _a === void 0 ? void 0 : _a.id,
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
            approval: (_b = governance.approval) !== null && _b !== void 0 ? _b : { required: false, requiredRoles: [], minApprovals: 0 },
            rationale,
        };
    }
    if (governance.disposition === 'REQUIRE_APPROVAL') {
        rationale.push('Restricting to proposal-safe operations until approval is granted by external system.');
        return {
            agentId: input.agent.id,
            intent: input.intent === 'EXECUTE' ? 'PROPOSE' : input.intent,
            missionId: (_c = input.mission) === null || _c === void 0 ? void 0 : _c.id,
            disposition: governance.disposition,
            allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
            forbiddenOperations: ['UPDATE_MISSION_STATUS', 'UPDATE_MISSION_FIELDS', 'UPDATE_AGENT_STATE'],
            approval: (_d = governance.approval) !== null && _d !== void 0 ? _d : {
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
            missionId: (_e = input.mission) === null || _e === void 0 ? void 0 : _e.id,
            disposition: governance.disposition,
            allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY'],
            forbiddenOperations: [
                'UPDATE_MISSION_STATUS',
                'UPDATE_MISSION_FIELDS',
                'UPDATE_AGENT_STATE',
                'REQUEST_APPROVAL',
            ],
            approval: (_f = governance.approval) !== null && _f !== void 0 ? _f : { required: false, requiredRoles: [], minApprovals: 0 },
            rationale,
        };
    }
    return {
        agentId: input.agent.id,
        intent: input.intent,
        missionId: (_g = input.mission) === null || _g === void 0 ? void 0 : _g.id,
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
