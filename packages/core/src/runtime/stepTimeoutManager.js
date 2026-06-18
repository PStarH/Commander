"use strict";
/**
 * StepTimeoutManager — wrap a step's promise with a deadline.
 *
 * Closes the "hung step" gap from the reversibility audit. Without this, a
 * tool that hangs (infinite loop, network stuck) blocks the agent run forever
 * because AgentRuntime.execute has no step-level deadline.
 *
 * Behavior:
 *   - Per-call AbortController fired after `timeoutMs`
 *   - On timeout: rejects with StepTimeoutError (subclass of Error)
 *   - Caller can pass an `onTimeout` callback for cleanup (e.g. abort the underlying fetch)
 *   - clear() called on success releases resources
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepTimeoutManager = exports.StepTimeoutError = void 0;
class StepTimeoutError extends Error {
    constructor(stepId, timeoutMs) {
        super(`Step "${stepId}" exceeded timeout of ${timeoutMs}ms`);
        this.name = 'StepTimeoutError';
        this.stepId = stepId;
        this.timeoutMs = timeoutMs;
    }
}
exports.StepTimeoutError = StepTimeoutError;
class StepTimeoutManager {
    constructor() {
        this.active = new Map();
    }
    async wrap(promise, options) {
        const controller = new AbortController();
        let rejectFn = null;
        const timeoutPromise = new Promise((_, reject) => {
            rejectFn = reject;
            const timer = setTimeout(() => {
                controller.abort(new StepTimeoutError(options.stepId, options.timeoutMs));
                if (options.onTimeout) {
                    try {
                        options.onTimeout(controller.signal);
                    }
                    catch {
                        /* best-effort */
                    }
                }
                reject(new StepTimeoutError(options.stepId, options.timeoutMs));
            }, options.timeoutMs);
            // Use .then() with both handlers instead of .finally() to avoid creating
            // a floating rejected promise that Node.js reports as unhandled.
            // .finally() propagates the rejection, but nothing chains on the result.
            // .then(onFulfilled, onRejected) swallows the error if neither handler throws.
            promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        });
        this.active.set(options.stepId, {
            controller,
            reject: (err) => {
                controller.abort(err);
                if (rejectFn)
                    rejectFn(err);
            },
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            this.active.delete(options.stepId);
        }
    }
    cancel(stepId) {
        const entry = this.active.get(stepId);
        if (!entry)
            return false;
        entry.reject(new StepTimeoutError(stepId, 0));
        return true;
    }
    cancelAll() {
        const count = this.active.size;
        for (const [stepId, entry] of this.active.entries()) {
            entry.reject(new StepTimeoutError(stepId, 0));
        }
        this.active.clear();
        return count;
    }
    activeCount() {
        return this.active.size;
    }
}
exports.StepTimeoutManager = StepTimeoutManager;
