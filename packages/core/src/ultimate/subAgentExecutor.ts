import * as fs from 'fs';
import * as path from 'path';
import type { TaskTreeNode, ExecutionError } from './types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { getTeamManager } from './agentTeamManager';
import { getMessageBus } from '../runtime/messageBus';
import { agentContext } from '../runtime/agentContext';
import { getGlobalLogger } from '../logging';
import { MIN_TOKENS_PER_AGENT, MAX_TOKENS_PER_AGENT, ESTIMATED_DURATION_DEFAULT } from '../config/constants';

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

export class SubAgentExecutor {
  private runtime: AgentRuntime;
  private artifactSystem: ArtifactSystem;
  private maxParallel: number;
  private currentTeamId: string | null = null;

  constructor(
    runtime: AgentRuntime,
    artifactSystem?: ArtifactSystem,
    maxParallel = 10,
  ) {
    this.runtime = runtime;
    this.artifactSystem = artifactSystem ?? getArtifactSystem();
    this.maxParallel = maxParallel;
  }

  setTeam(teamId: string | null): void {
    this.currentTeamId = teamId;
  }

  async executeNode(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    if (node.status === 'COMPLETED' || node.status === 'FAILED') return;

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

    // Clean up per-agent output directory after all execution is done
    this.cleanupOutputDir(node);
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
    try {
      await this.artifactSystem.write(
        node.id,
        'SUMMARY',
        node.goal.slice(0, 80),
        'Executing atomic task...',
        node.goal,
        ['atomic', node.role.toLowerCase()],
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

      // Prefer the full tool list from baseContext (set by orchestrator/CLI)
      // over the narrowed list the atomizer may have assigned to this node.
      const fullTools = (baseContext?.availableTools as string[] | undefined);
      const tools = fullTools?.length ? fullTools : node.context.availableTools;

      // Per-agent output directory for file write isolation
      const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputDir = path.join(process.cwd(), '.commander_output', safeId);
      fs.mkdirSync(outputDir, { recursive: true });

      const ctx: AgentExecutionContext = {
        agentId: node.id,
        projectId,
        goal: enrichedGoal,
        contextData: baseContext as AgentExecutionContext['contextData'],
        availableTools: tools,
        outputDir,
        maxSteps: 10,
        tokenBudget: Math.max(MIN_TOKENS_PER_AGENT, Math.min(MAX_TOKENS_PER_AGENT, node.context.estimatedTokens)),
      };

      let execResult: AgentExecutionResult;
      try {
        execResult = await agentContext.run(
          { agentId: node.id, outputDir },
          () => this.runtime.execute(ctx),
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({
          nodeId: node.id,
          agentId: node.id,
          message: errorMsg,
          recovered: false,
        });
        node.status = 'FAILED';
        node.durationMs = Date.now() - startTime;
        return;
      }

      node.durationMs = Date.now() - startTime;
      node.tokenUsage = execResult.totalTokenUsage;

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
        // Prefer actual file content over chat summary
        node.result = execResult.artifactContent || execResult.summary;

        // Collect tool outputs (file_read content, etc.) for richer synthesis
        const toolOutputs: string[] = [];
        for (const step of execResult.steps) {
          if (step.type === 'tool_result' && step.toolResult?.output && !step.toolResult.error) {
            const output = step.toolResult.output;
            // Only include substantial tool outputs (file reads, etc.)
            if (output.length > 100) {
              toolOutputs.push(`[${step.toolResult.name}] ${output}`);
            }
          }
        }
        if (toolOutputs.length > 0) {
          const toolContent = toolOutputs.join('\n\n---\n\n');
          // If tool outputs are richer than the summary, use them
          if (toolContent.length > (node.result?.length ?? 0)) {
            node.result = toolContent;
          }
        }
      }

      await this.artifactSystem.write(
        node.id,
        'RESEARCH_FINDING',
        `Result: ${node.goal.slice(0, 60)}`,
        execResult.summary.slice(0, 500),
        execResult.summary,
        ['completed', node.role.toLowerCase(), ...(execResult.status === 'success' ? ['success'] : ['partial'])],
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

    const ctx: AgentExecutionContext = {
      agentId: `synthesizer-${node.id}`,
      projectId,
      goal: synthesisGoal,
      contextData: baseContext as AgentExecutionContext['contextData'],
      availableTools: tools,
      maxSteps: 8,
      tokenBudget: Math.max(MIN_TOKENS_PER_AGENT, Math.round(node.context.estimatedTokens * 0.5)),
    };

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

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
