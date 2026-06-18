"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SagaCoordinatorError = exports.SagaNodeError = exports.SagaAbortedError = exports.SagaCoordinator = void 0;
exports.runSaga = runSaga;
exports.startSaga = startSaga;
exports.attachSagaHandle = attachSagaHandle;
const node_crypto_1 = require("node:crypto");
const types_1 = require("./types");
const executionGraph_1 = require("./executionGraph");
const compensationScheduler_1 = require("./compensationScheduler");
const compensationScheduler_2 = require("./compensationScheduler");
const workerPool_1 = require("./workerPool");
class SagaCoordinator {
    constructor(graphValue, ctx, checkpointMgr, approvalMgr, options) {
        var _a, _b, _c, _d;
        this.graphValue = graphValue;
        this.ctx = ctx;
        this.checkpointMgr = checkpointMgr;
        this.approvalMgr = approvalMgr;
        this.nodeStates = new Map();
        this.childRunIds = new Set();
        this.sagaState = 'PENDING';
        this.fencingEpoch = 0;
        this.intentHash = '';
        this.checkpointVersion = 0;
        this.cancelController = new AbortController();
        this.results = new Map();
        this.graph = graphValue;
        this.compensation =
            (_a = options.compensation) !== null && _a !== void 0 ? _a : new compensationScheduler_1.CompensationScheduler({
                retryPolicy: (0, compensationScheduler_2.defaultCompensationRetryPolicy)(),
                deadLetter: options.deadLetter,
            });
        this.workerPool = (_b = options.workerPool) !== null && _b !== void 0 ? _b : new workerPool_1.InProcessWorkerPool(8);
        this.clock = (_c = options.clock) !== null && _c !== void 0 ? _c : (() => new Date());
        this.idGenerator = (_d = options.idGenerator) !== null && _d !== void 0 ? _d : (() => (0, node_crypto_1.randomUUID)());
        this.tenantId = ctx.tenantId;
        this.parentRunId = ctx.parentRunId;
        const now = this.clock().toISOString();
        this.createdAt = now;
        this.updatedAt = now;
        this.graph.walk((n) => this.nodeStates.set(n.id, 'pending'));
    }
    get state() {
        return this.sagaState;
    }
    getNodeState(id) {
        return this.nodeStates.get(id);
    }
    get snapshot() {
        const nodeStates = {};
        for (const [k, v] of this.nodeStates)
            nodeStates[k] = v;
        return {
            runId: this.ctx.runId,
            state: this.sagaState,
            intentHash: this.intentHash,
            fencingEpoch: this.fencingEpoch,
            nodeStates,
            parentRunId: this.parentRunId,
            childRunIds: Array.from(this.childRunIds),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            checkpointVersion: this.checkpointVersion,
            error: this.error,
            tenantId: this.tenantId,
        };
    }
    cancel() {
        this.cancelController.abort();
    }
    async run(options = {}) {
        this.sagaState = 'EXECUTING';
        await this.appendEvent(this.eventFor('begin', {}));
        await this.persist();
        try {
            await this.executeSequence(this.graph.rootId);
            this.sagaState = 'VERIFYING';
            await this.persist();
            this.sagaState = 'COMMITTED';
            await this.appendEvent(this.eventFor('commit', {}));
            await this.persist();
            return this.makeResult('committed', options);
        }
        catch (err) {
            return await this.handleFailure(err, options);
        }
    }
    async executeSequence(startId) {
        var _a;
        let currentId = startId;
        while (currentId !== undefined) {
            if (this.cancelController.signal.aborted) {
                throw new SagaAbortedError('Cancelled');
            }
            const node = this.graph.requireNode(currentId);
            this.nodeStates.set(currentId, 'running');
            await this.appendEvent(this.eventFor('step.started', { nodeId: currentId, name: node.name }));
            await this.persist();
            try {
                await this.executeNode(node);
                this.nodeStates.set(currentId, 'completed');
            }
            catch (err) {
                this.nodeStates.set(currentId, 'failed');
                const wrapped = err instanceof Error ? err : new Error(String(err));
                throw new SagaNodeError(currentId, node.name, wrapped);
            }
            await this.persist();
            currentId = (_a = this.graph.nextSiblingOf(currentId)) === null || _a === void 0 ? void 0 : _a.id;
        }
    }
    async executeNode(node) {
        switch (node.kind) {
            case 'step':
                await this.executeStep(node);
                return;
            case 'parallel':
                await this.executeParallel(node);
                return;
            case 'nested':
                await this.executeNested(node);
                return;
            case 'approval':
                await this.executeApproval(node);
                return;
        }
    }
    async executeStep(node) {
        var _a, _b;
        const policy = (_a = node.retryPolicy) !== null && _a !== void 0 ? _a : types_1.DEFAULT_RETRY_POLICY;
        const timeoutMs = (_b = node.timeoutMs) !== null && _b !== void 0 ? _b : 30000;
        let attempt = 0;
        let lastError;
        while (attempt < policy.maxAttempts) {
            attempt++;
            this.ctx.attempts.set(node.id, attempt);
            try {
                const result = await this.runWithTimeout(() => node.fn(this.ctx), timeoutMs, this.cancelController.signal);
                this.results.set(node.id, result);
                this.ctx.results.set(node.name, result);
                this.ctx.results.set(node.id, result);
                await this.appendEvent(this.eventFor('step.completed', {
                    nodeId: node.id,
                    attempt,
                    hasResult: result !== undefined,
                }));
                return;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt >= policy.maxAttempts)
                    break;
                const retryable = policy.retryOn === undefined || policy.retryOn(lastError);
                if (!retryable)
                    break;
                const delay = this.computeBackoff(policy, attempt);
                await this.appendEvent(this.eventFor('retry.scheduled', {
                    nodeId: node.id,
                    attempt,
                    delayMs: delay,
                }));
                await this.sleep(delay);
            }
        }
        throw lastError !== null && lastError !== void 0 ? lastError : new Error('Step failed without error');
    }
    async executeParallel(node) {
        if (node.branches.length === 0)
            return;
        const abort = new AbortController();
        const promises = [];
        for (const branch of node.branches) {
            if (branch.kind !== 'nested') {
                throw new SagaCoordinatorError('Parallel branch must be a nested node');
            }
            const childRunId = `${this.ctx.runId}::${branch.id}`;
            this.childRunIds.add(childRunId);
            const childCtx = {
                ...this.ctx,
                runId: childRunId,
                parentRunId: this.ctx.runId,
                signal: abort.signal,
            };
            const child = new SagaCoordinator(new executionGraph_1.ExecutionGraph(branch.child), childCtx, this.checkpointMgr, this.approvalMgr, {
                checkpoint: this.checkpointMgr,
                approval: this.approvalMgr,
                compensation: this.compensation,
                workerPool: this.workerPool,
                deadLetter: undefined,
                clock: this.clock,
                idGenerator: this.idGenerator,
            });
            promises.push(child.run().then(() => undefined));
        }
        let firstError;
        let settled = 0;
        await new Promise((resolve) => {
            for (const p of promises) {
                p.then(() => {
                    settled++;
                    if (settled === promises.length)
                        resolve();
                }, (err) => {
                    if (firstError === undefined) {
                        firstError = err;
                        if (node.failFast)
                            abort.abort();
                    }
                    settled++;
                    if (settled === promises.length)
                        resolve();
                });
            }
        });
        if (firstError !== undefined)
            throw firstError;
    }
    async executeNested(node) {
        var _a;
        const childRunId = `${this.ctx.runId}::${node.id}`;
        this.childRunIds.add(childRunId);
        const childCtx = {
            ...this.ctx,
            runId: childRunId,
            parentRunId: this.ctx.runId,
            signal: this.cancelController.signal,
        };
        const child = new SagaCoordinator(new executionGraph_1.ExecutionGraph(node.child), childCtx, this.checkpointMgr, this.approvalMgr, {
            checkpoint: this.checkpointMgr,
            approval: this.approvalMgr,
            compensation: this.compensation,
            workerPool: this.workerPool,
            deadLetter: undefined,
            clock: this.clock,
            idGenerator: this.idGenerator,
        });
        const result = await child.run();
        if (result.status === 'aborted') {
            throw new SagaNodeError(node.id, node.name, new Error((_a = result.error) !== null && _a !== void 0 ? _a : 'Nested saga aborted'));
        }
    }
    async executeApproval(node) {
        var _a;
        this.nodeStates.set(node.id, 'paused');
        await this.appendEvent(this.eventFor('pause', { nodeId: node.id, approver: node.approver }));
        await this.approvalMgr.request({
            runId: this.ctx.runId,
            nodeId: node.id,
            approver: node.approver,
            payload: this.ctx.input,
            contextSummary: node.name,
            requestedAt: this.clock().toISOString(),
            expiresAt: node.timeoutMs
                ? new Date(this.clock().getTime() + node.timeoutMs).toISOString()
                : undefined,
            sagaName: this.graph.name,
            tenantId: this.tenantId,
        });
        await this.persist();
        const signal = this.combineSignals(this.cancelController.signal, node.timeoutMs ? AbortSignal.timeout(node.timeoutMs) : undefined);
        const result = await this.approvalMgr.waitForDecision(this.ctx.runId, node.id, { signal });
        if (result.decision === 'approve') {
            this.nodeStates.set(node.id, 'completed');
            await this.appendEvent(this.eventFor('resume', { nodeId: node.id, decision: 'approve' }));
            return;
        }
        if (node.onTimeout === 'fail' && signal.aborted) {
            this.nodeStates.set(node.id, 'failed');
            throw new Error(`Approval timed out for ${node.approver}`);
        }
        this.nodeStates.set(node.id, 'failed');
        throw new Error(`Approval rejected by ${result.decidedBy}: ${(_a = result.reason) !== null && _a !== void 0 ? _a : 'no reason'}`);
    }
    async handleFailure(err, options) {
        const sagaError = err instanceof SagaNodeError
            ? err
            : err instanceof Error
                ? new SagaNodeError('?', '?', err)
                : new SagaNodeError('?', '?', new Error(String(err)));
        this.error = sagaError.message;
        this.sagaState = 'ABORTED';
        await this.appendEvent(this.eventFor('abort', { nodeId: sagaError.nodeId, error: sagaError.message }));
        const compensablePath = this.collectCompensablePath(sagaError.nodeId);
        const result = await this.compensation.compensate(compensablePath, this.ctx);
        if (result.failed.length > 0) {
            await this.appendEvent(this.eventFor('compensate.done', {
                compensated: result.compensated,
                failed: result.failed.map((f) => f.nodeId),
            }));
        }
        else {
            await this.appendEvent(this.eventFor('compensate.done', {
                compensated: result.compensated,
                failed: [],
            }));
        }
        await this.persist();
        return this.makeResult('aborted', options);
    }
    collectCompensablePath(failedNodeId) {
        if (failedNodeId === '?')
            return [];
        const steps = [];
        const visited = new Set();
        const visit = (id) => {
            if (visited.has(id))
                return;
            visited.add(id);
            const node = this.graph.getNode(id);
            if (!node)
                return;
            if (node.kind === 'step' && node.compensable) {
                const state = this.nodeStates.get(id);
                if (state === 'completed' && this.results.has(id)) {
                    steps.push({ node, result: this.results.get(id) });
                }
            }
            const prev = this.graph.previousSiblingOf(id);
            if (prev)
                visit(prev.id);
            const parentId = this.graph.parentOf(id);
            if (parentId !== undefined)
                visit(parentId);
        };
        visit(failedNodeId);
        return steps;
    }
    makeResult(status, options) {
        var _a;
        const results = {};
        if (options.includeResults !== false) {
            for (const [id, value] of this.results) {
                const node = this.graph.getNode(id);
                if (node && node.kind === 'step') {
                    results[node.name] = value;
                }
            }
        }
        return {
            runId: this.ctx.runId,
            status,
            results,
            error: this.error,
            summary: status === 'committed'
                ? `Saga ${this.graph.name} completed`
                : `Saga ${this.graph.name} aborted: ${(_a = this.error) !== null && _a !== void 0 ? _a : 'unknown'}`,
            durationMs: this.clock().getTime() - new Date(this.createdAt).getTime(),
        };
    }
    async persist() {
        const snapshot = this.checkpointMgr.createSnapshot({
            runId: this.ctx.runId,
            state: this.sagaState,
            intentHash: this.intentHash,
            fencingEpoch: this.fencingEpoch,
            nodeStates: this.serializeNodeStates(),
            parentRunId: this.parentRunId,
            childRunIds: Array.from(this.childRunIds),
            error: this.error,
            tenantId: this.tenantId,
            previous: this.checkpointVersion > 0
                ? await this.checkpointMgr.loadSnapshot(this.ctx.runId)
                : undefined,
        });
        this.checkpointVersion = snapshot.checkpointVersion;
        this.updatedAt = snapshot.updatedAt;
        await this.checkpointMgr.saveSnapshot(snapshot);
    }
    serializeNodeStates() {
        const out = {};
        for (const [k, v] of this.nodeStates)
            out[k] = v;
        return out;
    }
    async appendEvent(event) {
        await this.checkpointMgr.appendEvent(event);
    }
    eventFor(kind, fields) {
        const base = {
            runId: this.ctx.runId,
            fencingEpoch: this.fencingEpoch,
            timestamp: this.clock().toISOString(),
        };
        return { ...base, kind, ...fields };
    }
    async runWithTimeout(fn, ms, signal) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Step timed out after ${ms}ms`));
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error('Cancelled'));
            };
            if (signal.aborted) {
                clearTimeout(timer);
                reject(new Error('Cancelled'));
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            fn().then((value) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            }, (err) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                reject(err);
            });
        });
    }
    computeBackoff(policy, attempt) {
        const base = policy.backoff === 'fixed'
            ? policy.initialDelayMs
            : policy.backoff === 'linear'
                ? policy.initialDelayMs * attempt
                : policy.initialDelayMs * Math.pow(2, attempt - 1);
        const capped = Math.min(base, policy.maxDelayMs);
        if (policy.jitter === 'none')
            return capped;
        if (policy.jitter === 'full')
            return Math.floor(Math.random() * capped);
        return Math.floor(capped / 2 + Math.random() * (capped / 2));
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    combineSignals(a, b) {
        if (!b)
            return a;
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        a.addEventListener('abort', onAbort, { once: true });
        b.addEventListener('abort', onAbort, { once: true });
        if (a.aborted || b.aborted)
            ctrl.abort();
        return ctrl.signal;
    }
}
exports.SagaCoordinator = SagaCoordinator;
class SagaAbortedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SagaAbortedError';
    }
}
exports.SagaAbortedError = SagaAbortedError;
class SagaNodeError extends Error {
    constructor(nodeId, nodeName, cause) {
        super(`Saga node ${nodeName} (${nodeId}) failed: ${cause.message}`);
        this.nodeId = nodeId;
        this.nodeName = nodeName;
        this.cause = cause;
        this.name = 'SagaNodeError';
    }
}
exports.SagaNodeError = SagaNodeError;
class SagaCoordinatorError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SagaCoordinatorError';
    }
}
exports.SagaCoordinatorError = SagaCoordinatorError;
async function runSaga(graph, context, checkpoint, approval, options) {
    const eg = new executionGraph_1.ExecutionGraph(graph);
    const coord = new SagaCoordinator(eg, context, checkpoint, approval, {
        checkpoint,
        approval,
        ...options,
    });
    return coord.run();
}
function startSaga(graph, context, checkpoint, approval, options) {
    const eg = new executionGraph_1.ExecutionGraph(graph);
    const coord = new SagaCoordinator(eg, context, checkpoint, approval, {
        checkpoint,
        approval,
        ...options,
    });
    return {
        result: coord.run(),
        cancel: () => coord.cancel(),
        snapshot: () => coord.snapshot,
        getNodeState: (id) => coord.getNodeState(id),
    };
}
function attachSagaHandle(runId, coord) {
    return {
        runId,
        state: coord.state,
        cancel: () => coord.cancel(),
        snapshot: () => coord.snapshot,
        getNodeState: (id) => coord.getNodeState(id),
    };
}
