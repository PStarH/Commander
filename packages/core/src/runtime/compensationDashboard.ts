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
import type { BusMessage } from './types';
import { getMetricsCollector } from './metricsCollector';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Data aggregation
// ============================================================================

/**
 * Aggregate compensation metrics and recent bus events into a JSON-serializable snapshot.
 */
export function getCompensationData(bus: MessageBus): CompensationDashboardData {
  const mc = getMetricsCollector();
  const plannedTotal = mc.getCounter('compensation_planned_total');
  const stepsTotal = mc.getCounter('compensation_steps_total');
  const outcomeTotal = mc.getCounter('compensation_total');

  // Per-tool breakdown: enumerate known tool labels from counter lookups
  const byTool: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  const byStepStatus: Record<string, number> = {};
  const compensationOutcomes: Record<string, number> = {};

  // Query known tool names from the planned counter using listMetricNames
  // and derive label values from counter keys.
  const plannedHistory = bus.getHistory('tool.compensation_planned', 200);
  const seenTools = new Set<string>();
  const seenRisks = new Set<string>();
  for (const msg of plannedHistory) {
    const p = msg.payload as { toolName?: string; risk?: string };
    if (p.toolName) seenTools.add(p.toolName);
    if (p.risk) seenRisks.add(p.risk);
  }

  for (const tool of seenTools) {
    byTool[tool] =
      mc.getCounter('compensation_planned_total', [
        { name: 'tool', value: tool },
        { name: 'risk', value: 'safe' },
      ]) +
      mc.getCounter('compensation_planned_total', [
        { name: 'tool', value: tool },
        { name: 'risk', value: 'review' },
      ]) +
      mc.getCounter('compensation_planned_total', [
        { name: 'tool', value: tool },
        { name: 'risk', value: 'destructive' },
      ]);
  }

  for (const risk of seenRisks) {
    let total = 0;
    for (const tool of seenTools) {
      total += mc.getCounter('compensation_planned_total', [
        { name: 'tool', value: tool },
        { name: 'risk', value: risk },
      ]);
    }
    byRisk[risk] = total;
  }

  const stepHistory = bus.getHistory('tool.compensation_step', 200);
  const seenStatuses = new Set<string>();
  for (const msg of stepHistory) {
    const p = msg.payload as { status?: string };
    if (p.status) seenStatuses.add(p.status);
  }
  for (const status of seenStatuses) {
    let total = 0;
    for (const tool of seenTools) {
      total += mc.getCounter('compensation_steps_total', [
        { name: 'tool', value: tool },
        { name: 'status', value: status },
      ]);
    }
    byStepStatus[status] = total;
  }

  // Compensation outcomes (from recordCompensation)
  for (const outcome of ['success', 'failed', 'exhausted'] as const) {
    let total = 0;
    for (const tool of seenTools) {
      total += mc.getCounter('compensation_total', [
        { name: 'tool', value: tool },
        { name: 'outcome', value: outcome },
      ]);
    }
    compensationOutcomes[outcome] = total;
  }

  // Recent events: merge both topics, sort by timestamp, take latest 50
  const rawHistory: BusMessage[] = [
    ...bus.getHistory('tool.compensation_planned', 100),
    ...bus.getHistory('tool.compensation_step', 100),
  ];

  rawHistory.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const recentEvents = rawHistory.slice(0, 50).map((msg) => {
    let summary = '';
    const p = msg.payload as Record<string, unknown>;
    if (msg.topic === 'tool.compensation_planned') {
      summary = `Planned: ${String(p.toolName ?? '?')} (${String(p.stepCount ?? 0)} steps, risk=${String(p.risk ?? '?')})`;
    } else if (msg.topic === 'tool.compensation_step') {
      summary = `Step [${String(p.stepIndex ?? '?')}/${String(p.totalSteps ?? '?')}]: ${String(p.toolName ?? '?')} → ${String(p.status ?? '?')}${p.error ? ` (${String(p.error)})` : ''}`;
    }
    return {
      id: msg.id,
      topic: msg.topic,
      timestamp: msg.timestamp,
      summary,
    };
  });

  return {
    counters: {
      compensation_planned_total: plannedTotal,
      compensation_steps_total: stepsTotal,
      compensation_total: outcomeTotal,
    },
    byTool,
    byRisk,
    byStepStatus,
    compensationOutcomes,
    recentEvents,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// HTML dashboard
// ============================================================================

/**
 * Render a self-contained HTML dashboard page for compensation observability.
 * Uses Chart.js from CDN for bar charts and SSE for real-time updates.
 */
export function renderDashboardHtml(bus: MessageBus): string {
  const data = getCompensationData(bus);

  const plannedTotal = data.counters.compensation_planned_total ?? 0;
  const stepsTotal = data.counters.compensation_steps_total ?? 0;
  const outcomeTotal = data.counters.compensation_total ?? 0;

  const eventRows = data.recentEvents
    .map(
      (e) =>
        `<tr>
          <td class="topic-${e.topic === 'tool.compensation_planned' ? 'planned' : 'step'}">${e.topic === 'tool.compensation_planned' ? 'Planned' : 'Step'}</td>
          <td>${escapeHtml(e.summary)}</td>
          <td class="timestamp">${new Date(e.timestamp).toLocaleTimeString()}</td>
        </tr>`,
    )
    .join('\n');

  const byToolLabels = JSON.stringify(Object.keys(data.byTool));
  const byToolValues = JSON.stringify(Object.values(data.byTool));
  const byRiskLabels = JSON.stringify(Object.keys(data.byRisk));
  const byRiskValues = JSON.stringify(Object.values(data.byRisk));
  const byStatusLabels = JSON.stringify(Object.keys(data.byStepStatus));
  const byStatusValues = JSON.stringify(Object.values(data.byStepStatus));
  const outcomeLabels = JSON.stringify(Object.keys(data.compensationOutcomes));
  const outcomeValues = JSON.stringify(Object.values(data.compensationOutcomes));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compensation Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; color: #f1f5f9; }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
  .card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
  .card .value { font-size: 2rem; font-weight: 700; color: #38bdf8; }
  .card .value.success { color: #4ade80; }
  .card .value.warning { color: #fbbf24; }
  .card .value.danger { color: #f87171; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .chart-container { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
  .chart-container h3 { font-size: 0.875rem; font-weight: 600; color: #94a3b8; margin-bottom: 12px; }
  .chart-container canvas { max-height: 250px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 12px 16px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1px solid #334155; }
  td { padding: 10px 16px; font-size: 0.875rem; border-bottom: 1px solid #1e293b; }
  .topic-planned { color: #38bdf8; font-weight: 600; }
  .topic-step { color: #a78bfa; font-weight: 600; }
  .timestamp { color: #64748b; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; }
  .connection-badge { display: inline-block; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-left: 8px; }
  .connection-badge.connected { background: #064e3b; border: 1px solid #059669; color: #6ee7b7; }
  .connection-badge.disconnected { background: #7f1d1d; border: 1px solid #dc2626; color: #fca5a5; }
  .error-banner { display: none; background: #7f1d1d; border: 1px solid #991b1b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; color: #fca5a5; font-size: 0.875rem; }
</style>
</head>
<body>
  <h1>⚡ Compensation Dashboard</h1>
  <div class="subtitle">Real-time compensation event observability <span class="connection-badge connected" id="connectionBadge" title="Connected via SSE">● live</span></div>
  <div class="error-banner" id="errorBanner">SSE connection lost — reconnecting...</div>

  <div class="cards">
    <div class="card">
      <div class="label">Planned</div>
      <div class="value" id="plannedValue">${plannedTotal}</div>
    </div>
    <div class="card">
      <div class="label">Steps</div>
      <div class="value" id="stepsValue">${stepsTotal}</div>
    </div>
    <div class="card">
      <div class="label">Successful Compensations</div>
      <div class="value success" id="successValue">${data.compensationOutcomes['success'] ?? 0}</div>
    </div>
    <div class="card">
      <div class="label">Failed / Exhausted</div>
      <div class="value danger" id="failedValue">${(data.compensationOutcomes['failed'] ?? 0) + (data.compensationOutcomes['exhausted'] ?? 0)}</div>
    </div>
  </div>

  <div class="charts">
    <div class="chart-container">
      <h3>By Tool</h3>
      <canvas id="byToolChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>By Risk</h3>
      <canvas id="byRiskChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>Step Status</h3>
      <canvas id="byStatusChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>Outcomes</h3>
      <canvas id="outcomeChart"></canvas>
    </div>
  </div>

  <h2 style="font-size:1rem;font-weight:600;color:#94a3b8;margin-bottom:12px;">Recent Events</h2>
  <div style="max-height:400px;overflow-y:auto;border-radius:8px;">
    <table>
      <thead><tr><th>Type</th><th>Summary</th><th>Time</th></tr></thead>
      <tbody id="eventRows">
        ${eventRows || '<tr><td colspan="3" style="text-align:center;color:#64748b;">No events yet</td></tr>'}
      </tbody>
    </table>
  </div>

<script>
  const CHARTS = {};

  function initChart(id, type, labels, values, colors) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    CHARTS[id] = new Chart(ctx, {
      type,
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors || ['#38bdf8','#a78bfa','#4ade80','#fbbf24','#f87171','#fb923c'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
          x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
        },
      },
    });
  }

  function updateDashboard(data) {
    document.getElementById('errorBanner').style.display = 'none';
    document.getElementById('plannedValue').textContent = data.counters.compensation_planned_total || 0;
    document.getElementById('stepsValue').textContent = data.counters.compensation_steps_total || 0;
    document.getElementById('successValue').textContent = (data.compensationOutcomes?.success) || 0;
    const failed = (data.compensationOutcomes?.failed || 0) + (data.compensationOutcomes?.exhausted || 0);
    document.getElementById('failedValue').textContent = failed;

    updateChart('byToolChart', Object.keys(data.byTool || {}), Object.values(data.byTool || {}));
    updateChart('byRiskChart', Object.keys(data.byRisk || {}), Object.values(data.byRisk || {}));
    updateChart('byStatusChart', Object.keys(data.byStepStatus || {}), Object.values(data.byStepStatus || {}));
    updateChart('outcomeChart', Object.keys(data.compensationOutcomes || {}), Object.values(data.compensationOutcomes || {}));

    const tbody = document.getElementById('eventRows');
    if (data.recentEvents?.length) {
      tbody.innerHTML = data.recentEvents.map(e =>
        '<tr><td class="topic-' + (e.topic === 'tool.compensation_planned' ? 'planned' : 'step') + '">' +
        (e.topic === 'tool.compensation_planned' ? 'Planned' : 'Step') +
        '</td><td>' + escapeHtml(e.summary) +
        '</td><td class="timestamp">' + new Date(e.timestamp).toLocaleTimeString() + '</td></tr>'
      ).join('');
    }
  }

  function updateChart(id, labels, values) {
    const chart = CHARTS[id];
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.update('none');
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  // Initialize charts with server-rendered data
  initChart('byToolChart', 'bar', ${byToolLabels}, ${byToolValues});
  initChart('byRiskChart', 'doughnut', ${byRiskLabels}, ${byRiskValues}, ['#38bdf8','#fbbf24','#f87171']);
  initChart('byStatusChart', 'bar', ${byStatusLabels}, ${byStatusValues});
  initChart('outcomeChart', 'doughnut', ${outcomeLabels}, ${outcomeValues}, ['#4ade80','#f87171','#fb923c']);

  // Connect SSE stream for real-time updates (replaces polling)
  const evtSource = new EventSource('/stream/compensation');

  evtSource.addEventListener('compensation.update', function (e) {
    const parsed = JSON.parse(e.data);
    updateDashboard(parsed.data);
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
