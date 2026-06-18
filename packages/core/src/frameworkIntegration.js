"use strict";
/**
 * Commander Framework Integration
 * Phase 3: 将终极框架组件集成到现有 API
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGlobalMetrics = exports.getGlobalLogger = exports.MetricsCollector = exports.Logger = exports.InspectorAgent = exports.ConsensusChecker = exports.ReflectionEngine = exports.ThreeLayerMemory = exports.TokenBudgetAllocator = exports.AdaptiveOrchestrator = void 0;
exports.initializeFramework = initializeFramework;
exports.getFramework = getFramework;
exports.createExecutionPlan = createExecutionPlan;
exports.allocateBudget = allocateBudget;
exports.recordMemory = recordMemory;
exports.queryMemory = queryMemory;
exports.startReflection = startReflection;
exports.completeReflection = completeReflection;
exports.runConsensusCheck = runConsensusCheck;
exports.updateComponentHealth = updateComponentHealth;
exports.runInspection = runInspection;
const adaptiveOrchestrator_1 = require("./adaptiveOrchestrator");
Object.defineProperty(exports, "AdaptiveOrchestrator", { enumerable: true, get: function () { return adaptiveOrchestrator_1.AdaptiveOrchestrator; } });
const tokenBudgetAllocator_1 = require("./tokenBudgetAllocator");
Object.defineProperty(exports, "TokenBudgetAllocator", { enumerable: true, get: function () { return tokenBudgetAllocator_1.TokenBudgetAllocator; } });
const threeLayerMemory_1 = require("./threeLayerMemory");
Object.defineProperty(exports, "ThreeLayerMemory", { enumerable: true, get: function () { return threeLayerMemory_1.ThreeLayerMemory; } });
const reflectionEngine_1 = require("./reflectionEngine");
Object.defineProperty(exports, "ReflectionEngine", { enumerable: true, get: function () { return reflectionEngine_1.ReflectionEngine; } });
const consensusCheck_1 = require("./consensusCheck");
Object.defineProperty(exports, "ConsensusChecker", { enumerable: true, get: function () { return consensusCheck_1.ConsensusChecker; } });
const inspectorAgent_1 = require("./inspectorAgent");
Object.defineProperty(exports, "InspectorAgent", { enumerable: true, get: function () { return inspectorAgent_1.InspectorAgent; } });
const logging_1 = require("./logging");
Object.defineProperty(exports, "Logger", { enumerable: true, get: function () { return logging_1.Logger; } });
Object.defineProperty(exports, "MetricsCollector", { enumerable: true, get: function () { return logging_1.MetricsCollector; } });
Object.defineProperty(exports, "getGlobalLogger", { enumerable: true, get: function () { return logging_1.getGlobalLogger; } });
Object.defineProperty(exports, "getGlobalMetrics", { enumerable: true, get: function () { return logging_1.getGlobalMetrics; } });
// ========================================
// Framework Integration
// ========================================
let frameworkInitialized = false;
let frameworkInstances = null;
function initializeFramework() {
    if (frameworkInitialized)
        return;
    frameworkInstances = {
        orchestrator: new adaptiveOrchestrator_1.AdaptiveOrchestrator(),
        budgetAllocator: new tokenBudgetAllocator_1.TokenBudgetAllocator({ baseBudget: 100000 }),
        memory: new threeLayerMemory_1.ThreeLayerMemory(),
        reflection: new reflectionEngine_1.ReflectionEngine(),
        consensus: new consensusCheck_1.ConsensusChecker({ minVoters: 3 }),
        inspector: new inspectorAgent_1.InspectorAgent(),
        logger: (0, logging_1.getGlobalLogger)(),
        metrics: (0, logging_1.getGlobalMetrics)(),
    };
    frameworkInitialized = true;
}
function getFramework() {
    if (!frameworkInitialized) {
        initializeFramework();
    }
    return frameworkInstances;
}
// ========================================
// High-Level API Functions
// ========================================
/**
 * Create an execution plan
 */
function createExecutionPlan(tasks, suggestedMode) {
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
        status: 'pending',
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
function allocateBudget(mode) {
    const { budgetAllocator } = getFramework();
    const budget = budgetAllocator.allocate(mode, 50, 1);
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
function recordMemory(content, layer, context, importance = 0.5) {
    const { memory } = getFramework();
    const entry = memory.add(content, layer, context, importance);
    return { id: entry.id, layer: entry.layer };
}
/**
 * Query framework memory
 */
function queryMemory(options) {
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
function startReflection(taskId) {
    const { reflection } = getFramework();
    const sessionId = reflection.startSession(taskId);
    return { sessionId };
}
/**
 * Complete a reflection session
 */
function completeReflection(sessionId, outcome) {
    const { reflection } = getFramework();
    reflection.completeSession(sessionId, outcome);
    return { sessionId, outcome };
}
/**
 * Run consensus check
 */
function runConsensusCheck(question, votes) {
    const { consensus } = getFramework();
    const checkId = consensus.createCheck(question);
    for (const vote of votes) {
        consensus.addVote(checkId, vote.modelId, vote.modelName, vote.decision, vote.confidence, vote.reasoning);
    }
    const result = consensus.getResult(checkId);
    return {
        checkId,
        consensusLevel: result === null || result === void 0 ? void 0 : result.consensusLevel,
        consensusScore: result === null || result === void 0 ? void 0 : result.consensusScore,
        decision: result === null || result === void 0 ? void 0 : result.decision,
    };
}
/**
 * Update component health
 */
function updateComponentHealth(name, status, score) {
    const { inspector } = getFramework();
    inspector.updateComponent(name, status, score);
    return { name, status, score };
}
/**
 * Run system inspection
 */
function runInspection() {
    const { inspector } = getFramework();
    const report = inspector.inspect();
    return {
        overallStatus: report.overallStatus,
        overallHealth: report.overallHealth,
        openIssues: report.openIssues.length,
    };
}
