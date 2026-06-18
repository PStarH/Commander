"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareTraces = compareTraces;
const timelineBuilder_1 = require("./timelineBuilder");
function eventsMatch(a, b) {
    return a.type === b.type && a.agentId === b.agentId;
}
function computeChanges(a, b) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    const changes = [];
    if (((_a = a.data.modelInfo) === null || _a === void 0 ? void 0 : _a.model) !== ((_b = b.data.modelInfo) === null || _b === void 0 ? void 0 : _b.model)) {
        changes.push(`model: ${(_d = (_c = a.data.modelInfo) === null || _c === void 0 ? void 0 : _c.model) !== null && _d !== void 0 ? _d : 'none'} → ${(_f = (_e = b.data.modelInfo) === null || _e === void 0 ? void 0 : _e.model) !== null && _f !== void 0 ? _f : 'none'}`);
    }
    if (((_g = a.data.tokenUsage) === null || _g === void 0 ? void 0 : _g.totalTokens) !== ((_h = b.data.tokenUsage) === null || _h === void 0 ? void 0 : _h.totalTokens)) {
        changes.push(`tokens: ${(_k = (_j = a.data.tokenUsage) === null || _j === void 0 ? void 0 : _j.totalTokens) !== null && _k !== void 0 ? _k : 0} → ${(_m = (_l = b.data.tokenUsage) === null || _l === void 0 ? void 0 : _l.totalTokens) !== null && _m !== void 0 ? _m : 0}`);
    }
    if (a.durationMs !== b.durationMs) {
        changes.push(`duration: ${a.durationMs}ms → ${b.durationMs}ms`);
    }
    if (a.data.error !== b.data.error) {
        changes.push(`error: ${(_o = a.data.error) !== null && _o !== void 0 ? _o : 'none'} → ${(_p = b.data.error) !== null && _p !== void 0 ? _p : 'none'}`);
    }
    return changes;
}
function compareTraces(traceA, traceB) {
    const eventsA = traceA.events;
    const eventsB = traceB.events;
    const matchedB = new Set();
    const eventDiffs = [];
    for (const a of eventsA) {
        let found = false;
        for (let j = 0; j < eventsB.length; j++) {
            if (matchedB.has(j))
                continue;
            const b = eventsB[j];
            if (eventsMatch(a, b)) {
                matchedB.add(j);
                const changes = computeChanges(a, b);
                eventDiffs.push({
                    type: changes.length > 0 ? 'modified' : 'unchanged',
                    spanId: a.spanId,
                    event: a,
                    changes: changes.length > 0 ? changes : undefined,
                });
                found = true;
                break;
            }
        }
        if (!found) {
            eventDiffs.push({ type: 'removed', spanId: a.spanId, event: a });
        }
    }
    for (let j = 0; j < eventsB.length; j++) {
        if (!matchedB.has(j)) {
            eventDiffs.push({ type: 'added', spanId: eventsB[j].spanId, event: eventsB[j] });
        }
    }
    const added = eventDiffs.filter((d) => d.type === 'added').length;
    const removed = eventDiffs.filter((d) => d.type === 'removed').length;
    const modified = eventDiffs.filter((d) => d.type === 'modified').length;
    const unchanged = eventDiffs.filter((d) => d.type === 'unchanged').length;
    const timelineA = (0, timelineBuilder_1.buildTimeline)(traceA);
    const timelineB = (0, timelineBuilder_1.buildTimeline)(traceB);
    const costA = timelineA.summary.totalCost.totalCostUsd;
    const costB = timelineB.summary.totalCost.totalCostUsd;
    const tokensA = timelineA.summary.totalTokens.total;
    const tokensB = timelineB.summary.totalTokens.total;
    const durationA = timelineA.totalDurationMs;
    const durationB = timelineB.totalDurationMs;
    return {
        runIdA: traceA.runId,
        runIdB: traceB.runId,
        summary: {
            totalEventsA: eventsA.length,
            totalEventsB: eventsB.length,
            added,
            removed,
            modified,
            unchanged,
        },
        eventDiffs,
        costDelta: {
            totalCostA: costA,
            totalCostB: costB,
            deltaUsd: costB - costA,
            deltaPercent: costA > 0 ? ((costB - costA) / costA) * 100 : 0,
        },
        tokenDelta: {
            totalTokensA: tokensA,
            totalTokensB: tokensB,
            delta: tokensB - tokensA,
            deltaPercent: tokensA > 0 ? ((tokensB - tokensA) / tokensA) * 100 : 0,
        },
        durationDelta: {
            durationA,
            durationB,
            deltaMs: durationB - durationA,
            deltaPercent: durationA > 0 ? ((durationB - durationA) / durationA) * 100 : 0,
        },
    };
}
