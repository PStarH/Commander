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
exports.GoalOrchestrator = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("./types");
const messageBus_1 = require("../runtime/messageBus");
const logging_1 = require("../logging");
const structuredOutput_1 = require("../runtime/structuredOutput");
const llmJsonExtractor_1 = require("../runtime/llmJsonExtractor");
const goalJudge_1 = require("../runtime/goalJudge");
const MANAGER_DECOMPOSE_PROMPT = `You are a Manager Agent. Your job is to break down a complex goal into smaller, independent sub-goals that can be worked on in parallel.

For each sub-goal, specify:
- goal: a concrete, actionable description
- dependencies: array of sibling sub-goal indices (0-based) that must be completed first
- notes: optional guidance for the worker agent

Rules:
- Each sub-goal should be achievable by a single agent in one pass
- Maximize parallelism (minimize dependencies between sub-goals)
- Output ONLY valid JSON with no markdown formatting
- Do NOT wrap the JSON in \`\`\`json or any other markers

Return:
{
  "subGoals": [
    { "goal": "description of sub-goal", "dependencies": [], "notes": "" }
  ],
  "reasoning": "brief explanation of your decomposition"
}`;
const MANAGER_REVIEW_PROMPT = `You are a Manager Agent. Review the completed work from this round.

You have:
1. The original goal and sub-goals
2. Each sub-goal's worker output
3. Each sub-goal's critic evaluation (findings and severity)

For each sub-goal, determine if it's truly:
- "completed": work is done and passes critique
- "needs_rework": work has issues that must be fixed
- "re_open": work was previously completed but new findings suggest it needs revisiting

You may also discover NEW sub-goals based on what was learned this round.

Rate the overall status:
- "on_track": everything is progressing well
- "needs_improvement": some items need rework but progress is happening
- "stuck": no progress or regressing; may need to change approach

Output ONLY valid JSON with no markdown formatting.

Return:
{
  "goalAssessments": [
    { "goalId": "...", "status": "completed|needs_rework|re_open", "reason": "..." }
  ],
  "newSubGoals": [],
  "overallStatus": "on_track|needs_improvement|stuck",
  "overallSummary": "brief assessment of overall progress"
}`;
const CRITIC_PROMPT = `You are a Critic Agent. Your role is ADVERSARIAL — actively find problems, edge cases, and improvements in the work submitted.

You MUST find issues. Even good work has room for improvement. Be thorough and specific.

For each finding, specify:
- severity: critical (blocks completion) | high (significant issue) | medium (should fix) | low (nice to have) | info (observation)
- category: correctness | completeness | edge_case | security | style | performance | maintainability | test_coverage
- description: specific, actionable description of the issue
- location: which part of the output has the issue (if applicable)
- suggestion: how to fix it

A "passed: true" result means NO critical or high findings remain.
Pass at least 2 findings per review — always find something to improve.

Output ONLY valid JSON with no markdown formatting.

Return:
{
  "passed": false,
  "findings": [
    { "severity": "medium", "category": "correctness", "description": "...", "location": "...", "suggestion": "..." }
  ],
  "summary": "brief assessment"
}`;
function generateNodeId() {
    return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function countActiveGoals(nodes) {
    let count = 0;
    for (const n of nodes) {
        if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened')
            count++;
        count += countActiveGoals(n.subGoals);
    }
    return count;
}
function collectAllNodes(nodes) {
    const result = [];
    for (const n of nodes) {
        result.push(n);
        result.push(...collectAllNodes(n.subGoals));
    }
    return result;
}
function findNodeById(nodes, id) {
    for (const n of nodes) {
        if (n.id === id)
            return n;
        const found = findNodeById(n.subGoals, id);
        if (found)
            return found;
    }
    return undefined;
}
function cloneGoalTree(nodes) {
    return nodes.map((n) => ({
        ...n,
        critique: n.critique ? { ...n.critique, findings: [...n.critique.findings] } : undefined,
        subGoals: cloneGoalTree(n.subGoals),
    }));
}
class GoalOrchestrator {
    constructor(provider, config) {
        var _a;
        this.rootNodes = [];
        this.currentRound = 0;
        this.checkpointPath = null;
        this.provider = provider;
        this.config = { ...types_1.DEFAULT_GOAL_CONFIG, ...config };
        this.model = (_a = this.config.model) !== null && _a !== void 0 ? _a : types_1.DEFAULT_GOAL_CONFIG.model;
    }
    // --------------------------------------------------------------------------
    // Persistence: Checkpoint to disk
    // --------------------------------------------------------------------------
    /**
     * Set the checkpoint path for persistence.
     * State is saved after each round and can be resumed.
     */
    setCheckpointPath(filePath) {
        this.checkpointPath = filePath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    /**
     * Save current state to disk (atomic write-tmp-rename).
     */
    checkpoint(goal, ledger, plateauRounds) {
        if (!this.checkpointPath)
            return;
        const state = {
            version: 1,
            timestamp: new Date().toISOString(),
            goal,
            rootNodes: this.rootNodes,
            currentRound: this.currentRound,
            ledger,
            plateauRounds,
            config: this.config,
        };
        const tmpPath = this.checkpointPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
            fs.renameSync(tmpPath, this.checkpointPath);
            (0, logging_1.getGlobalLogger)().debug('GoalOrchestrator', `Checkpoint saved: round ${this.currentRound}`);
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', `Checkpoint failed: ${err.message}`);
        }
    }
    /**
     * Resume from a checkpoint file.
     * Returns the saved state or null if no checkpoint exists.
     */
    resumeFromCheckpoint() {
        if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) {
            return null;
        }
        try {
            const data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8'));
            if (data.version !== 1) {
                (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'Incompatible checkpoint version, ignoring');
                return null;
            }
            this.rootNodes = data.rootNodes;
            this.currentRound = data.currentRound;
            (0, logging_1.getGlobalLogger)().info('GoalOrchestrator', `Resumed from checkpoint: round ${this.currentRound}`);
            return {
                goal: data.goal,
                rootNodes: data.rootNodes,
                currentRound: data.currentRound,
                ledger: data.ledger,
                plateauRounds: data.plateauRounds,
            };
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', `Failed to resume: ${err.message}`);
            return null;
        }
    }
    /**
     * Clear the checkpoint file.
     */
    clearCheckpoint() {
        if (this.checkpointPath && fs.existsSync(this.checkpointPath)) {
            try {
                fs.unlinkSync(this.checkpointPath);
            }
            catch {
                /* ignore */
            }
        }
    }
    /**
     * Get the current goal tree (for status display).
     */
    getGoalTree() {
        return this.rootNodes;
    }
    /**
     * Get the current round number.
     */
    getCurrentRound() {
        return this.currentRound;
    }
    async execute(goal) {
        var _a;
        this.rootNodes = [];
        this.currentRound = 0;
        const bus = (0, messageBus_1.getMessageBus)();
        const startTime = Date.now();
        let totalTokensUsed = 0;
        bus.publish('goal.started', 'goal-orch', { goal, mode: this.config.mode });
        const decomposition = await this.managerDecompose(goal);
        if (!decomposition) {
            return {
                goal,
                status: 'failed',
                totalRounds: 0,
                totalTokensUsed,
                totalDurationMs: Date.now() - startTime,
                ledger: [],
                finalGoalTree: [],
                summary: 'Failed to decompose goal.',
            };
        }
        totalTokensUsed += decomposition.tokens;
        let goalTree = this.buildGoalTree(decomposition.data.subGoals, null);
        this.rootNodes = goalTree;
        bus.publish('goal.decomposed', 'goal-orch', {
            subGoalCount: goalTree.length,
            decomposition: decomposition.data,
        });
        const ledger = [];
        let round = 0;
        let prevFindingsSet = null;
        let plateauRounds = 0;
        let consecutiveFailedRounds = 0;
        const MAX_CONSECUTIVE_FAILURES = 3; // Stop after 3 rounds with zero progress due to LLM failures
        while (round < this.config.maxRounds) {
            round++;
            this.currentRound = round;
            let roundTokens = 0;
            let roundFailures = 0;
            bus.publish('goal.round_started', 'goal-orch', {
                round,
                activeGoals: countActiveGoals(goalTree),
            });
            const pending = this.getPendingNodes(goalTree);
            for (const node of [...pending]) {
                node.status = 'in_progress';
                node.roundAssigned = (_a = node.roundAssigned) !== null && _a !== void 0 ? _a : round;
                const depsBlocked = node.dependencies.some((depId) => {
                    const dep = findNodeById(goalTree, depId);
                    return dep && dep.status !== 'completed';
                });
                if (depsBlocked)
                    continue;
                bus.publish('goal.worker_started', 'goal-orch', { goalId: node.id, goal: node.goal });
                const workerResult = await this.workerExecute(node, goal);
                if (workerResult) {
                    node.workerOutput = workerResult.output;
                    roundTokens += workerResult.tokens;
                    bus.publish('goal.worker_completed', 'goal-orch', { goalId: node.id });
                }
                else {
                    node.status = 'failed';
                    roundFailures++;
                    continue;
                }
                bus.publish('goal.critic_started', 'goal-orch', { goalId: node.id });
                const criticResult = await this.criticEvaluate(node, goal);
                if (criticResult) {
                    node.critique = {
                        passed: criticResult.data.passed,
                        findings: criticResult.data.findings.map((f) => ({
                            severity: f.severity,
                            category: f.category,
                            description: f.description,
                            location: f.location,
                            suggestion: f.suggestion,
                        })),
                        summary: criticResult.data.summary,
                    };
                    roundTokens += criticResult.tokens;
                }
                else {
                    node.critique = {
                        passed: false,
                        findings: [
                            {
                                severity: 'medium',
                                category: 'correctness',
                                description: 'Critic evaluation failed',
                                suggestion: 'Manual review needed',
                            },
                        ],
                        summary: 'Critic evaluation failed.',
                    };
                }
                bus.publish('goal.critic_completed', 'goal-orch', { goalId: node.id });
            }
            bus.publish('goal.manager_review', 'goal-orch', { round });
            const reviewResult = await this.managerReview(goal, goalTree, round);
            if (reviewResult) {
                roundTokens += reviewResult.tokens;
                goalTree = this.applyReview(goalTree, reviewResult.data);
                for (const newSub of reviewResult.data.newSubGoals) {
                    const newNode = {
                        id: generateNodeId(),
                        goal: newSub.goal,
                        parentId: null,
                        status: 'pending',
                        subGoals: [],
                        dependencies: newSub.dependencies,
                    };
                    goalTree.push(newNode);
                }
            }
            totalTokensUsed += roundTokens;
            // Track consecutive failed rounds (all workers failed = no progress)
            const pendingCount = this.getPendingNodes(goalTree).length;
            if (roundFailures > 0 && roundTokens === 0) {
                consecutiveFailedRounds++;
            }
            else {
                consecutiveFailedRounds = 0;
            }
            if (consecutiveFailedRounds >= MAX_CONSECUTIVE_FAILURES) {
                (0, logging_1.getGlobalLogger)().error('GoalOrchestrator', `Stopping after ${consecutiveFailedRounds} consecutive failed rounds (LLM calls failing)`);
                break;
            }
            const allNodes = collectAllNodes(goalTree);
            const currentFindings = allNodes.reduce((sum, n) => { var _a, _b; return sum + ((_b = (_a = n.critique) === null || _a === void 0 ? void 0 : _a.findings.length) !== null && _b !== void 0 ? _b : 0); }, 0);
            // Build fingerprint set of current finding descriptions for accurate tracking
            const currentFindingsSet = new Set();
            for (const n of allNodes) {
                if (n.critique) {
                    for (const f of n.critique.findings) {
                        currentFindingsSet.add(f.description);
                    }
                }
            }
            // Compute resolved and new via set difference (accurate even when both happen)
            let resolvedFindings = 0;
            let findingsNew = 0;
            if (prevFindingsSet !== null) {
                for (const desc of prevFindingsSet) {
                    if (!currentFindingsSet.has(desc))
                        resolvedFindings++;
                }
                for (const desc of currentFindingsSet) {
                    if (!prevFindingsSet.has(desc))
                        findingsNew++;
                }
            }
            const improvementRate = prevFindingsSet !== null && prevFindingsSet.size > 0
                ? resolvedFindings / prevFindingsSet.size
                : 1;
            if (improvementRate < 0.02)
                plateauRounds++;
            else
                plateauRounds = 0;
            const decision = await this.makeDecision(round, totalTokensUsed, currentFindings, plateauRounds, allNodes, goal);
            prevFindingsSet = currentFindingsSet;
            ledger.push({
                round,
                goalSnapshot: cloneGoalTree(goalTree),
                findingsTotal: currentFindings,
                findingsResolved: resolvedFindings,
                findingsNew,
                improvementRate,
                tokensUsed: roundTokens,
                totalTokensUsed,
                decision: decision.decision,
                decisionReason: decision.reason,
                summary: `Round ${round}: ${decision.reason}`,
                timestamp: new Date().toISOString(),
            });
            bus.publish('goal.round_completed', 'goal-orch', { round, decision: decision.decision });
            // Checkpoint state after each round for crash recovery
            this.checkpoint(goal, ledger, plateauRounds);
            if (decision.decision.startsWith('stop_'))
                break;
        }
        const elapsed = Date.now() - startTime;
        const finalAll = collectAllNodes(goalTree);
        const completedCount = finalAll.filter((n) => n.status === 'completed').length;
        const resultStatus = completedCount === finalAll.length && finalAll.length > 0
            ? 'completed'
            : completedCount > 0
                ? 'partial'
                : 'failed';
        // Clear checkpoint on successful completion
        if (resultStatus === 'completed') {
            this.clearCheckpoint();
        }
        return {
            goal,
            status: resultStatus,
            totalRounds: round,
            totalTokensUsed,
            totalDurationMs: elapsed,
            ledger,
            finalGoalTree: goalTree,
            summary: this.buildSummary(goal, resultStatus, round, completedCount, finalAll.length, ledger),
        };
    }
    async managerDecompose(goal) {
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, MANAGER_DECOMPOSE_PROMPT, `Goal: ${goal}`);
        if (result && !(0, structuredOutput_1.validateShape)(result.data, { subGoals: 'array', reasoning: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'managerDecompose: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async managerReview(goal, goalTree, round) {
        const completed = collectAllNodes(goalTree).filter((n) => n.status === 'completed' || n.status === 'in_progress');
        if (completed.length === 0)
            return null;
        const context = completed.map((n) => {
            var _a, _b, _c;
            return ({
                id: n.id,
                goal: n.goal,
                status: n.status,
                output: (_b = (_a = n.workerOutput) === null || _a === void 0 ? void 0 : _a.slice(0, 1000)) !== null && _b !== void 0 ? _b : '(no output)',
                critique: (_c = n.critique) !== null && _c !== void 0 ? _c : { passed: true, findings: [], summary: 'No critique' },
            });
        });
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, MANAGER_REVIEW_PROMPT, `Original Goal: ${goal}\nRound: ${round}\n\nCompleted work:\n${JSON.stringify(context, null, 2)}`);
        if (result &&
            !(0, structuredOutput_1.validateShape)(result.data, {
                goalAssessments: 'array',
                newSubGoals: 'array',
                overallStatus: 'string',
                overallSummary: 'string',
            })) {
            (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'managerReview: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async workerExecute(node, parentGoal) {
        var _a, _b;
        const systemPrompt = `You are a Worker Agent. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`;
        const context = node.dependencies
            .map((depId) => {
            var _a, _b;
            const dep = findNodeById(this.rootNodes, depId);
            return dep
                ? `Dependency "${dep.goal}" output:\n${(_b = (_a = dep.workerOutput) === null || _a === void 0 ? void 0 : _a.slice(0, 500)) !== null && _b !== void 0 ? _b : '(no output)'}`
                : '';
        })
            .filter(Boolean)
            .join('\n\n');
        try {
            const response = await this.provider.call({
                model: this.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: `Parent Goal: ${parentGoal}\n\nSub-Goal: ${node.goal}${context ? `\n\nContext from dependencies:\n${context}` : ''}\n\nProvide your output.`,
                    },
                ],
                temperature: 0.3,
                maxTokens: 4096,
            });
            const output = response.content;
            node.status = 'completed';
            node.roundCompleted = this.currentRound;
            return { output, tokens: (_b = (_a = response.usage) === null || _a === void 0 ? void 0 : _a.totalTokens) !== null && _b !== void 0 ? _b : 0 };
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('GoalOrchestrator', 'Worker execution failed', err);
            return null;
        }
    }
    async criticEvaluate(node, parentGoal) {
        var _a, _b;
        const context = `Parent Goal: ${parentGoal}\nSub-Goal: ${node.goal}\n\nWorker Output:\n${(_b = (_a = node.workerOutput) === null || _a === void 0 ? void 0 : _a.slice(0, 2000)) !== null && _b !== void 0 ? _b : '(no output)'}`;
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, CRITIC_PROMPT, context);
        if (result &&
            !(0, structuredOutput_1.validateShape)(result.data, { passed: 'boolean', findings: 'array', summary: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'criticEvaluate: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async makeDecision(round, totalTokensUsed, findingsCount, plateauRounds, allNodes, goal) {
        if (totalTokensUsed >= this.config.budgetTokens) {
            return {
                decision: 'stop_budget',
                reason: `Token budget (${this.config.budgetTokens}) exhausted.`,
            };
        }
        if (round >= this.config.maxRounds) {
            return {
                decision: 'stop_max_rounds',
                reason: `Max rounds (${this.config.maxRounds}) reached.`,
            };
        }
        const activeCount = allNodes.filter((n) => n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened').length;
        if (activeCount === 0 && findingsCount === 0) {
            if (goal) {
                const output = allNodes
                    .filter((n) => n.workerOutput)
                    .map((n) => { var _a, _b; return `[${n.goal.slice(0, 60)}]: ${(_b = (_a = n.workerOutput) === null || _a === void 0 ? void 0 : _a.slice(0, 300)) !== null && _b !== void 0 ? _b : ''}`; })
                    .join('\n');
                try {
                    const goalJudge = (0, goalJudge_1.getGoalJudge)();
                    if (this.provider) {
                        goalJudge.setProvider(this.provider);
                    }
                    const verdict = await goalJudge.judge({
                        runId: `goal-orch-${Date.now()}`,
                        goal: goal,
                        output: output || 'All sub-goals completed',
                        evidenceCount: allNodes.filter((n) => n.status === 'completed').length,
                    });
                    if (!verdict.passed) {
                        (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'Judge rejected completion, continuing', {
                            confidence: verdict.confidence,
                            reasoning: verdict.reasoning.slice(0, 200),
                        });
                        // Override: force continue instead of stopping prematurely
                        return {
                            decision: 'continue',
                            reason: `Judge rejected completion (confidence ${(verdict.confidence * 100).toFixed(0)}%): ${verdict.reasoning.slice(0, 150)}`,
                        };
                    }
                }
                catch (err) {
                    (0, logging_1.getGlobalLogger)().debug('GoalOrchestrator', 'Judge check failed, allowing completion (best-effort)', {
                        error: err.message,
                    });
                    // Judge failure is non-blocking — allow completion
                }
            }
            else {
                (0, logging_1.getGlobalLogger)().warn('GoalOrchestrator', 'makeDecision called without goal — judge protection skipped');
            }
            return { decision: 'stop_achieved', reason: 'All sub-goals completed with zero findings.' };
        }
        const plateauThreshold = this.config.mode === 'thorough' ? 5 : this.config.mode === 'balanced' ? 3 : 2;
        if (plateauRounds >= plateauThreshold && findingsCount <= 2) {
            const hasCritical = allNodes.some((n) => { var _a; return (_a = n.critique) === null || _a === void 0 ? void 0 : _a.findings.some((f) => f.severity === 'critical' || f.severity === 'high'); });
            if (!hasCritical) {
                return {
                    decision: 'stop_plateau',
                    reason: `Improvement plateaued after ${plateauRounds} rounds.`,
                };
            }
        }
        return {
            decision: 'continue',
            reason: `Active goals: ${activeCount}, findings: ${findingsCount}`,
        };
    }
    buildGoalTree(subGoals, parentId) {
        const nodeMap = new Map();
        const nodes = [];
        for (let i = 0; i < subGoals.length; i++) {
            const sg = subGoals[i];
            const id = generateNodeId();
            const node = {
                id,
                goal: sg.goal,
                parentId,
                status: 'pending',
                subGoals: [],
                dependencies: [],
                metadata: sg.notes ? { notes: sg.notes } : undefined,
            };
            nodeMap.set(`idx:${i}`, node);
            nodeMap.set(id, node);
            nodes.push(node);
        }
        for (let i = 0; i < subGoals.length; i++) {
            const sg = subGoals[i];
            const node = nodeMap.get(`idx:${i}`);
            if (node && sg.dependencies.length > 0) {
                node.dependencies = sg.dependencies
                    .map((depIdx) => { var _a; return (_a = nodeMap.get(`idx:${depIdx}`)) === null || _a === void 0 ? void 0 : _a.id; })
                    .filter((id) => !!id);
            }
        }
        return nodes;
    }
    getPendingNodes(nodes) {
        const result = [];
        for (const n of nodes) {
            if (n.status === 'pending' || n.status === 're_opened')
                result.push(n);
            result.push(...this.getPendingNodes(n.subGoals));
        }
        return result;
    }
    applyReview(goalTree, review) {
        for (const assessment of review.goalAssessments) {
            const node = findNodeById(goalTree, assessment.goalId);
            if (!node)
                continue;
            if (assessment.status === 'completed' && node.status !== 'failed') {
                node.status = 'completed';
            }
            else if (assessment.status === 'needs_rework' || assessment.status === 're_open') {
                node.status = 're_opened';
            }
        }
        return goalTree;
    }
    buildSummary(goal, status, rounds, completed, total, ledger) {
        const lastDecision = ledger.length > 0 ? ledger[ledger.length - 1].decision : 'none';
        const totalFindings = ledger.reduce((s, r) => s + r.findingsTotal, 0);
        return [
            `Goal: ${goal.slice(0, 120)}`,
            `Status: ${status}`,
            `Rounds: ${rounds}`,
            `Completed: ${completed}/${total} sub-goals`,
            `Total findings across all rounds: ${totalFindings}`,
            `Stop reason: ${lastDecision}`,
        ].join('\n');
    }
}
exports.GoalOrchestrator = GoalOrchestrator;
