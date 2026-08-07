import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, History, Settings, Shield, ShieldAlert } from 'lucide-react';
import { Badge } from './ui';
import { fetchApprovalAuditLog, fetchApprovalConfig } from '../api';
import type {
  ApprovalAuditEntry,
  ApprovalSandboxMode,
  RiskLevel,
  UnifiedApprovalConfig,
} from '../api';
import { formatTimestamp } from '../types';

type BadgeVariant = 'success' | 'warning' | 'error' | 'info';

const MODE_LABELS: Record<ApprovalSandboxMode, string> = {
  suggest: 'Suggest',
  'auto-edit': 'Auto Edit',
  'full-auto': 'Full Auto',
  'read-only': 'Read Only',
  plan: 'Plan',
};

const LEVEL_VARIANTS: Record<string, BadgeVariant> = {
  auto: 'success',
  semi_auto: 'warning',
  manual: 'error',
};

const RISK_VARIANTS: Record<RiskLevel, BadgeVariant> = {
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

function riskVariantFor(level: string | undefined): BadgeVariant {
  return level && level in RISK_VARIANTS ? RISK_VARIANTS[level as RiskLevel] : 'info';
}

export function ApprovalConfigPanel() {
  const [config, setConfig] = useState<UnifiedApprovalConfig | null>(null);
  const [auditEntries, setAuditEntries] = useState<ApprovalAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [nextConfig, audit] = await Promise.all([
        fetchApprovalConfig(),
        fetchApprovalAuditLog(50),
      ]);
      setConfig(nextConfig);
      setAuditEntries(audit.entries);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load approval configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return <div className="empty">Loading approval configuration...</div>;
  }

  if (error || !config) {
    return (
      <div className="narrative narrative-red">
        <AlertTriangle size={14} /> {error ?? 'Failed to load approval configuration'}
      </div>
    );
  }

  return (
    <div className="approval-config-panel">
      <section className="approval-section">
        <div className="approval-subhead">
          <Shield size={14} />
          <h3>Sandbox Mode</h3>
        </div>
        <div className="sandbox-mode-grid">
          {(Object.keys(MODE_LABELS) as ApprovalSandboxMode[]).map((mode) => (
            <div
              key={mode}
              className={`sandbox-mode-card${config.sandboxMode === mode ? ' active' : ''}`}
            >
              <div className="sandbox-mode-card-head">
                <span className="sandbox-mode-label">{MODE_LABELS[mode]}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="narrative narrative-green" style={{ marginTop: 12 }}>
          <ShieldAlert size={14} />
          <strong>{config.sandboxMode}</strong>
          {config.failClosed && ' · Fail-closed'}
        </div>
      </section>

      <section className="approval-section">
        <div className="approval-subhead">
          <Settings size={14} />
          <h3>Tool Policies</h3>
          <span className="approval-hint">
            {config.toolPolicies.length} pattern(s) · {formatTimestamp(config.lastUpdated)}
          </span>
        </div>
        <div className="approval-table-wrap">
          <table className="approval-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Level</th>
                <th>Risk</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {config.toolPolicies.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No tool policies configured
                  </td>
                </tr>
              )}
              {config.toolPolicies.map((policy) => (
                <tr key={policy.pattern}>
                  <td>
                    <code>{policy.pattern}</code>
                  </td>
                  <td>
                    <Badge variant={LEVEL_VARIANTS[policy.level] ?? 'info'}>{policy.level}</Badge>
                  </td>
                  <td>
                    <Badge variant={RISK_VARIANTS[policy.riskLevel]}>{policy.riskLevel}</Badge>
                  </td>
                  <td className="approval-desc">{policy.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="approval-section">
        <div className="approval-subhead">
          <History size={14} />
          <h3>Approval Audit Log</h3>
          <span className="approval-hint">{auditEntries.length} decision(s)</span>
        </div>
        <div className="approval-table-wrap">
          <table className="approval-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Tool</th>
                <th>Decision</th>
                <th>Risk</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {auditEntries.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No approval decisions recorded
                  </td>
                </tr>
              )}
              {auditEntries.map((entry, index) => {
                const decision = (entry.decision ?? '').toLowerCase();
                const decisionVariant: BadgeVariant =
                  decision === 'approved' ? 'success' : decision === 'denied' ? 'error' : 'info';
                return (
                  <tr key={`${entry.timestamp}-${index}`}>
                    <td className="approval-time">{formatTimestamp(entry.timestamp)}</td>
                    <td>
                      <code>{entry.toolName ?? '—'}</code>
                    </td>
                    <td>
                      <Badge variant={decisionVariant}>
                        {entry.decision ?? entry.event ?? '—'}
                      </Badge>
                    </td>
                    <td>
                      {entry.riskLevel ? (
                        <Badge variant={riskVariantFor(entry.riskLevel)}>{entry.riskLevel}</Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="approval-reason">{entry.reason ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
