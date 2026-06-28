import { Shield, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { Card, Badge, Button, MetricCard } from '../components/ui';
import { ApprovalConfigPanel } from '../components/ApprovalConfigPanel';
import type { Mission, BattleReport } from '../types';
import { formatTimestamp, isMissionHighRisk } from '../types';

interface GovernancePageProps {
  missions: Mission[];
  battleReport: BattleReport | null;
  onApprove: (missionId: string) => void;
  onStatusChange: (missionId: string, status: string) => void;
}

export function GovernancePage({
  missions,
  battleReport,
  onApprove,
  onStatusChange,
}: GovernancePageProps) {
  const manualMissions = missions.filter((m) => m.governanceMode === 'MANUAL');
  const highRiskMissions = missions.filter((m) => isMissionHighRisk(m));
  const pendingApproval = missions.filter(
    (m) => m.governanceMode === 'MANUAL' && isMissionHighRisk(m) && m.status !== 'DONE',
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Oversight</div>
          <h1>Governance</h1>
        </div>
        <p className="page-desc">
          Risk monitoring, approval flows, and compliance for mission execution.
        </p>
      </div>

      <div className="metric-row">
        <MetricCard
          label="Manual missions"
          value={String(manualMissions.length)}
          icon={<Shield size={14} />}
        />
        <MetricCard
          label="High risk"
          value={String(highRiskMissions.length)}
          icon={<AlertTriangle size={14} />}
        />
        <MetricCard
          label="Pending approval"
          value={String(pendingApproval.length)}
          icon={<Clock size={14} />}
        />
        <MetricCard
          label="Health"
          value={battleReport?.health || '---'}
          icon={<CheckCircle size={14} />}
        />
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>Pending Approvals</h2>
      </div>

      {pendingApproval.length === 0 && (
        <div className="empty">No missions require approval at this time</div>
      )}

      <div className="gov-queue">
        {pendingApproval.map((mission) => (
          <Card key={mission.id} variant="high-risk" className="gov-card">
            <div className="gov-card-top">
              <div>
                <h3>{mission.title}</h3>
                <p>{mission.objective}</p>
              </div>
              <Badge variant="warning">MANUAL</Badge>
            </div>
            <div className="gov-card-meta">
              <span>
                Risk: <strong>{mission.riskLevel}</strong>
              </span>
              <span>Updated: {formatTimestamp(mission.updatedAt)}</span>
            </div>
            <div className="gov-card-acts">
              <Button variant="primary" onClick={() => onApprove(mission.id)}>
                <CheckCircle size={14} />
                Approve
              </Button>
              <Button variant="ghost" onClick={() => onStatusChange(mission.id, 'BLOCKED')}>
                Block
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>Governance Rules</h2>
      </div>

      <div className="gov-rules">
        <Card className="gov-rule">
          <Badge variant="success">AUTO</Badge>
          <div>
            <strong>Autonomous</strong>
            <p>Agents execute without human intervention. All state transitions are automatic.</p>
          </div>
        </Card>
        <Card className="gov-rule">
          <Badge variant="warning">GUARDED</Badge>
          <div>
            <strong>Guarded</strong>
            <p>Standard missions auto-execute. High-risk missions trigger an alert but proceed.</p>
          </div>
        </Card>
        <Card className="gov-rule">
          <Badge variant="error">MANUAL</Badge>
          <div>
            <strong>Manual</strong>
            <p>
              All state transitions require explicit approval. High-risk missions block until
              approved.
            </p>
          </div>
        </Card>
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>Approval Configuration</h2>
      </div>

      <ApprovalConfigPanel />
    </div>
  );
}
