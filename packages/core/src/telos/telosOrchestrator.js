"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELOSOrchestrator = void 0;
const modelRouter_1 = require("../runtime/modelRouter");
const messageBus_1 = require("../runtime/messageBus");
const executionTrace_1 = require("../runtime/executionTrace");
const metaLearner_1 = require("../selfEvolution/metaLearner");
const types_1 = require("./types");
const tokenSentinel_1 = require("./tokenSentinel");
const providerPool_1 = require("./providerPool");
function generateId() {
    return `telos_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function analyzeTask(goal, contextData) {
    var _a, _b, _c;
    const reasoning = [];
    const gov = contextData.governanceProfile;
    const riskLevel = (_a = gov === null || gov === void 0 ? void 0 : gov.riskLevel) !== null && _a !== void 0 ? _a : 'LOW';
    let complexity = 0;
    if (goal.length > 500) {
        complexity += 2;
        reasoning.push('long goal, +2 complexity');
    }
    else if (goal.length > 200) {
        complexity += 1;
        reasoning.push('medium goal, +1 complexity');
    }
    if (riskLevel === 'CRITICAL') {
        complexity += 4;
        reasoning.push('critical risk, +4 complexity');
    }
    else if (riskLevel === 'HIGH') {
        complexity += 3;
        reasoning.push('high risk, +3 complexity');
    }
    else if (riskLevel === 'MEDIUM') {
        complexity += 1;
        reasoning.push('medium risk, +1 complexity');
    }
    const toolHints = (_c = (_b = contextData.availableTools) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0;
    if (toolHints > 5) {
        complexity += 2;
        reasoning.push(`${toolHints} tools suggested, +2 complexity`);
    }
    let mode;
    const level = complexity >= 7 ? 'CRITICAL' : complexity >= 4 ? 'HIGH' : complexity >= 2 ? 'MEDIUM' : 'LOW';
    if (riskLevel === 'CRITICAL') {
        mode = 'CONSENSUS';
        reasoning.push('CRITICAL risk → CONSENSUS mode');
    }
    else if (level === 'CRITICAL' || level === 'HIGH') {
        mode = 'MAGENTIC';
        reasoning.push(`${level} complexity → MAGENTIC mode`);
    }
    else if (level === 'MEDIUM' && toolHints > 3) {
        mode = 'HANDOFF';
        reasoning.push('MEDIUM complexity + multiple tools → HANDOFF mode');
    }
    else if (level === 'MEDIUM') {
        mode = 'PARALLEL';
        reasoning.push('MEDIUM complexity → PARALLEL mode');
    }
    else {
        mode = 'SEQUENTIAL';
        reasoning.push('LOW complexity → SEQUENTIAL mode');
    }
    return {
        mode,
        complexity: level,
        riskLevel: riskLevel,
        estimatedSubtasks: Math.max(1, Math.ceil(complexity / 2)),
        requiresConsensus: mode === 'CONSENSUS',
        requiresApproval: riskLevel === 'CRITICAL' || riskLevel === 'HIGH',
        reasoning,
    };
}
// ============================================================================
// Plan Context Builder — builds context ONCE
// ============================================================================
function buildPlanContext(projectId, agentId, goal, contextData, profile) {
    var _a, _b, _c;
    const planId = generateId();
    const assignments = [];
    const roleMap = {
        SEQUENTIAL: 'executor',
        PARALLEL: 'executor',
        HANDOFF: 'lead',
        MAGENTIC: 'lead',
        CONSENSUS: 'voter',
    };
    const tierMap = {
        LOW: 'eco',
        MEDIUM: 'standard',
        HIGH: 'power',
        CRITICAL: 'consensus',
    };
    assignments.push({
        agentId,
        role: (_a = roleMap[profile.mode]) !== null && _a !== void 0 ? _a : 'executor',
        modelTier: ((_b = tierMap[profile.complexity]) !== null && _b !== void 0 ? _b : 'standard'),
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
    const gov = contextData.governanceProfile;
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
            availableToolNames: (_c = contextData.availableTools) !== null && _c !== void 0 ? _c : [],
            estimatedContextTokens,
            budget: {
                hardCapTokens: profile.complexity === 'CRITICAL'
                    ? 400000
                    : profile.complexity === 'HIGH'
                        ? 200000
                        : 100000,
                softCapTokens: profile.complexity === 'CRITICAL'
                    ? 300000
                    : profile.complexity === 'HIGH'
                        ? 150000
                        : 75000,
                costCapUsd: profile.complexity === 'CRITICAL' ? 10.0 : profile.complexity === 'HIGH' ? 5.0 : 2.0,
            },
        },
        governance: {
            riskLevel: profile.complexity,
            governanceMode: profile.requiresApproval
                ? 'MANUAL'
                : profile.mode === 'CONSENSUS'
                    ? 'GUARDED'
                    : 'AUTO',
            requiresApproval: profile.requiresApproval,
        },
        reasoning: profile.reasoning,
        createdAt: new Date().toISOString(),
    };
}
// ============================================================================
// TELOS Orchestrator — the unified entry point
// ============================================================================
class TELOSOrchestrator {
    constructor(runtime, config, sentinel, pool) {
        this.activePlans = new Map();
        this.runtime = runtime;
        this.config = { ...types_1.DEFAULT_TELOS_CONFIG, ...config };
        this.sentinel = sentinel !== null && sentinel !== void 0 ? sentinel : (0, tokenSentinel_1.getTokenSentinel)();
        this.pool = pool !== null && pool !== void 0 ? pool : (0, providerPool_1.getProviderPool)();
    }
    getConfig() {
        return { ...this.config };
    }
    // ========================================================================
    // Plan — analyze + build context (NO LLM call)
    // ========================================================================
    plan(params) {
        var _a, _b;
        const profile = analyzeTask(params.goal, (_a = params.contextData) !== null && _a !== void 0 ? _a : {});
        const plan = buildPlanContext(params.projectId, params.agentId, params.goal, (_b = params.contextData) !== null && _b !== void 0 ? _b : {}, profile);
        this.activePlans.set(plan.planId, plan);
        // Publish plan event
        (0, messageBus_1.getMessageBus)().publish('agent.message', 'telos-orchestrator', {
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
    preflight(planId) {
        const plan = this.activePlans.get(planId);
        if (!plan)
            return { allowed: false, reason: 'plan not found' };
        const sentinelCheck = this.sentinel.check([
            { role: 'system', content: plan.slimContext.systemPrompt },
            { role: 'user', content: plan.slimContext.goal },
        ], 'claude-3-5-sonnet', plan.slimContext.budget);
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
    async execute(planId) {
        var _a;
        const plan = this.activePlans.get(planId);
        if (!plan) {
            return {
                status: 'failed',
                results: [],
                totalCostUsd: 0,
                totalTokens: 0,
                error: 'plan not found',
            };
        }
        // Preflight check (budget gate)
        const check = this.preflight(planId);
        if (!check.allowed) {
            return {
                status: 'cancelled',
                results: [],
                totalCostUsd: 0,
                totalTokens: 0,
                error: (_a = check.reason) !== null && _a !== void 0 ? _a : 'preflight check failed',
            };
        }
        const bus = (0, messageBus_1.getMessageBus)();
        const tracer = (0, executionTrace_1.getTraceRecorder)();
        const router = (0, modelRouter_1.getModelRouter)();
        const results = [];
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
            const request = {
                model: routing.modelId,
                messages: [
                    { role: 'system', content: plan.slimContext.systemPrompt },
                    { role: 'user', content: assignment.subtask },
                ],
                maxTokens: routing.maxTokens,
            };
            // Token check before sending
            const tokenCheck = this.sentinel.check(request.messages, routing.modelId, plan.slimContext.budget);
            if (!tokenCheck.allowed) {
                tracer.recordDecision(planId, `TOKEN_BUDGET_EXCEEDED for ${assignment.agentId}: ${tokenCheck.reason}`, 0);
                results.push({ agentId: assignment.agentId, summary: '', status: 'cancelled' });
                continue;
            }
            tracer.recordDecision(planId, `Routing ${assignment.agentId} → ${routing.modelId} (${routing.tier})`, 0);
            // Execute via runtime
            try {
                const ctx = {
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
                // Track cost using per-record cost to avoid cross-plan misattribution
                if (execResult.status === 'success') {
                    const costRecord = this.sentinel.recordCostFromUsage(planId, assignment.agentId, routing.modelId, execResult.totalTokenUsage);
                    totalCostUsd += costRecord.costUsd;
                }
                totalTokens += execResult.totalTokenUsage.totalTokens;
                results.push({
                    agentId: assignment.agentId,
                    summary: execResult.summary,
                    status: execResult.status,
                });
                tracer.completeRun(planId);
            }
            catch (err) {
                tracer.recordError(planId, `Execution failed for ${assignment.agentId}: ${err}`, 0);
                results.push({ agentId: assignment.agentId, summary: '', status: 'failed' });
            }
        }
        // totalCostUsd already accumulated via per-record cost tracking
        // Record experience
        (0, metaLearner_1.getMetaLearner)().recordExperience({
            id: `exp-${planId}`,
            runId: planId,
            agentId: 'telos-orchestrator',
            taskType: plan.mode,
            modelUsed: 'multiple',
            strategyUsed: plan.mode,
            success: results.every((r) => r.status === 'success'),
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
        const allSuccess = results.every((r) => r.status === 'success');
        // Clean up completed plan to prevent unbounded activePlans growth
        this.activePlans.delete(planId);
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
    async planAndExecute(params) {
        const plan = this.plan(params);
        const execution = await this.execute(plan.planId);
        return { plan, ...execution };
    }
    getPlan(planId) {
        return this.activePlans.get(planId);
    }
    listPlans() {
        return Array.from(this.activePlans.values());
    }
    getSentinel() {
        return this.sentinel;
    }
}
exports.TELOSOrchestrator = TELOSOrchestrator;
