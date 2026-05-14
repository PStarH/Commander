/**
 * Recursive Atomizer - ROMA-inspired task decomposition.
 *
 * ROMA (Recursive Open Meta-Agents) decomposes goals into dependency-aware
 * subtask trees that can be executed in parallel. The Atomizer determines
 * whether a task should be decomposed (non-atomic) or executed directly (atomic).
 */
import type { TaskTreeNode, DeliberationPlan } from './types';

let nodeCounter = 0;
function generateNodeId(): string {
  return `task_${Date.now()}_${++nodeCounter}`;
}

export class RecursiveAtomizer {
  private maxDepth: number;
  private maxSubtasks: number;

  constructor(maxDepth = 3, maxSubtasks = 10) {
    this.maxDepth = maxDepth;
    this.maxSubtasks = maxSubtasks;
  }

  decompose(
    goal: string,
    deliberation: DeliberationPlan,
    parentId: string | null = null,
    depth = 0,
    availableTools: string[] = [],
  ): TaskTreeNode {
    const nodeId = generateNodeId();
    const isAtomic = this.shouldBeAtomic(goal, deliberation, depth);

    const node: TaskTreeNode = {
      id: nodeId,
      parentId,
      goal,
      role: isAtomic ? 'EXECUTOR' : 'ATOMIZER',
      isAtomic,
      subtasks: [],
      dependencies: [],
      context: {
        systemPrompt: this.buildSystemPrompt(goal, deliberation, isAtomic),
        availableTools,
        estimatedTokens: isAtomic ? deliberation.estimatedTokens / 2 : deliberation.estimatedTokens,
      },
      status: 'PENDING',
    };

    if (!isAtomic && depth < this.maxDepth) {
      const subtasks = this.generateSubtasks(goal, deliberation, depth);
      const limitedSubtasks = subtasks.slice(0, this.maxSubtasks);

      if (limitedSubtasks.length > 1) {
        node.role = 'PLANNER';
        node.subtasks = limitedSubtasks.map((sub, i) => {
          const child = this.decompose(
            sub.goal,
            sub.deliberation as DeliberationPlan,
            nodeId,
            depth + 1,
            sub.availableTools ?? availableTools,
          );
          child.dependencies = sub.dependencies.map(depIdx =>
            node.subtasks[depIdx]?.id,
          ).filter(Boolean);
          return child;
        });
      }
    }

    return node;
  }

  private shouldBeAtomic(
    goal: string,
    deliberation: DeliberationPlan,
    depth: number,
  ): boolean {
    if (depth >= this.maxDepth) return true;
    if (deliberation.decompositionStrategy === 'NONE') return true;
    if (goal.length < 200) return true;
    if (deliberation.estimatedSteps < 5) return true;
    return false;
  }

  private generateSubtasks(
    goal: string,
    deliberation: DeliberationPlan,
    depth: number,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    const strategy = deliberation.decompositionStrategy;

    switch (strategy) {
      case 'ASPECT':
        return this.decomposeByAspect(goal, deliberation);
      case 'STEP':
        return this.decomposeByStep(goal, deliberation);
      case 'RECURSIVE':
        return this.decomposeRecursive(goal, deliberation, depth);
      default:
        return [{
          goal,
          deliberation: { ...deliberation, decompositionStrategy: 'NONE' } as DeliberationPlan,
          dependencies: [],
        }];
    }
  }

  private decomposeByAspect(
    goal: string,
    deliberation: DeliberationPlan,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    const aspects = [
      {
        aspect: 'research',
        prefix: 'Research and gather information',
        tools: ['web_search', 'document_reader'],
      },
      {
        aspect: 'analysis',
        prefix: 'Analyze and evaluate',
        tools: ['code_analysis', 'data_processing'],
      },
      {
        aspect: 'synthesis',
        prefix: 'Synthesize findings into',
        tools: ['reasoning'],
      },
    ];

    return aspects.map((a, i) => ({
      goal: `${a.prefix} for: ${goal}`,
      deliberation: {
        ...deliberation,
        decompositionStrategy: 'NONE',
        estimatedAgentCount: Math.max(1, Math.floor((deliberation.estimatedAgentCount ?? 3) / 3)),
        estimatedSteps: Math.max(2, Math.floor((deliberation.estimatedSteps ?? 10) / 3)),
      },
      dependencies: i > 0 ? [i - 1] : [],
      availableTools: a.tools,
    }));
  }

  private decomposeByStep(
    goal: string,
    deliberation: DeliberationPlan,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    const steps = [
      'Plan and design approach',
      'Implement core logic',
      'Review and verify',
      'Polish and finalize',
    ];

    return steps.map((step, i) => ({
      goal: `${step}: ${goal}`,
      deliberation: {
        ...deliberation,
        decompositionStrategy: 'NONE',
        estimatedSteps: Math.max(2, Math.floor((deliberation.estimatedSteps ?? 10) / 4)),
      },
      dependencies: i > 0 ? [i - 1] : [],
    }));
  }

  private decomposeRecursive(
    goal: string,
    deliberation: DeliberationPlan,
    depth: number,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    const halves = Math.min(3, Math.ceil(goal.length / 500));
    const chunkSize = Math.ceil(goal.length / halves);
    const chunks: string[] = [];

    for (let i = 0; i < halves; i++) {
      chunks.push(goal.slice(i * chunkSize, (i + 1) * chunkSize));
    }

    return chunks.map((chunk, i) => ({
      goal: chunk,
      deliberation: {
        ...deliberation,
        decompositionStrategy: depth < this.maxDepth - 1 ? 'RECURSIVE' : 'NONE',
        estimatedAgentCount: Math.max(1, Math.floor((deliberation.estimatedAgentCount ?? 4) / halves)),
        estimatedSteps: Math.max(3, Math.floor((deliberation.estimatedSteps ?? 12) / halves)),
      },
      dependencies: i > 0 ? [i - 1] : [],
    }));
  }

  private buildSystemPrompt(
    goal: string,
    deliberation: DeliberationPlan,
    isAtomic: boolean,
  ): string {
    const role = isAtomic
      ? 'You are an EXECUTOR agent. Execute the assigned subtask directly and produce a concrete result.'
      : deliberation.decompositionStrategy === 'ASPECT'
        ? 'You are an ASPECT RESEARCHER. Explore one aspect of the problem thoroughly.'
        : deliberation.decompositionStrategy === 'RECURSIVE'
          ? 'You are a RECURSIVE PLANNER. Decompose this subtask further if needed.'
          : 'You are a TASK PLANNER. Plan and execute the next step in the workflow.';

    return [
      role,
      '',
      `Task type: ${deliberation.taskType}`,
      `Complexity: ${deliberation.estimatedAgentCount > 5 ? 'HIGH' : deliberation.estimatedAgentCount > 2 ? 'MEDIUM' : 'LOW'}`,
      isAtomic ? 'Execute efficiently and return structured results.' : 'Decompose and delegate to sub-agents.',
      'Use the artifact pattern: write results to shared storage and return references.',
    ].join('\n');
  }
}
