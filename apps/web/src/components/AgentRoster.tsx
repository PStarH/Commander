import { useEffect, useState } from 'react';
import { AgentCard } from './AgentCard';
import type { AgentWorkload } from '../types';

interface AgentRosterProps {
  agents: AgentWorkload[];
  runId?: string;
  pollMs?: number;
}

interface LiveAgentRow {
  agentId: string;
  claimed: number;
  completed: number;
  failed: number;
  pending: number;
  totalTokens: number;
  currentGoal?: string;
}

export function AgentRoster({ agents, runId, pollMs = 1500 }: AgentRosterProps) {
  const [live, setLive] = useState<LiveAgentRow[] | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useEffect(() => {
    if (!runId) {
      setLive(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/teams/${encodeURIComponent(runId)}/agents`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) {
          setLive(j.agents ?? []);
          setLastUpdate(Date.now());
        }
      } catch {
        if (!cancelled) setLastUpdate(Date.now());
      }
    };
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId, pollMs]);

  const merged: AgentWorkload[] = agents.map(a => {
    const row = live?.find(l => l.agentId === a.agentId);
    if (!row) return a;
    const active = row.claimed + row.pending;
    const nextStatus =
      row.failed > 0 && row.completed === 0 ? 'BLOCKED' as const :
      active > 0 ? 'RUNNING' as const :
      row.completed > 0 ? 'READY' as const :
      a.status;
    return {
      ...a,
      status: nextStatus,
      activeMissionCount: active,
      completedMissionCount: row.completed,
      assignedMissionCount: row.claimed + row.completed + row.failed + row.pending,
      specialty: row.currentGoal ? row.currentGoal.slice(0, 60) : a.specialty,
      latestLogAt: lastUpdate ? new Date(lastUpdate).toISOString() : a.latestLogAt,
    };
  });

  const fallbackAgents = live && agents.length === 0
    ? live.map(row => ({
        agentId: row.agentId,
        agentName: row.agentId,
        callsign: row.agentId.slice(-6),
        status: (row.claimed > 0 ? 'RUNNING' : row.failed > 0 ? 'BLOCKED' : 'READY') as AgentWorkload['status'],
        specialty: row.currentGoal?.slice(0, 60) ?? 'idle',
        assignedMissionCount: row.claimed + row.completed + row.failed + row.pending,
        activeMissionCount: row.claimed + row.pending,
        completedMissionCount: row.completed,
        latestLogAt: lastUpdate ? new Date(lastUpdate).toISOString() : undefined,
      }))
    : null;

  const display = fallbackAgents ?? merged;

  return (
    <div className="roster">
      <div className="section-head">
        <div>
          <div className="section-label">Roster</div>
          <h2>Agents</h2>
        </div>
        <span className="section-tag">
          {display.length} operators
          {runId && live && <span style={{ marginLeft: 8, opacity: 0.6 }}>· live</span>}
        </span>
      </div>

      <div className="agent-grid">
        {display.map(agent => (
          <AgentCard key={agent.agentId} agent={agent} />
        ))}
      </div>
    </div>
  );
}
