import { AgentRoster } from '../components/AgentRoster';
import type { AgentWorkload } from '../types';

interface AgentsPageProps {
  agents: AgentWorkload[];
}

export function AgentsPage({ agents }: AgentsPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Personnel</div>
          <h1>Agent Roster</h1>
        </div>
        <p className="page-desc">
          Monitor all deployed agents, their workloads, and real-time status.
        </p>
      </div>
      <AgentRoster agents={agents} />
    </div>
  );
}
