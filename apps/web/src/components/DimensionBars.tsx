import type { DimensionScore } from '../types';

interface Props {
  dimensions: DimensionScore[];
}

function barColor(status: DimensionScore['status']): string {
  switch (status) {
    case 'excellent':
      return 'var(--accent-green)';
    case 'good':
      return 'var(--accent-blue)';
    case 'adequate':
      return 'var(--accent-amber)';
    case 'needs_improvement':
      return 'var(--accent-amber)';
    default:
      return 'var(--accent-red)';
  }
}

export function DimensionBars({ dimensions }: Props) {
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="section-head" style={{ marginBottom: '12px' }}>
        <div>
          <span className="section-label">Security Dimensions</span>
          <h2 style={{ fontSize: '1.1rem' }}>Posture Breakdown</h2>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {dimensions.map((dim) => {
          const color = barColor(dim.status);
          return (
            <div
              key={dim.dimension}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr 48px 36px',
                alignItems: 'center',
                gap: '12px',
                padding: '6px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              {/* Label */}
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {dim.label}
                </div>
                <div
                  style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '2px' }}
                >
                  {(dim.weight * 100).toFixed(0)}% weight
                </div>
              </div>

              {/* Bar */}
              <div
                style={{
                  position: 'relative',
                  height: '8px',
                  borderRadius: '4px',
                  background: 'var(--border-subtle)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '4px',
                    background: color,
                    width: `${dim.score}%`,
                    transition: 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
                    boxShadow: `0 0 6px ${color}44`,
                  }}
                />
              </div>

              {/* Score */}
              <span
                style={{
                  fontSize: '0.92rem',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  textAlign: 'right',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {dim.score}
              </span>

              {/* Status dot */}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: color,
                    boxShadow: `0 0 6px ${color}`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Weights row */}
      <div
        style={{
          marginTop: '10px',
          paddingTop: '8px',
          display: 'flex',
          gap: '16px',
          fontSize: '0.65rem',
          color: 'var(--text-muted)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {dimensions.map((d) => (
          <span key={d.dimension}>
            {d.label.split(' ')[0]} {(d.weight * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}
