import express from 'express';
import { WarRoomStore } from './store';
import { ProjectMemoryStore } from './memoryStore';
import { AgentStateStore } from './agentStateStore';
import { MemoryIndexManager, DEFAULT_DOMAINS } from './memoryIndexManager';
import { EpisodicMemoryStore } from './episodicMemoryStore';
import { ActionRationaleStore } from './actionRationale';
import { ConfidenceReporter } from './confidenceReporter';
import { createProjectRouter } from './projectEndpoints';
import { createConflictRouter } from './conflictEndpoints';
import { createSecurityRouter } from './securityEndpoints';
import { createQualityRouter } from './qualityEndpoints';
import { createMemoryIndexRouter } from './memoryIndexEndpoints';
import { createConfidenceRouter } from './confidenceEndpoints';
import { createNamespacedMemoryRouter } from './namespacedMemoryEndpoints';
import { createPipelineRouter } from './pipelineEndpoints';
import { createEvaluationRouter, createMockLLMCall } from './evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from './evaluation';
import { CheckpointManager } from './governanceCheckpoint';
import { createGovernanceRouter } from './governanceEndpoints';
import stateMachineRouter from './stateMachineEndpoints';
import { AgentCardRegistry } from './agentCard';
import { createA2ARouter } from './a2aEndpoints';
import { TaskManager, ArtifactManager } from './a2aTask';
import { createA2AV2Router } from './a2aV2Endpoints';
import { createMCPRouter, createMCPClientRouter } from './mcpEndpoints';
import { createRuntimeRouter } from './runtimeEndpoints';
import { createSelfAssessmentRouter } from './selfAssessmentEndpoints';
import { createAgentCardRouter } from './agentCardEndpoints';
import { createReasoningConfigRouter } from './reasoningConfigEndpoints';
import { createEvaluationRunnerRouter } from './evaluationRunnerEndpoints';
import { createOrchestratorRouter } from './orchestratorEndpoints';

const PROJECT_ID = 'project-war-room';
const app = express();

// ── Shared state ────────────────────────────────────────────────────────────
const store = new WarRoomStore();
const memoryStore = new ProjectMemoryStore();
const agentStateStore = new AgentStateStore();
const memoryIndexManager = new MemoryIndexManager(PROJECT_ID);
const episodicMemoryStore = new EpisodicMemoryStore();
const actionRationaleStore = new ActionRationaleStore();
const confidenceReporter = new ConfidenceReporter(actionRationaleStore);
const agentCardRegistry = new AgentCardRegistry();
const evaluator = new LLMEvaluator();
const smoother = new ScoreSmoother();
const mockLLMCall = createMockLLMCall();
const evaluationRouter = createEvaluationRouter(evaluator, smoother, mockLLMCall);
const checkpointManager = new CheckpointManager();
const governanceRouter = createGovernanceRouter(checkpointManager);
const a2aTaskManager = new TaskManager();
const a2aArtifactManager = new ArtifactManager();
const a2aRouter = createA2ARouter(a2aTaskManager, a2aArtifactManager, agentCardRegistry);

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

// Initialize default memory domains on startup
DEFAULT_DOMAINS.forEach(({ domain, description }) => {
  try {
    memoryIndexManager.addDomain(domain, description);
  } catch (e) {
    process.stderr.write(`[MemoryIndex] Domain already exists: ${domain}\n`);
  }
});

// ── System ──────────────────────────────────────────────────────────────────
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

// ── Routers ─────────────────────────────────────────────────────────────────
app.use(createProjectRouter(store, memoryStore, agentStateStore));
app.use(createMemoryIndexRouter(memoryIndexManager));
app.use(createConflictRouter(store));
app.use(createSecurityRouter());
app.use(createConfidenceRouter(store, confidenceReporter));
app.use(createQualityRouter());
app.use('/api', createSelfAssessmentRouter());
app.use('/api/evaluation', evaluationRouter);
app.use('/api/governance', governanceRouter);
app.use('/api/state-machine', stateMachineRouter);
app.use('/api', createAgentCardRouter(agentCardRegistry));
app.use('/api', createReasoningConfigRouter());
app.use('/api', createEvaluationRunnerRouter());
app.use(createPipelineRouter());
app.use(createNamespacedMemoryRouter());
app.use('/a2a', a2aRouter);
app.use('/a2a/v2', createA2AV2Router());
app.use('/mcp', createMCPRouter());
app.use('/mcp/client', createMCPClientRouter());
app.use('/api/runtime', createRuntimeRouter());
app.use('/api', createOrchestratorRouter());

// ── OpenAPI ─────────────────────────────────────────────────────────────────
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

// ── Startup ─────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  process.stdout.write(`API listening on http://localhost:${port}\n`);
  process.stdout.write(`War room project ready at GET /projects/${PROJECT_ID}/war-room\n`);
});
