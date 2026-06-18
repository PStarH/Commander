/**
 * TokenTrendChart — Multi-tenant token consumption timeline for Commander War Room.
 *
 * Renders time-series line charts showing token usage across tenants, models,
 * or agents. Supports 1h/6h/24h/7d time windows and indigo-themed dark mode.
 *
 * Design: professional "Datadog-style" observability panel with:
 *   - Recharts-based responsive line chart
 *   - Per-tenant / per-model breakdown
 *   - Time window selector
 *   - Summary metric cards
 */

import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Cpu, TrendingUp, Clock, Activity } from 'lucide-react';
import { MetricCard } from './ui';

// ============================================================================
// Colors — Commander indigo design system
// ============================================================================

const COLORS = {
  indigo: '#4d9eff',
  green: '#4de98c',
  amber: '#ffcc66',
  coral: '#ff8b9d',
  purple: '#a78bfa',
  cyan: '#22d3ee',
  slate: '#64748b',
  surface: '#050913',
  border: '#151c23',
  gridLine: 'rgba(77, 158, 255, 0.06)',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
};

const SERIES_COLORS = [
  COLORS.indigo,
  COLORS.green,
  COLORS.amber,
  COLORS.coral,
  COLORS.purple,
  COLORS.cyan,
  COLORS.slate,
  '#38bdf8',
];

// ============================================================================
// Types
// ============================================================================

interface TokenDataPoint {
  timestamp: string;
  label: string;
  [series: string]: number | string;
}

interface TokenTrendChartProps {
  /** Time-series data (each series key becomes a line) */
  data: TokenDataPoint[];
  /** Series keys to render (omit timestamp/label) */
  series: string[];
  /** Chart title */
  title?: string;
  /** Total tokens in view */
  totalTokens?: number;
  /** Average tokens per interval */
  avgTokensPerInterval?: number;
  /** Peak tokens in interval */
  peakTokens?: number;
}

type TimeWindow = '1h' | '6h' | '24h' | '7d';

// ============================================================================
// Component
// ============================================================================

export function TokenTrendChart({
  data,
  series,
  title = 'Token Consumption',
  totalTokens = 0,
  avgTokensPerInterval = 0,
  peakTokens = 0,
}: TokenTrendChartProps) {
  const [window, setWindow] = useState<TimeWindow>('24h');

  // Filter data by time window
  const filteredData = useMemo(() => {
    if (data.length === 0) return data;
    const now = Date.now();
    const windowMs: Record<TimeWindow, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    const cutoff = now - windowMs[window];

    // Filter data points that fall within the time window
    // We assume timestamps are ISO strings or epoch ms
    return data.filter((point) => {
      const ts = new Date(point.timestamp).getTime();
      return ts >= cutoff;
    });
  }, [data, window]);

  if (data.length === 0) {
    return (
      <div className="token-trend-chart">
        <div className="section-head">
          <div>
            <div className="section-label">Token Trends</div>
            <h2>{title}</h2>
          </div>
          <span className="section-tag">No data yet</span>
        </div>
        <div className="narrative narrative-green">
          Token consumption tracking activates when agents start executing tasks. Data will appear
          here in real-time.
        </div>
      </div>
    );
  }

  const formatLargeNumber = (v: number): string => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
    return String(v);
  };

  return (
    <div className="token-trend-chart">
      <div className="section-head">
        <div>
          <div className="section-label">Token Trends</div>
          <h2>{title}</h2>
        </div>
        <div className="time-window-selector">
          {(['1h', '6h', '24h', '7d'] as TimeWindow[]).map((w) => (
            <button
              key={w}
              className={`time-window-btn ${window === w ? 'active' : ''}`}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Metric Cards */}
      <div className="metric-row">
        <MetricCard
          label="Total tokens"
          value={formatLargeNumber(totalTokens)}
          icon={<Cpu size={14} />}
        />
        <MetricCard
          label="Avg / interval"
          value={formatLargeNumber(avgTokensPerInterval)}
          icon={<Activity size={14} />}
        />
        <MetricCard
          label="Peak tokens"
          value={formatLargeNumber(peakTokens)}
          icon={<TrendingUp size={14} />}
        />
        <MetricCard
          label="Data points"
          value={String(filteredData.length)}
          icon={<Clock size={14} />}
        />
      </div>

      {/* Line Chart */}
      <div className="chart-card" style={{ marginTop: 16 }}>
        <div className="chart-title">Token consumption ({window})</div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={filteredData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="4 4" stroke={COLORS.gridLine} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: COLORS.text, fontSize: 11 }}
              axisLine={{ stroke: COLORS.border }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: COLORS.text, fontSize: 11 }}
              axisLine={{ stroke: COLORS.border }}
              tickLine={false}
              tickFormatter={formatLargeNumber}
            />
            <Tooltip
              contentStyle={{
                background: COLORS.surface,
                border: `1px solid ${COLORS.border}`,
                borderRadius: '6px',
                fontSize: '12px',
              }}
              itemStyle={{ color: COLORS.textPrimary }}
              labelStyle={{ color: COLORS.text, marginBottom: 4 }}
              formatter={(value: any) => [formatLargeNumber(Number(value ?? 0)), 'tokens']}
            />
            {series.length > 1 && (
              <Legend
                wrapperStyle={{
                  color: COLORS.text,
                  fontSize: '11px',
                }}
                iconType="circle"
                iconSize={6}
              />
            )}
            {series.map((key, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: SERIES_COLORS[i % SERIES_COLORS.length],
                  stroke: COLORS.surface,
                  strokeWidth: 2,
                }}
                animationDuration={600}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
