import type { LLMProvider } from '../runtime/types';
import type { CritiqueResult } from '../goal/types';
import type {
  SwarmConfig,
  SwarmNode,
  SwarmManager,
  SwarmTopology,
  SwarmResult,
  SwarmStatus,
  FusionReport,
} from './types';
import { DEFAULT_SWARM_CONFIG } from './types';
import { FusionEngine } from './fusionEngine';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import { callLLMJSON } from '../runtime/llmJsonExtractor';
import { validateShape } from '../runtime/structuredOutput';

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

// ============================================================================
// Helpers
// ============================================================================

interface DecompositionOutput {
  subGoals: Array<{
    goal: string;
    dependencies: string[];
    notes?: string;
    complexity?: number;
  }>;
  reasoning: string;
}

interface ReviewOutput {
  goalAssessments: Array<{
    goalId: string;
    status: 'completed' | 'needs_rework' | 're_open';
    reason: string;
  }>;
  newSubGoals: Array<{ goal: string; dependencies: string[] }>;
  overallStatus: 'on_track' | 'needs_improvement' | 'stuck';
  overallSummary: string;
}

interface CriticOutput {
  passed: boolean;
  findings: Array<{
    severity: CritiqueResult['findings'][0]['severity'];
    category: string;
    description: string;
    location?: string;
    suggestion?: string;
  }>;
  summary: string;
}

