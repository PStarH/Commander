import express from 'express';
import {
  LogLevel,
  MissionPriority,
  MissionStatus,
  MissionRiskLevel,
  MissionGovernanceMode,
  ProjectMemoryKind,
  CommanderRunContextV2,
  CommanderRunMeta,
  CommanderAgentCard,
  CommanderRunIntent,
  createSlimSnapshot,
  getDefaultInvocationProfile,
  recommendStrategy,
  HallucinationDetector,
} from '@commander/core';
import { WarRoomStore } from './store';
import { ProjectMemoryStore } from './memoryStore';
import { AgentStateStore } from './agentStateStore';
import { contentScanner, ScanResult } from './contentScanner';
import { MemoryIndexManager, DEFAULT_DOMAINS } from './memoryIndexManager';
import { EpisodicMemoryStore, EpisodicMemory, EpisodicMemorySearchOptions } from './episodicMemoryStore';
import { calculateGovernanceStats, generateGovernanceAlerts, generateWeeklyGovernanceReport } from './governanceObserver';
import {
  proactiveConflictCheck,
  reactiveConflictMonitor,
  formatConflictSummary,
  Conflict,
  Agent as ConflictAgent,
  ProposedAction,
} from './conflictDetection';
import { ActionRationaleStore, CreateActionRationaleInput, MissionExplainabilityReport } from './actionRationale';
import { ConfidenceReporter, ConfidenceReport, ConfidenceAlert, DEFAULT_THRESHOLDS } from './confidenceReporter';
import { DeterministicTaskAllocator, getTaskAllocator, TaskAllocation, AllocationRequest, AllocationResult, ReleaseRequest, ReleaseResult, TaskQueueStatus } from './deterministicTaskAllocator';

const PROJECT_ID = 'project-war-room';
const app = express();
const store = new WarRoomStore();
const memoryStore = new ProjectMemoryStore();
const agentStateStore = new AgentStateStore();
const memoryIndexManager = new MemoryIndexManager(PROJECT_ID);
const episodicMemoryStore = new EpisodicMemoryStore();
const actionRationaleStore = new ActionRationaleStore();
const confidenceReporter = new ConfidenceReporter(actionRationaleStore);
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, projectId: PROJECT_ID });
});

app.get('/system/status', (_req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime),
    memory: {
      rss: Math.floor(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.floor(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.floor(memUsage.heapTotal / 1024 / 1024) + 'MB',
    },
    modules: {
      core: 'loaded',
      warRoom: store ? 'active' : 'inactive',
      memoryStore: memoryStore ? 'active' : 'inactive',
      agentStateStore: agentStateStore ? 'active' : 'inactive',
      episodicMemoryStore: episodicMemoryStore ? 'active' : 'inactive',
      memoryIndexManager: memoryIndexManager ? 'active' : 'inactive',
      confidenceReporter: confidenceReporter ? 'active' : 'inactive',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/projects', (_req, res) => {
  res.json(store.listProjects());
});

app.get('/projects/:projectId/agents', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json(store.listAgents(req.params.projectId));
});

app.get('/projects/:projectId/agents/:agentId/state', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const agent = snapshot.agents.find(agent => agent.agentId === req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const state = agentStateStore.get(req.params.projectId, req.params.agentId);
  if (!state) {
    return res.status(404).json({ error: 'Agent state not found' });
  }

  res.json(state);
});

app.patch('/projects/:projectId/agents/:agentId/state', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const agent = snapshot.agents.find(agent => agent.agentId === req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { summary, preferences, tags } = req.body as {
    summary?: string;
    preferences?: string;
    tags?: string[];
  };

  try {
    const state = agentStateStore.upsert({
      projectId: req.params.projectId,
      agentId: req.params.agentId,
      summary,
      preferences,
      tags,
    });

    res.json(state);
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.get('/projects/:projectId/war-room', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json(snapshot);
});

app.get('/projects/:projectId/run-context', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { agentId, missionId, memoryLimit, intent, runId, issuedByKind, issuedById, issuedByLabel } =
    req.query as {
      agentId?: string;
      missionId?: string;
      memoryLimit?: string;
      intent?: CommanderRunIntent;
      runId?: string;
      issuedByKind?: 'HUMAN' | 'AGENT' | 'SYSTEM';
      issuedById?: string;
      issuedByLabel?: string;
    };

  const limit = memoryLimit ? Number(memoryLimit) : 12;

  const memoryItems = memoryStore.search(req.params.projectId, {
    limit,
  });

  // v1 推荐记忆策略：
  // - 优先选择与当前 mission 相关的 SUMMARY / LESSON / DECISION；
  // - 如无 missionId 或未命中 mission-scoped 记忆，则退化为最近的若干条记忆。
  const recommendedMemorySelection = (() => {
    if (!missionId) {
      return {
        items: memoryItems,
        sourceTags: ['recent'] as string[],
      };
    }

    const lowerLimit = Math.min(limit, 12);
    const missionScoped = memoryStore.search(req.params.projectId, {
      limit: lowerLimit,
      kind: undefined,
    }).filter(item => item.missionId === missionId);

    if (missionScoped.length > 0) {
      return {
        items: missionScoped,
        sourceTags: ['mission-scoped'] as string[],
      };
    }

    return {
      items: memoryItems,
      sourceTags: ['recent'] as string[],
    };
  })();
  const recommendedItems = recommendedMemorySelection.items;

  const now = new Date().toISOString();

  const runMeta: CommanderRunMeta = {
    runId: runId || `${req.params.projectId}-${now}`,
    issuedAt: now,
    issuedBy: issuedByKind
      ? {
          kind: issuedByKind,
          id: issuedById,
          label: issuedByLabel,
        }
      : undefined,
  };

  const slimSnapshot = createSlimSnapshot(snapshot, {
    focusMissionId: missionId,
    maxMissionsPerBucket: 6,
    maxLogs: 8,
  });

  const roster: CommanderAgentCard[] = snapshot.agents.map(agent => ({
    id: agent.agentId,
    projectId: req.params.projectId,
    name: agent.agentName,
    callsign: agent.callsign,
    status: agent.status,
    specialty: agent.specialty,
    governanceRole: (() => {
      const fullAgent = store.listAgents(req.params.projectId).find(a => a.id === agent.agentId);
      return fullAgent?.governanceRole ?? 'EXECUTOR';
    })(),
  }));

  const focusMission = missionId
    ? slimSnapshot.focusMission?.id === missionId
      ? slimSnapshot.focusMission
      : [
          ...slimSnapshot.missionBoard.running,
          ...slimSnapshot.missionBoard.blocked,
          ...slimSnapshot.missionBoard.planned,
          ...slimSnapshot.missionBoard.done,
        ].find(mission => mission.id === missionId)
    : undefined;

  const effectiveIntent = intent || 'EXECUTE';
  const focusAgent = (agentId ? roster.find(agent => agent.id === agentId) : undefined) ??
    (focusMission ? roster.find(agent => agent.id === focusMission.assignedAgentId) : undefined);

  const guidance = focusAgent
    ? {
        invocationProfile: getDefaultInvocationProfile({
          agent: focusAgent,
          mission: focusMission,
          intent: effectiveIntent,
        }),
        strategy: recommendStrategy({
          projectId: req.params.projectId,
          run: runMeta,
          focus: {
            agentId,
            missionId,
            intent: effectiveIntent,
          },
          slimSnapshot,
          recentMemory: memoryItems,
          recommendedMemory: {
            items: recommendedItems,
            sourceTags: recommendedMemorySelection.sourceTags,
          },
          guidance: undefined,
          agentRoster: roster,
        }),
      }
    : undefined;

  const context: CommanderRunContextV2 = {
    projectId: req.params.projectId,
    run: runMeta,
    focus: {
      agentId,
      missionId,
      intent: effectiveIntent,
    },
    slimSnapshot,
    recentMemory: memoryItems,
    recommendedMemory: {
      items: recommendedItems,
      sourceTags: recommendedMemorySelection.sourceTags,
    },
    guidance,
    agentRoster: roster,
  };

  res.json(context);
});

app.get('/projects/:projectId/memory', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const limit = req.query.limit ? Number(req.query.limit) : 24;
  const items = memoryStore.list(req.params.projectId, limit);
  res.json(items);
});

app.get('/projects/:projectId/memory/overview', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json(memoryStore.overview(req.params.projectId));
});

