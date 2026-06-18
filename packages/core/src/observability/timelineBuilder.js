"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTimeline = buildTimeline;
exports.buildSpanTree = buildSpanTree;
const types_1 = require("./types");
const costModel_1 = require("./costModel");
const PREVIEW_CHARS = 200;
function truncate(s, n = PREVIEW_CHARS) {
    if (s.length <= n)
        return s;
    return s.slice(0, n) + '…';
}
function preview(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string')
        return truncate(value);
    try {
        return truncate(JSON.stringify(value));
    }
    catch {
        return undefined;
    }
}
function tokensFromEvent(e) {
    var _a, _b, _c;
    const u = e.data.tokenUsage;
    if (!u)
        return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
    const input = (_a = u.promptTokens) !== null && _a !== void 0 ? _a : 0;
    const output = (_b = u.completionTokens) !== null && _b !== void 0 ? _b : 0;
    const total = (_c = u.totalTokens) !== null && _c !== void 0 ? _c : input + output;
    return { input, output, cached: 0, reasoning: 0, total };
}
function nodeFromEvent(e, childSpanIds) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const kind = ((_a = types_1.COMMANDER_TYPE_TO_SPAN_KIND[e.type]) !== null && _a !== void 0 ? _a : 'CHAIN');
    const operation = types_1.SPAN_KIND_TO_OPERATION[kind];
    const tokens = e.data.tokenUsage ? tokensFromEvent(e) : undefined;
    const cost = e.data.modelInfo && tokens
        ? (0, costModel_1.getCostModel)().calculate(e.data.modelInfo.provider, e.data.modelInfo.model, tokens)
        : undefined;
    const endedAt = new Date(new Date(e.timestamp).getTime() + e.durationMs).toISOString();
    let promptContent;
    let completionContent;
    if (e.type === 'llm_call') {
        if (e.data.input && typeof e.data.input === 'object') {
            const req = e.data.input;
            if (typeof req['messages'] === 'string')
                promptContent = req['messages'];
            else if (Array.isArray(req['messages']))
                promptContent = JSON.stringify(req['messages']);
        }
        if (typeof e.data.output === 'string')
            completionContent = e.data.output;
        else if (e.data.output && typeof e.data.output === 'object') {
            const out = e.data.output;
            if (typeof out['content'] === 'string')
                completionContent = out['content'];
            else
                completionContent = JSON.stringify(e.data.output);
        }
    }
    return {
        spanId: e.spanId,
        parentSpanId: e.parentSpanId,
        traceId: e.traceId,
        type: kind,
        operation,
        name: e.type === 'llm_call'
            ? `chat ${(_c = (_b = e.data.modelInfo) === null || _b === void 0 ? void 0 : _b.model) !== null && _c !== void 0 ? _c : 'llm'}`
            : e.type === 'tool_execution'
                ? `execute_tool ${String((_d = e.data.input) !== null && _d !== void 0 ? _d : 'unknown')}`
                : e.type,
        startedAt: e.timestamp,
        endedAt,
        durationMs: e.durationMs,
        status: e.type === 'error' ? 'error' : 'ok',
        errorMessage: e.data.error,
        agentId: e.agentId,
        model: (_e = e.data.modelInfo) === null || _e === void 0 ? void 0 : _e.model,
        provider: (_f = e.data.modelInfo) === null || _f === void 0 ? void 0 : _f.provider,
        tier: (_g = e.data.tier) !== null && _g !== void 0 ? _g : (_h = e.data.modelInfo) === null || _h === void 0 ? void 0 : _h.tier,
        taskCategory: e.data.taskCategory,
        tokens,
        cost,
        reasoning: e.type === 'llm_call' ? preview(e.data.output) : undefined,
        promptContent,
        completionContent,
        toolInputPreview: e.type === 'tool_execution' ? preview(e.data.input) : undefined,
        toolOutputPreview: e.type === 'tool_execution' ? preview(e.data.output) : undefined,
        decision: e.type === 'decision'
            ? typeof e.data.output === 'string'
                ? e.data.output
                : preview(e.data.output)
            : undefined,
        stateTransition: e.data.stateTransition,
        evaluationScore: e.data.evaluationScore,
        evaluationPassed: e.data.evaluationPassed,
        hasChildren: childSpanIds.has(e.spanId),
    };
}
function buildTimeline(trace) {
    const events = trace.events;
    const childSpanIds = new Set();
    for (const e of events) {
        if (e.parentSpanId)
            childSpanIds.add(e.parentSpanId);
    }
    const nodes = events.map((e) => nodeFromEvent(e, childSpanIds));
    const costModel = (0, costModel_1.getCostModel)();
    const emptyTokens = costModel.emptyTokens();
    const emptyCost = costModel.emptyCost();
    let totalTokens = emptyTokens;
    let totalCost = emptyCost;
    let llmCalls = 0;
    let toolCalls = 0;
    let agentInvocations = 0;
    let errors = 0;
    const modelAgg = new Map();
    for (const n of nodes) {
        if (n.tokens)
            totalTokens = costModel.addTokens(totalTokens, n.tokens);
        if (n.cost)
            totalCost = costModel.addCost(totalCost, n.cost);
        if (n.type === 'LLM')
            llmCalls++;
        if (n.type === 'TOOL')
            toolCalls++;
        if (n.type === 'AGENT' || n.type === 'TASK')
            agentInvocations++;
        if (n.status === 'error')
            errors++;
        if (n.model && n.provider && n.cost && n.tokens) {
            const key = `${n.provider}:${n.model}`;
            const cur = modelAgg.get(key);
            if (cur) {
                cur.calls++;
                cur.tokens = costModel.addTokens(cur.tokens, n.tokens);
                cur.costUsd += n.cost.totalCostUsd;
            }
            else {
                modelAgg.set(key, {
                    model: n.model,
                    provider: n.provider,
                    calls: 1,
                    tokens: n.tokens,
                    costUsd: n.cost.totalCostUsd,
                });
            }
        }
    }
    const modelsUsed = Array.from(modelAgg.values()).map((m) => ({
        model: m.model,
        provider: m.provider,
        calls: m.calls,
        tokens: m.tokens.total,
        costUsd: m.costUsd,
    }));
    return {
        runId: trace.runId,
        traceId: trace.traceId,
        agentId: trace.agentId,
        tenantId: trace.tenantId,
        startedAt: trace.startedAt,
        endedAt: trace.completedAt,
        totalDurationMs: trace.completedAt
            ? new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()
            : trace.summary.totalDurationMs,
        nodes,
        summary: {
            totalSpans: nodes.length,
            llmCalls,
            toolCalls,
            agentInvocations,
            errors,
            totalTokens,
            totalCost,
            modelsUsed,
        },
    };
}
function buildSpanTree(trace) {
    const events = trace.events;
    const childSpanIds = new Set();
    for (const e of events)
        if (e.parentSpanId)
            childSpanIds.add(e.parentSpanId);
    const nodeMap = new Map();
    for (const e of events) {
        const span = nodeFromEvent(e, childSpanIds);
        nodeMap.set(e.spanId, { span, children: [], depth: 0 });
    }
    let root = null;
    const orphans = [];
    for (const e of events) {
        const node = nodeMap.get(e.spanId);
        if (!node)
            continue;
        if (!e.parentSpanId) {
            if (!root) {
                root = node;
                node.depth = 0;
            }
            else {
                orphans.push(node);
            }
        }
        else {
            const parent = nodeMap.get(e.parentSpanId);
            if (parent) {
                parent.children.push(node);
                node.depth = parent.depth + 1;
            }
            else {
                orphans.push(node);
            }
        }
    }
    return {
        runId: trace.runId,
        traceId: trace.traceId,
        root: root !== null && root !== void 0 ? root : {
            span: nodeFromEvent(events[0], childSpanIds),
            children: [],
            depth: 0,
        },
        orphans,
    };
}
