/**
 * Multi-Agent Orchestrator
 * Based on Anthropic's multi-agent research system architecture
 *
 * Key principles:
 * 1. Lead agent decomposes queries into subtasks
 * 2. Subagents operate in parallel with separate context windows
 * 3. Clear task boundaries prevent duplication
 * 4. Scale effort to query complexity
 * 5. Deterministic task allocation prevents agent contention
 */
import { v4 as uuidv4 } from 'uuid';
import {
  DeterministicTaskAllocator,
  getTaskAllocator,
  AllocationResult,
  TaskPriority,
  ReleaseResult
} from './deterministicTaskAllocator';

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface SubagentTask {
  id: string;
  objective: string;
  outputFormat: string;
  tools: string[];
  boundaries: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  assignedAgentId?: string;
  allocationId?: string;
}

export interface OrchestratorPlan {
  id: string;
  query: string;
  complexity: TaskComplexity;
  subagentCount: number;
  tasks: SubagentTask[];
  createdAt: string;
  allocationEnabled: boolean;
}

export interface DelegationRequest {
  projectId: string;
  query: string;
  context?: string;
}

/**
 * Determines task complexity based on query characteristics
 * Following Anthropic's guidelines:
 * - Simple: 1 agent, 3-10 tool calls
 * - Moderate: 2-4 subagents, 10-15 calls each
 * - Complex: 10+ subagents with clear divisions
 */
export function assessComplexity(query: string): TaskComplexity {
  const indicators = {
    simple: ['what is', 'who is', 'when did', 'define'],
    moderate: ['compare', 'analyze', 'review', 'difference between'],
    complex: ['comprehensive', 'all aspects', 'thorough', 'multiple sources', 'deep dive']
  };

  const lowerQuery = query.toLowerCase();

  // Check for complexity indicators
  if (indicators.complex.some(i => lowerQuery.includes(i))) {
    return 'complex';
  }
  if (indicators.moderate.some(i => lowerQuery.includes(i))) {
    return 'moderate';
  }
  return 'simple';
}

/**
 * Calculates optimal subagent count based on complexity
 */
export function calculateSubagentCount(complexity: TaskComplexity): number {
  switch (complexity) {
    case 'simple': return 1;
    case 'moderate': return 2 + Math.floor(Math.random() * 2); // 2-4
    case 'complex': return 8 + Math.floor(Math.random() * 4); // 8-12
  }
}

/**
 * Creates a delegation plan for multi-agent execution
 */
export function createDelegationPlan(request: DelegationRequest): OrchestratorPlan {
  const complexity = assessComplexity(request.query);
  const subagentCount = calculateSubagentCount(complexity);

  const tasks: SubagentTask[] = [];

  // Decompose query into subtasks
  if (complexity === 'simple') {
    tasks.push({
      id: uuidv4(),
      objective: `Complete the query: "${request.query}"`,
      outputFormat: 'Direct answer with supporting evidence',
      tools: ['search', 'fetch'],
      boundaries: ['Focus on authoritative sources', 'Limit to 3-5 sources'],
      status: 'pending'
    });
  } else {
    // For moderate/complex, create specialized tasks
    // This is a placeholder - actual decomposition would use LLM
    const aspects = extractAspects(request.query);
    aspects.slice(0, subagentCount).forEach(aspect => {
      tasks.push({
        id: uuidv4(),
        objective: `Research: ${aspect}`,
        outputFormat: 'Structured findings with citations',
        tools: ['search', 'fetch', 'analyze'],
        boundaries: [
          'Do not duplicate work of other agents',
          'Focus on primary sources',
          'Return comprehensive findings'
        ],
        status: 'pending'
      });
    });
  }

  return {
    id: uuidv4(),
    query: request.query,
    complexity,
    subagentCount,
    tasks,
    createdAt: new Date().toISOString(),
    allocationEnabled: true
  };
}

/**
 * Extracts research aspects from a query (simplified)
 * In production, this would use an LLM
 */
function extractAspects(query: string): string[] {
  // Simplified aspect extraction
  const aspects: string[] = [];

  // Check for common patterns
  if (query.includes(' and ') || query.includes('&')) {
    aspects.push(...query.split(/\s+(?:and|&)\s+/).map(s => s.trim()));
  } else if (query.includes(' vs ') || query.includes('versus')) {
    const parts = query.split(/\s+(?:vs|versus)\s+/);
    aspects.push(`Aspect 1: ${parts[0]}`, `Aspect 2: ${parts[1]}`);
  } else {
    aspects.push(query);
  }

  return aspects;
}

