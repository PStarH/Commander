/**
 * EvalPage — Plugin control + data plane for builtin-eval.
 *
 * Shows plugin status (registered/enabled), judge stats, dataset count,
 * and AB result count. Enable/disable toggle calls /api/eval/{enable,disable}.
 */
import { useState, useEffect, useCallback } from 'react';
import { FlaskConical, Power, PowerOff, RefreshCw } from 'lucide-react';
import { Badge, Button, MetricCard } from '../components/ui';
import { fetchEvalStatus, enableEvalPlugin, disableEvalPlugin, type PluginStatus } from '../api';

export function EvalPage() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchEvalStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async () => {
    if (!status) return;
    setToggling(true);
    try {
      if (status.enabled) {
        await disableEvalPlugin();
      } else {
        await enableEvalPlugin();
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const registered = status?.registered ?? false;
  const enabled = status?.enabled ?? false;
  const judgeStats =
    (status?.judgeStats as { totalRuns?: number; successCount?: number } | null) ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <FlaskConical size={20} /> Evaluation
        </h1>
        <p>LLM-as-Judge evaluation, dataset versioning, and A/B experiment comparison.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>builtin-eval</strong>
            {!registered && <Badge variant="error">Not Registered</Badge>}
            {registered && enabled && <Badge variant="success">Enabled</Badge>}
            {registered && !enabled && <Badge variant="warning">Disabled</Badge>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </Button>
            {registered && (
              <Button
                variant={enabled ? 'danger' : 'primary'}
                onClick={() => void handleToggle()}
                disabled={toggling}
              >
                {enabled ? <PowerOff size={14} /> : <Power size={14} />}
                {enabled ? 'Disable' : 'Enable'}
              </Button>
            )}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="metric-row">
          <MetricCard label="Judge Runs" value={String(judgeStats?.totalRuns ?? 0)} />
          <MetricCard label="Successes" value={String(judgeStats?.successCount ?? 0)} />
          <MetricCard label="Datasets" value={String(status?.datasetCount ?? 0)} />
          <MetricCard label="AB Results" value={String(status?.abResultCount ?? 0)} />
        </div>
      </div>

      <div className="card">
        <h3>About</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          This plugin provides LLM-as-Judge evaluation (5-dimension scoring with cost circuit
          breaker), dataset version management, and A/B experiment comparison using Wilcoxon
          signed-rank test. It is a development-time toolset — enable it when benchmarking agents,
          disable in production.
        </p>
      </div>
    </div>
  );
}
