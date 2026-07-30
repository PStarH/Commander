import { ExecutionFeed } from '../components/ExecutionFeed';
import type { ExecutionLog, Mission } from '../types';
import { Link } from 'react-router-dom';
import { SquareActivity } from 'lucide-react';

interface ExecutionPageProps {
  logs: ExecutionLog[];
  missions: Mission[];
  agentNameById: Map<string, string>;
}

export function ExecutionPage({ logs, missions, agentNameById }: ExecutionPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Telemetry</div>
          <h1>Execution Feed</h1>
        </div>
        <Link className="btn btn-secondary btn-md" to="/actions">
          <SquareActivity size={15} />
          Actions
        </Link>
      </div>
      <ExecutionFeed logs={logs} missions={missions} agentNameById={agentNameById} />
    </div>
  );
}
