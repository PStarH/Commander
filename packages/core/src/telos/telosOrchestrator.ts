import type { AgentExecutionContext, LLMRequest, TokenUsage } from '../runtime/types';
import { AgentRuntime } from '../runtime/agentRuntime';
import { getModelRouter } from '../runtime/modelRouter';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import type { TELOSPlanContext, TELOSAgentAssignment, TELOSOrchestrationMode, TELOSConfig } from './types';
import { DEFAULT_TELOS_CONFIG } from './types';
import { TokenSentinel, getTokenSentinel } from './tokenSentinel';
import { ProviderPool, getProviderPool } from './providerPool';

function generateId(): string {
  return `telos_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// Task Analysis (cheap, no LLM call)
// ============================================================================

interface TaskProfile {
  mode: TELOSOrchestrationMode;
  complexity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedSubtasks: number;
  requiresConsensus: boolean;
  requiresApproval: boolean;
  reasoning: string[];
}

function analyzeTask(
  goal: string,
  contextData: Record<string, unknown>,
): TaskProfile {
  const reasoning: string[] = [];
  const gov = contextData.governanceProfile as { riskLevel?: string } | undefined;
  const riskLevel = gov?.riskLevel ?? 'LOW';

  let complexity = 0;
  if (goal.length > 500) { complexity += 2; reasoning.push('long goal, +2 complexity'); }
  else if (goal.length > 200) { complexity += 1; reasoning.push('medium goal, +1 complexity'); }

  if (riskLevel === 'CRITICAL') { complexity += 4; reasoning.push('critical risk, +4 complexity'); }
  else if (riskLevel === 'HIGH') { complexity += 3; reasoning.push('high risk, +3 complexity'); }
  else if (riskLevel === 'MEDIUM') { complexity += 1; reasoning.push('medium risk, +1 complexity'); }

  const toolHints = (contextData.availableTools as string[] | undefined)?.length ?? 0;
  if (toolHints > 5) { complexity += 2; reasoning.push(`${toolHints} tools suggested, +2 complexity`); }

  let mode: TELOSOrchestrationMode;
  const level = complexity >= 7 ? 'CRITICAL' : complexity >= 4 ? 'HIGH' : complexity >= 2 ? 'MEDIUM' : 'LOW';

  if (riskLevel === 'CRITICAL') {
    mode = 'CONSENSUS';
    reasoning.push('CRITICAL risk → CONSENSUS mode');
  } else if (level === 'CRITICAL' || level === 'HIGH') {
    mode = 'MAGENTIC';
    reasoning.push(`${level} complexity → MAGENTIC mode`);
  } else if (level === 'MEDIUM' && toolHints > 3) {
    mode = 'HANDOFF';
    reasoning.push('MEDIUM complexity + multiple tools → HANDOFF mode');
  } else if (level === 'MEDIUM') {
    mode = 'PARALLEL';
    reasoning.push('MEDIUM complexity → PARALLEL mode');
  } else {
    mode = 'SEQUENTIAL';
    reasoning.push('LOW complexity → SEQUENTIAL mode');
  }

  return {
    mode,
    complexity: level as TaskProfile['complexity'],
    estimatedSubtasks: Math.max(1, Math.ceil(complexity / 2)),
    requiresConsensus: mode === 'CONSENSUS',
    requiresApproval: riskLevel === 'CRITICAL' || riskLevel === 'HIGH',
    reasoning,
  };
}

// ============================================================================
// Plan Context Builder — builds context ONCE
// ============================================================================

function buildPlanContext(
  projectId: string,
  agentId: string,
  goal: string,
  contextData: Record<string, unknown>,
  profile: TaskProfile,
): TELOSPlanContext {
  const planId = generateId();

  const assignments: TELOSAgentAssignment[] = [];
  const roleMap: Record<TELOSOrchestrationMode, TELOSAgentAssignment['role']> = {
    SEQUENTIAL: 'executor',
    PARALLEL: 'executor',
    HANDOFF: 'lead',
    MAGENTIC: 'lead',
    CONSENSUS: 'voter',
  };

  const tierMap: Record<string, string> = {
    LOW: 'eco',
    MEDIUM: 'standard',
    HIGH: 'power',
    CRITICAL: 'consensus',
  };

  assignments.push({
    agentId,
    role: roleMap[profile.mode] ?? 'executor',
    modelTier: (tierMap[profile.complexity] ?? 'standard') as any,
    subtask: goal,
    dependencies: [],
  });

  // For consensus, add 2 more voters
  if (profile.mode === 'CONSENSUS') {
    for (let i = 0; i < 2; i++) {
      assignments.push({
        agentId: `${agentId}-voter-${i + 1}`,
        role: 'voter',
        modelTier: 'power',
        subtask: `Review and vote on: ${goal.slice(0, 200)}`,
        dependencies: [assignments[0].agentId],
      });
    }
  }

  // Build the system prompt once
  const gov = contextData.governanceProfile as Record<string, unknown> | undefined;
  const systemParts = [
    `You are agent ${agentId} on project ${projectId}.`,
    `Mode: ${profile.mode}. Complexity: ${profile.complexity}.`,
    gov ? `Governance: ${JSON.stringify(gov)}` : '',
    profile.requiresApproval ? 'NOTE: This task requires human approval for final execution.' : '',
  ];
  const systemPrompt = systemParts.filter(Boolean).join('\n');

  // Estimate context tokens
  const goalTokens = Math.ceil(goal.length / 3.7);
  const systemTokens = Math.ceil(systemPrompt.length / 3.7);
  const estimatedContextTokens = goalTokens + systemTokens + 100;

  return {
    planId,
    projectId,
    mode: profile.mode,
    agentAssignments: assignments,
    slimContext: {
      goal,
      systemPrompt,
      availableToolNames: (contextData.availableTools as string[] | undefined) ?? [],
      estimatedContextTokens,
      budget: {
        hardCapTokens: profile.complexity === 'CRITICAL' ? 128000 : profile.complexity === 'HIGH' ? 64000 : 32000,
        softCapTokens: profile.complexity === 'CRITICAL' ? 96000 : profile.complexity === 'HIGH' ? 48000 : 24000,
        costCapUsd: profile.complexity === 'CRITICAL' ? 5.00 : profile.complexity === 'HIGH' ? 2.00 : 0.50,
      },
    },
    governance: {
      riskLevel: profile.complexity,
      governanceMode: profile.requiresApproval ? 'MANUAL' : profile.mode === 'CONSENSUS' ? 'GUARDED' : 'AUTO',
      requiresApproval: profile.requiresApproval,
    },
    reasoning: profile.reasoning,
    createdAt: new Date().toISOString(),
  };
}

// ============================================================================
// TELOS Orchestrator — the unified entry point
// ============================================================================

export class TELOSOrchestrator {
  private runtime: AgentRuntime;
  private sentinel: TokenSentinel;
  private pool: ProviderPool;
  private config: TELOSConfig;
  private activePlans: Map<string, TELOSPlanContext> = new Map();

  constructor(
    runtime: AgentRuntime,
    config?: Partial<TELOSConfig>,
    sentinel?: TokenSentinel,
    pool?: ProviderPool,
  ) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_TELOS_CONFIG, ...config };
    this.sentinel = sentinel ?? getTokenSentinel();
    this.pool = pool ?? getProviderPool();
  }

  getConfig(): TELOSConfig {
    return { ...this.config };
  }

  // ========================================================================
  // Plan — analyze + build context (NO LLM call)
  // ========================================================================

  plan(params: {
    projectId: string;
    agentId: string;
    goal: string;
    contextData?: Record<string, unknown>;
  }): TELOSPlanContext {
    const profile = analyzeTask(params.goal, params.contextData ?? {});
    const plan = buildPlanContext(
      params.projectId,
      params.agentId,
      params.goal,
      params.contextData ?? {},
      profile,
    );

    this.activePlans.set(plan.planId, plan);

    // Publish plan event
    getMessageBus().publish('agent.message', 'telos-orchestrator', {
      type: 'plan_created',
      planId: plan.planId,
      mode: plan.mode,
      complexity: profile.complexity,
    });

    return plan;
  }

  // ========================================================================
  // Preflight — check budget BEFORE executing (token-safe gate)
  // ========================================================================

  preflight(planId: string): { allowed: boolean; reason?: string } {
    const plan = this.activePlans.get(planId);
    if (!plan) return { allowed: false, reason: 'plan not found' };

    const sentinelCheck = this.sentinel.check(
      [
        { role: 'system', content: plan.slimContext.systemPrompt },
        { role: 'user', content: plan.slimContext.goal },
      ],
      'claude-3-5-sonnet',
      plan.slimContext.budget,
    );

    if (!sentinelCheck.allowed) {
      return { allowed: false, reason: sentinelCheck.reason };
    }

    const costCheck = this.sentinel.checkCostBudget(planId);
    if (costCheck) {
      return { allowed: false, reason: costCheck.message };
    }

    return { allowed: true };
  }

  // ========================================================================
  // Execute — run the plan with token-safe execution
  // ========================================================================

  async execute(
    planId: string,
  ): Promise<{
    status: 'success' | 'failed' | 'cancelled';
    results: Array<{ agentId: string; summary: string; status: string }>;
    totalCostUsd: number;
    totalTokens: number;
    error?: string;
  }> {
    const plan = this.activePlans.get(planId);
    if (!plan) {
      return { status: 'failed', results: [], totalCostUsd: 0, totalTokens: 0, error: 'plan not found' };
    }

    // Preflight check (budget gate)
    const check = this.preflight(planId);
    if (!check.allowed) {
      return {
        status: 'cancelled',
        results: [],
        totalCostUsd: 0,
        totalTokens: 0,
        error: check.reason ?? 'preflight check failed',
      };
    }

    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const router = getModelRouter();
    const results: Array<{ agentId: string; summary: string; status: string }> = [];
    let totalCostUsd = 0;
    let totalTokens = 0;

    bus.publish('agent.started', 'telos-orchestrator', {
      planId,
      mode: plan.mode,
      assignments: plan.agentAssignments.length,
    });

    // Execute each assignment
    for (const assignment of plan.agentAssignments) {
      tracer.startRun(planId, assignment.agentId);

      const routing = router.route({
        agentId: assignment.agentId,
        projectId: plan.projectId,
        goal: assignment.subtask,
        contextData: {
          governanceProfile: plan.governance,
        },
        availableTools: plan.slimContext.availableToolNames,
        maxSteps: 10,
        tokenBudget: plan.slimContext.budget.hardCapTokens,
      });

      const request: LLMRequest = {
        model: routing.modelId,
        messages: [
          { role: 'system', content: plan.slimContext.systemPrompt },
          { role: 'user', content: assignment.subtask },
        ],
        maxTokens: routing.maxTokens,
      };

      // Token check before sending
      const tokenCheck = this.sentinel.check(
        request.messages,
        routing.modelId,
        plan.slimContext.budget,
      );
      if (!tokenCheck.allowed) {
        tracer.recordDecision(planId, `TOKEN_BUDGET_EXCEEDED for ${assignment.agentId}: ${tokenCheck.reason}`, 0);
        results.push({ agentId: assignment.agentId, summary: '', status: 'cancelled' });
        continue;
      }

      tracer.recordDecision(planId, `Routing ${assignment.agentId} → ${routing.modelId} (${routing.tier})`, 0);

      // Execute via runtime
      try {
        const ctx: AgentExecutionContext = {
          agentId: assignment.agentId,
          projectId: plan.projectId,
          goal: assignment.subtask,
          contextData: {
            governanceProfile: plan.governance,
          },
          availableTools: plan.slimContext.availableToolNames,
          maxSteps: 10,
          tokenBudget: plan.slimContext.budget.hardCapTokens,
        };

        const execResult = await this.runtime.execute(ctx);

        // Track cost
        if (execResult.status === 'success') {
          this.sentinel.recordCostFromUsage(
            planId,
            assignment.agentId,
            execResult.steps[0]?.tokenUsage ? 'claude-3-5-sonnet' : routing.modelId,
            execResult.totalTokenUsage,
          );
        }

        totalCostUsd += 0;
        totalTokens += execResult.totalTokenUsage.totalTokens;
        results.push({
          agentId: assignment.agentId,
          summary: execResult.summary,
          status: execResult.status,
        });

        tracer.completeRun(planId);
      } catch (err) {
        tracer.recordError(planId, `Execution failed for ${assignment.agentId}: ${err}`, 0);
        results.push({ agentId: assignment.agentId, summary: '', status: 'failed' });
      }
    }

    // Get final cost
    const costSummary = this.sentinel.getCostSummary();
    totalCostUsd = costSummary.totalCostUsd;

    // Record experience
    getMetaLearner().recordExperience({
      id: `exp-${planId}`,
      runId: planId,
      agentId: 'telos-orchestrator',
      taskType: plan.mode,
      modelUsed: 'multiple',
      strategyUsed: plan.mode,
      success: results.every(r => r.status === 'success'),
      durationMs: 0,
      tokenCost: totalTokens,
      lessons: [],
      timestamp: new Date().toISOString(),
    });

    bus.publish('agent.completed', 'telos-orchestrator', {
      planId,
      mode: plan.mode,
      results: results.length,
      totalCostUsd,
      totalTokens,
    });

    const allSuccess = results.every(r => r.status === 'success');
    return {
      status: allSuccess ? 'success' : 'failed',
      results,
      totalCostUsd,
      totalTokens,
    };
  }

  // ========================================================================
  // Plan + Execute combined (common case)
  // ========================================================================

  async planAndExecute(params: {
    projectId: string;
    agentId: string;
    goal: string;
    contextData?: Record<string, unknown>;
  }): Promise<{
    plan: TELOSPlanContext;
    status: 'success' | 'failed' | 'cancelled';
    results: Array<{ agentId: string; summary: string; status: string }>;
    totalCostUsd: number;
    totalTokens: number;
  }> {
    const plan = this.plan(params);
    const execution = await this.execute(plan.planId);
    return { plan, ...execution };
  }

  getPlan(planId: string): TELOSPlanContext | undefined {
    return this.activePlans.get(planId);
  }

  listPlans(): TELOSPlanContext[] {
    return Array.from(this.activePlans.values());
  }

  getSentinel(): TokenSentinel {
    return this.sentinel;
  }
}
