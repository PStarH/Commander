import type { TraceEvent } from '../runtime/types';
interface ToolStats {
    toolName: string;
    invocations: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
    avgDurationMs: number;
    lastUsed: string;
}
interface ToolMetricsSummary {
    totalTools: number;
    totalInvocations: number;
    overallSuccessRate: number;
    tools: ToolStats[];
}
export declare class ToolMetricsCollector {
    private toolStats;
    recordToolExecution(event: TraceEvent): void;
    recordFromTrace(events: TraceEvent[]): void;
    getToolStats(toolName: string): ToolStats | undefined;
    getAllStats(): ToolStats[];
    getSuccessRate(toolName: string): number;
    getSummary(): ToolMetricsSummary;
}
export declare function getToolMetricsCollector(): ToolMetricsCollector;
export declare function resetToolMetricsCollector(): void;
export {};
//# sourceMappingURL=toolMetrics.d.ts.map