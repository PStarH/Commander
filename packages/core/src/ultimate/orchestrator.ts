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
  TaskDAG,
  TaskDAGNode,
  TaskDAGEdge,
} from './types';
import { DEFAULT_ULTIMATE_CONFIG } from './types';
import type { ModelTier, TokenUsage } from '../runtime/types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';
import { getModelRouter } from '../runtime/modelRouter';
import { getMetaLearner, DEFAULT_META_LEARNER_CONFIG } from '../selfEvolution/metaLearner';
import { TrajectoryAnalyzer } from '../selfEvolution/trajectoryAnalyzer';
import { getEvolverAgent } from '../selfEvolution/evolverAgent';
import type { LLMProvider, AnalysisMode, ExecutionExperience, FailureCategory } from '../runtime/types';
import type { OptimizationAction } from './topologyOptimizer';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { deliberate, deliberateWithLLM } from './deliberation';
import { RecursiveAtomizer } from './atomizer';
import { TopologyRouter } from './topologyRouter';
import { SubAgentExecutor } from './subAgentExecutor';
import { MultiAgentSynthesizer } from './synthesizer';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { CapabilityRegistry, getCapabilityRegistry } from './capabilityRegistry';
import { AgentTeamManager, getTeamManager } from './agentTeamManager';
import { getEffortRules, classifyEffortLevel } from './effortScaler';
import { ReflexionTopologicalOptimizer } from './topologyOptimizer';
import { getEvolutionEngine } from '../runtime/evolutionaryWorkflowEngine';
import { COST_PER_TOKEN } from '../config/constants';
import { getGlobalLogger } from '../logging';

function generateExecId(counter: { value: number }): string {
  return `ultimate_${Date.now()}_${++counter.value}`;
}

/** Quality score threshold below which auto-fix attempts are worthwhile */
const QUALITY_FIX_THRESHOLD = 0.7;

/** Maximum auto-fix attempts for quality gate failures */
const MAX_FIX_ATTEMPTS = 2;

/** Token budget for quality fix agent (targeted fixes, not full regeneration) */
const QUALITY_FIX_TOKEN_BUDGET = 2000;

/** Maximum steps for quality fix agent */
const QUALITY_FIX_MAX_STEPS = 2;

/** Minimum synthesis length to accept a fix result */
const MIN_FIX_RESULT_LENGTH = 50;

/** Minimum ratio of agent-written content to synthesis to prefer agent output */
const AGENT_CONTENT_PREF_RATIO = 1.2;

/** Minimum agent-written file size to consider */
const MIN_AGENT_FILE_SIZE = 200;

