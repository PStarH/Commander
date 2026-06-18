"use strict";
/**
 * ReliabilityEngine — Unified resilience facade for Commander.
 *
 * Encapsulates the four core resilience subsystems into a single,
 * injectable engine so that AgentRuntime and other callers never
 * depend on low-level implementation classes directly.
 *
 * Subsystems:
 *   - CircuitBreaker     → failure-aware gating of LLM / tool calls
 *   - DeadLetterQueue    → persistent audit log of unrecoverable failures
 *   - CompensationRegistry → undo side-effects of failed mutation tools
 *   - StateCheckpointer  → crash-safe atomic execution snapshots
 *
 * @example
 * ```typescript
 * const engine = new ReliabilityEngine({ threshold: 5, recoveryTimeMs: 30_000 });
 * engine.registerCompensation('file_write', async (action) => {
 *   await fs.promises.unlink(action.args.path as string);
 *   return { success: true };
 * });
 *
 * if (!engine.isAvailable()) throw new Error('Circuit open');
 * engine.recordAction({ actionId: 'a1', toolName: 'file_write', ... });
 * engine.checkpoint({ runId, phase: 'started', ... });
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReliabilityEngine = void 0;
const circuitBreaker_1 = require("./circuitBreaker");
const deadLetterQueue_1 = require("./deadLetterQueue");
const compensationRegistry_1 = require("./compensationRegistry");
const stateCheckpointer_1 = require("./stateCheckpointer");
const metricsCollector_1 = require("./metricsCollector");
// ============================================================================
// ReliabilityEngine
// ============================================================================
class ReliabilityEngine {
    constructor(config = {}) {
        var _a, _b, _c;
        this.disposed = false;
        const threshold = (_a = config.circuitThreshold) !== null && _a !== void 0 ? _a : 5;
        const recoveryMs = (_b = config.circuitRecoveryMs) !== null && _b !== void 0 ? _b : 30000;
        const halfOpenTests = (_c = config.circuitHalfOpenMaxTests) !== null && _c !== void 0 ? _c : 1;
        this._circuitBreaker = new circuitBreaker_1.CircuitBreaker(threshold, recoveryMs, halfOpenTests);
        this._circuitBreaker.setProviderName('reliabilityEngine');
        this._deadLetterQueue = new deadLetterQueue_1.DeadLetterQueue(config.dlqBaseDir);
        this._compensationRegistry = new compensationRegistry_1.CompensationRegistry();
        this._stateCheckpointer = new stateCheckpointer_1.StateCheckpointer(config.checkpointBaseDir, config.tenantId, {
            leaseManager: config.leaseManager,
        });
        // Wire observability
        this._circuitBreaker.setObservability({
            onTransition: (from, to, provider) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCircuitTransition(from, to, provider !== null && provider !== void 0 ? provider : 'reliabilityEngine');
                }
                catch {
                    /* best-effort */
                }
                try {
                    this._deadLetterQueue.enqueue({
                        category: 'circuit_breaker',
                        operationName: 'circuit.transition',
                        errorMessage: `${from}->${to}`,
                        tags: [`from:${from}`, `to:${to}`],
                        failureMode: 'circuit_open',
                    });
                }
                catch {
                    /* best-effort */
                }
            },
        });
        // Wire durable compensation queue for crash-safe retry
        if (config.compensationQueue) {
            try {
                this._compensationRegistry.setCompensationQueue(config.compensationQueue);
            }
            catch {
                /* queue requires better-sqlite3; skip durable retry */
            }
        }
        this._compensationRegistry.setObservability({
            onSuccess: (action) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'success');
                }
                catch {
                    /* best-effort */
                }
            },
            onFailed: (action, err) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'failed');
                }
                catch {
                    /* best-effort */
                }
            },
            onExhausted: (action, err) => {
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordCompensation(action.toolName, 'exhausted');
                }
                catch {
                    /* best-effort */
                }
                try {
                    this._deadLetterQueue.enqueue({
                        category: 'compensation',
                        operationName: 'compensation.exhausted',
                        errorMessage: err,
                        tags: [action.toolName],
                        failureMode: 'compensation_exhausted',
                    });
                }
                catch {
                    /* best-effort */
                }
            },
        });
    }
    // ── Semantic Circuit Breaker Wiring ─────────────────────────────────────
    /** Set a handler for semantic trip events (verification degradation, etc.). */
    setSemanticTripHandler(handler) {
        this._circuitBreaker.setSemanticTripHandler(handler);
    }
    // ── Circuit Breaker ──────────────────────────────────────────────────────
    /** Whether the circuit is currently closed (calls allowed). */
    isAvailable() {
        return this._circuitBreaker.isAvailable();
    }
    /** Report a successful operation to the circuit breaker. */
    recordSuccess() {
        this._circuitBreaker.onSuccess();
    }
    /** Report a failed operation to the circuit breaker. */
    recordFailure() {
        this._circuitBreaker.onFailure();
    }
    /** Record a semantic/quality failure (verification, hallucination, etc.). */
    recordSemanticFailure(reason) {
        this._circuitBreaker.recordSemanticFailure(reason);
    }
    /** Reset semantic failure counter after recovery. */
    recordSemanticSuccess() {
        this._circuitBreaker.recordSemanticSuccess();
    }
    /** Get semantic health status. */
    getSemanticHealth() {
        return this._circuitBreaker.getSemanticHealth();
    }
    /** Record a semantic drift event. */
    recordSemanticDrift(score) {
        this._circuitBreaker.onSemanticDrift(score);
    }
    /** Record a security event (e.g. HIGH/CRITICAL threat detected). */
    recordSecurityEvent(severity) {
        this._circuitBreaker.onSecurityEvent(severity);
    }
    // ── Dead Letter Queue ────────────────────────────────────────────────────
    /** Record a failure entry to the persistent dead letter queue. */
    recordDLQ(entry) {
        this._deadLetterQueue.record(entry);
    }
    /** Enqueue a failure entry from a partial spec (fills sensible defaults). */
    enqueueDLQ(spec) {
        this._deadLetterQueue.enqueue(spec);
    }
    /** Read recent entries from a dead letter category. */
    readDLQ(category, limit) {
        return this._deadLetterQueue.readEntries(category, limit);
    }
    /** Get retryable DLQ entries that haven't been recovered. */
    getRetryableEntries(category, limit) {
        return this._deadLetterQueue.getRetryableEntries(category, limit);
    }
    // ── Compensation Registry ────────────────────────────────────────────────
    /** Register a compensation handler for a mutation tool. */
    registerCompensation(toolName, handler) {
        this._compensationRegistry.register(toolName, handler);
    }
    /** Record an action for potential compensation. */
    recordAction(action) {
        this._compensationRegistry.recordAction(action);
    }
    /** Compensate a single action by ID. */
    async compensate(actionId) {
        return this._compensationRegistry.compensate(actionId);
    }
    /** Compensate all pending actions (reverse order, max 3 attempts each). */
    async compensateAll() {
        return this._compensationRegistry.compensateAll();
    }
    /** Process due items from the durable compensation queue. */
    async processCompensationQueue() {
        return this._compensationRegistry.processQueue();
    }
    // ── State Checkpointer ───────────────────────────────────────────────────
    /** Write a crash-safe atomic checkpoint. */
    checkpoint(state) {
        this._stateCheckpointer.checkpoint(state);
    }
    /** Write a terminal checkpoint and clean up in-progress artifacts. */
    terminalCheckpoint(state) {
        this._stateCheckpointer.terminalCheckpoint(state);
    }
    /** Load the latest checkpoint for a run (validates lease if bound). */
    loadCheckpoint(runId) {
        return this._stateCheckpointer.loadCheckpoint(runId);
    }
    /** Resume from a completed checkpoint. */
    resume(runId) {
        return this._stateCheckpointer.resume(runId);
    }
    /** List all checkpoints. */
    listCheckpoints() {
        return this._stateCheckpointer.listCheckpoints();
    }
    /** Delete a checkpoint and all its artifacts. */
    deleteCheckpoint(runId) {
        this._stateCheckpointer.deleteCheckpoint(runId);
    }
    // ── Lifecycle ────────────────────────────────────────────────────────────
    /** Get a unified stats snapshot. */
    getStats() {
        return {
            circuit: this._circuitBreaker.getStats(),
            dlq: this._deadLetterQueue.getStats(),
            compensation: {
                pending: this._compensationRegistry.getPendingCount(),
                compensated: this._compensationRegistry.getCompensatedCount(),
            },
            checkpointCount: this.listCheckpoints().length,
        };
    }
    /** Flush pending buffers and release any resources. */
    flush() {
        this._deadLetterQueue.flush();
    }
    /** Shut down the reliability engine, flushing all pending data. */
    shutdown() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.flush();
        this._stateCheckpointer.dispose();
        this._compensationRegistry.clear();
    }
}
exports.ReliabilityEngine = ReliabilityEngine;
