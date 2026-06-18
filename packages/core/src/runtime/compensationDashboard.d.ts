/**
 * CompensationDashboard — Data aggregation and HTML page for compensation observability.
 *
 * Provides:
 * 1. `getCompensationData()` — JSON-serializable snapshot of compensation metrics + recent events
 * 2. `renderDashboardHtml()` — Self-contained HTML dashboard page with charts via SSE live updates
 *
 * The dashboard reads from MetricsCollector counters (compensation_planned_total,
 * compensation_steps_total, compensation_total) and MessageBus history.
 * The HTML page connects to /stream/compensation SSE for real-time updates.
 */
import type { MessageBus } from './messageBus';
export interface CompensationDashboardData {
    /** Counter snapshots keyed by metric name */
    counters: Record<string, number>;
    /** Per-tool breakdown of compensation_planned_total */
    byTool: Record<string, number>;
    /** Per-risk breakdown of compensation_planned_total */
    byRisk: Record<string, number>;
    /** Per-status breakdown of compensation_steps_total */
    byStepStatus: Record<string, number>;
    /** Compensation total (success/failed/exhausted) */
    compensationOutcomes: Record<string, number>;
    /** Recent bus events (up to 50) */
    recentEvents: Array<{
        id: string;
        topic: string;
        timestamp: string;
        summary: string;
    }>;
    /** Snapshot timestamp */
    timestamp: string;
}
/**
 * Aggregate compensation metrics and recent bus events into a JSON-serializable snapshot.
 */
export declare function getCompensationData(bus: MessageBus): CompensationDashboardData;
/**
 * Render a self-contained HTML dashboard page for compensation observability.
 * Uses Chart.js from CDN for bar charts and SSE for real-time updates.
 */
export declare function renderDashboardHtml(bus: MessageBus): string;
//# sourceMappingURL=compensationDashboard.d.ts.map