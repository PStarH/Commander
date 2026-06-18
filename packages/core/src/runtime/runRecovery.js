"use strict";
/**
 * RunRecovery — load a checkpoint and resume execution.
 *
 * Closes the "automatic resume from checkpoint" gap from the reversibility audit.
 * Without this, a crashed run has to be manually restarted from scratch, losing
 * all completed tool results and wasting tokens re-executing them.
 *
 * Recovery flow:
 *   1. Load latest checkpoint via checkpointer.loadCheckpoint()
 *   2. Validate lease (checkpointer enforces fencing internally)
 *   3. Reconstruct completed-tool-call set from steps
 *   4. Return resume state for AgentRuntime to continue from
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunRecovery = void 0;
const logging_1 = require("../logging");
class RunRecovery {
    constructor(checkpointer, leaseManager) {
        this.checkpointer = checkpointer;
        this.leaseManager = leaseManager;
    }
    async attempt(runId, options = {}) {
        var _a;
        const log = (0, logging_1.getGlobalLogger)();
        const state = this.checkpointer.loadCheckpoint(runId);
        if (!state) {
            return { status: 'not_found', completedToolCallIds: new Set() };
        }
        if (state.leaseToken && typeof state.fencingEpoch === 'number') {
            const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
                tenantId: options.tenantId,
            });
            if (!live) {
                log.warn('RunRecovery', 'Lease lost on resume', { runId });
                return {
                    status: 'lease_lost',
                    completedToolCallIds: new Set(),
                    state,
                    errorMessage: 'Lease no longer valid. The run was likely fenced by another worker.',
                };
            }
        }
        const completedToolCallIds = new Set();
        for (const msg of (_a = state.messages) !== null && _a !== void 0 ? _a : []) {
            const toolCallId = msg.toolCallId;
            if (toolCallId && msg.role === 'tool') {
                completedToolCallIds.add(toolCallId);
            }
        }
        log.info('RunRecovery', 'Run recovered from checkpoint', {
            runId,
            resumeFromStep: state.stepNumber,
            completedCount: completedToolCallIds.size,
        });
        return {
            status: 'recovered',
            resumeFromStep: state.stepNumber,
            completedToolCallIds,
            state,
        };
    }
    listRecoverableRuns() {
        return this.checkpointer.listCheckpoints().map((entry) => ({
            runId: entry.runId,
            phase: entry.phase,
            timestamp: entry.timestamp,
        }));
    }
}
exports.RunRecovery = RunRecovery;