/**
 * Orchestrator class for managing multi-agent execution
 * Now integrates with DeterministicTaskAllocator to prevent agent contention
 */
export class Orchestrator {
  private activePlans: Map<string, OrchestratorPlan> = new Map();
  private taskAllocator: DeterministicTaskAllocator;

  constructor() {
    this.taskAllocator = getTaskAllocator();
  }

  createPlan(request: DelegationRequest): OrchestratorPlan {
    const plan = createDelegationPlan(request);
    this.activePlans.set(plan.id, plan);
    return plan;
  }

  getPlan(planId: string): OrchestratorPlan | undefined {
    return this.activePlans.get(planId);
  }

  /**
   * Attempt to allocate a task to an agent
   * Returns allocation result with success/failure reason
   */
  allocateTask(
    planId: string,
    taskId: string,
    agentId: string,
    agentRole: string,
    options: {
      priority?: TaskPriority;
      timeoutMs?: number;
      dependencies?: string[];
    } = {}
  ): AllocationResult {
    const plan = this.activePlans.get(planId);
    if (!plan) {
      return {
        success: false,
        error: 'PLAN_NOT_FOUND'
      };
    }

    const task = plan.tasks.find(t => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: 'TASK_NOT_FOUND'
      };
    }

    // Use deterministic task allocator
    const result = this.taskAllocator.allocate({
      taskId,
      agentId,
      agentRole,
      priority: options.priority || 'normal',
      timeoutMs: options.timeoutMs,
      dependencies: options.dependencies,
      metadata: {
        planId,
        objective: task.objective
      }
    });

    if (result.success && result.allocation) {
      // Update task with allocation info
      task.assignedAgentId = agentId;
      task.allocationId = result.allocation.taskId;
      task.status = 'running';
    }

    return result;
  }

  /**
   * Release a task allocation
   */
  releaseTask(
    planId: string,
    taskId: string,
    agentId: string,
    reason: 'completed' | 'failed' | 'timeout' | 'manual',
    result?: string
  ): ReleaseResult {
    const plan = this.activePlans.get(planId);
    if (!plan) {
      return { success: false, error: 'PLAN_NOT_FOUND' };
    }

    const task = plan.tasks.find(t => t.id === taskId);
    
    const releaseResult = this.taskAllocator.release({
      taskId,
      ownerId: agentId,
      reason,
      result
    });

    if (releaseResult.success && task) {
      task.status = reason === 'completed' ? 'completed' : 'failed';
      if (result) task.result = result;
    }

    return releaseResult;
  }

  /**
   * Check if a task can be allocated (not already owned by another agent)
   */
  canAllocateTask(taskId: string): boolean {
    return this.taskAllocator.isAllocatable(taskId);
  }

  /**
   * Get agent's current workload
   */
  getAgentWorkload(agentId: string): number {
    return this.taskAllocator.getAgentWorkload(agentId);
  }

  /**
   * Get queue status
   */
  getQueueStatus() {
    return this.taskAllocator.getQueueStatus();
  }

  updateTaskStatus(
    planId: string,
    taskId: string,
    status: SubagentTask['status'],
    result?: string
  ): void {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    const task = plan.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      if (result) task.result = result;
    }
  }

  getCompletedTasks(planId: string): SubagentTask[] {
    const plan = this.activePlans.get(planId);
    if (!plan) return [];

    return plan.tasks.filter(t => t.status === 'completed');
  }

  isPlanComplete(planId: string): boolean {
    const plan = this.activePlans.get(planId);
    if (!plan) return false;

    return plan.tasks.every(t => t.status === 'completed' || t.status === 'failed');
  }

  clearPlan(planId: string): void {
    const plan = this.activePlans.get(planId);
    if (plan) {
      // Release all active allocations for this plan
      for (const task of plan.tasks) {
        if (task.assignedAgentId && task.status === 'running') {
          this.taskAllocator.release({
            taskId: task.id,
            ownerId: task.assignedAgentId,
            reason: 'manual'
          });
        }
      }
    }
    this.activePlans.delete(planId);
  }

  /**
   * Get allocator statistics for monitoring
   */
  getAllocatorStats() {
    return this.taskAllocator.getQueueStatus();
  }
}

// ============================================================================
// runAgentStep — Guidance-aware single-step agent execution
// ============================================================================

export interface RunAgentStepInput {
  agentId: string;
  missionId: string;
}

