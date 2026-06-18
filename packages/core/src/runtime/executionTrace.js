"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionTraceRecorder = void 0;
exports.getTraceRecorder = getTraceRecorder;
exports.resetTraceRecorder = resetTraceRecorder;
function generateId() {
    return `span_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 15)}`;
}
class ExecutionTraceRecorder {
    /** Evict the oldest completed trace to make room. Skips active traces. */
    evictOldestCompleted() {
        // Use shift for O(1) on the common case (oldest is first inserted)
        while (this.traceInsertOrder.length > 0) {
            const key = this.traceInsertOrder[0];
            const trace = this.traces.get(key);
            if (trace === null || trace === void 0 ? void 0 : trace.completedAt) {
                this.traceInsertOrder.shift();
                this.traces.delete(key);
                return;
            }
            // Oldest is still active — try the next one
            break;
        }
    }
    constructor(maxTraces = 500, store, maxEventsPerTrace = 5000) {
        this.traces = new Map();
        this.traceInsertOrder = [];
        this.maxTraces = maxTraces;
        this.maxEventsPerTrace = maxEventsPerTrace;
        this.store = store !== null && store !== void 0 ? store : null;
    }
    setStore(store) {
        this.store = store;
    }
    hasStore() {
        return this.store !== null;
    }
    startRun(runId, agentId, missionId, traceId, context) {
        const tid = traceId !== null && traceId !== void 0 ? traceId : generateTraceId();
        this.traces.set(runId, {
            runId,
            traceId: tid,
            agentId,
            missionId,
            tenantId: context === null || context === void 0 ? void 0 : context.tenantId,
            parentRunId: context === null || context === void 0 ? void 0 : context.parentRunId,
            subAgentDepth: context === null || context === void 0 ? void 0 : context.subAgentDepth,
            subAgentRole: context === null || context === void 0 ? void 0 : context.subAgentRole,
            startedAt: new Date().toISOString(),
            events: [],
            summary: {
                totalEvents: 0,
                totalDurationMs: 0,
                totalTokens: 0,
                llmCalls: 0,
                toolExecutions: 0,
                errors: 0,
                modelUsed: '',
            },
        });
        this.traceInsertOrder.push(runId);
        if (this.traces.size > this.maxTraces) {
            this.evictOldestCompleted();
        }
    }
    recordEvent(runId, event) {
        var _a, _b, _c;
        const trace = this.traces.get(runId);
        if (!trace) {
            const tid = generateTraceId();
            return {
                id: '',
                spanId: '',
                traceId: tid,
                runId,
                agentId: 'unknown',
                timestamp: new Date().toISOString(),
                durationMs: 0,
                type: (_a = event.type) !== null && _a !== void 0 ? _a : 'decision',
                data: (_b = event.data) !== null && _b !== void 0 ? _b : {},
                parentSpanId: event.parentSpanId,
            };
        }
        const fullEvent = {
            ...event,
            id: generateId(),
            spanId: generateId(),
            traceId: trace.traceId,
            runId,
            agentId: trace.agentId,
            timestamp: new Date().toISOString(),
        };
        // Limit events per trace to prevent unbounded memory growth
        if (trace.events.length >= this.maxEventsPerTrace) {
            // Drop oldest events (keep most recent 80%)
            const keepCount = Math.floor(this.maxEventsPerTrace * 0.8);
            trace.events = trace.events.slice(-keepCount);
        }
        trace.events.push(fullEvent);
        trace.summary.totalEvents++;
        trace.summary.totalDurationMs += event.durationMs;
        if (event.type === 'llm_call') {
            trace.summary.llmCalls++;
            if (event.data.tokenUsage) {
                trace.summary.totalTokens += event.data.tokenUsage.totalTokens;
            }
            if (event.data.modelInfo) {
                trace.summary.modelUsed = event.data.modelInfo.model;
            }
        }
        if (event.type === 'tool_execution')
            trace.summary.toolExecutions++;
        if (event.type === 'error')
            trace.summary.errors++;
        (_c = this.store) === null || _c === void 0 ? void 0 : _c.append(fullEvent);
        if (this.traces.size > this.maxTraces) {
            this.evictOldestCompleted();
        }
        return fullEvent;
    }
    recordLLMCall(runId, model, provider, tier, input, output, tokenUsage, durationMs, parentSpanId, metadata) {
        return this.recordEvent(runId, {
            type: 'llm_call',
            durationMs,
            data: {
                input,
                output,
                modelInfo: { model, provider, tier },
                tokenUsage,
                tier,
                taskCategory: metadata === null || metadata === void 0 ? void 0 : metadata.taskCategory,
            },
            parentSpanId,
        });
    }
    recordToolExecution(runId, toolName, input, output, durationMs, error, parentSpanId) {
        return this.recordEvent(runId, {
            type: 'tool_execution',
            durationMs,
            data: { input, output, error },
            parentSpanId,
        });
    }
    recordDecision(runId, decision, durationMs, parentSpanId) {
        return this.recordEvent(runId, {
            type: 'decision',
            durationMs,
            data: { input: undefined, output: decision },
            parentSpanId,
        });
    }
    recordError(runId, error, durationMs, parentSpanId) {
        return this.recordEvent(runId, {
            type: 'error',
            durationMs,
            data: { error },
            parentSpanId,
        });
    }
    recordVerification(runId, passed, confidence, signalCount, durationMs, parentSpanId) {
        return this.recordEvent(runId, {
            type: 'verification',
            durationMs,
            data: {
                input: { passed, confidence, signalCount },
                output: { passed, confidence, signalCount },
                evaluationScore: confidence,
                evaluationPassed: passed,
            },
            parentSpanId,
        });
    }
    /**
     * Record a critical event with fsync durability. Use sparingly: circuit-breaker
     * transitions, compensation exhaustion, intent-log writes, run manifest commits.
     * Higher latency than recordEvent() because it fsyncs the file descriptor.
     */
    recordCriticalEvent(runId, event) {
        var _a, _b, _c;
        const trace = this.traces.get(runId);
        const fullEvent = {
            ...event,
            id: generateId(),
            spanId: generateId(),
            traceId: (_a = trace === null || trace === void 0 ? void 0 : trace.traceId) !== null && _a !== void 0 ? _a : generateTraceId(),
            runId,
            agentId: (_b = trace === null || trace === void 0 ? void 0 : trace.agentId) !== null && _b !== void 0 ? _b : 'unknown',
            timestamp: new Date().toISOString(),
        };
        if (trace) {
            trace.events.push(fullEvent);
        }
        if (this.store &&
            typeof this.store.appendCritical ===
                'function') {
            this.store.appendCritical(fullEvent);
        }
        else {
            (_c = this.store) === null || _c === void 0 ? void 0 : _c.append(fullEvent);
        }
        return fullEvent;
    }
    completeRun(runId) {
        var _a;
        const trace = this.traces.get(runId);
        if (!trace) {
            throw new Error(`No trace found for run: ${runId}`);
        }
        trace.completedAt = new Date().toISOString();
        (_a = this.store) === null || _a === void 0 ? void 0 : _a.flush(runId);
        return trace;
    }
    getTrace(runId) {
        return this.traces.get(runId);
    }
    listTraces(agentId, limit = 50) {
        let all = Array.from(this.traces.values());
        if (agentId) {
            all = all.filter((t) => t.agentId === agentId);
        }
        // ISO string comparison — no Date parsing needed
        return all
            .sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0))
            .slice(0, limit);
    }
    getSummary() {
        let totalLLMCalls = 0;
        let totalTokens = 0;
        let totalErrors = 0;
        for (const trace of this.traces.values()) {
            totalLLMCalls += trace.summary.llmCalls;
            totalTokens += trace.summary.totalTokens;
            totalErrors += trace.summary.errors;
        }
        return {
            totalTraces: this.traces.size,
            totalLLMCalls,
            totalTokens,
            totalErrors,
        };
    }
    startSpan(runId, name, parentSpanId) {
        var _a, _b;
        const trace = this.traces.get(runId);
        const spanId = generateId();
        const traceId = (_a = trace === null || trace === void 0 ? void 0 : trace.traceId) !== null && _a !== void 0 ? _a : generateTraceId();
        const agentId = (_b = trace === null || trace === void 0 ? void 0 : trace.agentId) !== null && _b !== void 0 ? _b : 'unknown';
        const startTime = Date.now();
        if (!trace) {
            this.traces.set(runId, {
                runId,
                traceId,
                agentId,
                missionId: undefined,
                startedAt: new Date().toISOString(),
                events: [],
                summary: {
                    totalEvents: 0,
                    totalDurationMs: 0,
                    totalTokens: 0,
                    llmCalls: 0,
                    toolExecutions: 0,
                    errors: 0,
                    modelUsed: '',
                },
            });
            this.traceInsertOrder.push(runId);
        }
        // Re-fetch after potential fallback creation
        const finalTrace = this.traces.get(runId);
        return {
            spanId,
            traceId,
            end: (attrs) => {
                const durationMs = Date.now() - startTime;
                const event = this.recordEvent(runId, {
                    type: 'state_change',
                    durationMs,
                    data: {
                        input: name,
                        output: attrs === null || attrs === void 0 ? void 0 : attrs.output,
                        error: attrs === null || attrs === void 0 ? void 0 : attrs.error,
                    },
                    parentSpanId,
                });
                return event;
            },
            recordChild: (type, attrs) => {
                var _a;
                const childDuration = (_a = attrs === null || attrs === void 0 ? void 0 : attrs.durationMs) !== null && _a !== void 0 ? _a : 0;
                return this.recordEvent(runId, {
                    type,
                    durationMs: childDuration,
                    data: {
                        input: attrs === null || attrs === void 0 ? void 0 : attrs.input,
                        output: attrs === null || attrs === void 0 ? void 0 : attrs.output,
                        error: attrs === null || attrs === void 0 ? void 0 : attrs.error,
                    },
                    parentSpanId: spanId,
                });
            },
        };
    }
}
exports.ExecutionTraceRecorder = ExecutionTraceRecorder;
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let _traceStore;
const traceRecorderSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ExecutionTraceRecorder(500, _traceStore));
function getTraceRecorder(store) {
    if (store)
        _traceStore = store;
    const recorder = traceRecorderSingleton.get();
    if (store && !recorder.hasStore()) {
        recorder.setStore(store);
    }
    return recorder;
}
function resetTraceRecorder() {
    traceRecorderSingleton.reset();
}
