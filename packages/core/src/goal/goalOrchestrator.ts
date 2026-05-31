import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from '../runtime/types';
import type {
  GoalNode,
  GoalConfig,
  GoalResult,
  RoundLedger,
  RoundDecision,
  ManagerDecomposition,
  ManagerReview,
  CriticOutput,
} from './types';
import { DEFAULT_GOAL_CONFIG } from './types';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import { validateShape } from '../runtime/structuredOutput';
import { callLLMJSON } from '../runtime/llmJsonExtractor';

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

function generateNodeId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function countActiveGoals(nodes: GoalNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened') count++;
    count += countActiveGoals(n.subGoals);
  }
  return count;
}

function collectAllNodes(nodes: GoalNode[]): GoalNode[] {
  const result: GoalNode[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...collectAllNodes(n.subGoals));
  }
  return result;
}

function findNodeById(nodes: GoalNode[], id: string): GoalNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNodeById(n.subGoals, id);
    if (found) return found;
  }
  return undefined;
}

function cloneGoalTree(nodes: GoalNode[]): GoalNode[] {
  return nodes.map(n => ({
    ...n,
    critique: n.critique ? { ...n.critique, findings: [...n.critique.findings] } : undefined,
    subGoals: cloneGoalTree(n.subGoals),
  }));
}

export class GoalOrchestrator {
  private provider: LLMProvider;
  private config: GoalConfig;
  private model: string;
  private rootNodes: GoalNode[] = [];
  private currentRound = 0;
  private checkpointPath: string | null = null;

  constructor(
    provider: LLMProvider,
    config?: Partial<GoalConfig>,
  ) {
    this.provider = provider;
    this.config = { ...DEFAULT_GOAL_CONFIG, ...config };
    this.model = this.config.model ?? DEFAULT_GOAL_CONFIG.model!;
  }

  // --------------------------------------------------------------------------
  // Persistence: Checkpoint to disk
  // --------------------------------------------------------------------------

  /**
   * Set the checkpoint path for persistence.
   * State is saved after each round and can be resumed.
   */
  setCheckpointPath(filePath: string): void {
    this.checkpointPath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Save current state to disk (atomic write-tmp-rename).
   */
  private checkpoint(goal: string, ledger: RoundLedger[], plateauRounds: number): void {
    if (!this.checkpointPath) return;

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
      getGlobalLogger().debug('GoalOrchestrator', `Checkpoint saved: round ${this.currentRound}`);
    } catch (err) {
      getGlobalLogger().warn('GoalOrchestrator', `Checkpoint failed: ${(err as Error).message}`);
    }
  }

