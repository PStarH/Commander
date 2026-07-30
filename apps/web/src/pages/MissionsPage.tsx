import { MissionBoard } from '../components/MissionBoard';
import type { Mission } from '../types';

interface MissionsPageProps {
  missions: Mission[];
  agentNameById: Map<string, string>;
}

export function MissionsPage({ missions, agentNameById }: MissionsPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Operations</div>
          <h1>Mission Control</h1>
        </div>
        <p className="page-desc">Track projected mission state across all agents.</p>
      </div>
      <MissionBoard missions={missions} agentNameById={agentNameById} />
    </div>
  );
}
