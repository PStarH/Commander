import { useState } from 'react';
import { Brain, Wrench, GitBranch, AlertTriangle, ArrowRight, type LucideIcon } from 'lucide-react';
import type { ObservabilityTimelineNode } from '../types';

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
  track: '#0a1020',
};

const KIND_COLOR: Record<string, string> = {
  AGENT: C.blue,
  TASK: C.blue,
  TOOL: C.purple,
  LLM: C.blue,
  RETRIEVER: C.purple,
  EMBEDDING: C.purple,
  EVALUATOR: C.amber,
  GUARDRAIL: C.amber,
  CHAIN: C.amber,
  DECISION: C.amber,
  ERROR: C.red,
  STATE_CHANGE: C.green,
};

const KIND_ICON: Record<string, LucideIcon> = {
  AGENT: GitBranch,
  TASK: GitBranch,
  TOOL: Wrench,
  LLM: Brain,
  RETRIEVER: Wrench,
  EMBEDDING: Wrench,
  EVALUATOR: Brain,
  GUARDRAIL: Brain,
  CHAIN: GitBranch,
  DECISION: GitBranch,
  ERROR: AlertTriangle,
  STATE_CHANGE: ArrowRight,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

interface TimelineBarProps {
  nodes: ObservabilityTimelineNode[];
  totalDurationMs: number;
  startedAt: string;
}

export function TimelineBar({ nodes, totalDurationMs, startedAt }: TimelineBarProps) {
  const [hovered, setHovered] = useState<ObservabilityTimelineNode | null>(null);
  const startMs = new Date(startedAt).getTime();
  const max = totalDurationMs || 1;

  if (nodes.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: C.textDim, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
        No timeline nodes
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 8, padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{ fontSize: '0.68rem', letterSpacing: '0.16em', textTransform: 'uppercase', color: C.textDim }}>
          Timeline · {nodes.length} spans · {formatDuration(totalDurationMs)}
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: '0.7rem', color: C.textDim }}>
          <Legend color={C.blue} label="LLM/Agent" />
          <Legend color={C.purple} label="Tool" />
          <Legend color={C.amber} label="Decision" />
          <Legend color={C.red} label="Error" />
        </div>
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {nodes.map((node) => {
          const nodeStart = new Date(node.startedAt).getTime() - startMs;
          const leftPct = Math.max(0, (nodeStart / max) * 100);
          const widthPct = Math.max(0.4, (node.durationMs / max) * 100);
          const color = node.status === 'error' ? C.red : KIND_COLOR[node.type] ?? C.textDim;
          const Icon = KIND_ICON[node.type] ?? GitBranch;
          return (
            <div
              key={node.spanId}
              onMouseEnter={() => setHovered(node)}
              onMouseLeave={() => setHovered((h) => (h?.spanId === node.spanId ? null : h))}
              style={{
                position: 'relative',
                height: 22,
                background: C.track,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                title={`${node.name} · ${formatDuration(node.durationMs)}`}
                style={{
                  position: 'absolute',
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  height: '100%',
                  background: color,
                  opacity: node.status === 'error' ? 0.9 : 0.7,
                  borderRadius: 3,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 4,
                  gap: 4,
                  cursor: 'pointer',
                }}
              >
                <Icon size={10} style={{ color: '#02040a' }} />
              </div>
            </div>
          );
        })}
      </div>

      {hovered && (
        <div style={{
          marginTop: 12,
          padding: '10px 12px',
          background: C.track,
          borderRadius: 6,
          border: `1px solid ${C.border}`,
          fontSize: '0.78rem',
          color: C.text,
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Span
            </div>
            <div>{hovered.name}</div>
          </div>
          <div>
            <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Type
            </div>
            <div>{hovered.type} · {hovered.operation}</div>
          </div>
          <div>
            <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Duration
            </div>
            <div>{formatDuration(hovered.durationMs)}</div>
          </div>
          {hovered.model && (
            <div>
              <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Model
              </div>
              <div>{hovered.model} ({hovered.provider})</div>
            </div>
          )}
          {hovered.tokens && (
            <div>
              <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Tokens
              </div>
              <div>{hovered.tokens.input} in / {hovered.tokens.output} out</div>
            </div>
          )}
          {hovered.cost && (
            <div>
              <div style={{ fontSize: '0.6rem', color: C.textDim, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Cost
              </div>
              <div>${hovered.cost.totalCostUsd.toFixed(4)}</div>
            </div>
          )}
          {hovered.errorMessage && (
            <div style={{ flexBasis: '100%' }}>
              <div style={{ fontSize: '0.6rem', color: C.red, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Error
              </div>
              <div style={{ color: C.red }}>{hovered.errorMessage}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span>{label}</span>
    </div>
  );
}
