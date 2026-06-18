import type { SOPTemplate } from './sopExport';
export interface SOPListItem {
    agentId: string;
    runId: string;
    goal: string;
    status: string;
    stepCount: number;
    tags: string[];
    generatedAt: string;
    hasMarkdown: boolean;
    hasJson: boolean;
}
export interface SOPDashboardData {
    agents: string[];
    total: number;
    sops: SOPListItem[];
    recentEvents: Array<{
        topic: string;
        timestamp: string;
        payload: unknown;
    }>;
    timestamp: string;
}
/**
 * List all generated SOPs, grouped by agent.
 * Scans the SOP directory for agentId subdirectories.
 */
export declare function listSOPs(customDir?: string): SOPListItem[];
/**
 * Retrieve a specific SOP as a structured object.
 */
export declare function getSOP(agentId: string, runId: string, customDir?: string): SOPTemplate | null;
/**
 * Retrieve a specific SOP as Markdown string.
 */
export declare function getSOPMarkdown(agentId: string, runId: string, customDir?: string): string | null;
/**
 * Build dashboard data snapshot from bus events and filesystem.
 */
export declare function getSOPDashboardData(customDir?: string): SOPDashboardData;
/**
 * Render a self-contained HTML dashboard page for SOP observability.
 * Uses Chart.js from CDN for charts and SSE for real-time updates.
 * Includes search/filter and expandable SOP detail rows.
 */
export declare function renderSOPDashboardHtml(customDir?: string): string;
//# sourceMappingURL=sopDashboard.d.ts.map