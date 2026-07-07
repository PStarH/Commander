import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Bell,
  ShieldAlert,
  DollarSign,
  BrainCircuit,
  AlertTriangle,
  Info,
  X,
  RefreshCw,
  Filter,
  Clock,
} from 'lucide-react';
import {
  fetchUnifiedAlerts,
  type UnifiedAlert,
  type AlertSource,
  type AlertSeverity,
} from '../api';
import { formatTimestamp } from '../types';

const SOURCE_META: Record<AlertSource, { label: string; icon: React.ReactNode; color: string }> = {
  governance: {
    label: 'Governance',
    icon: <ShieldAlert size={14} />,
    color: 'var(--accent-amber)',
  },
  cost: { label: 'Cost', icon: <DollarSign size={14} />, color: 'var(--accent-blue)' },
  confidence: {
    label: 'Confidence',
    icon: <BrainCircuit size={14} />,
    color: 'var(--accent-purple)',
  },
};

const SEVERITY_META: Record<
  AlertSeverity,
  { label: string; icon: React.ReactNode; color: string; bg: string; border: string }
> = {
  critical: {
    label: 'Critical',
    icon: <AlertTriangle size={12} />,
    color: 'var(--accent-red)',
    bg: 'var(--accent-red-bg)',
    border: 'var(--accent-red-border)',
  },
  warning: {
    label: 'Warning',
    icon: <Bell size={12} />,
    color: 'var(--accent-amber)',
    bg: 'var(--accent-amber-bg)',
    border: 'var(--accent-amber-border)',
  },
  info: {
    label: 'Info',
    icon: <Info size={12} />,
    color: 'var(--accent-blue)',
    bg: 'var(--accent-blue-bg)',
    border: 'var(--accent-blue-border)',
  },
};

