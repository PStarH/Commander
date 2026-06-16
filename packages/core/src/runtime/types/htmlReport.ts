// ============================================================================
// HTML Report Types
// ============================================================================

/**
 * Section of an HTML report.
 */
export interface HTMLReportSection {
  title: string;
  content: string;   // HTML content
  collapsible?: boolean;
  priority: number;  // display order
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
