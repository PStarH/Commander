import { BattleReport } from '../components/BattleReport';
import { AgentRoster } from '../components/AgentRoster';
import { MissionBoard } from '../components/MissionBoard';
import { ExecutionFeed } from '../components/ExecutionFeed';
import { MemoryBrowser } from '../components/MemoryBrowser';
import type { WarRoomSnapshot, ProjectMemoryItem, MemoryOverview } from '../types';

interface DashboardProps {
  snapshot: WarRoomSnapshot | null;
  memoryItems: ProjectMemoryItem[];
  memoryOverview: MemoryOverview | null;
  loading: boolean;
  agentNameById: Map<string, string>;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
  onCreateMission: (payload: any) => void;
  onCreateLog: (missionId: string, payload: { level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; message: string }) => void;
  onSearchMemory: (filters?: any) => void;
}

export function Dashboard({
  snapshot,
  memoryItems,
  memoryOverview,
  agentNameById,
  onStatusChange,
  onApprove,
  onCreateMission,
  onCreateLog,
  onSearchMemory,
}: DashboardProps) {
  if (!snapshot) return null;

  return (
    <div className="dashboard-grid">
      <BattleReport report={snapshot.battleReport} />

      <AgentRoster agents={snapshot.agents} />

      <MissionBoard
        missions={snapshot.missions}
        agents={snapshot.agents}
        agentNameById={agentNameById}
        onStatusChange={onStatusChange}
        onApprove={onApprove}
        onCreateMission={onCreateMission}
      />

      <ExecutionFeed
        logs={snapshot.latestLogs}
        missions={snapshot.missions}
        agentNameById={agentNameById}
        onCreateLog={onCreateLog}
      />

      <MemoryBrowser
        items={memoryItems}
        overview={memoryOverview}
        onSearch={onSearchMemory}
      />
    </div>
  );
}
