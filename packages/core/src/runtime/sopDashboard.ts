/**
 * SOP Dashboard — HTTP API helpers for listing and retrieving generated SOPs.
 *
 * Scans the SOP directory (.commander/sops by default) and aggregates
 * bus events for real-time SSE streaming.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getMessageBus } from './messageBus';
import type { BusMessage } from './types';
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
 * Default SOP directory relative to project root.
 */
function getDefaultSOPDir(): string {
  return path.join(process.cwd(), '.commander', 'sops');
}

/**
 * Resolve the SOP directory. Accepts an optional custom path.
 */
function resolveSOPDir(customDir?: string): string {
  return customDir || getDefaultSOPDir();
}

/**
 * Sanitize a path segment for safe filesystem access.
 * Strips path traversal sequences and limits length.
 */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}

/**
 * List all generated SOPs, grouped by agent.
 * Scans the SOP directory for agentId subdirectories.
 */
export function listSOPs(customDir?: string): SOPListItem[] {
  const baseDir = resolveSOPDir(customDir);
  if (!fs.existsSync(baseDir)) return [];

  const items: SOPListItem[] = [];

  try {
    const agentDirs = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) continue;
      const agentId = agentDir.name;
      const agentPath = path.join(baseDir, agentId);

      try {
        const files = fs.readdirSync(agentPath);
        // Find JSON files (the structured source of truth)
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
          const runId = jsonFile.replace(/\.json$/, '');
          const jsonPath = path.join(agentPath, jsonFile);
          const mdPath = path.join(agentPath, `${runId}.md`);

          try {
            const raw = fs.readFileSync(jsonPath, 'utf-8');
            const sop = JSON.parse(raw) as SOPTemplate;
            const stat = fs.statSync(jsonPath);

            items.push({
              agentId,
              runId,
              goal: sop.goal || 'Untitled',
              status: 'success',
              stepCount: sop.totalSteps || 0,
              tags: sop.tags || [],
              generatedAt: stat.mtime.toISOString(),
              hasMarkdown: files.includes(`${runId}.md`),
              hasJson: true,
            });
          } catch (err) {
            console.warn('[Catch]', err);
            // Corrupt JSON file — skip
          }
        }
      } catch (err) {
        console.warn('[Catch]', err);
        // Permission error or similar — skip this agent
      }
    }
  } catch (err) {
    console.warn('[Catch]', err);
    // Base dir doesn't exist or can't be read
  }

  // Sort by generatedAt descending (most recent first)
  items.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

  return items;
}

/**
 * Retrieve a specific SOP as a structured object.
 */
export function getSOP(agentId: string, runId: string, customDir?: string): SOPTemplate | null {
  const baseDir = resolveSOPDir(customDir);
  const safeAgent = sanitizeSegment(agentId);
  const safeRun = sanitizeSegment(runId);
  const jsonPath = path.join(baseDir, safeAgent, `${safeRun}.json`);

  if (!fs.existsSync(jsonPath)) return null;

  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    return JSON.parse(raw) as SOPTemplate;
  } catch (err) {
    console.warn('[Catch]', err);
    return null;
  }
}

/**
 * Retrieve a specific SOP as Markdown string.
 */
export function getSOPMarkdown(agentId: string, runId: string, customDir?: string): string | null {
  const baseDir = resolveSOPDir(customDir);
  const safeAgent = sanitizeSegment(agentId);
  const safeRun = sanitizeSegment(runId);
  const mdPath = path.join(baseDir, safeAgent, `${safeRun}.md`);

  if (!fs.existsSync(mdPath)) return null;

  try {
    return fs.readFileSync(mdPath, 'utf-8');
  } catch (err) {
    console.warn('[Catch]', err);
    return null;
  }
}

/**
 * Build dashboard data snapshot from bus events and filesystem.
 */
