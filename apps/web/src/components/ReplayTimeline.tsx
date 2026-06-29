import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  Brain,
  Wrench,
  GitBranch,
  AlertTriangle,
  ArrowRight,
  Clock,
  Cpu,
  Zap,
  ChevronDown,
  ChevronRight,
  Play,
  CheckCircle,
  XCircle,
  Undo2,
  Loader,
} from 'lucide-react';
import { Badge, Button } from './ui';
import { fetchReplayRuns, fetchReplayEvents, rollbackToStep } from '../api';
import { formatTimestamp } from '../types';
import type { ReplayRun, ReplayEvent } from '../types';

// Event types that represent checkpointed, re-executable steps and are
// therefore valid rollback targets (per GAP-03 spec).
const ROLLBACKABLE_EVENT_TYPES = new Set(['tool_execution', 'state_change']);

type RollbackStatus = 'idle' | 'confirming' | 'success' | 'error';

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  surface: '#050913',
  border: '#151c23',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
};

const EVENT_CONFIG: Record<string, { icon: typeof Brain; color: string; label: string }> = {
  llm_call: { icon: Brain, color: COLORS.blue, label: 'LLM Call' },
  tool_execution: { icon: Wrench, color: COLORS.purple, label: 'Tool' },
  decision: { icon: GitBranch, color: COLORS.amber, label: 'Decision' },
  error: { icon: AlertTriangle, color: COLORS.red, label: 'Error' },
  state_change: { icon: ArrowRight, color: COLORS.green, label: 'State Change' },
};

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export function ReplayTimeline() {
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ReplayRun | null>(null);
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);

  // ── Step-level rollback state (GAP-03 frontend) ───────────────────────
  // rollbackTarget: the event index currently being rolled back (null = idle)
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [rollbackInstructions, setRollbackInstructions] = useState('');
  const [rollbackStatus, setRollbackStatus] = useState<RollbackStatus>('idle');
  const [rollbackMessage, setRollbackMessage] = useState('');
  const [rollbackLoading, setRollbackLoading] = useState(false);

  useEffect(() => {
    loadRuns();
  }, []);

  useEffect(() => {
    if (selectedRun) loadEvents(selectedRun.runId, typeFilter);
  }, [selectedRun, typeFilter]);

  async function loadRuns() {
    setLoading(true);
    try {
      const data = await fetchReplayRuns();
      setRuns(data.runs);
      if (data.runs.length > 0 && !selectedRun) {
        setSelectedRun(data.runs[0]);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }

  async function loadEvents(runId: string, type?: string) {
    setEventsLoading(true);
    try {
      const data = await fetchReplayEvents(runId, type || undefined);
      setEvents(data.events);
    } catch {
      setEvents([]);
    }
    setEventsLoading(false);
  }

  function getEventSummary(event: ReplayEvent): string {
    switch (event.type) {
      case 'llm_call': {
        const model = event.data.modelInfo?.model ?? 'unknown';
        const tokens = event.data.tokenUsage?.totalTokens;
        return `${model}${tokens ? ` · ${formatTokens(tokens)} tokens` : ''}`;
      }
      case 'tool_execution': {
        const name = event.data.toolName ?? 'unknown tool';
        const input =
          typeof event.data.input === 'string'
            ? truncate(event.data.input, 60)
            : truncate(JSON.stringify(event.data.input ?? ''), 60);
        return `${name}${input ? ` · ${input}` : ''}`;
      }
      case 'decision':
        return typeof event.data.decision === 'string'
          ? truncate(event.data.decision, 80)
          : 'Decision recorded';
      case 'error':
        return typeof event.data.error === 'string'
          ? truncate(event.data.error, 80)
          : 'Error occurred';
      case 'state_change': {
        const t = event.data.stateTransition;
        return t ? `${t.from} → ${t.to}` : 'State changed';
      }
      default:
        return event.type;
    }
  }

  // ── Rollback handlers ────────────────────────────────────────────────
  function startRollback(eventIndex: number): void {
    setRollbackTarget(eventIndex);
    setRollbackStatus('confirming');
    setRollbackInstructions('');
    setRollbackMessage('');
  }

  function resetRollback(): void {
    setRollbackTarget(null);
    setRollbackStatus('idle');
    setRollbackInstructions('');
    setRollbackMessage('');
    setRollbackLoading(false);
  }

  async function handleConfirmRollback(runId: string, stepNumber: number): Promise<void> {
    setRollbackLoading(true);
    try {
      const trimmed = rollbackInstructions.trim();
      const result = await rollbackToStep(runId, stepNumber, trimmed || undefined);
      setRollbackStatus('success');
      setRollbackMessage(
        result.message || `Rolled back from step ${result.fromStep} to step ${result.toStep}.`,
      );
    } catch (err) {
      setRollbackStatus('error');
      setRollbackMessage(err instanceof Error ? err.message : 'Failed to rollback to step');
    } finally {
      setRollbackLoading(false);
    }
  }

  /**
   * Renders the step-level rollback panel for a given timeline event.
   *
   * Rendered as a sibling of the timeline-content button (valid HTML — buttons
   * cannot be nested) but visually aligned beneath the expanded detail. Only
   * shown for rollbackable event types (tool_execution / state_change).
   */
  function renderRollbackPanel(eventIndex: number, eventType: string): ReactNode {
    if (!selectedRun) return null;
    if (!ROLLBACKABLE_EVENT_TYPES.has(eventType)) return null;

    const isActive = rollbackTarget === eventIndex;
    const runId = selectedRun.runId;

    return (
      <div className="timeline-rollback" style={{ marginLeft: 38, marginBottom: 8, marginTop: -4 }}>
        {/* Success banner */}
        {isActive && rollbackStatus === 'success' && (
          <div
            className="banner"
            style={{
              marginBottom: 8,
              padding: '8px 12px',
              fontSize: '0.78rem',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <CheckCircle size={14} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{rollbackMessage}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetRollback}>
              Close
            </button>
          </div>
        )}

        {/* Error banner */}
        {isActive && rollbackStatus === 'error' && (
          <div
            className="banner error"
            style={{
              marginBottom: 8,
              padding: '8px 12px',
              fontSize: '0.78rem',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{rollbackMessage}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={resetRollback}
              disabled={rollbackLoading}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Inline confirmation form */}
        {isActive && rollbackStatus === 'confirming' && (
          <div
            style={{
              padding: 10,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--accent-red)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 8,
                fontSize: '0.78rem',
                color: 'var(--accent-red)',
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span>
                Confirm rollback to step {eventIndex}. Execution will re-run from this point.
              </span>
            </div>
            <input
              type="text"
              className="inp"
              value={rollbackInstructions}
              onChange={(e) => setRollbackInstructions(e.target.value)}
              placeholder="Optional: inject correction instructions"
              disabled={rollbackLoading}
              style={{
                width: '100%',
                marginBottom: 8,
                minHeight: 32,
                fontSize: '0.78rem',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => handleConfirmRollback(runId, eventIndex)}
                disabled={rollbackLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {rollbackLoading ? (
                  <Loader size={12} className="spin" />
                ) : (
                  <AlertTriangle size={12} />
                )}
                {rollbackLoading ? 'Rolling back…' : 'Confirm Rollback'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={resetRollback}
                disabled={rollbackLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Default: Rollback to Here button */}
        {!isActive && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => startRollback(eventIndex)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Undo2 size={12} />
            Rollback to Here
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="replay-layout">
        <div className="narrative narrative-green">Loading execution history...</div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="replay-layout">
        <div className="section-head">
          <div>
            <div className="section-label">Execution Replay</div>
            <h2>No execution history</h2>
          </div>
        </div>
        <div className="narrative narrative-green">
          Run an agent task to see execution traces here. Each run's LLM calls, tool executions, and
          decisions are recorded for replay.
        </div>
      </div>
    );
  }

  return (
    <div className="replay-layout">
      {/* Run List */}
      <div className="replay-sidebar">
        <div className="replay-sidebar-header">
          <div className="section-label">Runs</div>
          <span className="run-count">{runs.length}</span>
        </div>
        <div className="replay-run-list">
          {runs.map((run) => (
            <button
              key={run.runId}
              className={`replay-run-item ${selectedRun?.runId === run.runId ? 'active' : ''}`}
              onClick={() => setSelectedRun(run)}
            >
              <div className="run-item-header">
                {run.status === 'completed' ? (
                  <CheckCircle size={14} style={{ color: COLORS.green }} />
                ) : (
                  <XCircle size={14} style={{ color: COLORS.red }} />
                )}
                <span className="run-id">{run.runId.slice(0, 12)}</span>
              </div>
              {run.goal && <div className="run-goal">{truncate(run.goal, 60)}</div>}
              <div className="run-meta">
                <span>{run.totalEvents} events</span>
                <span>{formatDuration(run.durationMs)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="replay-main">
        {selectedRun && (
          <>
            {/* Run Header */}
            <div className="replay-run-header">
              <div className="section-head">
                <div>
                  <div className="section-label">Execution Trace</div>
                  <h2>{selectedRun.goal ?? selectedRun.runId}</h2>
                </div>
                <div className="run-stats">
                  <Badge variant={selectedRun.status === 'completed' ? 'success' : 'error'}>
                    {selectedRun.phase}
                  </Badge>
                  <span className="run-stat">
                    <Cpu size={12} /> {formatTokens(selectedRun.totalTokens)} tokens
                  </span>
                  <span className="run-stat">
                    <Clock size={12} /> {formatDuration(selectedRun.durationMs)}
                  </span>
                  <span className="run-stat">
                    <Zap size={12} /> {selectedRun.totalEvents} events
                  </span>
                </div>
              </div>

              {/* Type Filter */}
              <div className="replay-filters">
                <button
                  className={`filter-chip ${typeFilter === '' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('')}
                >
                  All
                </button>
                {Object.entries(EVENT_CONFIG).map(([type, config]) => (
                  <button
                    key={type}
                    className={`filter-chip ${typeFilter === type ? 'active' : ''}`}
                    onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
                    style={
                      typeFilter === type
                        ? { borderColor: config.color, color: config.color }
                        : undefined
                    }
                  >
                    <config.icon size={12} />
                    {config.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Events Timeline */}
            <div className="replay-timeline">
              {eventsLoading ? (
                <div className="narrative narrative-green">Loading events...</div>
              ) : events.length === 0 ? (
                <div className="narrative narrative-green">No events found</div>
              ) : (
                events.map((event, i) => {
                  const config = EVENT_CONFIG[event.type] ?? EVENT_CONFIG.decision;
                  const Icon = config.icon;
                  const isExpanded = expandedEvent === event.id;

                  return (
                    <div key={event.id} className="timeline-event">
                      <div className="timeline-connector">
                        <div className="timeline-dot" style={{ borderColor: config.color }}>
                          <Icon size={12} style={{ color: config.color }} />
                        </div>
                        {i < events.length - 1 && <div className="timeline-line" />}
                      </div>

                      <button
                        className="timeline-content"
                        onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                      >
                        <div className="timeline-header">
                          <span
                            className="bdg bdg-default"
                            style={{ borderColor: config.color, color: config.color }}
                          >
                            {config.label}
                          </span>
                          <span className="timeline-time">{formatTimestamp(event.timestamp)}</span>
                          {event.durationMs > 0 && (
                            <span className="timeline-duration">
                              {formatDuration(event.durationMs)}
                            </span>
                          )}
                          {event.data.tokenUsage && (
                            <span className="timeline-tokens">
                              {formatTokens(event.data.tokenUsage.totalTokens)} tok
                            </span>
                          )}
                          {isExpanded ? (
                            <ChevronDown size={14} className="timeline-chevron" />
                          ) : (
                            <ChevronRight size={14} className="timeline-chevron" />
                          )}
                        </div>
                        <div className="timeline-summary">{getEventSummary(event)}</div>

                        {/* Expanded Detail */}
                        {isExpanded && (
                          <div className="timeline-detail">
                            {event.data.modelInfo && (
                              <div className="detail-row">
                                <span className="detail-label">Model</span>
                                <span className="detail-value">
                                  {event.data.modelInfo.model} ({event.data.modelInfo.provider})
                                </span>
                              </div>
                            )}
                            {event.data.tokenUsage && (
                              <div className="detail-row">
                                <span className="detail-label">Tokens</span>
                                <span className="detail-value">
                                  {event.data.tokenUsage.promptTokens} prompt +{' '}
                                  {event.data.tokenUsage.completionTokens} completion ={' '}
                                  {event.data.tokenUsage.totalTokens}
                                </span>
                              </div>
                            )}
                            {event.data.input != null && (
                              <div className="detail-row">
                                <span className="detail-label">Input</span>
                                <pre className="detail-pre">
                                  {truncate(
                                    typeof event.data.input === 'string'
                                      ? event.data.input
                                      : JSON.stringify(event.data.input, null, 2),
                                    500,
                                  )}
                                </pre>
                              </div>
                            )}
                            {event.data.output != null && (
                              <div className="detail-row">
                                <span className="detail-label">Output</span>
                                <pre className="detail-pre">
                                  {truncate(
                                    typeof event.data.output === 'string'
                                      ? event.data.output
                                      : JSON.stringify(event.data.output, null, 2),
                                    500,
                                  )}
                                </pre>
                              </div>
                            )}
                            {event.data.error && (
                              <div className="detail-row">
                                <span className="detail-label">Error</span>
                                <pre className="detail-pre error">{String(event.data.error)}</pre>
                              </div>
                            )}
                            {event.data.rationale && (
                              <div className="detail-row">
                                <span className="detail-label">Rationale</span>
                                <span className="detail-value">{event.data.rationale}</span>
                              </div>
                            )}
                            {event.data.stateTransition && (
                              <div className="detail-row">
                                <span className="detail-label">Transition</span>
                                <span className="detail-value">
                                  {event.data.stateTransition.from} <ArrowRight size={12} />{' '}
                                  {event.data.stateTransition.to}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </button>
                      {isExpanded && renderRollbackPanel(i, event.type)}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