function generateNodeId(): string {
  return `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function findNodeById(nodes: SwarmNode[], id: string): SwarmNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    for (const child of n.children) {
      if (child.id === id) return findNodeById(child.result?.rootNodes ?? [], id);
    }
    const found = findNodeById(n.subNodes, id);
    if (found) return found;
  }
  return undefined;
}

function collectAllNodes(nodes: SwarmNode[]): SwarmNode[] {
  const result: SwarmNode[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...collectAllNodes(n.subNodes));
    for (const child of n.children) {
      result.push(...collectAllNodes(child.result?.rootNodes ?? []));
    }
  }
  return result;
}

function countActiveNodes(nodes: SwarmNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened') count++;
    count += countActiveNodes(n.subNodes);
    for (const child of n.children) {
      count += countActiveNodes(child.result?.rootNodes ?? []);
    }
  }
  return count;
}

function computeTopology(nodes: SwarmNode[], depth = 0): SwarmTopology {
  let managerCount = 1;
  let totalNodes = nodes.length;
  const levelBreaths: number[] = [];

  // Record breadth at current depth
  levelBreaths[depth] = (levelBreaths[depth] ?? 0) + nodes.length;

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
          levelBreaths[targetDepth] = (levelBreaths[targetDepth] ?? 0) + childTopo.levelBreaths[i];
        }
      }
    }
    // Sub-nodes are local decomposition at same depth
    const subTopo = computeTopology(n.subNodes, depth);
    if (subTopo.levelBreaths.length > 0) {
      for (let i = 0; i < subTopo.levelBreaths.length; i++) {
        levelBreaths[i] = (levelBreaths[i] ?? 0) + subTopo.levelBreaths[i];
      }
    }
  }

  // Find the deepest populated level
  let effectiveDepth = 0;
  for (let i = 0; i < levelBreaths.length; i++) {
    if (levelBreaths[i] > 0) effectiveDepth = i;
  }

  return {
    managerCount,
    totalNodes,
    depth: effectiveDepth,
    levelBreaths: levelBreaths.filter(b => b > 0),
  };
}

// ============================================================================
// SwarmOrchestrator
// ============================================================================

export class SwarmOrchestrator {
  private provider: LLMProvider;
  private config: SwarmConfig;
  private model: string;
  private fusionEngine: FusionEngine;
  private rootNodes: SwarmNode[] = [];
  private depth: number;
  private fusionReports: FusionReport[] = [];

  constructor(
    provider: LLMProvider,
    config?: Partial<SwarmConfig>,
    depth = 0,
  ) {
    this.provider = provider;
    this.config = { ...DEFAULT_SWARM_CONFIG, ...config };
    this.model = this.config.model ?? 'gpt-4o-mini';
    this.fusionEngine = new FusionEngine();
    this.depth = depth;
  }

  async execute(goal: string): Promise<SwarmResult> {
    this.rootNodes = [];
    this.fusionReports = [];

    const bus = getMessageBus();
    const startTime = Date.now();
    let totalTokensUsed = 0;

    bus.publish('swarm.started', 'swarm-orch', {
      goal,
      depth: this.depth,
      mode: this.config.goalConfig.mode ?? 'balanced',
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
    let prevFindingsSet: Set<string> | null = null;
    let plateauRounds = 0;
    const maxRounds = this.config.goalConfig.maxRounds ?? 10;

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

        const depsBlocked = node.dependencies.some(depId => {
          const dep = findNodeById(goalTree, depId);
          if (!dep) return true;
          return dep.status !== 'completed';
        });
        if (depsBlocked) continue;

        // Skip nodes that were fissioned (they have children)
        if (node.children.length > 0) continue;

        const workerResult = await this.workerExecute(node, goal);
        if (workerResult) {
          node.workerOutput = workerResult.output;
          roundTokens += workerResult.tokens;
        } else {
          node.status = 'failed';
          continue;
        }

        const criticResult = await this.criticEvaluate(node, goal);
        if (criticResult) {
          node.critique = {
            passed: criticResult.data.passed,
            findings: criticResult.data.findings.map(f => ({
              severity: f.severity,
              category: f.category as CritiqueResult['findings'][0]['category'],
              description: f.description,
              location: f.location,
              suggestion: f.suggestion,
            })),
            summary: criticResult.data.summary,
          };
          roundTokens += criticResult.tokens;
        } else {
          node.critique = {
            passed: false,
            findings: [{ severity: 'medium' as const, category: 'correctness' as const, description: 'Critic evaluation failed', suggestion: 'Manual review needed' }],
            summary: 'Critic evaluation failed.',
          };
        }
      }

      // === FUSION: detect cross-worker conflicts ===
      const allNodes = collectAllNodes(goalTree);
      const activeNodes = allNodes.filter(n => n.status === 'completed' || n.status === 'in_progress');
      const fusionReport = this.fusionEngine.analyze(activeNodes, round);
      if (this.fusionReports.length > 200) this.fusionReports.shift();
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
          const newNode: SwarmNode = {
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
      const totalFindings = allNodes.reduce((sum, n) => sum + (n.critique?.findings.length ?? 0), 0);

      // Build fingerprint set of current finding descriptions for accurate tracking
      const currentFindingsSet = new Set<string>();
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
          if (!currentFindingsSet.has(desc)) resolvedFindings++;
        }
      }

      const improvementRate = prevFindingsSet !== null && prevFindingsSet.size > 0
        ? resolvedFindings / prevFindingsSet.size
        : 1;

      if (improvementRate < 0.02) plateauRounds++;
      else plateauRounds = 0;
      prevFindingsSet = currentFindingsSet;

      const decision = this.makeDecision(
        round, totalTokensUsed, totalFindings, plateauRounds, allNodes,
      );

      bus.publish('swarm.completed', 'swarm-orch', { round, depth: this.depth, decision });

      if (decision.startsWith('stop_')) break;
    }

    const elapsed = Date.now() - startTime;
    const finalAll = collectAllNodes(goalTree);
    const completedCount = finalAll.filter(n => n.status === 'completed').length;
    const resultStatus: SwarmStatus = completedCount === finalAll.length && finalAll.length > 0
      ? 'completed'
      : completedCount > 0 ? 'partial' : 'failed';

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
  private async processFission(nodes: SwarmNode[]): Promise<void> {
    for (const node of nodes) {
      if (node.children.length > 0 || node.status !== 'pending') continue;

      const complexity = node.metadata?.complexity as number ?? 3;
      const shouldFission = complexity >= this.config.fissionThreshold
        && this.depth < this.config.maxDepth;

      if (shouldFission) {
        const childOrch = new SwarmOrchestrator(
          this.provider,
          {
            ...this.config,
            goalConfig: { ...this.config.goalConfig },
          },
          this.depth + 1,
        );

        const childResult = await childOrch.execute(node.goal);

        const childManager: SwarmManager = {
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
          .filter(n => n.critique)
          .flatMap(n => n.critique!.findings);
        if (childFindings.length > 0) {
          node.critique = {
            passed: !childFindings.some(f => f.severity === 'critical' || f.severity === 'high'),
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
  private makeDecision(
    round: number,
    totalTokensUsed: number,
    findingsCount: number,
    plateauRounds: number,
    allNodes: SwarmNode[],
  ): string {
    const budgetTokens = this.config.goalConfig.budgetTokens ?? 500_000;
    const maxRounds = this.config.goalConfig.maxRounds ?? 10;

    if (totalTokensUsed >= budgetTokens) {
      return 'stop_budget';
    }

    if (round >= maxRounds) {
      return 'stop_max_rounds';
    }

    const activeCount = allNodes.filter(n =>
      n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened'
    ).length;

    if (activeCount === 0 && findingsCount === 0) {
      return 'stop_achieved';
    }

    const mode = this.config.goalConfig.mode ?? 'balanced';
    const plateauThreshold = mode === 'thorough' ? 5
      : mode === 'balanced' ? 3
      : 2;

    if (plateauRounds >= plateauThreshold && findingsCount <= 2) {
      const hasCritical = allNodes.some(n =>
        n.critique?.findings.some(f => f.severity === 'critical' || f.severity === 'high')
      );
      if (!hasCritical) {
        return 'stop_plateau';
      }
    }

    return 'continue';
  }

  // ========================================================================
  // LLM calls
  // ========================================================================

  private async managerDecompose(goal: string): Promise<{ data: DecompositionOutput; tokens: number } | null> {
    const result = await callLLMJSON<DecompositionOutput>(
      this.provider, this.model,
      MANAGER_DECOMPOSE_PROMPT,
      `Goal: ${goal}`,
    );
    if (result && !validateShape(result.data, { subGoals: 'array', reasoning: 'string' })) {
      getGlobalLogger().warn('SwarmOrchestrator', 'managerDecompose: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async managerReview(
    goal: string,
    goalTree: SwarmNode[],
    round: number,
    fusionReport: FusionReport,
  ): Promise<{ data: ReviewOutput; tokens: number } | null> {
    const completed = collectAllNodes(goalTree).filter(n => n.status === 'completed' || n.status === 'in_progress');
    if (completed.length === 0) return null;

    const context = completed.map(n => ({
      id: n.id,
      goal: n.goal,
      status: n.status,
      output: n.workerOutput?.slice(0, 1000) ?? '(no output)',
      critique: n.critique ?? { passed: true, findings: [], summary: 'No critique' },
      childManagers: n.children.length > 0
        ? n.children.map(c => ({
            id: c.id,
            goal: c.goal,
            status: c.result?.status ?? 'unknown',
            summary: c.result?.summary?.slice(0, 500) ?? '',
          }))
        : undefined,
    }));

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

    const result = await callLLMJSON<ReviewOutput>(
      this.provider, this.model,
      MANAGER_REVIEW_PROMPT,
      userMessage,
    );
    if (result && !validateShape(result.data, { goalAssessments: 'array', newSubGoals: 'array', overallStatus: 'string', overallSummary: 'string' })) {
      getGlobalLogger().warn('SwarmOrchestrator', 'managerReview: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async workerExecute(
    node: SwarmNode,
    parentGoal: string,
  ): Promise<{ output: string; tokens: number } | null> {
    const context = node.dependencies
      .map(depId => {
        const dep = findNodeById(this.rootNodes, depId);
        return dep ? `Dependency "${dep.goal}" output:\n${dep.workerOutput?.slice(0, 500) ?? '(no output)'}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    try {
      const response = await this.provider.call({
        model: this.model,
        messages: [
          { role: 'system', content: WORKER_PROMPT },
          { role: 'user', content: `Parent Goal: ${parentGoal}\n\nSub-Goal: ${node.goal}${context ? `\n\nContext from dependencies:\n${context}` : ''}\n\nProvide your output.` },
        ],
        temperature: 0.3,
        maxTokens: 4096,
      });
      const output = response.content;
      node.status = 'completed';
      return { output, tokens: response.usage?.totalTokens ?? 0 };
    } catch (err) {
      getGlobalLogger().error('SwarmOrchestrator', 'Worker execution failed', err as Error);
      return null;
    }
  }

  private async criticEvaluate(
    node: SwarmNode,
    parentGoal: string,
  ): Promise<{ data: CriticOutput; tokens: number } | null> {
    const context = `Parent Goal: ${parentGoal}\nSub-Goal: ${node.goal}\n\nWorker Output:\n${node.workerOutput?.slice(0, 2000) ?? '(no output)'}`;
    const result = await callLLMJSON<CriticOutput>(
      this.provider, this.model,
      CRITIC_PROMPT,
      context,
    );
    if (result && !validateShape(result.data, { passed: 'boolean', findings: 'array', summary: 'string' })) {
      getGlobalLogger().warn('SwarmOrchestrator', 'criticEvaluate: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  // ========================================================================
  // Tree management
  // ========================================================================

  private buildSwarmTree(
    subGoals: DecompositionOutput['subGoals'],
    parentId: string | null,
  ): SwarmNode[] {
    const nodeMap = new Map<string, SwarmNode>();
    const nodes: SwarmNode[] = [];

    for (let i = 0; i < subGoals.length; i++) {
      const sg = subGoals[i];
      const id = generateNodeId();
      const node: SwarmNode = {
        id,
        goal: sg.goal,
        parentId,
        status: 'pending',
        subNodes: [],
        children: [],
        dependencies: [],
        metadata: {
          notes: sg.notes ?? '',
          complexity: sg.complexity ?? 3,
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
          .map(depIdx => nodeMap.get(`idx:${depIdx}`)?.id)
          .filter((id): id is string => !!id);
      }
    }

    return nodes;
  }

  private getPendingNodes(nodes: SwarmNode[]): SwarmNode[] {
    const result: SwarmNode[] = [];
    for (const n of nodes) {
      if ((n.status === 'pending' || n.status === 're_opened') && n.children.length === 0) {
        result.push(n);
      }
      result.push(...this.getPendingNodes(n.subNodes));
    }
    return result;
  }

  private applyReview(goalTree: SwarmNode[], review: ReviewOutput): void {
    for (const assessment of review.goalAssessments) {
      const node = findNodeById(goalTree, assessment.goalId);
      if (!node) continue;
      if (assessment.status === 'completed' && node.status !== 'failed') {
        node.status = 'completed';
      } else if (assessment.status === 'needs_rework' || assessment.status === 're_open') {
        node.status = 're_opened';
      }
    }
  }

  private buildSummary(
    goal: string,
    status: SwarmStatus,
    rounds: number,
    completed: number,
    total: number,
  ): string {
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
