import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  useDroppable,
  useSensor,
  useSensors,
  PointerSensor,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { MissionCard } from './MissionCard';
import { Input, Select, Button } from './ui';
import type { Mission, AgentWorkload, MissionStatus } from '../types';
import { MISSION_STATUS_ORDER } from '../types';

interface MissionBoardProps {
  missions: Mission[];
  agents: AgentWorkload[];
  agentNameById: Map<string, string>;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
  onCreateMission: (payload: {
    title: string;
    objective: string;
    assignedAgentId: string;
    priority: string;
    riskLevel: string;
    governanceMode: string;
  }) => void;
}

interface SortableMissionProps {
  mission: Mission;
  agentName?: string;
  onStatusChange: (missionId: string, status: string) => void;
  onApprove: (missionId: string) => void;
}

function DroppableColumn({
  status,
  children,
}: {
  status: MissionStatus;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${status}` });
  return (
    <div ref={setNodeRef} className={`mission-col ${isOver ? 'mission-col-over' : ''}`}>
      {children}
    </div>
  );
}

function SortableMission({ mission, agentName, onStatusChange, onApprove }: SortableMissionProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mission.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <MissionCard
        mission={mission}
        agentName={agentName}
        onStatusChange={onStatusChange}
        onApprove={onApprove}
      />
    </div>
  );
}

export function MissionBoard({
  missions,
  agents,
  agentNameById,
  onStatusChange,
  onApprove,
  onCreateMission,
}: MissionBoardProps) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.agentId || '');
  const [filterPriority, setFilterPriority] = useState('ALL');

  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const filteredMissions =
    filterPriority === 'ALL' ? missions : missions.filter((m) => m.priority === filterPriority);

  const missionsByStatus = new Map<MissionStatus, Mission[]>();
  for (const status of MISSION_STATUS_ORDER) {
    missionsByStatus.set(status, []);
  }
  for (const mission of filteredMissions) {
    missionsByStatus.get(mission.status)?.push(mission);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const mission = missions.find((m) => m.id === active.id);
    if (!mission) return;

    if (typeof over.id === 'string' && over.id.startsWith('col-')) {
      const targetStatus = over.id.replace('col-', '') as MissionStatus;
      if (mission.status !== targetStatus) {
        onStatusChange(mission.id, targetStatus);
      }
      return;
    }

    const overMission = missions.find((m) => m.id === over.id);
    if (!overMission) return;

    if (mission.status !== overMission.status) {
      onStatusChange(mission.id, overMission.status);
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !agentId) return;
    onCreateMission({
      title: title.trim(),
      objective: objective.trim(),
      assignedAgentId: agentId,
      priority: 'HIGH',
      riskLevel: 'MEDIUM',
      governanceMode: 'GUARDED',
    });
    setTitle('');
    setObjective('');
    setShowForm(false);
  };

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
          <Button onClick={() => setShowForm(!showForm)}>
            <Plus size={14} />
            <span>New Mission</span>
          </Button>
        </div>
      </div>

      {showForm && (
        <form className="composer" onSubmit={handleSubmit}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Mission title"
            required
          />
          <Input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Objective"
          />
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentName}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary">
            Create
          </Button>
        </form>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="mission-cols">
          {MISSION_STATUS_ORDER.map((status) => {
            const statusMissions = missionsByStatus.get(status) || [];
            return (
              <DroppableColumn key={status} status={status}>
                <div className="mission-col-head">
                  <span>{status}</span>
                  <strong>{statusMissions.length}</strong>
                </div>
                <SortableContext
                  items={statusMissions.map((m) => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="mission-list">
                    {statusMissions.map((mission) => (
                      <SortableMission
                        key={mission.id}
                        mission={mission}
                        agentName={agentNameById.get(mission.assignedAgentId)}
                        onStatusChange={onStatusChange}
                        onApprove={onApprove}
                      />
                    ))}
                    {statusMissions.length === 0 && (
                      <div className="empty">No missions in this lane</div>
                    )}
                  </div>
                </SortableContext>
              </DroppableColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeId ? (
            <div className="drag-overlay">
              <MissionCard
                mission={missions.find((m) => m.id === activeId)!}
                agentName={agentNameById.get(
                  missions.find((m) => m.id === activeId)!.assignedAgentId,
                )}
                onStatusChange={onStatusChange}
                onApprove={onApprove}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
