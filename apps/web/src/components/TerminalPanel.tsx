import { useEffect, useRef } from 'react';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface TerminalPanelProps {
  entries: LogEntry[];
  title?: string;
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'var(--accent-blue)',
  warn: 'var(--accent-amber)',
  error: 'var(--accent-red)',
  debug: 'var(--text-tertiary)',
};

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return ts;
  }
}

export function TerminalPanel({ entries, title = 'Terminal' }: TerminalPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div>
      <div className="section-head">
        <h2>{title}</h2>
        <span className="section-tag">{entries.length} lines</span>
      </div>
      <div className="card" style={{
        maxHeight: 400,
        overflowY: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        lineHeight: 1.5,
        padding: '8px 0',
      }}>
        {entries.length === 0 ? (
          <div style={{ padding: '10px 14px', color: 'var(--text-tertiary)' }}>No output yet</div>
        ) : (
          entries.map((entry, i) => {
            const color = LEVEL_COLORS[entry.level] || 'var(--text-secondary)';
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '2px 14px',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                }}
              >
                <span style={{ color: 'var(--text-muted)', flexShrink: 0, width: 70 }}>
                  {formatTime(entry.timestamp)}
                </span>
                <span style={{ color, flexShrink: 0, width: 50, textTransform: 'uppercase', fontWeight: 600 }}>
                  {entry.level}
                </span>
                <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                  {entry.message}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
