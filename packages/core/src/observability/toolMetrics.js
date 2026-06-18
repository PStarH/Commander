"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolMetricsCollector = void 0;
exports.getToolMetricsCollector = getToolMetricsCollector;
exports.resetToolMetricsCollector = resetToolMetricsCollector;
class ToolMetricsCollector {
    constructor() {
        this.toolStats = new Map();
    }
    recordToolExecution(event) {
        var _a;
        if (event.type !== 'tool_execution')
            return;
        const toolName = String((_a = event.data.input) !== null && _a !== void 0 ? _a : 'unknown');
        const hasError = !!event.data.error;
        let stats = this.toolStats.get(toolName);
        if (!stats) {
            stats = {
                toolName,
                invocations: 0,
                successes: 0,
                failures: 0,
                totalDurationMs: 0,
                avgDurationMs: 0,
                lastUsed: event.timestamp,
            };
            this.toolStats.set(toolName, stats);
        }
        stats.invocations++;
        if (hasError)
            stats.failures++;
        else
            stats.successes++;
        stats.totalDurationMs += event.durationMs;
        stats.avgDurationMs = stats.totalDurationMs / stats.invocations;
        if (event.timestamp > stats.lastUsed)
            stats.lastUsed = event.timestamp;
    }
    recordFromTrace(events) {
        for (const e of events)
            this.recordToolExecution(e);
    }
    getToolStats(toolName) {
        return this.toolStats.get(toolName);
    }
    getAllStats() {
        return Array.from(this.toolStats.values()).sort((a, b) => b.invocations - a.invocations);
    }
    getSuccessRate(toolName) {
        const stats = this.toolStats.get(toolName);
        if (!stats || stats.invocations === 0)
            return 0;
        return stats.successes / stats.invocations;
    }
    getSummary() {
        const tools = this.getAllStats();
        const totalInvocations = tools.reduce((sum, t) => sum + t.invocations, 0);
        const totalSuccesses = tools.reduce((sum, t) => sum + t.successes, 0);
        return {
            totalTools: tools.length,
            totalInvocations,
            overallSuccessRate: totalInvocations > 0 ? totalSuccesses / totalInvocations : 0,
            tools,
        };
    }
}
exports.ToolMetricsCollector = ToolMetricsCollector;
let globalCollector = null;
function getToolMetricsCollector() {
    if (!globalCollector)
        globalCollector = new ToolMetricsCollector();
    return globalCollector;
}
function resetToolMetricsCollector() {
    globalCollector = null;
}
