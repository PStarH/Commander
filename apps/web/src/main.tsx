import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

type AgentStatus = 'READY' | 'RUNNING' | 'BLOCKED' | 'OFFLINE';
type MissionStatus = 'PLANNED' | 'RUNNING' | 'BLOCKED' | 'DONE';
type MissionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type MissionRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type MissionGovernanceMode = 'AUTO' | 'GUARDED' | 'MANUAL';
type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

interface Project {
  id: string;
  name: string;
  codename: string;
  objective: string;
  status: 'ACTIVE' | 'AT_RISK' | 'STABILIZING';
  updatedAt: string;
}

interface AgentWorkload {
  agentId: string;
  agentName: string;
  callsign: string;
  status: AgentStatus;
  specialty: string;
  assignedMissionCount: number;
  activeMissionCount: number;
  completedMissionCount: number;
  latestLogAt?: string;
}

interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  governanceMode: MissionGovernanceMode;
  assignedAgentId: string;
  updatedAt: string;
}

function isMissionHighRisk(mission: Pick<Mission, 'riskLevel'>) {
  return mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
}

interface ExecutionLog {
  id: string;
  missionId: string;
  agentId: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

type ProjectMemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
type MemoryKindFilter = 'ALL' | ProjectMemoryKind;

interface ProjectMemoryItem {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: ProjectMemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

interface BattleReport {
  generatedAt: string;
  health: 'GREEN' | 'AMBER' | 'RED';
  totalAgents: number;
  activeAgents: number;
  totalMissions: number;
  runningMissionCount: number;
  blockedMissionCount: number;
  completedMissionCount: number;
  logVolume24h: number;
  completionRate: number;
  highRiskMissionCount: number;
  manualGovernanceMissionCount: number;
  topAgents: Array<{
    agentId: string;
    agentName: string;
    completedMissionCount: number;
  }>;
  narrative: string;
}

interface WarRoomSnapshot {
  project: Project;
  agents: AgentWorkload[];
  missions: Mission[];
  latestLogs: ExecutionLog[];
  battleReport: BattleReport;
}

interface MemoryOverview {
  totalItems: number;
  kindCounts: Record<ProjectMemoryKind, number>;
  topTags: Array<{
    tag: string;
    count: number;
  }>;
  missionLinkedCount: number;
  agentLinkedCount: number;
  latestCreatedAt?: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const PROJECT_ID = 'project-war-room';

const missionStatusOrder: MissionStatus[] = ['PLANNED', 'RUNNING', 'BLOCKED', 'DONE'];
const missionPriorityOptions: MissionPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const missionRiskOptions: MissionRiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const missionGovernanceOptions: MissionGovernanceMode[] = ['AUTO', 'GUARDED', 'MANUAL'];
const logLevelOptions: LogLevel[] = ['INFO', 'SUCCESS', 'WARN', 'ERROR'];
const memoryKindOptions: MemoryKindFilter[] = ['ALL', 'DECISION', 'ISSUE', 'LESSON', 'SUMMARY'];

function App() {
  const [snapshot, setSnapshot] = useState<WarRoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSavingMission, setIsSavingMission] = useState(false);
  const [isSavingLog, setIsSavingLog] = useState(false);
  const [memoryItems, setMemoryItems] = useState<ProjectMemoryItem[]>([]);
  const [memoryOverview, setMemoryOverview] = useState<MemoryOverview | null>(null);

  const [missionTitle, setMissionTitle] = useState('');
  const [missionObjective, setMissionObjective] = useState('');
  const [missionAgentId, setMissionAgentId] = useState('');
  const [missionPriority, setMissionPriority] = useState<MissionPriority>('HIGH');
  const [missionRiskLevel, setMissionRiskLevel] = useState<MissionRiskLevel>('MEDIUM');
  const [missionGovernanceMode, setMissionGovernanceMode] =
    useState<MissionGovernanceMode>('GUARDED');

  const [logMissionId, setLogMissionId] = useState('');
  const [logLevel, setLogLevel] = useState<LogLevel>('INFO');
  const [logMessage, setLogMessage] = useState('');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryKindFilter, setMemoryKindFilter] = useState<MemoryKindFilter>('ALL');
  const [memoryTagFilter, setMemoryTagFilter] = useState('');
  const [isSearchingMemory, setIsSearchingMemory] = useState(false);

