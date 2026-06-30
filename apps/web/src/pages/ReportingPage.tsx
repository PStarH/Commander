/**
 * ReportingPage — Plugin control for builtin-reporting.
 *
 * Shows plugin status (registered/enabled) and provides enable/disable toggle.
 * The actual rendering is done via POST /api/reporting/render or the existing
 * POST /api/runtime/render-report endpoint.
 */
import { useState, useEffect, useCallback } from 'react';
import { FileText, Power, PowerOff, RefreshCw } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import {
  fetchReportingStatus,
  enableReportingPlugin,
  disableReportingPlugin,
  type PluginStatus,
} from '../api';

export function ReportingPage() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchReportingStatus());
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
        await disableReportingPlugin();
      } else {
        await enableReportingPlugin();
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

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <FileText size={20} /> Reporting
        </h1>
        <p>HTML report renderer for WarRoom and custom reports.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>builtin-reporting</strong>
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
      </div>

      <div className="card">
        <h3>About</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          This plugin provides HTML report rendering (WarRoom style). The renderer is also
          accessible via the existing <code>POST /api/runtime/render-report</code> endpoint.
          Enable this plugin to expose the <code>render_report</code> tool to agents.
        </p>
      </div>
    </div>
  );
}
