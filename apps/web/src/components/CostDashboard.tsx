/**
 * CostDashboard — Enterprise-grade cost analytics dashboard.
 *
 * Addresses "cost anxiety" — the #1 pain point for enterprise users who worry
 * about runaway LLM API costs. Provides granular cost reporting aggregated by
 * model, tool, user, and time period, with trend visualization.
 *
 * Features:
 *   A. Top stat cards — total cost, today's cost, avg cost per task, cache savings
 *   B. Model breakdown table — per-model calls, tokens, cost, percentage
 *   C. Tool breakdown table — per-tool calls, tokens, cost, percentage
 *   D. Trend chart — cost over time (recharts AreaChart)
 *   E. Time range selector — Today / 7 Days / 30 Days / All
 *   F. Auto-refresh every 60 seconds
 */
import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  DollarSign,
  Calendar,
  TrendingDown,
  Save,
  RefreshCw,
  AlertTriangle,
  Cpu,
  Wrench,
} from 'lucide-react';
import { Badge, Button, Select, MetricCard } from './ui';
import { fetchCostDashboard } from '../api';
import type { CostTimeRange, CostDashboardResponse } from '../api';

// ── Constants ─────────────────────────────────────────────────────────────

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  cyan: '#22d3ee',
  surface: '#050913',
  border: '#151c23',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
};

const TIME_RANGE_OPTIONS: { value: CostTimeRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'all', label: 'All' },
];

