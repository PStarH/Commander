"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExecutiveSummary = buildExecutiveSummary;
const timelineBuilder_1 = require("./timelineBuilder");
const costModel_1 = require("./costModel");
function buildExecutiveSummary(trace) {
    const timeline = (0, timelineBuilder_1.buildTimeline)(trace);
    const costModel = (0, costModel_1.getCostModel)();
    const modelsUsed = new Set();
    const toolsUsed = new Set();
    let totalCostUsd = 0;
    let totalTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let errors = 0;
    const highlights = [];
    for (const node of timeline.nodes) {
        if (node.model)
            modelsUsed.add(node.model);
        if (node.type === 'LLM')
            llmCalls++;
        if (node.type === 'TOOL') {
            toolCalls++;
            const toolName = node.name.replace('execute_tool ', '');
            toolsUsed.add(toolName);
        }
        if (node.status === 'error')
            errors++;
        if (node.cost)
            totalCostUsd += node.cost.totalCostUsd;
        if (node.tokens)
            totalTokens += node.tokens.total;
    }
    const durationMs = timeline.totalDurationMs;
    const status = errors > 0 ? 'error' : 'success';
    if (errors > 0)
        highlights.push(`${errors} error(s) detected`);
    if (toolCalls > 10)
        highlights.push(`High tool usage: ${toolCalls} calls`);
    if (totalCostUsd > 1.0)
        highlights.push(`High cost: $${totalCostUsd.toFixed(4)}`);
    if (durationMs > 60000)
        highlights.push(`Long execution: ${(durationMs / 1000).toFixed(1)}s`);
    const narrative = buildNarrative(trace, timeline, status, durationMs, totalCostUsd, totalTokens, llmCalls, toolCalls, errors, modelsUsed, toolsUsed);
    const timelineEvents = buildTimelineEvents(trace);
    return {
        runId: trace.runId,
        traceId: trace.traceId,
        status,
        durationMs,
        totalCostUsd,
        totalTokens,
        llmCalls,
        toolCalls,
        errors,
        modelsUsed: Array.from(modelsUsed),
        toolsUsed: Array.from(toolsUsed),
        topology: extractTopology(trace),
        taskCategory: extractTaskCategory(trace),
        narrative,
        highlights,
        timeline: timelineEvents,
    };
}
function buildNarrative(trace, _timeline, status, durationMs, totalCostUsd, totalTokens, llmCalls, toolCalls, errors, modelsUsed, toolsUsed) {
    const parts = [];
    parts.push(`Run ${trace.runId.slice(0, 12)} ${status === 'success' ? 'completed successfully' : 'had errors'}.`);
    const durationSec = (durationMs / 1000).toFixed(1);
    parts.push(`Duration: ${durationSec}s`);
    parts.push(`Cost: $${totalCostUsd.toFixed(4)} (${totalTokens} tokens)`);
    if (llmCalls > 0) {
        const models = Array.from(modelsUsed).join(', ');
        parts.push(`${llmCalls} LLM call(s) using ${models}`);
    }
    if (toolCalls > 0) {
        const tools = Array.from(toolsUsed).join(', ');
        parts.push(`${toolCalls} tool call(s): ${tools}`);
    }
    if (errors > 0) {
        parts.push(`${errors} error(s) occurred during execution`);
    }
    return parts.join('. ') + '.';
}
function buildTimelineEvents(trace) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const events = [];
    for (const e of trace.events) {
        let label;
        let detail;
        switch (e.type) {
            case 'llm_call': {
                const model = (_b = (_a = e.data.modelInfo) === null || _a === void 0 ? void 0 : _a.model) !== null && _b !== void 0 ? _b : 'unknown';
                const provider = (_d = (_c = e.data.modelInfo) === null || _c === void 0 ? void 0 : _c.provider) !== null && _d !== void 0 ? _d : 'unknown';
                label = `LLM Call (${provider}/${model})`;
                const tokens = (_f = (_e = e.data.tokenUsage) === null || _e === void 0 ? void 0 : _e.totalTokens) !== null && _f !== void 0 ? _f : 0;
                detail = `${tokens} tokens`;
                break;
            }
            case 'tool_execution': {
                const toolName = String((_g = e.data.input) !== null && _g !== void 0 ? _g : 'unknown');
                label = `Tool: ${toolName}`;
                detail = e.data.error ? `Error: ${e.data.error}` : 'Executed';
                break;
            }
            case 'decision':
                label = 'Decision';
                detail = typeof e.data.output === 'string' ? e.data.output : 'Made a decision';
                break;
            case 'error':
                label = 'Error';
                detail = String((_h = e.data.error) !== null && _h !== void 0 ? _h : 'Unknown error');
                break;
            case 'state_change':
                label = 'State Change';
                detail = e.data.stateTransition
                    ? `${e.data.stateTransition.from} → ${e.data.stateTransition.to}`
                    : 'State changed';
                break;
            default:
                label = e.type;
                detail = 'Event recorded';
        }
        events.push({
            timestamp: e.timestamp,
            label,
            detail,
            durationMs: e.durationMs,
            costUsd: e.data.modelInfo && e.data.tokenUsage
                ? (0, costModel_1.getCostModel)().calculate(e.data.modelInfo.provider, e.data.modelInfo.model, {
                    input: (_j = e.data.tokenUsage.promptTokens) !== null && _j !== void 0 ? _j : 0,
                    output: (_k = e.data.tokenUsage.completionTokens) !== null && _k !== void 0 ? _k : 0,
                    cached: 0,
                    reasoning: 0,
                    total: (_l = e.data.tokenUsage.totalTokens) !== null && _l !== void 0 ? _l : 0,
                }).totalCostUsd
                : undefined,
        });
    }
    return events;
}
function extractTopology(trace) {
    for (const e of trace.events) {
        if (e.type === 'decision' && typeof e.data.output === 'string') {
            const output = e.data.output.toLowerCase();
            if (output.includes('topology') ||
                output.includes('sequential') ||
                output.includes('parallel')) {
                return e.data.output;
            }
        }
    }
    return undefined;
}
function extractTaskCategory(trace) {
    for (const e of trace.events) {
        if (e.type === 'decision' && typeof e.data.output === 'string') {
            const output = e.data.output.toLowerCase();
            if (output.includes('coding') || output.includes('research') || output.includes('analysis')) {
                return e.data.output;
            }
        }
    }
    return undefined;
}
