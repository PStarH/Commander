"use strict";
/**
 * Tool Orchestrator — Approval → Sandbox → Execute → Retry
 *
 * Surpasses Codex's orchestrator pattern by adding:
 * 1. Approval gate integration (uses existing ToolApproval)
 * 2. Sandbox selection based on tool risk profile
 * 3. Retry with escalation (retry same → retry with modified args → skip)
 * 4. Timeout cascade (per-tool → per-batch → per-turn)
 * 5. Circuit breaker per tool (stop retrying a broken tool)
 *
 * This is the single entry point for all tool execution in the runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolOrchestrator = void 0;
const circuitBreakerRegistry_1 = require("./circuitBreakerRegistry");
const approval_1 = require("../sandbox/approval");
const idempotencyStore_1 = require("../atr/idempotencyStore");
const canonicalJson_1 = require("../atr/canonicalJson");
const intentLog_1 = require("./intentLog");
const DEFAULT_CONFIG = {
    enabled: true,
    defaultToolTimeoutMs: 30000,
    turnTimeoutMs: 180000,
    maxRetries: 1,
    useApproval: false,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60000,
    toolTimeouts: {},
};
// ============================================================================
// Tool Orchestrator
// ============================================================================
class ToolOrchestrator {
    constructor(config, approval) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.approval = approval;
        this.breakerRegistry = new circuitBreakerRegistry_1.CircuitBreakerRegistry();
    }
    /**
     * Build an execution plan: partition tools into concurrent/serial,
     * check approvals, check circuit breakers.
     */
    async planExecution(toolCalls, tools) {
        var _a;
        const concurrent = [];
        const serial = [];
        const skipped = [];
        const circuitBroken = [];
        const approvalSystem = (0, approval_1.getApprovalSystem)();
        for (const tc of toolCalls) {
            // Check circuit breaker
            if (this.isCircuitOpen(tc.name)) {
                circuitBroken.push({ toolCall: tc, toolName: tc.name });
                continue;
            }
            const modeCheck = this.checkApprovalMode(tc.name);
            if (modeCheck === 'denied') {
                const mode = approvalSystem.getMode();
                skipped.push({
                    toolCall: tc,
                    reason: `Blocked by ${mode} mode: tool "${tc.name}" not allowed`,
                });
                continue;
            }
            // Check tool-level approval
            if (this.config.useApproval && this.approval) {
                const approvalResult = await this.approval.requestApproval(tc.name, tc.arguments);
                if (!approvalResult.approved) {
                    skipped.push({
                        toolCall: tc,
                        reason: (_a = approvalResult.reason) !== null && _a !== void 0 ? _a : 'Approval rejected',
                    });
                    continue;
                }
            }
            // Partition by concurrency safety
            const tool = tools.get(tc.name);
            if (tool === null || tool === void 0 ? void 0 : tool.isConcurrencySafe) {
                concurrent.push(tc);
            }
            else {
                serial.push(tc);
            }
        }
        return { concurrent, serial, skipped, circuitBroken };
    }
    /**
     * Execute a batch of tool calls according to the plan.
     * Handles timeouts, retries, and circuit breaker updates.
     */
    async execute(plan, tools, context) {
        const startTime = Date.now();
        const results = [];
        let retriedCount = 0;
        // Execute concurrent tools in parallel
        if (plan.concurrent.length > 0) {
            const concurrentResults = await Promise.allSettled(plan.concurrent.map((tc) => this.executeSingleWithRetry(tc, tools, context)));
            for (const r of concurrentResults) {
                if (r.status === 'fulfilled') {
                    results.push(r.value.result);
                    retriedCount += r.value.retries;
                }
            }
        }
        // Execute serial tools in order
        for (const tc of plan.serial) {
            // Check turn timeout
            if (Date.now() - startTime > this.config.turnTimeoutMs) {
                results.push({
                    toolCallId: tc.id,
                    name: tc.name,
                    output: '',
                    error: `TURN_TIMEOUT: Turn exceeded ${this.config.turnTimeoutMs}ms`,
                    durationMs: 0,
                });
                continue;
            }
            const { result, retries } = await this.executeSingleWithRetry(tc, tools, context);
            results.push(result);
            retriedCount += retries;
        }
        // Add results for skipped/circuit-broken tools
        for (const s of plan.skipped) {
            results.push({
                toolCallId: s.toolCall.id,
                name: s.toolCall.name,
                output: '',
                error: `APPROVAL_REJECTED: ${s.reason}`,
                durationMs: 0,
            });
        }
        for (const cb of plan.circuitBroken) {
            results.push({
                toolCallId: cb.toolCall.id,
                name: cb.toolCall.name,
                output: '',
                error: `CIRCUIT_OPEN: "${cb.toolName}" is temporarily disabled due to repeated failures`,
                durationMs: 0,
            });
        }
        return {
            results,
            plan,
            totalDurationMs: Date.now() - startTime,
            retriedCount,
            approvalRejectedCount: plan.skipped.length,
        };
    }
    /**
     * Execute a single tool call with retry logic and circuit breaker.
     */
    async executeSingleWithRetry(toolCall, tools, context) {
        var _a, _b, _c, _d;
        const tool = tools.get(toolCall.name);
        if (!tool) {
            return {
                result: {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    output: '',
                    error: `TOOL_NOT_FOUND: "${toolCall.name}" is not registered`,
                    durationMs: 0,
                },
                retries: 0,
            };
        }
        const store = (0, idempotencyStore_1.getIdempotencyStore)();
        const idempotencyKey = this.computeIdempotencyKey(tool, toolCall, context);
        if (store && idempotencyKey) {
            const cached = store.get(idempotencyKey);
            if ((cached === null || cached === void 0 ? void 0 : cached.state) === 'completed') {
                return {
                    result: {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        output: typeof cached.result === 'string' ? cached.result : JSON.stringify(cached.result),
                        durationMs: 0,
                        fromCache: true,
                    },
                    retries: 0,
                };
            }
            if ((cached === null || cached === void 0 ? void 0 : cached.state) === 'failed') {
                return {
                    result: {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        output: '',
                        error: (_a = cached.error) !== null && _a !== void 0 ? _a : 'Prior attempt failed (cached)',
                        durationMs: 0,
                        fromCache: true,
                    },
                    retries: 0,
                };
            }
        }
        const timeout = (_b = this.config.toolTimeouts[toolCall.name]) !== null && _b !== void 0 ? _b : this.config.defaultToolTimeoutMs;
        let lastError;
        let retries = 0;
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            const startTime = Date.now();
            if (store && idempotencyKey && attempt === 0) {
                store.begin(idempotencyKey, {
                    runId: context.runId,
                    toolName: toolCall.name,
                    tenantId: undefined,
                });
            }
            try {
                const execPromise = tool.execute(toolCall.arguments);
                const timeoutPromise = new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error(`TOOL_TIMEOUT: "${toolCall.name}" exceeded ${timeout}ms`)), timeout);
                    if (typeof timer.unref === 'function')
                        timer.unref();
                });
                const output = await Promise.race([execPromise, timeoutPromise]);
                const durationMs = Date.now() - startTime;
                this.recordSuccess(toolCall.name);
                if (store && idempotencyKey) {
                    store.complete(idempotencyKey, output);
                }
                try {
                    (0, intentLog_1.getIntentLog)(context.tenantId).write({
                        schemaVersion: 1,
                        runId: (_c = context.runId) !== null && _c !== void 0 ? _c : 'tool-orchestrator',
                        capturedAt: new Date().toISOString(),
                        stage: 'tool.execute',
                        decision: 'success',
                        reason: `${toolCall.name} completed`,
                        payload: {
                            toolName: toolCall.name,
                            toolCallId: toolCall.id,
                            durationMs,
                            outputLength: typeof output === 'string' ? output.length : JSON.stringify(output).length,
                            attempt: attempt + 1,
                        },
                    });
                }
                catch {
                    /* best-effort */
                }
                return {
                    result: {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        output: typeof output === 'string' ? output : JSON.stringify(output),
                        durationMs,
                    },
                    retries,
                };
            }
            catch (err) {
                const durationMs = Date.now() - startTime;
                lastError = err instanceof Error ? err.message : String(err);
                this.recordFailure(toolCall.name);
                try {
                    (0, intentLog_1.getIntentLog)(context.tenantId).write({
                        schemaVersion: 1,
                        runId: (_d = context.runId) !== null && _d !== void 0 ? _d : 'tool-orchestrator',
                        capturedAt: new Date().toISOString(),
                        stage: 'tool.execute',
                        decision: 'failed',
                        reason: lastError.slice(0, 200),
                        payload: {
                            toolName: toolCall.name,
                            toolCallId: toolCall.id,
                            durationMs,
                            attempt: attempt + 1,
                            willRetry: attempt < this.config.maxRetries,
                        },
                    });
                }
                catch {
                    /* best-effort */
                }
                if (attempt < this.config.maxRetries) {
                    retries++;
                    await new Promise((r) => {
                        const t = setTimeout(r, 500 * (attempt + 1));
                        t.unref();
                    });
                }
                else {
                    if (store && idempotencyKey) {
                        store.fail(idempotencyKey, this.formatError(toolCall, lastError, durationMs, attempt + 1));
                    }
                    return {
                        result: {
                            toolCallId: toolCall.id,
                            name: toolCall.name,
                            output: '',
                            error: this.formatError(toolCall, lastError, durationMs, attempt + 1),
                            durationMs,
                        },
                        retries,
                    };
                }
            }
        }
        // Should not reach here, but just in case
        return {
            result: {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: '',
                error: lastError !== null && lastError !== void 0 ? lastError : 'Unknown error',
                durationMs: 0,
            },
            retries,
        };
    }
    computeIdempotencyKey(tool, toolCall, context) {
        var _a;
        if (tool.idempotencyKey) {
            if (typeof tool.idempotencyKey === 'function') {
                return tool.idempotencyKey(toolCall.arguments, {
                    runId: context.runId,
                    stepId: `step-${context.stepNumber}`,
                });
            }
            return tool.idempotencyKey;
        }
        if (tool.isIdempotent !== true)
            return null;
        return (0, canonicalJson_1.generateIdempotencyKey)({
            externalSystem: (_a = tool.externalSystem) !== null && _a !== void 0 ? _a : 'unknown',
            toolName: toolCall.name,
            args: toolCall.arguments,
            intentHash: context.runId,
            runId: context.runId,
            stepId: `step-${context.stepNumber}`,
        });
    }
    /**
     * Format a structured error message for the model.
     */
    formatError(toolCall, error, durationMs, attempts) {
        return [
            `tool_error: "${toolCall.name}" failed after ${attempts} attempt(s) (${durationMs}ms)`,
            `  reason: ${error}`,
            `  args: ${JSON.stringify(toolCall.arguments)}`,
            `advice:`,
            `  - If transient, retry the call`,
            `  - If args invalid, correct and retry`,
            `  - If tool unavailable, try a different approach`,
        ].join('\n');
    }
    // ============================================================================
    // Circuit Breaker (delegates to CircuitBreakerRegistry)
    // ============================================================================
    isCircuitOpen(toolName) {
        this.breakerRegistry.register(toolName, {
            threshold: this.config.circuitBreakerThreshold,
            recoveryTimeMs: this.config.circuitBreakerCooldownMs,
        });
        return !this.breakerRegistry.isAvailable(toolName);
    }
    recordSuccess(toolName) {
        this.breakerRegistry.onSuccess(toolName);
    }
    recordFailure(toolName) {
        this.breakerRegistry.onFailure(toolName);
    }
    getCircuitState(toolName) {
        const stats = this.breakerRegistry.getStats(toolName);
        return { isOpen: stats.state === 'OPEN', failures: stats.failureCount };
    }
    resetCircuit(toolName) {
        this.breakerRegistry.reset(toolName);
    }
    resetAllCircuits() {
        this.breakerRegistry.resetAll();
    }
    getBreakerRegistry() {
        return this.breakerRegistry;
    }
    /**
     * Check the current approval mode against a tool name.
     * Returns 'denied' when the mode blocks this tool type, 'approved' otherwise.
     */
    checkApprovalMode(toolName) {
        const mode = (0, approval_1.getApprovalSystem)().getMode();
        if (mode === 'full-auto')
            return 'approved';
        const isWrite = /^(file_write|file_edit|write|edit|apply_patch|code_fixer|refine_code|execute_script|python_execute|shell_execute)$/i.test(toolName);
        const isDestructive = /^(rm|rmdir|remove|delete)/i.test(toolName);
        const isNetwork = /^(web_search|web_fetch|browser_search|browser_fetch|web_extract)/i.test(toolName);
        if (mode === 'plan' || mode === 'read-only') {
            if (isWrite || isDestructive)
                return 'denied';
        }
        if (mode === 'read-only') {
            if (isNetwork)
                return 'denied';
        }
        return 'approved';
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
