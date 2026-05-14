import type { TaskTreeNode, ExecutionError } from './types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { getTeamManager } from './agentTeamManager';
import { getMessageBus } from '../runtime/messageBus';

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
  }

  private async executeSubtasks(
    node: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
    errors: ExecutionError[],
  ): Promise<void> {
    const dependencyMap = this.buildDependencyMap(node.subtasks);
    const orderedLevels = this.topologicalLevels(dependencyMap, node.subtasks);

    for (const level of orderedLevels) {
      const batches = this.chunkArray(level, this.maxParallel);
      for (const batch of batches) {
        const promises = batch.map(sub => 
          this.executeNode(sub, projectId, baseContext, errors)
        );
        const results = await Promise.allSettled(promises);
        
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') {
            const subNode = batch[i];
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
        const inboxMessages = teamManager.readMessages(this.currentTeamId, node.id, 20, false);
        if (inboxMessages.length > 0) {
          inboxContext = '\n\n=== Messages from team members ===\n' +
            inboxMessages.map(m =>
              `[${m.from}] ${m.subject}: ${m.body.slice(0, 500)}`
            ).join('\n---\n');
        }
      }

      const enrichedGoal = inboxContext
        ? `${node.goal}\n\n${inboxContext}`
        : node.goal;

      const ctx: AgentExecutionContext = {
        agentId: node.id,
        projectId,
        goal: enrichedGoal,
        contextData: baseContext as AgentExecutionContext['contextData'],
        availableTools: node.context.availableTools,
        maxSteps: 10,
        tokenBudget: Math.max(2000, Math.min(50000, node.context.estimatedTokens)),
      };

      let execResult: AgentExecutionResult;
      try {
        execResult = await this.runtime.execute(ctx);
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
        node.result = execResult.summary;
      }

      await this.artifactSystem.write(
        node.id,
        'RESEARCH_FINDING',
        `Result: ${node.goal.slice(0, 60)}`,
        execResult.summary.slice(0, 200),
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
    const completed = node.subtasks.filter(s => s.status === 'COMPLETED');
    const failed = node.subtasks.filter(s => s.status === 'FAILED');

    const summaries = completed
      .map(s => `[${s.id}] ${s.goal.slice(0, 100)}: ${(s.result ?? '').slice(0, 200)}`)
      .join('\n\n');

    const synthesisGoal = [
      `Synthesize the following ${completed.length} completed subtask results into a cohesive output.`,
      failed.length > 0 ? `Note: ${failed.length} subtasks failed.` : '',
      '',
      'Subtask results:',
      summaries,
    ].filter(Boolean).join('\n');

    const ctx: AgentExecutionContext = {
      agentId: `synthesizer-${node.id}`,
      projectId,
      goal: synthesisGoal,
      contextData: baseContext as AgentExecutionContext['contextData'],
      availableTools: node.context.availableTools,
      maxSteps: 5,
      tokenBudget: Math.round(node.context.estimatedTokens * 0.3),
    };

    try {
      const result = await this.runtime.execute(ctx);
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
