import { BattleReport } from '../components/BattleReport';
import { AgentRoster } from '../components/AgentRoster';
import { MissionBoard } from '../components/MissionBoard';
import { ExecutionFeed } from '../components/ExecutionFeed';
import { MemoryBrowser } from '../components/MemoryBrowser';
import { TokenTrendChart } from '../components/TokenTrendChart';
import { TopologyLiveView } from '../components/TopologyLiveView';
import type { WarRoomSnapshot, ProjectMemoryItem, MemoryOverview } from '../types';

// Static demo data for TokenTrendChart — replaced by live data when plumbing is ready
const TOKEN_DEMO_DATA = [
  { timestamp: '2026-06-16T00:00:00Z', label: '00:00', input: 42000, output: 18000, cache: 8000 },
  { timestamp: '2026-06-16T04:00:00Z', label: '04:00', input: 38000, output: 16000, cache: 7000 },
  { timestamp: '2026-06-16T08:00:00Z', label: '08:00', input: 62000, output: 24000, cache: 14000 },
  { timestamp: '2026-06-16T12:00:00Z', label: '12:00', input: 88000, output: 35000, cache: 25000 },
  { timestamp: '2026-06-16T16:00:00Z', label: '16:00', input: 104000, output: 44000, cache: 34000 },
  { timestamp: '2026-06-16T20:00:00Z', label: '20:00', input: 68000, output: 26000, cache: 18000 },
];

interface DashboardProps {
  snapshot: WarRoomSnapshot | null;
  memoryItems: ProjectMemoryItem[];
  memoryOverview: MemoryOverview | null;
  loading: boolean;
  agentNameById: Map<string, string>;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
  onCreateMission: (payload: any) => void;
  onCreateLog: (
    missionId: string,
    payload: { level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'; message: string },
  ) => void;
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

      <TokenTrendChart
        data={TOKEN_DEMO_DATA}
        series={['input', 'output', 'cache']}
        totalTokens={1420000}
        avgTokensPerInterval={59000}
        peakTokens={134000}
        title="Token Consumption"
      />

      <TopologyLiveView
        activeTopology="HYBRID"
        agentCount={snapshot.battleReport.activeAgents}
        runningCount={snapshot.battleReport.runningMissionCount}
        completedCount={snapshot.battleReport.completedMissionCount}
      />

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

      <MemoryBrowser items={memoryItems} overview={memoryOverview} onSearch={onSearchMemory} />
    </div>
  );
}
