"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompensationRegistry = void 0;
class CompensationRegistry {
    constructor() {
        this.handlers = new Map();
        this.pendingActions = new Map();
        this.compensationAttempts = new Map();
        this.compensated = new Set();
    }
    register(toolName, handler) {
        this.handlers.set(toolName, handler);
    }
    /** Wire the durable compensation queue for cross-process crash-safe retry.
     *  Without this, exhausted compensations are dropped after 3 in-memory attempts.
     *  With the queue, exhausted items are persisted to SQLite with exponential backoff
     *  and can be recovered by a new process after a crash. */
    setCompensationQueue(queue) {
        this.queue = queue;
    }
    setObservability(obs) {
        this.observability = obs;
    }
    recordAction(action) {
        this.pendingActions.set(action.actionId, action);
    }
    assessReversibility(toolName) {
        const READ_ONLY = ['file_read', 'web_search', 'web_fetch', 'memory_recall', 'memory_list'];
        if (READ_ONLY.some(p => toolName.startsWith(p)))
            return 'fully_reversible';
        const MUTATING = ['file_write', 'file_edit', 'shell_execute', 'python_execute', 'git_push', 'git_commit'];
        if (MUTATING.some(p => toolName.startsWith(p)))
            return 'non_reversible';
        return 'partially_reversible';
    }
    /** Compensate a single action by its actionId */
    async compensate(actionId) {
        var _a, _b, _c, _d, _e, _f, _g;
        const action = this.pendingActions.get(actionId);
        if (!action)
            return { success: true };
        const handler = this.handlers.get(action.toolName);
        if (!handler) {
            this.pendingActions.delete(actionId);
            this.addToCompensated(actionId);
            return { success: true };
        }
        try {
            const result = await handler(action);
            if (result.success) {
                this.pendingActions.delete(actionId);
                this.compensationAttempts.delete(actionId);
                this.addToCompensated(actionId);
                try {
                    (_b = (_a = this.observability) === null || _a === void 0 ? void 0 : _a.onSuccess) === null || _b === void 0 ? void 0 : _b.call(_a, action);
                }
                catch {
                    /* best-effort */
                }
            }
            else {
                try {
                    (_d = (_c = this.observability) === null || _c === void 0 ? void 0 : _c.onFailed) === null || _d === void 0 ? void 0 : _d.call(_c, action, (_e = result.error) !== null && _e !== void 0 ? _e : 'unknown');
                }
                catch {
                    /* best-effort */
                }
            }
            return result;
        }
        catch (err) {
            const errStr = String(err);
            try {
                (_g = (_f = this.observability) === null || _f === void 0 ? void 0 : _f.onFailed) === null || _g === void 0 ? void 0 : _g.call(_f, action, errStr);
            }
            catch {
                /* best-effort */
            }
            return { success: false, error: errStr };
        }
    }
    /** Compensate ALL pending actions (in reverse order, max 3 attempts each).
     *  Exhausted items are enqueued to the durable CompensationQueue if wired. */
    async compensateAll() {
        var _a, _b, _c;
        const ids = Array.from(this.pendingActions.keys()).reverse();
        let succeeded = 0;
        let failed = 0;
        const errors = [];
        for (const id of ids) {
            const action = this.pendingActions.get(id);
            if (!action)
                continue;
            const attempts = (_a = this.compensationAttempts.get(id)) !== null && _a !== void 0 ? _a : 0;
            if (attempts >= 3) {
                // Enqueue to durable queue for cross-process retry instead of dropping
                if (this.queue && action.runId) {
                    try {
                        this.queue.enqueue({
                            id: action.actionId,
                            runId: action.runId,
                            agentId: action.agentId,
                            toolName: action.toolName,
                            args: action.args,
                            compensationHandlerKey: action.toolName,
                            maxAttempts: 10,
                        });
                    }
                    catch {
                        /* queue down; proceed with drop */
                    }
                }
                this.pendingActions.delete(id);
                this.compensationAttempts.delete(id);
                failed++;
                const errMsg = `Compensation exhausted after 3 attempts: ${action.toolName}${this.queue ? ' (queued for durable retry)' : ''}`;
                errors.push(errMsg);
                try {
                    (_c = (_b = this.observability) === null || _b === void 0 ? void 0 : _b.onExhausted) === null || _c === void 0 ? void 0 : _c.call(_b, action, errMsg);
                }
                catch {
                    /* best-effort */
                }
                continue;
            }
            this.compensationAttempts.set(id, attempts + 1);
            const result = await this.compensate(id);
            if (result.success) {
                this.compensationAttempts.delete(id);
                succeeded++;
            }
            else {
                failed++;
                if (result.error)
                    errors.push(result.error);
            }
        }
        return { succeeded, failed, errors };
    }
    /** Process due items from the durable compensation queue.
     *  Claims items one at a time and retries the registered handler.
     *  Call periodically (e.g., on process startup, or every N minutes).
     *  Returns the number of items processed. */
    async processQueue() {
        var _a, _b, _c, _d, _e;
        if (!this.queue)
            return 0;
        let processed = 0;
        const maxBatch = 10; // prevent unbounded processing in one call
        for (let i = 0; i < maxBatch; i++) {
            const item = this.queue.claimNext();
            if (!item)
                break;
            const handler = this.handlers.get(item.compensationHandlerKey);
            if (!handler) {
                this.queue.markEscalated(item.id, `No handler registered for "${item.compensationHandlerKey}"`);
                processed++;
                continue;
            }
            try {
                const args = JSON.parse(item.args);
                const action = {
                    actionId: item.id,
                    toolName: item.toolName,
                    args: args,
                    description: `[queue:${item.runId}] ${item.toolName}`,
                    tags: ['compensation_queue', item.toolName],
                    runId: item.runId,
                    agentId: item.agentId,
                };
                const result = await handler(action);
                if (result.success) {
                    this.queue.markCompleted(item.id);
                }
                else {
                    const outcome = this.queue.markFailed(item.id, (_a = result.error) !== null && _a !== void 0 ? _a : 'unknown', item.attemptCount);
                    if (outcome === 'escalated') {
                        try {
                            (_c = (_b = this.observability) === null || _b === void 0 ? void 0 : _b.onExhausted) === null || _c === void 0 ? void 0 : _c.call(_b, action, `Queue compensation exhausted: ${result.error}`);
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
            }
            catch (err) {
                const errStr = err instanceof Error ? err.message : String(err);
                const outcome = this.queue.markFailed(item.id, errStr, item.attemptCount);
                if (outcome === 'escalated') {
                    try {
                        (_e = (_d = this.observability) === null || _d === void 0 ? void 0 : _d.onExhausted) === null || _e === void 0 ? void 0 : _e.call(_d, { actionId: item.id, toolName: item.toolName, args: {}, description: '', tags: [] }, `Queue compensation error: ${errStr}`);
                    }
                    catch {
                        /* best-effort */
                    }
                }
            }
            processed++;
        }
        return processed;
    }
    addToCompensated(actionId) {
        this.compensated.add(actionId);
        // Cap at 1000 entries — drop oldest to prevent unbounded growth in long sessions
        if (this.compensated.size > 1000) {
            const first = this.compensated.values().next().value;
            if (first)
                this.compensated.delete(first);
        }
    }
    /** Look up a compensation handler by tool name. Returns undefined if not registered. */
    getHandler(toolName) {
        return this.handlers.get(toolName);
    }
    getPendingCount() {
        return this.pendingActions.size;
    }
    getCompensatedCount() {
        return this.compensated.size;
    }
    clear() {
        this.pendingActions.clear();
        this.compensated.clear();
        this.compensationAttempts.clear();
    }
}
exports.CompensationRegistry = CompensationRegistry;
