import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain, Wrench, GitBranch } from 'lucide-react';
import type { ObservabilityDecisionNode, ObservabilityDecisionSummary } from '../types';

const C = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  text: '#e5f0da',
  textDim: '#7f8c86',
  textSubtle: '#53605c',
  border: '#151c23',
  card: '#050913',
  track: '#0a1020',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

interface DecisionListProps {
  decisions: ObservabilityDecisionNode[];
  summary: ObservabilityDecisionSummary;
}

export function DecisionList({ decisions, summary }: DecisionListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (decisions.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: 'center',
          color: C.textDim,
          border: `1px dashed ${C.border}`,
          borderRadius: 8,
        }}
      >
        No decisions recorded
      </div>
    );
  }

  return (
    <div
      style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 8, padding: 16 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: '0.68rem',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: C.textDim,
          }}
        >
          Decisions · {summary.total} total · {summary.withLlmReasoning} with LLM reasoning
        </div>
        <div style={{ fontSize: '0.7rem', color: C.textDim }}>
          avg think {formatDuration(summary.avgThinkDurationMs)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {decisions.map((d) => {
          const isOpen = expanded === d.spanId;
          return (
            <div
              key={d.spanId}
              style={{
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                background: C.track,
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : d.spanId)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  textAlign: 'left',
                }}
              >
                {isOpen ? (
                  <ChevronDown size={14} style={{ color: C.textDim }} />
                ) : (
                  <ChevronRight size={14} style={{ color: C.textDim }} />
                )}
                <Wrench size={14} style={{ color: C.purple }} />
                <span style={{ fontSize: '0.85rem', color: C.text, fontWeight: 600 }}>
                  {d.toolName}
                </span>
                <span
                  style={{
                    fontSize: '0.75rem',
                    color: C.textDim,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {d.decisionReason}
                </span>
                {d.llmModel && (
                  <span
                    style={{
                      fontSize: '0.65rem',
                      color: C.blue,
                      border: `1px solid ${C.blue}40`,
                      padding: '1px 6px',
                      borderRadius: 999,
                    }}
                  >
                    <Brain size={9} style={{ display: 'inline', marginRight: 3 }} />
                    {d.llmModel}
                  </span>
                )}
                <span
                  style={{
                    fontSize: '0.7rem',
                    color: C.textSubtle,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {formatDuration(d.thinkDurationMs)}
                </span>
              </button>
              {isOpen && (
                <div
                  style={{
                    padding: '8px 12px 12px 36px',
                    borderTop: `1px solid ${C.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  {d.llmReasoning && (
                    <div>
                      <div
                        style={{
                          fontSize: '0.6rem',
                          color: C.textDim,
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          marginBottom: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Brain size={10} /> LLM reasoning
                      </div>
                      <div
                        style={{
                          fontSize: '0.82rem',
                          color: C.text,
                          lineHeight: 1.5,
                          background: '#02040a',
                          padding: 8,
                          borderRadius: 4,
                          border: `1px solid ${C.border}`,
                        }}
                      >
                        {d.llmReasoning}
                      </div>
                    </div>
                  )}
                  {Object.keys(d.toolArgs).length > 0 && (
                    <div>
                      <div
                        style={{
                          fontSize: '0.6rem',
                          color: C.textDim,
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          marginBottom: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Wrench size={10} /> Tool args
                      </div>
                      <pre
                        style={{
                          fontSize: '0.72rem',
                          color: C.text,
                          background: '#02040a',
                          padding: 8,
                          borderRadius: 4,
                          border: `1px solid ${C.border}`,
                          margin: 0,
                          overflow: 'auto',
                          maxHeight: 180,
                        }}
                      >
                        {JSON.stringify(d.toolArgs, null, 2)}
                      </pre>
                    </div>
                  )}
                  {d.alternatives && d.alternatives.length > 0 && (
                    <div>
                      <div
                        style={{
                          fontSize: '0.6rem',
                          color: C.textDim,
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          marginBottom: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <GitBranch size={10} /> Alternatives considered
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {(d.alternatives ?? []).map((alt, i) => (
                          <div
                            key={i}
                            style={{
                              fontSize: '0.75rem',
                              color: C.textDim,
                              paddingLeft: 8,
                              borderLeft: `2px solid ${C.border}`,
                            }}
                          >
                            <span style={{ color: C.amber, fontWeight: 600 }}>{alt.toolName}</span>{' '}
                            — {alt.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
