import type { HTMLReport, HTMLReportSection } from '../runtime/types';

const HTML_BOILERPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: #02040a;
    --surface: #04070f;
    --border: #151c23;
    --text: #e5f0da;
    --text-dim: #7f8c86;
    --accent: #4de98c;
    --accent-dim: rgba(77, 233, 140, 0.15);
    --warn: #ffcc66;
    --error: #ff8b9d;
    --font: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .report { max-width: 960px; margin: 0 auto; }
  .report-header { margin-bottom: 28px; }
  .report-eyebrow {
    text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.7rem; color: var(--accent); margin-bottom: 6px;
  }
  .report-title { font-size: 2rem; letter-spacing: -0.03em; margin-bottom: 6px; }
  .report-subtitle { color: var(--text-dim); font-size: 0.9rem; }
  .report-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: 0.78rem; color: var(--text-dim); }
  .report-meta span { padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
  .highlights {
    display: grid; gap: 8px; margin-bottom: 28px; padding: 14px 16px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  }
  .highlights h3 { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.72rem; color: var(--accent); margin-bottom: 8px; }
  .highlight-item {
    padding: 8px 12px; border-left: 2px solid var(--accent);
    background: var(--accent-dim); border-radius: 0 4px 4px 0; font-size: 0.88rem;
  }
  .section {
    margin-bottom: 20px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface); overflow: hidden;
  }
  .section-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer;
    user-select: none;
  }
  .section-header:hover { background: rgba(77, 233, 140, 0.04); }
  .section-title { font-size: 1rem; font-weight: 600; }
  .section-toggle { color: var(--text-dim); font-size: 0.78rem; }
  .section-body { padding: 14px 16px; }
  .section-body.collapsed { display: none; }

  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: var(--accent); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(77, 233, 140, 0.03); }

  .metric-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  .metric-card {
    padding: 12px; border-radius: 6px; border: 1px solid var(--border); background: #050913;
  }
  .metric-label { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.7rem; color: var(--text-dim); }
  .metric-value { display: block; margin-top: 6px; font-size: 1.4rem; font-weight: 600; }

  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em; border: 1px solid var(--border); }
  .tag-green { border-color: rgba(77, 233, 140, 0.7); color: #4de98c; background: rgba(10, 40, 20, 0.85); }
  .tag-amber { border-color: rgba(255, 196, 92, 0.8); color: #ffcc66; background: rgba(40, 30, 10, 0.85); }
  .tag-red { border-color: rgba(255, 105, 120, 0.8); color: #ff8b9d; background: rgba(40, 10, 16, 0.85); }
  .tag-blue { border-color: rgba(126, 167, 191, 0.8); color: #9cc4df; background: rgba(11, 24, 34, 0.9); }

  .trace-step { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 0.84rem; }
  .trace-step:last-child { border-bottom: none; }
  .trace-header { display: flex; justify-content: space-between; gap: 8px; }
  .trace-type { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; font-weight: 600; }
  .trace-tokens { color: var(--text-dim); font-size: 0.75rem; }
  .trace-detail { margin-top: 4px; color: var(--text-dim); font-size: 0.8rem; max-height: 120px; overflow-y: auto; }

  .status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  }
  .status-success { background: rgba(77, 233, 140, 0.15); color: #4de98c; }
  .status-failed { background: rgba(255, 105, 120, 0.15); color: #ff8b9d; }
  .status-partial { background: rgba(255, 196, 92, 0.15); color: #ffcc66; }

  @media (max-width: 640px) {
    body { padding: 12px; }
    .metric-row { grid-template-columns: repeat(2, 1fr); }
    .report-title { font-size: 1.5rem; }
  }
</style>
</head>
<body>
<div class="report">{CONTENT}</div>
</body>
</html>`;

export class HTMLReportRenderer {
  /**
   * Render a complete HTML report.
   */
  render(report: HTMLReport): string {
    const content = this.renderContent(report);
    return HTML_BOILERPLATE.replace('{CONTENT}', content);
  }

  private renderContent(report: HTMLReport): string {
    const highlightsHtml = report.highlights.length > 0
      ? `<div class="highlights"><h3>Key Highlights</h3>${report.highlights.map(h =>
          `<div class="highlight-item">${this.escapeHtml(h)}</div>`
        ).join('')}</div>`
      : '';

    const sectionsHtml = report.sections
      .sort((a, b) => a.priority - b.priority)
      .map(s => this.renderSection(s))
      .join('');

    return `
      <div class="report-header">
        <div class="report-eyebrow">${report.metadata['type'] ?? 'Report'}</div>
        <h1 class="report-title">${this.escapeHtml(report.title)}</h1>
        ${report.subtitle ? `<p class="report-subtitle">${this.escapeHtml(report.subtitle)}</p>` : ''}
        <div class="report-meta">
          ${Object.entries(report.metadata).map(([k, v]) =>
            `<span>${this.escapeHtml(k)}: ${this.escapeHtml(v)}</span>`
          ).join('')}
          <span>Generated: ${report.generatedAt}</span>
        </div>
      </div>
      ${highlightsHtml}
      ${sectionsHtml}
    `;
  }

  private renderSection(section: HTMLReportSection): string {
    const collapseAttr = section.collapsible ? ' onclick="this.parentElement.querySelector(\'.section-body\').classList.toggle(\'collapsed\')"' : '';
    const toggleHtml = section.collapsible ? '<span class="section-toggle">click to toggle</span>' : '';

    return `
      <div class="section">
        <div class="section-header"${collapseAttr}>
          <span class="section-title">${this.escapeHtml(section.title)}</span>
          ${toggleHtml}
        </div>
        <div class="section-body">
          ${section.content}
        </div>
      </div>
    `;
  }

  /**
   * Render a metrics row (key-value pairs).
   */
  renderMetrics(metrics: Record<string, string | number>): string {
    return `<div class="metric-row">${Object.entries(metrics).map(([label, value]) =>
      `<div class="metric-card">
        <div class="metric-label">${this.escapeHtml(label)}</div>
        <div class="metric-value">${this.escapeHtml(String(value))}</div>
      </div>`
    ).join('')}</div>`;
  }

  /**
   * Render a table from column headers and rows.
   */
  renderTable(headers: string[], rows: string[][]): string {
    return `<table><thead><tr>${headers.map(h => `<th>${this.escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row =>
        `<tr>${row.map(cell => `<td>${this.escapeHtml(cell)}</td>`).join('')}</tr>`
      ).join('')}</tbody></table>`;
  }

  /**
   * Render a status badge.
   */
  renderStatusBadge(label: string, status: 'success' | 'failed' | 'partial'): string {
    return `<span class="status-badge status-${status}">${this.escapeHtml(label)}</span>`;
  }

  /**
   * Render a tag chip.
   */
  renderTag(label: string, variant: 'green' | 'amber' | 'red' | 'blue' = 'blue'): string {
    return `<span class="tag tag-${variant}">${this.escapeHtml(label)}</span>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

let globalRenderer: HTMLReportRenderer | null = null;

export function getHTMLReportRenderer(): HTMLReportRenderer {
  if (!globalRenderer) {
    globalRenderer = new HTMLReportRenderer();
  }
  return globalRenderer;
}

export function createWarRoomHTMLReport(params: {
  projectName: string;
  operationCodename: string;
  health: 'GREEN' | 'AMBER' | 'RED';
  metrics: Record<string, string | number>;
  narrative: string;
  topAgents: Array<{ name: string; completed: number }>;
  missionSummary: Record<string, number>;
  recentEvents?: Array<{ timestamp: string; level: string; message: string }>;
}): HTMLReport {
  const renderer = getHTMLReportRenderer();

  const sections: HTMLReportSection[] = [
    {
      title: 'Project Pulse',
      content: renderer.renderMetrics(params.metrics),
      collapsible: false,
      priority: 0,
    },
    {
      title: 'Battle Narrative',
      content: `<p style="padding: 8px 12px; border-left: 2px solid #4de98c; background: rgba(7,16,12,0.96); line-height: 1.6;">${params.narrative}</p>`,
      collapsible: true,
      priority: 1,
    },
    {
      title: 'Agent Leaderboard',
      content: params.topAgents.length > 0
        ? renderer.renderTable(
            ['Agent', 'Missions Completed'],
            params.topAgents.map(a => [a.name, String(a.completed), a.completed >= 5 ? renderer.renderTag('top performer', 'green') : '']),
          )
        : '<p style="color: var(--text-dim);">No agents have completed missions yet.</p>',
      collapsible: true,
      priority: 2,
    },
    {
      title: 'Mission Board',
      content: renderer.renderMetrics(params.missionSummary),
      collapsible: true,
      priority: 3,
    },
  ];

  if (params.recentEvents && params.recentEvents.length > 0) {
    sections.push({
      title: 'Recent Execution Events',
      content: params.recentEvents.map(e =>
        `<div class="trace-step">
          <div class="trace-header">
            <span class="trace-type">${e.level}</span>
            <span class="trace-tokens">${e.timestamp}</span>
          </div>
          <div class="trace-detail">${e.message}</div>
        </div>`
      ).join(''),
      collapsible: true,
      priority: 4,
    });
  }

  return {
    title: `War Room Report — ${params.operationCodename}`,
    subtitle: params.projectName,
    metadata: {
      type: 'WAR_ROOM_REPORT',
      health: params.health,
      'data source': 'Commander API',
    },
    sections,
    generatedAt: new Date().toISOString(),
    highlights: [
      `Project health: ${params.health}`,
      ...(params.topAgents[0] ? [`Lead: ${params.topAgents[0].name} (${params.topAgents[0].completed} missions)`] : []),
    ],
  };
}