app.get('/projects/:projectId/memory/search', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { kind, tags, q, limit } = req.query as {
    kind?: string;
    tags?: string;
    q?: string;
    limit?: string;
  };

  const parsedKind = kind && isProjectMemoryKind(kind) ? kind : undefined;
  const parsedTags = tags
    ? tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    : undefined;
  const query = q?.trim() || undefined;
  const parsedLimit = limit ? Number(limit) : undefined;

  const items = memoryStore.search(req.params.projectId, {
    kind: parsedKind,
    tags: parsedTags,
    query,
    limit: parsedLimit,
  });

  res.json(items);
});

app.post('/projects/:projectId/missions', (req, res) => {
  const { title, objective, assignedAgentId, priority, riskLevel, governanceMode } = req.body as {
    title?: string;
    objective?: string;
    assignedAgentId?: string;
    priority?: MissionPriority;
    riskLevel?: MissionRiskLevel;
    governanceMode?: MissionGovernanceMode;
  };

  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (!assignedAgentId?.trim()) {
    return res.status(400).json({ error: 'assignedAgentId is required' });
  }

  const nextPriority = priority ?? 'MEDIUM';
  if (!isMissionPriority(nextPriority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }

  const nextRiskLevel = riskLevel && isMissionRiskLevel(riskLevel) ? riskLevel : undefined;
  const nextGovernanceMode =
    governanceMode && isMissionGovernanceMode(governanceMode) ? governanceMode : undefined;

  try {
    const mission = store.createMission({
      projectId: req.params.projectId,
      title: title.trim(),
      objective: objective?.trim() || 'No objective provided yet.',
      assignedAgentId: assignedAgentId.trim(),
      priority: nextPriority,
      riskLevel: nextRiskLevel,
      governanceMode: nextGovernanceMode,
    });

    res.status(201).json(mission);
  } catch (error) {
    res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
  }
});

app.patch('/missions/:missionId', (req, res) => {
  const { status, priority, assignedAgentId, title, objective, riskLevel, governanceMode } = req.body as {
    status?: MissionStatus;
    priority?: MissionPriority;
    assignedAgentId?: string;
    title?: string;
    objective?: string;
    riskLevel?: MissionRiskLevel;
    governanceMode?: MissionGovernanceMode;
  };

  if (status && !isMissionStatus(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  if (priority && !isMissionPriority(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }

  if (riskLevel && !isMissionRiskLevel(riskLevel)) {
    return res.status(400).json({ error: 'Invalid riskLevel' });
  }

  if (governanceMode && !isMissionGovernanceMode(governanceMode)) {
    return res.status(400).json({ error: 'Invalid governanceMode' });
  }

  try {
    const mission = store.updateMission(req.params.missionId, {
      status,
      priority,
      assignedAgentId: assignedAgentId?.trim(),
      title: title?.trim(),
      objective: objective?.trim(),
      riskLevel,
      governanceMode,
    });

    if (mission.status === 'DONE') {
      try {
        const existingSummary = memoryStore
          .list(mission.projectId, 100)
          .find(item => item.missionId === mission.id && item.kind === 'SUMMARY');

        if (!existingSummary) {
          memoryStore.append({
            projectId: mission.projectId,
            missionId: mission.id,
            agentId: mission.assignedAgentId,
            kind: 'SUMMARY',
            title: `任务完成：${mission.title}`,
            content: `任务「${mission.title}」已完成（优先级 ${mission.priority}，风险等级 ${mission.riskLevel}，治理模式 ${mission.governanceMode}）。目标：${mission.objective}`,
            tags: ['mission', 'done', mission.priority.toLowerCase(), mission.riskLevel.toLowerCase()],
          });
        }
      } catch {
      }
    }

    res.json(mission);
  } catch (error) {
    res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
  }
});

app.post('/projects/:projectId/memory', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { title, content, kind, missionId, agentId, tags } = req.body as {
    title?: string;
    content?: string;
    kind?: ProjectMemoryKind;
    missionId?: string;
    agentId?: string;
    tags?: string[];
  };

  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (!content?.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  const memoryKind: ProjectMemoryKind = isProjectMemoryKind(kind || 'SUMMARY') ? (kind || 'SUMMARY') : 'SUMMARY';
  const safeTags = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
    : [];

  try {
    const item = memoryStore.append({
      projectId: req.params.projectId,
      missionId,
      agentId,
      kind: memoryKind,
      title: title.trim(),
      content: content.trim(),
      tags: safeTags,
    });

    res.status(201).json(item);
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.post('/missions/:missionId/logs', (req, res) => {
  const { message, level } = req.body as {
    message?: string;
    level?: LogLevel;
  };

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const nextLevel = level ?? 'INFO';
  if (!isLogLevel(nextLevel)) {
    return res.status(400).json({ error: 'Invalid log level' });
  }

  try {
    const log = store.createLog({
      missionId: req.params.missionId,
      message: message.trim(),
      level: nextLevel,
    });

    res.status(201).json(log);
  } catch (error) {
    res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
  }
});

// ========================================
// Governance API (v1)
// ========================================

app.get('/projects/:projectId/governance/stats', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const stats = calculateGovernanceStats(snapshot.missions, snapshot.agents);
  res.json(stats);
});

app.get('/projects/:projectId/governance/alerts', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const stats = calculateGovernanceStats(snapshot.missions, snapshot.agents);
  const alerts = generateGovernanceAlerts(stats);
  res.json(alerts);
});

app.get('/projects/:projectId/governance/weekly-report', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const stats = calculateGovernanceStats(snapshot.missions, snapshot.agents);
  const alerts = generateGovernanceAlerts(stats);
  const report = generateWeeklyGovernanceReport(stats, alerts);
  res.type('text/markdown').send(report);
});

// ========================================
// Memory Index API (Claude Code Layer 2)
// ========================================

app.get('/projects/:projectId/memory-index/domains', (_req, res) => {
  const domains = memoryIndexManager.listDomains();
  res.json(domains);
});

app.post('/projects/:projectId/memory-index/domains', (req, res) => {
  const { domain, description } = req.body as { domain?: string; description?: string };
  if (!domain?.trim()) {
    return res.status(400).json({ error: 'domain is required' });
  }
  const pointer = memoryIndexManager.addDomain(domain.trim(), description?.trim() || '');
  res.status(201).json(pointer);
});

app.get('/projects/:projectId/memory-index/domains/:domain', (req, res) => {
  const domainMemory = memoryIndexManager.readDomain(req.params.domain);
  if (!domainMemory) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  res.json(domainMemory);
});

app.post('/projects/:projectId/memory-index/domains/:domain/entries', (req, res) => {
  const { type, title, content, tags } = req.body as {
    type?: string;
    title?: string;
    content?: string;
    tags?: string[];
  };
  if (!type || !title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'type, title, and content are required' });
  }
  const entry = memoryIndexManager.writeEntry(req.params.domain, {
    type: type as 'decision' | 'context' | 'pattern' | 'preference' | 'issue' | 'lesson',
    title: title.trim(),
    content: content.trim(),
    tags: tags ?? [],
  });
  if (!entry) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  res.status(201).json(entry);
});

app.post('/projects/:projectId/memory-index/reconcile', (_req, res) => {
  const result = memoryIndexManager.reconcile();
  res.json({ reconciled: true, ...result });
});

// Initialize default memory domains on startup
DEFAULT_DOMAINS.forEach(({ domain, description }) => {
  try {
    memoryIndexManager.addDomain(domain, description);
  } catch {
    // Domain already exists
  }
});

// ========================================
// Conflict Detection API
// ========================================

app.post('/projects/:projectId/conflict-detection/proactive', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { agentId, proposedAction } = req.body as {
    agentId: string;
    proposedAction: ProposedAction;
  };

  if (!agentId || !proposedAction) {
    return res.status(400).json({ error: 'agentId and proposedAction are required' });
  }

  const agent = snapshot.agents.find(a => a.agentId === agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const conflictAgent: ConflictAgent = {
    id: agent.agentId,
    name: agent.agentName,
    role: agent.status,
    specialties: agent.specialty ? [agent.specialty] : undefined,
    currentTaskId: snapshot.missions.find(m => m.assignedAgentId === agentId)?.id,
  };

  const otherAgents: ConflictAgent[] = snapshot.agents
    .filter(a => a.agentId !== agentId)
    .map(a => ({
      id: a.agentId,
      name: a.agentName,
      role: a.status,
      specialties: a.specialty ? [a.specialty] : undefined,
    }));

  const result = proactiveConflictCheck(conflictAgent, proposedAction, {
    otherAgents,
    activeMissions: snapshot.missions.map(m => ({
      id: m.id,
      assignedAgentId: m.assignedAgentId,
      priority: m.priority,
    })),
    governanceMode: snapshot.missions.find(m => m.assignedAgentId === agentId)?.governanceMode as 'AUTO' | 'GUARDED' | 'MANUAL' | undefined,
  });

  res.json(result);
});

app.post('/projects/:projectId/conflict-detection/reactive', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { recentActions } = req.body as {
    recentActions?: ProposedAction[];
  };

  if (!recentActions || !Array.isArray(recentActions)) {
    return res.status(400).json({ error: 'recentActions array is required' });
  }

  const agents: ConflictAgent[] = snapshot.agents.map(a => ({
    id: a.agentId,
    name: a.agentName,
    role: a.status,
    specialties: a.specialty ? [a.specialty] : undefined,
  }));

  const conflicts = reactiveConflictMonitor(agents, recentActions);

  res.json({
    conflicts,
    summary: conflicts.map(formatConflictSummary),
  });
});

app.get('/projects/:projectId/conflict-detection/summary', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }

  // Generate a summary of potential conflict hotspots based on current state
  const agentWorkloads = new Map<string, number>();
  for (const mission of snapshot.missions) {
    if (mission.status === 'RUNNING' || mission.status === 'PLANNED') {
      const count = agentWorkloads.get(mission.assignedAgentId) || 0;
      agentWorkloads.set(mission.assignedAgentId, count + 1);
    }
  }

  const potentialConflicts: Array<{ type: string; description: string; severity: string }> = [];

  // Check for overloaded agents
  for (const [agentId, count] of agentWorkloads) {
    if (count > 3) {
      potentialConflicts.push({
        type: 'RESOURCE',
        description: `Agent ${agentId} has ${count} active missions - potential bottleneck`,
        severity: count > 5 ? 'high' : 'medium',
      });
    }
  }

  // Check for mission priority conflicts
  const highPriorityMissions = snapshot.missions.filter(m => m.priority === 'HIGH' || m.priority === 'CRITICAL');
  if (highPriorityMissions.length > 3) {
    potentialConflicts.push({
      type: 'GOAL',
      description: `${highPriorityMissions.length} high/critical priority missions - resource contention likely`,
      severity: 'medium',
    });
  }

  // Check for governance mode distribution
  const manualMissions = snapshot.missions.filter(m => m.governanceMode === 'MANUAL' && m.status === 'RUNNING');
  if (manualMissions.length > 2) {
    potentialConflicts.push({
      type: 'POLICY',
      description: `${manualMissions.length} MANUAL governance missions running - approval bottleneck risk`,
      severity: 'low',
    });
  }

  res.json({
    agentWorkloads: Object.fromEntries(agentWorkloads),
    potentialConflicts,
    recommendations: potentialConflicts.length > 0
      ? ['Consider redistributing workload among agents', 'Review mission priorities', 'Evaluate governance mode settings']
      : ['No immediate conflict risks detected'],
  });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`War room project ready at GET /projects/${PROJECT_ID}/war-room`);
});