const AUTO_REFRESH_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatTrendTime(timestamp: string, isHourly: boolean): string {
  const d = new Date(timestamp);
  if (isHourly) {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

// ── Component ─────────────────────────────────────────────────────────────

export function CostDashboard() {
  const [data, setData] = useState<CostDashboardResponse | null>(null);
  const [timeRange, setTimeRange] = useState<CostTimeRange>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async (range: CostTimeRange, isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const result = await fetchCostDashboard(range);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cost dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Load on mount and when time range changes
  useEffect(() => {
    loadData(timeRange);
  }, [loadData, timeRange]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadData(timeRange, true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadData, timeRange]);

  function handleTimeRangeChange(value: string) {
    setTimeRange(value as CostTimeRange);
  }

  // ── Render: Loading ──────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="cost-dashboard">
        <div className="section-head">
          <div>
            <div className="section-label">Cost Analytics</div>
            <h2>Loading cost dashboard...</h2>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Error ────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <div className="cost-dashboard">
        <div className="section-head">
          <div>
            <div className="section-label">Cost Analytics</div>
            <h2>Cost Dashboard</h2>
          </div>
        </div>
        <div className="narrative narrative-red">
          <AlertTriangle size={14} /> {error}
        </div>
      </div>
    );
  }

  // ── Render: No data ──────────────────────────────────────────────────
  if (!data) return null;

  const isHourly = timeRange === 'today';
  const trendData = data.trend.map((p) => ({
    ...p,
    label: formatTrendTime(p.timestamp, isHourly),
  }));

  const hasData = data.summary.totalCalls > 0;

  // ── Render: Main ─────────────────────────────────────────────────────
  return (
    <div className="cost-dashboard">
      {/* ── Header + Controls ─────────────────────────────────────────── */}
      <div className="section-head">
        <div>
          <div className="section-label">Cost Analytics</div>
          <h2>Cost Dashboard</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Select
            value={timeRange}
            onChange={(e) => handleTimeRangeChange(e.target.value)}
            disabled={refreshing}
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadData(timeRange, true)}
            disabled={refreshing}
            title="Refresh now"
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          </Button>
        </div>
      </div>

      {!hasData ? (
        <div className="narrative narrative-green">
          <DollarSign size={14} /> No cost data found for the selected time range. Cost tracking
          activates automatically when agents make LLM calls. Run a task to see costs here.
        </div>
      ) : (
        <>
          {error && (
            <div className="narrative narrative-red" style={{ marginBottom: 12 }}>
              <AlertTriangle size={14} /> {error} (showing last successful data)
            </div>
          )}

          {/* ── Top stat cards ────────────────────────────────────────── */}
          <div className="metric-row">
            <MetricCard
              label="Total Cost"
              value={formatCost(data.summary.totalCostUsd)}
              icon={<DollarSign size={14} />}
              trend={
                data.summary.totalCostUsd > 0
                  ? { value: `${data.summary.totalCalls} calls`, positive: true }
                  : undefined
              }
            />
            <MetricCard
              label="Today's Cost"
              value={formatCost(data.summary.todayCostUsd)}
              icon={<Calendar size={14} />}
            />
            <MetricCard
              label="Avg Cost / Task"
              value={formatCost(data.summary.averageCostPerTask)}
              icon={<Cpu size={14} />}
              trend={
                data.summary.totalTasks > 0
                  ? { value: `${data.summary.totalTasks} tasks`, positive: true }
                  : undefined
              }
            />
            <MetricCard
              label="Cache Savings"
              value={formatCost(data.summary.cacheSavingsUsd)}
              icon={<Save size={14} />}
              trend={
                data.summary.cacheSavingsUsd > 0 ? { value: 'saved', positive: true } : undefined
              }
            />
          </div>

          {/* ── Trend chart ───────────────────────────────────────────── */}
          {trendData.length > 0 && (
            <div className="card" style={{ marginTop: 16, padding: 16 }}>
              <div className="chart-title" style={{ marginBottom: 12 }}>
                Cost Trend ({TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)?.label})
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={trendData} margin={{ left: 0, right: 10, top: 5 }}>
                  <defs>
                    <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.blue} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.blue} stopOpacity={0.1} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: COLORS.text, fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: COLORS.text, fontSize: 11 }}
                    tickFormatter={(v) => `$${v.toFixed(2)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: COLORS.surface,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: COLORS.textPrimary }}
                    formatter={(value: number) => [formatCost(value), 'Cost']}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    stroke={COLORS.blue}
                    strokeWidth={2}
                    fill="url(#costGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Peak cost info ────────────────────────────────────────── */}
          {data.summary.peakCostHour && (
            <div className="narrative narrative-amber" style={{ marginTop: 12 }}>
              <AlertTriangle size={14} /> Peak cost hour:{' '}
              {data.summary.peakCostHour.replace('T', ' ')}:00 UTC
            </div>
          )}

          {/* ── Model breakdown table ─────────────────────────────────── */}
          <div className="section-head" style={{ marginTop: 24 }}>
            <div>
              <div className="section-label">
                <Cpu size={12} style={{ display: 'inline', marginRight: 4 }} />
                Cost by Model
              </div>
              <h3 style={{ fontSize: 16 }}>{data.byModel.length} model(s)</h3>
            </div>
          </div>

          {data.byModel.length === 0 ? (
            <div className="empty">No model cost data available</div>
          ) : (
            <div className="approval-table-wrap">
              <table className="approval-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Provider</th>
                    <th>Calls</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Cache Tokens</th>
                    <th>Cost</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((entry, i) => (
                    <tr key={`${entry.provider}:${entry.model}:${i}`}>
                      <td>
                        <code>{entry.model}</code>
                      </td>
                      <td>
                        <Badge variant="info">{entry.provider}</Badge>
                      </td>
                      <td>{entry.calls}</td>
                      <td>{formatTokens(entry.inputTokens)}</td>
                      <td>{formatTokens(entry.outputTokens)}</td>
                      <td>{formatTokens(entry.cacheTokens)}</td>
                      <td>
                        <strong>{formatCost(entry.costUsd)}</strong>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div
                            style={{
                              width: 60,
                              height: 6,
                              background: COLORS.border,
                              borderRadius: 3,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(entry.percentage, 100)}%`,
                                height: '100%',
                                background: COLORS.blue,
                              }}
                            />
                          </div>
                          <span style={{ fontSize: 11, color: COLORS.text }}>
                            {entry.percentage.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Tool breakdown table ──────────────────────────────────── */}
          <div className="section-head" style={{ marginTop: 24 }}>
            <div>
              <div className="section-label">
                <Wrench size={12} style={{ display: 'inline', marginRight: 4 }} />
                Cost by Tool
              </div>
              <h3 style={{ fontSize: 16 }}>{data.byTool.length} tool(s)</h3>
            </div>
          </div>

          {data.byTool.length === 0 ? (
            <div className="empty">No tool cost data available</div>
          ) : (
            <div className="approval-table-wrap">
              <table className="approval-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Calls</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byTool.map((entry, i) => (
                    <tr key={`${entry.tool}:${i}`}>
                      <td>
                        <code>{entry.tool}</code>
                      </td>
                      <td>{entry.calls}</td>
                      <td>{formatTokens(entry.tokens)}</td>
                      <td>
                        <strong>{formatCost(entry.costUsd)}</strong>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div
                            style={{
                              width: 60,
                              height: 6,
                              background: COLORS.border,
                              borderRadius: 3,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(entry.percentage, 100)}%`,
                                height: '100%',
                                background: COLORS.green,
                              }}
                            />
                          </div>
                          <span style={{ fontSize: 11, color: COLORS.text }}>
                            {entry.percentage.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── User breakdown ────────────────────────────────────────── */}
          {data.byUser.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 24 }}>
                <div>
                  <div className="section-label">
                    <TrendingDown size={12} style={{ display: 'inline', marginRight: 4 }} />
                    Cost by User / Agent
                  </div>
                  <h3 style={{ fontSize: 16 }}>{data.byUser.length} user(s)</h3>
                </div>
              </div>
              <div className="approval-table-wrap">
                <table className="approval-table">
                  <thead>
                    <tr>
                      <th>User / Agent</th>
                      <th>Calls</th>
                      <th>Cost</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byUser.map((entry, i) => (
                      <tr key={`${entry.userId}:${i}`}>
                        <td>
                          <code>{entry.userId}</code>
                        </td>
                        <td>{entry.calls}</td>
                        <td>
                          <strong>{formatCost(entry.costUsd)}</strong>
                        </td>
                        <td>
                          <span style={{ fontSize: 11, color: COLORS.text }}>
                            {entry.percentage.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
