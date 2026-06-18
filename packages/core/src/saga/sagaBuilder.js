"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SagaBuilderError = exports.SagaBuilder = void 0;
exports.createSaga = createSaga;
exports.buildSaga = buildSaga;
let idCounter = 0;
function genId(prefix) {
    idCounter = (idCounter + 1) >>> 0;
    return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
class SagaBuilder {
    constructor(name) {
        this.nodes = [];
        if (!name || typeof name !== 'string') {
            throw new SagaBuilderError('Saga name is required');
        }
        this._name = name;
    }
    describe(description) {
        this._description = description;
        return this;
    }
    withTimeout(ms) {
        if (ms <= 0)
            throw new SagaBuilderError('timeoutMs must be > 0');
        this._timeoutMs = ms;
        return this;
    }
    withRetry(policy) {
        this._defaultRetryPolicy = policy;
        return this;
    }
    withTenant(tenantId) {
        this._tenantId = tenantId;
        return this;
    }
    withMetadata(metadata) {
        var _a;
        this._metadata = { ...((_a = this._metadata) !== null && _a !== void 0 ? _a : {}), ...metadata };
        return this;
    }
    step(name, fn, config = {}) {
        var _a, _b, _c;
        const id = (_a = config.id) !== null && _a !== void 0 ? _a : genId('step');
        const node = {
            kind: 'step',
            id,
            name,
            fn,
            compensate: config.compensate,
            compensateOrder: (_b = config.compensateOrder) !== null && _b !== void 0 ? _b : 'lifo',
            timeoutMs: config.timeoutMs,
            retryPolicy: config.retryPolicy ? this.resolveRetryPolicy(config.retryPolicy) : undefined,
            compensable: config.compensate !== undefined,
            description: config.description,
            tags: (_c = config.tags) !== null && _c !== void 0 ? _c : [],
        };
        this.nodes.push(node);
        return this;
    }
    compensate(fn) {
        const last = this.nodes[this.nodes.length - 1];
        if (!last || last.kind !== 'step') {
            throw new SagaBuilderError('compensate() must follow a step() — most recent node is not a step');
        }
        const step = last;
        step.compensate = fn;
        step.compensable = true;
        return this;
    }
    parallel(branches, config = {}) {
        var _a, _b, _c;
        if (branches.length === 0) {
            throw new SagaBuilderError('parallel() requires at least one branch');
        }
        const nestedNodes = branches.map((g, i) => {
            var _a;
            return ({
                kind: 'nested',
                id: `${(_a = config.id) !== null && _a !== void 0 ? _a : genId('parallel')}_b${i}`,
                name: g.name,
                child: g,
                compensateOrder: 'lifo',
            });
        });
        const parallel = {
            kind: 'parallel',
            id: (_a = config.id) !== null && _a !== void 0 ? _a : genId('parallel'),
            name: (_b = config.name) !== null && _b !== void 0 ? _b : 'parallel',
            branches: nestedNodes,
            failFast: (_c = config.failFast) !== null && _c !== void 0 ? _c : true,
        };
        this.nodes.push(parallel);
        return this;
    }
    nested(child, config = {}) {
        var _a, _b, _c;
        const node = {
            kind: 'nested',
            id: (_a = config.id) !== null && _a !== void 0 ? _a : genId('nested'),
            name: (_b = config.name) !== null && _b !== void 0 ? _b : child.name,
            child,
            compensateOrder: (_c = config.compensateOrder) !== null && _c !== void 0 ? _c : 'lifo',
        };
        this.nodes.push(node);
        return this;
    }
    approval(approver, config = {}) {
        var _a, _b;
        if (!approver) {
            throw new SagaBuilderError('approval() requires an approver id');
        }
        const node = {
            kind: 'approval',
            id: (_a = config.id) !== null && _a !== void 0 ? _a : genId('approval'),
            name: approver,
            approver,
            timeoutMs: config.timeoutMs,
            onTimeout: (_b = config.onTimeout) !== null && _b !== void 0 ? _b : 'reject',
        };
        this.nodes.push(node);
        return this;
    }
    build() {
        if (this.nodes.length === 0) {
            throw new SagaBuilderError('Cannot build a saga with no nodes — add at least one step');
        }
        const graph = {
            name: this._name,
            description: this._description,
            nodes: this.nodes,
            rootId: this.nodes[0].id,
            timeoutMs: this._timeoutMs,
            defaultRetryPolicy: this._defaultRetryPolicy,
            tenantId: this._tenantId,
            metadata: this._metadata,
        };
        return graph;
    }
    resolveRetryPolicy(partial) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const base = (_a = this._defaultRetryPolicy) !== null && _a !== void 0 ? _a : {
            maxAttempts: 1,
            backoff: 'exponential',
            initialDelayMs: 100,
            maxDelayMs: 30000,
            jitter: 'equal',
        };
        return {
            maxAttempts: (_b = partial.maxAttempts) !== null && _b !== void 0 ? _b : base.maxAttempts,
            backoff: (_c = partial.backoff) !== null && _c !== void 0 ? _c : base.backoff,
            initialDelayMs: (_d = partial.initialDelayMs) !== null && _d !== void 0 ? _d : base.initialDelayMs,
            maxDelayMs: (_e = partial.maxDelayMs) !== null && _e !== void 0 ? _e : base.maxDelayMs,
            jitter: (_f = partial.jitter) !== null && _f !== void 0 ? _f : base.jitter,
            retryOn: (_g = partial.retryOn) !== null && _g !== void 0 ? _g : base.retryOn,
            circuitBreakerAfter: (_h = partial.circuitBreakerAfter) !== null && _h !== void 0 ? _h : base.circuitBreakerAfter,
        };
    }
}
exports.SagaBuilder = SagaBuilder;
class SagaBuilderError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SagaBuilderError';
    }
}
exports.SagaBuilderError = SagaBuilderError;
function createSaga(name) {
    return new SagaBuilder(name);
}
function buildSaga(name, configure) {
    const builder = new SagaBuilder(name);
    return configure(builder).build();
}
