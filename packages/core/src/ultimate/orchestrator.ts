import type {
  UltimateExecutionContext,
  UltimateExecutionResult,
  UltimateOrchestratorConfig,
  UltimateMetrics,
  ExecutionError,
  OrchestrationTopology,
  EffortLevel,
  DeliberationPlan,
  TaskTreeNode,
  ArtifactReference,
} from './types';
import { DEFAULT_ULTIMATE_CONFIG } from './types';
import type { ModelTier, TokenUsage } from '../runtime/types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';
import { getModelRouter } from '../runtime/modelRouter';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { deliberate, deliberateWithLLM } from './deliberation';
import { RecursiveAtomizer } from './atomizer';
import { TopologyRouter } from './topologyRouter';
import { SubAgentExecutor } from './subAgentExecutor';
import { MultiAgentSynthesizer } from './synthesizer';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { CapabilityRegistry, getCapabilityRegistry } from './capabilityRegistry';
import { AgentTeamManager, getTeamManager } from './agentTeamManager';
import { getEffortRules, classifyEffortLevel, selectTopologyForEffort } from './effortScaler';

let executionCounter = 0;

function generateExecId(): string {
  return `ultimate_${Date.now()}_${++executionCounter}`;
}

export class UltimateOrchestrator {
  private config: UltimateOrchestratorConfig;
  private telos: TELOSOrchestrator;
  private runtime: AgentRuntime;
  private atomizer: RecursiveAtomizer;
  private topologyRouter: TopologyRouter;
  private subAgentExecutor: SubAgentExecutor;
  private synthesizer: MultiAgentSynthesizer;
  private artifactSystem: ArtifactSystem;
  private capabilityRegistry: CapabilityRegistry;
  private teamManager: AgentTeamManager;
  private activeExecutions: Map<string, UltimateExecutionContext> = new Map();

  constructor(
    telos: TELOSOrchestrator,
    runtime: AgentRuntime,
    config?: Partial<UltimateOrchestratorConfig>,
    artifactSystem?: ArtifactSystem,
    capabilityRegistry?: CapabilityRegistry,
    teamManager?: AgentTeamManager,
  ) {
    this.config = { ...DEFAULT_ULTIMATE_CONFIG, ...config };
    this.telos = telos;
    this.runtime = runtime;
    this.artifactSystem = artifactSystem ?? getArtifactSystem();
    this.capabilityRegistry = capabilityRegistry ?? getCapabilityRegistry();
    this.teamManager = teamManager ?? getTeamManager();

    this.atomizer = new RecursiveAtomizer(
      this.config.maxRecursiveDepth,
      this.config.maxParallelSubAgents,
    );
    this.topologyRouter = new TopologyRouter();
    this.subAgentExecutor = new SubAgentExecutor(
      runtime,
      this.artifactSystem,
      this.config.maxParallelSubAgents,
    );
    this.synthesizer = new MultiAgentSynthesizer();
  }

