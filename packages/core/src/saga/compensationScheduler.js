"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompensationSchedulerError = exports.CompensationScheduler = void 0;
exports.defaultCompensationRetryPolicy = defaultCompensationRetryPolicy;
const retryController_1 = require("./retryController");
class CompensationScheduler {
    constructor(options) {
        var _a;
        this.retry = new retryController_1.RetryController(options.retryPolicy);
        this.dlq = (_a = options.deadLetter) !== null && _a !== void 0 ? _a : (() => Promise.resolve());
    }
    async compensate(steps, context) {
        var _a;
        const compensated = [];
        const failed = [];
        for (const step of steps) {
            const attempt = await this.runOne(step, context);
            if (attempt.success) {
                compensated.push(step.node.id);
            }
            else {
                const entry = {
                    nodeId: step.node.id,
                    runId: context.runId,
                    compensationError: (_a = attempt.error) !== null && _a !== void 0 ? _a : new Error('unknown'),
                    attempts: attempt.attempts,
                    timestamp: new Date().toISOString(),
                };
                failed.push(entry);
                await this.dlq(entry);
            }
        }
        return { compensated, failed };
    }
    async compensateParallel(steps, context) {
        var _a;
        const attempts = await Promise.all(steps.map((s) => this.runOne(s, context)));
        const compensated = [];
        const failed = [];
        for (let i = 0; i < attempts.length; i++) {
            const a = attempts[i];
            if (a.success) {
                compensated.push(steps[i].node.id);
            }
            else {
                const entry = {
                    nodeId: steps[i].node.id,
                    runId: context.runId,
                    compensationError: (_a = a.error) !== null && _a !== void 0 ? _a : new Error('unknown'),
                    attempts: a.attempts,
                    timestamp: new Date().toISOString(),
                };
                failed.push(entry);
                await this.dlq(entry);
            }
        }
        return { compensated, failed };
    }
    async forceCompensate(step, context) {
        return this.runOne(step, context);
    }
    async runOne(step, context) {
        if (!step.node.compensate) {
            return { nodeId: step.node.id, success: true, attempts: 0 };
        }
        let attempts = 0;
        let lastError;
        const max = this.retry.policy_.maxAttempts;
        while (attempts < max) {
            attempts++;
            try {
                await step.node.compensate(step.result);
                return { nodeId: step.node.id, success: true, attempts };
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempts < max) {
                    const delay = this.retry.computeDelay(attempts);
                    if (delay > 0) {
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    }
                }
            }
        }
        return {
            nodeId: step.node.id,
            success: false,
            attempts,
            error: lastError,
        };
    }
}
exports.CompensationScheduler = CompensationScheduler;
class CompensationSchedulerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CompensationSchedulerError';
    }
}
exports.CompensationSchedulerError = CompensationSchedulerError;
function defaultCompensationRetryPolicy() {
    return {
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelayMs: 200,
        maxDelayMs: 5000,
        jitter: 'equal',
    };
}
