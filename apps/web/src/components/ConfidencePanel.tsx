import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  CheckCircle,
  Info,
} from 'lucide-react';
import { MetricCard, Badge } from './ui';
import { fetchMissionConfidence, fetchAgentConfidence } from '../api';
import type { ConfidenceReport, Mission, AgentWorkload } from '../types';

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

interface ConfidencePanelProps {
  missions: Mission[];
  agents: AgentWorkload[];
}

export function ConfidencePanel({ missions, agents }: ConfidencePanelProps) {
  const [selectedMission, setSelectedMission] = useState<string>('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [report, setReport] = useState<ConfidenceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-select first running mission
  useEffect(() => {
    const running = missions.find((m) => m.status === 'RUNNING');
    if (running && !selectedMission) {
      setSelectedMission(running.id);
    }
  }, [missions, selectedMission]);

  // Fetch confidence data when selection changes
  useEffect(() => {
    loadConfidence();
  }, [selectedMission, selectedAgent]);

  async function loadConfidence() {
    if (!selectedMission && !selectedAgent) return;

    setLoading(true);
    setError(null);
    try {
      let data: ConfidenceReport;
      if (selectedAgent) {
        data = await fetchAgentConfidence(selectedAgent);
      } else {
        data = await fetchMissionConfidence(selectedMission);
      }
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load confidence data');
      setReport(null);
    }
    setLoading(false);
  }

  // Get confidence color
  function getConfidenceColor(score: number): string {
    if (score >= 0.8) return COLORS.green;
    if (score >= 0.6) return COLORS.amber;
    return COLORS.red;
  }

  // Get confidence label
  function getConfidenceLabel(score: number): string {
    if (score >= 0.8) return 'High';
    if (score >= 0.6) return 'Medium';
    return 'Low';
  }

  // Get trend icon
  function getTrendIcon(direction: string) {
    switch (direction) {
      case 'improving':
        return <TrendingUp size={14} />;
      case 'declining':
        return <TrendingDown size={14} />;
      default:
        return <Minus size={14} />;
    }
  }

  // Prepare distribution chart data
  const distributionData = report
    ? [
        { name: 'Low', count: report.distribution.low, color: COLORS.red },
        { name: 'Medium', count: report.distribution.medium, color: COLORS.amber },
        { name: 'High', count: report.distribution.high, color: COLORS.green },
        { name: 'Very High', count: report.distribution.veryHigh, color: COLORS.blue },
      ]
    : [];

  return (
    <div className="confidence-panel">
      <div className="section-head">
        <div>
          <div className="section-label">Confidence Scoring</div>
          <h2>Decision reliability</h2>
        </div>
        <div className="confidence-filters">
          <select
            className="sel"
            value={selectedMission}
            onChange={(e) => {
              setSelectedMission(e.target.value);
              setSelectedAgent('');
            }}
          >
            <option value="">Select mission...</option>
            {missions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          <select
            className="sel"
            value={selectedAgent}
            onChange={(e) => {
              setSelectedAgent(e.target.value);
              if (e.target.value) setSelectedMission('');
            }}
          >
            <option value="">Or select agent...</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="narrative narrative-green">Loading confidence data...</div>}

      {error && (
        <div className="narrative narrative-amber">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loading && !error && !report && (
        <div className="narrative narrative-green">
          Select a mission or agent to view confidence scoring. Confidence is tracked per-decision
          and aggregated into reports.
        </div>
      )}

      {!loading && !error && report && report.totalDecisions === 0 && (
        <div className="narrative narrative-green">
          No decisions recorded yet for this {selectedAgent ? 'agent' : 'mission'}. Confidence data
          appears after agents make decisions.
        </div>
      )}

      {!loading && report && report.totalDecisions > 0 && (
        <>
          {/* Metric Cards */}
          <div className="metric-row">
            <MetricCard
              label="Avg confidence"
              value={`${(report.averageConfidence * 100).toFixed(0)}%`}
              icon={
                report.averageConfidence >= 0.8 ? (
                  <ShieldCheck size={14} />
                ) : (
                  <ShieldAlert size={14} />
                )
              }
              trend={{
                value: getConfidenceLabel(report.averageConfidence),
                positive: report.averageConfidence >= 0.8,
              }}
            />
            <MetricCard
              label="Total decisions"
              value={String(report.totalDecisions)}
              icon={<Info size={14} />}
            />
            <MetricCard
              label="Trend"
              value={report.trend.direction}
              icon={getTrendIcon(report.trend.direction)}
              trend={
                report.trend.changeRate !== 0
                  ? {
                      value: `${report.trend.changeRate > 0 ? '+' : ''}${report.trend.changeRate.toFixed(1)}%`,
                      positive: report.trend.direction === 'improving',
                    }
                  : undefined
              }
            />
            <MetricCard
              label="Low confidence"
              value={String(report.distribution.low)}
              icon={<AlertTriangle size={14} />}
              trend={
                report.distribution.low > 0
                  ? { value: 'Needs review', positive: false }
                  : { value: 'All clear', positive: true }
              }
            />
          </div>

          {/* Confidence Gauge */}
          <div className="confidence-gauge">
            <div className="gauge-label">Overall Confidence</div>
            <div className="gauge-bar-track">
              <div
                className="gauge-bar-fill"
                style={{
                  width: `${report.averageConfidence * 100}%`,
                  background: getConfidenceColor(report.averageConfidence),
                }}
              />
              <div className="gauge-markers">
                <div className="gauge-marker" style={{ left: '40%' }}>
                  <span>0.4</span>
                </div>
                <div className="gauge-marker" style={{ left: '60%' }}>
                  <span>0.6</span>
                </div>
                <div className="gauge-marker" style={{ left: '80%' }}>
                  <span>0.8</span>
                </div>
              </div>
            </div>
            <div className="gauge-labels">
              <span style={{ color: COLORS.red }}>Low</span>
              <span style={{ color: COLORS.amber }}>Medium</span>
              <span style={{ color: COLORS.green }}>High</span>
            </div>
          </div>

          {/* Distribution Chart */}
          <div className="chart-row">
            <div className="chart-card">
              <div className="chart-title">Decision Distribution</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={distributionData} margin={{ left: 0, right: 10 }}>
                  <XAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: COLORS.text, fontSize: 11 }}
                  />
                  <YAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: COLORS.surface,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: COLORS.textPrimary }}
                  />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {distributionData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card">
              <div className="chart-title">Confidence Levels</div>
              <div className="confidence-levels">
                {distributionData.map((level) => (
                  <div key={level.name} className="level-item">
                    <div className="level-bar">
                      <div
                        className="level-fill"
                        style={{
                          width:
                            report.totalDecisions > 0
                              ? `${(level.count / report.totalDecisions) * 100}%`
                              : '0%',
                          background: level.color,
                        }}
                      />
                    </div>
                    <span className="level-label">{level.name}</span>
                    <span className="level-count">{level.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Low Confidence Actions */}
          {report.lowConfidenceActions.length > 0 && (
            <div className="low-confidence-actions">
              <div className="chart-title">
                <AlertTriangle size={14} /> Low Confidence Actions
              </div>
              <div className="actions-list">
                {report.lowConfidenceActions.map((action, i) => (
                  <div key={i} className="action-item">
                    <div className="action-header">
                      <Badge variant="warning">{action.actionType}</Badge>
                      <span className="action-score" style={{ color: COLORS.red }}>
                        {(action.confidenceScore * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="action-rationale">{action.rationale}</div>
                    {action.recommendation && (
                      <div className="action-recommendation">
                        <CheckCircle size={12} /> {action.recommendation}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {report.recommendations.length > 0 && (
            <div className="confidence-recommendations">
              <div className="chart-title">Recommendations</div>
              <ul className="recommendations-list">
                {report.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
