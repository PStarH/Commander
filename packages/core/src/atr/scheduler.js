"use strict";
/**
 * ExecutionScheduler — the single ATR entry point.
 *
 * Owns: run lease, idempotency, checkpoint version, saga state machine.
 * Composes: LeaseManager + IdempotencyStore + RunLedger + CompensationBridge + StateCheckpointer.
 *
 * Every state-mutating call is lease-validated. A zombie process that resumes
 * a run gets its writes rejected at the boundary, not at the side effect.
 *
 * State machine (from RunLedger):
 *   PENDING → EXECUTING → VERIFYING → COMMITTED
 *                         \→ ABORTED → COMPENSATED
 *
 * The scheduler is a stateless facade: the run state lives in the ledger.
 * `beginRun / resumeRun` return a RunHandle — a snapshot of the lease
 * credentials + state at call time. Pass them back to every subsequent
 * schedule/commit/abort call. The scheduler does NOT cache them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionScheduler = void 0;
exports.getExecutionScheduler = getExecutionScheduler;
exports.resetExecutionScheduler = resetExecutionScheduler;
const canonicalJson_1 = require("./canonicalJson");
const runLedger_1 = require("./runLedger");
const compensationBridge_1 = require("./compensationBridge");
const defaultCompensation_1 = require("./defaultCompensation");
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
class ExecutionScheduler {
    constructor(opts) {
        this.lease = opts.lease;
        this.idempotency = opts.idempotency;
        this.ledger = opts.ledger;
        this.bridge = opts.bridge;
        this.checkpointer = opts.checkpointer;
    }
    beginRun(input) {
        var _a, _b;
        const intentHash = (_a = input.intentHash) !== null && _a !== void 0 ? _a : (0, canonicalJson_1.hashIntent)((_b = input.intent) !== null && _b !== void 0 ? _b : input.goal);
        const result = this.ledger.start({
            runId: input.runId,
            intentHash,
            tenantId: input.tenantId,
            metadata: input.metadata,
            ttlSeconds: input.ttlSeconds,
            holder: input.holder,
        });
        this.ledger.beginExecuting(result.tx.runId, result.tx.leaseToken, result.tx.fencingEpoch, {
            tenantId: input.tenantId,
        });
        return {
            runId: result.tx.runId,
            state: 'EXECUTING',
            leaseToken: result.tx.leaseToken,
            fencingEpoch: result.tx.fencingEpoch,
            intentHash,
            tenantId: input.tenantId,
            metadata: result.tx.metadata,
            createdAt: result.tx.createdAt,
            resumed: result.lease.acquired === false && result.lease.reclaimed !== true,
            acquired: result.lease.acquired,
        };
    }
    scheduleAction(input) {
        const beginResult = this.idempotency.begin(input.idempotencyKey, {
            tenantId: input.tenantId,
            runId: input.runId,
            toolName: input.toolName,
        });
        if (!beginResult.acquired && beginResult.record.state === 'completed') {
            return {
                replayed: true,
                actionId: `replay:${beginResult.record.key}`,
                cachedResult: beginResult.record.result,
            };
        }
        if (!beginResult.acquired && beginResult.record.state === 'failed') {
            return {
                replayed: true,
                actionId: `replay:${beginResult.record.key}`,
                cachedError: beginResult.record.error,
            };
        }
        const action = this.ledger.recordAction({
            runId: input.runId,
            leaseToken: input.leaseToken,
            fencingEpoch: input.fencingEpoch,
            tenantId: input.tenantId,
            toolName: input.toolName,
            externalSystem: input.externalSystem,
            args: input.args,
            idempotencyKey: input.idempotencyKey,
            compensable: input.compensable,
            tags: input.tags,
            description: input.description,
        });
        if (!action) {
            this.idempotency.fail(input.idempotencyKey, 'ledger_rejected', { tenantId: input.tenantId });
            return null;
        }
        return { replayed: false, actionId: action.actionId };
    }
    recordResult(input) {
        this.ledger.recordResult(input.actionId, input.result);
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (tx) {
            const action = tx.actions.find((a) => a.actionId === input.actionId);
            if (action)
                this.idempotency.complete(action.idempotencyKey, input.result, {
                    tenantId: input.tenantId,
                });
        }
    }
    recordError(input) {
        this.ledger.recordError(input.actionId, input.error);
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (tx) {
            const action = tx.actions.find((a) => a.actionId === input.actionId);
            if (action)
                this.idempotency.fail(action.idempotencyKey, input.error, { tenantId: input.tenantId });
        }
    }
    commitRun(input) {
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (!tx)
            return { committed: false, reason: 'not_found' };
        if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
            return { committed: false, reason: 'fenced' };
        }
        const ok = this.ledger.commit(input.runId, input.leaseToken, input.fencingEpoch, {
            tenantId: input.tenantId,
        });
        if (!ok)
            return { committed: false, reason: 'fenced' };
        this.lease.release(input.runId, input.leaseToken, { tenantId: input.tenantId });
        return { committed: true };
    }
    async abortRun(input) {
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (!tx)
            return {
                aborted: false,
                reason: 'not_found',
                outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
            };
        if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
            return {
                aborted: false,
                reason: 'fenced',
                outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
            };
        }
        const res = await this.ledger.abortAndCompensate(input.runId, input.leaseToken, input.fencingEpoch, input.reason, { tenantId: input.tenantId, maxAttempts: input.maxAttempts });
        this.lease.release(input.runId, input.leaseToken, { tenantId: input.tenantId });
        return {
            aborted: res.aborted,
            reason: res.aborted ? undefined : 'fenced',
            outcome: res.outcome,
        };
    }
    resumeRun(input) {
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (!tx)
            return null;
        return {
            runId: tx.runId,
            state: tx.state,
            leaseToken: tx.leaseToken,
            fencingEpoch: tx.fencingEpoch,
            intentHash: tx.intentHash,
            tenantId: input.tenantId,
            metadata: tx.metadata,
            createdAt: tx.createdAt,
            resumed: true,
            acquired: false,
        };
    }
    getRun(input) {
        return this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
    }
    listActions(input) {
        var _a;
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (!tx)
            return [];
        const limit = (_a = input.limit) !== null && _a !== void 0 ? _a : 100;
        return tx.actions.slice(-limit).reverse();
    }
    killRun(input) {
        const tx = this.ledger.getTransaction(input.runId, { tenantId: input.tenantId });
        if (!tx)
            return { killed: false, reason: 'not_found' };
        if (tx.leaseToken !== input.leaseToken || tx.fencingEpoch !== input.fencingEpoch) {
            return { killed: false, reason: 'fenced' };
        }
        const released = this.lease.release(input.runId, input.leaseToken, {
            tenantId: input.tenantId,
        });
        return { killed: released, reason: released ? undefined : 'fenced' };
    }
    heartbeat(input) {
        return this.lease.heartbeat(input.runId, input.leaseToken, {
            tenantId: input.tenantId,
            ttlSeconds: input.ttlSeconds,
        });
    }
    checkpoint(input) {
        if (!this.checkpointer)
            return false;
        this.checkpointer.checkpoint(input.state);
        return true;
    }
    listRuns(input) {
        if (input === null || input === void 0 ? void 0 : input.state)
            return this.ledger.listByState(input.state, { tenantId: input.tenantId });
        const allStates = [
            'PENDING',
            'EXECUTING',
            'VERIFYING',
            'COMMITTED',
            'ABORTED',
            'COMPENSATED',
            'PAUSED',
        ];
        const tenantId = input === null || input === void 0 ? void 0 : input.tenantId;
        return allStates.flatMap((s) => this.ledger.listByState(s, { tenantId }));
    }
    registerCompensation(toolName, handler) {
        this.ledger.registerCompensation(toolName, handler);
        this.bridge.register(toolName, handler);
    }
    registerDefaultCompensations() {
        const bridge = this.bridge;
        for (const [toolName, handler] of Object.entries(defaultCompensation_1.defaultCompensationHandlers)) {
            this.ledger.registerCompensation(toolName, handler);
            bridge.register(toolName, handler);
        }
    }
}
exports.ExecutionScheduler = ExecutionScheduler;
let schedulerSingleton = null;
function createSchedulerSingleton() {
    return (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => {
        const bundle = (0, runLedger_1.getRunLedgerBundle)();
        const scheduler = new ExecutionScheduler({
            lease: bundle.lease,
            idempotency: bundle.idempotency,
            ledger: bundle.ledger,
            bridge: new compensationBridge_1.CompensationBridge(),
        });
        scheduler.registerDefaultCompensations();
        return scheduler;
    }, { dispose: () => { } });
}
function getExecutionScheduler() {
    if (!schedulerSingleton) {
        schedulerSingleton = createSchedulerSingleton();
    }
    return schedulerSingleton.get();
}
function resetExecutionScheduler() {
    schedulerSingleton === null || schedulerSingleton === void 0 ? void 0 : schedulerSingleton.reset();
}
