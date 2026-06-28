/**
 * HallucinationRiskPanel — surfaces the Core HallucinationDetector output
 * (riskScore 0-1 + recommendation + 13 signal types) for a selected run.
 *
 * Pulls hallucination reports from `/api/hallucination/runs/:runId` (GAP-04).
 * The run picker is populated from the existing replay runs list so the panel
 * is self-contained when dropped into ExecutionPage.
 */
import { useEffect, useState } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Brain,
  AlertTriangle,
  Activity,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { Badge, MetricCard } from './ui';
import { fetchHallucinationReport, fetchReplayRuns } from '../api';
import { formatTimestamp } from '../types';
import type {
  HallucinationReportEntry,
  HallucinationReportResponse,
  HallucinationSignal,
  ReplayRun,
} from '../types';

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

/**
 * Map a 0-1 risk score to a color per the GAP-04 spec:
 *   green  < 0.3
 *   yellow 0.3 - 0.7
 *   red    > 0.7
 */
function riskColor(riskScore: number): string {
  if (riskScore >= 0.7) return COLORS.red;
  if (riskScore >= 0.3) return COLORS.amber;
  return COLORS.green;
}

function riskLabel(riskScore: number): string {
  if (riskScore >= 0.7) return 'High risk';
  if (riskScore >= 0.3) return 'Medium risk';
  return 'Low risk';
}

function recommendationVariant(
  recommendation: HallucinationReportEntry['recommendation'],
): 'success' | 'warning' | 'error' {
  switch (recommendation) {
    case 'pass':
      return 'success';
    case 'flag_for_review':
      return 'warning';
    case 'reject':
      return 'error';
  }
}

function recommendationIcon(
  recommendation: HallucinationReportEntry['recommendation'],
) {
  switch (recommendation) {
    case 'pass':
      return <ShieldCheck size={14} style={{ color: COLORS.green }} />;
    case 'flag_for_review':
      return <ShieldAlert size={14} style={{ color: COLORS.amber }} />;
    case 'reject':
      return <ShieldX size={14} style={{ color: COLORS.red }} />;
  }
}

function severityColor(severity: HallucinationSignal['severity']): string {
  switch (severity) {
    case 'high':
      return COLORS.red;
    case 'medium':
      return COLORS.amber;
    case 'low':
      return COLORS.green;
  }
}

function severityVariant(severity: HallucinationSignal['severity']): 'error' | 'warning' | 'success' {
  switch (severity) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'success';
  }
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** Human-readable label for each of the 13 hallucination signal types. */
const SIGNAL_LABELS: Record<string, string> = {
  overconfidence: 'Overconfidence',
  unsupported_specificity: 'Unsupported specificity',
  inconsistency: 'Inconsistency',
  fabricated_reference: 'Fabricated reference',
  temporal_impossibility: 'Temporal impossibility',
  numeric_anomaly: 'Numeric anomaly',
  self_contradiction: 'Self-contradiction',
  confidence_inconsistency: 'Confidence inconsistency',
  entailment_failure: 'Entailment failure',
  claim_unverifiable: 'Claim unverifiable',
  multi_sample_inconsistency: 'Multi-sample inconsistency',
  entity_hallucination: 'Entity hallucination',
  hedged_as_fact: 'Hedged as fact',
};

function signalLabel(type: string): string {
  return SIGNAL_LABELS[type] ?? type;
}

interface HallucinationRiskPanelProps {
  /** Optional pre-selected runId (e.g. when embedded in a run-scoped view). */
  runId?: string;
}

