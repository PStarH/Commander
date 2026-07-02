import { useEffect, useState } from 'react';
import { BattleReport } from '../components/BattleReport';
import { AgentRoster } from '../components/AgentRoster';
import { MissionBoard } from '../components/MissionBoard';
import { ExecutionFeed } from '../components/ExecutionFeed';
import { MemoryBrowser } from '../components/MemoryBrowser';
import { TokenTrendChart } from '../components/TokenTrendChart';
import { TopologyLiveView, type TopologyType } from '../components/TopologyLiveView';
import type { WarRoomSnapshot, ProjectMemoryItem, MemoryOverview } from '../types';
import { fetchCostDashboard, type TrendPoint } from '../api';

/**
 * Derive the currently active topology from the live snapshot rather than
 * hardcoding "HYBRID". The War Room snapshot does not carry an explicit
 * topology field, so we infer it from agent/mission state:
 *   - 0 or 1 active agents → SINGLE
 *   - multiple agents with running missions → HYBRID (mixed parallel work)
 *   - multiple agents but none running → SEQUENTIAL
 */
function deriveTopology(snapshot: WarRoomSnapshot): TopologyType {
  const active = snapshot.battleReport.activeAgents;
  const running = snapshot.battleReport.runningMissionCount;
  if (active <= 1) return 'SINGLE';
  if (running > 0) return 'HYBRID';
  return 'SEQUENTIAL';
}

/** Map a real cost-dashboard trend point into the chart's data shape. */
function toChartData(point: TrendPoint): {
  timestamp: string;
  label: string;
  tokens: number;
} {
  const d = new Date(point.timestamp);
  const label = isNaN(d.getTime())
    ? point.timestamp
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return { timestamp: point.timestamp, label, tokens: point.tokens };
}

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
  const [tokenTrend, setTokenTrend] = useState<TrendPoint[]>([]);

  // Fetch real token-consumption trend from the cost dashboard API.
  // Replaces the previous hardcoded TOKEN_DEMO_DATA.
  useEffect(() => {
    let cancelled = false;
    fetchCostDashboard('7d')
      .then((resp) => {
        if (!cancelled) setTokenTrend(resp.trend ?? []);
      })
      .catch(() => {
        // Cost data is best-effort — leave empty so the chart shows an
        // honest empty state instead of fabricated demo numbers.
        if (!cancelled) setTokenTrend([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot) return null;

  const chartData = tokenTrend.map(toChartData);
  const totalTokens = chartData.reduce((sum, p) => sum + p.tokens, 0);
  const peakTokens = chartData.reduce((max, p) => Math.max(max, p.tokens), 0);
  const avgTokensPerInterval =
    chartData.length > 0 ? Math.round(totalTokens / chartData.length) : 0;

  return (
    <div className="dashboard-grid">
      <BattleReport report={snapshot.battleReport} />

      <TokenTrendChart
        data={chartData}
        series={['tokens']}
        totalTokens={totalTokens}
        avgTokensPerInterval={avgTokensPerInterval}
        peakTokens={peakTokens}
        title="Token Consumption"
      />

      <TopologyLiveView
        activeTopology={deriveTopology(snapshot)}
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