  /**
   * Resume from a checkpoint file.
   * Returns the saved state or null if no checkpoint exists.
   */
  resumeFromCheckpoint(): {
    goal: string;
    rootNodes: GoalNode[];
    currentRound: number;
    ledger: RoundLedger[];
    plateauRounds: number;
  } | null {
    if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8'));
      if (data.version !== 1) {
        getGlobalLogger().warn('GoalOrchestrator', 'Incompatible checkpoint version, ignoring');
        return null;
      }

      this.rootNodes = data.rootNodes;
      this.currentRound = data.currentRound;

      getGlobalLogger().info('GoalOrchestrator', `Resumed from checkpoint: round ${this.currentRound}`);
      return {
        goal: data.goal,
        rootNodes: data.rootNodes,
        currentRound: data.currentRound,
        ledger: data.ledger,
        plateauRounds: data.plateauRounds,
      };
    } catch (err) {
      getGlobalLogger().warn('GoalOrchestrator', `Failed to resume: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Clear the checkpoint file.
   */
  clearCheckpoint(): void {
    if (this.checkpointPath && fs.existsSync(this.checkpointPath)) {
      try {
        fs.unlinkSync(this.checkpointPath);
      } catch { /* ignore */ }
    }
  }

  /**
   * Get the current goal tree (for status display).
   */
  getGoalTree(): GoalNode[] {
    return this.rootNodes;
  }

  /**
   * Get the current round number.
   */
  getCurrentRound(): number {
    return this.currentRound;
  }

  async execute(goal: string): Promise<GoalResult> {
    this.rootNodes = [];
    this.currentRound = 0;

    const bus = getMessageBus();
    const startTime = Date.now();
    let totalTokensUsed = 0;

    bus.publish('goal.started', 'goal-orch', { goal, mode: this.config.mode });

    const decomposition = await this.managerDecompose(goal);
    if (!decomposition) {
      return {
        goal, status: 'failed', totalRounds: 0, totalTokensUsed, totalDurationMs: Date.now() - startTime,
        ledger: [], finalGoalTree: [], summary: 'Failed to decompose goal.',
      };
    }
    totalTokensUsed += decomposition.tokens;

    let goalTree = this.buildGoalTree(decomposition.data.subGoals, null);
    this.rootNodes = goalTree;

    bus.publish('goal.decomposed', 'goal-orch', {
      subGoalCount: goalTree.length,
      decomposition: decomposition.data,
    });

    const ledger: RoundLedger[] = [];
    let round = 0;
    let prevFindingsSet: Set<string> | null = null;
    let plateauRounds = 0;
    let consecutiveFailedRounds = 0;
    const MAX_CONSECUTIVE_FAILURES = 3; // Stop after 3 rounds with zero progress due to LLM failures

    while (round < this.config.maxRounds) {
      round++;
      this.currentRound = round;
      let roundTokens = 0;
      let roundFailures = 0;

      bus.publish('goal.round_started', 'goal-orch', { round, activeGoals: countActiveGoals(goalTree) });

      const pending = this.getPendingNodes(goalTree);
      for (const node of [...pending]) {
        node.status = 'in_progress';
        node.roundAssigned = node.roundAssigned ?? round;

        const depsBlocked = node.dependencies.some(depId => {
          const dep = findNodeById(goalTree, depId);
          return dep && dep.status !== 'completed';
        });
        if (depsBlocked) continue;

        bus.publish('goal.worker_started', 'goal-orch', { goalId: node.id, goal: node.goal });
        const workerResult = await this.workerExecute(node, goal);
        if (workerResult) {
          node.workerOutput = workerResult.output;
          roundTokens += workerResult.tokens;
          bus.publish('goal.worker_completed', 'goal-orch', { goalId: node.id });
        } else {
          node.status = 'failed';
          roundFailures++;
          continue;
        }

        bus.publish('goal.critic_started', 'goal-orch', { goalId: node.id });
        const criticResult = await this.criticEvaluate(node, goal);
        if (criticResult) {
          node.critique = {
            passed: criticResult.data.passed,
            findings: criticResult.data.findings.map(f => ({
              severity: f.severity,
              category: f.category,
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
            findings: [{ severity: 'medium', category: 'correctness', description: 'Critic evaluation failed', suggestion: 'Manual review needed' }],
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
          const newNode: GoalNode = {
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
      } else {
        consecutiveFailedRounds = 0;
      }

      if (consecutiveFailedRounds >= MAX_CONSECUTIVE_FAILURES) {
        getGlobalLogger().error('GoalOrchestrator', `Stopping after ${consecutiveFailedRounds} consecutive failed rounds (LLM calls failing)`);
        break;
      }

      const allNodes = collectAllNodes(goalTree);
      const currentFindings = allNodes.reduce((sum, n) => sum + (n.critique?.findings.length ?? 0), 0);

      // Build fingerprint set of current finding descriptions for accurate tracking
      const currentFindingsSet = new Set<string>();
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
          if (!currentFindingsSet.has(desc)) resolvedFindings++;
        }
        for (const desc of currentFindingsSet) {
          if (!prevFindingsSet.has(desc)) findingsNew++;
        }
      }

      const improvementRate = prevFindingsSet !== null && prevFindingsSet.size > 0
        ? resolvedFindings / prevFindingsSet.size
        : 1;

      if (improvementRate < 0.02) plateauRounds++;
      else plateauRounds = 0;

      const decision = this.makeDecision(
        round, totalTokensUsed, currentFindings, plateauRounds,
        allNodes,
      );

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

      if (decision.decision.startsWith('stop_')) break;
    }

    const elapsed = Date.now() - startTime;
    const finalAll = collectAllNodes(goalTree);
    const completedCount = finalAll.filter(n => n.status === 'completed').length;
    const resultStatus = completedCount === finalAll.length && finalAll.length > 0
      ? 'completed'
      : completedCount > 0 ? 'partial' : 'failed';

    // Clear checkpoint on successful completion
    if (resultStatus === 'completed') {
      this.clearCheckpoint();
    }

    return {
      goal, status: resultStatus, totalRounds: round, totalTokensUsed, totalDurationMs: elapsed,
      ledger, finalGoalTree: goalTree, summary: this.buildSummary(goal, resultStatus, round, completedCount, finalAll.length, ledger),
    };
  }

  private async managerDecompose(goal: string): Promise<{ data: ManagerDecomposition; tokens: number } | null> {
    const result = await callLLMJSON<ManagerDecomposition>(
      this.provider, this.model,
      MANAGER_DECOMPOSE_PROMPT,
      `Goal: ${goal}`,
    );
    if (result && !validateShape(result.data, { subGoals: 'array', reasoning: 'string' })) {
      getGlobalLogger().warn('GoalOrchestrator', 'managerDecompose: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async managerReview(
    goal: string,
    goalTree: GoalNode[],
    round: number,
  ): Promise<{ data: ManagerReview; tokens: number } | null> {
    const completed = collectAllNodes(goalTree).filter(n => n.status === 'completed' || n.status === 'in_progress');
    if (completed.length === 0) return null;

    const context = completed.map(n => ({
      id: n.id,
      goal: n.goal,
      status: n.status,
      output: n.workerOutput?.slice(0, 1000) ?? '(no output)',
      critique: n.critique ?? { passed: true, findings: [], summary: 'No critique' },
    }));

    const result = await callLLMJSON<ManagerReview>(
      this.provider, this.model,
      MANAGER_REVIEW_PROMPT,
      `Original Goal: ${goal}\nRound: ${round}\n\nCompleted work:\n${JSON.stringify(context, null, 2)}`,
    );
    if (result && !validateShape(result.data, {
      goalAssessments: 'array',
      newSubGoals: 'array',
      overallStatus: 'string',
      overallSummary: 'string',
    })) {
      getGlobalLogger().warn('GoalOrchestrator', 'managerReview: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async workerExecute(
    node: GoalNode,
    parentGoal: string,
  ): Promise<{ output: string; tokens: number } | null> {
    const systemPrompt = `You are a Worker Agent. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`;
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Parent Goal: ${parentGoal}\n\nSub-Goal: ${node.goal}${context ? `\n\nContext from dependencies:\n${context}` : ''}\n\nProvide your output.` },
        ],
        temperature: 0.3,
        maxTokens: 4096,
      });
      const output = response.content;
      node.status = 'completed';
      node.roundCompleted = this.currentRound;
      return { output, tokens: response.usage?.totalTokens ?? 0 };
    } catch (err) {
      getGlobalLogger().error('GoalOrchestrator', 'Worker execution failed', err as Error);
      return null;
    }
  }

  private async criticEvaluate(
    node: GoalNode,
    parentGoal: string,
  ): Promise<{ data: CriticOutput; tokens: number } | null> {
    const context = `Parent Goal: ${parentGoal}\nSub-Goal: ${node.goal}\n\nWorker Output:\n${node.workerOutput?.slice(0, 2000) ?? '(no output)'}`;
    const result = await callLLMJSON<CriticOutput>(
      this.provider, this.model,
      CRITIC_PROMPT,
      context,
    );
    if (result && !validateShape(result.data, { passed: 'boolean', findings: 'array', summary: 'string' })) {
      getGlobalLogger().warn('GoalOrchestrator', 'criticEvaluate: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private makeDecision(
    round: number,
    totalTokensUsed: number,
    findingsCount: number,
    plateauRounds: number,
    allNodes: GoalNode[],
  ): { decision: RoundDecision; reason: string } {
    if (totalTokensUsed >= this.config.budgetTokens) {
      return { decision: 'stop_budget', reason: `Token budget (${this.config.budgetTokens}) exhausted.` };
    }

    if (round >= this.config.maxRounds) {
      return { decision: 'stop_max_rounds', reason: `Max rounds (${this.config.maxRounds}) reached.` };
    }

    const activeCount = allNodes.filter(n =>
      n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened'
    ).length;

    if (activeCount === 0 && findingsCount === 0) {
      return { decision: 'stop_achieved', reason: 'All sub-goals completed with zero findings.' };
    }

    const plateauThreshold = this.config.mode === 'thorough' ? 5
      : this.config.mode === 'balanced' ? 3
      : 2;

    if (plateauRounds >= plateauThreshold && findingsCount <= 2) {
      const hasCritical = allNodes.some(n =>
        n.critique?.findings.some(f => f.severity === 'critical' || f.severity === 'high')
      );
      if (!hasCritical) {
        return { decision: 'stop_plateau', reason: `Improvement plateaued after ${plateauRounds} rounds.` };
      }
    }

    return { decision: 'continue', reason: `Active goals: ${activeCount}, findings: ${findingsCount}` };
  }

  private buildGoalTree(subGoals: ManagerDecomposition['subGoals'], parentId: string | null): GoalNode[] {
    const nodeMap = new Map<string, GoalNode>();
    const nodes: GoalNode[] = [];

    for (let i = 0; i < subGoals.length; i++) {
      const sg = subGoals[i];
      const id = generateNodeId();
      const node: GoalNode = {
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
          .map(depIdx => nodeMap.get(`idx:${depIdx}`)?.id)
          .filter((id): id is string => !!id);
      }
    }

    return nodes;
  }

  private getPendingNodes(nodes: GoalNode[]): GoalNode[] {
    const result: GoalNode[] = [];
    for (const n of nodes) {
      if (n.status === 'pending' || n.status === 're_opened') result.push(n);
      result.push(...this.getPendingNodes(n.subGoals));
    }
    return result;
  }

  private applyReview(goalTree: GoalNode[], review: ManagerReview): GoalNode[] {
    for (const assessment of review.goalAssessments) {
      const node = findNodeById(goalTree, assessment.goalId);
      if (!node) continue;
      if (assessment.status === 'completed' && node.status !== 'failed') {
        node.status = 'completed';
      } else if (assessment.status === 'needs_rework' || assessment.status === 're_open') {
        node.status = 're_opened';
      }
    }
    return goalTree;
  }

  private buildSummary(
    goal: string,
    status: GoalResult['status'],
    rounds: number,
    completed: number,
    total: number,
    ledger: RoundLedger[],
  ): string {
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
