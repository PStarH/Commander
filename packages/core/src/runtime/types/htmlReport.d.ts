/**
 * Section of an HTML report.
 */
export interface HTMLReportSection {
    title: string;
    content: string;
    collapsible?: boolean;
    priority: number;
}
/**
 * Complete HTML report for human consumption.
 */
export interface HTMLReport {
    title: string;
    subtitle?: string;
    metadata: Record<string, string>;
    sections: HTMLReportSection[];
    generatedAt: string;
    /** Highlights/insights for the executive summary */
    highlights: string[];
}
//# sourceMappingURL=htmlReport.d.ts.map