  async function loadMemory(filters?: {
    query?: string;
    kind?: MemoryKindFilter;
    tags?: string;
  }) {
    const query = filters?.query ?? memoryQuery;
    const kind = filters?.kind ?? memoryKindFilter;
    const tags = filters?.tags ?? memoryTagFilter;

    const hasFilters = Boolean(query.trim() || tags.trim() || kind !== 'ALL');
    const url = new URL(
      hasFilters
        ? `${API_BASE}/projects/${PROJECT_ID}/memory/search`
        : `${API_BASE}/projects/${PROJECT_ID}/memory`
    );

    if (hasFilters) {
      if (query.trim()) {
        url.searchParams.set('q', query.trim());
      }
      if (tags.trim()) {
        url.searchParams.set('tags', tags.trim());
      }
      if (kind !== 'ALL') {
        url.searchParams.set('kind', kind);
      }
    }

    url.searchParams.set('limit', '24');

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(await readError(response, 'Failed to load memory'));
    }

    const memoryData = (await response.json()) as ProjectMemoryItem[];
    setMemoryItems(memoryData);
  }

  async function loadSnapshot() {
    try {
      setLoading(true);
      setError(null);
      const [snapshotResponse, memoryResponse, memoryOverviewResponse] = await Promise.all([
        fetch(`${API_BASE}/projects/${PROJECT_ID}/war-room`),
        fetch(`${API_BASE}/projects/${PROJECT_ID}/memory?limit=24`),
        fetch(`${API_BASE}/projects/${PROJECT_ID}/memory/overview`),
      ]);

      if (!snapshotResponse.ok) {
        throw new Error('Failed to load war room snapshot');
      }

      const snapshotData = (await snapshotResponse.json()) as WarRoomSnapshot;
      setSnapshot(snapshotData);
      setMissionAgentId(currentAgentId => currentAgentId || snapshotData.agents[0]?.agentId || '');
      setLogMissionId(currentMissionId => currentMissionId || snapshotData.missions[0]?.id || '');

      if (memoryResponse.ok) {
        const memoryData = (await memoryResponse.json()) as ProjectMemoryItem[];
        setMemoryItems(memoryData);
      }

      if (memoryOverviewResponse.ok) {
        const overview = (await memoryOverviewResponse.json()) as MemoryOverview;
        setMemoryOverview(overview);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSnapshot();

    const timer = window.setInterval(() => {
      loadSnapshot();
    }, 12000);

    return () => window.clearInterval(timer);
  }, []);

  async function handleMemorySearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setIsSearchingMemory(true);
      setError(null);
      await loadMemory();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    } finally {
      setIsSearchingMemory(false);
    }
  }

  async function handleClearMemoryFilters() {
    try {
      setIsSearchingMemory(true);
      setError(null);
      setMemoryQuery('');
      setMemoryKindFilter('ALL');
      setMemoryTagFilter('');
      await loadMemory({ query: '', kind: 'ALL', tags: '' });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    } finally {
      setIsSearchingMemory(false);
    }
  }

  const missionsByStatus = new Map<MissionStatus, Mission[]>();
  for (const status of missionStatusOrder) {
    missionsByStatus.set(status, []);
  }

  for (const mission of snapshot?.missions ?? []) {
    missionsByStatus.get(mission.status)?.push(mission);
  }

  const agentNameById = new Map(
    (snapshot?.agents ?? []).map(agent => [agent.agentId, agent.agentName])
  );

  async function handleCreateMission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!missionTitle.trim() || !missionAgentId) {
      return;
    }

    try {
      setIsSavingMission(true);
      setError(null);

      const response = await fetch(`${API_BASE}/projects/${PROJECT_ID}/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: missionTitle.trim(),
          objective: missionObjective.trim(),
          assignedAgentId: missionAgentId,
          priority: missionPriority,
          riskLevel: missionRiskLevel,
          governanceMode: missionGovernanceMode,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, 'Failed to create mission'));
      }

      setMissionTitle('');
      setMissionObjective('');
      setMissionRiskLevel('MEDIUM');
      setMissionGovernanceMode('GUARDED');
      await loadSnapshot();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    } finally {
      setIsSavingMission(false);
    }
  }

  async function handleMissionStatusChange(missionId: string, status: MissionStatus) {
    try {
      setError(null);
      const response = await fetch(`${API_BASE}/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        const message = await readError(response, 'Failed to update mission');
        // 治理拦截：MANUAL + 高风险任务需要通过审批流完成
        if (response.status === 409 && message.includes('requires approval')) {
          setError('该任务在 MANUAL 治理模式下，完成前需要在指挥台中走审批流。');
          return;
        }

        throw new Error(message);
      }

      await loadSnapshot();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    }
  }

  async function handleApproveMission(missionId: string) {
    try {
      setError(null);
      const response = await fetch(`${API_BASE}/missions/${missionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(await readError(response, 'Failed to approve mission'));
      }

      await loadSnapshot();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    }
  }

  async function handleCreateLog(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!logMissionId || !logMessage.trim()) {
      return;
    }

    try {
      setIsSavingLog(true);
      setError(null);
      const response = await fetch(`${API_BASE}/missions/${logMissionId}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level: logLevel,
          message: logMessage.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, 'Failed to write log'));
      }

      setLogMessage('');
      await loadSnapshot();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unknown error');
    } finally {
      setIsSavingLog(false);
    }
  }

  return (
    <div className="shell">
      <div className="bg-orb bg-orb-left" />
      <div className="bg-orb bg-orb-right" />

      <header className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Commander v0</span>
          <h1>Agent War Room</h1>
          <p>
            {snapshot?.project.objective ||
              'Coordinate AI agents like teammates, keep missions moving, and turn execution into a readable battle report.'}
          </p>
        </div>

        <div className="hero-card">
          <div className="hero-card-top">
            <div>
              <div className="hero-label">Operation</div>
              <div className="hero-title">
                {snapshot?.project.codename || 'Loading operation'}
              </div>
            </div>
            <span className={`health health-${snapshot?.battleReport.health || 'AMBER'}`}>
              {snapshot?.battleReport.health || 'AMBER'}
            </span>
          </div>
          <div className="hero-meta">
            <div>
              <span>Status</span>
              <strong>{snapshot?.project.status || '...'}</strong>
            </div>
            <div>
              <span>Last sync</span>
              <strong>{snapshot ? formatTimestamp(snapshot.project.updatedAt) : '...'}</strong>
            </div>
          </div>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {loading && !snapshot && <div className="banner">Loading war room snapshot...</div>}

      {snapshot && (
        <main className="grid">
          <section className="panel summary-panel">
            <div className="panel-heading">
              <div>
                <div className="section-label">Battle Report</div>
                <h2>Project pulse</h2>
              </div>
              <span className="section-tag">
                Generated {formatTimestamp(snapshot.battleReport.generatedAt)}
              </span>
            </div>

            <div className="metric-grid">
              <MetricCard
                label="Agents online"
                value={`${snapshot.battleReport.activeAgents}/${snapshot.battleReport.totalAgents}`}
              />
              <MetricCard
                label="Missions complete"
                value={`${snapshot.battleReport.completedMissionCount}/${snapshot.battleReport.totalMissions}`}
              />
              <MetricCard
                label="Running now"
                value={String(snapshot.battleReport.runningMissionCount)}
              />
              <MetricCard
                label="Logs / 24h"
                value={String(snapshot.battleReport.logVolume24h)}
              />
              <MetricCard
                label="高风险任务"
                value={String(snapshot.battleReport.highRiskMissionCount)}
              />
              <MetricCard
                label="需人工审批"
                value={String(snapshot.battleReport.manualGovernanceMissionCount)}
              />
            </div>

            <p className="narrative">{snapshot.battleReport.narrative}</p>

            <div className="leaderboard">
              <div className="section-label">Top agents</div>
              {snapshot.battleReport.topAgents.length === 0 && (
                <div className="empty-state">No completed missions yet.</div>
              )}
              {snapshot.battleReport.topAgents.map(agent => (
                <div className="leaderboard-row" key={agent.agentId}>
                  <span>{agent.agentName}</span>
                  <strong>{agent.completedMissionCount} complete</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="section-label">Roster</div>
                <h2>Agents</h2>
              </div>
              <span className="section-tag">{snapshot.agents.length} operators</span>
            </div>

            <div className="agent-grid">
              {snapshot.agents.map(agent => (
                <article className="agent-card" key={agent.agentId}>
                  <div className="agent-header">
                    <div>
                      <h3>{agent.agentName}</h3>
                      <p>{agent.callsign}</p>
                    </div>
                    <span className={`status-chip status-${agent.status.toLowerCase()}`}>
                      {agent.status}
                    </span>
                  </div>
                  <div className="agent-role">{agent.specialty}</div>
                  <div className="agent-stats">
                    <span>{agent.assignedMissionCount} assigned</span>
                    <span>{agent.activeMissionCount} active</span>
                    <span>{agent.completedMissionCount} done</span>
                  </div>
                  <div className="agent-footer">
                    Last signal {agent.latestLogAt ? formatTimestamp(agent.latestLogAt) : 'No logs yet'}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel mission-panel">
            <div className="panel-heading">
              <div>
                <div className="section-label">Command Deck</div>
                <h2>Missions</h2>
              </div>
              <span className="section-tag">{snapshot.missions.length} tracked</span>
            </div>

            <form className="composer" onSubmit={handleCreateMission}>
              <input
                value={missionTitle}
                onChange={event => setMissionTitle(event.target.value)}
                placeholder="Mission title"
              />
              <input
                value={missionObjective}
                onChange={event => setMissionObjective(event.target.value)}
                placeholder="Objective"
              />
              <select
                value={missionAgentId}
                onChange={event => setMissionAgentId(event.target.value)}
              >
                {snapshot.agents.map(agent => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.agentName}
                  </option>
                ))}
              </select>
              <select
                value={missionPriority}
                onChange={event => setMissionPriority(event.target.value as MissionPriority)}
              >
                {missionPriorityOptions.map(priority => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
              <select
                value={missionRiskLevel}
                onChange={event => setMissionRiskLevel(event.target.value as MissionRiskLevel)}
              >
                {missionRiskOptions.map(level => (
                  <option key={level} value={level}>
                    risk: {level}
                  </option>
                ))}
              </select>
              <select
                value={missionGovernanceMode}
                onChange={event =>
                  setMissionGovernanceMode(event.target.value as MissionGovernanceMode)
                }
              >
                {missionGovernanceOptions.map(mode => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={isSavingMission}>
                {isSavingMission ? 'Dispatching...' : 'Create mission'}
              </button>
            </form>

            <div className="mission-columns">
              {missionStatusOrder.map(status => (
                <div className="mission-column" key={status}>
                  <div className="mission-column-header">
                    <span>{status}</span>
                    <strong>{missionsByStatus.get(status)?.length || 0}</strong>
                  </div>

                  <div className="mission-list">
                    {(missionsByStatus.get(status) || []).map(mission => (
                      <article
                        className={`mission-card ${
                          isMissionHighRisk(mission)
                            ? mission.riskLevel === 'CRITICAL'
                              ? 'mission-card-critical-risk'
                              : 'mission-card-high-risk'
                            : ''
                        }`}
                        key={mission.id}
                      >
                        <div className="mission-topline">
                          <span className={`priority priority-${mission.priority.toLowerCase()}`}>
                            {mission.priority}
                          </span>
                          <span className="mission-time">{formatTimestamp(mission.updatedAt)}</span>
                        </div>

                        <div className="mission-governance">
                          <span
                            className={`badge badge-risk-${mission.riskLevel.toLowerCase()} badge-gov-${mission.governanceMode.toLowerCase()}`}
                            title="riskLevel | governanceMode"
                          >
                            {mission.riskLevel} | {mission.governanceMode}
                          </span>
                        </div>
                        <h3>{mission.title}</h3>
                        <p>{mission.objective}</p>
                        <div className="mission-footer">
                          <span>{agentNameById.get(mission.assignedAgentId) || mission.assignedAgentId}</span>
                          <div className="mission-actions">
                            {nextMissionActions(mission.status).map(nextStatus => (
                              <button
                                key={nextStatus}
                                type="button"
                                onClick={() => handleMissionStatusChange(mission.id, nextStatus)}
                              >
                                {nextStatus}
                              </button>
                            ))}
                            {mission.governanceMode === 'MANUAL' &&
                              (mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL') &&
                              mission.status !== 'DONE' && (
                                <button
                                  type="button"
                                  className="mission-approve-button"
                                  onClick={() => handleApproveMission(mission.id)}
                                >
                                  Approve
                                </button>
                              )}
                          </div>
                        </div>
                      </article>
                    ))}

                    {(missionsByStatus.get(status)?.length || 0) === 0 && (
                      <div className="empty-state">No missions in this lane.</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel log-panel">
            <div className="panel-heading">
              <div>
                <div className="section-label">Execution Feed</div>
                <h2>Latest logs</h2>
              </div>
              <span className="section-tag">{snapshot.latestLogs.length} visible</span>
            </div>

            <section className="panel" style={{ marginTop: 12 }}>
              <div className="panel-heading">
                <div>
                  <div className="section-label">Memory</div>
                  <h2>Recent lessons</h2>
                </div>
                <span className="section-tag">{memoryItems.length} items</span>
              </div>

              {memoryOverview && (
                <div className="memory-overview">
                  <div className="memory-overview-grid">
                    <div className="memory-overview-card">
                      <span>Total</span>
                      <strong>{memoryOverview.totalItems}</strong>
                    </div>
                    <div className="memory-overview-card">
                      <span>Lessons</span>
                      <strong>{memoryOverview.kindCounts.LESSON}</strong>
                    </div>
                    <div className="memory-overview-card">
                      <span>Decisions</span>
                      <strong>{memoryOverview.kindCounts.DECISION}</strong>
                    </div>
                    <div className="memory-overview-card">
                      <span>Issues</span>
                      <strong>{memoryOverview.kindCounts.ISSUE}</strong>
                    </div>
                  </div>
                  {memoryOverview.topTags.length > 0 && (
                    <div className="memory-top-tags">
                      {memoryOverview.topTags.map(item => (
                        <span key={item.tag} className="memory-tag-chip">
                          {item.tag} · {item.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <form className="memory-search" onSubmit={handleMemorySearch}>
                <input
                  value={memoryQuery}
                  onChange={event => setMemoryQuery(event.target.value)}
                  placeholder="Search memory content"
                />
                <select
                  value={memoryKindFilter}
                  onChange={event => setMemoryKindFilter(event.target.value as MemoryKindFilter)}
                >
                  {memoryKindOptions.map(kind => (
                    <option key={kind} value={kind}>
                      {kind === 'ALL' ? 'all kinds' : kind}
                    </option>
                  ))}
                </select>
                <input
                  value={memoryTagFilter}
                  onChange={event => setMemoryTagFilter(event.target.value)}
                  placeholder="tags: governance, frontend"
                />
                <button type="submit" disabled={isSearchingMemory}>
                  {isSearchingMemory ? 'Searching...' : 'Search'}
                </button>
                <button
                  type="button"
                  className="memory-clear-button"
                  onClick={handleClearMemoryFilters}
                  disabled={isSearchingMemory}
                >
                  Clear
                </button>
              </form>

              <div className="memory-list">
                {memoryItems.length === 0 && (
                  <div className="empty-state">No distilled memories yet.</div>
                )}

                {memoryItems.map(item => (
                  <article key={item.id} className="memory-item">
                    <div className="memory-item-header">
                      <span className="memory-item-title">{item.title}</span>
                      <span className={`memory-kind-pill memory-kind-${item.kind}`}>
                        {item.kind}
                      </span>
                    </div>
                    <div className="memory-item-body">{item.content}</div>
                    <div className="memory-item-meta">
                      <span>{formatTimestamp(item.createdAt)}</span>
                      {item.tags.length > 0 && <span>tags: {item.tags.join(', ')}</span>}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <form className="composer log-composer" onSubmit={handleCreateLog}>
              <select value={logMissionId} onChange={event => setLogMissionId(event.target.value)}>
                {snapshot.missions.map(mission => (
                  <option key={mission.id} value={mission.id}>
                    {mission.title}
                  </option>
                ))}
              </select>
              <select value={logLevel} onChange={event => setLogLevel(event.target.value as LogLevel)}>
                {logLevelOptions.map(level => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
              <input
                value={logMessage}
                onChange={event => setLogMessage(event.target.value)}
                placeholder="Write a checkpoint log"
              />
              <button type="submit" disabled={isSavingLog}>
                {isSavingLog ? 'Writing...' : 'Append log'}
              </button>
            </form>

            <div className="log-list">
              {snapshot.latestLogs.map(log => (
                <article className="log-card" key={log.id}>
                  <div className="log-topline">
                    <span className={`log-pill log-${log.level.toLowerCase()}`}>{log.level}</span>
                    <span>{formatTimestamp(log.createdAt)}</span>
                  </div>
                  <p>{log.message}</p>
                  <div className="log-meta">
                    <span>{agentNameById.get(log.agentId) || log.agentId}</span>
                    <span>{snapshot.missions.find(mission => mission.id === log.missionId)?.title || log.missionId}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function nextMissionActions(status: MissionStatus): MissionStatus[] {
  switch (status) {
    case 'PLANNED':
      return ['RUNNING', 'BLOCKED'];
    case 'RUNNING':
      return ['DONE', 'BLOCKED'];
    case 'BLOCKED':
      return ['RUNNING', 'DONE'];
    case 'DONE':
      return [];
    default:
      return [];
  }
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function readError(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
