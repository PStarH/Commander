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
exports.SubAgentExecutor = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const humanApprovalManager_1 = require("./humanApprovalManager");
const artifactSystem_1 = require("./artifactSystem");
const agentTeamManager_1 = require("./agentTeamManager");
const messageBus_1 = require("../runtime/messageBus");
const agentContext_1 = require("../runtime/agentContext");
const logging_1 = require("../logging");
const deadLetterQueueSingleton_1 = require("../runtime/deadLetterQueueSingleton");
const scheduler_1 = require("../atr/scheduler");
const workCoordinator_1 = require("./workCoordinator");
const constants_1 = require("../config/constants");
const intentLog_1 = require("../runtime/intentLog");
const metricsCollector_1 = require("../runtime/metricsCollector");
const subAgentGuard_1 = require("./subAgentGuard");
const effortScaler_1 = require("./effortScaler");
const types_1 = require("./types");
/** Critical path token budget multiplier (LAMaS: give critical tasks more resources) */
const CRITICAL_PATH_TOKEN_MULTIPLIER = 1.5;
/** Slack threshold in ms — nodes with less slack than this are considered critical */
const CRITICAL_PATH_SLACK_THRESHOLD_MS = 100;
/** Default estimated duration for nodes without explicit estimates */
const DEFAULT_NODE_DURATION_MS = constants_1.ESTIMATED_DURATION_DEFAULT;
/** Maximum inbox messages to read per agent */
const MAX_INBOX_MESSAGES = 20;
/** Maximum characters from inbox messages to include in goal context */
const MAX_INBOX_MESSAGE_CHARS = 500;
/**
 * Fresh-context fields: only pass these to sub-agents.
 * Everything else (memoryItems, agentState, full history) is orchestrator-level
 * state that bloats sub-agent prompts without improving their output.
 * See: Anthropic "How we built our multi-agent research system" (June 2025).
 */
