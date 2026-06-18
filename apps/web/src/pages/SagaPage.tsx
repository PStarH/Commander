import { useEffect, useState, useRef } from 'react';
import { GitBranch, Play, RotateCcw } from 'lucide-react';
import { fetchSagaRuns, fetchSagaRun, resumeSagaRun, forkSagaRun } from '../api';
import type { SagaRunSummary, SagaRunDetail, SagaTimelineEvent } from '../types';

export function SagaPage() {
  const [runs, setRuns] = useState<SagaRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SagaRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    loadRuns();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    loadRun(selectedRunId);

    const es = new EventSource(
      `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'}/api/saga/stream/${selectedRunId}`,
    );
    eventSourceRef.current = es;

    es.addEventListener('saga.completed', (e) => {
      const data = JSON.parse(e.data);
      setLiveState(`completed: ${data.status}`);
      loadRun(selectedRunId);
    });
    es.addEventListener('saga.failed', (e) => {
      const data = JSON.parse(e.data);
      setLiveState(`failed: ${data.error}`);
      loadRun(selectedRunId);
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [selectedRunId]);

  async function loadRuns() {
    try {
      setError(null);
      const data = await fetchSagaRuns();
      setRuns(data.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load saga runs');
    }
  }

  async function loadRun(runId: string) {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSagaRun(runId);
      setDetail(data);
      setLiveState(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load saga run');
    } finally {
      setLoading(false);
    }
  }

  async function handleResume(runId: string) {
    try {
      setError(null);
      await resumeSagaRun(runId);
      setLiveState('resuming...');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resume saga');
    }
  }

  async function handleFork(runId: string, nodeId: string) {
    try {
      setError(null);
      const result = await forkSagaRun(runId, nodeId);
      setSelectedRunId(result.newRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fork saga');
    }
  }

  const terminalStates = new Set(['COMMITTED', 'ABORTED']);

  return (
    <div className="page saga-page">
      <div className="page-head">
        <h1>
          <GitBranch size={22} style={{ marginRight: 10, verticalAlign: 'middle' }} />
          Saga Time-Travel
        </h1>
        <p className="page-desc">
          Resume, replay, and fork multi-step agent transactions from any checkpoint.
        </p>
      </div>

      {error && (
        <div className="banner error">
          <span>{error}</span>
        </div>
      )}

      <div className="saga-layout">
        <aside className="saga-sidebar card">
          <div className="section-head">
            <div>
              <div className="section-label">Runs</div>
              <h2>Sagas</h2>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={loadRuns}
              title="Refresh"
            >
              <RotateCcw size={14} />
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="empty-state">No saga runs found.</p>
          ) : (
            <ul className="saga-run-list">
              {runs.map((run) => (
                <li key={run.runId}>
                  <button
                    type="button"
                    className={`saga-run-item ${selectedRunId === run.runId ? 'active' : ''}`}
                    onClick={() => setSelectedRunId(run.runId)}
                  >
                    <span className="saga-run-id">{run.runId}</span>
                    <span className={`bdg bdg-${stateVariant(run.state)}`}>{run.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="saga-main card">
          {!selectedRunId ? (
            <div className="empty-state">Select a saga run to inspect its timeline.</div>
          ) : loading ? (
            <div className="loading-screen">
              <div className="loader" />
              <p>Loading saga state...</p>
            </div>
          ) : detail ? (
            <>
              <div className="saga-detail-header">
                <div>
                  <h2>{detail.runId}</h2>
                  <p className="meta">
                    {detail.snapshot.sagaName ?? 'unknown saga'} · {detail.snapshot.state}
                    {liveState && <span className="live"> · {liveState}</span>}
                  </p>
                </div>
                {!terminalStates.has(detail.snapshot.state) && (
                  <button
                    type="button"
                    className="btn btn-primary btn-md"
                    onClick={() => handleResume(detail.runId)}
                  >
                    <Play size={14} /> Resume
                  </button>
                )}
              </div>

              {detail.snapshot.error && <div className="banner error">{detail.snapshot.error}</div>}

              <div className="saga-timeline">
                {detail.events.map((ev: SagaTimelineEvent, idx: number) => (
                  <div key={idx} className={`timeline-event ${ev.kind.replace(/\./g, '-')}`}>
                    <div className="timeline-dot" />
                    <div className="timeline-body">
                      <div className="timeline-meta">
                        <span className="timeline-kind">{ev.kind}</span>
                        <span className="timeline-time">
                          {new Date(ev.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {ev.name && <div className="timeline-node">{ev.name}</div>}
                      {ev.state && <div className="timeline-state">state: {ev.state}</div>}
                      {ev.error && <div className="timeline-error">{ev.error}</div>}
                    </div>
                    {ev.kind === 'step.completed' && ev.nodeId && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleFork(detail.runId, ev.nodeId!)}
                        title="Fork a new run from this step"
                      >
                        <GitBranch size={14} /> Fork
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function stateVariant(state: string): string {
  switch (state) {
    case 'COMMITTED':
      return 'success';
    case 'ABORTED':
      return 'error';
    case 'EXECUTING':
      return 'info';
    default:
      return 'default';
  }
}
