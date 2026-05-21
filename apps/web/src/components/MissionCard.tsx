import { Card, Badge, Button } from './ui';
import type { Mission } from '../types';
import { formatTimestamp, nextMissionActions, isMissionHighRisk } from '../types';

interface MissionCardProps {
  mission: Mission;
  agentName?: string;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
}

const priorityColors: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  LOW: 'info',
  MEDIUM: 'success',
  HIGH: 'warning',
  CRITICAL: 'error',
};

const riskGovColors: Record<string, string> = {
  'LOW': 'rgba(126, 167, 191, 0.7)',
  'MEDIUM': 'rgba(255, 196, 92, 0.8)',
  'HIGH': 'rgba(255, 105, 120, 0.8)',
  'CRITICAL': 'rgba(255, 105, 120, 0.95)',
  'AUTO': 'rgba(77, 233, 140, 0.6)',
  'GUARDED': 'rgba(255, 196, 92, 0.7)',
  'MANUAL': 'rgba(255, 105, 120, 0.7)',
};

export function MissionCard({ mission, agentName, onStatusChange, onApprove }: MissionCardProps) {
  const highRisk = isMissionHighRisk(mission);
  const cardVariant = highRisk
    ? mission.riskLevel === 'CRITICAL' ? 'critical-risk' : 'high-risk'
    : 'default';

  return (
    <Card className="mission" variant={cardVariant}>
      <div className="mission-top">
        <Badge variant={priorityColors[mission.priority] || 'info'}>
          {mission.priority}
        </Badge>
        <span className="mission-time">{formatTimestamp(mission.updatedAt)}</span>
      </div>

      <div className="mission-gov">
        <span
          className="gov-pill"
          style={{
            borderColor: riskGovColors[mission.riskLevel] || '',
            color: riskGovColors[mission.riskLevel] || '',
          }}
        >
          {mission.riskLevel}
        </span>
        <span
          className="gov-pill"
          style={{
            borderColor: riskGovColors[mission.governanceMode] || '',
            color: riskGovColors[mission.governanceMode] || '',
          }}
        >
          {mission.governanceMode}
        </span>
      </div>

      <h3 className="mission-title">{mission.title}</h3>
      <p className="mission-obj">{mission.objective}</p>

      <div className="mission-foot">
        <span className="mission-agent">{agentName || mission.assignedAgentId}</span>
        <div className="mission-acts">
          {nextMissionActions(mission.status).map(next => (
            <Button
              key={next}
              size="sm"
              variant="ghost"
              onClick={() => {
                if (next === 'BLOCKED' && !window.confirm(`Block mission "${mission.title}"? This may pause the workflow.`)) {
                  return;
                }
                onStatusChange(mission.id, next);
              }}
            >
              {next}
            </Button>
          ))}
          {mission.governanceMode === 'MANUAL' && highRisk && mission.status !== 'DONE' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onApprove(mission.id)}
              className="approve-btn"
            >
              Approve
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
