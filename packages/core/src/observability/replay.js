"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dryReplay = dryReplay;
exports.liveReplay = liveReplay;
const timelineBuilder_1 = require("./timelineBuilder");
function applySubstitution(node, spec) {
    for (const sub of spec.substitutions) {
        if (sub.spanId !== node.spanId)
            continue;
        if (sub.target === 'tool_output' && node.type === 'TOOL') {
            return { ...node, toolOutputPreview: previewOf(sub.value) };
        }
        if (sub.target === 'tool_input' && node.type === 'TOOL') {
            return { ...node, toolInputPreview: previewOf(sub.value) };
        }
        if (sub.target === 'llm_response' && node.type === 'LLM') {
            return { ...node, reasoning: previewOf(sub.value) };
        }
    }
    return node;
}
function previewOf(v, n = 200) {
    if (v === undefined || v === null)
        return '';
    if (typeof v === 'string')
        return v.length > n ? v.slice(0, n) + '…' : v;
    try {
        const s = JSON.stringify(v);
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    catch {
        return String(v).slice(0, n);
    }
}
function dryReplay(trace, spec) {
    const originalTimeline = (0, timelineBuilder_1.buildTimeline)(trace);
    const replayedNodes = originalTimeline.nodes.map((n) => applySubstitution(n, spec));
    const replaySummary = recomputeSummary(replayedNodes);
    const newSpans = replayedNodes.filter((n) => !originalTimeline.nodes.some((o) => o.spanId === n.spanId)).length;
    const changedSpans = replayedNodes.filter((n) => {
        const o = originalTimeline.nodes.find((x) => x.spanId === n.spanId);
        if (!o)
            return false;
        return (o.reasoning !== n.reasoning ||
            o.toolOutputPreview !== n.toolOutputPreview ||
            o.toolInputPreview !== n.toolInputPreview);
    }).length;
    const costDelta = replaySummary.totalCost.totalCostUsd - originalTimeline.summary.totalCost.totalCostUsd;
    const tokenDelta = replaySummary.totalTokens.total - originalTimeline.summary.totalTokens.total;
    return {
        runId: trace.runId,
        traceId: trace.traceId,
        originalSummary: originalTimeline.summary,
        replaySummary,
        diff: { newSpans, changedSpans, costDeltaUsd: costDelta, tokenDelta },
        replayedNodes,
    };
}
async function liveReplay(trace, spec, ctx, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    if (!spec.reExecuteLlm) {
        return { ...dryReplay(trace, spec), mode: 'dry', reExecutedSpans: [] };
    }
    const originalTimeline = (0, timelineBuilder_1.buildTimeline)(trace);
    const replayedNodes = [];
    const reExecutedSpans = [];
    for (const originalNode of originalTimeline.nodes) {
        if (originalNode.type !== 'LLM') {
            replayedNodes.push(applySubstitution(originalNode, spec));
            continue;
        }
        if (options.onlySpanIds && !options.onlySpanIds.includes(originalNode.spanId)) {
            replayedNodes.push(applySubstitution(originalNode, spec));
            continue;
        }
        const model = (_b = (_a = options.modelOverride) !== null && _a !== void 0 ? _a : originalNode.model) !== null && _b !== void 0 ? _b : 'unknown';
        const prompt = originalNode.toolInputPreview || originalNode.reasoning || '';
        const originalEvent = findEventForNode(trace, originalNode.spanId);
        const originalTokens = {
            promptTokens: (_d = (_c = originalNode.tokens) === null || _c === void 0 ? void 0 : _c.input) !== null && _d !== void 0 ? _d : 0,
            completionTokens: (_f = (_e = originalNode.tokens) === null || _e === void 0 ? void 0 : _e.output) !== null && _f !== void 0 ? _f : 0,
            totalTokens: (_h = (_g = originalNode.tokens) === null || _g === void 0 ? void 0 : _g.total) !== null && _h !== void 0 ? _h : 0,
        };
        try {
            if ((_j = ctx.signal) === null || _j === void 0 ? void 0 : _j.aborted)
                throw new Error('replay aborted');
            const result = await ctx.invokeLlm({
                spanId: originalNode.spanId,
                model,
                prompt,
                originalTokens,
            });
            const substituted = applySubstitution({ ...originalNode, reasoning: result.text }, spec);
            replayedNodes.push({
                ...substituted,
                model,
                tokens: {
                    input: result.tokens.promptTokens,
                    output: result.tokens.completionTokens,
                    cached: (_l = (_k = substituted.tokens) === null || _k === void 0 ? void 0 : _k.cached) !== null && _l !== void 0 ? _l : 0,
                    reasoning: (_m = originalEvent === null || originalEvent === void 0 ? void 0 : originalEvent.data.reasoningTokens) !== null && _m !== void 0 ? _m : 0,
                    total: result.tokens.totalTokens,
                },
                cost: {
                    totalCostUsd: result.costUsd,
                    inputCostUsd: 0,
                    outputCostUsd: result.costUsd,
                },
            });
            reExecutedSpans.push(originalNode.spanId);
        }
        catch (err) {
            replayedNodes.push(applySubstitution(originalNode, spec));
        }
    }
    const replaySummary = recomputeSummary(replayedNodes);
    const newSpans = replayedNodes.filter((n) => !originalTimeline.nodes.some((o) => o.spanId === n.spanId)).length;
    const changedSpans = replayedNodes.filter((n) => {
        const o = originalTimeline.nodes.find((x) => x.spanId === n.spanId);
        if (!o)
            return false;
        return (o.reasoning !== n.reasoning ||
            o.toolOutputPreview !== n.toolOutputPreview ||
            o.toolInputPreview !== n.toolInputPreview ||
            o.model !== n.model);
    }).length;
    const costDelta = replaySummary.totalCost.totalCostUsd - originalTimeline.summary.totalCost.totalCostUsd;
    const tokenDelta = replaySummary.totalTokens.total - originalTimeline.summary.totalTokens.total;
    return {
        runId: trace.runId,
        traceId: trace.traceId,
        originalSummary: originalTimeline.summary,
        replaySummary,
        diff: { newSpans, changedSpans, costDeltaUsd: costDelta, tokenDelta },
        replayedNodes,
        mode: 'live',
        reExecutedSpans,
    };
}
function findEventForNode(trace, spanId) {
    return trace.events.find((e) => e.spanId === spanId);
}
function recomputeSummary(nodes) {
    const cost = { totalCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
    const tokens = { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
    let llmCalls = 0, toolCalls = 0, agentInvocations = 0, errors = 0;
    for (const n of nodes) {
        if (n.tokens) {
            tokens.input += n.tokens.input;
            tokens.output += n.tokens.output;
            tokens.cached += n.tokens.cached;
            tokens.reasoning += n.tokens.reasoning;
            tokens.total += n.tokens.total;
        }
        if (n.cost) {
            cost.totalCostUsd += n.cost.totalCostUsd;
            cost.inputCostUsd += n.cost.inputCostUsd;
            cost.outputCostUsd += n.cost.outputCostUsd;
        }
        if (n.type === 'LLM')
            llmCalls++;
        if (n.type === 'TOOL')
            toolCalls++;
        if (n.type === 'AGENT' || n.type === 'TASK')
            agentInvocations++;
        if (n.status === 'error')
            errors++;
    }
    return {
        totalSpans: nodes.length,
        llmCalls,
        toolCalls,
        agentInvocations,
        errors,
        totalTokens: tokens,
        totalCost: cost,
        modelsUsed: [],
    };
}
