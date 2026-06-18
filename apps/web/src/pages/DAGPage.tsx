import { DAGVisualization } from '../components/DAGVisualization';
import type { Mission, AgentWorkload } from '../types';

interface DAGPageProps {
  missions: Mission[];
  agents: AgentWorkload[];
  agentNameById: Map<string, string>;
}

export function DAGPage({ missions, agents, agentNameById }: DAGPageProps) {
  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div>
          <div className="section-label">Visualization</div>
          <h1>Task Graph</h1>
        </div>
        <p className="page-desc">Real-time DAG of mission dependencies and agent assignments.</p>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid rgba(77, 158, 255, 0.15)',
        }}
      >
        <DAGVisualization missions={missions} agents={agents} agentNameById={agentNameById} />
      </div>
    </div>
  );
}
