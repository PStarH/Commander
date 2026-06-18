"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GuardianAgent = void 0;
exports.getGuardianAgent = getGuardianAgent;
exports.resetGuardianAgent = resetGuardianAgent;
const securityAuditLogger_1 = require("./securityAuditLogger");
const DEFAULT_CONFIG = {
    enabled: true,
    semanticDriftThreshold: 0.7,
    anomalyWindowSize: 20,
    anomalyStddevMultiplier: 2.5,
    maxConsecutiveAnomalies: 3,
    costPerTokenUsd: 0.000002,
    maxCostPerRunUsd: 5.0,
};
class GuardianAgent {
    constructor(config = {}) {
        this.actionHistory = new Map();
        this.interventionCount = 0;
        this.pausedAgents = new Set();
        this.tokenUsage = new Map();
        this.consecutiveAnomalies = new Map();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    monitor(action) {
        if (!this.config.enabled)
            return null;
        this.appendToHistory(action);
        const drift = this.detectSemanticDrift(action);
        if (drift)
            return this.intervene('semantic_drift', action);
        const anomaly = this.detectAnomaly(action.agentId);
        if (anomaly)
            return this.intervene('anomaly', action);
        const safety = this.detectSafetyViolation(action);
        if (safety)
            return this.intervene('safety_violation', action);
        const cost = this.detectCostOverrun(action);
        if (cost)
            return this.intervene('cost_overrun', action);
        return null;
    }
    recordTokens(agentId, tokens) {
        var _a;
        const prev = (_a = this.tokenUsage.get(agentId)) !== null && _a !== void 0 ? _a : 0;
        this.tokenUsage.set(agentId, prev + tokens);
    }
    isPaused(agentId) {
        return this.pausedAgents.has(agentId);
    }
    resume(agentId) {
        this.pausedAgents.delete(agentId);
    }
    getEvidencePacks(agentId) {
        var _a;
        const packs = [];
        const history = agentId
            ? ((_a = this.actionHistory.get(agentId)) !== null && _a !== void 0 ? _a : [])
            : Array.from(this.actionHistory.values()).flat();
        void history;
        return packs;
    }
    getStats() {
        let totalActions = 0;
        for (const actions of this.actionHistory.values()) {
            totalActions += actions.length;
        }
        return {
            totalActions,
            totalInterventions: this.interventionCount,
            pausedAgents: this.pausedAgents.size,
            perAgentTokens: new Map(this.tokenUsage),
        };
    }
    reset() {
        this.actionHistory.clear();
        this.interventionCount = 0;
        this.pausedAgents.clear();
        this.tokenUsage.clear();
        this.consecutiveAnomalies.clear();
    }
    appendToHistory(action) {
        var _a;
        const history = (_a = this.actionHistory.get(action.agentId)) !== null && _a !== void 0 ? _a : [];
        history.push(action);
        if (history.length > this.config.anomalyWindowSize * 2) {
            history.splice(0, history.length - this.config.anomalyWindowSize * 2);
        }
        this.actionHistory.set(action.agentId, history);
    }
    detectSemanticDrift(action) {
        var _a;
        if (action.type !== 'llm_call')
            return false;
        const history = (_a = this.actionHistory.get(action.agentId)) !== null && _a !== void 0 ? _a : [];
        const recentLLMs = history
            .filter((a) => a.type === 'llm_call')
            .slice(-this.config.anomalyWindowSize);
        if (recentLLMs.length < 3)
            return false;
        const goalAction = recentLLMs[0];
        const currentLength = action.content.length;
        const goalLength = goalAction.content.length;
        if (goalLength === 0)
            return false;
        const lengthRatio = currentLength / goalLength;
        const drifted = lengthRatio > 3 || lengthRatio < 0.1;
        if (drifted) {
            const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
            audit.logEvent({
                type: 'content_threat',
                severity: 'high',
                source: 'guardian_agent',
                message: `Semantic drift detected for agent ${action.agentId}`,
                details: { agentId: action.agentId, lengthRatio, driftDetected: true },
            });
        }
        return drifted;
    }
    detectAnomaly(agentId) {
        var _a, _b, _c;
        const history = (_a = this.actionHistory.get(agentId)) !== null && _a !== void 0 ? _a : [];
        const recent = history.slice(-this.config.anomalyWindowSize);
        if (recent.length < 5)
            return false;
        const toolCalls = recent.filter((a) => a.type === 'tool_call');
        const toolRate = toolCalls.length / recent.length;
        if (toolRate > 0.9) {
            const count = ((_b = this.consecutiveAnomalies.get(agentId)) !== null && _b !== void 0 ? _b : 0) + 1;
            this.consecutiveAnomalies.set(agentId, count);
            return count >= this.config.maxConsecutiveAnomalies;
        }
        const intervals = [];
        for (let i = 1; i < recent.length; i++) {
            intervals.push(recent[i].timestamp - recent[i - 1].timestamp);
        }
        if (intervals.length >= 3) {
            const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
            const stddev = Math.sqrt(variance);
            const burstCount = intervals.filter((i) => i < mean - stddev * this.config.anomalyStddevMultiplier).length;
            if (burstCount > intervals.length * 0.5) {
                const count = ((_c = this.consecutiveAnomalies.get(agentId)) !== null && _c !== void 0 ? _c : 0) + 1;
                this.consecutiveAnomalies.set(agentId, count);
                return count >= this.config.maxConsecutiveAnomalies;
            }
        }
        this.consecutiveAnomalies.set(agentId, 0);
        return false;
    }
    detectSafetyViolation(action) {
        if (action.type !== 'tool_result')
            return false;
        const threats = this.scanForThreats(action.content);
        return threats.some((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL');
    }
    detectCostOverrun(action) {
        var _a;
        const tokens = (_a = this.tokenUsage.get(action.agentId)) !== null && _a !== void 0 ? _a : 0;
        const costUsd = tokens * this.config.costPerTokenUsd;
        return costUsd > this.config.maxCostPerRunUsd;
    }
    scanForThreats(content) {
        var _a;
        const threats = [];
        const lower = content.toLowerCase();
        const injectionPatterns = [
            /ignore\s+(all\s+)?previous\s+instructions/i,
            /you\s+are\s+now\s+a/i,
            /system\s*:\s*/i,
            /override\s+your\s+instructions/i,
            /forget\s+everything/i,
            /new\s+instructions?\s*:/i,
        ];
        for (const pattern of injectionPatterns) {
            if (pattern.test(content)) {
                const match = content.match(pattern);
                threats.push({
                    type: 'prompt_injection',
                    severity: 'HIGH',
                    description: `Potential prompt injection: ${(_a = match === null || match === void 0 ? void 0 : match[0]) !== null && _a !== void 0 ? _a : 'pattern matched'}`,
                    location: { start: 0, end: content.length, snippet: content.slice(0, 200) },
                    remediation: 'Block execution and review agent behavior',
                });
            }
        }
        if (lower.includes('api_key') || lower.includes('secret') || lower.includes('password')) {
            threats.push({
                type: 'data_exfil_channel',
                severity: 'MEDIUM',
                description: 'Potential credential exposure in tool result',
                location: { start: 0, end: content.length, snippet: content.slice(0, 200) },
                remediation: 'Redact sensitive data from tool results',
            });
        }
        return threats;
    }
    intervene(type, action) {
        var _a;
        this.interventionCount++;
        this.pausedAgents.add(action.agentId);
        const consecutive = ((_a = this.consecutiveAnomalies.get(action.agentId)) !== null && _a !== void 0 ? _a : 0) + 1;
        this.consecutiveAnomalies.set(action.agentId, consecutive);
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        audit.logEvent({
            type: 'content_threat',
            severity: type === 'safety_violation' ? 'critical' : 'high',
            source: 'guardian_agent',
            message: `Guardian intervention: ${type} for agent ${action.agentId}`,
            details: {
                agentId: action.agentId,
                interventionType: type,
                paused: true,
                consecutiveAnomalies: consecutive,
            },
        });
        return type;
    }
}
exports.GuardianAgent = GuardianAgent;
let defaultInstance;
function getGuardianAgent() {
    if (!defaultInstance) {
        defaultInstance = new GuardianAgent();
    }
    return defaultInstance;
}
function resetGuardianAgent() {
    defaultInstance = undefined;
}
