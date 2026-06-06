import { useState, useEffect, useCallback } from 'react';
import { Pause, Play, RefreshCw, Send } from 'lucide-react';
import { Button, Badge } from './ui';
import { fetchActiveRuns, pauseRun, resumeRun } from '../api';
import type { ActiveRun } from '../types';

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
};

export function PauseResumeControls() {
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [resumeInput, setResumeInput] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const data = await fetchActiveRuns();
      setRuns(data.runs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadRuns();
    const interval = setInterval(loadRuns, 5000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  async function handlePause(runId: string) {
    setActionLoading(prev => ({ ...prev, [runId]: true }));
    try {
      const result = await pauseRun(runId);
      setMessage({ type: 'success', text: result.message });
      await loadRuns();
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    }
    setActionLoading(prev => ({ ...prev, [runId]: false }));
  }

  async function handleResume(runId: string) {
    setActionLoading(prev => ({ ...prev, [runId]: true }));
    try {
      const instructions = resumeInput[runId] || undefined;
      const result = await resumeRun(runId, instructions);
      setMessage({ type: 'success', text: result.message });
      setResumeInput(prev => ({ ...prev, [runId]: '' }));
      await loadRuns();
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    }
    setActionLoading(prev => ({ ...prev, [runId]: false }));
  }

  // Auto-dismiss messages
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  if (runs.length === 0) return null;

  return (
    <div className="pause-controls">
      <div className="pause-header">
        <RefreshCw size={14} className={loading ? 'spinning' : ''} />
        <span className="section-label">Active Runs</span>
        <span className="run-count">{runs.length}</span>
      </div>

      {message && (
        <div className={`pause-message ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="pause-run-list">
        {runs.map(run => (
          <div key={run.runId} className="pause-run-item">
            <div className="pause-run-info">
              <span className="pause-run-id">{run.runId.slice(0, 16)}</span>
              <Badge variant={run.paused ? 'warning' : 'success'}>
                {run.paused ? 'PAUSED' : 'RUNNING'}
              </Badge>
            </div>

            <div className="pause-run-actions">
              {!run.paused ? (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handlePause(run.runId)}
                  disabled={actionLoading[run.runId]}
                >
                  <Pause size={12} />
                  Pause
                </Button>
              ) : (
                <div className="resume-form">
                  <input
                    className="inp"
                    placeholder="Optional instructions for resume..."
                    value={resumeInput[run.runId] || ''}
                    onChange={(e) => setResumeInput(prev => ({ ...prev, [run.runId]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleResume(run.runId); }}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleResume(run.runId)}
                    disabled={actionLoading[run.runId]}
                  >
                    <Play size={12} />
                    Resume
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
