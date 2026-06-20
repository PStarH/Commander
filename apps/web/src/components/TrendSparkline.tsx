import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { PostureSnapshot, TrendAnalysis } from '../types';

interface Props {
  history: PostureSnapshot[];
  trend: TrendAnalysis;
}

export function TrendSparkline({ history, trend }: Props) {
  const data = history.map((s) => ({
    date: new Date(s.timestamp).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    score: s.posture.overallScore,
  }));

  if (data.length < 2) {
    return (
      <div className="card" style={{ padding: '16px 18px' }}>
        <div className="section-head">
          <span className="section-label">Posture Trend</span>
        </div>
        <div className="empty">Insufficient data (need min 2 snapshots)</div>
      </div>
    );
  }

  const trendColor =
    trend.trend === 'improving' ? 'var(--accent-green)' :
    trend.trend === 'declining' ? 'var(--accent-red)' :
    'var(--accent-blue)';

  const trendIcon =
    trend.trend === 'improving' ? '↑' :
    trend.trend === 'declining' ? '↓' : '→';

  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="section-head" style={{ marginBottom: '8px' }}>
        <div>
          <span className="section-label">Posture Trend</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            <span style={{ color: trendColor }}>{trendIcon}</span>{' '}
            {trend.trend.replace(/_/g, ' ')} · {trend.snapshotCount} snapshots
          </h2>
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
          <span>Avg {trend.averageScore}</span>
          <span>Δ {trend.scoreDelta >= 0 ? '+' : ''}{trend.scoreDelta}</span>
          <span>Proj {trend.projectedScore}</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: 'var(--border-subtle)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[60, 100]}
            tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
            width={28}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: '6px',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
            }}
            formatter={(value: number) => [`${value}/100`, 'Score']}
          />
          <Line
            type="monotone"
            dataKey="score"
            stroke={trendColor}
            strokeWidth={2}
            dot={{ r: 3, fill: trendColor, stroke: 'var(--bg-deep)', strokeWidth: 1 }}
            activeDot={{ r: 5, fill: trendColor, stroke: 'var(--bg-deep)', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Stats row */}
      <div style={{
        display: 'flex',
        gap: '16px',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: '0.68rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)',
      }}>
        <span>Min {trend.minScore}</span>
        <span>Max {trend.maxScore}</span>
        <span>Vol ±{trend.volatility}</span>
        <span>Recent Δ {trend.scoreDeltaRecent >= 0 ? '+' : ''}{trend.scoreDeltaRecent}</span>
      </div>
    </div>
  );
}
