import type { SecurityPosture } from '../types';

interface Props {
  posture: SecurityPosture;
}

const SIZE = 180;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = RADIUS * Math.PI;
const CENTER = SIZE / 2;

function scoreColor(score: number): string {
  if (score >= 90) return 'var(--accent-green)';
  if (score >= 80) return 'var(--accent-blue)';
  if (score >= 65) return 'var(--accent-amber)';
  return 'var(--accent-red)';
}

function statusColor(status: SecurityPosture['status']): string {
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

export function ScoreGauge({ posture }: Props) {
  const score = posture.overallScore;
  const color = scoreColor(score);
  const fillLen = (score / 100) * CIRCUMFERENCE;
  const bgLen = CIRCUMFERENCE - fillLen;

  return (
    <div
      className="card"
      style={{
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
      }}
    >
      <svg width={SIZE} height={SIZE / 2 + STROKE} viewBox={`0 0 ${SIZE} ${SIZE / 2 + STROKE}`}>
        {/* Background arc */}
        <path
          d={`M ${STROKE / 2} ${SIZE / 2} A ${RADIUS} ${RADIUS} 0 0 1 ${SIZE - STROKE / 2} ${SIZE / 2}`}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        {/* Score arc */}
        <path
          d={`M ${STROKE / 2} ${SIZE / 2} A ${RADIUS} ${RADIUS} 0 0 1 ${SIZE - STROKE / 2} ${SIZE / 2}`}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${fillLen} ${bgLen}`}
          style={{
            filter: `drop-shadow(0 0 8px ${color})`,
            transition: 'stroke-dasharray 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
        {/* Center text */}
        <text
          x={CENTER}
          y={SIZE / 2 - 14}
          textAnchor="middle"
          fill="var(--text-primary)"
          fontSize="36"
          fontWeight="700"
          fontFamily="var(--font-mono)"
        >
          {score}
        </text>
        <text
          x={CENTER}
          y={SIZE / 2 + 12}
          textAnchor="middle"
          fill="var(--text-tertiary)"
          fontSize="13"
          fontWeight="600"
          fontFamily="var(--font-mono)"
          letterSpacing="0.1em"
        >
          / &nbsp;100
        </text>
      </svg>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          className="bdg"
          style={{
            borderColor: color,
            color,
            background: `${color}20`,
          }}
        >
          {posture.grade}
        </span>
        <span
          className="bdg"
          style={{
            borderColor: statusColor(posture.status),
            color: statusColor(posture.status),
            background: `${statusColor(posture.status)}20`,
          }}
        >
          {posture.status.replace(/_/g, ' ')}
        </span>
      </div>
    </div>
  );
}
