import { useState } from 'react';
import { X, Activity, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, ResponsiveContainer } from 'recharts';
import { Card, Badge, Button } from './ui';
import type { AgentWorkload } from '../types';
import { formatTimestamp } from '../types';

interface AgentCardProps {
  agent: AgentWorkload;
}

const statusConfig: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'info'; icon: typeof Activity }> = {
  READY: { label: 'Ready', color: 'success', icon: CheckCircle },
  RUNNING: { label: 'Running', color: 'info', icon: Activity },
  BLOCKED: { label: 'Blocked', color: 'warning', icon: AlertCircle },
  OFFLINE: { label: 'Offline', color: 'error', icon: Clock },
};

export function AgentCard({ agent }: AgentCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const cfg = statusConfig[agent.status] || statusConfig.READY;
  const StatusIcon = cfg.icon;

  return (
    <>
      <Card className={`agent-card status-${agent.status.toLowerCase()}`}>
        <button type="button" className="agent-card-click" onClick={() => setShowDetail(true)}>
          <div className="agent-head">
            <div className="agent-id">
              <div className="agent-status-ring">
                <StatusIcon size={14} />
              </div>
              <div>
                <h3>{agent.agentName}</h3>
                <p>{agent.callsign}</p>
              </div>
            </div>
            <Badge variant={cfg.color}>{cfg.label}</Badge>
          </div>

          <div className="agent-spec">{agent.specialty}</div>

          <div className="agent-stats">
            <span>
              <strong>{agent.assignedMissionCount}</strong> assigned
            </span>
            <span>
              <strong>{agent.activeMissionCount}</strong> active
            </span>
            <span>
              <strong>{agent.completedMissionCount}</strong> done
            </span>
          </div>
        </button>

        <div className="agent-foot">
          Last signal {agent.latestLogAt ? formatTimestamp(agent.latestLogAt) : 'No logs yet'}
        </div>
      </Card>

      {showDetail && (
        <div className="modal-overlay" onClick={() => setShowDetail(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{agent.agentName}</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowDetail(false)}>
                <X size={16} />
              </Button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-item">
                  <span>Status</span>
                  <Badge variant={cfg.color}>{cfg.label}</Badge>
                </div>
                <div className="detail-item">
                  <span>Callsign</span>
                  <strong>{agent.callsign}</strong>
                </div>
                <div className="detail-item">
                  <span>Specialty</span>
                  <strong>{agent.specialty}</strong>
                </div>
                <div className="detail-item">
                  <span>Assigned</span>
                  <strong>{agent.assignedMissionCount}</strong>
                </div>
                <div className="detail-item">
                  <span>Active</span>
                  <strong>{agent.activeMissionCount}</strong>
                </div>
                <div className="detail-item">
                  <span>Completed</span>
                  <strong>{agent.completedMissionCount}</strong>
                </div>
              </div>
              <div className="agent-perf-chart">
                <div className="chart-title">Workload</div>
                <ResponsiveContainer width="100%" height={100}>
                  <BarChart data={[
                    { name: 'Assigned', count: agent.assignedMissionCount },
                    { name: 'Active', count: agent.activeMissionCount },
                    { name: 'Completed', count: agent.completedMissionCount },
                  ]}>
                    <XAxis dataKey="name" tick={{ fill: '#7f8c86', fontSize: 10 }} />
                    <Bar dataKey="count" fill="#4de98c" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