function isMissionStatus(value: string): value is MissionStatus {
  return ['PLANNED', 'RUNNING', 'BLOCKED', 'DONE'].includes(value);
}

function isMissionPriority(value: string): value is MissionPriority {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value);
}

function isMissionRiskLevel(value: string): value is MissionRiskLevel {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value);
}

function isMissionGovernanceMode(value: string): value is MissionGovernanceMode {
  return ['AUTO', 'GUARDED', 'MANUAL'].includes(value);
}

function isProjectMemoryKind(value: string): value is ProjectMemoryKind {
  return ['DECISION', 'ISSUE', 'LESSON', 'SUMMARY'].includes(value);
}

function isLogLevel(value: string): value is LogLevel {
  return ['INFO', 'SUCCESS', 'WARN', 'ERROR'].includes(value);
}

function mapErrorToStatusCode(error: unknown) {
  const message = toErrorMessage(error);
  if (message === 'Project not found' || message === 'Mission not found' || message === 'Agent not found') {
    return 404;
  }

  if (message === 'MISSION_REQUIRES_APPROVAL') {
    return 409;
  }

  return 400;
}

function toErrorMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return 'Unknown error';
  }

  switch (error.message) {
    case 'PROJECT_NOT_FOUND':
      return 'Project not found';
    case 'MISSION_NOT_FOUND':
      return 'Mission not found';
    case 'AGENT_NOT_FOUND':
      return 'Agent not found';
    case 'MISSION_REQUIRES_APPROVAL':
      return 'Mission requires approval before completion';
    default:
      return error.message;
  }
}

