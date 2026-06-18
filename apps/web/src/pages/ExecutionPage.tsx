import { ExecutionFeed } from '../components/ExecutionFeed';
import type { ExecutionLog, Mission } from '../types';

interface ExecutionPageProps {
  logs: ExecutionLog[];
  missions: Mission[];
  agentNameById: Map<string, string>;
  onCreateLog: (
    missionId: string,
    payload: { level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; message: string },
  ) => void;
}

export function ExecutionPage({ logs, missions, agentNameById, onCreateLog }: ExecutionPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Telemetry</div>
          <h1>Execution Feed</h1>
        </div>
        <p className="page-desc">Real-time operation logs from all active agents and missions.</p>
      </div>
      <ExecutionFeed
        logs={logs}
        missions={missions}
        agentNameById={agentNameById}
        onCreateLog={onCreateLog}
      />
    </div>
  );
}
