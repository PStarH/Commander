import type { HTMLReport } from '../runtime/types';
export declare class HTMLReportRenderer {
    /**
     * Render a complete HTML report.
     */
    render(report: HTMLReport): string;
    private renderContent;
    private renderSection;
    /**
     * Render a metrics row (key-value pairs).
     */
    renderMetrics(metrics: Record<string, string | number>): string;
    /**
     * Render a table from column headers and rows.
     */
    renderTable(headers: string[], rows: string[][]): string;
    /**
     * Render a status badge.
     */
    renderStatusBadge(label: string, status: 'success' | 'failed' | 'partial'): string;
    /**
     * Render a tag chip.
     */
    renderTag(label: string, variant?: 'green' | 'amber' | 'red' | 'blue'): string;
    escapeHtml(str: string): string;
}
export declare function getHTMLReportRenderer(): HTMLReportRenderer;
export declare function resetHTMLReportRenderer(): void;
export declare function createWarRoomHTMLReport(params: {
    projectName: string;
    operationCodename: string;
    health: 'GREEN' | 'AMBER' | 'RED';
    metrics: Record<string, string | number>;
    narrative: string;
    topAgents: Array<{
        name: string;
        completed: number;
    }>;
    missionSummary: Record<string, number>;
    recentEvents?: Array<{
        timestamp: string;
        level: string;
        message: string;
    }>;
}): HTMLReport;
//# sourceMappingURL=htmlReportRenderer.d.ts.map