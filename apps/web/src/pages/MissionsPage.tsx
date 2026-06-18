import { MissionBoard } from '../components/MissionBoard';
import type { Mission, AgentWorkload } from '../types';

interface MissionsPageProps {
  missions: Mission[];
  agents: AgentWorkload[];
  agentNameById: Map<string, string>;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
  onCreateMission: (payload: any) => void;
}

export function MissionsPage({
  missions,
  agents,
  agentNameById,
  onStatusChange,
  onApprove,
  onCreateMission,
}: MissionsPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Operations</div>
          <h1>Mission Control</h1>
        </div>
        <p className="page-desc">
          Plan, dispatch, and track missions across all agents. Drag cards between lanes to update
          status.
        </p>
      </div>
      <MissionBoard
        missions={missions}
        agents={agents}
        agentNameById={agentNameById}
        onStatusChange={onStatusChange}
        onApprove={onApprove}
        onCreateMission={onCreateMission}
      />
    </div>
  );
}