export function getSOPDashboardData(customDir?: string): SOPDashboardData {
  const bus = getMessageBus();
  const sops = listSOPs(customDir);

  // Collect recent bus events related to SOPs
  const history =
    (bus as { getHistory?: (topic?: string, limit?: number) => BusMessage[] }).getHistory?.(
      'sop.generated',
      50,
    ) || [];

  const recentEvents = history.map((msg) => ({
    topic: msg.topic,
    timestamp: msg.timestamp,
    payload: msg.payload,
  }));

  // Collect unique agent IDs
  const agents = [...new Set(sops.map((s) => s.agentId))];

  return {
    agents,
    total: sops.length,
    sops,
    recentEvents,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// HTML dashboard
// ============================================================================

/**
 * Render a self-contained HTML dashboard page for SOP observability.
 * Uses Chart.js from CDN for charts and SSE for real-time updates.
 * Includes search/filter and expandable SOP detail rows.
 */
export function renderSOPDashboardHtml(customDir?: string): string {
  const data = getSOPDashboardData(customDir);

  // Compute aggregate stats
  const totalSOPs = data.total;
  const totalAgents = data.agents.length;
  const totalSteps = data.sops.reduce((sum, s) => sum + s.stepCount, 0);
  const totalTags = [...new Set(data.sops.flatMap((s) => s.tags))].length;

  // Chart data: by agent
  const agentCounts: Record<string, number> = {};
  for (const sop of data.sops) {
    agentCounts[sop.agentId] = (agentCounts[sop.agentId] || 0) + 1;
  }
  const byAgentLabels = JSON.stringify(Object.keys(agentCounts));
  const byAgentValues = JSON.stringify(Object.values(agentCounts));

  // Chart data: top 10 tags
  const tagCounts: Record<string, number> = {};
  for (const sop of data.sops) {
    for (const tag of sop.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const byTagLabels = JSON.stringify(topTags.map((t) => t[0]));
  const byTagValues = JSON.stringify(topTags.map((t) => t[1]));

  // Chart data: step count distribution
  const stepBuckets: Record<string, number> = {
    '<10': 0,
    '10-25': 0,
    '26-50': 0,
    '51-100': 0,
    '100+': 0,
  };
  for (const sop of data.sops) {
    if (sop.stepCount < 10) stepBuckets['<10']++;
    else if (sop.stepCount <= 25) stepBuckets['10-25']++;
    else if (sop.stepCount <= 50) stepBuckets['26-50']++;
    else if (sop.stepCount <= 100) stepBuckets['51-100']++;
    else stepBuckets['100+']++;
  }
  const byStepLabels = JSON.stringify(Object.keys(stepBuckets));
  const byStepValues = JSON.stringify(Object.values(stepBuckets));

  // Table rows
  const tableRows = data.sops
    .map(
      (sop, i) =>
        `<tr class="sop-row" data-index="${i}" onclick="toggleDetail(${i})">
          <td><span class="agent-badge">${escapeHtml(sop.agentId)}</span></td>
          <td class="goal-cell">${escapeHtml(sop.goal.slice(0, 80))}${sop.goal.length > 80 ? '&hellip;' : ''}</td>
          <td>${sop.stepCount}</td>
          <td class="tags-cell">${sop.tags
            .slice(0, 3)
            .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
            .join(
              ' ',
            )}${sop.tags.length > 3 ? ` <span class="tag-more">+${sop.tags.length - 3}</span>` : ''}</td>
          <td class="timestamp">${new Date(sop.generatedAt).toLocaleString()}</td>
          <td class="actions-cell">
            <a href="/api/v1/sops/${encodeURIComponent(sop.agentId)}/${encodeURIComponent(sop.runId)}" class="action-link" title="View JSON" onclick="event.stopPropagation()">JSON</a>
            ${sop.hasMarkdown ? `<a href="/api/v1/sops/${encodeURIComponent(sop.agentId)}/${encodeURIComponent(sop.runId)}/markdown" class="action-link" title="View Markdown" onclick="event.stopPropagation()">MD</a>` : ''}
          </td>
        </tr>
        <tr class="detail-row" id="detail-${i}" style="display:none">
          <td colspan="6">
            <div class="detail-panel">
              <div class="detail-section">
                <strong>Goal:</strong> ${escapeHtml(sop.goal)}
              </div>
              <div class="detail-section">
                <strong>Run ID:</strong> <code>${escapeHtml(sop.runId)}</code>
              </div>
              <div class="detail-section">
                <strong>Agent:</strong> <code>${escapeHtml(sop.agentId)}</code>
              </div>
              <div class="detail-section">
                <strong>Tags:</strong> ${sop.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}
              </div>
              <div class="detail-section">
                <strong>Generated:</strong> ${new Date(sop.generatedAt).toLocaleString()}
              </div>
              <div class="detail-section">
                <a href="/api/v1/sops/${encodeURIComponent(sop.agentId)}/${encodeURIComponent(sop.runId)}" class="action-link">📄 View JSON</a>
                ${sop.hasMarkdown ? `<a href="/api/v1/sops/${encodeURIComponent(sop.agentId)}/${encodeURIComponent(sop.runId)}/markdown" class="action-link">📝 View Markdown</a>` : ''}
              </div>
            </div>
          </td>
        </tr>`,
    )
    .join('\n');

  // Recent events rows
  const eventRows = data.recentEvents
    .slice(0, 20)
    .map(
      (e) =>
        `<tr>
          <td class="topic-generated">Generated</td>
          <td>${escapeHtml(JSON.stringify(e.payload).slice(0, 100))}</td>
          <td class="timestamp">${new Date(e.timestamp).toLocaleTimeString()}</td>
        </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOP Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; color: #f1f5f9; display: flex; align-items: center; gap: 8px; }
  h1 .icon { font-size: 1.4rem; }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 24px; }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; transition: border-color 0.2s; }
  .card:hover { border-color: #475569; }
  .card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
  .card .value { font-size: 2rem; font-weight: 700; color: #38bdf8; }
  .card .value.green { color: #4ade80; }
  .card .value.purple { color: #a78bfa; }
  .card .value.orange { color: #fb923c; }

  /* Charts */
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .chart-container { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
  .chart-container h3 { font-size: 0.875rem; font-weight: 600; color: #94a3b8; margin-bottom: 12px; }
  .chart-container canvas { max-height: 220px; }

  /* Search / filter bar */
  .search-bar { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  .search-bar input {
    flex: 1; min-width: 200px;
    background: #1e293b; border: 1px solid #334155; border-radius: 6px;
    padding: 10px 14px; color: #e2e8f0; font-size: 0.875rem;
    outline: none; transition: border-color 0.2s;
  }
  .search-bar input:focus { border-color: #38bdf8; }
  .search-bar input::placeholder { color: #475569; }
  .filter-badge {
    display: inline-flex; align-items: center; gap: 4px;
    background: #1e293b; border: 1px solid #334155; border-radius: 20px;
    padding: 6px 14px; font-size: 0.75rem; color: #94a3b8; cursor: pointer;
    transition: all 0.2s;
  }
  .filter-badge:hover { border-color: #475569; color: #e2e8f0; }
  .filter-badge.active { background: #0ea5e9; border-color: #0ea5e9; color: #fff; }

  /* Table */
  .table-container { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; padding: 12px 16px;
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: #64748b; border-bottom: 1px solid #334155;
    cursor: pointer; user-select: none;
  }
  th:hover { color: #94a3b8; }
  th .sort-arrow { display: inline-block; margin-left: 4px; color: #475569; }
  th.sorted .sort-arrow { color: #38bdf8; }
  td { padding: 10px 16px; font-size: 0.875rem; border-bottom: 1px solid #1e293b; }
  .sop-row { cursor: pointer; transition: background 0.15s; }
  .sop-row:hover { background: #1a2332; }

  .agent-badge {
    display: inline-block;
    background: #1e3a5f; color: #93c5fd; border-radius: 4px;
    padding: 2px 8px; font-size: 0.75rem; font-weight: 600;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .goal-cell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timestamp { color: #64748b; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; white-space: nowrap; }
  .tags-cell { max-width: 200px; }
  .tag {
    display: inline-block;
    background: #1e293b; border: 1px solid #334155; border-radius: 4px;
    padding: 1px 6px; font-size: 0.7rem; color: #94a3b8;
    margin: 1px 2px; white-space: nowrap;
  }
  .tag-more { font-size: 0.7rem; color: #64748b; }
  .actions-cell { white-space: nowrap; }
  .action-link {
    color: #38bdf8; text-decoration: none; font-size: 0.75rem; font-weight: 600;
    margin: 0 4px; transition: color 0.15s;
  }
  .action-link:hover { color: #7dd3fc; text-decoration: underline; }

  /* Detail panel */
  .detail-row td { padding: 0; }
  .detail-panel {
    background: #0f172a; border-top: 1px solid #334155;
    padding: 16px 24px; display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;
  }
  .detail-section { font-size: 0.8125rem; color: #cbd5e1; }
  .detail-section code {
    background: #1e293b; border: 1px solid #334155; border-radius: 3px;
    padding: 1px 5px; font-size: 0.75rem; color: #94a3b8;
  }
  .detail-section .action-link { font-size: 0.8125rem; }

  /* Events table */
  .section-title { font-size: 1rem; font-weight: 600; color: #94a3b8; margin-bottom: 12px; }
  .events-container { max-height: 300px; overflow-y: auto; border-radius: 8px; background: #1e293b; border: 1px solid #334155; }
  .topic-generated { color: #4ade80; font-weight: 600; }

  /* Connection status */
  .connection-badge {
    display: inline-block; border-radius: 4px; padding: 2px 8px;
    font-size: 0.75rem; margin-left: 8px;
  }
  .connection-badge.connected { background: #064e3b; border: 1px solid #059669; color: #6ee7b7; }
  .connection-badge.disconnected { background: #7f1d1d; border: 1px solid #dc2626; color: #fca5a5; }
  .error-banner { display: none; background: #7f1d1d; border: 1px solid #991b1b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; color: #fca5a5; font-size: 0.875rem; }

  /* No data placeholder */
  .empty-state { text-align: center; padding: 48px 24px; color: #475569; }
  .empty-state .big-icon { font-size: 3rem; margin-bottom: 12px; }
  .empty-state p { font-size: 0.875rem; }
</style>
</head>
<body>
  <h1><span class="icon">📋</span> SOP Dashboard</h1>
  <div class="subtitle">
    Browse and search generated Standard Operating Procedure templates
    <span class="connection-badge connected" id="connectionBadge" title="Connected via SSE">● live</span>
  </div>
  <div class="error-banner" id="errorBanner">SSE connection lost — reconnecting...</div>

  <div class="cards">
    <div class="card">
      <div class="label">Total SOPs</div>
      <div class="value" id="totalValue">${totalSOPs}</div>
    </div>
    <div class="card">
      <div class="label">Agents</div>
      <div class="value green" id="agentsValue">${totalAgents}</div>
    </div>
    <div class="card">
      <div class="label">Total Steps</div>
      <div class="value purple" id="stepsValue">${totalSteps}</div>
    </div>
    <div class="card">
      <div class="label">Unique Tags</div>
      <div class="value orange" id="tagsValue">${totalTags}</div>
    </div>
  </div>

  <div class="charts">
    <div class="chart-container">
      <h3>By Agent</h3>
      <canvas id="byAgentChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>Top 10 Tags</h3>
      <canvas id="byTagChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>Step Count Distribution</h3>
      <canvas id="byStepChart"></canvas>
    </div>
  </div>

  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search SOPs by goal, agent, or tags..." oninput="filterSOPs()" />
    <span class="filter-badge" id="countBadge">${totalSOPs} SOPs</span>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th onclick="sortBy('agentId')" id="sort-agentId">Agent <span class="sort-arrow">▼</span></th>
          <th onclick="sortBy('goal')" id="sort-goal">Goal <span class="sort-arrow">▼</span></th>
          <th onclick="sortBy('stepCount')" id="sort-stepCount">Steps <span class="sort-arrow">▼</span></th>
          <th>Tags</th>
          <th onclick="sortBy('generatedAt')" id="sort-generatedAt" class="sorted">Generated <span class="sort-arrow">▼</span></th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="sopRows">
        ${tableRows || '<tr><td colspan="6" class="empty-state"><div class="big-icon">📋</div><p>No SOPs generated yet. Run an agent task to create one.</p></td></tr>'}
      </tbody>
    </table>
  </div>

  <h2 class="section-title">🔄 Recent Events</h2>
  <div class="events-container">
    <table>
      <thead><tr><th>Type</th><th>Payload</th><th>Time</th></tr></thead>
      <tbody id="eventRows">
        ${eventRows || '<tr><td colspan="3" style="text-align:center;color:#64748b;">No recent events</td></tr>'}
      </tbody>
    </table>
  </div>

<script>
  const CHARTS = {};
  let SORT_FIELD = 'generatedAt';
  let SORT_DIR = -1;

  function initChart(id, type, labels, values, colors, extraOptions) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    var isHorizontal = extraOptions && extraOptions.indexAxis === 'y';
    var options = {
      responsive: true,
      maintainAspectRatio: true,
      indexAxis: isHorizontal ? 'y' : undefined,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) { return context.parsed.x || context.parsed.y || context.parsed; }
          }
        }
      },
      scales: type === 'bar' ? {
        y: isHorizontal ? { grid: { display: false }, ticks: { color: '#94a3b8' } } : { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
        x: isHorizontal ? { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } : { grid: { display: false }, ticks: { color: '#94a3b8', maxRotation: 45 } },
      } : undefined,
    };
    CHARTS[id] = new Chart(ctx, {
      type,
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors || ['#38bdf8','#a78bfa','#4ade80','#fbbf24','#f87171','#fb923c','#818cf8','#2dd4bf','#f472b6','#b45309'],
          borderWidth: 0,
        }],
      },
      options: options,
    });
  }

  function updateChart(id, labels, values) {
    const chart = CHARTS[id];
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.update('none');
  }

  function toggleDetail(index) {
    const row = document.getElementById('detail-' + index);
    if (!row) return;
    const isVisible = row.style.display !== 'none';
    row.style.display = isVisible ? 'none' : 'table-row';
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') return String(s || '');
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  function sortBy(field) {
    if (SORT_FIELD === field) {
      SORT_DIR *= -1;
    } else {
      SORT_FIELD = field;
      SORT_DIR = 1;
    }
    // Update header indicators
    document.querySelectorAll('th[id^="sort-"]').forEach(el => el.classList.remove('sorted'));
    const header = document.getElementById('sort-' + field);
    if (header) header.classList.add('sorted');
    applyFiltersAndSort();
  }

  // Safe-embed SOP data in script context: encode HTML-special chars for XSS protection
  let ALL_DATA = JSON.parse('${JSON.stringify(data.sops).replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/'/g, '\\u0027').replace(/&/g, '\\u0026')}');

  function filterSOPs() {
    applyFiltersAndSort();
  }

  function applyFiltersAndSort() {
    const query = (document.getElementById('searchInput').value || '').toLowerCase();

    let filtered = ALL_DATA;
    if (query) {
      filtered = ALL_DATA.filter(sop =>
        sop.agentId.toLowerCase().includes(query) ||
        sop.goal.toLowerCase().includes(query) ||
        (sop.tags || []).some(t => t.toLowerCase().includes(query))
      );
    }

    // Sort
    filtered.sort((a, b) => {
      let aVal = a[SORT_FIELD];
      let bVal = b[SORT_FIELD];
      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = (bVal || '').toLowerCase();
      }
      if (aVal < bVal) return -1 * SORT_DIR;
      if (aVal > bVal) return 1 * SORT_DIR;
      return 0;
    });

    // Update count badge
    document.getElementById('countBadge').textContent = filtered.length + ' SOPs';

    // Re-render table
    const tbody = document.getElementById('sopRows');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No SOPs match your search.</p></td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map((sop, i) =>
      '<tr class="sop-row" onclick="toggleDetail(' + i + ')">' +
        '<td><span class="agent-badge">' + escapeHtml(sop.agentId) + '</span></td>' +
        '<td class="goal-cell">' + escapeHtml(sop.goal.slice(0, 80)) + (sop.goal.length > 80 ? '&hellip;' : '') + '</td>' +
        '<td>' + sop.stepCount + '</td>' +
        '<td class="tags-cell">' + (sop.tags || []).slice(0, 3).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join(' ') + (sop.tags.length > 3 ? ' <span class="tag-more">+' + (sop.tags.length - 3) + '</span>' : '') + '</td>' +
        '<td class="timestamp">' + new Date(sop.generatedAt).toLocaleString() + '</td>' +
        '<td class="actions-cell">' +
          '<a href="/api/v1/sops/' + encodeURIComponent(sop.agentId) + '/' + encodeURIComponent(sop.runId) + '" class="action-link" onclick="event.stopPropagation()">JSON</a>' +
          (sop.hasMarkdown ? '<a href="/api/v1/sops/' + encodeURIComponent(sop.agentId) + '/' + encodeURIComponent(sop.runId) + '/markdown" class="action-link" onclick="event.stopPropagation()">MD</a>' : '') +
        '</td>' +
      '</tr>' +
      '<tr class="detail-row" id="detail-' + i + '" style="display:none">' +
        '<td colspan="6"><div class="detail-panel">' +
          '<div class="detail-section"><strong>Goal:</strong> ' + escapeHtml(sop.goal) + '</div>' +
          '<div class="detail-section"><strong>Run ID:</strong> <code>' + escapeHtml(sop.runId) + '</code></div>' +
          '<div class="detail-section"><strong>Agent:</strong> <code>' + escapeHtml(sop.agentId) + '</code></div>' +
          '<div class="detail-section"><strong>Tags:</strong> ' + (sop.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join(' ') + '</div>' +
          '<div class="detail-section"><strong>Generated:</strong> ' + new Date(sop.generatedAt).toLocaleString() + '</div>' +
          '<div class="detail-section">' +
            '<a href="/api/v1/sops/' + encodeURIComponent(sop.agentId) + '/' + encodeURIComponent(sop.runId) + '" class="action-link">📄 View JSON</a>' +
            (sop.hasMarkdown ? '<a href="/api/v1/sops/' + encodeURIComponent(sop.agentId) + '/' + encodeURIComponent(sop.runId) + '/markdown" class="action-link">📝 View Markdown</a>' : '') +
          '</div>' +
        '</div></td>' +
      '</tr>'
    ).join('');
  }

  function updateDashboard(data) {
    document.getElementById('errorBanner').style.display = 'none';

    // Update counters
    document.getElementById('totalValue').textContent = data.total || 0;
    document.getElementById('agentsValue').textContent = (data.agents || []).length;
    const totalSteps = (data.sops || []).reduce(function(sum, s) { return sum + (s.stepCount || 0); }, 0);
    document.getElementById('stepsValue').textContent = totalSteps;
    const allTags = new Set();
    (data.sops || []).forEach(function(s) { (s.tags || []).forEach(function(t) { allTags.add(t); }); });
    document.getElementById('tagsValue').textContent = allTags.size;

    // Rebuild chart data
    const agentCounts = {};
    (data.sops || []).forEach(function(sop) {
      agentCounts[sop.agentId] = (agentCounts[sop.agentId] || 0) + 1;
    });
    updateChart('byAgentChart', Object.keys(agentCounts), Object.values(agentCounts));

    const tagCounts = {};
    (data.sops || []).forEach(function(sop) {
      (sop.tags || []).forEach(function(tag) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    const topTags = Object.entries(tagCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);
    updateChart('byTagChart', topTags.map(function(t) { return t[0]; }), topTags.map(function(t) { return t[1]; }));

    const buckets = { '<10': 0, '10-25': 0, '26-50': 0, '51-100': 0, '100+': 0 };
    (data.sops || []).forEach(function(sop) {
      if (sop.stepCount < 10) buckets['<10']++;
      else if (sop.stepCount <= 25) buckets['10-25']++;
      else if (sop.stepCount <= 50) buckets['26-50']++;
      else if (sop.stepCount <= 100) buckets['51-100']++;
      else buckets['100+']++;
    });
    updateChart('byStepChart', Object.keys(buckets), Object.values(buckets));

    // Update data and re-apply filters
    ALL_DATA = data.sops || [];
    applyFiltersAndSort();

    // Update events
    const eventRows = document.getElementById('eventRows');
    if (data.recentEvents && data.recentEvents.length > 0) {
      eventRows.innerHTML = data.recentEvents.slice(0, 20).map(function(e) {
        return '<tr><td class="topic-generated">Generated</td><td>' + escapeHtml(JSON.stringify(e.payload).slice(0, 100)) + '</td><td class="timestamp">' + new Date(e.timestamp).toLocaleTimeString() + '</td></tr>';
      }).join('');
    }
  }

  // Initialize charts with server-rendered data
  initChart('byAgentChart', 'bar', ${byAgentLabels}, ${byAgentValues});
  initChart('byTagChart', 'bar', ${byTagLabels}, ${byTagValues}, null, { indexAxis: 'y' });
  initChart('byStepChart', 'bar', ${byStepLabels}, ${byStepValues}, ['#38bdf8','#a78bfa','#4ade80','#fbbf24','#f87171']);

  // Connect SSE stream for real-time updates
  const evtSource = new EventSource('/stream/sop');

  evtSource.addEventListener('sop.update', function (e) {
    try {
      const parsed = JSON.parse(e.data);
      updateDashboard(parsed.data);
    } catch (err) {
      console.error('SOP SSE parse error', err);
    }
  });

  evtSource.onopen = function () {
    const badge = document.getElementById('connectionBadge');
    if (badge) {
      badge.className = 'connection-badge connected';
      badge.title = 'Connected via SSE';
      badge.textContent = '\\u25cf live';
    }
    document.getElementById('errorBanner').style.display = 'none';
  };

  evtSource.onerror = function () {
    const badge = document.getElementById('connectionBadge');
    if (badge) {
      badge.className = 'connection-badge disconnected';
      badge.title = 'SSE reconnecting';
      badge.textContent = '\\u25cf disconnected';
    }
    document.getElementById('errorBanner').style.display = 'block';
  };
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
