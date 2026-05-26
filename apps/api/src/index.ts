import express from 'express';
import { SequentialPipeline } from '@commander/core';
import { WarRoomStore } from './store';
import { ProjectMemoryStore } from './memoryStore';
import { AgentStateStore } from './agentStateStore';
import { MemoryIndexManager, DEFAULT_DOMAINS } from './memoryIndexManager';
import { EpisodicMemoryStore } from './episodicMemoryStore';
import { ActionRationaleStore } from './actionRationale';
import { ConfidenceReporter, ConfidenceReport, ConfidenceAlert, DEFAULT_THRESHOLDS } from './confidenceReporter';
import { createProjectRouter } from './projectEndpoints';
import { createConflictRouter } from './conflictEndpoints';
import { createSecurityRouter } from './securityEndpoints';
import { createQualityRouter } from './qualityEndpoints';

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

app.use(createProjectRouter(store, memoryStore, agentStateStore));

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
  } catch (e) {
    process.stderr.write(`[MemoryIndex] Domain already exists: ${domain}\n`);
  }
});

// ========================================
// Conflict Detection API
// ========================================

app.use(createConflictRouter(store));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  process.stdout.write(`API listening on http://localhost:${port}\n`);
  process.stdout.write(`War room project ready at GET /projects/${PROJECT_ID}/war-room\n`);
});

app.use(createSecurityRouter());

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
// Quality Gates — Hallucination Detection, Quality Check, Consistency Monitor
// ============================================================================

app.use(createQualityRouter());

// (memory poisoning routes live in securityEndpoints.ts via createSecurityRouter)

// (consistency monitor routes live in qualityEndpoints.ts via createQualityRouter)

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
const manager = selfAssessmentManager;
   const assessor = manager.getOrCreate(agentId);
  
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
   runContextProvider: (async (ctx: { projectId?: string }) => ({
     projectId: ctx?.projectId ?? 'default',
     run: { runId: 'run', issuedAt: new Date().toISOString() },
     slimSnapshot: {
       project: { id: 'default', codename: 'default', objective: '', status: 'ACTIVE', updatedAt: new Date().toISOString() },
       missionBoard: { running: [], blocked: [], planned: [], done: [] },
       battleMetrics: { health: 'GREEN', runningMissionCount: 0, blockedMissionCount: 0, completedMissionCount: 0, highRiskMissionCount: 0, manualGovernanceMissionCount: 0, logVolume24h: 0, completionRate: 0 },
     },
     recentMemory: [],
     recommendedMemory: { items: [] },
     agentRoster: [],
   })),
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
const run = await sequentialExecutor.execute(pipeline as SequentialPipeline, { input });
     pipelineRuns.set(run.id, run);
     res.json(run);
   } catch (err: unknown) {
     res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