  async execute(params: {
    projectId: string;
    agentId: string;
    goal: string;
    contextData?: Record<string, unknown>;
    effortLevel?: EffortLevel;
    topology?: OrchestrationTopology;
    onProgress?: (phase: string, detail: string) => void;
  }): Promise<UltimateExecutionResult> {
    const execId = generateExecId();
    const startTime = Date.now();
    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const errors: ExecutionError[] = [];
    const reasoning: string[] = [];
    const artifactsCreated: ArtifactReference[] = [];

    const emit = (phase: string, detail: string) => {
      bus.publish('agent.started', `ultimate-orch-${execId}`, { phase, detail, execId });
      params.onProgress?.(phase, detail);
    };

    emit('INIT', `Starting execution: ${params.goal.slice(0, 100)}...`);

    const ctx = this.buildContext(execId, params);
    this.activeExecutions.set(execId, ctx);

    // Phase 1: Deliberation (LLM-powered when a provider is registered)
    emit('DELIBERATION', 'Analyzing task requirements...');
    const firstProvider = this.runtime.getProvider('openai') ?? this.runtime.getProvider('anthropic');
    const useLLM = this.config.enableDeliberation && firstProvider !== undefined;
    const deliberation = useLLM
      ? await deliberateWithLLM(params.goal, firstProvider, params.contextData)
      : deliberate(params.goal, params.contextData);
    ctx.deliberation = deliberation;
    reasoning.push(...deliberation.reasoning);
    reasoning.push(`Confidence: ${(deliberation.confidence * 100).toFixed(0)}%`);

    // Phase 2: Effort Scaling
    emit('EFFORT_SCALING', `Classifying effort level...`);
    const effortLevel = params.effortLevel ?? classifyEffortLevel(params.goal, {
      toolCount: (params.contextData?.availableTools as string[] | undefined)?.length,
      riskLevel: (params.contextData?.governanceProfile as Record<string, string> | undefined)?.riskLevel,
    });
    ctx.effortLevel = effortLevel;
    const scalingRules = getEffortRules(effortLevel);
    ctx.scalingRules = scalingRules;
    reasoning.push(`Effort level: ${effortLevel} (${scalingRules.minSubAgents}-${scalingRules.maxSubAgents} agents)`);

    // Phase 3: Topology Routing
    emit('TOPOLOGY_ROUTING', `Selecting orchestration topology...`);
    const topology = params.topology ?? selectTopologyForEffort(effortLevel);
    ctx.topology = topology;
    reasoning.push(`Topology: ${topology}`);

    // Phase 4: Recursive Task Decomposition
    emit('DECOMPOSITION', `Decomposing task into subtasks...`);
    const taskTree = this.atomizer.decompose(
      params.goal,
      deliberation,
      null,
      0,
      (params.contextData?.availableTools as string[] | undefined) ?? [],
    );
    ctx.taskTree = taskTree;
    reasoning.push(`Task tree: ${countNodes(taskTree)} nodes, depth ${measureDepth(taskTree)}`);

    // Phase 5: Team Formation (if topology needs it)
    let teamId: string | null = null;
    if (this.config.enableTeams && taskTree.subtasks.length > 2) {
      emit('TEAM_FORMATION', `Forming agent team...`);
      const members = taskTree.subtasks.map((sub, i) => ({
        agentId: sub.id,
        role: (i === 0 ? 'LEAD' : i % 2 === 0 ? 'RESEARCHER' : 'CODER') as any,
        capabilities: sub.context.availableTools,
        status: 'IDLE' as const,
      }));
      const team = this.teamManager.createTeam(
        `team-${execId.slice(-8)}`,
        members,
        { goal: params.goal, execId },
      );
      teamId = team.id;
      ctx.team = team;
      reasoning.push(`Team formed: ${team.name} (${members.length} members)`);

      for (const sub of taskTree.subtasks) {
        const task = this.teamManager.addTask(team.id, {
          description: sub.goal.slice(0, 200),
          assignedTo: sub.id,
          dependencies: sub.dependencies,
        });
        if (task) {
          this.teamManager.assignTask(team.id, task.id, sub.id);
        }
      }
    }

    // Phase 6: Parallel Execution with team inbox collaboration
    emit('EXECUTION', `Executing ${taskTree.subtasks.length} subtasks...`);
    if (teamId) {
      this.subAgentExecutor.setTeam(teamId);
    }
    await this.subAgentExecutor.executeNode(
      taskTree,
      params.projectId,
      params.contextData ?? {},
      errors,
    );
    this.subAgentExecutor.setTeam(null);

    const completedCount = countCompleted(taskTree);
    const failedCount = countFailed(taskTree);
    reasoning.push(`Execution: ${completedCount} completed, ${failedCount} failed`);

    // Phase 7: Multi-Agent Synthesis
    emit('SYNTHESIS', `Synthesizing results from ${completedCount} completed subtasks...`);
    const allArtifacts = await this.artifactSystem.find({ tags: ['completed'] }, 50);
    const synthesis = await this.synthesizer.synthesize(
      this.config.defaultSynthesisConfig.strategy,
      this.config.defaultSynthesisConfig,
      taskTree,
      allArtifacts,
    );

    reasoning.push(`Synthesis quality: ${(synthesis.qualityScore * 100).toFixed(0)}%`);

    // Phase 8: Quality Gates with auto-fix retry loop
    let finalSynthesis = synthesis.synthesis;
    let finalQualityScore = synthesis.qualityScore;
    let finalGateResults = synthesis.gateResults;
    for (let fixAttempt = 0; fixAttempt < 2; fixAttempt++) {
      const failedGates = finalGateResults.filter(g => !g.passed);
      if (failedGates.length === 0) break;

      const autoFixGate = failedGates.find(g => {
        const gc = this.config.qualityGates.find(c => c.name === g.gate);
        return gc?.autoFix;
      });
      if (!autoFixGate) break;

      reasoning.push(`Quality gate "${autoFixGate.gate}" failed (score: ${(autoFixGate.score * 100).toFixed(0)}%) — auto-fix attempt ${fixAttempt + 1}`);

      // Build a fix prompt targeting the failed gate
      const fixInstructions: string[] = [];
      if (autoFixGate.gate === 'hallucination') {
        fixInstructions.push('Remove unverified claims. Only include information supported by the subtask results. Be precise and factual.');
      }
      if (autoFixGate.gate === 'consistency') {
        fixInstructions.push('Ensure all statements are internally consistent. Resolve contradictions between subtask results.');
      }
      if (autoFixGate.gate === 'completeness') {
        fixInstructions.push('Ensure all key aspects from the subtask results are covered. Do not omit important findings.');
      }
      if (autoFixGate.gate === 'accuracy') {
        fixInstructions.push('Verify all numbers, names, and specific claims against the subtask results.');
      }

      const fixGoal = `Revise the following synthesis to address quality issues.\n\nIssues to fix: ${fixInstructions.join(' ')}\n\nCurrent synthesis:\n${finalSynthesis}`;

      try {
        const fixResult = await this.runtime.execute({
          agentId: `quality-fixer`,
          projectId: params.projectId,
          goal: fixGoal,
          contextData: params.contextData ?? {},
          availableTools: [],
          maxSteps: 3,
          tokenBudget: 4000,
        });

        if (fixResult.status === 'success') {
          const fixedSynth = fixResult.summary;
          if (fixedSynth.length > 50) {
            finalSynthesis = fixedSynth;
            // Re-run quality gates on the fixed synthesis
            const recheck = await this.synthesizer.runQualityGatesStrict(
              this.config.qualityGates.filter(g => g.enabled),
              finalSynthesis,
              taskTree,
            );
            finalGateResults = recheck;
            finalQualityScore = recheck.reduce((acc, g) => acc + (g.passed ? g.score : 0), 0) / Math.max(1, recheck.length);
            reasoning.push(`Auto-fix ${fixAttempt + 1}: quality score ${(finalQualityScore * 100).toFixed(0)}%`);
          }
        }
      } catch (err) {
        reasoning.push(`Auto-fix attempt ${fixAttempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const totalDurationMs = Date.now() - startTime;

    // Collect artifacts
    for (const artifact of allArtifacts) {
      artifactsCreated.push(artifact);
    }

    // Record experience for self-evolution with real metrics
    const allSuccess = errors.filter(e => !e.recovered).length === 0;
    const totalTokens = this.sumTokenUsage(taskTree);
    const lessons: string[] = [];
    for (const gate of synthesis.gateResults) {
      if (!gate.passed) lessons.push(`Quality gate "${gate.gate}" scored ${(gate.score * 100).toFixed(0)}% (threshold: ${(this.config.qualityGates.find(g => g.name === gate.gate)?.threshold ?? 0.7) * 100}%)`);
    }
    if (completedCount > 0 && failedCount > 0) {
      lessons.push(`${failedCount}/${countNodes(taskTree)} subtasks failed - partial completion`);
    }
    getMetaLearner().recordExperience({
      id: `exp-${execId}`,
      runId: execId,
      agentId: params.agentId,
      taskType: topology,
      modelUsed: this.config.modelTierMapping[effortLevel] ?? 'standard',
      strategyUsed: `${effortLevel}_${topology}`,
      success: allSuccess,
      durationMs: totalDurationMs,
      tokenCost: totalTokens,
      lessons,
      timestamp: new Date().toISOString(),
    });

    // Self-optimize: apply meta-learner suggestions after each execution
    this.applyOptimizationSuggestions();

    // Store execution result in vector memory for future retrieval
    try {
      const memory = getGlobalThreeLayerMemory();
      const qualitySummary = synthesis.gateResults.map(g => `${g.gate}=${(g.score * 100).toFixed(0)}%`).join(', ');
      memory.add(
        `[${allSuccess ? 'SUCCESS' : 'FAIL'}] ${params.goal.slice(0, 200)}`,
        'episodic',
        `topology:${topology}|effort:${effortLevel}|quality:${qualitySummary}`,
        allSuccess ? 0.8 : 0.3,
        [topology, effortLevel, allSuccess ? 'success' : 'failure', 'execution'],
        { execId, goal: params.goal.slice(0, 500) },
      );
    } catch {
      // Memory is non-critical
    }

    // Cleanup team
    if (teamId) {
      this.teamManager.disbandTeam(teamId);
    }

    const metrics = this.computeMetrics(
      taskTree,
      startTime,
      topology,
      effortLevel,
      synthesis.qualityScore,
      artifactsCreated.length,
    );

    this.activeExecutions.delete(execId);

    emit('COMPLETE', `Execution ${allSuccess ? 'succeeded' : 'completed with issues'} (${metrics.totalCostUsd.toFixed(4)} USD)`);

    return {
      id: execId,
      status: allSuccess ? 'SUCCESS' : errors.length > 0 ? 'FAILED' : 'PARTIAL',
      summary: `${completedCount}/${countNodes(taskTree)} subtasks completed. ${errors.length} errors.`,
      synthesis: synthesis.synthesis,
      artifacts: artifactsCreated,
      executionTree: flattenTree(taskTree),
      metrics,
      errors,
      reasoning,
    };
  }

  private buildContext(
    execId: string,
    params: {
      projectId: string;
      goal: string;
      contextData?: Record<string, unknown>;
    },
  ): UltimateExecutionContext {
    return {
      id: execId,
      projectId: params.projectId,
      goal: params.goal,
      context: params.contextData ?? {},
      effortLevel: this.config.defaultEffortLevel,
      scalingRules: getEffortRules(this.config.defaultEffortLevel),
      topology: 'SINGLE',
      artifacts: [],
      budget: { ...this.config.defaultBudget },
      thinkingBudget: { ...this.config.defaultThinkingBudget },
      synthesisConfig: { ...this.config.defaultSynthesisConfig },
      governance: {
        requiresApproval: false,
        humanInTheLoop: false,
      },
      maxRetries: 3,
      circuitBreaker: {
        maxErrors: 5,
        cooldownMs: 30000,
        currentErrors: 0,
        tripped: false,
      },
    };
  }

  private computeMetrics(
    taskTree: TaskTreeNode,
    startTime: number,
    topology: OrchestrationTopology,
    effortLevel: EffortLevel,
    qualityScore: number,
    artifactCount: number,
  ): UltimateMetrics {
    const allNodes = flattenTree(taskTree);
    let totalTokens = 0;
    let subAgentCount = 0;

    for (const node of allNodes) {
      if (node.tokenUsage) {
        totalTokens += node.tokenUsage.totalTokens;
      }
      if (node.isAtomic) subAgentCount++;
    }

    return {
      totalTokens,
      totalCostUsd: totalTokens * 0.000015,
      totalDurationMs: Date.now() - startTime,
      llmCalls: subAgentCount * 2,
      toolCalls: subAgentCount * 5,
      subAgentsSpawned: subAgentCount,
      artifactsCreated: artifactCount,
      qualityScore,
      topologyUsed: topology,
      effortLevelUsed: effortLevel,
    };
  }

  getExecution(id: string): UltimateExecutionContext | undefined {
    return this.activeExecutions.get(id);
  }

  listExecutions(): UltimateExecutionContext[] {
    return Array.from(this.activeExecutions.values());
  }

  getConfig(): UltimateOrchestratorConfig {
    return { ...this.config };
  }

  /**
   * Close the meta-learning feedback loop.
   * Reads optimization suggestions from the MetaLearner and applies them
   * to the orchestrator's live config — making the system self-optimizing.
   */
  applyOptimizationSuggestions(): void {
    const suggestions = getMetaLearner().getSuggestions();
    for (const suggestion of suggestions) {
      if (suggestion.confidence < 0.3) continue;

      switch (suggestion.type) {
        case 'model_tier_change': {
          // Adjust model tier mapping: find the effort level using the 'from' model
          for (const [effortLevel, currentModel] of Object.entries(this.config.modelTierMapping)) {
            if (currentModel === suggestion.from) {
              this.config.modelTierMapping[effortLevel as EffortLevel] = suggestion.to as any;
              getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
                type: 'self_optimization',
                change: `model_tier: ${effortLevel} switched from ${suggestion.from} → ${suggestion.to}`,
                confidence: suggestion.confidence,
                evidence: suggestion.evidence,
              });
            }
          }
          break;
        }
        case 'strategy_change': {
          // Adjust topology routing: prefer the suggested topology for compatible effort levels
          const topologyMap: Record<string, OrchestrationTopology> = {
            'SEQUENTIAL': 'SEQUENTIAL',
            'PARALLEL': 'PARALLEL',
            'HIERARCHICAL': 'HIERARCHICAL',
            'HYBRID': 'HYBRID',
          };
          const preferredTopology = topologyMap[suggestion.to];
          if (preferredTopology) {
            getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
              type: 'self_optimization',
              change: `strategy: prefer ${suggestion.to} over ${suggestion.from}`,
              confidence: suggestion.confidence,
              evidence: suggestion.evidence,
            });
          }
          break;
        }
        case 'prompt_template_change': {
          // Adjust quality gate thresholds based on prompt template suggestions
          const gateConfig = this.config.qualityGates.find(g => g.name === suggestion.target);
          if (gateConfig) {
            const thresholdAdjustment = suggestion.confidence * 0.1;
            if (suggestion.to === 'strict') {
              gateConfig.threshold = Math.min(1.0, gateConfig.threshold + thresholdAdjustment);
            } else if (suggestion.to === 'relaxed') {
              gateConfig.threshold = Math.max(0.1, gateConfig.threshold - thresholdAdjustment);
            }
          }
          break;
        }
        case 'tool_change': {
          // Could adjust available tools or tool configurations
          getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
            type: 'self_optimization',
            change: `tool_change: ${suggestion.from} → ${suggestion.to} (confidence: ${suggestion.confidence})`,
            confidence: suggestion.confidence,
            evidence: suggestion.evidence,
          });
          break;
        }
      }
    }
  }

  private sumTokenUsage(taskTree: TaskTreeNode): number {
    let total = 0;
    const nodes = flattenTree(taskTree);
    for (const node of nodes) {
      if (node.tokenUsage) {
        total += node.tokenUsage.totalTokens;
      }
    }
    return total || Math.ceil(taskTree.goal.length / 3.7) * countNodes(taskTree);
  }
}

function countNodes(node: TaskTreeNode): number {
  let count = 1;
  for (const sub of node.subtasks) {
    count += countNodes(sub);
  }
  return count;
}

function measureDepth(node: TaskTreeNode): number {
  if (node.subtasks.length === 0) return 0;
  let maxDepth = 0;
  for (const sub of node.subtasks) {
    maxDepth = Math.max(maxDepth, measureDepth(sub) + 1);
  }
  return maxDepth;
}

function countCompleted(node: TaskTreeNode): number {
  let count = node.status === 'COMPLETED' ? 1 : 0;
  for (const sub of node.subtasks) {
    count += countCompleted(sub);
  }
  return count;
}

function countFailed(node: TaskTreeNode): number {
  let count = node.status === 'FAILED' ? 1 : 0;
  for (const sub of node.subtasks) {
    count += countFailed(sub);
  }
  return count;
}

function flattenTree(node: TaskTreeNode): TaskTreeNode[] {
  const nodes: TaskTreeNode[] = [node];
  for (const sub of node.subtasks) {
    nodes.push(...flattenTree(sub));
  }
  return nodes;
}


