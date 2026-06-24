import type { Express } from 'express';
import type { IWarRoomStore } from './store';
import type { ProjectMemoryStore } from './memoryStore';
import type { AgentStateStore } from './agentStateStore';
import type { MemoryIndexManager } from './memoryIndexManager';
import type { EpisodicMemoryStore } from './episodicMemoryStore';
import type { ConfidenceReporter } from './confidenceReporter';
import type { AgentCardRegistry } from './agentCard';
import type { LLMEvaluator, ScoreSmoother } from './evaluation';
import type { CheckpointManager } from './governanceCheckpoint';
import type { TaskManager, ArtifactManager } from './a2aTask';

import { createProjectRouter } from './projectEndpoints';
import { createConflictRouter } from './conflictEndpoints';
import { createSecurityRouter } from './securityEndpoints';
import { createQualityRouter } from './qualityEndpoints';
import { createMemoryIndexRouter } from './memoryIndexEndpoints';
import { createConfidenceRouter } from './confidenceEndpoints';
import { createNamespacedMemoryRouter } from './namespacedMemoryEndpoints';
import { createPipelineRouter } from './pipelineEndpoints';
import { createEvaluationRouter, createMockLLMCall } from './evaluationEndpoints';
import { createGovernanceRouter } from './governanceEndpoints';
import stateMachineRouter from './stateMachineEndpoints';
import { createA2ARouter } from './a2aEndpoints';
import { createA2AV2Router } from './a2aV2Endpoints';
import { createMCPRouter, createMCPClientRouter } from './mcpEndpoints';
import { createRuntimeRouter } from './runtimeEndpoints';
import { createCostRouter } from './costEndpoints';
import { createPauseRouter } from './pauseEndpoints';
import { createReplayRouter } from './replayEndpoints';
import { createTeamRouter } from './teamEndpoints';
import { createSelfAssessmentRouter } from './selfAssessmentEndpoints';
import { createAgentCardRouter } from './agentCardEndpoints';
import { createReasoningConfigRouter } from './reasoningConfigEndpoints';
import { createEvaluationRunnerRouter } from './evaluationRunnerEndpoints';
import { createOrchestratorRouter } from './orchestratorEndpoints';
import { createObservabilityRouter } from './observabilityEndpoints';
import { createStreamRouter } from './streamEndpoints';
import { authMiddleware } from './authMiddleware';

export interface RouterContext {
  store: IWarRoomStore;
  memoryStore: ProjectMemoryStore;
  agentStateStore: AgentStateStore;
  memoryIndexManager: MemoryIndexManager;
  episodicMemoryStore: EpisodicMemoryStore;
  confidenceReporter: ConfidenceReporter;
  agentCardRegistry: AgentCardRegistry;
  evaluator: LLMEvaluator;
  smoother: ScoreSmoother;
  checkpointManager: CheckpointManager;
  a2aTaskManager: TaskManager;
  a2aArtifactManager: ArtifactManager;
}

export function registerRoutes(app: Express, ctx: RouterContext) {
  const mockLLMCall = createMockLLMCall();
  const evaluationRouter = createEvaluationRouter(ctx.evaluator, ctx.smoother, mockLLMCall);
  const governanceRouter = createGovernanceRouter(ctx.checkpointManager);
  const a2aRouter = createA2ARouter(
    ctx.a2aTaskManager,
    ctx.a2aArtifactManager,
    ctx.agentCardRegistry,
  );

  app.use(authMiddleware);

  app.use(createProjectRouter(ctx.store, ctx.memoryStore, ctx.agentStateStore));
  app.use(createMemoryIndexRouter(ctx.memoryIndexManager));
  app.use(createConflictRouter(ctx.store));
  app.use(createSecurityRouter());
  app.use(createConfidenceRouter(ctx.store, ctx.confidenceReporter));
  app.use(createQualityRouter());
  app.use('/api', createSelfAssessmentRouter());
  app.use('/api/evaluation', evaluationRouter);
  app.use('/api/governance', governanceRouter);
  app.use('/api/state-machine', stateMachineRouter);
  app.use('/api', createAgentCardRouter(ctx.agentCardRegistry));
  app.use('/api', createReasoningConfigRouter());
  app.use('/api', createEvaluationRunnerRouter());
  app.use(createPipelineRouter());
  app.use(createNamespacedMemoryRouter());
  app.use('/a2a', a2aRouter);
  app.use('/a2a/v2', createA2AV2Router());
  app.use('/mcp', createMCPRouter());
  app.use('/mcp/client', createMCPClientRouter());
  app.use(createStreamRouter());
  app.use('/api/runtime', createRuntimeRouter());
  app.use('/', createCostRouter());
  app.use('/', createPauseRouter());
  app.use('/', createReplayRouter());
  app.use('/api', createOrchestratorRouter());
  app.use('/api', createTeamRouter());

  app.use('/api/v1/evaluation', evaluationRouter);
  app.use('/api/v1/governance', governanceRouter);
  app.use('/api/v1/state-machine', stateMachineRouter);
  app.use('/api/v1', createSelfAssessmentRouter());
  app.use('/api/v1', createAgentCardRouter(ctx.agentCardRegistry));
  app.use('/api/v1', createReasoningConfigRouter());
  app.use('/api/v1', createEvaluationRunnerRouter());
  app.use('/api/v1/runtime', createRuntimeRouter());
  app.use('/api/v1', createOrchestratorRouter());
  app.use('/api/v1/observability', createObservabilityRouter());
}
