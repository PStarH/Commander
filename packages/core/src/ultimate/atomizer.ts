/**
 * Recursive Atomizer - ROMA-inspired task decomposition.
 *
 * ROMA (Recursive Open Meta-Agents) decomposes goals into dependency-aware
 * subtask trees that can be executed in parallel. The Atomizer determines
 * whether a task should be decomposed (non-atomic) or executed directly (atomic).
 */
import type { TaskTreeNode, DeliberationPlan } from './types';
import * as path from 'path';

/** Ms per estimated token for timeout calculation */
const MS_PER_TOKEN = 5;

/** Ms per available tool for timeout calculation */
const MS_PER_TOOL = 1000;

/** Minimum goal length (chars) to consider decomposition */
const MIN_GOAL_LENGTH_FOR_DECOMPOSITION = 200;

/** Minimum estimated steps to consider decomposition */
const MIN_STEPS_FOR_DECOMPOSITION = 5;

/**
 * Extract file-writing intent from a goal string.
 * Returns the file path if the goal mentions writing/creating/generating a file, or null.
 */
function extractFileIntent(goal: string): string | null {
  const extRe = `(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql|go|rs|java|c|cpp|h)`;
  const patterns = [
    new RegExp(`write\\s+(?:a|an|the)?\\s*(?:to\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`create\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`generate\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`output\\s+(?:to\\s+)?(?:the\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`produce\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`save\\s+(?:to\\s+)?(?:the\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
  ];
  for (const re of patterns) {
    const m = goal.match(re);
    if (m) {
      // Validate it looks like a real path (not a random word ending in .md)
      const candidate = m[1];
      if (candidate.includes('/') || candidate.includes('\\') || candidate.startsWith('.') || path.extname(candidate).length > 1) {
        return candidate;
      }
    }
  }
  return null;
}

export class RecursiveAtomizer {
  private maxDepth: number;
  private maxSubtasks: number;
  private nodeCounter = 0;

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
    const nodeId = `task_${Date.now()}_${++this.nodeCounter}`;
    const isAtomic = this.shouldBeAtomic(goal, deliberation, depth);

    const estimatedTokens = isAtomic ? deliberation.estimatedTokens / 2 : deliberation.estimatedTokens;

    // Chimera-inspired: use deliberation's per-agent time budget for node timeout
    const nodeTimeoutMs = deliberation.timeBudgetPerAgentMs > 0
      ? deliberation.timeBudgetPerAgentMs
      : Math.round(estimatedTokens * MS_PER_TOKEN + availableTools.length * MS_PER_TOOL);

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
        estimatedTokens,
      },
      status: 'PENDING',
      estimatedDurationMs: nodeTimeoutMs,
    };

    if (!isAtomic && depth < this.maxDepth) {
      const subtasks = this.generateSubtasks(goal, deliberation, depth);
      const limitedSubtasks = subtasks.slice(0, this.maxSubtasks);

      if (limitedSubtasks.length > 1) {
        node.role = 'PLANNER';
        const children = limitedSubtasks.map((sub, i) => {
          return this.decompose(
            sub.goal,
            sub.deliberation as DeliberationPlan,
            nodeId,
            depth + 1,
            sub.availableTools ?? availableTools,
          );
        });
        for (let i = 0; i < limitedSubtasks.length; i++) {
          children[i].dependencies = limitedSubtasks[i].dependencies
            .map(depIdx => children[depIdx]?.id)
            .filter((id): id is string => !!id);
        }
        node.subtasks = children;
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
    if (goal.length < MIN_GOAL_LENGTH_FOR_DECOMPOSITION) return true;
    if (deliberation.estimatedSteps < MIN_STEPS_FOR_DECOMPOSITION) return true;
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

    const fileIntent = extractFileIntent(goal);
    return aspects.map((a, i) => {
      let subtaskGoal = `${a.prefix} for: ${goal}`;
      // If the original goal asks for a file, the last subtask must write it
      if (fileIntent && i === aspects.length - 1) {
        subtaskGoal = `${a.prefix} for: ${goal}\n\nIMPORTANT: Your final output MUST be written to the file "${fileIntent}" using the file_write tool. Do not just return text — write the file.`;
      }
      // Add detail instruction to all subtasks
      subtaskGoal += '\n\nIMPORTANT: Produce a DETAILED, COMPREHENSIVE output. Include specific findings, code examples, line numbers, and actionable recommendations. Do NOT just summarize what you plan to do — actually do it and provide the full analysis.';
      return {
        goal: subtaskGoal,
        deliberation: {
          ...deliberation,
          decompositionStrategy: 'NONE',
          estimatedAgentCount: Math.max(1, Math.floor((deliberation.estimatedAgentCount ?? 3) / 3)),
          estimatedSteps: Math.max(2, Math.floor((deliberation.estimatedSteps ?? 10) / 3)),
        },
        dependencies: i > 0 ? [i - 1] : [],
        availableTools: a.tools,
      };
    });
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

    const fileIntent = extractFileIntent(goal);
    return steps.map((step, i) => {
      let subtaskGoal = `${step}: ${goal}`;
      // If the original goal asks for a file, the last subtask must write it
      if (fileIntent && i === steps.length - 1) {
        subtaskGoal = `${step}: ${goal}\n\nIMPORTANT: Your final output MUST be written to the file "${fileIntent}" using the file_write tool. Do not just return text — write the file.`;
      }
      // Add detail instruction to all subtasks
      subtaskGoal += '\n\nIMPORTANT: Produce a DETAILED, COMPREHENSIVE output. Include specific findings, code examples, line numbers, and actionable recommendations. Do NOT just summarize what you plan to do — actually do it and provide the full analysis.';
      return {
        goal: subtaskGoal,
        deliberation: {
          ...deliberation,
          decompositionStrategy: 'NONE',
          estimatedSteps: Math.max(2, Math.floor((deliberation.estimatedSteps ?? 10) / 4)),
        },
        dependencies: i > 0 ? [i - 1] : [],
      };
    });
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
    const chunks = this.splitAtSemanticBoundaries(goal, halves);

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

  /**
   * Split text at semantic boundaries (paragraphs, sentences) instead of
   * arbitrary character positions. This preserves meaning and avoids
   * mid-sentence splits that confuse sub-agents.
   */
  private splitAtSemanticBoundaries(text: string, targetChunks: number): string[] {
    if (targetChunks <= 1) return [text];

    const idealChunkSize = Math.ceil(text.length / targetChunks);

    // Try splitting by double newlines (paragraphs) first
    const paragraphs = text.split(/\n\s*\n/);
    if (paragraphs.length >= targetChunks) {
      return this.groupBySize(paragraphs, idealChunkSize, '\n\n');
    }

    // Fall back to splitting by sentences
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length >= targetChunks) {
      return this.groupBySize(sentences, idealChunkSize, ' ');
    }

    // Last resort: split at word boundaries
    const words = text.split(/\s+/);
    return this.groupBySize(words, idealChunkSize, ' ');
  }

  /**
   * Group items into chunks that respect a target size, joining with the separator.
   */
  private groupBySize(items: string[], targetSize: number, separator: string): string[] {
    const chunks: string[] = [];
    let current: string[] = [];
    let currentSize = 0;

    for (const item of items) {
      if (currentSize + item.length > targetSize && current.length > 0) {
        chunks.push(current.join(separator));
        current = [item];
        currentSize = item.length;
      } else {
        current.push(item);
        currentSize += item.length + separator.length;
      }
    }

    if (current.length > 0) {
      chunks.push(current.join(separator));
    }

    return chunks;
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

    const taskTypeGuidance = this.getTaskTypeGuidance(deliberation.taskType);

    return [
      role,
      '',
      `Task type: ${deliberation.taskType}`,
      `Complexity: ${deliberation.estimatedAgentCount > 5 ? 'HIGH' : deliberation.estimatedAgentCount > 2 ? 'MEDIUM' : 'LOW'}`,
      isAtomic ? 'Execute efficiently and return structured results.' : 'Decompose and delegate to sub-agents.',
      taskTypeGuidance,
      'Use the artifact pattern: write results to shared storage and return references.',
    ].join('\n');
  }

  private getTaskTypeGuidance(taskType: DeliberationPlan['taskType']): string {
    switch (taskType) {
      case 'RESEARCH':
        return 'Focus on gathering comprehensive information. Cite sources. Distinguish facts from speculation.';
      case 'ANALYSIS':
        return 'Provide structured analysis with clear reasoning chains. Support conclusions with evidence.';
      case 'CODING':
        return 'Write clean, tested code. Include error handling. Follow existing patterns in the codebase.';
      case 'REASONING':
        return 'Show your reasoning step by step. Consider edge cases and counterarguments.';
      case 'CREATIVE':
        return 'Generate diverse options. Consider multiple approaches before selecting the best.';
      case 'FACTUAL':
        return 'Be precise and accurate. Verify facts before stating them. Cite sources when possible.';
      default:
        return '';
    }
  }
}