export function HallucinationRiskPanel({ runId: initialRunId }: HallucinationRiskPanelProps) {
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(initialRunId ?? '');
  const [report, setReport] = useState<HallucinationReportResponse | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the list of available runs once.
  useEffect(() => {
    let cancelled = false;
    async function loadRuns() {
      setLoadingRuns(true);
      try {
        const data = await fetchReplayRuns();
        if (!cancelled) {
          setRuns(data.runs);
          if (!initialRunId && data.runs.length > 0) {
            setSelectedRunId(data.runs[0].runId);
          }
        }
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setLoadingRuns(false);
      }
    }
    loadRuns();
    return () => {
      cancelled = true;
    };
  }, [initialRunId]);

  // Load the hallucination report whenever the selected run changes.
  useEffect(() => {
    if (!selectedRunId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    async function loadReport() {
      setLoadingReport(true);
      setError(null);
      try {
        const data = await fetchHallucinationReport(selectedRunId);
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load hallucination report');
          setReport(null);
        }
      } finally {
        if (!cancelled) setLoadingReport(false);
      }
    }
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  // Aggregate stats across all reports for the selected run.
  const aggregated = report && report.reports.length > 0
    ? aggregateReports(report.reports)
    : null;

  return (
    <div className="confidence-panel">
      <div className="section-head">
        <div>
          <div className="section-label">Hallucination Detection</div>
          <h2>Output grounding risk</h2>
        </div>
        <div className="confidence-filters">
          <select
            className="sel"
            value={selectedRunId}
            onChange={(e) => setSelectedRunId(e.target.value)}
            disabled={loadingRuns || runs.length === 0}
          >
            {loadingRuns && <option value="">Loading runs...</option>}
            {!loadingRuns && runs.length === 0 && <option value="">No runs available</option>}
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId.slice(0, 12)} · {run.totalEvents} events
              </option>
            ))}
          </select>
          {selectedRunId && (
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => setSelectedRunId((current) => current && current)}
              title="Refresh"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      </div>

      {loadingReport && (
        <div className="narrative narrative-green">Loading hallucination report...</div>
      )}

      {!loadingReport && error && (
        <div className="narrative narrative-amber">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loadingReport && !error && !report && (
        <div className="narrative narrative-green">
          Select a run to view hallucination detection results. The Core HallucinationDetector
          scans every LLM output for 13 signal types (overconfidence, fabricated references,
          temporal impossibility, and more) and emits a risk score plus a pass / flag / reject
          recommendation.
        </div>
      )}

      {!loadingReport && !error && report && report.reports.length === 0 && (
        <div className="narrative narrative-green">
          No hallucination signals recorded for this run. Either the run produced no LLM output,
          or every output passed the grounding checks cleanly.
        </div>
      )}

      {!loadingReport && !error && report && report.reports.length > 0 && aggregated && (
        <>
          {/* Metric Cards */}
          <div className="metric-row">
            <MetricCard
              label="Avg risk score"
              value={`${(aggregated.avgRiskScore * 100).toFixed(0)}%`}
              icon={<Brain size={14} />}
              trend={{
                value: riskLabel(aggregated.avgRiskScore),
                positive: aggregated.avgRiskScore < 0.3,
              }}
            />
            <MetricCard
              label="Peak risk score"
              value={`${(aggregated.peakRiskScore * 100).toFixed(0)}%`}
              icon={<Activity size={14} />}
              trend={{
                value: riskLabel(aggregated.peakRiskScore),
                positive: aggregated.peakRiskScore < 0.3,
              }}
            />
            <MetricCard
              label="Reports"
              value={String(report.total)}
              icon={<AlertTriangle size={14} />}
            />
            <MetricCard
              label="Signals"
              value={String(aggregated.totalSignals)}
              icon={<AlertTriangle size={14} />}
              trend={{
                value: aggregated.rejectCount > 0 ? 'Rejects' : 'None rejected',
                positive: aggregated.rejectCount === 0,
              }}
            />
          </div>

          {/* Risk gauge */}
          <div className="confidence-gauge">
            <div className="gauge-label">Average Hallucination Risk</div>
            <div className="gauge-bar-track">
              <div
                className="gauge-bar-fill"
                style={{
                  width: `${aggregated.avgRiskScore * 100}%`,
                  background: riskColor(aggregated.avgRiskScore),
                }}
              />
              <div className="gauge-markers">
                <div className="gauge-marker" style={{ left: '30%' }}>
                  <span>0.3</span>
                </div>
                <div className="gauge-marker" style={{ left: '70%' }}>
                  <span>0.7</span>
                </div>
              </div>
            </div>
            <div className="gauge-labels">
              <span style={{ color: COLORS.green }}>Low (&lt;0.3)</span>
              <span style={{ color: COLORS.amber }}>Medium (0.3-0.7)</span>
              <span style={{ color: COLORS.red }}>High (&gt;0.7)</span>
            </div>
          </div>

          {/* Per-report timeline */}
          <div className="replay-timeline">
            {report.reports.map((entry, i) => {
              const color = riskColor(entry.riskScore);
              const isExpanded = expandedReport === entry.eventId;
              const isLast = i === report.reports.length - 1;
              return (
                <div key={entry.eventId} className="timeline-event">
                  <div className="timeline-connector">
                    <div className="timeline-dot" style={{ borderColor: color }}>
                      {recommendationIcon(entry.recommendation)}
                    </div>
                    {!isLast && <div className="timeline-line" />}
                  </div>

                  <button
                    type="button"
                    className="timeline-content"
                    onClick={() => setExpandedReport(isExpanded ? null : entry.eventId)}
                  >
                    <div className="timeline-header">
                      <span
                        className="bdg bdg-default"
                        style={{ borderColor: color, color }}
                      >
                        {entry.eventType}
                      </span>
                      <Badge variant={recommendationVariant(entry.recommendation)}>
                        {entry.recommendation.replace(/_/g, ' ')}
                      </Badge>
                      <span className="timeline-time">{formatTimestamp(entry.timestamp)}</span>
                      <span
                        className="timeline-tokens"
                        style={{ color }}
                      >
                        {(entry.riskScore * 100).toFixed(0)}% risk
                      </span>
                      {isExpanded ? (
                        <ChevronDown size={14} className="timeline-chevron" />
                      ) : (
                        <ChevronRight size={14} className="timeline-chevron" />
                      )}
                    </div>
                    <div className="timeline-summary">
                      {entry.summary || `${entry.signals.length} signal(s) detected`}
                    </div>

                    {isExpanded && (
                      <div className="timeline-detail">
                        <div className="detail-row">
                          <span className="detail-label">Agent</span>
                          <span className="detail-value">{entry.agentId}</span>
                        </div>
                        <div className="detail-row">
                          <span className="detail-label">Risk score</span>
                          <span className="detail-value" style={{ color }}>
                            {entry.riskScore.toFixed(3)} ({riskLabel(entry.riskScore)})
                          </span>
                        </div>
                        <div className="detail-row">
                          <span className="detail-label">Recommendation</span>
                          <span className="detail-value">
                            {recommendationIcon(entry.recommendation)}{' '}
                            {entry.recommendation}
                          </span>
                        </div>

                        {entry.signals.length > 0 && (
                          <div className="detail-row">
                            <span className="detail-label">Signals</span>
                            <div className="actions-list" style={{ flex: 1 }}>
                              {entry.signals.map((signal, idx) => (
                                <div key={idx} className="action-item">
                                  <div className="action-header">
                                    <Badge variant={severityVariant(signal.severity)}>
                                      {signalLabel(signal.type)}
                                    </Badge>
                                    <span
                                      className="action-score"
                                      style={{ color: severityColor(signal.severity) }}
                                    >
                                      {signal.severity}
                                    </span>
                                  </div>
                                  {signal.evidence && (
                                    <div className="action-rationale">
                                      {truncate(signal.evidence, 200)}
                                    </div>
                                  )}
                                  {signal.suggestion && (
                                    <div className="action-recommendation">
                                      <ShieldCheck size={12} /> {signal.suggestion}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

interface AggregatedReport {
  avgRiskScore: number;
  peakRiskScore: number;
  totalSignals: number;
  rejectCount: number;
  flagCount: number;
  passCount: number;
}

function aggregateReports(reports: HallucinationReportEntry[]): AggregatedReport {
  if (reports.length === 0) {
    return {
      avgRiskScore: 0,
      peakRiskScore: 0,
      totalSignals: 0,
      rejectCount: 0,
      flagCount: 0,
      passCount: 0,
    };
  }
  let sum = 0;
  let peak = 0;
  let signals = 0;
  let rejectCount = 0;
  let flagCount = 0;
  let passCount = 0;
  for (const r of reports) {
    sum += r.riskScore;
    if (r.riskScore > peak) peak = r.riskScore;
    signals += r.signals.length;
    if (r.recommendation === 'reject') rejectCount++;
    else if (r.recommendation === 'flag_for_review') flagCount++;
    else passCount++;
  }
  return {
    avgRiskScore: sum / reports.length,
    peakRiskScore: peak,
    totalSignals: signals,
    rejectCount,
    flagCount,
    passCount,
  };
}