const FRESH_CONTEXT_FIELDS = ['governanceProfile', 'warRoomSnapshot'];
class SubAgentExecutor {
    constructor(runtime, artifactSystem, maxParallel = 10, config) {
        this.currentTeamId = null;
        this.currentRunId = null;
        this.currentRunHandle = null;
        this.checkpointer = null;
        this.approvalGate = null;
        this.skippedApprovals = [];
        this.runtime = runtime;
        this.artifactSystem = artifactSystem !== null && artifactSystem !== void 0 ? artifactSystem : (0, artifactSystem_1.getArtifactSystem)();
        this.maxParallel = maxParallel;
        this.config = config !== null && config !== void 0 ? config : types_1.DEFAULT_ULTIMATE_CONFIG;
        this.currentEffortLevel = this.config.defaultEffortLevel;
    }
    /**
     * Set the effort level for the current execution. Determines lead/specialist
     * model tier mapping for sub-agents.
     */
    setEffortLevel(level) {
        this.currentEffortLevel = level;
    }
    getModelTiers() {
        const rules = (0, effortScaler_1.getEffortRules)(this.currentEffortLevel);
        return {
            lead: rules.leadModelTier,
            specialist: rules.specialistModelTier,
        };
    }
    setTeam(teamId) {
        this.currentTeamId = teamId;
    }
    setRunId(runId) {
        this.currentRunId = runId;
    }
    setRunHandle(handle) {
        this.currentRunHandle = handle;
    }
    setCheckpointer(cp) {
        this.checkpointer = cp;
    }
    setApprovalGate(gate) {
        this.approvalGate = gate;
    }
    getSkippedApprovals() {
        return this.skippedApprovals;
    }
    getCurrentRunId() {
        return this.currentRunId;
    }
    writeCheckpoint(node) {
        var _a;
        if (!this.checkpointer)
            return;
        if (!this.currentRunId)
            return;
        this.checkpointer.checkpoint({
            runId: this.currentRunId,
            agentId: node.id,
            timestamp: new Date().toISOString(),
            phase: node.status === 'COMPLETED' || node.status === 'PARTIAL' ? 'completed' : 'failed',
            stepNumber: 0,
            attemptNumber: 0,
            messages: [],
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            stepDurations: [],
            context: {
                agentId: node.id,
                projectId: '',
                goal: node.goal,
                availableTools: (_a = node.context.availableTools) !== null && _a !== void 0 ? _a : [],
                maxSteps: 0,
                tokenBudget: 0,
            },
            totalDurationMs: 0,
        });
    }
    async executeNode(node, projectId, baseContext, errors) {
        var _a, _b, _c, _d;
        if (node.status === 'COMPLETED' ||
            node.status === 'FAILED' ||
            node.status === 'SKIPPED' ||
            node.status === 'PARTIAL')
            return;
        // Check approval gate before executing
        if ((_a = this.approvalGate) === null || _a === void 0 ? void 0 : _a.enabled) {
            const manager = (0, humanApprovalManager_1.getHumanApprovalManager)();
            const request = manager.request({
                runId: (_b = this.currentRunId) !== null && _b !== void 0 ? _b : 'unknown',
                nodeId: node.id,
                nodeGoal: node.goal,
                gate: this.approvalGate,
                riskLevel: 'low',
                requesterId: 'sub-agent-executor',
            });
            const resolution = await manager.awaitResolution(request.approvalId);
            if (resolution.decision === 'reject' || resolution.decision === 'modify') {
                node.status = 'SKIPPED';
                node.result = `[skipped] approval not granted: ${resolution.decision}`;
                const skipReason = resolution.timedOut
                    ? `Timed out: ${(_c = resolution.note) !== null && _c !== void 0 ? _c : 'no response'}`
                    : ((_d = resolution.note) !== null && _d !== void 0 ? _d : 'approval not granted');
                this.skippedApprovals.push({
                    nodeId: node.id,
                    reason: skipReason,
                });
                errors.push({
                    nodeId: node.id,
                    agentId: node.id,
                    message: `Node skipped: ${skipReason}`,
                    recovered: false,
                });
                // Write checkpoint when node is skipped
                this.writeCheckpoint(node);
                return;
            }
        }
        node.status = 'RUNNING';
        if (node.subtasks.length > 0) {
            await this.executeSubtasks(node, projectId, baseContext, errors);
        }
        if (node.isAtomic || node.subtasks.length === 0) {
            await this.executeAtomicNode(node, projectId, baseContext, errors);
        }
        if (node.subtasks.length > 0 && !node.isAtomic) {
            await this.synthesizeSubtasks(node, projectId, baseContext, errors);
        }
        this.cleanupOutputDir(node);
        this.writeCheckpoint(node);
    }
    async executeSubtasks(node, projectId, baseContext, errors) {
        var _a, _b;
        const dependencyMap = this.buildDependencyMap(node.subtasks);
        this.computeCriticalPath(node.subtasks, dependencyMap);
        const orderedLevels = this.topologicalLevels(dependencyMap, node.subtasks);
        for (const level of orderedLevels) {
            // LAMaS: sort critical path tasks first within each level
            const sorted = [...level].sort((a, b) => {
                var _a, _b;
                if (a.isOnCriticalPath && !b.isOnCriticalPath)
                    return -1;
                if (!a.isOnCriticalPath && b.isOnCriticalPath)
                    return 1;
                return ((_a = b.estimatedDurationMs) !== null && _a !== void 0 ? _a : 0) - ((_b = a.estimatedDurationMs) !== null && _b !== void 0 ? _b : 0);
            });
            const batches = this.chunkArray(sorted, this.maxParallel);
            for (const batch of batches) {
                // LAMaS: allocate more tokens to critical path tasks
                const adjustedBatch = batch.map((sub) => {
                    var _a;
                    if (sub.isOnCriticalPath) {
                        sub.context.estimatedTokens = Math.round(((_a = sub.context.estimatedTokens) !== null && _a !== void 0 ? _a : constants_1.MIN_TOKENS_PER_AGENT) *
                            CRITICAL_PATH_TOKEN_MULTIPLIER);
                    }
                    return sub;
                });
                const promises = adjustedBatch.map((sub) => this.executeNode(sub, projectId, baseContext, errors));
                const results = await Promise.allSettled(promises);
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    if (result.status === 'rejected') {
                        const subNode = adjustedBatch[i];
                        subNode.status = 'FAILED';
                        errors.push({
                            nodeId: subNode.id,
                            agentId: projectId,
                            message: (_b = (_a = result.reason) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : 'Unknown error',
                            recovered: false,
                        });
                    }
                }
            }
        }
    }
    /**
     * LAMaS: compute critical path using forward/backward pass.
     * Nodes on the critical path have zero slack — delaying them
     * delays the entire execution. These nodes get scheduling priority
     * and larger token budgets.
     */
    computeCriticalPath(nodes, dependencyMap) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
        if (nodes.length === 0)
            return;
        const nodeMap = new Map(nodes.map((n) => [n.id, n]));
        const est = new Map();
        const eft = new Map();
        const lft = new Map();
        const lst = new Map();
        // Forward pass: compute Earliest Start Time (EST) and Earliest Finish Time (EFT)
        const inDegree = new Map();
        const adjList = new Map();
        for (const node of nodes) {
            inDegree.set(node.id, 0);
            adjList.set(node.id, []);
        }
        for (const [nodeId, deps] of dependencyMap) {
            for (const dep of deps) {
                (_a = adjList.get(dep)) === null || _a === void 0 ? void 0 : _a.push(nodeId);
                inDegree.set(nodeId, ((_b = inDegree.get(nodeId)) !== null && _b !== void 0 ? _b : 0) + 1);
            }
        }
        const queue = [];
        for (const [nodeId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(nodeId);
                est.set(nodeId, 0);
                const dur = (_d = (_c = nodeMap.get(nodeId)) === null || _c === void 0 ? void 0 : _c.estimatedDurationMs) !== null && _d !== void 0 ? _d : DEFAULT_NODE_DURATION_MS;
                eft.set(nodeId, dur);
            }
        }
        let qIdx = 0;
        while (qIdx < queue.length) {
            const current = queue[qIdx++];
            const currentEft = (_e = eft.get(current)) !== null && _e !== void 0 ? _e : 0;
            for (const successor of (_f = adjList.get(current)) !== null && _f !== void 0 ? _f : []) {
                const newEst = currentEft;
                const currentEst = (_g = est.get(successor)) !== null && _g !== void 0 ? _g : 0;
                if (newEst > currentEst) {
                    est.set(successor, newEst);
                    const dur = (_j = (_h = nodeMap.get(successor)) === null || _h === void 0 ? void 0 : _h.estimatedDurationMs) !== null && _j !== void 0 ? _j : DEFAULT_NODE_DURATION_MS;
                    eft.set(successor, newEst + dur);
                }
                inDegree.set(successor, ((_k = inDegree.get(successor)) !== null && _k !== void 0 ? _k : 1) - 1);
                if (inDegree.get(successor) === 0) {
                    queue.push(successor);
                }
            }
        }
        // Project finish time = max EFT
        let projectFinish = 0;
        for (const [, finish] of eft) {
            projectFinish = Math.max(projectFinish, finish);
        }
        // Backward pass: compute Latest Finish Time (LFT) and Latest Start Time (LST)
        for (const node of nodes) {
            lft.set(node.id, projectFinish);
        }
        const outDegree = new Map();
        for (const node of nodes) {
            outDegree.set(node.id, 0);
        }
        for (const [nodeId, deps] of dependencyMap) {
            for (const _dep of deps) {
                outDegree.set(_dep, ((_l = outDegree.get(_dep)) !== null && _l !== void 0 ? _l : 0) + 1);
            }
        }
        const reverseQueue = [];
        for (const [nodeId, degree] of outDegree) {
            if (degree === 0) {
                reverseQueue.push(nodeId);
            }
        }
        let rqIdx = 0;
        while (rqIdx < reverseQueue.length) {
            const current = reverseQueue[rqIdx++];
            const currentLst = ((_m = lft.get(current)) !== null && _m !== void 0 ? _m : projectFinish) -
                ((_p = (_o = nodeMap.get(current)) === null || _o === void 0 ? void 0 : _o.estimatedDurationMs) !== null && _p !== void 0 ? _p : DEFAULT_NODE_DURATION_MS);
            lst.set(current, currentLst);
            for (const dep of (_q = dependencyMap.get(current)) !== null && _q !== void 0 ? _q : []) {
                const newLft = currentLst;
                const currentLft = (_r = lft.get(dep)) !== null && _r !== void 0 ? _r : projectFinish;
                if (newLft < currentLft) {
                    lft.set(dep, newLft);
                }
                outDegree.set(dep, ((_s = outDegree.get(dep)) !== null && _s !== void 0 ? _s : 1) - 1);
                if (outDegree.get(dep) === 0) {
                    reverseQueue.push(dep);
                }
            }
        }
        // Mark critical path: EST === LST (zero slack)
        for (const node of nodes) {
            const nodeEst = (_t = est.get(node.id)) !== null && _t !== void 0 ? _t : 0;
            const nodeLst = (_u = lst.get(node.id)) !== null && _u !== void 0 ? _u : 0;
            const slack = Math.abs(nodeLst - nodeEst);
            node.isOnCriticalPath = slack < CRITICAL_PATH_SLACK_THRESHOLD_MS;
        }
    }
    async executeAtomicNode(node, projectId, baseContext, errors) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2;
        if (this.currentRunId) {
            const workCoord = (0, workCoordinator_1.getWorkCoordinator)();
            const existing = workCoord
                .list({ runId: this.currentRunId })
                .find((i) => i.parentNodeId === node.id);
            if (!existing) {
                workCoord.enqueue({
                    runId: this.currentRunId,
                    parentNodeId: node.id,
                    goal: node.goal,
                    tools: (_a = node.context.availableTools) !== null && _a !== void 0 ? _a : [],
                    tokenBudget: (_b = node.context.estimatedTokens) !== null && _b !== void 0 ? _b : constants_1.MIN_TOKENS_PER_AGENT,
                    maxAttempts: 2,
                });
            }
            const claimed = workCoord.claim(node.id, {
                runId: this.currentRunId,
                parentNodeId: node.id,
            });
            if (!claimed) {
                node.status = 'COMPLETED';
                node.result = '[WorkCoordinator] work already claimed by another instance';
                return;
            }
        }
        try {
            await this.artifactSystem.write(node.id, 'SUMMARY', node.goal.slice(0, 80), 'Executing atomic task...', node.goal, ['atomic', ((_c = node.role) !== null && _c !== void 0 ? _c : 'sub-agent').toLowerCase()]);
            const startTime = Date.now();
            // Read inbox messages from dependency agents (team collaboration)
            let inboxContext = '';
            if (this.currentTeamId && node.dependencies.length > 0) {
                const teamManager = (0, agentTeamManager_1.getTeamManager)();
                const inboxMessages = teamManager.readMessages(this.currentTeamId, node.id, MAX_INBOX_MESSAGES, false);
                if (inboxMessages.length > 0) {
                    inboxContext =
                        '\n\n=== Messages from team members ===\n' +
                            inboxMessages
                                .map((m) => `[${m.from}] ${m.subject}: ${m.body.slice(0, MAX_INBOX_MESSAGE_CHARS)}`)
                                .join('\n---\n');
                }
            }
            const enrichedGoal = inboxContext ? `${node.goal}\n\n${inboxContext}` : node.goal;
            // Anthropic fresh-context: structured task brief with output format + constraints
            const rolePrompt = this.getRolePrompt(node.role);
            const taskBrief = [
                `<role>`,
                rolePrompt,
                `</role>`,
                ``,
                `<task>`,
                `## Task`,
                enrichedGoal,
                `</task>`,
                ``,
                `<output>`,
                `## Expected Output`,
                `Return your findings as a structured JSON object with the following fields:`,
                `- summary: A concise 1-2 sentence summary of your findings.`,
                `- result: The detailed output of your work (code, analysis, or text).`,
                `- confidenceScore: A number from 0 to 1 indicating your confidence in the result.`,
                `- sources: An array of sources used (file paths, URLs, tool outputs referenced).`,
                `- errors: An array of any errors or issues encountered during execution.`,
                ``,
                `## Constraints`,
                `- Complete only the assigned subtask — do not expand scope.`,
                `- Use file_read to read relevant source files before analyzing.`,
                `- Report outcomes faithfully: if something fails, say so.`,
                `- Do NOT include intermediate tool calls or reasoning in your final output.`,
                `</output>`,
            ].join('\n');
            // Filter tools per role — sub-agents don't need all tools
            const fullTools = (_e = (_d = baseContext === null || baseContext === void 0 ? void 0 : baseContext.availableTools) !== null && _d !== void 0 ? _d : node.context.availableTools) !== null && _e !== void 0 ? _e : [];
            const tools = this.filterToolsForRole(fullTools, node.role);
            // Per-agent output directory for file write isolation
            const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
            const outputDir = path.join(process.cwd(), '.commander_output', safeId);
            try {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            catch (e) {
                const errorMsg = `Failed to create output directory: ${e instanceof Error ? e.message : String(e)}`;
                node.status = 'FAILED';
                node.durationMs = Date.now() - startTime;
                errors.push({ nodeId: node.id, agentId: node.id, message: errorMsg, recovered: false });
                return;
            }
            const narrowContext = this.buildNarrowContext(baseContext);
            const { specialist } = this.getModelTiers();
            const ctx = {
                agentId: node.id,
                projectId,
                goal: taskBrief,
                contextData: narrowContext,
                availableTools: tools,
                outputDir,
                maxSteps: 10,
                tokenBudget: Math.max(constants_1.MIN_TOKENS_PER_AGENT, Math.min(constants_1.MAX_TOKENS_PER_AGENT, node.context.estimatedTokens)),
                parentRunId: (_f = this.currentRunId) !== null && _f !== void 0 ? _f : undefined,
                subAgentRole: (_g = node.role) !== null && _g !== void 0 ? _g : 'sub-agent',
                subAgentDepth: (_h = baseContext.__depth) !== null && _h !== void 0 ? _h : 1,
                preferredModelTier: (_j = node.preferredModelTier) !== null && _j !== void 0 ? _j : specialist,
            };
            try {
                (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                    schemaVersion: 1,
                    runId: (_l = (_k = this.currentRunId) !== null && _k !== void 0 ? _k : ctx.runId) !== null && _l !== void 0 ? _l : node.id,
                    capturedAt: new Date().toISOString(),
                    stage: 'subAgentExecutor.spawn',
                    decision: 'spawn',
                    reason: 'sub-agent execution started',
                    payload: {
                        agentId: node.id,
                        parentRunId: this.currentRunId,
                        subAgentRole: node.role,
                        depth: (_m = baseContext.__depth) !== null && _m !== void 0 ? _m : 1,
                    },
                });
            }
            catch {
                /* best-effort */
            }
            let execResult;
            // Create per-node sub-agent guard to enforce limits (steps, tokens, wall clock)
            const guard = new subAgentGuard_1.SubAgentGuard({
                maxSteps: 10,
                maxTokens: Math.max(constants_1.MIN_TOKENS_PER_AGENT, Math.min(constants_1.MAX_TOKENS_PER_AGENT, node.context.estimatedTokens)),
                maxWallClockMs: 5 * 60 * 1000,
            });
            // Pass guard into execution context so agentRuntime enforces limits per-step
            ctx.guard = guard;
            try {
                execResult = await agentContext_1.agentContext.run({ agentId: node.id, outputDir }, () => this.runtime.execute(ctx));
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                if (err instanceof subAgentGuard_1.SubAgentLimitError) {
                    node.status = 'FAILED';
                    node.result = `Sub-agent limit exceeded (${err.reason}): ${err.observed} >= ${err.limit}`;
                    node.durationMs = Date.now() - startTime;
                    try {
                        (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                            schemaVersion: 1,
                            runId: (_p = (_o = this.currentRunId) !== null && _o !== void 0 ? _o : ctx.runId) !== null && _p !== void 0 ? _p : node.id,
                            capturedAt: new Date().toISOString(),
                            stage: 'subAgentExecutor.complete',
                            decision: 'failed',
                            reason: `limit_exceeded: ${err.reason}`,
                            payload: {
                                agentId: node.id,
                                status: 'failed',
                                parentRunId: this.currentRunId,
                                limitReason: err.reason,
                                observed: err.observed,
                                limit: err.limit,
                            },
                        });
                    }
                    catch {
                        /* best-effort */
                    }
                    try {
                        (0, metricsCollector_1.getMetricsCollector)().recordSubAgentOutcome(node.id, 'failed', (_q = baseContext.__depth) !== null && _q !== void 0 ? _q : 1, ctx.tenantId);
                    }
                    catch {
                        /* best-effort */
                    }
                    errors.push({
                        nodeId: node.id,
                        agentId: node.id,
                        message: `Sub-agent limit exceeded (${err.reason}): ${err.observed} >= ${err.limit}`,
                        recovered: false,
                    });
                    return;
                }
                errors.push({
                    nodeId: node.id,
                    agentId: node.id,
                    message: errorMsg,
                    recovered: false,
                });
                node.status = 'FAILED';
                node.durationMs = Date.now() - startTime;
                try {
                    (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                        schemaVersion: 1,
                        runId: (_s = (_r = this.currentRunId) !== null && _r !== void 0 ? _r : ctx.runId) !== null && _s !== void 0 ? _s : node.id,
                        capturedAt: new Date().toISOString(),
                        stage: 'subAgentExecutor.complete',
                        decision: 'failed',
                        reason: errorMsg.slice(0, 200),
                        payload: { agentId: node.id, status: 'failed', parentRunId: this.currentRunId },
                    });
                }
                catch {
                    /* best-effort */
                }
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordSubAgentOutcome(node.id, 'failed', (_t = baseContext.__depth) !== null && _t !== void 0 ? _t : 1, ctx.tenantId);
                }
                catch {
                    /* best-effort */
                }
                return;
            }
            node.durationMs = Date.now() - startTime;
            if (!execResult) {
                node.status = 'FAILED';
                node.result = 'Execution returned no result (provider may have timed out or returned null)';
                errors.push({
                    nodeId: node.id,
                    agentId: node.id,
                    message: 'Execution returned no result',
                    recovered: false,
                });
                return;
            }
            node.tokenUsage = execResult.totalTokenUsage;
            // ── Token Budget Tracking ───────────────────────────────────────────
            try {
                const { getTokenBudgetManager } = await Promise.resolve().then(() => __importStar(require('../runtime/tokenBudgetManager')));
                const bm = getTokenBudgetManager();
                bm.recordUsage((_u = this.currentRunId) !== null && _u !== void 0 ? _u : node.id, node.id, execResult.totalTokenUsage.totalTokens);
                bm.markSubAgentComplete((_v = this.currentRunId) !== null && _v !== void 0 ? _v : node.id, node.id, execResult.totalTokenUsage.totalTokens);
            }
            catch {
                /* best-effort */
            }
            if (execResult.status !== 'success') {
                const errorMsg = execResult.error || `Execution returned status: ${execResult.status}`;
                node.result = errorMsg;
                errors.push({
                    nodeId: node.id,
                    agentId: node.id,
                    message: errorMsg,
                    recovered: false,
                });
            }
            else {
                // Anthropic fresh-context: return only the condensed summary, not raw tool outputs.
                // This prevents context pollution — the parent sees distilled findings, not the
                // sub-agent's full conversation history.
                node.result = execResult.summary;
                try {
                    (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                        schemaVersion: 1,
                        runId: (_x = (_w = this.currentRunId) !== null && _w !== void 0 ? _w : ctx.runId) !== null && _x !== void 0 ? _x : node.id,
                        capturedAt: new Date().toISOString(),
                        stage: 'subAgentExecutor.complete',
                        decision: 'success',
                        reason: 'sub-agent execution succeeded',
                        payload: {
                            agentId: node.id,
                            status: 'success',
                            parentRunId: this.currentRunId,
                            durationMs: node.durationMs,
                            tokenUsage: node.tokenUsage,
                        },
                    });
                }
                catch {
                    /* best-effort */
                }
                try {
                    (0, metricsCollector_1.getMetricsCollector)().recordSubAgentOutcome(node.id, 'success', (_y = baseContext.__depth) !== null && _y !== void 0 ? _y : 1, ctx.tenantId);
                }
                catch {
                    /* best-effort */
                }
            }
            await this.artifactSystem.write(node.id, 'RESEARCH_FINDING', `Result: ${node.goal.slice(0, 60)}`, execResult.summary.slice(0, 500), execResult.summary, [
                'completed',
                ((_z = node.role) !== null && _z !== void 0 ? _z : 'sub-agent').toLowerCase(),
                ...(execResult.status === 'success' ? ['success'] : ['partial']),
            ]);
            node.status = execResult.status === 'success' ? 'COMPLETED' : 'FAILED';
            // Notify dependent agents via team inbox
            if (this.currentTeamId) {
                const teamManager = (0, agentTeamManager_1.getTeamManager)();
                teamManager.sendMessage(this.currentTeamId, node.id, 'ALL', `Completed: ${node.goal.slice(0, 100)}`, `Status: ${node.status}\nSummary: ${((_0 = node.result) !== null && _0 !== void 0 ? _0 : '').slice(0, 500)}`, node.status === 'COMPLETED' ? 'NORMAL' : 'HIGH');
                (0, messageBus_1.getMessageBus)().publish('agent.message', node.id, {
                    type: 'team_inbox',
                    teamId: this.currentTeamId,
                    from: node.id,
                    subject: `Task ${node.status}`,
                });
            }
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push({
                nodeId: node.id,
                agentId: node.id,
                message: errorMsg,
                recovered: false,
            });
            node.status = 'FAILED';
            try {
                const compResult = await this.runtime.getCompensationRegistry().compensateAll();
                for (const compError of compResult.errors) {
                    (0, deadLetterQueueSingleton_1.getDeadLetterQueue)().record({
                        id: `compensation-${node.id}-${Date.now()}`,
                        category: 'execution',
                        runId: node.id,
                        agentId: node.id,
                        missionId: projectId,
                        timestamp: new Date().toISOString(),
                        errorClass: 'permanent',
                        errorMessage: compError,
                        retryable: false,
                        attemptNumber: 1,
                        operationName: 'subagent.compensation_exhausted',
                        compensated: true,
                        recovered: false,
                        tags: ['sub_agent', 'compensation_failed', `node:${node.id}`],
                    });
                }
            }
            catch (compErr) {
                (0, logging_1.getGlobalLogger)().warn('subAgentExecutor', 'compensateAll failed', {
                    nodeId: node.id,
                    error: compErr === null || compErr === void 0 ? void 0 : compErr.message,
                });
            }
            // Phase 3: notify the centralized ExecutionScheduler that this sub-agent run failed
            try {
                (0, scheduler_1.getExecutionScheduler)().abortRun({
                    runId: `subagent:${node.id}`,
                    leaseToken: 'n/a',
                    fencingEpoch: 0,
                    reason: errorMsg,
                });
            }
            catch (schedErr) {
                (0, logging_1.getGlobalLogger)().debug('subAgentExecutor', 'scheduler abortRun no-op for sub-agent', {
                    nodeId: node.id,
                    error: schedErr.message,
                });
            }
        }
        if (this.currentRunId) {
            const workCoord = (0, workCoordinator_1.getWorkCoordinator)();
            const myItem = workCoord
                .list({ runId: this.currentRunId })
                .find((i) => i.parentNodeId === node.id);
            if (myItem) {
                if (node.status === 'COMPLETED') {
                    workCoord.complete(myItem.id, node.id);
                }
                else {
                    const lastError = (_2 = (_1 = errors[errors.length - 1]) === null || _1 === void 0 ? void 0 : _1.message) !== null && _2 !== void 0 ? _2 : 'sub-agent execution failed';
                    const reassignResult = workCoord.fail(myItem.id, node.id, lastError);
                    if (reassignResult === null && this.currentRunHandle) {
                        try {
                            await (0, scheduler_1.getExecutionScheduler)().abortRun({
                                runId: this.currentRunHandle.runId,
                                leaseToken: this.currentRunHandle.leaseToken,
                                fencingEpoch: this.currentRunHandle.fencingEpoch,
                                reason: `terminal work failure: ${lastError.slice(0, 200)}`,
                            });
                        }
                        catch (abortErr) {
                            (0, logging_1.getGlobalLogger)().debug('subAgentExecutor', 'ATR abortRun on terminal failure no-op', { nodeId: node.id, error: abortErr.message });
                        }
                        try {
                            const compResult = await this.runtime.getCompensationRegistry().compensateAll();
                            (0, logging_1.getGlobalLogger)().info('subAgentExecutor', 'compensateAll on terminal failure', {
                                nodeId: node.id,
                                succeeded: compResult.succeeded,
                                failed: compResult.failed,
                            });
                        }
                        catch (compErr) {
                            (0, logging_1.getGlobalLogger)().debug('subAgentExecutor', 'compensateAll failed', {
                                nodeId: node.id,
                                error: compErr.message,
                            });
                        }
                    }
                }
            }
        }
    }
    async synthesizeSubtasks(node, projectId, baseContext, errors) {
        var _a, _b, _c, _d, _e;
        // Merge per-agent output directories into the workspace before synthesis
        this.mergeAgentOutputs(node);
        const completed = node.subtasks.filter((s) => s.status === 'COMPLETED');
        const failed = node.subtasks.filter((s) => s.status === 'FAILED');
        // Preserve the FULL concatenated results before synthesis agent runs.
        // This ensures the orchestrator's leadSynthesis always has access to complete data.
        const fullResults = completed
            .map((s) => { var _a; return `### ${s.goal.slice(0, 120)}\n\n${(_a = s.result) !== null && _a !== void 0 ? _a : ''}`; })
            .join('\n\n---\n\n');
        node.fullSubtaskResults = fullResults;
        // Pass full results to synthesis agent (no truncation)
        const summaries = completed
            .map((s) => { var _a; return `[${s.id}] ${s.goal.slice(0, 100)}: ${(_a = s.result) !== null && _a !== void 0 ? _a : ''}`; })
            .join('\n\n');
        const synthesisGoal = [
            `Synthesize the following ${completed.length} completed subtask results into a cohesive output.`,
            failed.length > 0 ? `Note: ${failed.length} subtasks failed.` : '',
            '',
            'Subtask results:',
            summaries,
        ]
            .filter(Boolean)
            .join('\n');
        const fullTools = baseContext === null || baseContext === void 0 ? void 0 : baseContext.availableTools;
        const tools = (fullTools === null || fullTools === void 0 ? void 0 : fullTools.length) ? fullTools : node.context.availableTools;
        const narrowContext = this.buildNarrowContext(baseContext);
        const { lead } = this.getModelTiers();
        const ctx = {
            agentId: `synthesizer-${node.id}`,
            projectId,
            goal: synthesisGoal,
            contextData: narrowContext,
            availableTools: tools,
            maxSteps: 8,
            tokenBudget: Math.max(constants_1.MIN_TOKENS_PER_AGENT, Math.round(node.context.estimatedTokens * 0.5)),
            parentRunId: (_a = this.currentRunId) !== null && _a !== void 0 ? _a : undefined,
            subAgentRole: 'synthesizer',
            subAgentDepth: ((_b = baseContext.__depth) !== null && _b !== void 0 ? _b : 1) + 1,
            preferredModelTier: (_c = node.preferredModelTier) !== null && _c !== void 0 ? _c : lead,
        };
        try {
            (0, intentLog_1.getIntentLog)(ctx.tenantId).write({
                schemaVersion: 1,
                runId: (_e = (_d = this.currentRunId) !== null && _d !== void 0 ? _d : ctx.runId) !== null && _e !== void 0 ? _e : node.id,
                capturedAt: new Date().toISOString(),
                stage: 'subAgentExecutor.synthesize',
                decision: 'spawn',
                reason: 'synthesizer sub-agent spawned',
                payload: {
                    agentId: ctx.agentId,
                    parentRunId: this.currentRunId,
                    subAgentRole: 'synthesizer',
                },
            });
        }
        catch {
            /* best-effort */
        }
        try {
            const result = await agentContext_1.agentContext.run({ agentId: `synthesizer-${node.id}` }, () => this.runtime.execute(ctx));
            // Preserve original results: use synthesis as summary, keep full results accessible
            node.result = result.summary;
            node.status = result.status === 'success' ? 'COMPLETED' : 'PARTIAL';
            await this.artifactSystem.write(node.id, 'SUMMARY', `Synthesis: ${node.goal.slice(0, 60)}`, result.summary.slice(0, 200), result.summary, ['synthesis', 'aggregated']);
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push({
                nodeId: node.id,
                agentId: `synthesizer-${node.id}`,
                message: errorMsg,
                recovered: false,
            });
            node.status = 'PARTIAL';
        }
    }
    /**
     * Merge per-agent output directories into the workspace.
     * Later agents' files overwrite earlier ones for the same path.
     * Cleans up the per-agent directories after merging.
     */
    mergeAgentOutputs(node) {
        const safeRoot = process.env.COMMANDER_WORKSPACE || process.cwd();
        for (const sub of node.subtasks) {
            const safeId = sub.id.replace(/[^a-zA-Z0-9_-]/g, '_');
            const outputDir = path.join(safeRoot, '.commander_output', safeId);
            if (!fs.existsSync(outputDir))
                continue;
            try {
                this.copyDirRecursive(outputDir, safeRoot);
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SubAgentExecutor', 'Failed to merge agent output', {
                    nodeId: sub.id,
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        // Clean up the .commander_output directory if empty
        const commanderOutputDir = path.join(safeRoot, '.commander_output');
        try {
            if (fs.existsSync(commanderOutputDir)) {
                const remaining = fs.readdirSync(commanderOutputDir);
                if (remaining.length === 0)
                    fs.rmSync(commanderOutputDir, { recursive: true });
            }
        }
        catch {
            /* ignore */
        }
    }
    copyDirRecursive(src, dest, safeRoot) {
        const root = safeRoot !== null && safeRoot !== void 0 ? safeRoot : dest;
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            // Prevent directory traversal: resolved dest must stay within root
            const resolved = path.resolve(destPath);
            if (!resolved.startsWith(path.resolve(root))) {
                (0, logging_1.getGlobalLogger)().warn('SubAgentExecutor', 'Blocked directory traversal', {
                    destPath: resolved,
                });
                continue;
            }
            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                this.copyDirRecursive(srcPath, destPath, root);
            }
            else {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
    /**
     * Merge remaining per-agent output files into the workspace, then clean up.
     */
    cleanupOutputDir(node) {
        const safeRoot = process.env.COMMANDER_WORKSPACE || process.cwd();
        const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const nodeOutputDir = path.join(safeRoot, '.commander_output', safeId);
        try {
            if (!fs.existsSync(nodeOutputDir))
                return;
            this.copyDirRecursive(nodeOutputDir, safeRoot);
            fs.rmSync(nodeOutputDir, { recursive: true, force: true });
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SubAgentExecutor', 'Failed to cleanup output dir', {
                nodeId: node.id,
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    buildDependencyMap(subtasks) {
        const map = new Map();
        for (const sub of subtasks) {
            map.set(sub.id, sub.dependencies);
        }
        return map;
    }
    topologicalLevels(dependencyMap, allNodes) {
        var _a;
        const levels = [];
        const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
        const remaining = new Set(allNodes.map((n) => n.id));
        const completed = new Set();
        while (remaining.size > 0) {
            const currentLevel = [];
            for (const nodeId of remaining) {
                const deps = (_a = dependencyMap.get(nodeId)) !== null && _a !== void 0 ? _a : [];
                const allDepsMet = deps.every((d) => completed.has(d));
                if (allDepsMet) {
                    const node = nodeMap.get(nodeId);
                    if (node)
                        currentLevel.push(node);
                }
            }
            if (currentLevel.length === 0) {
                const remainingList = Array.from(remaining);
                for (const id of remainingList) {
                    const node = nodeMap.get(id);
                    if (node)
                        currentLevel.push(node);
                }
            }
            for (const node of currentLevel) {
                remaining.delete(node.id);
                completed.add(node.id);
            }
            levels.push(currentLevel);
        }
        return levels;
    }
    /**
     * Build a narrow context for sub-agents (Anthropic fresh-context pattern).
     * Only includes governanceProfile and warRoomSnapshot — drops memoryItems,
     * agentState, and full orchestrator history that bloats sub-agent prompts.
     */
    buildNarrowContext(baseContext) {
        const narrow = {};
        for (const field of FRESH_CONTEXT_FIELDS) {
            if (field in baseContext) {
                narrow[field] = baseContext[field];
            }
        }
        return narrow;
    }
    /**
     * Filter tools per role — sub-agents don't need all tools.
     * Researchers need search/read; coders need read/write/edit/bash; etc.
     */
    filterToolsForRole(allTools, role) {
        const roleLower = (role !== null && role !== void 0 ? role : '').toLowerCase();
        const roleToolHints = {
            researcher: [
                'webSearch',
                'web_search',
                'web_fetch',
                'file_read',
                'read_file',
                'grep',
                'file_search',
            ],
            coder: [
                'file_read',
                'read_file',
                'file_write',
                'write_file',
                'file_edit',
                'edit_file',
                'bash',
                'grep',
            ],
            reviewer: ['file_read', 'read_file', 'grep', 'file_search', 'diff'],
            synthesizer: ['file_read', 'read_file', 'file_write', 'write_file'],
            planner: ['file_read', 'read_file', 'grep', 'file_search'],
        };
        const hints = roleToolHints[roleLower];
        if (!hints)
            return allTools;
        const filtered = hints.filter((t) => allTools.includes(t));
        return filtered.length > 0 ? filtered : allTools;
    }
    /**
     * Get role-specific prompt template for sub-agents.
     * Research (Anthropic 2025): differentiated role prompts improve agent
     * performance by 10-20% vs generic prompts through better role alignment.
     */
    getRolePrompt(role) {
        var _a;
        const roleLower = (role !== null && role !== void 0 ? role : '').toLowerCase();
        const prompts = {
            researcher: [
                'You are a Research Specialist. Your priority is finding complete, accurate information.',
                'Search thoroughly across multiple sources before drawing conclusions.',
                'Cross-reference findings and cite specific sources for every claim.',
                'When data is incomplete, state what is missing rather than guessing.',
                'Return all findings with sources and confidence scores.',
            ].join(' '),
            coder: [
                'You are a TypeScript Engineer focused on correctness and type safety.',
                'Read files completely before editing. Follow existing patterns and conventions.',
                'Never use `as any` casts or `@ts-ignore` comments. Add proper error handling.',
                'Write production-quality code matching the project style.',
                'Clean up unused imports, variables, and dead code after your changes.',
            ].join(' '),
            reviewer: [
                'You are a Code Reviewer focused on correctness, security, and maintainability.',
                'Examine code for bugs, edge cases, security vulnerabilities, and performance issues.',
                "Check that changes follow existing conventions and don't break downstream consumers.",
                'Be critical and thorough. Flag potential issues even if uncertain.',
            ].join(' '),
            planner: [
                'You are a Planning Specialist. Your focus is task decomposition and dependency analysis.',
                'Break down complex tasks into independent, well-defined sub-tasks.',
                'Identify dependencies between sub-tasks and order them correctly.',
                'Estimate effort and resources needed for each sub-task.',
            ].join(' '),
            synthesizer: [
                'You are a Synthesis Specialist. Your role is to combine and reconcile multiple outputs.',
                'Identify agreements and conflicts across different sub-agent results.',
                'Produce a unified, coherent final output that addresses the original goal.',
                'Give more weight to high-confidence results and flag low-confidence findings.',
            ].join(' '),
        };
        return ((_a = prompts[roleLower]) !== null && _a !== void 0 ? _a : [
            'You are a Specialist Agent. Complete your assigned task accurately and efficiently.',
            'Focus on the specific sub-task. Do not expand scope beyond what was assigned.',
            'Report outcomes faithfully. If something fails, say so with details.',
        ].join(' '));
    }
    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }
}
exports.SubAgentExecutor = SubAgentExecutor;
