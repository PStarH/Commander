import * as fs from 'fs';
import * as path from 'path';
import type { TaskTreeNode, ExecutionError, HumanApprovalGate, UltimateOrchestratorConfig, EffortLevel } from './types';
import type { AgentRuntimeInterface } from '../runtime';
import type { AgentExecutionContext, AgentExecutionResult, ModelTier } from '../runtime/types';
import type { StateCheckpointer } from '../runtime/stateCheckpointer';
import { getHumanApprovalManager } from './humanApprovalManager';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { getTeamManager } from './agentTeamManager';
import { getMessageBus } from '../runtime/messageBus';
import { agentContext } from '../runtime/agentContext';
import { getGlobalLogger } from '../logging';
import { getDeadLetterQueue } from '../runtime/deadLetterQueueSingleton';
import { getExecutionScheduler } from '../atr/scheduler';
import type { RunHandle } from '../atr/scheduler';
import { getWorkCoordinator } from './workCoordinator';
import { MIN_TOKENS_PER_AGENT, MAX_TOKENS_PER_AGENT, ESTIMATED_DURATION_DEFAULT } from '../config/constants';
import { getIntentLog } from '../runtime/intentLog';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { SubAgentGuard, SubAgentLimitError } from './subAgentGuard';
import { getEffortRules } from './effortScaler';
import { DEFAULT_ULTIMATE_CONFIG } from './types';

/** Critical path token budget multiplier (LAMaS: give critical tasks more resources) */
const CRITICAL_PATH_TOKEN_MULTIPLIER = 1.5;

/** Slack threshold in ms — nodes with less slack than this are considered critical */
const CRITICAL_PATH_SLACK_THRESHOLD_MS = 100;

/** Default estimated duration for nodes without explicit estimates */
const DEFAULT_NODE_DURATION_MS = ESTIMATED_DURATION_DEFAULT;

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
const FRESH_CONTEXT_FIELDS = ['governanceProfile', 'warRoomSnapshot'] as const;

export class SubAgentExecutor {
  private runtime: AgentRuntimeInterface;
  private artifactSystem: ArtifactSystem;
  private maxParallel: number;
  private config: UltimateOrchestratorConfig;
  private currentEffortLevel: EffortLevel;
  private currentTeamId: string | null = null;
  private currentRunId: string | null = null;
  private currentRunHandle: RunHandle | null = null;
  private checkpointer: StateCheckpointer | null = null;
  private approvalGate: HumanApprovalGate | null = null;
  private skippedApprovals: Array<{ nodeId: string; reason: string }> = [];

  constructor(
    runtime: AgentRuntimeInterface,
    artifactSystem?: ArtifactSystem,
    maxParallel = 10,
    config?: UltimateOrchestratorConfig,
  ) {
    this.runtime = runtime;
    this.artifactSystem = artifactSystem ?? getArtifactSystem();
    this.maxParallel = maxParallel;
    this.config = config ?? DEFAULT_ULTIMATE_CONFIG;
    this.currentEffortLevel = this.config.defaultEffortLevel;
  }

  /**
   * Set the effort level for the current execution. Determines lead/specialist
   * model tier mapping for sub-agents.
   */
  setEffortLevel(level: EffortLevel): void {
    this.currentEffortLevel = level;
  }

  private getModelTiers(): { lead: ModelTier; specialist: ModelTier } {
    const rules = getEffortRules(this.currentEffortLevel);
    return {
      lead: rules.leadModelTier,
      specialist: rules.specialistModelTier,
    };
  }

  setTeam(teamId: string | null): void {
    this.currentTeamId = teamId;
  }

  setRunId(runId: string | null): void {
    this.currentRunId = runId;
  }

  setRunHandle(handle: RunHandle | null): void {
    this.currentRunHandle = handle;
  }

  setCheckpointer(cp: StateCheckpointer | null): void {
    this.checkpointer = cp;
  }

  setApprovalGate(gate: HumanApprovalGate | null): void {
    this.approvalGate = gate;
  }