// Content Scanner Endpoints
app.post('/api/security/scan', async (req, res) => {
  try {
    const { content, contentType } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const result: ScanResult = await contentScanner.scan(
      content,
      contentType || 'text'
    );
    
    res.json({
      safe: result.safe,
      threats: result.threats,
      sanitizedContent: result.sanitizedContent,
      confidence: result.confidence,
      summary: result.safe 
        ? 'Content passed security scan'
        : `Found ${result.threats.length} potential threat(s)`
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

app.post('/api/security/scan/:contentType', async (req, res) => {
  try {
    const { contentType } = req.params;
    const { content } = req.body;
    
    if (!['html', 'markdown', 'text', 'json'].includes(contentType)) {
      return res.status(400).json({ 
        error: 'Invalid contentType. Must be one of: html, markdown, text, json' 
      });
    }
    
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const result: ScanResult = await contentScanner.scan(content, contentType as any);
    
    res.json({
      safe: result.safe,
      threats: result.threats,
      sanitizedContent: result.sanitizedContent,
      confidence: result.confidence,
      contentType,
      scannedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: toErrorMessage(error) });
  }
});

app.get('/api/security/stats', (_req, res) => {
  res.json({
    service: 'ContentScanner',
    version: '1.0.0',
    threatTypes: [
      'hidden_html',
      'hidden_css',
      'metadata_injection',
      'prompt_injection',
      'javascript_url',
      'data_url',
      'svg_injection',
      'unicode_obfuscation'
    ],
    supportedContentTypes: ['html', 'markdown', 'text', 'json'],
    description: 'Agent Security Content Scanner based on arXiv:2510.23883v2'
  });
});

// ========================================
// Confidence Reporter API (Explainability)
// ========================================

// Get confidence report for a mission
app.get('/projects/:projectId/missions/:missionId/confidence', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const mission = snapshot.missions.find(m => m.id === req.params.missionId);
  if (!mission) {
    return res.status(404).json({ error: 'Mission not found' });
  }
  const report: ConfidenceReport = confidenceReporter.generateMissionReport(req.params.missionId);
  res.json(report);
});

// Get confidence report for an agent
app.get('/projects/:projectId/agents/:agentId/confidence', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const agent = snapshot.agents.find(a => a.agentId === req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const { missionId } = req.query;
  const report: ConfidenceReport = confidenceReporter.generateAgentReport(
    req.params.projectId,
    req.params.agentId,
    missionId as string | undefined
  );
  res.json(report);
});

// Get confidence alerts for a mission
app.get('/projects/:projectId/missions/:missionId/confidence/alerts', (req, res) => {
  const snapshot = store.getProjectSnapshot(req.params.projectId);
  if (!snapshot) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const mission = snapshot.missions.find(m => m.id === req.params.missionId);
  if (!mission) {
    return res.status(404).json({ error: 'Mission not found' });
  }
  const alerts: ConfidenceAlert[] = confidenceReporter.checkForAlerts(req.params.missionId);
  res.json({
    missionId: req.params.missionId,
    alertCount: alerts.length,
    thresholds: DEFAULT_THRESHOLDS,
    alerts,
  });
});

// Get confidence thresholds configuration
app.get('/api/confidence/thresholds', (_req, res) => {
  res.json({
    thresholds: DEFAULT_THRESHOLDS,
    description: {
      low: 'Below this threshold = critical alert, requires immediate review',
      warning: 'Below this threshold = warning, may need validation',
      target: 'Target confidence level for optimal decisions',
    },
  });
});

// ============================================================================
// Hallucination Detection API
// ============================================================================

const hallucinationDetector = new HallucinationDetector();

app.post('/api/quality/hallucination-check', (req, res) => {
  const { input, output } = req.body;
  if (!input || !output) {
    return res.status(400).json({ error: 'Both input and output are required' });
  }
  const report = hallucinationDetector.analyze(
    typeof input === 'string' ? input : JSON.stringify(input),
    typeof output === 'string' ? output : JSON.stringify(output),
  );
  res.json(report);
});

app.get('/api/quality/hallucination-check/info', (_req, res) => {
  res.json({
    signals: [
      'overconfidence',
      'unsupported_specificity',
      'fabricated_reference',
      'temporal_impossibility',
      'inconsistency',
      'numeric_anomaly',
    ],
    thresholds: {
      pass: 'riskScore < 0.3',
      flag_for_review: '0.3 <= riskScore < 0.6',
      reject: 'riskScore >= 0.6',
    },
  });
});

// ============================================================================
// Quality Gate — Comprehensive check endpoint
// ============================================================================

app.post('/api/quality/check', (req, res) => {
  const { input, output } = req.body ?? {};
  if (!output) {
    return res.status(400).json({ error: 'output is required' });
  }

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

  // 1. Hallucination check
  const hallucinationReport = hallucinationDetector.analyze(inputStr, outputStr);

  // 2. Consensus quality (signal-based)
  let consensusScore = 1.0;
  const consensusSignals: string[] = [];

  const hasHedging = /\b(might|may|could|likely|possibly|approximately|around|I think|it seems)\b/i.test(outputStr);
  if (hasHedging) consensusSignals.push('hedging_language');

  const contradictions = (outputStr.match(/\bhowever\b|\bbut\b|\bon the other hand\b|\bcontrary to\b/gi) ?? []).length;
  if (contradictions > 3) { consensusScore -= 0.2; consensusSignals.push(`contradiction_markers:${contradictions}`); }

  const sentences = outputStr.split(/[.!?]+/).filter((s: string) => s.trim().length > 20);
  const unique = new Set(sentences.map((s: string) => s.trim().toLowerCase()));
  const repRate = 1 - (unique.size / Math.max(sentences.length, 1));
  if (repRate > 0.3) { consensusScore -= 0.25; consensusSignals.push(`repetition:${(repRate * 100).toFixed(0)}%`); }
  consensusScore = Math.max(0, Math.min(1, consensusScore));

  // 3. Handoff verification
  const handoffSignals: string[] = [];
  let handoffPassed = true;
  if (!input) { handoffPassed = false; handoffSignals.push('missing_input'); }

  // 4. Output validation
  const outputValid = output !== null && output !== undefined && outputStr.trim().length > 0;

  res.json({
    hallucination: hallucinationReport,
    consensus: {
      score: consensusScore,
      passed: consensusScore >= 0.67,
      signals: consensusSignals,
    },
    handoff: {
      passed: handoffPassed,
      signals: handoffSignals,
    },
    outputValidation: {
      passed: outputValid,
    },
    overall: {
      passed: hallucinationReport.recommendation !== 'reject' && consensusScore >= 0.67 && handoffPassed && outputValid,
    },
  });
});

// ============================================================================
// Memory Poisoning Detection API
// ============================================================================

import { MemoryPoisoningDetector } from './memoryPoisoningDetector';
const memoryPoisoningDetector = new MemoryPoisoningDetector();

app.post('/api/memory/assess-credibility', async (req, res) => {
  const { id, content, timestamp, source, embedding, metadata } = req.body ?? {};
  if (!content || !source) {
    return res.status(400).json({ error: 'content and source are required' });
  }

  const result = await memoryPoisoningDetector.assessCredibility({
    id: id ?? `mem-${Date.now()}`,
    content,
    timestamp: timestamp ? new Date(timestamp) : new Date(),
    source,
    embedding,
    metadata,
  });

  res.json(result);
});

app.post('/api/memory/detect-poisoning', async (req, res) => {
  const { newMemories, existingMemories } = req.body ?? {};
  if (!Array.isArray(newMemories)) {
    return res.status(400).json({ error: 'newMemories array is required' });
  }

  const indicators = await memoryPoisoningDetector.detectPoisoning(
    newMemories.map((m: any) => ({
      id: m.id ?? `mem-${Date.now()}`,
      content: m.content ?? '',
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      source: m.source ?? 'unknown',
      embedding: m.embedding,
      metadata: m.metadata,
    })),
    (existingMemories ?? []).map((m: any) => ({
      id: m.id ?? `mem-${Date.now()}`,
      content: m.content ?? '',
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      source: m.source ?? 'unknown',
      embedding: m.embedding,
      metadata: m.metadata,
    })),
  );

  res.json({ indicators, count: indicators.length });
});

// ============================================================================
// Consistency Monitor API
// ============================================================================

import { getConsistencyMonitorManager } from './consistencyMonitor';

app.post('/api/consistency/record', (req, res) => {
  const { missionId, agentId, outputType, content } = req.body ?? {};
  if (!agentId || !content) {
    return res.status(400).json({ error: 'agentId and content are required' });
  }
  const manager = getConsistencyMonitorManager();
  manager.recordOutput(missionId ?? 'global', {
    agentId,
    type: outputType ?? 'analysis',
    content,
    timestamp: Date.now(),
  });
  res.json({ status: 'recorded' });
});

app.get('/api/consistency/check/:missionId', (req, res) => {
  const manager = getConsistencyMonitorManager();
  const report = manager.checkConsistency(req.params.missionId);
  res.json(report);
});

app.get('/api/consistency/status', (_req, res) => {
  const manager = getConsistencyMonitorManager();
  const all = manager.getAllConsistencyStatus();
  const result: Record<string, any> = {};
  all.forEach((report, missionId) => {
    result[missionId] = report;
  });
  res.json(result);
});

// ============================================================================
// Agent Self-Assessment API
// ============================================================================

import { SelfAssessmentManager } from './selfAssessment';
const selfAssessmentManager = new SelfAssessmentManager();

app.post('/api/agents/:agentId/self-assess', (req, res) => {
  const { agentId } = req.params;
  const { type, requiredSkills, complexity } = req.body ?? {};
  
  const result = selfAssessmentManager.assess(agentId, {
    type,
    requiredSkills,
    complexity,
  });

  res.json(result);
});

app.get('/api/agents/:agentId/self-model', (req, res) => {
  const { agentId } = req.params;
  const manager = selfAssessmentManager as any;
  const assessor = manager.agents?.get(agentId);
  
  if (!assessor) {
    return res.status(404).json({ error: 'Agent not found. Run self-assessment first.' });
  }

  res.json(assessor.getSelfModel());
});

// ============================================================================
// Evaluation API (LLM-as-Judge)
// ============================================================================

import { createEvaluationRouter, createMockLLMCall } from './evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from './evaluation';

const evaluator = new LLMEvaluator();
const smoother = new ScoreSmoother();
const mockLLMCall = createMockLLMCall();
const evaluationRouter = createEvaluationRouter(evaluator, smoother, mockLLMCall);
app.use('/api/evaluation', evaluationRouter);

// ============================================================================
// Governance Checkpoint API
// ============================================================================

import { CheckpointManager } from './governanceCheckpoint';
import { createGovernanceRouter } from './governanceEndpoints';

const checkpointManager = new CheckpointManager();
const governanceRouter = createGovernanceRouter(checkpointManager);
app.use('/api/governance', governanceRouter);

// ============================================================================
// State Machine API
// ============================================================================

import stateMachineRouter from './stateMachineEndpoints';
app.use('/api/state-machine', stateMachineRouter);

// ============================================================================
// Agent Card API (A2A Protocol)
// ============================================================================

import { AgentCardRegistry } from './agentCard';
const agentCardRegistry = new AgentCardRegistry();

app.get('/api/agent-cards', (_req, res) => {
  res.json(agentCardRegistry.listAll());
});

app.get('/api/agent-cards/:id', (req, res) => {
  const card = agentCardRegistry.get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Agent card not found' });
  res.json(card);
});

app.post('/api/agent-cards', (req, res) => {
  const card = req.body;
  if (!card?.id || !card?.name) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  agentCardRegistry.register(card);
  res.status(201).json(card);
});

// ============================================================================
// Reasoning Config API
// ============================================================================

import { selectReasoningMode, confidenceToAction, buildReasoningConfig, ReasoningMode } from './reasoningConfig';

app.post('/api/reasoning/select-mode', (req, res) => {
  const { estimatedSteps, hasBranches, dependenciesComplex } = req.body ?? {};
  if (estimatedSteps === undefined) {
    return res.status(400).json({ error: 'estimatedSteps is required' });
  }

  const mode = selectReasoningMode(estimatedSteps, hasBranches, dependenciesComplex);
  const config = buildReasoningConfig(mode);
  res.json({ mode, config });
});

app.post('/api/reasoning/confidence-action', (req, res) => {
  const { confidence } = req.body ?? {};
  if (confidence === undefined) {
    return res.status(400).json({ error: 'confidence is required (0-1)' });
  }

  const action = confidenceToAction(confidence);
  res.json({ confidence, action });
});

// ============================================================================
// Evaluation API
// ============================================================================

import { createEvaluationRunner, StringMatchGrader, OutcomeVerificationGrader } from './evaluationRunner';

app.post('/api/evaluation/grade', async (req, res) => {
  const { trials, graderType, expectedOutput } = req.body ?? {};
  if (!Array.isArray(trials) || trials.length === 0) {
    return res.status(400).json({ error: 'trials array is required' });
  }

  const grader = graderType === 'outcome'
    ? new OutcomeVerificationGrader('outcome-check', (t: any) => t.output?.status === 'success')
    : new StringMatchGrader('string-match', expectedOutput ?? '');

  const runner = createEvaluationRunner();
  const results = await runner.gradeTrials(trials, [grader]);

  const output: Record<string, any> = {};
  results.forEach((v, k) => { output[k] = v; });
  res.json({ results: output });
});

app.post('/api/evaluation/pass-at-k', (req, res) => {
  const { trials, graderResults, k } = req.body ?? {};
  if (!Array.isArray(trials) || !graderResults || !k) {
    return res.status(400).json({ error: 'trials, graderResults, and k are required' });
  }

  const runner = createEvaluationRunner();
  const map = new Map<string, any>(Object.entries(graderResults));
  const passAtK = runner.calculatePassAtK(trials, map, k);

  res.json({ passAtK, k, totalTrials: trials.length });
});

// ============================================================================
// Pattern State Machine API
// ============================================================================

import { PatternStateMachineFactory, PatternStateMachine } from './patternStateMachine';
const patternMachineFactory = new PatternStateMachineFactory();
const activeMachines = new Map<string, PatternStateMachine>();

app.post('/api/state-machine/create', (req, res) => {
  const { pattern, projectId } = req.body ?? {};
  if (!pattern) {
    return res.status(400).json({ error: 'pattern is required (orchestrator-worker, hierarchical, swarm, pipeline)' });
  }

  try {
    const machine = PatternStateMachineFactory.create(pattern);
    const machineId = `sm-${Date.now()}`;
    activeMachines.set(machineId, machine);
    
    res.json({
      machineId,
      pattern,
      currentState: machine.getCurrentState().currentStep,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/state-machine/:machineId/transition', async (req, res) => {
  const { machineId } = req.params;
  const { targetState } = req.body ?? {};
  const machine = activeMachines.get(machineId);
  
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  if (!targetState) {
    return res.status(400).json({ error: 'targetState is required' });
  }

  try {
    const result = await machine.transition(targetState);
    res.json({ result, currentState: machine.getCurrentState() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/state-machine/:machineId', (req, res) => {
  const { machineId } = req.params;
  const machine = activeMachines.get(machineId);
  
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }

  const currentState = machine.getCurrentState();
  res.json({
    machineId,
    currentState,
  });
});

// ============================================================================
// Sequential Executor API
// ============================================================================

import { SequentialExecutor, createMockAgentExecutor } from './sequentialExecutor';

const pipelineRuns = new Map<string, any>();
const sequentialExecutor = new SequentialExecutor({
  agentExecutor: createMockAgentExecutor(),
  runContextProvider: (async (ctx: any) => ({ projectId: ctx?.projectId ?? 'default', run: { runId: 'run', issuedAt: new Date().toISOString() }, slimSnapshot: {}, recentMemory: [], recommendedMemory: [], agentRoster: [] })) as any,
});

app.post('/api/pipeline/execute', async (req, res) => {
  const { id, name, projectId, steps, input } = req.body ?? {};
  if (!id || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'id and steps[] are required' });
  }

  const now = new Date().toISOString();
  const pipeline = {
    id,
    name: name ?? id,
    projectId: projectId ?? 'default',
    steps: steps.map((s: any, i: number) => ({
      id: s.id ?? `step-${i}`,
      agentId: s.agentId ?? 'agent-default',
      name: s.name ?? `Step ${i + 1}`,
      input: s.input,
      timeoutMs: s.timeoutMs,
      retries: s.retries,
    })),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const run = await sequentialExecutor.execute(pipeline as any, { input });
    pipelineRuns.set(run.id, run);
    res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pipeline/runs/:runId', (req, res) => {
  const run = pipelineRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.get('/api/pipeline/runs', (_req, res) => {
  res.json(Array.from(pipelineRuns.values()));
});

// ============================================================================
// Agent Benchmark Runner API
// ============================================================================

import { AgentBenchmarkRunner, createCommanderHealthCheckBenchmark, visualizeBenchmark, calculatePassAtK } from './agentBenchmarkRunner';

app.post('/api/benchmark/run', async (req, res) => {
  const { tasks, maxConcurrency, name: benchName } = req.body ?? {};
  const benchmarkTasks = tasks ?? createCommanderHealthCheckBenchmark();
  
  const runner = new AgentBenchmarkRunner({
    name: benchName ?? 'Commander Health Check',
    tasks: benchmarkTasks,
    maxConcurrency: maxConcurrency ?? 1,
    executor: { execute: async (prompt: string) => `Benchmark response for: ${prompt}` },
  });

  try {
    const result = await runner.run();
    const visualization = visualizeBenchmark(result);
    res.json({ result, visualization });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/benchmark/health-check-tasks', (_req, res) => {
  const tasks = createCommanderHealthCheckBenchmark();
  res.json({ tasks, count: tasks.length });
});

// ============================================================================
// Namespaced Memory Store API (RBAC + Audit)
// ============================================================================

import { NamespacedMemoryStore } from './namespacedMemoryStore';
const namespacedStore = new NamespacedMemoryStore();

app.post('/api/namespaced-memory/:namespace/write', (req, res) => {
  const { namespace } = req.params;
  const { key, value, role, agentId, projectId, kind, title, content: memContent, tags } = req.body ?? {};
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value are required' });
  }

  const result = namespacedStore.write(
    { namespace, projectId: projectId ?? 'default', kind: kind ?? 'SUMMARY', title: title ?? key, content: memContent ?? value, tags: tags ?? [] },
    { agentId: agentId ?? 'api', role: role ?? 'system', namespace }
  );

  if (!result) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  res.json({ status: 'ok', namespace, id: result.id });
});

app.get('/api/namespaced-memory/:namespace/read/:id', (req, res) => {
  const { namespace, id } = req.params;
  const role = (req.query.role as string) ?? 'reader';
  const agentId = (req.query.agentId as string) ?? 'api';

  const item = namespacedStore.read(id, { agentId, role, namespace });
  if (!item) {
    return res.status(404).json({ error: 'Not found or permission denied' });
  }
  res.json(item);
});

app.get('/api/namespaced-memory/:namespace/search', (req, res) => {
  const { namespace } = req.params;
  const q = (req.query.q as string) ?? '';
  const role = (req.query.role as string) ?? 'reader';
  const agentId = (req.query.agentId as string) ?? 'api';
  const projectId = (req.query.projectId as string) ?? 'default';

  const results = namespacedStore.search(
    { projectId, query: q, namespaces: [namespace] },
    { agentId, role, namespace }
  );
  res.json({ namespace, query: q, items: results.items, total: results.total });
});

app.get('/api/namespaced-memory/:namespace/stats', (req, res) => {
  const { namespace } = req.params;
  const stats = namespacedStore.getNamespaceStats(namespace);
  res.json(stats);
});

app.get('/api/namespaced-memory/:namespace/audit', (req, res) => {
  const { namespace } = req.params;
  const limit = parseInt(req.query.limit as string) ?? 50;
  const audit = namespacedStore.getAuditLog({ namespace, limit });
  res.json({ namespace, entries: audit, count: audit.length });
});

app.get('/api/namespaced-memory/acl', (_req, res) => {
  res.json({ rules: namespacedStore.getACLRules() });
});

// ============================================================================
// A2A Protocol Endpoints (Google Agent-to-Agent)
// ============================================================================

import { createA2ARouter } from './a2aEndpoints';
import { TaskManager, ArtifactManager } from './a2aTask';

const a2aTaskManager = new TaskManager();
const a2aArtifactManager = new ArtifactManager();

const a2aRouter = createA2ARouter(a2aTaskManager, a2aArtifactManager, agentCardRegistry);
app.use('/a2a', a2aRouter);

// A2A v1.0 Protocol — JSON-RPC 2.0 + SSE + Agent Card
import { createA2AV2Router } from './a2aV2Endpoints';
app.use('/a2a/v2', createA2AV2Router());

// MCP Protocol — Model Context Protocol server + client
import { createMCPRouter, createMCPClientRouter } from './mcpEndpoints';
app.use('/mcp', createMCPRouter());
app.use('/mcp/client', createMCPClientRouter());

// ============================================================================
// Runtime System API — Agent Execution Engine
// ============================================================================

import { createRuntimeRouter } from './runtimeEndpoints';
app.use('/api/runtime', createRuntimeRouter());

// ============================================================================
// Ultimate Orchestrator API — Multi-Agent Execution
// ============================================================================

import { AgentRuntime, OpenAIProvider, AnthropicProvider, createAllTools, SSEStream } from '@commander/core';
import { TELOSOrchestrator } from '@commander/core';
import { UltimateOrchestrator } from '@commander/core';

let orchInstance: UltimateOrchestrator | null = null;

function getOrchestrator(): UltimateOrchestrator | null {
  if (orchInstance) return orchInstance;
  const runtime = new AgentRuntime();
  const allTools = createAllTools();
  for (const [name, tool] of allTools) runtime.registerTool(name, tool);

  let hasProvider = false;
  if (process.env.OPENAI_API_KEY) {
    runtime.registerProvider('openai', new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
    hasProvider = true;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
    hasProvider = true;
  }
  if (!hasProvider) return null;

  const telos = new TELOSOrchestrator(runtime);
  orchInstance = new UltimateOrchestrator(telos, runtime);
  return orchInstance;
}

app.post('/api/orchestrator/execute', async (req, res) => {
  const { goal, effortLevel, tools } = req.body ?? {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.' });

  try {
    const result = await orch.execute({
      projectId: 'api',
      agentId: 'orchestrator-api',
      goal,
      contextData: {
        availableTools: tools ?? ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'python_execute', 'shell_execute', 'git'],
        governanceProfile: { riskLevel: 'LOW' },
      },
      effortLevel: effortLevel || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/orchestrator/deliberate', async (req, res) => {
  const { goal } = req.body ?? {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  const { deliberate } = require('@commander/core');
  const plan = deliberate(goal);
  res.json(plan);
});

app.get('/api/orchestrator/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sse = new SSEStream();
  sse.pipe(res);

  req.on('close', () => {
    sse.close();
    res.end();
  });
});

// ============================================================================
// OpenAPI Specification Endpoint
// ============================================================================

app.get('/api/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Commander Multi-Agent Framework API',
      version: '1.0.0',
      description: 'Production-grade multi-agent orchestration with governance, quality gates, and memory management.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
    tags: [
      { name: 'Projects', description: 'Project and agent management' },
      { name: 'Missions', description: 'Mission lifecycle' },
      { name: 'Memory', description: 'Memory stores (standard, namespaced, RBAC)' },
      { name: 'Quality', description: 'Quality gates: hallucination, consensus, handoff' },
      { name: 'Governance', description: 'Governance monitoring and alerts' },
      { name: 'Evaluation', description: 'Agent evaluation and grading' },
      { name: 'Benchmark', description: 'Agent benchmarking' },
      { name: 'A2A', description: 'Google Agent-to-Agent protocol' },
      { name: 'System', description: 'Health and status' },
    ],
    paths: {
      '/health': { get: { tags: ['System'], summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/system/status': { get: { tags: ['System'], summary: 'Module health status', responses: { '200': { description: 'Status of all modules' } } } },
      '/projects': { get: { tags: ['Projects'], summary: 'List all projects', responses: { '200': { description: 'Project list' } } } },
      '/projects/{projectId}/war-room': { get: { tags: ['Projects'], summary: 'War room snapshot', parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'War room data' } } } },
      '/projects/{projectId}/missions': { post: { tags: ['Missions'], summary: 'Create mission', responses: { '201': { description: 'Created' } } } },
      '/missions/{missionId}': { patch: { tags: ['Missions'], summary: 'Update mission', responses: { '200': { description: 'Updated' } } } },
      '/missions/{missionId}/logs': { post: { tags: ['Missions'], summary: 'Add mission log', responses: { '200': { description: 'OK' } } } },
      '/projects/{projectId}/memory': { get: { tags: ['Memory'], summary: 'List memories' }, post: { tags: ['Memory'], summary: 'Create memory' } },
      '/projects/{projectId}/memory/search': { get: { tags: ['Memory'], summary: 'Search memories' } },
      '/api/quality/check': { post: { tags: ['Quality'], summary: 'Run all quality gates', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { input: { type: 'string' }, output: { type: 'string', required: true } } } } } }, responses: { '200': { description: 'Quality gate results' } } } },
      '/api/quality/hallucination-check': { post: { tags: ['Quality'], summary: 'Hallucination detection', responses: { '200': { description: 'Hallucination report' } } } },
      '/api/memory/assess-credibility': { post: { tags: ['Memory'], summary: 'Source credibility assessment', responses: { '200': { description: 'Credibility score' } } } },
      '/api/memory/detect-poisoning': { post: { tags: ['Memory'], summary: 'Batch poisoning detection', responses: { '200': { description: 'Poisoning indicators' } } } },
      '/api/agents/{agentId}/self-assess': { post: { tags: ['Governance'], summary: 'Agent self-assessment', responses: { '200': { description: 'Assessment result' } } } },
      '/api/agents/{agentId}/self-model': { get: { tags: ['Governance'], summary: 'Agent self-model', responses: { '200': { description: 'Self model' } } } },
      '/projects/{projectId}/governance/stats': { get: { tags: ['Governance'], summary: 'Governance statistics', responses: { '200': { description: 'Stats' } } } },
      '/projects/{projectId}/governance/alerts': { get: { tags: ['Governance'], summary: 'Governance alerts', responses: { '200': { description: 'Alerts' } } } },
      '/projects/{projectId}/governance/weekly-report': { get: { tags: ['Governance'], summary: 'Weekly governance report', responses: { '200': { description: 'Report' } } } },
      '/api/benchmark/run': { post: { tags: ['Benchmark'], summary: 'Run agent benchmark', responses: { '200': { description: 'Benchmark results' } } } },
      '/api/benchmark/health-check-tasks': { get: { tags: ['Benchmark'], summary: 'List benchmark tasks', responses: { '200': { description: 'Tasks' } } } },
      '/api/namespaced-memory/{namespace}/write': { post: { tags: ['Memory'], summary: 'RBAC memory write', responses: { '200': { description: 'Written' }, '403': { description: 'Permission denied' } } } },
      '/api/namespaced-memory/{namespace}/read/{id}': { get: { tags: ['Memory'], summary: 'RBAC memory read', responses: { '200': { description: 'Memory item' }, '403': { description: 'Permission denied' } } } },
      '/api/namespaced-memory/{namespace}/search': { get: { tags: ['Memory'], summary: 'RBAC memory search', responses: { '200': { description: 'Search results' } } } },
      '/api/namespaced-memory/{namespace}/stats': { get: { tags: ['Memory'], summary: 'Namespace stats', responses: { '200': { description: 'Stats' } } } },
      '/api/namespaced-memory/{namespace}/audit': { get: { tags: ['Memory'], summary: 'Audit log', responses: { '200': { description: 'Audit entries' } } } },
      '/api/namespaced-memory/acl': { get: { tags: ['Memory'], summary: 'ACL rules', responses: { '200': { description: 'Rules' } } } },
      '/a2a/.well-known/agent-card': { get: { tags: ['A2A'], summary: 'Agent card (A2A protocol)', responses: { '200': { description: 'Agent card' } } } },
      '/a2a/agent-cards': { get: { tags: ['A2A'], summary: 'List agent cards', responses: { '200': { description: 'Cards' } } } },
      '/a2a/tasks': { post: { tags: ['A2A'], summary: 'Create A2A task', responses: { '201': { description: 'Task created' } } } },
    },
  });
});
