"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptVersionTracker = void 0;
exports.getPromptVersionTracker = getPromptVersionTracker;
exports.resetPromptVersionTracker = resetPromptVersionTracker;
function hashPrompt(prompt) {
    let hash = 0;
    for (let i = 0; i < prompt.length; i++) {
        const char = prompt.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}
function extractPrompt(event) {
    if (event.type !== 'llm_call')
        return undefined;
    if (typeof event.data.input === 'string')
        return event.data.input;
    if (event.data.input && typeof event.data.input === 'object') {
        const req = event.data.input;
        if (typeof req['messages'] === 'string')
            return req['messages'];
        if (Array.isArray(req['messages']))
            return JSON.stringify(req['messages']);
    }
    return undefined;
}
class PromptVersionTracker {
    constructor() {
        this.versions = new Map();
        this.eventVersions = new Map();
    }
    recordEvent(event) {
        var _a, _b;
        const prompt = extractPrompt(event);
        if (!prompt)
            return;
        const hash = hashPrompt(prompt);
        const versionId = `v-${hash}`;
        const preview = prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt;
        let version = this.versions.get(versionId);
        if (!version) {
            version = {
                versionId,
                promptHash: hash,
                promptPreview: preview,
                firstSeen: event.timestamp,
                lastSeen: event.timestamp,
                runCount: 0,
                avgTokens: 0,
                avgDurationMs: 0,
                successRate: 0,
            };
            this.versions.set(versionId, version);
        }
        version.lastSeen = event.timestamp;
        version.runCount++;
        const tokens = (_b = (_a = event.data.tokenUsage) === null || _a === void 0 ? void 0 : _a.totalTokens) !== null && _b !== void 0 ? _b : 0;
        version.avgTokens = (version.avgTokens * (version.runCount - 1) + tokens) / version.runCount;
        version.avgDurationMs =
            (version.avgDurationMs * (version.runCount - 1) + event.durationMs) / version.runCount;
        this.eventVersions.set(event.spanId, versionId);
    }
    recordFromTrace(trace) {
        for (const event of trace.events)
            this.recordEvent(event);
    }
    getVersion(versionId) {
        return this.versions.get(versionId);
    }
    getAllVersions() {
        return Array.from(this.versions.values()).sort((a, b) => b.runCount - a.runCount);
    }
    getVersionForEvent(spanId) {
        const versionId = this.eventVersions.get(spanId);
        return versionId ? this.versions.get(versionId) : undefined;
    }
    compareVersions(versionIdA, versionIdB) {
        const a = this.versions.get(versionIdA);
        const b = this.versions.get(versionIdB);
        if (!a || !b)
            return undefined;
        const shorter = Math.min(a.promptPreview.length, b.promptPreview.length);
        let matches = 0;
        for (let i = 0; i < shorter; i++) {
            if (a.promptPreview[i] === b.promptPreview[i])
                matches++;
        }
        const similarity = shorter > 0 ? matches / shorter : 0;
        return {
            versionA: versionIdA,
            versionB: versionIdB,
            similarity,
            tokenDelta: b.avgTokens - a.avgTokens,
            costDelta: 0,
        };
    }
    getSummary() {
        const versions = this.getAllVersions();
        const totalEvents = versions.reduce((sum, v) => sum + v.runCount, 0);
        return {
            totalVersions: versions.length,
            totalEvents,
            mostUsedVersion: versions[0],
            avgTokensByVersion: versions.map((v) => ({
                versionId: v.versionId,
                avgTokens: v.avgTokens,
                runCount: v.runCount,
            })),
        };
    }
}
exports.PromptVersionTracker = PromptVersionTracker;
let globalTracker = null;
function getPromptVersionTracker() {
    if (!globalTracker)
        globalTracker = new PromptVersionTracker();
    return globalTracker;
}
function resetPromptVersionTracker() {
    globalTracker = null;
}
