import {
  Clock,
  Cpu,
  Zap,
  DollarSign,
  AlertTriangle,
  CheckCircle,
  Play,
  type LucideIcon,
} from 'lucide-react';
import type { ObservabilityTimelineView, ObservabilityCostReport } from '../types';

const C = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  text: '#e5f0da',
  textDim: '#7f8c86',
  border: '#151c23',
  card: '#050913',
};

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

interface RunHeaderProps {
  timeline: ObservabilityTimelineView;
  cost?: ObservabilityCostReport;
}

export function RunHeader({ timeline, cost }: RunHeaderProps) {
  const s = timeline.summary;
  const isRunning = !timeline.endedAt;
  const isError = s.errors > 0;
  const statusColor = isError ? C.red : isRunning ? C.blue : C.green;
  const StatusIcon = isError ? AlertTriangle : isRunning ? Play : CheckCircle;

  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        background: C.card,
        borderRadius: 8,
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 240 }}>
        <StatusIcon size={20} style={{ color: statusColor }} />
        <div>
          <div
            style={{
              fontSize: '0.68rem',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: C.textDim,
            }}
          >
            {isRunning ? 'Running' : isError ? 'Failed' : 'Completed'}
          </div>
          <div style={{ fontSize: '1.05rem', color: C.text, fontWeight: 600, marginTop: 2 }}>
            {timeline.runId.slice(0, 16)}
            {timeline.runId.length > 16 ? '…' : ''}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <Stat
          icon={Clock}
          label="Duration"
          value={formatDuration(timeline.totalDurationMs)}
          color={C.blue}
        />
        <Stat icon={Cpu} label="LLM calls" value={String(s.llmCalls)} color={C.purple} />
        <Stat icon={Zap} label="Tool calls" value={String(s.toolCalls)} color={C.amber} />
        <Stat
          icon={Cpu}
          label="Tokens"
          value={formatTokens(s.totalTokens.total)}
          color={C.text}
          sub={`${formatTokens(s.totalTokens.input)} in / ${formatTokens(s.totalTokens.output)} out`}
        />
        {cost && (
          <Stat
            icon={DollarSign}
            label="Cost"
            value={formatUsd(cost.total.totalCostUsd)}
            color={C.green}
            sub={cost.byModel.length > 0 ? `${cost.byModel[0]!.model}` : ''}
          />
        )}
        {s.errors > 0 && (
          <Stat icon={AlertTriangle} label="Errors" value={String(s.errors)} color={C.red} />
        )}
      </div>
    </div>
  );
}

interface StatProps {
  icon: LucideIcon;
  label: string;
  value: string;
  color: string;
  sub?: string;
}

function Stat({ icon: Icon, label, value, color, sub }: StatProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon size={16} style={{ color }} />
      <div>
        <div
          style={{
            fontSize: '0.6rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: C.textDim,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: '1.05rem', color: C.text, fontWeight: 600, marginTop: 1 }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: '0.7rem', color: C.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}
