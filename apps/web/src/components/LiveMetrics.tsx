import { useEffect, useState, useRef, useCallback } from 'react';
import { Activity, Layers, Gauge, Cpu } from 'lucide-react';

interface MetricSnapshot {
  [name: string]: { value: number; help: string };
}

const METRIC_CONFIG: Record<string, { icon: typeof Activity; color: string }> = {
  active_runs: { icon: Activity, color: 'var(--accent-green)' },
  runtime_queue_depth: { icon: Layers, color: 'var(--accent-blue)' },
  event_loop_lag_ms: { icon: Gauge, color: 'var(--accent-amber)' },
  llm_calls_total: { icon: Cpu, color: 'var(--accent-purple)' },
};

const DEFAULT_CONFIG = { icon: Activity, color: 'var(--accent-blue)' };

interface MetricCardProps {
  name: string;
  value: number;
  help: string;
  icon: typeof Activity;
  color: string;
}

function MetricCard({ name, value, icon: Icon, color, help }: MetricCardProps) {
  const prev = useRef(value);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 300);
      return () => clearTimeout(t);
    }
  }, [value]);

  return (
    <div className={`metric-card${pulse ? ' metric-card--pulse' : ''}`} title={help}>
      <style>{`
        .metric-card--pulse {
          animation: metricPulse 0.3s ease-out;
        }
        @keyframes metricPulse {
          0% { box-shadow: 0 0 0 0 color-mix(in srgb, ${color} 40%, transparent); }
          100% { box-shadow: 0 0 16px 0 color-mix(in srgb, ${color} 0%, transparent); }
        }
      `}</style>
      <div className="metric-card-head">
        <span className="metric-card-icon" style={{ color }}>
          <Icon size={14} />
        </span>
        <span className="metric-card-label">{name.replace(/_/g, ' ')}</span>
      </div>
      <div className="metric-card-body">
        <span className="metric-card-value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      </div>
    </div>
  );
}

export function LiveMetrics() {
  const [snapshot, setSnapshot] = useState<MetricSnapshot>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closed = false;

    function connect() {
      if (closed) return;
      es = new EventSource('http://localhost:4000/api/metrics/stream');

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'snapshot' && data.metrics) {
            setSnapshot(data.metrics);
          }
        } catch { void 0; }
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  const entries = Object.entries(snapshot);
  if (entries.length === 0) {
    return (
      <div className="card" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <p>{connected ? 'No metrics yet' : 'Connecting to Commander Up...'}</p>
      </div>
    );
  }

  return (
    <div className="section-head" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h2>Live Metrics</h2>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          fontSize: '0.7rem', color: connected ? 'var(--accent-green)' : 'var(--accent-red)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connected ? 'var(--accent-green)' : 'var(--accent-red)',
            boxShadow: connected ? '0 0 6px var(--accent-green)' : 'none',
          }} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="metric-row">
        {entries.map(([name, metric]) => {
          const cfg = METRIC_CONFIG[name] || DEFAULT_CONFIG;
          return (
            <MetricCard
              key={name}
              name={name}
              value={metric.value}
              help={metric.help}
              icon={cfg.icon}
              color={cfg.color}
            />
          );
        })}
      </div>
    </div>
  );
}
