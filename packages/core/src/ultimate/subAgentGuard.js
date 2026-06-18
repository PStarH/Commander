"use strict";
/**
 * SubAgentGuard — enforce lifetime limits on sub-agent executions.
 *
 * Closes the "runaway sub-agent" gap from the reversibility audit. Sub-agents
 * can recursively spawn; without enforcement a single bad task can spawn N
 * sub-agents that each consume M tokens = NM cost explosion.
 *
 * Limits (all configurable per call):
 *   - maxSteps        → hard cap on internal LLM steps
 *   - maxTokens       → hard cap on token usage
 *   - maxWallClockMs  → hard cap on elapsed time
 *   - onNoProgress(n) → callback fired when N consecutive steps add no new evidence
 *
 * The guard is a thin wrapper; the actual sub-agent loop calls `guard.check()`
 * at each step boundary. Violations throw SubAgentLimitError.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubAgentGuard = exports.SubAgentLimitError = void 0;
class SubAgentLimitError extends Error {
    constructor(reason, limit, observed) {
        super(`Sub-agent limit violated (${reason}): ${observed} >= ${limit}`);
        this.name = 'SubAgentLimitError';
        this.reason = reason;
        this.limit = limit;
        this.observed = observed;
    }
}
exports.SubAgentLimitError = SubAgentLimitError;
class SubAgentGuard {
    constructor(limits = {}) {
        var _a, _b, _c, _d;
        this.limits = {
            maxSteps: (_a = limits.maxSteps) !== null && _a !== void 0 ? _a : 50,
            maxTokens: (_b = limits.maxTokens) !== null && _b !== void 0 ? _b : 100000,
            maxWallClockMs: (_c = limits.maxWallClockMs) !== null && _c !== void 0 ? _c : 5 * 60 * 1000,
            noProgressThreshold: (_d = limits.noProgressThreshold) !== null && _d !== void 0 ? _d : 10,
        };
        this.state = {
            steps: 0,
            tokens: 0,
            startedAt: Date.now(),
            evidenceCount: 0,
        };
    }
    check(currentEvidenceCount) {
        this.state.steps += 1;
        if (this.state.steps > this.limits.maxSteps) {
            throw new SubAgentLimitError('max_steps', this.limits.maxSteps, this.state.steps);
        }
        const elapsed = Date.now() - this.state.startedAt;
        if (elapsed > this.limits.maxWallClockMs) {
            throw new SubAgentLimitError('max_wall_clock', this.limits.maxWallClockMs, elapsed);
        }
        if (this.state.tokens > this.limits.maxTokens) {
            throw new SubAgentLimitError('max_tokens', this.limits.maxTokens, this.state.tokens);
        }
        if (currentEvidenceCount > this.state.evidenceCount) {
            this.state.evidenceCount = currentEvidenceCount;
        }
        else {
            const stall = this.state.steps - this.state.evidenceCount;
            if (stall >= this.limits.noProgressThreshold) {
                throw new SubAgentLimitError('no_progress', this.limits.noProgressThreshold, stall);
            }
        }
    }
    recordTokens(used) {
        this.state.tokens += used;
        if (this.state.tokens > this.limits.maxTokens) {
            throw new SubAgentLimitError('max_tokens', this.limits.maxTokens, this.state.tokens);
        }
    }
    getState() {
        return { ...this.state, startedAt: this.state.startedAt };
    }
    getLimits() {
        return { ...this.limits };
    }
}
exports.SubAgentGuard = SubAgentGuard;
