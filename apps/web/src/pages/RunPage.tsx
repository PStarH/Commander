import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { RunHeader } from '../components/RunHeader';
import { TimelineBar } from '../components/TimelineBar';
import { DecisionList } from '../components/DecisionList';
import {
  fetchObservabilityRuns,
  fetchTimeline,
  fetchCostReport,
  fetchDecisions,
} from '../api';
import type {
  ObservabilityRunSummary,
  ObservabilityTimelineView,
  ObservabilityCostReport,
  ObservabilityDecisionResponse,
} from '../types';

const C = {
  text: '#e5f0da',
  textDim: '#7f8c86',
  textSubtle: '#53605c',
  border: '#151c23',
  card: '#050913',
  track: '#0a1020',
  accent: '#4de98c',
  blue: '#4d9eff',
};

function formatTimestamp(value: string): string {
  const d = new Date(value);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function RunPage() {
  const [runs, setRuns] = useState<ObservabilityRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ObservabilityTimelineView | null>(null);
  const [cost, setCost] = useState<ObservabilityCostReport | null>(null);
  const [decisions, setDecisions] = useState<ObservabilityDecisionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchObservabilityRuns();
        if (cancelled) return;
        setRuns(res.runs);
        if (res.runs.length > 0) setSelectedRunId(res.runs[0]!.runId);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([
      fetchTimeline(selectedRunId),
      fetchCostReport(selectedRunId).catch(() => null),
      fetchDecisions(selectedRunId).catch(() => null),
    ]).then(([tl, c, d]) => {
      if (cancelled) return;
      setTimeline(tl);
      setCost(c);
      setDecisions(d);
    }).catch((e) => {
      if (!cancelled) setError((e as Error).message);
    }).finally(() => {
      if (!cancelled) setDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  if (loading) {
    return (
      <div className="page">
        <div style={{ color: C.textDim, padding: 24 }}>Loading runs...</div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Run Timeline</h1>
          <p className="page-desc">Per-run timeline, cost, and decision provenance. Read-only, 30-second scan.</p>
        </div>
        <div style={{
          padding: 32, textAlign: 'center', color: C.textDim,
          border: `1px dashed ${C.border}`, borderRadius: 8, background: C.card,
        }}>
          <Activity size={32} style={{ color: C.textSubtle, marginBottom: 12 }} />
          <div style={{ fontSize: '0.95rem', color: C.text, marginBottom: 6 }}>No execution history yet</div>
          <div style={{ fontSize: '0.8rem' }}>
            Run an agent task to see its timeline, cost, and decision provenance here.
            Each run is recorded as an OpenTelemetry-compatible span tree.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Run Timeline</h1>
        <p className="page-desc">
          Per-run timeline, cost, and decision provenance. Read-only, 30-second scan.
        </p>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#3a1820', border: '1px solid #ff8b9d40', borderRadius: 6, color: '#ff8b9d', marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        <RunList
          runs={runs}
          selected={selectedRunId}
          onSelect={setSelectedRunId}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {detailLoading && !timeline && (
            <div style={{ color: C.textDim, padding: 24 }}>Loading run detail...</div>
          )}
          {timeline && (
            <>
              <RunHeader timeline={timeline} cost={cost ?? undefined} />
              <TimelineBar
                nodes={timeline.nodes}
                totalDurationMs={timeline.totalDurationMs}
                startedAt={timeline.startedAt}
              />
              {decisions && decisions.decisions.length > 0 && (
                <DecisionList decisions={decisions.decisions} summary={decisions.summary} />
              )}
              <div style={{
                padding: 12, background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 6, fontSize: '0.78rem', color: C.textDim,
              }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ textTransform: 'uppercase', fontSize: '0.6rem', letterSpacing: '0.12em', color: C.textSubtle }}>
                      Started
                    </div>
                    <div style={{ color: C.text }}>{formatTimestamp(timeline.startedAt)}</div>
                  </div>
                  {timeline.endedAt && (
                    <div>
                      <div style={{ textTransform: 'uppercase', fontSize: '0.6rem', letterSpacing: '0.12em', color: C.textSubtle }}>
                        Ended
                      </div>
                      <div style={{ color: C.text }}>{formatTimestamp(timeline.endedAt)}</div>
                    </div>
                  )}
                  <div>
                    <div style={{ textTransform: 'uppercase', fontSize: '0.6rem', letterSpacing: '0.12em', color: C.textSubtle }}>
                      Agent
                    </div>
                    <div style={{ color: C.text }}>{timeline.agentId}</div>
                  </div>
                  {cost && cost.byModel.length > 0 && (
                    <div style={{ flexBasis: '100%' }}>
                      <div style={{ textTransform: 'uppercase', fontSize: '0.6rem', letterSpacing: '0.12em', color: C.textSubtle, marginBottom: 4 }}>
                        Cost by model
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {cost.byModel.map((m) => (
                          <div key={`${m.provider}:${m.model}`} style={{ display: 'flex', gap: 12, color: C.text }}>
                            <span style={{ minWidth: 160 }}>{m.provider}/{m.model}</span>
                            <span style={{ color: C.textDim }}>{m.calls} calls · {m.tokens.total} tok</span>
                            <span style={{ color: C.accent }}>${m.cost.totalCostUsd.toFixed(4)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface RunListProps {
  runs: ObservabilityRunSummary[];
  selected: string | null;
  onSelect: (runId: string) => void;
}

function RunList({ runs, selected, onSelect }: RunListProps) {
  return (
    <div style={{
      border: `1px solid ${C.border}`, background: C.card, borderRadius: 8,
      padding: 12, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto',
    }}>
      <div style={{
        fontSize: '0.68rem', letterSpacing: '0.16em', textTransform: 'uppercase',
        color: C.textDim, marginBottom: 10, display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Runs</span>
        <span style={{ color: C.blue }}>{runs.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {runs.map((r) => {
          const isActive = selected === r.runId;
          return (
            <button
              key={r.runId}
              onClick={() => onSelect(r.runId)}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 4,
                background: isActive ? 'rgba(77, 158, 255, 0.12)' : C.track,
                border: isActive ? '1px solid #4d9eff40' : `1px solid ${C.border}`,
                color: C.text,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }}>
                <span style={{
                  width: 6, height: 6, borderRadius: 999,
                  background: r.status === 'completed' ? C.accent : C.blue,
                }} />
                <span style={{ fontFamily: 'var(--font-mono)' }}>{r.runId.slice(0, 12)}</span>
              </div>
              <div style={{ display: 'flex', gap: 10, fontSize: '0.7rem', color: C.textDim, marginTop: 4 }}>
                <span>{r.llmCalls} LLM</span>
                <span>{r.toolExecutions} tool</span>
                <span>{r.totalTokens} tok</span>
              </div>
              <div style={{ fontSize: '0.65rem', color: C.textSubtle, marginTop: 2 }}>
                {formatTimestamp(r.startedAt)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
