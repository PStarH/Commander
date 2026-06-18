"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEffortRules = getEffortRules;
exports.classifyEffortLevel = classifyEffortLevel;
exports.selectTopologyForEffort = selectTopologyForEffort;
const EFFORT_RULES = {
    SIMPLE: {
        level: 'SIMPLE',
        minSubAgents: 1,
        maxSubAgents: 1,
        minToolCallsPerAgent: 3,
        maxToolCallsPerAgent: 10,
        recommendedTopology: 'SINGLE',
        thinkingTokens: 512,
        maxDepth: 0,
        leadModelTier: 'standard',
        specialistModelTier: 'eco',
    },
    MODERATE: {
        level: 'MODERATE',
        minSubAgents: 2,
        maxSubAgents: 4,
        minToolCallsPerAgent: 10,
        maxToolCallsPerAgent: 15,
        recommendedTopology: 'PARALLEL',
        thinkingTokens: 2048,
        maxDepth: 1,
        leadModelTier: 'power',
        specialistModelTier: 'standard',
    },
    COMPLEX: {
        level: 'COMPLEX',
        minSubAgents: 5,
        maxSubAgents: 10,
        minToolCallsPerAgent: 10,
        maxToolCallsPerAgent: 20,
        recommendedTopology: 'HIERARCHICAL',
        thinkingTokens: 4096,
        maxDepth: 2,
        leadModelTier: 'power',
        specialistModelTier: 'standard',
    },
    DEEP_RESEARCH: {
        level: 'DEEP_RESEARCH',
        minSubAgents: 10,
        maxSubAgents: 20,
        minToolCallsPerAgent: 15,
        maxToolCallsPerAgent: 30,
        recommendedTopology: 'HYBRID',
        thinkingTokens: 8192,
        maxDepth: 3,
        leadModelTier: 'consensus',
        specialistModelTier: 'standard',
    },
};
function getEffortRules(level) {
    return { ...EFFORT_RULES[level] };
}
function classifyEffortLevel(goal, contextHints) {
    var _a, _b, _c;
    const length = goal.length;
    const toolCount = (_a = contextHints === null || contextHints === void 0 ? void 0 : contextHints.toolCount) !== null && _a !== void 0 ? _a : 0;
    const riskLevel = (_b = contextHints === null || contextHints === void 0 ? void 0 : contextHints.riskLevel) !== null && _b !== void 0 ? _b : 'LOW';
    const depth = (_c = contextHints === null || contextHints === void 0 ? void 0 : contextHints.depth) !== null && _c !== void 0 ? _c : 0;
    if (length > 3000 || toolCount > 15 || riskLevel === 'CRITICAL' || depth > 3) {
        return 'DEEP_RESEARCH';
    }
    if (length > 1500 || toolCount > 8 || riskLevel === 'HIGH' || depth > 2) {
        return 'COMPLEX';
    }
    if (length > 400 || toolCount > 3 || riskLevel === 'MEDIUM' || depth > 1) {
        return 'MODERATE';
    }
    return 'SIMPLE';
}
function selectTopologyForEffort(level, dag) {
    const rules = getEffortRules(level);
    if (!dag)
        return rules.recommendedTopology;
    if (dag.interSubtaskCoupling > 0.7) {
        return 'SEQUENTIAL';
    }
    if (dag.criticalPathDepth > 3 && dag.parallelismWidth > 2) {
        return 'HIERARCHICAL';
    }
    if (dag.parallelismWidth > 3) {
        return 'PARALLEL';
    }
    return rules.recommendedTopology;
}