/** Buffer time in ms before execution start for file modification detection */
const FILE_DETECTION_BUFFER_MS = 1000;

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
   private topologyOptimizer: ReflexionTopologicalOptimizer;
   private evolutionEngine: ReturnType<typeof getEvolutionEngine> | null = null;
   private activeExecutions: Map<string, UltimateExecutionContext> = new Map();
   private executionCounter = { value: 0 };

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
     this.topologyOptimizer = new ReflexionTopologicalOptimizer();
     this.evolutionEngine = getEvolutionEngine();
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
    const execId = generateExecId(this.executionCounter);
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

    try {
    // Phase 1: Deliberation (LLM-powered when a provider is registered)
     emit('DELIBERATION', 'Analyzing task requirements...');
     const firstProvider = this.runtime.getProvider('openai')
       ?? this.runtime.getProvider('anthropic')
       ?? this.runtime.getProvider('openrouter')
       ?? this.runtime.getProvider('mimo')
       ?? this.runtime.getProvider('deepseek')
       ?? this.runtime.getProvider('glm')
       ?? this.runtime.getProvider('xiaomi')
       ?? this.runtime.getProvider('google');
     const useLLM = this.config.enableDeliberation && firstProvider !== undefined;
     const deliberation = useLLM
       ? await deliberateWithLLM(params.goal, firstProvider, params.contextData)
       : deliberate(params.goal, params.contextData);
    ctx.deliberation = deliberation;
    reasoning.push(...deliberation.reasoning);
    reasoning.push(`Confidence: ${(deliberation.confidence * 100).toFixed(0)}%`);

    // Phase 2: Effort Scaling — reuse from deliberation when available to avoid redundant classification
    emit('EFFORT_SCALING', `Classifying effort level...`);
    const effortLevel = params.effortLevel
      ?? deliberation.effortLevel
      ?? classifyEffortLevel(params.goal, {
        toolCount: (params.contextData?.availableTools as string[] | undefined)?.length,
        riskLevel: (params.contextData?.governanceProfile as Record<string, string> | undefined)?.riskLevel,
      });
    ctx.effortLevel = effortLevel;
    const scalingRules = getEffortRules(effortLevel);
    ctx.scalingRules = scalingRules;
    reasoning.push(`Effort level: ${effortLevel} (${scalingRules.minSubAgents}-${scalingRules.maxSubAgents} agents)`);

// Phase 3: Topology Routing — use DAG-aware router when available
     emit('TOPOLOGY_ROUTING', `Selecting orchestration topology...`);
     // Build DAG from deliberation for topology-aware routing
     const taskDAG = this.buildDAGFromDeliberation(deliberation);
     const topologyResult = this.topologyRouter.route(deliberation, taskDAG);
     const topology = params.topology
       ?? (useLLM && deliberation.recommendedTopology ? deliberation.recommendedTopology : topologyResult.topology);
     ctx.topology = topology;
     ctx.taskDAG = taskDAG;
     reasoning.push(...topologyResult.reasoning);
     reasoning.push(`Topology: ${topology}${useLLM && deliberation.recommendedTopology ? ' (from LLM deliberation)' : ` (from router, expected cost: $${topologyResult.expectedCost.toFixed(4)})`}`);

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
        role: (i === 0 ? 'LEAD' as const : i % 2 === 0 ? 'RESEARCHER' as const : 'CODER' as const),
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

     // Compute execution metrics early for Phase 7.5 optimization
     const totalDurationMs = Date.now() - startTime;
     const allSuccess = errors.every(e => e.recovered);
     const totalTokens = this.sumTokenUsage(taskTree);

     // Phase 7.5: Post-Execution Reflexion Topology Optimization
     if (this.config.enableDeliberation) {
       try {
         const optimizationResult = await this.topologyOptimizer.optimize(
           {
             modelUsed: this.config.modelTierMapping[effortLevel] ?? 'standard',
             success: allSuccess,
             durationMs: totalDurationMs,
             tokenCost: totalTokens,
             taskType: topology,
             strategyUsed: `${effortLevel}_${topology}`,
             lessons: reasoning.slice(-5),
             timestamp: new Date().toISOString(),
             id: `exp-${execId}`,
             runId: execId,
             agentId: params.agentId,
            },
            taskTree,
            ctx,
         );
         if (optimizationResult.proposal.actions.length > 0) {
           reasoning.push(`Topology optimized: ${optimizationResult.proposal.actions.length} actions`);
           const topologyAction = optimizationResult.proposal.actions.find((a: OptimizationAction) => a.type === 'change_topology');
if (topologyAction && 'to' in topologyAction) {
              ctx.topology = topologyAction.to as OrchestrationTopology;
            }
         }
       } catch (e) {
         reasoning.push(`Topology optimization skipped: ${e instanceof Error ? e.message : 'unknown'}`);
       }
     }

     // Phase 8: Quality Gates with Reflexion-inspired auto-fix retry loop
    // Optimized: early exit when score doesn't improve, reduced token budget for fixes
    let finalSynthesis = synthesis.synthesis;
    let finalQualityScore = synthesis.qualityScore;
    let finalGateResults = synthesis.gateResults;
    let previousAttemptSynth = '';
    let previousAttemptScore = 0;
    for (let fixAttempt = 0; fixAttempt < MAX_FIX_ATTEMPTS; fixAttempt++) {
      const failedGates = finalGateResults.filter(g => !g.passed);
      if (failedGates.length === 0) break;

      // Early exit: if score is already above threshold, don't burn tokens on marginal improvements
      if (finalQualityScore >= QUALITY_FIX_THRESHOLD && fixAttempt > 0) break;

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

      // Reflexion: Include context about previous failed attempts to prevent repeated mistakes
      let reflexionContext = '';
      if (previousAttemptSynth && previousAttemptScore <= finalQualityScore) {
        reflexionContext = `\n\nPrevious fix attempt scored ${(previousAttemptScore * 100).toFixed(0)}% but failed to pass the same gate. Do NOT repeat the same approach. Try a different strategy.`;
      }

      const fixGoal = `Revise the following synthesis to address quality issues.\n\nIssues to fix: ${fixInstructions.join(' ')}${reflexionContext}\n\nCurrent synthesis:\n${finalSynthesis}`;

      // Store current state before fix for comparison
      previousAttemptSynth = finalSynthesis;
      previousAttemptScore = finalQualityScore;

      try {
        const fixResult = await this.runtime.execute({
          agentId: `quality-fixer`,
          projectId: params.projectId,
          goal: fixGoal,
          contextData: params.contextData ?? {},
          availableTools: [],
          maxSteps: QUALITY_FIX_MAX_STEPS,
          tokenBudget: QUALITY_FIX_TOKEN_BUDGET,
        });

        if (fixResult.status === 'success') {
          const fixedSynth = fixResult.summary;
          if (fixedSynth.length > MIN_FIX_RESULT_LENGTH && fixedSynth !== previousAttemptSynth) {
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

            // Early exit: if fix didn't improve score, don't waste another attempt
            if (finalQualityScore <= previousAttemptScore) {
              reasoning.push(`Auto-fix ${fixAttempt + 1}: no score improvement, stopping fix loop`);
              break;
            }
          } else {
            reasoning.push(`Auto-fix ${fixAttempt + 1}: produced identical output, skipping`);
          }
        }
      } catch (err) {
        reasoning.push(`Auto-fix attempt ${fixAttempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Collect artifacts
    for (const artifact of allArtifacts) {
      artifactsCreated.push(artifact);
    }

    // Record experience for self-evolution with real metrics
    const lessons: string[] = [];
    for (const gate of finalGateResults) {
      if (!gate.passed) lessons.push(`Quality gate "${gate.gate}" scored ${(gate.score * 100).toFixed(0)}% (threshold: ${(this.config.qualityGates.find(g => g.name === gate.gate)?.threshold ?? 0.7) * 100}%)`);
    }
    if (completedCount > 0 && failedCount > 0) {
      lessons.push(`${failedCount}/${countNodes(taskTree)} subtasks failed - partial completion`);
    }
    const exp: ExecutionExperience = {
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
    };
    getMetaLearner().recordExperience(exp);

    // Self-optimize: apply meta-learner suggestions after each execution
    this.applyOptimizationSuggestions(exp);

    // Unified trajectory analysis + evolution cycle (deduplicated: single TrajectoryAnalyzer call)
    if (!allSuccess) {
      this.analyzeAndEvolve(exp, effortLevel, topology).catch(e =>
        getGlobalLogger().warn('UltimateOrchestrator', 'Trajectory analysis/evolution failed', { error: (e as Error)?.message }),
      );
    }

    try {
      const { MetaLearnerBridge, getSkillSystem } = await import('../skills');
      const bridge = new MetaLearnerBridge(getMetaLearner(), getSkillSystem().manager);
      const newSkills = await bridge.extractSkills();
      if (newSkills.length > 0) {
        bus.publish('skills.created', 'ultimate-orch', {
          skills: newSkills.map(s => s.name),
          execId,
        });
      }
    } catch (e) {
      getGlobalLogger().warn('UltimateOrchestrator', 'Skill extraction failed', { error: (e as Error)?.message });
    }

// Store execution result in vector memory for future retrieval
    try {
       const memory = getGlobalThreeLayerMemory();
       const qualitySummary = finalGateResults.map(g => `${g.gate}=${(g.score * 100).toFixed(0)}%`).join(', ');
       memory.add(
         `[${allSuccess ? 'SUCCESS' : 'FAIL'}] ${params.goal.slice(0, 200)}`,
        'episodic',
        `topology:${topology}|effort:${effortLevel}|quality:${qualitySummary}`,
        allSuccess ? 0.8 : 0.3,
        [topology, effortLevel, allSuccess ? 'success' : 'failure', 'execution'],
        { execId, goal: params.goal.slice(0, 500) },
      );
    } catch (e) {
      getGlobalLogger().warn('UltimateOrchestrator', 'Memory write failed', { error: (e as Error)?.message });
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
      finalQualityScore,
      artifactsCreated.length,
    );

    // Collect actual file content written by agents during execution.
    // Agents may write to workspace files, /tmp/, or per-agent output dirs.
    let finalOutput = finalSynthesis;
    try {
      const fs = await import('fs');
      const path = await import('path');
      const workspace = process.env.COMMANDER_WORKSPACE || process.cwd();
      const startTimeMs = startTime - FILE_DETECTION_BUFFER_MS;

      const agentWrittenFiles: Array<{ path: string; content: string; size: number }> = [];
      const seenPaths = new Set<string>();

      const tryAddFile = (fullPath: string): void => {
        if (seenPaths.has(fullPath)) return;
        try {
          if (!fs.existsSync(fullPath)) return;
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= startTimeMs && stat.size > MIN_AGENT_FILE_SIZE) {
            seenPaths.add(fullPath);
            agentWrittenFiles.push({
              path: fullPath,
              content: fs.readFileSync(fullPath, 'utf-8'),
              size: stat.size,
            });
          }
        } catch { /* ignore */ }
      }

      // Method 1: Extract absolute file paths from node results
      // Look for paths like /tmp/compare-*.md, /tmp/report.md, etc.
      const completedNodes = this.collectCompletedNodes(taskTree);
      for (const node of completedNodes) {
        const resultText = node.fullSubtaskResults || node.result || '';
        // Match absolute paths with known extensions
        const absPathMatches = resultText.matchAll(/(?:^|\s)(\/[\w./-]+\.(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql))(?:\s|$|[.,:])/gm);
        for (const match of absPathMatches) {
          tryAddFile(match[1]);
        }
        // Match relative file names (workspace-relative)
        const relPathMatches = resultText.matchAll(/(?:[\w.-]+\.(?:md|txt|json|ts|js|py|html|css|yaml|yml))/g);
        for (const match of relPathMatches) {
          tryAddFile(path.join(workspace, match[0]));
        }
      }

      // Method 2: Extract target file path from the goal itself
      const goalFilePath = extractOutputFilePath(params.goal);
      if (goalFilePath) {
        const resolvedGoal = goalFilePath.startsWith('/') || goalFilePath.startsWith('~')
          ? goalFilePath.replace(/^~/, process.env.HOME || '')
          : path.join(workspace, goalFilePath);
        tryAddFile(resolvedGoal);
      }

      // Method 3: Scan workspace root for files created during execution
      try {
        const entries = fs.readdirSync(workspace, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!['.md', '.txt', '.json', '.ts', '.js', '.py'].includes(ext)) continue;
          if (entry.name.startsWith('.') || entry.name === 'package.json') continue;
          tryAddFile(path.join(workspace, entry.name));
        }
      } catch { /* ignore */ }

      // Method 4: Scan /tmp/ for files matching goal patterns
      try {
        const tmpFiles = fs.readdirSync('/tmp', { withFileTypes: true });
        for (const entry of tmpFiles) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!['.md', '.txt', '.json'].includes(ext)) continue;
          if (entry.name.startsWith('.') || entry.name.length < 5) continue;
          tryAddFile(path.join('/tmp', entry.name));
        }
      } catch { /* ignore */ }

      // Method 5: Scan per-agent output directories
      try {
        const commanderOutputDir = path.join(workspace, '.commander_output');
        if (fs.existsSync(commanderOutputDir)) {
          const agentDirs = fs.readdirSync(commanderOutputDir, { withFileTypes: true });
          for (const agentDir of agentDirs) {
            if (!agentDir.isDirectory()) continue;
            const agentPath = path.join(commanderOutputDir, agentDir.name);
            try {
              const files = fs.readdirSync(agentPath, { withFileTypes: true });
              for (const file of files) {
                if (!file.isFile()) continue;
                tryAddFile(path.join(agentPath, file.name));
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      // If agents wrote substantial content, use that instead of truncated synthesis
      const totalAgentContent = agentWrittenFiles.reduce((s, f) => s + f.size, 0);
      if (totalAgentContent > finalSynthesis.length * AGENT_CONTENT_PREF_RATIO && agentWrittenFiles.length > 0) {
        const combined = agentWrittenFiles
          .sort((a, b) => b.size - a.size)
          .map(f => f.content)
          .join('\n\n---\n\n');
        finalOutput = combined;
        reasoning.push(`Combined ${agentWrittenFiles.length} agent-written files (${totalAgentContent} bytes) instead of synthesis (${finalSynthesis.length} bytes)`);
      }

      // Aggressive fallback: collect ALL available data, but only use if larger
      {
        const allResults: string[] = [];
        const allNodes = flattenTree(taskTree);
        for (const n of allNodes) {
          if (n.status !== 'COMPLETED') continue;
          const content = n.fullSubtaskResults || n.result;
          if (content && content.length > 10) {
            allResults.push(`### ${n.goal.slice(0, 150)}\n\n${content}`);
          }
        }
        for (const artifact of allArtifacts) {
          if (artifact.content && artifact.content.length > 50) {
            allResults.push(`### Artifact: ${artifact.title}\n\n${artifact.content}`);
          }
        }
        if (allResults.length > 0) {
          const combinedAll = allResults.join('\n\n---\n\n');
          // Only use combined version if it's larger than current output
          if (combinedAll.length > finalOutput.length) {
            finalOutput = `# Complete Results\n\n${combinedAll}`;
            reasoning.push(`Combined ${allResults.length} data sources (${finalOutput.length} bytes)`);
          }
        }
      }

      // Output generator: if output is STILL thin, run a dedicated agent that
      // reads files and produces detailed output (like Claude Code does)
      if (finalOutput.length < 5000) {
        try {
          const outputGoal = [
            `You are an expert analyst. Your job is to produce a comprehensive, detailed output.`,
            ``,
            `TASK: ${params.goal}`,
            ``,
            `INSTRUCTIONS:`,
            `1. Use file_read to read ALL relevant source files mentioned in the task`,
            `2. Analyze each file in detail — include specific code snippets, line numbers, and examples`,
            `3. Produce a comprehensive analysis with clear headers and sections`,
            `4. Include actionable recommendations with code examples`,
            `5. Write at least 2000 words of substantive content`,
            `6. If the task asks to write to a file, use file_write to write the complete output`,
            `7. Do NOT just describe what you will do — actually read the files and produce the analysis`,
          ].join('\n');

          const outputResult = await this.runtime.execute({
            agentId: `output-generator-${execId}`,
            projectId: params.projectId,
            goal: outputGoal,
            contextData: params.contextData ?? {},
            availableTools: (params.contextData?.availableTools as string[]) || [],
            maxSteps: 15,
            tokenBudget: 80000,
          });

          if (outputResult.status === 'success' && outputResult.summary.length > finalOutput.length) {
            finalOutput = outputResult.summary;
            reasoning.push(`Output generator: produced ${finalOutput.length} bytes`);
          }
        } catch (e) {
          reasoning.push(`Output generator failed: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }
    } catch (e) {
      reasoning.push(`Agent file collection failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    // Write synthesis output to target file if the goal specifies one.
    // Always write to ensure the file has the full synthesized content.
    try {
      const fileIntent = extractOutputFilePath(params.goal);
      if (fileIntent) {
        const fs = await import('fs');
        const path = await import('path');
        const resolvedPath = fileIntent.startsWith('/') || fileIntent.startsWith('~')
          ? fileIntent
          : `${process.cwd()}/${fileIntent}`;
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, finalOutput, 'utf-8');
        reasoning.push(`Wrote synthesis output (${finalOutput.length} bytes) to ${resolvedPath}`);
      }
    } catch (e) {
      reasoning.push(`File write failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    emit('COMPLETE', `Execution ${allSuccess ? 'succeeded' : 'completed with issues'} (${metrics.totalCostUsd.toFixed(4)} USD)`);

    return {
      id: execId,
      status: allSuccess ? 'SUCCESS' : errors.length > 0 ? 'FAILED' : 'PARTIAL',
      summary: `${completedCount}/${countNodes(taskTree)} subtasks completed. ${errors.length} errors.`,
      synthesis: finalSynthesis,
      artifacts: artifactsCreated,
      executionTree: flattenTree(taskTree),
      metrics,
      errors,
      reasoning,
    };
    } finally {
      this.activeExecutions.delete(execId);
    }
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
      totalCostUsd: totalTokens * COST_PER_TOKEN,
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
   * When an experience is provided, creates a falsifiable prediction for each strategy change.
   */
  applyOptimizationSuggestions(exp?: ExecutionExperience): void {
    const suggestions = getMetaLearner().getSuggestions();
    for (const suggestion of suggestions) {
      if (suggestion.confidence < 0.3) continue;

      switch (suggestion.type) {
        case 'model_tier_change': {
          // Adjust model tier mapping: find the effort level using the 'from' model
          for (const [effortLevel, currentModel] of Object.entries(this.config.modelTierMapping)) {
            if (currentModel === suggestion.from) {
              this.config.modelTierMapping[effortLevel as EffortLevel] = suggestion.to as ModelTier;
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
              this.config.defaultSynthesisConfig.qualityGates.forEach(g => {
                if (g.name === 'consistency') {
                  const thresholdAdjustment = suggestion.confidence * 0.1;
                  g.threshold = Math.max(0.1, Math.min(1.0, g.threshold + (suggestion.to === 'HYBRID' || suggestion.to === 'PARALLEL' ? -thresholdAdjustment : thresholdAdjustment)));
                }
              });
              getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
                type: 'self_optimization',
                change: `strategy: prefer ${suggestion.to} over ${suggestion.from}`,
                confidence: suggestion.confidence,
                evidence: suggestion.evidence,
              });

              // Create a falsifiable prediction for the strategy change
              if (exp) {
                getMetaLearner().createPrediction(
                  `opt-${Date.now()}`,
                  `strategy change: ${suggestion.from} → ${suggestion.to}`,
                  suggestion.to,
                  suggestion.from,
                  exp.modelUsed,
                  [exp.taskType],
                  [], // predicted fixes (filled from trajectory analysis)
                  ['unclassified'], // predicted regressions to watch
                );
              }
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

  /**
   * Unified trajectory analysis + evolution cycle.
   * Single TrajectoryAnalyzer call feeds both failure classification and evolver mutations,
   * eliminating the duplicate LLM call that previously existed in analyzeExecution + runEvolutionCycle.
   */
  private async analyzeAndEvolve(exp: ExecutionExperience, effortLevel?: string, taskType?: string): Promise<void> {
    const config = getMetaLearner()['config'] ?? DEFAULT_META_LEARNER_CONFIG;
    const mode: AnalysisMode = config.analysisMode ?? 'light';

    let provider: LLMProvider | undefined = undefined;
    let model: string | undefined = undefined;
    if (mode !== 'light' && this.runtime) {
      provider = this.runtime.getProvider('openai')
        ?? this.runtime.getProvider('anthropic')
        ?? this.runtime.getProvider('openrouter')
        ?? this.runtime.getProvider('mimo')
        ?? this.runtime.getProvider('deepseek')
        ?? this.runtime.getProvider('glm')
        ?? this.runtime.getProvider('xiaomi')
        ?? this.runtime.getProvider('google');
      if (provider && effortLevel) {
        model = this.config.modelTierMapping[effortLevel as EffortLevel] ?? 'gpt-4o-mini';
      }
    }

    // Single analyzer call — results feed both trajectory insights and evolution
    const analyzer = new TrajectoryAnalyzer(mode, provider, model);
    const insights = await analyzer.analyze([exp]);

    // Publish trajectory insights
    const bus = getMessageBus();
    for (const insight of insights) {
      if (!insight.success) {
        bus.publish('memory.written', 'ultimate-orch', {
          type: 'trajectory_insight',
          runId: insight.runId,
          category: insight.failureCategory,
          confidence: insight.confidence,
          evidence: insight.evidence,
          analysisTokens: insight.analysisTokens,
        });
      }
    }

    // Feed insights to evolver (previously a second TrajectoryAnalyzer call)
    if (insights.length > 0) {
      try {
        const evolver = getEvolverAgent();
        const cycle = evolver.runCycle(insights, this.config, exp, [taskType ?? 'general']);
        if (cycle.applied > 0) {
          bus.publish('system.alert', 'ultimate-orch', {
            type: 'evolution_applied',
            applied: cycle.applied,
            details: cycle.mutations.map(m => `${m.domain}: ${m.description}`),
          });
        }
      } catch (e) {
        getGlobalLogger().warn('UltimateOrchestrator', 'Evolution cycle failed', { error: (e as Error)?.message });
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

  private collectCompletedNodes(node: TaskTreeNode): TaskTreeNode[] {
    const completed: TaskTreeNode[] = [];
    if (node.status === 'COMPLETED' && node.result) {
      completed.push(node);
    }
    for (const sub of node.subtasks) {
      completed.push(...this.collectCompletedNodes(sub));
    }
    return completed;
  }

  /**
   * Build a TaskDAG from the deliberation plan for topology-aware routing.
   * Creates nodes based on estimated agent count and edges from decomposition strategy.
   */
  private buildDAGFromDeliberation(deliberation: DeliberationPlan): TaskDAG {
    const nodeCount = Math.max(1, deliberation.estimatedAgentCount);
    const nodes: TaskDAGNode[] = [];
    const edges: TaskDAGEdge[] = [];

    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        id: `dag_node_${i}`,
        label: `Subtask ${i + 1}`,
        estimatedComplexity: Math.ceil(deliberation.estimatedSteps / nodeCount),
        estimatedTokens: Math.ceil(deliberation.estimatedTokens / nodeCount),
        requiredCapabilities: deliberation.capabilitiesNeeded,
        atomic: deliberation.decompositionStrategy === 'NONE',
      });
    }

    // Build edges based on decomposition strategy
    if (deliberation.decompositionStrategy === 'STEP') {
      // Sequential chain
      for (let i = 0; i < nodes.length - 1; i++) {
        edges.push({
          from: nodes[i].id,
          to: nodes[i + 1].id,
          type: 'SEQUENTIAL',
          dataDependency: true,
        });
      }
    } else if (deliberation.decompositionStrategy === 'ASPECT') {
      // All independent (parallel)
      // No edges needed — all nodes can run in parallel
    } else if (deliberation.decompositionStrategy === 'RECURSIVE') {
      // Tree structure: first node fans out to the rest
      for (let i = 1; i < nodes.length; i++) {
        edges.push({
          from: nodes[0].id,
          to: nodes[i].id,
          type: 'PARALLEL',
          dataDependency: false,
        });
      }
    }

    return this.topologyRouter.buildDAG(nodes, edges);
  }

  dispose(): void {
    this.activeExecutions.clear();
    this.evolutionEngine = null;
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

/**
 * Extract the output file path from a goal string, if the goal asks to write/create a file.
 * Returns the file path or null.
 */
function extractOutputFilePath(goal: string): string | null {
  const extRe = `(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql|go|rs|java|c|cpp|h)`;

  // Pattern 1: verb + any words + "to" + path
  const toPattern = new RegExp(`(?:write|create|generate|output|produce|save)\\b[^.]*?\\bto\\b\\s+([\\/\\.][\\S]+\\.${extRe})`, 'i');
  const toMatch = goal.match(toPattern);
  if (toMatch) return toMatch[1];

  // Pattern 2: verb + path directly (e.g., "write /tmp/file.md")
  const directPattern = new RegExp(`(?:write|create|generate|output|produce|save)\\s+([\\/\\.][\\S]+\\.${extRe})`, 'i');
  const directMatch = goal.match(directPattern);
  if (directMatch) return directMatch[1];

  // Pattern 3: any absolute path with known extension at end of sentence/line
  const pathPattern = new RegExp(`([\\/][\\S]+\\.${extRe})(?:\\s|$|[.])`, 'i');
  const pathMatch = goal.match(pathPattern);
  if (pathMatch) return pathMatch[1];

  return null;
}
