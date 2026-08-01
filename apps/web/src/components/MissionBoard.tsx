import { useState } from 'react';
import { MissionCard } from './MissionCard';
import { Select } from './ui';
import type { Mission, MissionStatus } from '../types';
import { MISSION_STATUS_ORDER } from '../types';

interface MissionBoardProps {
  missions: Mission[];
  agentNameById: Map<string, string>;
}

function DroppableColumn({
  status,
  children,
}: {
  status: MissionStatus;
  children: React.ReactNode;
}) {
  return (
    <div className="mission-col" data-status={status}>
      {children}
    </div>
  );
}

export function MissionBoard({ missions, agentNameById }: MissionBoardProps) {
  const [filterPriority, setFilterPriority] = useState('ALL');

  const filteredMissions =
    filterPriority === 'ALL' ? missions : missions.filter((m) => m.priority === filterPriority);

  const missionsByStatus = new Map<MissionStatus, Mission[]>();
  for (const status of MISSION_STATUS_ORDER) {
    missionsByStatus.set(status, []);
  }
  for (const mission of filteredMissions) {
    missionsByStatus.get(mission.status)?.push(mission);
  }

  return (
    <div className="mission-board">
      <div className="section-head">
        <div>
          <div className="section-label">Command Deck</div>
          <h2>Missions</h2>
        </div>
        <div className="section-acts">
          <Select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
            <option value="ALL">All priorities</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </Select>
        </div>
      </div>
      <div className="mission-cols">
        {MISSION_STATUS_ORDER.map((status) => {
          const statusMissions = missionsByStatus.get(status) || [];
          return (
            <DroppableColumn key={status} status={status}>
              <div className="mission-col-head">
                <span>{status}</span>
                <strong>{statusMissions.length}</strong>
              </div>
              <div className="mission-list">
                {statusMissions.map((mission) => (
                  <MissionCard
                    key={mission.id}
                    mission={mission}
                    agentName={agentNameById.get(mission.assignedAgentId)}
                  />
                ))}
                {statusMissions.length === 0 && (
                  <div className="empty">No missions in this lane</div>
                )}
              </div>
            </DroppableColumn>
          );
        })}
      </div>
    </div>
  );
}
