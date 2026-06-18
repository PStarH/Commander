"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.UltimateOrchestrator = void 0;
exports.countNodes = countNodes;
exports.measureDepth = measureDepth;
exports.flattenTree = flattenTree;
const types_1 = require("./types");
const messageBus_1 = require("../runtime/messageBus");
const executionTrace_1 = require("../runtime/executionTrace");
const intentLog_1 = require("../runtime/intentLog");
const metricsCollector_1 = require("../runtime/metricsCollector");
const metaLearner_1 = require("../selfEvolution/metaLearner");
const trajectoryAnalyzer_1 = require("../selfEvolution/trajectoryAnalyzer");
const evolverAgent_1 = require("../selfEvolution/evolverAgent");
const threeLayerMemory_1 = require("../threeLayerMemory");
const deliberation_1 = require("./deliberation");
const atomizer_1 = require("./atomizer");
const topologyRouter_1 = require("./topologyRouter");
const subAgentExecutor_1 = require("./subAgentExecutor");
const synthesizer_1 = require("./synthesizer");
const artifactSystem_1 = require("./artifactSystem");
const workCoordinator_1 = require("./workCoordinator");
const capabilityRegistry_1 = require("./capabilityRegistry");
const agentTeamManager_1 = require("./agentTeamManager");
const effortScaler_1 = require("./effortScaler");
const topologyOptimizer_1 = require("./topologyOptimizer");
const evolutionaryWorkflowEngine_1 = require("../runtime/evolutionaryWorkflowEngine");
const constants_1 = require("../config/constants");
const logging_1 = require("../logging");
const stateManager_1 = require("./stateManager");
const tokenBudgetManager_1 = require("../runtime/tokenBudgetManager");
const checkpointWriter_1 = require("../runtime/checkpointWriter");
const rebuildPrompt_1 = require("../runtime/rebuildPrompt");
function generateExecId(counter) {
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
class UltimateOrchestrator {
    constructor(telos, runtime, config, artifactSystem, capabilityRegistry, teamManager) {
        this.evolutionEngine = null;
        this.activeExecutions = new Map();
        this.executionCounter = { value: 0 };
        /** Session-pinned configs: per-run config snapshot to prevent mid-task changes */
        this.pinnedSessions = new Map();
        this.maxPinnedSessions = 100;
        this.config = { ...types_1.DEFAULT_ULTIMATE_CONFIG, ...config };
        this.telos = telos;
        this.runtime = runtime;
        this.artifactSystem = artifactSystem !== null && artifactSystem !== void 0 ? artifactSystem : (0, artifactSystem_1.getArtifactSystem)();
        this.capabilityRegistry = capabilityRegistry !== null && capabilityRegistry !== void 0 ? capabilityRegistry : (0, capabilityRegistry_1.getCapabilityRegistry)();
        this.teamManager = teamManager !== null && teamManager !== void 0 ? teamManager : (0, agentTeamManager_1.getTeamManager)();
        this.atomizer = new atomizer_1.RecursiveAtomizer(this.config.maxRecursiveDepth, this.config.maxParallelSubAgents);
        this.topologyRouter = new topologyRouter_1.TopologyRouter();
        this.topologyOptimizer = new topologyOptimizer_1.ReflexionTopologicalOptimizer();
        this.evolutionEngine = (0, evolutionaryWorkflowEngine_1.getEvolutionEngine)();
        this.subAgentExecutor = new subAgentExecutor_1.SubAgentExecutor(runtime, this.artifactSystem, this.config.maxParallelSubAgents, this.config);
        this.synthesizer = new synthesizer_1.MultiAgentSynthesizer();
        this.workCoordinator = (0, workCoordinator_1.getWorkCoordinator)();
    }
    async execute(params) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6;
        const execId = generateExecId(this.executionCounter);
        const startTime = Date.now();
        const bus = (0, messageBus_1.getMessageBus)();
        const tracer = (0, executionTrace_1.getTraceRecorder)();
        const errors = [];
        const reasoning = [];
        const artifactsCreated = [];
        const emit = (phase, detail) => {
            var _a;
            bus.publish('agent.started', `ultimate-orch-${execId}`, { phase, detail, execId });
            (_a = params.onProgress) === null || _a === void 0 ? void 0 : _a.call(params, phase, detail);
        };
        try {
            (0, intentLog_1.getIntentLog)(undefined).write({
                schemaVersion: 1,
                runId: execId,
                capturedAt: new Date().toISOString(),
                stage: 'ultimate.execute',
                decision: 'enter',
                reason: 'orchestrator.execute() entered',
                payload: {
                    agentId: params.agentId,
                    goal: params.goal.slice(0, 200),
                    effortLevel: params.effortLevel,
                    requestedTopology: params.topology,
                },
            });
        }
        catch {
            /* best-effort */
        }
        emit('INIT', `Starting execution: ${params.goal.slice(0, 100)}...`);
        const ctx = this.buildContext(execId, params);
        this.activeExecutions.set(execId, ctx);
        // Session Pinning: snapshot config at execution start
        this.pinSessionConfig(execId, params.topology || ctx.topology, params.effortLevel);
        let taskTree;
        try {
            // Phase 1: Deliberation (LLM-powered when a provider is registered)
            emit('DELIBERATION', 'Analyzing task requirements...');
            const firstProvider = (_g = (_f = (_e = (_d = (_c = (_b = (_a = this.runtime.getProvider('openai')) !== null && _a !== void 0 ? _a : this.runtime.getProvider('anthropic')) !== null && _b !== void 0 ? _b : this.runtime.getProvider('openrouter')) !== null && _c !== void 0 ? _c : this.runtime.getProvider('mimo')) !== null && _d !== void 0 ? _d : this.runtime.getProvider('deepseek')) !== null && _e !== void 0 ? _e : this.runtime.getProvider('glm')) !== null && _f !== void 0 ? _f : this.runtime.getProvider('xiaomi')) !== null && _g !== void 0 ? _g : this.runtime.getProvider('google');
            const useLLM = this.config.enableDeliberation && firstProvider !== undefined;
            const deliberation = useLLM
                ? await (0, deliberation_1.deliberateWithLLM)(params.goal, firstProvider, params.contextData)
                : (0, deliberation_1.deliberate)(params.goal, params.contextData);
            ctx.deliberation = deliberation;
            reasoning.push(...deliberation.reasoning);
            reasoning.push(`Confidence: ${(deliberation.confidence * 100).toFixed(0)}%`);
            // Phase 2: Effort Scaling — reuse from deliberation when available to avoid redundant classification
            emit('EFFORT_SCALING', `Classifying effort level...`);
            const effortLevel = (_j = (_h = params.effortLevel) !== null && _h !== void 0 ? _h : deliberation.effortLevel) !== null && _j !== void 0 ? _j : (0, effortScaler_1.classifyEffortLevel)(params.goal, {
                toolCount: (_l = (_k = params.contextData) === null || _k === void 0 ? void 0 : _k.availableTools) === null || _l === void 0 ? void 0 : _l.length,
                riskLevel: (_o = (_m = params.contextData) === null || _m === void 0 ? void 0 : _m.governanceProfile) === null || _o === void 0 ? void 0 : _o.riskLevel,
            });
            ctx.effortLevel = effortLevel;
            const scalingRules = (0, effortScaler_1.getEffortRules)(effortLevel);
            ctx.scalingRules = scalingRules;
            this.subAgentExecutor.setEffortLevel(effortLevel);
            reasoning.push(`Effort level: ${effortLevel} (${scalingRules.minSubAgents}-${scalingRules.maxSubAgents} agents)`);
            // Phase 3: Topology Routing — use DAG-aware router when available
            emit('TOPOLOGY_ROUTING', `Selecting orchestration topology...`);
            // Build DAG from deliberation for topology-aware routing
            const taskDAG = this.buildDAGFromDeliberation(deliberation);
            const topologyResult = this.topologyRouter.route(deliberation, taskDAG);
            const topology = (_p = params.topology) !== null && _p !== void 0 ? _p : (useLLM && deliberation.recommendedTopology
                ? deliberation.recommendedTopology
                : topologyResult.topology);
            ctx.topology = topology;
            ctx.taskDAG = taskDAG;
            reasoning.push(...topologyResult.reasoning);
            reasoning.push(`Topology: ${topology}${useLLM && deliberation.recommendedTopology ? ' (from LLM deliberation)' : ` (from router, expected cost: $${topologyResult.expectedCost.toFixed(4)})`}`);
            try {
                (0, intentLog_1.getIntentLog)(undefined).write({
                    schemaVersion: 1,
                    runId: execId,
                    capturedAt: new Date().toISOString(),
                    stage: 'ultimate.routing',
                    decision: 'topology_selected',
                    reason: 'topology chosen',
                    payload: {
                        topology,
                        taskType: deliberation.taskType,
                        expectedCost: topologyResult.expectedCost,
                        expectedLatency: topologyResult.expectedLatency,
                    },
                });
            }
            catch {
                /* best-effort */
            }
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordTopoChoice(topology, deliberation.taskType);
            }
            catch {
                /* best-effort */
            }
            // Phase 4: Recursive Task Decomposition
            emit('DECOMPOSITION', `Decomposing task into subtasks...`);
            taskTree = this.atomizer.decompose(params.goal, deliberation, null, 0, (_r = (_q = params.contextData) === null || _q === void 0 ? void 0 : _q.availableTools) !== null && _r !== void 0 ? _r : []);
            ctx.taskTree = taskTree;
            // If the root task is atomic (simple enough to execute directly),
            // wrap it as the single subtask instead of failing
            if (taskTree.subtasks.length === 0 && taskTree.isAtomic) {
                taskTree.subtasks = [
                    {
                        ...taskTree,
                        id: `${taskTree.id}_sub`,
                        parentId: taskTree.id,
                        role: 'EXECUTOR',
                        subtasks: [],
                    },
                ];
            }
            if (taskTree.subtasks.length === 0) {
                return {
                    id: execId,
                    status: 'FAILED',
                    summary: 'Task decomposition produced 0 subtasks',
                    synthesis: `Task decomposition produced 0 subtasks. The task may be too vague or malformed. Try rephrasing with more specific details.`,
                    reasoning,
                    metrics: {
                        totalTokens: 0,
                        totalCostUsd: 0,
                        totalDurationMs: Date.now() - startTime,
                        llmCalls: 0,
                        toolCalls: 0,
                        subAgentsSpawned: 0,
                        artifactsCreated: 0,
                        qualityScore: 0,
                        topologyUsed: topology,
                        effortLevelUsed: effortLevel,
                    },
                    errors: [
                        {
                            nodeId: 'root',
                            agentId: 'orchestrator',
                            message: 'Task decomposition produced 0 subtasks',
                            recovered: false,
                        },
                    ],
                    artifacts: [],
                    executionTree: [],
                };
            }
            reasoning.push(`Task tree: ${countNodes(taskTree)} nodes, depth ${measureDepth(taskTree)}`);
            // ── Token Budget Allocation ───────────────────────────────────────────
            // Split the total budget proportionally across sub-agents based on
            // their estimated token needs (from deliberation/atomizer).
            const totalBudget = this.config.defaultBudget.hardCapTokens;
            const budgetManager = (0, tokenBudgetManager_1.getTokenBudgetManager)();
            budgetManager.startRun(execId, { hardCap: totalBudget });
            const checkpointWriter = (0, checkpointWriter_1.getCheckpointWriter)();
            const subAgentEstimates = taskTree.subtasks.map((s) => ({
                nodeId: s.id,
                estimatedTokens: s.context.estimatedTokens || Math.ceil(totalBudget / taskTree.subtasks.length),
            }));
            if (subAgentEstimates.length > 0) {
                const allocations = budgetManager.allocateToSubAgents(execId, subAgentEstimates);
                for (const sub of taskTree.subtasks) {
                    const allocated = allocations.get(sub.id);
                    if (allocated !== undefined) {
                        sub.context.estimatedTokens = allocated;
                    }
                }
                reasoning.push(`Budget: ${totalBudget.toLocaleString()} tokens across ${subAgentEstimates.length} sub-agents`);
            }
            // ── TELOS Budget Preflight ─────────────────────────────────────────
            // Create a lightweight plan and check whether the budget is feasible
            // before committing sub-agents. This is an advisory gate — if preflight
            // warns, we log it but continue (the token governor enforces hard caps).
            try {
                const telosPlan = this.telos.plan({
                    projectId: execId,
                    agentId: 'orchestrator',
                    goal: params.goal,
                    contextData: {
                        mode: 'balanced',
                        availableTokens: budgetManager.getRemainingBudget(execId),
                        constraints: {
                            maxSteps: ctx.taskTree.subtasks.length * 3,
                            maxTokens: totalBudget,
                            timeoutMs: (_s = this.config.executionTimeoutMs) !== null && _s !== void 0 ? _s : 300000,
                        },
                    },
                });
                const preflight = this.telos.preflight(telosPlan.planId);
                if (!preflight.allowed) {
                    reasoning.push(`TELOS preflight: ${(_t = preflight.reason) !== null && _t !== void 0 ? _t : 'budget advisory'}`);
                }
                else {
                    reasoning.push(`TELOS preflight: budget OK (${telosPlan.mode} mode)`);
                }
            }
            catch (e) {
                reasoning.push(`TELOS preflight skipped: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            // ── Work Queue Enqueue ──────────────────────────────────────────────
            // Enqueue subtasks for visibility and crash recovery. The
            // subAgentExecutor handles claiming, execution, and completion via
            // the WorkCoordinator's native lifecycle — we only seed the queue.
            try {
                const workItems = this.workCoordinator.enqueue(taskTree.subtasks.map((sub) => {
                    var _a, _b, _c;
                    return ({
                        runId: execId,
                        parentNodeId: sub.id,
                        goal: sub.goal,
                        tools: (_a = sub.context.availableTools) !== null && _a !== void 0 ? _a : [],
                        // Intentionally omitted: subAgentExecutor drives dependency
                        // ordering via task-tree DAG, not WorkCoordinator-level
                        // resolution. Passing node IDs would break dependenciesMet()
                        // (expects WorkItem IDs, not node IDs).
                        tokenBudget: (_b = sub.context.estimatedTokens) !== null && _b !== void 0 ? _b : 50000,
                        priority: ((_c = sub.dependencies) === null || _c === void 0 ? void 0 : _c.length) === 0 ? 80 : 50,
                    });
                }));
                reasoning.push(`Work queue: ${workItems.length} items enqueued (${workItems.filter((w) => w.priority >= 80).length} root)`);
            }
            catch (e) {
                reasoning.push(`Work queue enqueue skipped: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            // Phase 5: Team Formation (if topology needs it)
            let teamId = null;
            if (this.config.enableTeams && taskTree.subtasks.length > 2) {
                emit('TEAM_FORMATION', `Forming agent team...`);
                const members = taskTree.subtasks.map((sub, i) => ({
                    agentId: sub.id,
                    role: i === 0
                        ? 'LEAD'
                        : i % 2 === 0
                            ? 'RESEARCHER'
                            : 'CODER',
                    capabilities: sub.context.availableTools,
                    status: 'IDLE',
                }));
                const team = this.teamManager.createTeam(`team-${execId.slice(-8)}`, members, {
                    goal: params.goal,
                    execId,
                });
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
            // ── Capability Gap Analysis ─────────────────────────────────────────
            // Check whether registered agent capabilities cover the subtask goals.
            // Advisory only — does not alter team composition.
            try {
                const goals = taskTree.subtasks.map((s) => s.goal);
                const bestMatches = this.capabilityRegistry.findBestMatch(goals);
                if (bestMatches.length > 0) {
                    const topScore = bestMatches[0].matchScore;
                    reasoning.push(`Capability analysis: best match ${bestMatches[0].agentId} (score: ${(topScore * 100).toFixed(0)}%)${bestMatches.length > 1 ? `, ${bestMatches.length - 1} alternatives` : ''}`);
                    if (topScore < 0.5) {
                        reasoning.push(`Capability gap: no registered agent matches subtask goals well (best=${(topScore * 100).toFixed(0)}%). Consider registering more capable agents.`);
                    }
                }
            }
            catch (e) {
                reasoning.push(`Capability analysis skipped: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            // Phase 6: Parallel Execution with team inbox collaboration
            emit('EXECUTION', `Executing ${taskTree.subtasks.length} subtasks...`);
            if (teamId) {
                this.subAgentExecutor.setTeam(teamId);
            }
            // EVALUATOR_OPTIMIZER: dedicated generator→evaluator→optimizer loop
            if (topology === 'EVALUATOR_OPTIMIZER' && taskTree.subtasks.length >= 2) {
                await this.executeEvaluatorOptimizerLoop(taskTree, execId, params, errors, reasoning);
            }
            else {
                await this.subAgentExecutor.executeNode(taskTree, params.projectId, (_u = params.contextData) !== null && _u !== void 0 ? _u : {}, errors);
            }
            this.subAgentExecutor.setTeam(null);
            const completedCount = countCompleted(taskTree);
            const failedCount = countFailed(taskTree);
            reasoning.push(`Execution: ${completedCount} completed, ${failedCount} failed`);
            // ── Checkpoint Trigger (MiMo-style: 20%/45%/70% token budget) ──────
            // Runs an independent LLM call outside the main agent's attention.
            // Writes checkpoint.md for crash recovery and rebuild prompt injection.
            this.maybeCheckpoint(execId, taskTree, params, errors, reasoning).catch(() => {
                // Background task — ignore failures, don't block the main loop
            });
            // Fetch artifacts before merging shared state (allArtifacts needed for merge + synthesis)
            const allArtifacts = await this.artifactSystem.find({ tags: ['completed'] }, 50);
            // Merge sub-agent results into shared state using per-key reducers
            const completedNodes = flattenTree(taskTree).filter((n) => n.status === 'COMPLETED' && n.result);
            const failedNodes = flattenTree(taskTree).filter((n) => n.status === 'FAILED');
            ctx.sharedState = (0, stateManager_1.mergeSharedState)(ctx.sharedState, {
                findings: completedNodes.map((n) => `[${n.goal.slice(0, 80)}] ${n.result.slice(0, 500)}`),
                errors: failedNodes.map((n) => { var _a; return `[${n.goal.slice(0, 80)}] ${(_a = n.result) !== null && _a !== void 0 ? _a : 'failed'}`; }),
                artifacts: allArtifacts.map((a) => a.id),
                costAccumulator: this.sumTokenUsage(taskTree) * constants_1.COST_PER_TOKEN,
            });
            // Phase 7: Multi-Agent Synthesis
            emit('SYNTHESIS', `Synthesizing results from ${completedCount} completed subtasks...`);
            const synthesis = await this.synthesizer.synthesize(this.config.defaultSynthesisConfig.strategy, this.config.defaultSynthesisConfig, taskTree, allArtifacts);
            reasoning.push(`Synthesis quality: ${(synthesis.qualityScore * 100).toFixed(0)}%`);
            // Compute execution metrics early for Phase 7.5 optimization
            const totalDurationMs = Date.now() - startTime;
            const allSuccess = errors.every((e) => e.recovered);
            const totalTokens = this.sumTokenUsage(taskTree);
            // Phase 7.5: Post-Execution Reflexion Topology Optimization
            if (this.config.enableDeliberation) {
                try {
                    const optimizationResult = await this.topologyOptimizer.optimize({
                        modelUsed: (_v = this.config.modelTierMapping[effortLevel]) !== null && _v !== void 0 ? _v : 'standard',
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
                    }, taskTree, ctx);
                    if (optimizationResult.proposal.actions.length > 0) {
                        reasoning.push(`Topology optimized: ${optimizationResult.proposal.actions.length} actions`);
                        const topologyAction = optimizationResult.proposal.actions.find((a) => a.type === 'change_topology');
                        if (topologyAction && 'to' in topologyAction) {
                            ctx.topology = topologyAction.to;
                        }
                    }
                }
                catch (e) {
                    reasoning.push(`Topology optimization skipped: ${e instanceof Error ? e.message : 'unknown'}`);
                }
            }
            // ── Checkpoint after synthesis (captures final state before quality gates) ──
            this.maybeCheckpoint(execId, taskTree, params, errors, reasoning).catch(() => { });
            // Phase 8: Quality Gates with Reflexion-inspired auto-fix retry loop
            // Optimized: early exit when score doesn't improve, reduced token budget for fixes
            let finalSynthesis = synthesis.synthesis;
            let finalQualityScore = synthesis.qualityScore;
            let finalGateResults = synthesis.gateResults;
            let previousAttemptSynth = '';
            let previousAttemptScore = 0;
            for (let fixAttempt = 0; fixAttempt < MAX_FIX_ATTEMPTS; fixAttempt++) {
                const failedGates = finalGateResults.filter((g) => !g.passed);
                if (failedGates.length === 0)
                    break;
                // Early exit: if score is already above threshold, don't burn tokens on marginal improvements
                if (finalQualityScore >= QUALITY_FIX_THRESHOLD && fixAttempt > 0)
                    break;
                const autoFixGate = failedGates.find((g) => {
                    const gc = this.config.qualityGates.find((c) => c.name === g.gate);
                    return gc === null || gc === void 0 ? void 0 : gc.autoFix;
                });
                if (!autoFixGate)
                    break;
                reasoning.push(`Quality gate "${autoFixGate.gate}" failed (score: ${(autoFixGate.score * 100).toFixed(0)}%) — auto-fix attempt ${fixAttempt + 1}`);
                // Build a fix prompt targeting the failed gate
                const fixInstructions = [];
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
                        contextData: (_w = params.contextData) !== null && _w !== void 0 ? _w : {},
                        availableTools: ['file_read', 'file_edit'],
                        maxSteps: QUALITY_FIX_MAX_STEPS,
                        tokenBudget: QUALITY_FIX_TOKEN_BUDGET,
                    });
                    if (fixResult.status === 'success') {
                        const fixedSynth = fixResult.summary;
                        if (fixedSynth.length > MIN_FIX_RESULT_LENGTH && fixedSynth !== previousAttemptSynth) {
                            finalSynthesis = fixedSynth;
                            // Re-run quality gates on the fixed synthesis
                            const recheck = await this.synthesizer.runQualityGatesStrict(this.config.qualityGates.filter((g) => g.enabled), finalSynthesis, taskTree);
                            finalGateResults = recheck;
                            finalQualityScore =
                                recheck.reduce((acc, g) => acc + (g.passed ? g.score : 0), 0) /
                                    Math.max(1, recheck.length);
                            reasoning.push(`Auto-fix ${fixAttempt + 1}: quality score ${(finalQualityScore * 100).toFixed(0)}%`);
                            // Early exit: if fix didn't improve score, don't waste another attempt
                            if (finalQualityScore <= previousAttemptScore) {
                                reasoning.push(`Auto-fix ${fixAttempt + 1}: no score improvement, stopping fix loop`);
                                break;
                            }
                        }
                        else {
                            reasoning.push(`Auto-fix ${fixAttempt + 1}: produced identical output, skipping`);
                        }
                    }
                }
                catch (err) {
                    reasoning.push(`Auto-fix attempt ${fixAttempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Collect artifacts
            for (const artifact of allArtifacts) {
                artifactsCreated.push(artifact);
            }
            // Record experience for self-evolution with real metrics
            const lessons = [];
            for (const gate of finalGateResults) {
                if (!gate.passed)
                    lessons.push(`Quality gate "${gate.gate}" scored ${(gate.score * 100).toFixed(0)}% (threshold: ${((_y = (_x = this.config.qualityGates.find((g) => g.name === gate.gate)) === null || _x === void 0 ? void 0 : _x.threshold) !== null && _y !== void 0 ? _y : 0.7) * 100}%)`);
            }
            if (completedCount > 0 && failedCount > 0) {
                lessons.push(`${failedCount}/${countNodes(taskTree)} subtasks failed - partial completion`);
            }
            const exp = {
                id: `exp-${execId}`,
                runId: execId,
                agentId: params.agentId,
                taskType: topology,
                modelUsed: (_z = this.config.modelTierMapping[effortLevel]) !== null && _z !== void 0 ? _z : 'standard',
                strategyUsed: `${effortLevel}_${topology}`,
                success: allSuccess,
                durationMs: totalDurationMs,
                tokenCost: totalTokens,
                lessons,
                timestamp: new Date().toISOString(),
            };
            (0, metaLearner_1.getMetaLearner)().recordExperience(exp);
            // Self-optimize: apply meta-learner suggestions after each execution
            this.applyOptimizationSuggestions(exp);
            // ── Shadow Mode: run challenger strategy with read-only tools ──────
            let shadowResult = null;
            try {
                const shadowStrategy = (0, metaLearner_1.getMetaLearner)().selectShadowStrategy(topology);
                if (shadowStrategy) {
                    const shadowStart = Date.now();
                    reasoning.push(`Shadow mode: testing ${shadowStrategy} vs ${exp.strategyUsed}...`);
                    // Run shadow with the same goal but read-only tools only
                    const shadowExec = await this.runtime.execute({
                        agentId: `shadow-${execId}`,
                        projectId: params.projectId,
                        goal: params.goal,
                        contextData: { ...params.contextData },
                        availableTools: (_2 = (_1 = (_0 = params.contextData) === null || _0 === void 0 ? void 0 : _0.availableTools) === null || _1 === void 0 ? void 0 : _1.filter((t) => !['file_write', 'file_edit', 'apply_patch', 'git', 'shell_execute'].includes(t))) !== null && _2 !== void 0 ? _2 : [],
                        maxSteps: 3,
                        tokenBudget: 10000,
                    });
                    shadowResult = {
                        strategy: shadowStrategy,
                        success: shadowExec.status === 'success',
                        durationMs: Date.now() - shadowStart,
                    };
                    reasoning.push(`Shadow: ${shadowStrategy} ${shadowResult.success ? '✅ would succeed' : '❌ would fail'} (${(shadowResult.durationMs / 1000).toFixed(1)}s)`);
                    (0, metaLearner_1.getMetaLearner)().recordShadowComparison({
                        runId: execId,
                        taskType: topology,
                        mainStrategy: exp.strategyUsed,
                        shadowStrategy: shadowResult.strategy,
                        mainSuccess: allSuccess,
                        shadowSuccess: shadowResult.success,
                        mainDurationMs: totalDurationMs,
                        shadowDurationMs: shadowResult.durationMs,
                    });
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('UltimateOrchestrator', 'Shadow mode failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
            // Unified trajectory analysis + evolution cycle (deduplicated: single TrajectoryAnalyzer call)
            if (!allSuccess) {
                this.analyzeAndEvolve(exp, effortLevel, topology).catch((e) => (0, logging_1.getGlobalLogger)().warn('UltimateOrchestrator', 'Trajectory analysis/evolution failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                }));
            }
            // ── Workflow Evolution ──────────────────────────────────────────────
            // Evolve the DAG-based workflow based on execution results to improve
            // future task decomposition and topology selection.
            if (this.evolutionEngine) {
                try {
                    const evolutionResult = await this.evolutionEngine.evolve({
                        taskType: topology,
                        availableTools: (_4 = (_3 = params.contextData) === null || _3 === void 0 ? void 0 : _3.availableTools) !== null && _4 !== void 0 ? _4 : [],
                        existingTree: taskTree,
                        generations: 1,
                        populationSize: 3,
                        maxDurationSeconds: 30,
                    });
                    if (evolutionResult && evolutionResult.improvements.length > 0) {
                        reasoning.push(`Workflow evolved: ${evolutionResult.generations} gen(s), ${evolutionResult.improvements.length} improvement(s)`);
                    }
                }
                catch (e) {
                    reasoning.push(`Workflow evolution skipped: ${e instanceof Error ? e.message : 'unknown'}`);
                }
            }
            try {
                const { MetaLearnerBridge, getSkillSystem } = await Promise.resolve().then(() => __importStar(require('../skills')));
                const bridge = new MetaLearnerBridge((0, metaLearner_1.getMetaLearner)(), getSkillSystem().manager);
                const newSkills = await bridge.extractSkills();
                if (newSkills.length > 0) {
                    bus.publish('skills.created', 'ultimate-orch', {
                        skills: newSkills.map((s) => s.name),
                        execId,
                    });
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('UltimateOrchestrator', 'Skill extraction failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
            // Store execution result in vector memory for future retrieval
            try {
                const memory = (0, threeLayerMemory_1.getGlobalThreeLayerMemory)();
                const qualitySummary = finalGateResults
                    .map((g) => `${g.gate}=${(g.score * 100).toFixed(0)}%`)
                    .join(', ');
                memory.add(`[${allSuccess ? 'SUCCESS' : 'FAIL'}] ${params.goal.slice(0, 200)}`, 'episodic', `topology:${topology}|effort:${effortLevel}|quality:${qualitySummary}`, allSuccess ? 0.8 : 0.3, [topology, effortLevel, allSuccess ? 'success' : 'failure', 'execution'], { execId, goal: params.goal.slice(0, 500) });
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('UltimateOrchestrator', 'Memory write failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
                // Memory is non-critical
            }
            // Cleanup team
            if (teamId) {
                this.teamManager.disbandTeam(teamId);
            }
            const metrics = this.computeMetrics(taskTree, startTime, topology, effortLevel, finalQualityScore, artifactsCreated.length);
            // Collect actual file content written by agents during execution.
            // Agents may write to workspace files, /tmp/, or per-agent output dirs.
            let finalOutput = finalSynthesis;
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const workspace = process.env.COMMANDER_WORKSPACE || process.cwd();
                const startTimeMs = startTime - FILE_DETECTION_BUFFER_MS;
                const agentWrittenFiles = [];
                const seenPaths = new Set();
                const tryAddFile = (fullPath) => {
                    if (seenPaths.has(fullPath))
                        return;
                    try {
                        if (!fs.existsSync(fullPath))
                            return;
                        const stat = fs.statSync(fullPath);
                        if (stat.mtimeMs >= startTimeMs && stat.size > MIN_AGENT_FILE_SIZE) {
                            seenPaths.add(fullPath);
                            agentWrittenFiles.push({
                                path: fullPath,
                                content: fs.readFileSync(fullPath, 'utf-8'),
                                size: stat.size,
                            });
                        }
                    }
                    catch {
                        /* ignore */
                    }
                };
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
                        if (!entry.isFile())
                            continue;
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!['.md', '.txt', '.json', '.ts', '.js', '.py'].includes(ext))
                            continue;
                        if (entry.name.startsWith('.') || entry.name === 'package.json')
                            continue;
                        tryAddFile(path.join(workspace, entry.name));
                    }
                }
                catch {
                    /* ignore */
                }
                // Method 4: Scan /tmp/ for files matching goal patterns
                try {
                    const tmpFiles = fs.readdirSync('/tmp', { withFileTypes: true });
                    for (const entry of tmpFiles) {
                        if (!entry.isFile())
                            continue;
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!['.md', '.txt', '.json'].includes(ext))
                            continue;
                        if (entry.name.startsWith('.') || entry.name.length < 5)
                            continue;
                        tryAddFile(path.join('/tmp', entry.name));
                    }
                }
                catch {
                    /* ignore */
                }
                // Method 5: Scan per-agent output directories
                try {
                    const commanderOutputDir = path.join(workspace, '.commander_output');
                    if (fs.existsSync(commanderOutputDir)) {
                        const agentDirs = fs.readdirSync(commanderOutputDir, { withFileTypes: true });
                        for (const agentDir of agentDirs) {
                            if (!agentDir.isDirectory())
                                continue;
                            const agentPath = path.join(commanderOutputDir, agentDir.name);
                            try {
                                const files = fs.readdirSync(agentPath, { withFileTypes: true });
                                for (const file of files) {
                                    if (!file.isFile())
                                        continue;
                                    tryAddFile(path.join(agentPath, file.name));
                                }
                            }
                            catch {
                                /* ignore */
                            }
                        }
                    }
                }
                catch {
                    /* ignore */
                }
                // If agents wrote substantial content, use that instead of truncated synthesis
                const totalAgentContent = agentWrittenFiles.reduce((s, f) => s + f.size, 0);
                if (totalAgentContent > finalSynthesis.length * AGENT_CONTENT_PREF_RATIO &&
                    agentWrittenFiles.length > 0) {
                    const combined = agentWrittenFiles
                        .sort((a, b) => b.size - a.size)
                        .map((f) => f.content)
                        .join('\n\n---\n\n');
                    finalOutput = combined;
                    reasoning.push(`Combined ${agentWrittenFiles.length} agent-written files (${totalAgentContent} bytes) instead of synthesis (${finalSynthesis.length} bytes)`);
                }
                // Aggressive fallback: collect ALL available data, but only use if larger
                {
                    const allResults = [];
                    const allNodes = flattenTree(taskTree);
                    for (const n of allNodes) {
                        if (n.status !== 'COMPLETED')
                            continue;
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
                            contextData: (_5 = params.contextData) !== null && _5 !== void 0 ? _5 : {},
                            availableTools: ((_6 = params.contextData) === null || _6 === void 0 ? void 0 : _6.availableTools) || [],
                            maxSteps: 15,
                            tokenBudget: 80000,
                        });
                        if (outputResult.status === 'success' &&
                            outputResult.summary.length > finalOutput.length) {
                            finalOutput = outputResult.summary;
                            reasoning.push(`Output generator: produced ${finalOutput.length} bytes`);
                        }
                    }
                    catch (e) {
                        reasoning.push(`Output generator failed: ${e instanceof Error ? e.message : 'unknown'}`);
                    }
                }
            }
            catch (e) {
                reasoning.push(`Agent file collection failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            // Write synthesis output to target file if the goal specifies one.
            // Always write to ensure the file has the full synthesized content.
            try {
                const fileIntent = extractOutputFilePath(params.goal);
                if (fileIntent) {
                    const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                    const path = await Promise.resolve().then(() => __importStar(require('path')));
                    const resolvedPath = fileIntent.startsWith('/') || fileIntent.startsWith('~')
                        ? fileIntent
                        : `${process.cwd()}/${fileIntent}`;
                    const dir = path.dirname(resolvedPath);
                    if (!fs.existsSync(dir))
                        fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(resolvedPath, finalOutput, 'utf-8');
                    reasoning.push(`Wrote synthesis output (${finalOutput.length} bytes) to ${resolvedPath}`);
                }
            }
            catch (e) {
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
        }
        finally {
            // Terminal checkpoint: capture final state for future rebuild
            this.maybeCheckpoint(execId, taskTree, params, errors, reasoning).catch(() => { });
            // Clean up rebuild tracking for this run (prevents unbounded Map growth)
            try {
                (0, rebuildPrompt_1.getRebuildPrompt)().resetRun(execId);
            }
            catch {
                /* best-effort */
            }
            this.activeExecutions.delete(execId);
        }
    }
    buildContext(execId, params) {
        var _a;
        return {
            id: execId,
            projectId: params.projectId,
            goal: params.goal,
            context: (_a = params.contextData) !== null && _a !== void 0 ? _a : {},
            sharedState: (0, stateManager_1.createInitialSharedState)(),
            effortLevel: this.config.defaultEffortLevel,
            scalingRules: (0, effortScaler_1.getEffortRules)(this.config.defaultEffortLevel),
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
    computeMetrics(taskTree, startTime, topology, effortLevel, qualityScore, artifactCount) {
        const allNodes = flattenTree(taskTree);
        let totalTokens = 0;
        let subAgentCount = 0;
        for (const node of allNodes) {
            if (node.tokenUsage) {
                totalTokens += node.tokenUsage.totalTokens;
            }
            if (node.isAtomic)
                subAgentCount++;
        }
        return {
            totalTokens,
            totalCostUsd: totalTokens * constants_1.COST_PER_TOKEN,
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
    getExecution(id) {
        return this.activeExecutions.get(id);
    }
    listExecutions() {
        return Array.from(this.activeExecutions.values());
    }
    getConfig() {
        return { ...this.config };
    }
    /**
     * Live update of one (or all) quality gate thresholds. Mutates BOTH the
     * engine-side `config.qualityGates` (consumed by `runQualityGatesStrict`)
     * and the synthesis-side `config.defaultSynthesisConfig.qualityGates`
     * (consumed by `applyOptimizationSuggestions`). Threshold is clamped to
     * [0, 1]. Name "all" applies to every enabled gate.
     * Returns true if any gate was updated.
     */
    setQualityGateThreshold(name, threshold) {
        const clamped = Math.max(0, Math.min(1, threshold));
        let updated = false;
        const applyTo = (g) => {
            if ((name === 'all' || g.name === name) && g.enabled) {
                if (g.threshold !== clamped) {
                    g.threshold = clamped;
                    return true;
                }
            }
            return false;
        };
        for (const g of this.config.qualityGates) {
            if (applyTo(g))
                updated = true;
        }
        for (const g of this.config.defaultSynthesisConfig.qualityGates) {
            if (applyTo(g))
                updated = true;
        }
        return updated;
    }
    /**
     * Live override of effort-level → model-tier mapping. Useful for forcing
     * all sub-agents onto a single tier mid-session (e.g., cost honeymoon).
     * Pass `undefined` for `tier` to reset to default tier for a level.
     */
    setModelTier(effortLevel, tier) {
        // Resolve against the truth-source DEFAULT_ULTIMATE_CONFIG so future
        // changes to types.ts defaults propagate without drift. (Reviewer fix.)
        this.config.modelTierMapping[effortLevel] =
            tier !== null && tier !== void 0 ? tier : types_1.DEFAULT_ULTIMATE_CONFIG.modelTierMapping[effortLevel];
    }
    // ========================================================================
    // Session Pinning
    // ========================================================================
    /** Snapshots the current config for a run, preventing mid-task mutations. */
    pinSessionConfig(runId, topology, effortLevel) {
        const hash = this.computeConfigHash();
        const modelTierMapping = {};
        for (const [k, v] of Object.entries(this.config.modelTierMapping)) {
            modelTierMapping[k] = v;
        }
        const qualityGateThresholds = {};
        for (const g of this.config.qualityGates) {
            qualityGateThresholds[g.name] = g.threshold;
        }
        this.pinnedSessions.set(runId, {
            runId,
            configHash: hash,
            topology: topology !== null && topology !== void 0 ? topology : 'SINGLE',
            effortLevel: effortLevel !== null && effortLevel !== void 0 ? effortLevel : 'MODERATE',
            modelTierMapping,
            qualityGateThresholds,
            pinnedAt: new Date().toISOString(),
        });
        // Evict oldest if over capacity
        if (this.pinnedSessions.size > this.maxPinnedSessions) {
            const oldest = this.pinnedSessions.keys().next().value;
            if (oldest)
                this.pinnedSessions.delete(oldest);
        }
    }
    /** Get pinned config for a session, or null if not pinned. */
    getSessionPinnedConfig(runId) {
        var _a;
        return (_a = this.pinnedSessions.get(runId)) !== null && _a !== void 0 ? _a : null;
    }
    /** List all active pinned sessions. */
    getPinnedSessions() {
        return Array.from(this.pinnedSessions.values()).sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
    }
    /** Number of active pinned sessions. */
    getPinnedSessionCount() {
        return this.pinnedSessions.size;
    }
    /**
     * Fire-and-forget checkpoint trigger (MiMo-style).
     * Evaluates token usage against trigger points (20%/45%/70%) and writes
     * a structured checkpoint.md via an independent LLM call.
     *
     * This runs OUTSIDE the main agent's attention — the main execution loop
     * does not block on checkpoint completion.
     */
    async maybeCheckpoint(execId, taskTree, params, errors, reasoning) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        try {
            const hardCap = this.config.defaultBudget.hardCapTokens;
            if (hardCap <= 0)
                return;
            const tokensUsed = this.sumTokenUsage(taskTree);
            const writer = (0, checkpointWriter_1.getCheckpointWriter)();
            const trigger = writer.shouldTrigger(execId, tokensUsed, hardCap);
            if (!trigger)
                return;
            // Build checkpoint data from current execution state
            const completedNodes = flattenTree(taskTree).filter((n) => n.status === 'COMPLETED' && n.result);
            const pendingNodes = flattenTree(taskTree).filter((n) => n.status !== 'COMPLETED' && n.status !== 'FAILED');
            const failedNodes = flattenTree(taskTree).filter((n) => n.status === 'FAILED');
            // Extract key decisions from reasoning
            const decisions = reasoning.filter((r) => r.includes('Topology:') ||
                r.includes('Effort level:') ||
                r.includes('Confidence:') ||
                r.includes('Budget:') ||
                r.includes('Synthesis quality:') ||
                r.includes('Shadow'));
            // Extract file paths from available context data
            const filesRead = [];
            const filesModified = [];
            if ((_a = params.contextData) === null || _a === void 0 ? void 0 : _a.availableTools) {
                filesRead.push(...(Array.isArray(params.contextData.filesRead)
                    ? params.contextData.filesRead
                    : []));
                filesModified.push(...(Array.isArray(params.contextData.filesModified)
                    ? params.contextData.filesModified
                    : []));
            }
            // Collect recent messages from the execution context
            const recentMessages = [];
            for (const node of completedNodes.slice(-3)) {
                if (node.result) {
                    recentMessages.push({ role: 'assistant', content: node.result.slice(0, 200) });
                }
            }
            // Resolve a provider (use first available, same as deliberation)
            const provider = (_h = (_g = (_f = (_e = (_d = (_c = (_b = this.runtime.getProvider('openai')) !== null && _b !== void 0 ? _b : this.runtime.getProvider('anthropic')) !== null && _c !== void 0 ? _c : this.runtime.getProvider('openrouter')) !== null && _d !== void 0 ? _d : this.runtime.getProvider('mimo')) !== null && _e !== void 0 ? _e : this.runtime.getProvider('deepseek')) !== null && _f !== void 0 ? _f : this.runtime.getProvider('glm')) !== null && _g !== void 0 ? _g : this.runtime.getProvider('xiaomi')) !== null && _h !== void 0 ? _h : this.runtime.getProvider('google');
            const result = await writer.writeCheckpoint({
                runId: execId,
                goal: params.goal,
                phase: pendingNodes.length > 0 ? 'executing' : 'synthesis',
                stepNumber: completedNodes.length,
                completedSubtasks: completedNodes.map((n) => {
                    var _a, _b, _c, _d;
                    return ({
                        id: n.id,
                        goal: n.goal.slice(0, 200),
                        result: (_b = (_a = n.result) === null || _a === void 0 ? void 0 : _a.slice(0, 300)) !== null && _b !== void 0 ? _b : '',
                        tokensUsed: (_d = (_c = n.tokenUsage) === null || _c === void 0 ? void 0 : _c.totalTokens) !== null && _d !== void 0 ? _d : 0,
                        durationMs: 0,
                    });
                }),
                pendingSubtasks: pendingNodes.map((n) => {
                    var _a;
                    return ({
                        id: n.id,
                        goal: n.goal.slice(0, 200),
                        estimatedTokens: (_a = n.context.estimatedTokens) !== null && _a !== void 0 ? _a : Math.ceil(hardCap / Math.max(1, pendingNodes.length)),
                    });
                }),
                failedSubtasks: failedNodes.map((n) => {
                    var _a, _b;
                    return ({
                        id: n.id,
                        goal: n.goal.slice(0, 200),
                        error: (_b = (_a = n.result) === null || _a === void 0 ? void 0 : _a.slice(0, 200)) !== null && _b !== void 0 ? _b : 'Unknown error',
                    });
                }),
                keyDecisions: decisions,
                filesRead,
                filesModified,
                errors: errors.map((e) => ({
                    nodeId: e.nodeId,
                    message: e.message.slice(0, 150),
                    recovered: e.recovered,
                })),
                tokensUsed,
                tokensHardCap: hardCap,
                recentMessages,
                trigger,
            }, provider !== null && provider !== void 0 ? provider : undefined);
            reasoning.push(`Checkpoint v${result.version}: ${trigger.percent}% budget (${result.completedCount} done, ${result.pendingCount} pending, ${result.failedCount} failed)`);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('UltimateOrchestrator', 'Checkpoint trigger failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    /** Simple hash of key config properties for version comparison. */
    computeConfigHash() {
        const keyValues = [
            JSON.stringify(this.config.modelTierMapping),
            this.config.defaultSynthesisConfig.consensusThreshold,
            this.config.maxParallelSubAgents,
            this.config.maxRecursiveDepth,
            ...this.config.qualityGates.map((g) => `${g.name}=${g.threshold}`),
        ].join('|');
        // Simple 8-char hash
        let hash = 0;
        for (let i = 0; i < keyValues.length; i++) {
            hash = ((hash << 5) - hash + keyValues.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(16).padStart(8, '0');
    }
    /**
     * Close the meta-learning feedback loop.
     * Reads optimization suggestions from the MetaLearner and applies them
     * to the orchestrator's live config — making the system self-optimizing.
     * When an experience is provided, creates a falsifiable prediction for each strategy change.
     */
    applyOptimizationSuggestions(exp) {
        const suggestions = (0, metaLearner_1.getMetaLearner)().getSuggestions();
        for (const suggestion of suggestions) {
            if (suggestion.confidence < 0.3)
                continue;
            switch (suggestion.type) {
                case 'model_tier_change': {
                    // Adjust model tier mapping: find the effort level using the 'from' model
                    for (const [effortLevel, currentModel] of Object.entries(this.config.modelTierMapping)) {
                        if (currentModel === suggestion.from) {
                            this.config.modelTierMapping[effortLevel] = suggestion.to;
                            (0, messageBus_1.getMessageBus)().publish('system.alert', 'ultimate-orchestrator', {
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
                    const topologyMap = {
                        SEQUENTIAL: 'SEQUENTIAL',
                        PARALLEL: 'PARALLEL',
                        HIERARCHICAL: 'HIERARCHICAL',
                        HYBRID: 'HYBRID',
                    };
                    const preferredTopology = topologyMap[suggestion.to];
                    if (preferredTopology) {
                        this.config.defaultSynthesisConfig.qualityGates.forEach((g) => {
                            if (g.name === 'consistency') {
                                const thresholdAdjustment = suggestion.confidence * 0.1;
                                g.threshold = Math.max(0.1, Math.min(1.0, g.threshold +
                                    (suggestion.to === 'HYBRID' || suggestion.to === 'PARALLEL'
                                        ? -thresholdAdjustment
                                        : thresholdAdjustment)));
                            }
                        });
                        (0, messageBus_1.getMessageBus)().publish('system.alert', 'ultimate-orchestrator', {
                            type: 'self_optimization',
                            change: `strategy: prefer ${suggestion.to} over ${suggestion.from}`,
                            confidence: suggestion.confidence,
                            evidence: suggestion.evidence,
                        });
                        // Create a falsifiable prediction for the strategy change
                        if (exp) {
                            (0, metaLearner_1.getMetaLearner)().createPrediction(`opt-${Date.now()}`, `strategy change: ${suggestion.from} → ${suggestion.to}`, suggestion.to, suggestion.from, exp.modelUsed, [exp.taskType], [], // predicted fixes (filled from trajectory analysis)
                            ['unclassified']);
                        }
                    }
                    break;
                }
                case 'prompt_template_change': {
                    // Adjust quality gate thresholds based on prompt template suggestions
                    const gateConfig = this.config.qualityGates.find((g) => g.name === suggestion.target);
                    if (gateConfig) {
                        const thresholdAdjustment = suggestion.confidence * 0.1;
                        if (suggestion.to === 'strict') {
                            gateConfig.threshold = Math.min(1.0, gateConfig.threshold + thresholdAdjustment);
                        }
                        else if (suggestion.to === 'relaxed') {
                            gateConfig.threshold = Math.max(0.1, gateConfig.threshold - thresholdAdjustment);
                        }
                    }
                    break;
                }
                case 'tool_change': {
                    // Could adjust available tools or tool configurations
                    (0, messageBus_1.getMessageBus)().publish('system.alert', 'ultimate-orchestrator', {
                        type: 'self_optimization',
                        change: `tool_change: ${suggestion.from} → ${suggestion.to} (confidence: ${suggestion.confidence})`,
                        confidence: suggestion.confidence,
                        evidence: suggestion.evidence,
                    });
                    break;
                }
                default:
                    break;
            }
        }
    }
    /**
     * Unified trajectory analysis + evolution cycle.
     * Single TrajectoryAnalyzer call feeds both failure classification and evolver mutations,
     * eliminating the duplicate LLM call that previously existed in analyzeExecution + runEvolutionCycle.
     */
    async analyzeAndEvolve(exp, effortLevel, taskType) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const config = (_a = (0, metaLearner_1.getMetaLearner)()['config']) !== null && _a !== void 0 ? _a : metaLearner_1.DEFAULT_META_LEARNER_CONFIG;
        const mode = (_b = config.analysisMode) !== null && _b !== void 0 ? _b : 'light';
        let provider = undefined;
        let model = undefined;
        if (mode !== 'light' && this.runtime) {
            provider =
                (_j = (_h = (_g = (_f = (_e = (_d = (_c = this.runtime.getProvider('openai')) !== null && _c !== void 0 ? _c : this.runtime.getProvider('anthropic')) !== null && _d !== void 0 ? _d : this.runtime.getProvider('openrouter')) !== null && _e !== void 0 ? _e : this.runtime.getProvider('mimo')) !== null && _f !== void 0 ? _f : this.runtime.getProvider('deepseek')) !== null && _g !== void 0 ? _g : this.runtime.getProvider('glm')) !== null && _h !== void 0 ? _h : this.runtime.getProvider('xiaomi')) !== null && _j !== void 0 ? _j : this.runtime.getProvider('google');
            if (provider && effortLevel) {
                model = (_k = this.config.modelTierMapping[effortLevel]) !== null && _k !== void 0 ? _k : 'gpt-4o-mini';
            }
        }
        // Single analyzer call — results feed both trajectory insights and evolution
        const analyzer = new trajectoryAnalyzer_1.TrajectoryAnalyzer(mode, provider, model);
        const insights = await analyzer.analyze([exp]);
        // Publish trajectory insights
        const bus = (0, messageBus_1.getMessageBus)();
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
                const evolver = (0, evolverAgent_1.getEvolverAgent)();
                const cycle = evolver.runCycle(insights, this.config, exp, [taskType !== null && taskType !== void 0 ? taskType : 'general']);
                if (cycle.applied > 0) {
                    bus.publish('system.alert', 'ultimate-orch', {
                        type: 'evolution_applied',
                        applied: cycle.applied,
                        details: cycle.mutations.map((m) => `${m.domain}: ${m.description}`),
                    });
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('UltimateOrchestrator', 'Evolution cycle failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
    sumTokenUsage(taskTree) {
        let total = 0;
        const nodes = flattenTree(taskTree);
        for (const node of nodes) {
            if (node.tokenUsage) {
                total += node.tokenUsage.totalTokens;
            }
        }
        return total || Math.ceil(taskTree.goal.length / 3.7) * countNodes(taskTree);
    }
    collectCompletedNodes(node) {
        const completed = [];
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
    buildDAGFromDeliberation(deliberation) {
        const nodeCount = Math.max(1, deliberation.estimatedAgentCount);
        const nodes = [];
        const edges = [];
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
        }
        else if (deliberation.decompositionStrategy === 'ASPECT') {
            // All independent (parallel)
            // No edges needed — all nodes can run in parallel
        }
        else if (deliberation.decompositionStrategy === 'RECURSIVE') {
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
    async executeEvaluatorOptimizerLoop(taskTree, execId, params, errors, reasoning) {
        var _a, _b, _c, _d, _e, _f, _g;
        const MAX_ITERATIONS = 3;
        const QUALITY_THRESHOLD = 0.8;
        const DEFAULT_SCORE = 0.5;
        if (taskTree.subtasks.length < 2) {
            reasoning.push('E-O loop: insufficient subtasks, falling back to standard execution');
            await this.subAgentExecutor.executeNode(taskTree, params.projectId, (_a = params.contextData) !== null && _a !== void 0 ? _a : {}, errors);
            return;
        }
        const generator = taskTree.subtasks[0];
        const evaluator = taskTree.subtasks[1];
        const optimizer = taskTree.subtasks.length > 2 ? taskTree.subtasks[2] : null;
        const originalGeneratorGoal = generator.goal;
        const originalEvaluatorGoal = evaluator.goal;
        const originalOptimizerGoal = optimizer === null || optimizer === void 0 ? void 0 : optimizer.goal;
        let currentOutput = '';
        let iteration = 0;
        let qualityScore = 0;
        try {
            while (iteration < MAX_ITERATIONS) {
                iteration++;
                reasoning.push(`E-O loop iteration ${iteration}: generating...`);
                await this.subAgentExecutor.executeNode(generator, params.projectId, (_b = params.contextData) !== null && _b !== void 0 ? _b : {}, errors);
                currentOutput = (_c = generator.result) !== null && _c !== void 0 ? _c : '';
                if (!currentOutput) {
                    reasoning.push('E-O loop: generator produced empty output');
                    break;
                }
                reasoning.push(`E-O loop iteration ${iteration}: evaluating...`);
                evaluator.goal = `Evaluate this output for quality, correctness, and completeness:\n\n${currentOutput.slice(0, 2000)}`;
                await this.subAgentExecutor.executeNode(evaluator, params.projectId, (_d = params.contextData) !== null && _d !== void 0 ? _d : {}, errors);
                const evalResult = (_e = evaluator.result) !== null && _e !== void 0 ? _e : '';
                const scoreMatch = evalResult.match(/(?:quality|score|rating)[\s:]*(\d+(?:\.\d+)?)/i);
                const rawScore = scoreMatch ? parseFloat(scoreMatch[1]) : DEFAULT_SCORE * 100;
                qualityScore = rawScore > 1 ? rawScore / 100 : rawScore;
                reasoning.push(`E-O loop iteration ${iteration}: quality=${(qualityScore * 100).toFixed(0)}%`);
                if (qualityScore >= QUALITY_THRESHOLD) {
                    reasoning.push('E-O loop: quality threshold met');
                    break;
                }
                if (!optimizer) {
                    reasoning.push('E-O loop: no optimizer agent, using generator feedback');
                    generator.goal = `Improve this output based on feedback:\n\nEvaluation: ${evalResult.slice(0, 1000)}\n\nCurrent output:\n${currentOutput.slice(0, 2000)}`;
                    continue;
                }
                reasoning.push(`E-O loop iteration ${iteration}: optimizing...`);
                optimizer.goal = `Optimize this output based on evaluation feedback:\n\nEvaluation: ${evalResult.slice(0, 1000)}\n\nCurrent output:\n${currentOutput.slice(0, 2000)}`;
                await this.subAgentExecutor.executeNode(optimizer, params.projectId, (_f = params.contextData) !== null && _f !== void 0 ? _f : {}, errors);
                const optimizedOutput = (_g = optimizer.result) !== null && _g !== void 0 ? _g : currentOutput;
                generator.goal = `Use this optimized version as your next generation baseline:\n\n${optimizedOutput.slice(0, 2000)}`;
            }
        }
        finally {
            generator.goal = originalGeneratorGoal;
            evaluator.goal = originalEvaluatorGoal;
            if (optimizer && originalOptimizerGoal !== undefined) {
                optimizer.goal = originalOptimizerGoal;
            }
        }
        generator.result = currentOutput;
        generator.status = 'COMPLETED';
        reasoning.push(`E-O loop completed: ${iteration} iterations, final quality=${(qualityScore * 100).toFixed(0)}%`);
    }
    dispose() {
        this.activeExecutions.clear();
        this.evolutionEngine = null;
    }
}
exports.UltimateOrchestrator = UltimateOrchestrator;
function countNodes(node) {
    let count = 1;
    for (const sub of node.subtasks) {
        count += countNodes(sub);
    }
    return count;
}
function measureDepth(node) {
    if (node.subtasks.length === 0)
        return 0;
    let maxDepth = 0;
    for (const sub of node.subtasks) {
        maxDepth = Math.max(maxDepth, measureDepth(sub) + 1);
    }
    return maxDepth;
}
function countCompleted(node) {
    let count = node.status === 'COMPLETED' ? 1 : 0;
    for (const sub of node.subtasks) {
        count += countCompleted(sub);
    }
    return count;
}
function countFailed(node) {
    let count = node.status === 'FAILED' ? 1 : 0;
    for (const sub of node.subtasks) {
        count += countFailed(sub);
    }
    return count;
}
function flattenTree(node) {
    const nodes = [node];
    for (const sub of node.subtasks) {
        nodes.push(...flattenTree(sub));
    }
    return nodes;
}
/**
 * Extract the output file path from a goal string, if the goal asks to write/create a file.
 * Returns the file path or null.
 */
function extractOutputFilePath(goal) {
    const extRe = `(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql|go|rs|java|c|cpp|h)`;
    // Pattern 1: verb + any words + "to" + path
    const toPattern = new RegExp(`(?:write|create|generate|output|produce|save)\\b[^.]*?\\bto\\b\\s+([\\/\\.][\\S]+\\.${extRe})`, 'i');
    const toMatch = goal.match(toPattern);
    if (toMatch)
        return toMatch[1];
    // Pattern 2: verb + path directly (e.g., "write /tmp/file.md")
    const directPattern = new RegExp(`(?:write|create|generate|output|produce|save)\\s+([\\/\\.][\\S]+\\.${extRe})`, 'i');
    const directMatch = goal.match(directPattern);
    if (directMatch)
        return directMatch[1];
    // Pattern 3: any absolute path with known extension at end of sentence/line
    const pathPattern = new RegExp(`([\\/][\\S]+\\.${extRe})(?:\\s|$|[.])`, 'i');
    const pathMatch = goal.match(pathPattern);
    if (pathMatch)
        return pathMatch[1];
    return null;
}
