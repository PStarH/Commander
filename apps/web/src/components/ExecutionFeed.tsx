import { useState } from 'react';
import { Input, Select, Button } from './ui';
import type { ExecutionLog, Mission, LogLevel } from '../types';
import { LOG_LEVEL_OPTIONS, formatTimestamp } from '../types';

interface ExecutionFeedProps {
  logs: ExecutionLog[];
  missions: Mission[];
  agentNameById: Map<string, string>;
  onCreateLog: (missionId: string, payload: { level: LogLevel; message: string }) => void;
}

const logColors: Record<string, string> = {
  INFO: 'rgba(126, 167, 191, 0.8)',
  SUCCESS: '#4de98c',
  WARN: '#ffcc66',
  ERROR: '#ff8b9d',
};

const logBgColors: Record<string, string> = {
  INFO: 'rgba(11, 24, 34, 0.6)',
  SUCCESS: 'rgba(10, 40, 20, 0.4)',
  WARN: 'rgba(40, 30, 10, 0.4)',
  ERROR: 'rgba(40, 10, 16, 0.4)',
};

export function ExecutionFeed({ logs, missions, agentNameById, onCreateLog }: ExecutionFeedProps) {
  const [logMissionId, setLogMissionId] = useState(missions[0]?.id || '');
  const [logLevel, setLogLevel] = useState<LogLevel>('INFO');
  const [logMessage, setLogMessage] = useState('');
  const [filterLevel, setFilterLevel] = useState<string>('ALL');

  const filteredLogs = filterLevel === 'ALL'
    ? logs
    : logs.filter(l => l.level === filterLevel);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!logMissionId || !logMessage.trim()) return;
    onCreateLog(logMissionId, { level: logLevel, message: logMessage.trim() });
    setLogMessage('');
  };

  return (
    <div className="execution-feed">
      <div className="section-head">
        <div>
          <div className="section-label">Execution Feed</div>
          <h2>Latest operations</h2>
        </div>
        <Select value={filterLevel} onChange={e => setFilterLevel(e.target.value)}>
          <option value="ALL">All levels</option>
          {LOG_LEVEL_OPTIONS.map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </Select>
      </div>

      <form className="composer log-composer" onSubmit={handleSubmit}>
        <Select value={logMissionId} onChange={e => setLogMissionId(e.target.value)}>
          {missions.map(m => (
            <option key={m.id} value={m.id}>{m.title}</option>
          ))}
        </Select>
        <Select value={logLevel} onChange={e => setLogLevel(e.target.value as LogLevel)}>
          {LOG_LEVEL_OPTIONS.map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </Select>
        <Input
          value={logMessage}
          onChange={e => setLogMessage(e.target.value)}
          placeholder="Write a checkpoint log"
        />
        <Button type="submit">Append</Button>
      </form>

      <div className="log-timeline">
        {filteredLogs.length === 0 && (
          <div className="empty">No logs recorded yet</div>
        )}
        {filteredLogs.map((log, i) => {
          const prevDate = i > 0 ? new Date(filteredLogs[i - 1].createdAt).toDateString() : null;
          const currDate = new Date(log.createdAt).toDateString();
          const showDateSep = prevDate !== currDate;

          return (
            <div key={log.id}>
              {showDateSep && i > 0 && (
                <div className="log-date-sep">{currDate}</div>
              )}
              <div className="log-entry" style={{ borderLeftColor: logColors[log.level] || logColors.INFO }}>
                <div className="log-badge" style={{
                  background: logBgColors[log.level] || logBgColors.INFO,
                  color: logColors[log.level] || logColors.INFO,
                  borderColor: logColors[log.level] || logColors.INFO,
                }}>
                  {log.level}
                </div>
                <div className="log-content">
                  <p>{log.message}</p>
                  <div className="log-meta">
                    <span>{agentNameById.get(log.agentId) || log.agentId}</span>
                    <span>·</span>
                    <span>{missions.find(m => m.id === log.missionId)?.title || log.missionId}</span>
                    <span>·</span>
                    <span>{formatTimestamp(log.createdAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
