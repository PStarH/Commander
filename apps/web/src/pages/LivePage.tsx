import { LiveMetrics } from '../components/LiveMetrics';
import { TerminalPanel, type LogEntry } from '../components/TerminalPanel';
import { useState, useEffect, useRef } from 'react';

export function LivePage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:4000/api/logs/stream');
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'log' && data.entry) {
          setEntries((prev) => [...prev.slice(-500), data.entry]);
        }
      } catch {
        void 0;
      }
    };
    ws.onerror = () => {
      void 0;
    };
    return () => ws.close();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Live</h1>
        <p className="page-desc">Real-time metrics and execution output from Commander Up</p>
      </div>
      <LiveMetrics />
      <div style={{ marginTop: 20 }}>
        <TerminalPanel entries={entries} title="Execution Log" />
      </div>
    </div>
  );
}
