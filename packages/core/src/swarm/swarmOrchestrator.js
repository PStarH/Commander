"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmOrchestrator = void 0;
const types_1 = require("./types");
const fusionEngine_1 = require("./fusionEngine");
const messageBus_1 = require("../runtime/messageBus");
const logging_1 = require("../logging");
const llmJsonExtractor_1 = require("../runtime/llmJsonExtractor");
const structuredOutput_1 = require("../runtime/structuredOutput");
// ============================================================================
// Prompts — modified from goal/GoalOrchestrator with fission/fusion awareness
// ============================================================================
const MANAGER_DECOMPOSE_PROMPT = `You are a Manager Agent in a Swarm system. Your job is to break down a complex goal into smaller sub-goals that can be worked on in parallel or recursively decomposed.

For each sub-goal, specify:
- goal: a concrete, actionable description
- dependencies: array of sibling sub-goal indices (0-based) that must be completed first
- notes: optional guidance for the worker agent
- complexity: integer 1-10 estimating how complex this sub-goal is (1=trivial, 10=extremely complex)

Complex sub-goals (7+) may be recursively delegated to child managers for further decomposition.
Simple sub-goals (1-3) can be executed directly by a worker.
Medium sub-goals (4-6) may go either way.

Rules:
- Each sub-goal should be achievable by a single agent in one pass
- Maximize parallelism (minimize dependencies between sub-goals)
- Output ONLY valid JSON with no markdown formatting
- Do NOT wrap the JSON in \`\`\`json or any other markers

Return:
{
  "subGoals": [
    { "goal": "description", "dependencies": [], "notes": "", "complexity": 5 }
  ],
  "reasoning": "brief explanation of your decomposition and fission decisions"
}`;
const WORKER_PROMPT = `You are a Worker Agent in a Swarm system. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`;
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
const MANAGER_REVIEW_PROMPT = `You are a Manager Agent in a Swarm system. Review the completed work from this round.

You have:
1. The original goal and sub-goals
2. Each sub-goal's worker output (or child manager result)
3. Each sub-goal's critic evaluation (findings and severity)
4. The FusionEngine conflict report for any cross-worker issues

For each sub-goal, determine if it's truly:
- "completed": work is done and passes critique
- "needs_rework": work has issues that must be fixed
- "re_open": work was previously completed but new findings suggest it needs revisiting

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
function generateNodeId() {
    return `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function findNodeById(nodes, id) {
    var _a, _b;
    for (const n of nodes) {
        if (n.id === id)
            return n;
        for (const child of n.children) {
            if (child.id === id)
                return findNodeById((_b = (_a = child.result) === null || _a === void 0 ? void 0 : _a.rootNodes) !== null && _b !== void 0 ? _b : [], id);
        }
        const found = findNodeById(n.subNodes, id);
        if (found)
            return found;
    }
    return undefined;
}
function collectAllNodes(nodes) {
    var _a, _b;
    const result = [];
    for (const n of nodes) {
        result.push(n);
        result.push(...collectAllNodes(n.subNodes));
        for (const child of n.children) {
            result.push(...collectAllNodes((_b = (_a = child.result) === null || _a === void 0 ? void 0 : _a.rootNodes) !== null && _b !== void 0 ? _b : []));
        }
    }
    return result;
}
function countActiveNodes(nodes) {
    var _a, _b;
    let count = 0;
    for (const n of nodes) {
        if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened')
            count++;
        count += countActiveNodes(n.subNodes);
        for (const child of n.children) {
            count += countActiveNodes((_b = (_a = child.result) === null || _a === void 0 ? void 0 : _a.rootNodes) !== null && _b !== void 0 ? _b : []);
        }
    }
    return count;
}
function computeTopology(nodes, depth = 0) {
    var _a, _b, _c;
    let managerCount = 1;
    let totalNodes = nodes.length;
    const levelBreaths = [];
    // Record breadth at current depth
    levelBreaths[depth] = ((_a = levelBreaths[depth]) !== null && _a !== void 0 ? _a : 0) + nodes.length;
    for (const n of nodes) {
        for (const child of n.children) {
            managerCount++;
            if (child.result) {
                const childTopo = child.result.topology;
                totalNodes += childTopo.totalNodes;
                managerCount += childTopo.managerCount - 1;
                // Merge child level breaths (shifted by current depth + 1)
                for (let i = 0; i < childTopo.levelBreaths.length; i++) {
                    const targetDepth = depth + 1 + i;
                    levelBreaths[targetDepth] = ((_b = levelBreaths[targetDepth]) !== null && _b !== void 0 ? _b : 0) + childTopo.levelBreaths[i];
                }
            }
        }
        // Sub-nodes are local decomposition at same depth
        const subTopo = computeTopology(n.subNodes, depth);
        if (subTopo.levelBreaths.length > 0) {
            for (let i = 0; i < subTopo.levelBreaths.length; i++) {
                levelBreaths[i] = ((_c = levelBreaths[i]) !== null && _c !== void 0 ? _c : 0) + subTopo.levelBreaths[i];
            }
        }
    }
    // Find the deepest populated level
    let effectiveDepth = 0;
    for (let i = 0; i < levelBreaths.length; i++) {
        if (levelBreaths[i] > 0)
            effectiveDepth = i;
    }
    return {
        managerCount,
        totalNodes,
        depth: effectiveDepth,
        levelBreaths: levelBreaths.filter((b) => b > 0),
    };
}
// ============================================================================
// SwarmOrchestrator
// ============================================================================
class SwarmOrchestrator {
    constructor(provider, config, depth = 0) {
        var _a;
        this.rootNodes = [];
        this.fusionReports = [];
        this.provider = provider;
        this.config = { ...types_1.DEFAULT_SWARM_CONFIG, ...config };
        this.model = (_a = this.config.model) !== null && _a !== void 0 ? _a : 'gpt-4o-mini';
        this.fusionEngine = new fusionEngine_1.FusionEngine();
        this.depth = depth;
    }
    async execute(goal) {
        var _a, _b;
        this.rootNodes = [];
        this.fusionReports = [];
        const bus = (0, messageBus_1.getMessageBus)();
        const startTime = Date.now();
        let totalTokensUsed = 0;
        bus.publish('swarm.started', 'swarm-orch', {
            goal,
            depth: this.depth,
            mode: (_a = this.config.goalConfig.mode) !== null && _a !== void 0 ? _a : 'balanced',
        });
        const decomposition = await this.managerDecompose(goal);
        if (!decomposition) {
            return {
                goal,
                status: 'failed',
                totalRounds: 0,
                totalTokensUsed,
                totalDurationMs: Date.now() - startTime,
                topology: { managerCount: 1, totalNodes: 0, depth: this.depth, levelBreaths: [] },
                rootNodes: [],
                fusionReports: [],
                summary: 'Failed to decompose goal.',
            };
        }
        totalTokensUsed += decomposition.tokens;
        const goalTree = this.buildSwarmTree(decomposition.data.subGoals, null);
        this.rootNodes = goalTree;
        bus.publish('swarm.fission', 'swarm-orch', {
            subGoalCount: goalTree.length,
            decomposition: decomposition.data,
            depth: this.depth,
        });
        let round = 0;
        let prevFindingsSet = null;
        let plateauRounds = 0;
        const maxRounds = (_b = this.config.goalConfig.maxRounds) !== null && _b !== void 0 ? _b : 10;
        while (round < maxRounds) {
            round++;
            let roundTokens = 0;
            bus.publish('swarm.fusion_conflict', 'swarm-orch', {
                round,
                depth: this.depth,
                activeGoals: countActiveNodes(goalTree),
            });
            // === FISSION: check each sub-goal for recursive decomposition ===
            await this.processFission(goalTree);
            // === WORKER execution (for non-fissioned nodes) ===
            const pending = this.getPendingNodes(goalTree);
            for (const node of [...pending]) {
                node.status = 'in_progress';
                const depsBlocked = node.dependencies.some((depId) => {
                    const dep = findNodeById(goalTree, depId);
                    if (!dep)
                        return true;
                    return dep.status !== 'completed';
                });
                if (depsBlocked)
                    continue;
                // Skip nodes that were fissioned (they have children)
                if (node.children.length > 0)
                    continue;
                const workerResult = await this.workerExecute(node, goal);
                if (workerResult) {
                    node.workerOutput = workerResult.output;
                    roundTokens += workerResult.tokens;
                }
                else {
                    node.status = 'failed';
                    continue;
                }
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
            }
            // === FUSION: detect cross-worker conflicts ===
            const allNodes = collectAllNodes(goalTree);
            const activeNodes = allNodes.filter((n) => n.status === 'completed' || n.status === 'in_progress');
            const fusionReport = this.fusionEngine.analyze(activeNodes, round);
            if (this.fusionReports.length > 200)
                this.fusionReports.shift();
            this.fusionReports.push(fusionReport);
            if (fusionReport.conflicts.length > 0) {
                bus.publish('system.alert', 'swarm-orch', {
                    type: 'fusion_conflicts',
                    round,
                    conflictCount: fusionReport.conflicts.length,
                });
            }
            // === MANAGER REVIEW ===
            bus.publish('swarm.round_completed', 'swarm-orch', { round, depth: this.depth });
            const reviewResult = await this.managerReview(goal, goalTree, round, fusionReport);
            if (reviewResult) {
                roundTokens += reviewResult.tokens;
                this.applyReview(goalTree, reviewResult.data);
                for (const newSub of reviewResult.data.newSubGoals) {
                    const newNode = {
                        id: generateNodeId(),
                        goal: newSub.goal,
                        parentId: null,
                        status: 'pending',
                        subNodes: [],
                        children: [],
                        dependencies: newSub.dependencies,
                    };
                    goalTree.push(newNode);
                }
            }
            totalTokensUsed += roundTokens;
            // === CONTINUATION DECISION ===
            const totalFindings = allNodes.reduce((sum, n) => { var _a, _b; return sum + ((_b = (_a = n.critique) === null || _a === void 0 ? void 0 : _a.findings.length) !== null && _b !== void 0 ? _b : 0); }, 0);
            // Build fingerprint set of current finding descriptions for accurate tracking
            const currentFindingsSet = new Set();
            for (const n of allNodes) {
                if (n.critique) {
                    for (const f of n.critique.findings) {
                        currentFindingsSet.add(f.description);
                    }
                }
            }
            // Compute resolved via set difference (accurate even when resolution and addition happen together)
            let resolvedFindings = 0;
            if (prevFindingsSet !== null) {
                for (const desc of prevFindingsSet) {
                    if (!currentFindingsSet.has(desc))
                        resolvedFindings++;
                }
            }
            const improvementRate = prevFindingsSet !== null && prevFindingsSet.size > 0
                ? resolvedFindings / prevFindingsSet.size
                : 1;
            if (improvementRate < 0.02)
                plateauRounds++;
            else
                plateauRounds = 0;
            prevFindingsSet = currentFindingsSet;
            const decision = this.makeDecision(round, totalTokensUsed, totalFindings, plateauRounds, allNodes);
            bus.publish('swarm.completed', 'swarm-orch', { round, depth: this.depth, decision });
            if (decision.startsWith('stop_'))
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
        return {
            goal,
            status: resultStatus,
            totalRounds: round,
            totalTokensUsed,
            totalDurationMs: elapsed,
            topology: computeTopology(goalTree, this.depth),
            rootNodes: goalTree,
            fusionReports: this.fusionReports,
            summary: this.buildSummary(goal, resultStatus, round, completedCount, finalAll.length),
        };
    }
    /**
     * FISSION: recursively decompose complex sub-goals into child SwarmOrchestrators.
     */
    async processFission(nodes) {
        var _a, _b;
        for (const node of nodes) {
            if (node.children.length > 0 || node.status !== 'pending')
                continue;
            const complexity = (_b = (_a = node.metadata) === null || _a === void 0 ? void 0 : _a.complexity) !== null && _b !== void 0 ? _b : 3;
            const shouldFission = complexity >= this.config.fissionThreshold && this.depth < this.config.maxDepth;
            if (shouldFission) {
                const childOrch = new SwarmOrchestrator(this.provider, {
                    ...this.config,
                    goalConfig: { ...this.config.goalConfig },
                }, this.depth + 1);
                const childResult = await childOrch.execute(node.goal);
                const childManager = {
                    id: generateNodeId(),
                    goal: node.goal,
                    depth: this.depth + 1,
                    topology: childResult.topology,
                    result: childResult,
                };
                node.children.push(childManager);
                node.status = 'completed';
                node.workerOutput = childResult.summary;
                // Propagate findings from child tree
                const childAllNodes = collectAllNodes(childResult.rootNodes);
                const childFindings = childAllNodes
                    .filter((n) => n.critique)
                    .flatMap((n) => n.critique.findings);
                if (childFindings.length > 0) {
                    node.critique = {
                        passed: !childFindings.some((f) => f.severity === 'critical' || f.severity === 'high'),
                        findings: childFindings.slice(0, 20),
                        summary: `${childFindings.length} finding(s) from child manager`,
                    };
                }
            }
            // Recurse into sub-nodes for multi-level decomposition
            await this.processFission(node.subNodes);
        }
    }
    /**
     * Make continuation decision — same logic as GoalOrchestrator.
     */
    makeDecision(round, totalTokensUsed, findingsCount, plateauRounds, allNodes) {
        var _a, _b, _c;
        const budgetTokens = (_a = this.config.goalConfig.budgetTokens) !== null && _a !== void 0 ? _a : 500000;
        const maxRounds = (_b = this.config.goalConfig.maxRounds) !== null && _b !== void 0 ? _b : 10;
        if (totalTokensUsed >= budgetTokens) {
            return 'stop_budget';
        }
        if (round >= maxRounds) {
            return 'stop_max_rounds';
        }
        const activeCount = allNodes.filter((n) => n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened').length;
        if (activeCount === 0 && findingsCount === 0) {
            return 'stop_achieved';
        }
        const mode = (_c = this.config.goalConfig.mode) !== null && _c !== void 0 ? _c : 'balanced';
        const plateauThreshold = mode === 'thorough' ? 5 : mode === 'balanced' ? 3 : 2;
        if (plateauRounds >= plateauThreshold && findingsCount <= 2) {
            const hasCritical = allNodes.some((n) => { var _a; return (_a = n.critique) === null || _a === void 0 ? void 0 : _a.findings.some((f) => f.severity === 'critical' || f.severity === 'high'); });
            if (!hasCritical) {
                return 'stop_plateau';
            }
        }
        return 'continue';
    }
    // ========================================================================
    // LLM calls
    // ========================================================================
    async managerDecompose(goal) {
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, MANAGER_DECOMPOSE_PROMPT, `Goal: ${goal}`);
        if (result && !(0, structuredOutput_1.validateShape)(result.data, { subGoals: 'array', reasoning: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('SwarmOrchestrator', 'managerDecompose: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async managerReview(goal, goalTree, round, fusionReport) {
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
                childManagers: n.children.length > 0
                    ? n.children.map((c) => {
                        var _a, _b, _c, _d, _e;
                        return ({
                            id: c.id,
                            goal: c.goal,
                            status: (_b = (_a = c.result) === null || _a === void 0 ? void 0 : _a.status) !== null && _b !== void 0 ? _b : 'unknown',
                            summary: (_e = (_d = (_c = c.result) === null || _c === void 0 ? void 0 : _c.summary) === null || _d === void 0 ? void 0 : _d.slice(0, 500)) !== null && _e !== void 0 ? _e : '',
                        });
                    })
                    : undefined,
            });
        });
        const userMessage = [
            `Original Goal: ${goal}`,
            `Round: ${round}`,
            '',
            'Completed work:',
            JSON.stringify(context, null, 2),
            '',
            'Fusion conflict report:',
            JSON.stringify(fusionReport, null, 2),
        ].join('\n');
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, MANAGER_REVIEW_PROMPT, userMessage);
        if (result &&
            !(0, structuredOutput_1.validateShape)(result.data, {
                goalAssessments: 'array',
                newSubGoals: 'array',
                overallStatus: 'string',
                overallSummary: 'string',
            })) {
            (0, logging_1.getGlobalLogger)().warn('SwarmOrchestrator', 'managerReview: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async workerExecute(node, parentGoal) {
        var _a, _b;
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
                    { role: 'system', content: WORKER_PROMPT },
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
            return { output, tokens: (_b = (_a = response.usage) === null || _a === void 0 ? void 0 : _a.totalTokens) !== null && _b !== void 0 ? _b : 0 };
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('SwarmOrchestrator', 'Worker execution failed', err);
            return null;
        }
    }
    async criticEvaluate(node, parentGoal) {
        var _a, _b;
        const context = `Parent Goal: ${parentGoal}\nSub-Goal: ${node.goal}\n\nWorker Output:\n${(_b = (_a = node.workerOutput) === null || _a === void 0 ? void 0 : _a.slice(0, 2000)) !== null && _b !== void 0 ? _b : '(no output)'}`;
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, CRITIC_PROMPT, context);
        if (result &&
            !(0, structuredOutput_1.validateShape)(result.data, { passed: 'boolean', findings: 'array', summary: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('SwarmOrchestrator', 'criticEvaluate: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    // ========================================================================
    // Tree management
    // ========================================================================
    buildSwarmTree(subGoals, parentId) {
        var _a, _b;
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
                subNodes: [],
                children: [],
                dependencies: [],
                metadata: {
                    notes: (_a = sg.notes) !== null && _a !== void 0 ? _a : '',
                    complexity: (_b = sg.complexity) !== null && _b !== void 0 ? _b : 3,
                },
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
            if ((n.status === 'pending' || n.status === 're_opened') && n.children.length === 0) {
                result.push(n);
            }
            result.push(...this.getPendingNodes(n.subNodes));
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
    }
    buildSummary(goal, status, rounds, completed, total) {
        return [
            `Goal: ${goal.slice(0, 120)}`,
            `Status: ${status}`,
            `Rounds: ${rounds}`,
            `Completed: ${completed}/${total} sub-goals`,
            `Fusion conflicts detected: ${this.fusionReports.reduce((s, r) => s + r.conflicts.length, 0)}`,
            `Tree depth: ${this.depth}`,
        ].join('\n');
    }
}
exports.SwarmOrchestrator = SwarmOrchestrator;