export function AlertsPage() {
  const [data, setData] = useState<{ alerts: UnifiedAlert[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<AlertSource | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await fetchUnifiedAlerts(true);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filteredAlerts = useMemo(() => {
    if (!data) return [];
    return data.alerts.filter((a) => {
      const sourceOk = sourceFilter === 'all' || a.source === sourceFilter;
      const severityOk = severityFilter === 'all' || a.severity === severityFilter;
      return sourceOk && severityOk;
    });
  }, [data, sourceFilter, severityFilter]);

  const counts = useMemo(() => {
    const bySource: Record<AlertSource, number> = { governance: 0, cost: 0, confidence: 0 };
    const bySeverity: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
    for (const alert of data?.alerts ?? []) {
      bySource[alert.source]++;
      bySeverity[alert.severity]++;
    }
    return { bySource, bySeverity };
  }, [data]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Alert Center</div>
          <h1>Unified Alerts</h1>
        </div>
        <p className="page-desc">
          Aggregated warnings from Governance, Cost, and Confidence engines. Review, filter, and
          drill down into operational signals in one place.
        </p>
      </div>

      {/* Summary cards */}
      <div className="metric-row">
        <SummaryCard
          label="Total alerts"
          value={data?.total ?? 0}
          icon={<Bell size={14} />}
          color="var(--text-secondary)"
        />
        <SummaryCard
          label="Critical"
          value={counts.bySeverity.critical}
          icon={<AlertTriangle size={14} />}
          color="var(--accent-red)"
        />
        <SummaryCard
          label="Warnings"
          value={counts.bySeverity.warning}
          icon={<Bell size={14} />}
          color="var(--accent-amber)"
        />
        <SummaryCard
          label="Info"
          value={counts.bySeverity.info}
          icon={<Info size={14} />}
          color="var(--accent-blue)"
        />
      </div>

      {/* Source distribution */}
      <div className="metric-row" style={{ marginTop: 8, marginBottom: 20 }}>
        {(Object.keys(SOURCE_META) as AlertSource[]).map((source) => (
          <button
            key={source}
            type="button"
            onClick={() => setSourceFilter(sourceFilter === source ? 'all' : source)}
            className={`card metric source-card ${sourceFilter === source ? 'active' : ''}`}
            style={
              {
                '--source-color': SOURCE_META[source].color,
                borderColor: sourceFilter === source ? SOURCE_META[source].color : undefined,
              } as React.CSSProperties
            }
          >
            <div className="metric-head">
              <span className="metric-icon" style={{ color: SOURCE_META[source].color }}>
                {SOURCE_META[source].icon}
              </span>
              <span className="metric-label">{SOURCE_META[source].label}</span>
            </div>
            <span className="metric-value">{counts.bySource[source]}</span>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Filter size={14} style={{ color: 'var(--text-muted)' }} />
          <Select
            value={sourceFilter}
            onChange={(v) => setSourceFilter(v as AlertSource | 'all')}
            options={[
              { value: 'all', label: 'All sources' },
              { value: 'governance', label: 'Governance' },
              { value: 'cost', label: 'Cost' },
              { value: 'confidence', label: 'Confidence' },
            ]}
          />
          <Select
            value={severityFilter}
            onChange={(v) => setSeverityFilter(v as AlertSeverity | 'all')}
            options={[
              { value: 'all', label: 'All severities' },
              { value: 'critical', label: 'Critical' },
              { value: 'warning', label: 'Warning' },
              { value: 'info', label: 'Info' },
            ]}
          />
          {(sourceFilter !== 'all' || severityFilter !== 'all') && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSourceFilter('all');
                setSeverityFilter('all');
              }}
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => load(true)}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Refresh
        </button>
      </div>

      {/* Loading / error */}
      {loading && !data && <div className="narrative narrative-green">Loading alerts…</div>}
      {error && !data && (
        <div className="narrative narrative-red">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Alert list */}
      {!loading && !error && filteredAlerts.length === 0 && (
        <div className="empty-state">
          <Bell size={32} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No alerts match the current filters
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: 4 }}>
            {(data?.total ?? 0) > 0
              ? 'Try clearing filters to see all alerts.'
              : 'All systems are clear right now.'}
          </div>
        </div>
      )}

      {filteredAlerts.length > 0 && (
        <div className="alert-list">
          {filteredAlerts.map((alert) => {
            const severity = SEVERITY_META[alert.severity];
            const source = SOURCE_META[alert.source];
            const isExpanded = expandedId === alert.id;
            return (
              <div
                key={alert.id}
                className="card alert-card"
                style={{
                  borderLeft: `3px solid ${severity.color}`,
                  cursor: 'pointer',
                }}
                onClick={() => setExpandedId(isExpanded ? null : alert.id)}
              >
                <div className="alert-row">
                  <div className="alert-severity" style={{ color: severity.color }}>
                    {severity.icon}
                  </div>
                  <div className="alert-body">
                    <div className="alert-top">
                      <span
                        className="bdg"
                        style={{
                          color: severity.color,
                          background: severity.bg,
                          borderColor: severity.border,
                        }}
                      >
                        {severity.label}
                      </span>
                      <span
                        className="bdg bdg-default"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <span style={{ color: source.color }}>{source.icon}</span>
                        {source.label}
                      </span>
                      <span className="alert-category">{alert.category}</span>
                    </div>
                    <div className="alert-message">{alert.message}</div>
                    <div className="alert-meta">
                      <Clock size={12} />
                      {formatTimestamp(alert.timestamp)}
                      {alert.link && (
                        <NavLink
                          to={alert.link.to}
                          className="alert-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {alert.link.label} →
                        </NavLink>
                      )}
                    </div>
                  </div>
                  <div className="alert-expand">{isExpanded ? '−' : '+'}</div>
                </div>
                {isExpanded && alert.payload && (
                  <div className="alert-details">
                    <pre>{JSON.stringify(alert.payload, null, 2)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .source-card {
          text-align: left;
          transition: all var(--transition);
        }
        .source-card:hover {
          border-color: var(--source-color);
        }
        .source-card.active {
          background: color-mix(in srgb, var(--source-color) 10%, var(--bg-card));
        }
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 48px 24px;
          border: 1px dashed var(--border-default);
          border-radius: var(--radius-lg);
          background: var(--bg-card);
        }
        .alert-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .alert-card {
          padding: 14px 16px;
        }
        .alert-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }
        .alert-severity {
          margin-top: 2px;
          flex-shrink: 0;
        }
        .alert-body {
          flex: 1;
          min-width: 0;
        }
        .alert-top {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          flex-wrap: wrap;
        }
        .alert-category {
          font-size: 0.65rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .alert-message {
          font-size: 0.85rem;
          color: var(--text-secondary);
          line-height: 1.45;
          word-break: break-word;
        }
        .alert-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 8px;
          font-size: 0.7rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .alert-link {
          margin-left: auto;
          color: var(--accent-blue);
        }
        .alert-link:hover {
          text-decoration: underline;
        }
        .alert-expand {
          font-size: 1.1rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          padding: 0 4px;
        }
        .alert-details {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border-subtle);
        }
        .alert-details pre {
          margin: 0;
          padding: 10px 12px;
          background: var(--bg-deep);
          border: 1px solid var(--border-default);
          border-radius: var(--radius-sm);
          font-size: 0.72rem;
          color: var(--text-tertiary);
          overflow-x: auto;
        }
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="card metric" style={{ borderLeft: `2px solid ${color}` }}>
      <div className="metric-head">
        <span className="metric-icon" style={{ color }}>
          {icon}
        </span>
        <span className="metric-label">{label}</span>
      </div>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="sel"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minHeight: '32px', fontSize: '0.75rem' }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
