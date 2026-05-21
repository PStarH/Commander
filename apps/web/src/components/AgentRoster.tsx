import { AgentCard } from './AgentCard';
import type { AgentWorkload } from '../types';

interface AgentRosterProps {
  agents: AgentWorkload[];
}

export function AgentRoster({ agents }: AgentRosterProps) {
  return (
    <div className="roster">
      <div className="section-head">
        <div>
          <div className="section-label">Roster</div>
          <h2>Agents</h2>
        </div>
        <span className="section-tag">{agents.length} operators</span>
      </div>

      <div className="agent-grid">
        {agents.map(agent => (
          <AgentCard key={agent.agentId} agent={agent} />
        ))}
      </div>
    </div>
  );
}