  getSkippedApprovals(): Array<{ nodeId: string; reason: string }> {
    return this.skippedApprovals;
  }

  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  private writeCheckpoint(node: TaskTreeNode): void {
    if (!this.checkpointer) return;
    if (!this.currentRunId) return;
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
        availableTools: node.context.availableTools ?? [],
        maxSteps: 0,
        tokenBudget: 0,
      },
      totalDurationMs: 0,
    });
  }

  async executeNode(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    if (node.status === 'COMPLETED' || node.status === 'FAILED' || node.status === 'SKIPPED' || node.status === 'PARTIAL') return;

    // Check approval gate before executing
    if (this.approvalGate?.enabled) {
      const manager = getHumanApprovalManager();
      const request = manager.request({
        runId: this.currentRunId ?? 'unknown',
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
          ? `Timed out: ${resolution.note ?? 'no response'}`
          : (resolution.note ?? 'approval not granted');
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

  private async executeSubtasks(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    const dependencyMap = this.buildDependencyMap(node.subtasks);
    this.computeCriticalPath(node.subtasks, dependencyMap);
    const orderedLevels = this.topologicalLevels(dependencyMap, node.subtasks);

    for (const level of orderedLevels) {
      // LAMaS: sort critical path tasks first within each level
      const sorted = [...level].sort((a, b) => {
        if (a.isOnCriticalPath && !b.isOnCriticalPath) return -1;
        if (!a.isOnCriticalPath && b.isOnCriticalPath) return 1;
        return (b.estimatedDurationMs ?? 0) - (a.estimatedDurationMs ?? 0);
      });

      const batches = this.chunkArray(sorted, this.maxParallel);
      for (const batch of batches) {
        // LAMaS: allocate more tokens to critical path tasks
        const adjustedBatch = batch.map(sub => {
          if (sub.isOnCriticalPath) {
            sub.context.estimatedTokens = Math.round((sub.context.estimatedTokens ?? MIN_TOKENS_PER_AGENT) * CRITICAL_PATH_TOKEN_MULTIPLIER);
          }
          return sub;
        });

        const promises = adjustedBatch.map(sub => 
          this.executeNode(sub, projectId, baseContext, errors)
        );
        const results = await Promise.allSettled(promises);
        
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') {
            const subNode = adjustedBatch[i];
            subNode.status = 'FAILED';
            errors.push({
              nodeId: subNode.id,
              agentId: projectId,
              message: result.reason?.toString() ?? 'Unknown error',
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
  private computeCriticalPath(
    nodes: TaskTreeNode[],
    dependencyMap: Map<string, string[]>,
  ): void {
    if (nodes.length === 0) return;

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const est = new Map<string, number>();
    const eft = new Map<string, number>();
    const lft = new Map<string, number>();
    const lst = new Map<string, number>();

    // Forward pass: compute Earliest Start Time (EST) and Earliest Finish Time (EFT)
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }

    for (const [nodeId, deps] of dependencyMap) {
      for (const dep of deps) {
        adjList.get(dep)?.push(nodeId);
        inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(nodeId);
        est.set(nodeId, 0);
        const dur = nodeMap.get(nodeId)?.estimatedDurationMs ?? DEFAULT_NODE_DURATION_MS;
        eft.set(nodeId, dur);
      }
    }

    let qIdx = 0;
    while (qIdx < queue.length) {
      const current = queue[qIdx++];
      const currentEft = eft.get(current) ?? 0;

      for (const successor of (adjList.get(current) ?? [])) {
        const newEst = currentEft;
        const currentEst = est.get(successor) ?? 0;
        if (newEst > currentEst) {
          est.set(successor, newEst);
          const dur = nodeMap.get(successor)?.estimatedDurationMs ?? DEFAULT_NODE_DURATION_MS;
          eft.set(successor, newEst + dur);
        }
        inDegree.set(successor, (inDegree.get(successor) ?? 1) - 1);
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

    const outDegree = new Map<string, number>();
    for (const node of nodes) {
      outDegree.set(node.id, 0);
    }
    for (const [nodeId, deps] of dependencyMap) {
      for (const _dep of deps) {
        outDegree.set(_dep, (outDegree.get(_dep) ?? 0) + 1);
      }
    }

    const reverseQueue: string[] = [];
    for (const [nodeId, degree] of outDegree) {
      if (degree === 0) {
        reverseQueue.push(nodeId);
      }
    }

    let rqIdx = 0;
    while (rqIdx < reverseQueue.length) {
      const current = reverseQueue[rqIdx++];
      const currentLst = (lft.get(current) ?? projectFinish) - (nodeMap.get(current)?.estimatedDurationMs ?? DEFAULT_NODE_DURATION_MS);
      lst.set(current, currentLst);

      for (const dep of (dependencyMap.get(current) ?? [])) {
        const newLft = currentLst;
        const currentLft = lft.get(dep) ?? projectFinish;
        if (newLft < currentLft) {
          lft.set(dep, newLft);
        }
        outDegree.set(dep, (outDegree.get(dep) ?? 1) - 1);
        if (outDegree.get(dep) === 0) {
          reverseQueue.push(dep);
        }
      }
    }

    // Mark critical path: EST === LST (zero slack)
    for (const node of nodes) {
      const nodeEst = est.get(node.id) ?? 0;
      const nodeLst = lst.get(node.id) ?? 0;
      const slack = Math.abs(nodeLst - nodeEst);
      node.isOnCriticalPath = slack < CRITICAL_PATH_SLACK_THRESHOLD_MS;
    }
  }

  private async executeAtomicNode(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    if (this.currentRunId) {
      const workCoord = getWorkCoordinator();
      const existing = workCoord
        .list({ runId: this.currentRunId })
        .find(i => i.parentNodeId === node.id);
      if (!existing) {
        workCoord.enqueue({
          runId: this.currentRunId,
          parentNodeId: node.id,
          goal: node.goal,
          tools: node.context.availableTools ?? [],
          tokenBudget: node.context.estimatedTokens ?? MIN_TOKENS_PER_AGENT,
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
      await this.artifactSystem.write(
        node.id,
        'SUMMARY',
        node.goal.slice(0, 80),
        'Executing atomic task...',
        node.goal,
        ['atomic', (node.role ?? 'sub-agent').toLowerCase()],
      );

      const startTime = Date.now();

      // Read inbox messages from dependency agents (team collaboration)
      let inboxContext = '';
      if (this.currentTeamId && node.dependencies.length > 0) {
        const teamManager = getTeamManager();
        const inboxMessages = teamManager.readMessages(this.currentTeamId, node.id, MAX_INBOX_MESSAGES, false);
        if (inboxMessages.length > 0) {
          inboxContext = '\n\n=== Messages from team members ===\n' +
            inboxMessages.map(m =>
              `[${m.from}] ${m.subject}: ${m.body.slice(0, MAX_INBOX_MESSAGE_CHARS)}`
            ).join('\n---\n');
        }
      }

      const enrichedGoal = inboxContext
        ? `${node.goal}\n\n${inboxContext}`
        : node.goal;

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
      const fullTools = (baseContext?.availableTools as string[] | undefined) ?? node.context.availableTools ?? [];
      const tools = this.filterToolsForRole(fullTools, node.role);

      // Per-agent output directory for file write isolation
      const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputDir = path.join(process.cwd(), '.commander_output', safeId);
      try {
        fs.mkdirSync(outputDir, { recursive: true });
      } catch (e) {
        const errorMsg = `Failed to create output directory: ${e instanceof Error ? e.message : String(e)}`;
        node.status = 'FAILED';
        node.durationMs = Date.now() - startTime;
        errors.push({ nodeId: node.id, agentId: node.id, message: errorMsg, recovered: false });
        return;
      }

      const narrowContext = this.buildNarrowContext(baseContext);
      const { specialist } = this.getModelTiers();
      const ctx: AgentExecutionContext = {
        agentId: node.id,
        projectId,
        goal: taskBrief,
        contextData: narrowContext as AgentExecutionContext['contextData'],
        availableTools: tools,
        outputDir,
        maxSteps: 10,
        tokenBudget: Math.max(MIN_TOKENS_PER_AGENT, Math.min(MAX_TOKENS_PER_AGENT, node.context.estimatedTokens)),
        parentRunId: this.currentRunId ?? undefined,
        subAgentRole: node.role ?? 'sub-agent',
        subAgentDepth: (baseContext as { __depth?: number }).__depth ?? 1,
        preferredModelTier: node.preferredModelTier ?? specialist,
      };
      try { getIntentLog(ctx.tenantId).write({ schemaVersion: 1, runId: this.currentRunId ?? ctx.runId ?? node.id, capturedAt: new Date().toISOString(), stage: 'subAgentExecutor.spawn', decision: 'spawn', reason: 'sub-agent execution started', payload: { agentId: node.id, parentRunId: this.currentRunId, subAgentRole: node.role, depth: (baseContext as { __depth?: number }).__depth ?? 1 } }); } catch { /* best-effort */ }

      let execResult: AgentExecutionResult;
      // Create per-node sub-agent guard to enforce limits (steps, tokens, wall clock)
      const guard = new SubAgentGuard({
        maxSteps: 10,
        maxTokens: Math.max(MIN_TOKENS_PER_AGENT, Math.min(MAX_TOKENS_PER_AGENT, node.context.estimatedTokens)),
        maxWallClockMs: 5 * 60 * 1000,
      });
      // Pass guard into execution context so agentRuntime enforces limits per-step
      ctx.guard = guard;

      try {
        execResult = await agentContext.run(
          { agentId: node.id, outputDir },
          () => this.runtime.execute(ctx),
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof SubAgentLimitError) {
          node.status = 'FAILED';
          node.result = `Sub-agent limit exceeded (${err.reason}): ${err.observed} >= ${err.limit}`;
          node.durationMs = Date.now() - startTime;
          try { getIntentLog(ctx.tenantId).write({ schemaVersion: 1, runId: this.currentRunId ?? ctx.runId ?? node.id, capturedAt: new Date().toISOString(), stage: 'subAgentExecutor.complete', decision: 'failed', reason: `limit_exceeded: ${err.reason}`, payload: { agentId: node.id, status: 'failed', parentRunId: this.currentRunId, limitReason: err.reason, observed: err.observed, limit: err.limit } }); } catch { /* best-effort */ }
          try { getMetricsCollector().recordSubAgentOutcome(node.id, 'failed', (baseContext as { __depth?: number }).__depth ?? 1, ctx.tenantId); } catch { /* best-effort */ }
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
        try { getIntentLog(ctx.tenantId).write({ schemaVersion: 1, runId: this.currentRunId ?? ctx.runId ?? node.id, capturedAt: new Date().toISOString(), stage: 'subAgentExecutor.complete', decision: 'failed', reason: errorMsg.slice(0, 200), payload: { agentId: node.id, status: 'failed', parentRunId: this.currentRunId } }); } catch { /* best-effort */ }
        try { getMetricsCollector().recordSubAgentOutcome(node.id, 'failed', (baseContext as { __depth?: number }).__depth ?? 1, ctx.tenantId); } catch { /* best-effort */ }
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
        const { getTokenBudgetManager } = await import('../runtime/tokenBudgetManager');
        const bm = getTokenBudgetManager();
        bm.recordUsage(this.currentRunId ?? node.id, node.id, execResult.totalTokenUsage.totalTokens);
        bm.markSubAgentComplete(this.currentRunId ?? node.id, node.id, execResult.totalTokenUsage.totalTokens);
      } catch { /* best-effort */ }

      if (execResult.status !== 'success') {
        const errorMsg = execResult.error || `Execution returned status: ${execResult.status}`;
        node.result = errorMsg;
        errors.push({
          nodeId: node.id,
          agentId: node.id,
          message: errorMsg,
          recovered: false,
        });
      } else {
        // Anthropic fresh-context: return only the condensed summary, not raw tool outputs.
        // This prevents context pollution — the parent sees distilled findings, not the
        // sub-agent's full conversation history.
        node.result = execResult.summary;
        try { getIntentLog(ctx.tenantId).write({ schemaVersion: 1, runId: this.currentRunId ?? ctx.runId ?? node.id, capturedAt: new Date().toISOString(), stage: 'subAgentExecutor.complete', decision: 'success', reason: 'sub-agent execution succeeded', payload: { agentId: node.id, status: 'success', parentRunId: this.currentRunId, durationMs: node.durationMs, tokenUsage: node.tokenUsage } }); } catch { /* best-effort */ }
        try { getMetricsCollector().recordSubAgentOutcome(node.id, 'success', (baseContext as { __depth?: number }).__depth ?? 1, ctx.tenantId); } catch { /* best-effort */ }
      }

      await this.artifactSystem.write(
        node.id,
        'RESEARCH_FINDING',
        `Result: ${node.goal.slice(0, 60)}`,
        execResult.summary.slice(0, 500),
        execResult.summary,
        ['completed', (node.role ?? 'sub-agent').toLowerCase(), ...(execResult.status === 'success' ? ['success'] : ['partial'])],
      );

      node.status = execResult.status === 'success' ? 'COMPLETED' : 'FAILED';

      // Notify dependent agents via team inbox
      if (this.currentTeamId) {
        const teamManager = getTeamManager();
        teamManager.sendMessage(
          this.currentTeamId,
          node.id,
          'ALL',
          `Completed: ${node.goal.slice(0, 100)}`,
          `Status: ${node.status}\nSummary: ${(node.result ?? '').slice(0, 500)}`,
          node.status === 'COMPLETED' ? 'NORMAL' : 'HIGH',
        );
        getMessageBus().publish('agent.message', node.id, {
          type: 'team_inbox',
          teamId: this.currentTeamId,
          from: node.id,
          subject: `Task ${node.status}`,
        });
      }
    } catch (err) {
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
          getDeadLetterQueue().record({
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
      } catch (compErr) {
        getGlobalLogger().warn('subAgentExecutor', 'compensateAll failed', { nodeId: node.id, error: (compErr as Error)?.message });
      }
      // Phase 3: notify the centralized ExecutionScheduler that this sub-agent run failed
      try {
        getExecutionScheduler().abortRun({
          runId: `subagent:${node.id}`,
          leaseToken: 'n/a',
          fencingEpoch: 0,
          reason: errorMsg,
        });
      } catch (schedErr) {
        getGlobalLogger().debug('subAgentExecutor', 'scheduler abortRun no-op for sub-agent', { nodeId: node.id, error: (schedErr as Error).message });
      }
    }

    if (this.currentRunId) {
      const workCoord = getWorkCoordinator();
      const myItem = workCoord
        .list({ runId: this.currentRunId })
        .find(i => i.parentNodeId === node.id);
      if (myItem) {
        if (node.status === 'COMPLETED') {
          workCoord.complete(myItem.id, node.id);
        } else {
          const lastError = errors[errors.length - 1]?.message ?? 'sub-agent execution failed';
          const reassignResult = workCoord.fail(myItem.id, node.id, lastError);
          if (reassignResult === null && this.currentRunHandle) {
            try {
              await getExecutionScheduler().abortRun({
                runId: this.currentRunHandle.runId,
                leaseToken: this.currentRunHandle.leaseToken,
                fencingEpoch: this.currentRunHandle.fencingEpoch,
                reason: `terminal work failure: ${lastError.slice(0, 200)}`,
              });
            } catch (abortErr) {
              getGlobalLogger().debug('subAgentExecutor', 'ATR abortRun on terminal failure no-op', { nodeId: node.id, error: (abortErr as Error).message });
            }
            try {
              const compResult = await this.runtime.getCompensationRegistry().compensateAll();
              getGlobalLogger().info('subAgentExecutor', 'compensateAll on terminal failure', {
                nodeId: node.id,
                succeeded: compResult.succeeded,
                failed: compResult.failed,
              });
            } catch (compErr) {
              getGlobalLogger().debug('subAgentExecutor', 'compensateAll failed', { nodeId: node.id, error: (compErr as Error).message });
            }
          }
        }
      }
    }
  }

  private async synthesizeSubtasks(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    // Merge per-agent output directories into the workspace before synthesis
    this.mergeAgentOutputs(node);

    const completed = node.subtasks.filter(s => s.status === 'COMPLETED');
    const failed = node.subtasks.filter(s => s.status === 'FAILED');

    // Preserve the FULL concatenated results before synthesis agent runs.
    // This ensures the orchestrator's leadSynthesis always has access to complete data.
    const fullResults = completed
      .map(s => `### ${s.goal.slice(0, 120)}\n\n${s.result ?? ''}`)
      .join('\n\n---\n\n');
    node.fullSubtaskResults = fullResults;

    // Pass full results to synthesis agent (no truncation)
    const summaries = completed
      .map(s => `[${s.id}] ${s.goal.slice(0, 100)}: ${s.result ?? ''}`)
      .join('\n\n');

    const synthesisGoal = [
      `Synthesize the following ${completed.length} completed subtask results into a cohesive output.`,
      failed.length > 0 ? `Note: ${failed.length} subtasks failed.` : '',
      '',
      'Subtask results:',
      summaries,
    ].filter(Boolean).join('\n');

    const fullTools = (baseContext?.availableTools as string[] | undefined);
    const tools = fullTools?.length ? fullTools : node.context.availableTools;

    const narrowContext = this.buildNarrowContext(baseContext);
    const { lead } = this.getModelTiers();
    const ctx: AgentExecutionContext = {
      agentId: `synthesizer-${node.id}`,
      projectId,
      goal: synthesisGoal,
      contextData: narrowContext as AgentExecutionContext['contextData'],
      availableTools: tools,
      maxSteps: 8,
      tokenBudget: Math.max(MIN_TOKENS_PER_AGENT, Math.round(node.context.estimatedTokens * 0.5)),
      parentRunId: this.currentRunId ?? undefined,
      subAgentRole: 'synthesizer',
      subAgentDepth: ((baseContext as { __depth?: number }).__depth ?? 1) + 1,
      preferredModelTier: node.preferredModelTier ?? lead,
    };
    try { getIntentLog(ctx.tenantId).write({ schemaVersion: 1, runId: this.currentRunId ?? ctx.runId ?? node.id, capturedAt: new Date().toISOString(), stage: 'subAgentExecutor.synthesize', decision: 'spawn', reason: 'synthesizer sub-agent spawned', payload: { agentId: ctx.agentId, parentRunId: this.currentRunId, subAgentRole: 'synthesizer' } }); } catch { /* best-effort */ }

    try {
      const result = await agentContext.run(
        { agentId: `synthesizer-${node.id}` },
        () => this.runtime.execute(ctx),
      );
      // Preserve original results: use synthesis as summary, keep full results accessible
      node.result = result.summary;
      node.status = result.status === 'success' ? 'COMPLETED' : 'PARTIAL';

      await this.artifactSystem.write(
        node.id,
        'SUMMARY',
        `Synthesis: ${node.goal.slice(0, 60)}`,
        result.summary.slice(0, 200),
        result.summary,
        ['synthesis', 'aggregated'],
      );
    } catch (err) {
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
  private mergeAgentOutputs(node: TaskTreeNode): void {
    const safeRoot = process.env.COMMANDER_WORKSPACE || process.cwd();
    for (const sub of node.subtasks) {
      const safeId = sub.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputDir = path.join(safeRoot, '.commander_output', safeId);
      if (!fs.existsSync(outputDir)) continue;
      try {
        this.copyDirRecursive(outputDir, safeRoot);
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (e) {
        getGlobalLogger().warn('SubAgentExecutor', 'Failed to merge agent output', {
          nodeId: sub.id, error: (e as Error)?.message,
        });
      }
    }
    // Clean up the .commander_output directory if empty
    const commanderOutputDir = path.join(safeRoot, '.commander_output');
    try {
      if (fs.existsSync(commanderOutputDir)) {
        const remaining = fs.readdirSync(commanderOutputDir);
        if (remaining.length === 0) fs.rmSync(commanderOutputDir, { recursive: true });
      }
    } catch { /* ignore */ }
  }

  private copyDirRecursive(src: string, dest: string, safeRoot?: string): void {
    const root = safeRoot ?? dest;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      // Prevent directory traversal: resolved dest must stay within root
      const resolved = path.resolve(destPath);
      if (!resolved.startsWith(path.resolve(root))) {
        getGlobalLogger().warn('SubAgentExecutor', 'Blocked directory traversal', { destPath: resolved });
        continue;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirRecursive(srcPath, destPath, root);
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Merge remaining per-agent output files into the workspace, then clean up.
   */
  private cleanupOutputDir(node: TaskTreeNode): void {
    const safeRoot = process.env.COMMANDER_WORKSPACE || process.cwd();
    const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const nodeOutputDir = path.join(safeRoot, '.commander_output', safeId);
    try {
      if (!fs.existsSync(nodeOutputDir)) return;
      this.copyDirRecursive(nodeOutputDir, safeRoot);
      fs.rmSync(nodeOutputDir, { recursive: true, force: true });
    } catch (e) {
      getGlobalLogger().warn('SubAgentExecutor', 'Failed to cleanup output dir', { nodeId: node.id, error: (e as Error)?.message });
    }
  }

  private buildDependencyMap(
    subtasks: TaskTreeNode[],
  ): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const sub of subtasks) {
      map.set(sub.id, sub.dependencies);
    }
    return map;
  }

  private topologicalLevels(
    dependencyMap: Map<string, string[]>,
    allNodes: TaskTreeNode[],
  ): TaskTreeNode[][] {
    const levels: TaskTreeNode[][] = [];
    const nodeMap = new Map(allNodes.map(n => [n.id, n]));
    const remaining = new Set(allNodes.map(n => n.id));
    const completed = new Set<string>();

    while (remaining.size > 0) {
      const currentLevel: TaskTreeNode[] = [];
      for (const nodeId of remaining) {
        const deps = dependencyMap.get(nodeId) ?? [];
        const allDepsMet = deps.every(d => completed.has(d));
        if (allDepsMet) {
          const node = nodeMap.get(nodeId);
          if (node) currentLevel.push(node);
        }
      }

      if (currentLevel.length === 0) {
        const remainingList = Array.from(remaining);
        for (const id of remainingList) {
          const node = nodeMap.get(id);
          if (node) currentLevel.push(node);
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
  private buildNarrowContext(baseContext: Record<string, unknown>): Record<string, unknown> {
    const narrow: Record<string, unknown> = {};
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
  private filterToolsForRole(allTools: string[], role?: string): string[] {
    const roleLower = (role ?? '').toLowerCase();

    const roleToolHints: Record<string, string[]> = {
      researcher: ['webSearch', 'web_search', 'web_fetch', 'file_read', 'read_file', 'grep', 'file_search'],
      coder: ['file_read', 'read_file', 'file_write', 'write_file', 'file_edit', 'edit_file', 'bash', 'grep'],
      reviewer: ['file_read', 'read_file', 'grep', 'file_search', 'diff'],
      synthesizer: ['file_read', 'read_file', 'file_write', 'write_file'],
      planner: ['file_read', 'read_file', 'grep', 'file_search'],
    };

    const hints = roleToolHints[roleLower];
    if (!hints) return allTools;

    const filtered = hints.filter(t => allTools.includes(t));
    return filtered.length > 0 ? filtered : allTools;
  }

  /**
   * Get role-specific prompt template for sub-agents.
   * Research (Anthropic 2025): differentiated role prompts improve agent
   * performance by 10-20% vs generic prompts through better role alignment.
   */
  private getRolePrompt(role?: string): string {
    const roleLower = (role ?? '').toLowerCase();
    const prompts: Record<string, string> = {
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
        'Check that changes follow existing conventions and don\'t break downstream consumers.',
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
    return prompts[roleLower] ?? [
      'You are a Specialist Agent. Complete your assigned task accurately and efficiently.',
      'Focus on the specific sub-task. Do not expand scope beyond what was assigned.',
      'Report outcomes faithfully. If something fails, say so with details.',
    ].join(' ');
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
