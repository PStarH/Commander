/**
 * Commander Framework Integration
 * Phase 3: 将终极框架组件集成到现有 API
 */

import { AdaptiveOrchestrator } from './adaptiveOrchestrator';
import { TokenBudgetAllocator } from './tokenBudgetAllocator';
import { ThreeLayerMemory } from './threeLayerMemory';
import { ReflectionEngine } from './reflectionEngine';
import { ConsensusChecker } from './consensusCheck';
import { InspectorAgent } from './inspectorAgent';
import { Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics } from './logging';
import type { OrchestrationMode } from './adaptiveOrchestrator';

export type { OrchestrationMode };

// Re-export framework components
export {
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
  InspectorAgent,
  Logger,
  MetricsCollector,
  getGlobalLogger,
  getGlobalMetrics,
};

// ========================================
// Framework Integration
// ========================================

let frameworkInitialized = false;
let frameworkInstances: {
  orchestrator: AdaptiveOrchestrator;
  budgetAllocator: TokenBudgetAllocator;
  memory: ThreeLayerMemory;
  reflection: ReflectionEngine;
  consensus: ConsensusChecker;
  inspector: InspectorAgent;
  logger: Logger;
  metrics: MetricsCollector;
} | null = null;

export function initializeFramework() {
  if (frameworkInitialized) return;
  
  frameworkInstances = {
    orchestrator: new AdaptiveOrchestrator(),
    budgetAllocator: new TokenBudgetAllocator({ baseBudget: 100000 }),
    memory: new ThreeLayerMemory(),
    reflection: new ReflectionEngine(),
    consensus: new ConsensusChecker({ minVoters: 3 }),
    inspector: new InspectorAgent(),
    logger: getGlobalLogger(),
    metrics: getGlobalMetrics(),
  };
  
  frameworkInitialized = true;
}

export function getFramework() {
  if (!frameworkInitialized) {
    initializeFramework();
  }
  return frameworkInstances!;
}

// ========================================
// High-Level API Functions
// ========================================

/**
 * Create an execution plan
 */
export function createExecutionPlan(
  tasks: Array<{
    id: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
  }>,
  suggestedMode?: OrchestrationMode
) {
  const { orchestrator, logger } = getFramework();
  
  logger.info('framework', `Creating plan for ${tasks.length} task(s)`);
  
  const mappedTasks = tasks.map((t) => ({
    id: t.id,
    description: t.description,
    priority: t.priority || 'medium',
    complexity: 50,
    dependencies: [],
    retryCount: 0,
    maxRetries: 3,
    status: 'pending' as const,
  }));

  const plan = orchestrator.createPlan(mappedTasks, suggestedMode);

  return {
    planId: plan.id,
    mode: plan.mode,
    tasks: plan.tasks.length,
  };
}

/**
 * Allocate budget for a task
 */
export function allocateBudget(mode: OrchestrationMode) {
  const { budgetAllocator } = getFramework();
  
  // Use the actual signature: allocate(mode, complexity, agentCount)
  const budget = budgetAllocator.allocate('SEQUENTIAL' as any, 50, 1);
  
  return {
    total: budget.total,
    leadAgent: budget.leadAgent,
    specialistAgents: budget.specialistAgents,
    overhead: budget.overhead,
  };
}

/**
 * Record memory in the framework
 */
export function recordMemory(
  content: string,
  layer: 'working' | 'episodic' | 'longterm',
  context?: string,
  importance: number = 0.5
) {
  const { memory } = getFramework();
  const entry = memory.add(content, layer, context, importance);
  return { id: entry.id, layer: entry.layer };
}

/**
 * Query framework memory
 */
export function queryMemory(options: {
  keywords?: string[];
  layer?: 'working' | 'episodic' | 'longterm';
  limit?: number;
}) {
  const { memory } = getFramework();
  const results = memory.query({
    keywords: options.keywords,
    layer: options.layer,
    limit: options.limit || 10,
  });
  return { count: results.length };
}

/**
 * Start a reflection session
 */
export function startReflection(taskId: string) {
  const { reflection } = getFramework();
  const sessionId = reflection.startSession(taskId);
  return { sessionId };
}

/**
 * Complete a reflection session
 */
export function completeReflection(
  sessionId: string,
  outcome: 'success' | 'partial' | 'failure'
) {
  const { reflection } = getFramework();
  reflection.completeSession(sessionId, outcome);
  return { sessionId, outcome };
}

/**
 * Run consensus check
 */
export function runConsensusCheck(
  question: string,
  votes: Array<{
    modelId: string;
    modelName: string;
    decision: string;
    confidence: number;
    reasoning: string;
  }>
) {
  const { consensus } = getFramework();
  
  const checkId = consensus.createCheck(question);
  
  for (const vote of votes) {
    consensus.addVote(
      checkId,
      vote.modelId,
      vote.modelName,
      vote.decision,
      vote.confidence,
      vote.reasoning
    );
  }
  
  const result = consensus.getResult(checkId);
  
  return {
    checkId,
    consensusLevel: result?.consensusLevel,
    consensusScore: result?.consensusScore,
    decision: result?.decision,
  };
}

/**
 * Update component health
 */
export function updateComponentHealth(
  name: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
  score: number
) {
  const { inspector } = getFramework();
  inspector.updateComponent(name, status, score);
  return { name, status, score };
}

/**
 * Run system inspection
 */
export function runInspection() {
  const { inspector } = getFramework();
  const report = inspector.inspect();
  return {
    overallStatus: report.overallStatus,
    overallHealth: report.overallHealth,
    openIssues: report.openIssues.length,
  };
}