export interface RunAgentStepDeps {
  http: {
    fetchJson(url: string): Promise<any>;
    tryFetchJson(url: string): Promise<any>;
    postJson(url: string, body: any): Promise<void>;
    patchJson(url: string, body: any): Promise<void>;
  };
  invokeModel(args: { invocationProfile: any; context: string }): Promise<{
    summary: string;
    logs?: string[];
    missionPatch?: any;
    decisions?: { title: string; content: string }[];
    agentStatePatch?: any;
  }>;
}

const WRITE_OPS_MATRIX: Record<string, string[]> = {
  ALLOW_EXECUTION: ['WRITE_LOG', 'WRITE_MEMORY', 'UPDATE_MISSION_STATUS', 'UPDATE_MISSION_FIELDS', 'UPDATE_AGENT_STATE'],
  PROPOSE_ONLY: ['WRITE_LOG', 'WRITE_MEMORY'],
  REQUIRE_APPROVAL: ['WRITE_LOG', 'WRITE_MEMORY'],
  DENY: [],
};

function isOpAllowed(disposition: string, op: string): boolean {
  return (WRITE_OPS_MATRIX[disposition] ?? []).includes(op);
}

/**
 * Execute a single agent step using framework guidance (if available) or
 * falling back to local strategy/profile calculation.
 *
 * Enforces a write-back matrix: the invocation profile's disposition
 * controls which side-effects (logs, memory, mission patches, agent state)
 * are actually persisted.
 */
export async function runAgentStep(
  input: RunAgentStepInput,
  deps: RunAgentStepDeps,
): Promise<string> {
  // 1. Fetch run context
  const runContext = await deps.http.fetchJson(`/runs/${input.missionId}/context`);
  const embeddedGuidance = runContext.guidance ?? null;

  // 2. Always try guidance endpoint
  const explicitGuidance = await deps.http.tryFetchJson(`/runs/${input.missionId}/guidance`);
  const guidance = explicitGuidance ?? embeddedGuidance;

  // 3. Determine invocation profile — use guidance only when agentId matches
  let invocationProfile: any;
  let strategy: any;

  if (guidance?.invocationProfile?.agentId === input.agentId) {
    invocationProfile = guidance.invocationProfile;
    strategy = guidance.strategy;
  } else {
    // Fallback: compute locally
    strategy = guidance?.strategy ?? { kind: 'MANUAL_APPROVAL_GATE' };
    invocationProfile = {
      agentId: input.agentId,
      disposition: 'REQUIRE_APPROVAL',
      intent: 'PROPOSE',
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
      forbiddenOperations: [],
    };
  }

  // 4. Build model context
  const contextParts = [
    `strategyKind: ${strategy.kind}`,
    `effectiveIntent: ${invocationProfile.intent}`,
    `primaryAgentId: ${invocationProfile.agentId}`,
  ];
  if (runContext.slimSnapshot) {
    contextParts.push(`focusMission: ${input.missionId}`);
  }
  if (invocationProfile.allowedOperations) {
    contextParts.push(`allowedOperations: ${invocationProfile.allowedOperations.join(', ')}`);
  }
  const context = contextParts.join('\n');

  // 5. Invoke model
  const result = await deps.invokeModel({ invocationProfile, context });

  // 6. Enforce write-back matrix
  const disposition = invocationProfile.disposition ?? 'PROPOSE_ONLY';
  const projectId = runContext.projectId ?? 'project-war-room';

  // Logs — WRITE_LOG
  if (isOpAllowed(disposition, 'WRITE_LOG') && result.logs?.length) {
    for (const message of result.logs) {
      await deps.http.postJson(`/missions/${input.missionId}/logs`, { message });
    }
  }

  // Memory — WRITE_MEMORY
  if (isOpAllowed(disposition, 'WRITE_MEMORY') && result.decisions?.length) {
    for (const decision of result.decisions) {
      await deps.http.postJson(`/projects/${projectId}/memory`, {
        title: decision.title,
        content: decision.content,
      });
    }
  }

  // Mission patch — UPDATE_MISSION_STATUS / UPDATE_MISSION_FIELDS
  if (isOpAllowed(disposition, 'UPDATE_MISSION_STATUS') && result.missionPatch) {
    await deps.http.patchJson(`/missions/${input.missionId}`, result.missionPatch);
  }

  // Agent state patch — UPDATE_AGENT_STATE
  if (isOpAllowed(disposition, 'UPDATE_AGENT_STATE') && result.agentStatePatch) {
    await deps.http.patchJson(`/projects/${projectId}/agents/${input.agentId}/state`, result.agentStatePatch);
  }

  return result.summary;
}
