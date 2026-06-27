/**
 * Recursive Atomizer - template-based task decomposition.
 *
 * Decomposes goals into subtask trees using fixed templates and text splitting.
 * ASPECT mode creates fixed subtask groups, STEP mode creates fixed execution
 * steps, and RECURSIVE mode splits goal text at paragraph boundaries.
 */
import type { TaskTreeNode, DeliberationPlan, OrchestrationTopology, ROMARole } from './types';
import * as path from 'node:path';

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
    new RegExp(
      `write\\s+(?:a|an|the)?\\s*(?:to\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`,
      'i',
    ),
    new RegExp(`create\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`generate\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(
      `output\\s+(?:to\\s+)?(?:the\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`,
      'i',
    ),
    new RegExp(`produce\\s+(?:a|an|the)?\\s*(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
    new RegExp(`save\\s+(?:to\\s+)?(?:the\\s+)?(?:file\\s+)?[\`"']?(\\S+\\.${extRe})[\`"']?`, 'i'),
  ];
  for (const re of patterns) {
    const m = goal.match(re);
    if (m) {
      // Validate it looks like a real path (not a random word ending in .md)
      const candidate = m[1];
      if (
        candidate.includes('/') ||
        candidate.includes('\\') ||
        candidate.startsWith('.') ||
        path.extname(candidate).length > 1
      ) {
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
    topology?: OrchestrationTopology,
  ): TaskTreeNode {
    const nodeId = `task_${Date.now()}_${++this.nodeCounter}`;
    const isAtomic = this.shouldBeAtomic(goal, deliberation, depth);

    const estimatedTokens = isAtomic
      ? deliberation.estimatedTokens / 2
      : deliberation.estimatedTokens;

    // Chimera-inspired: use deliberation's per-agent time budget for node timeout
    const nodeTimeoutMs =
      deliberation.timeBudgetPerAgentMs > 0
        ? deliberation.timeBudgetPerAgentMs
        : Math.round(estimatedTokens * MS_PER_TOKEN + availableTools.length * MS_PER_TOOL);

    const node: TaskTreeNode = {
      id: nodeId,
      parentId,
      goal,
      role: deliberation.role ?? (isAtomic ? 'EXECUTOR' : 'ATOMIZER'),
      isAtomic,
      subtasks: [],
      dependencies: [],
      context: {
        systemPrompt: this.buildSystemPrompt(goal, deliberation, isAtomic, topology),
        availableTools,
        estimatedTokens,
      },
      status: 'PENDING',
      estimatedDurationMs: nodeTimeoutMs,
    };

    if (!isAtomic && depth < this.maxDepth) {
      const subtasks = this.generateSubtasks(goal, deliberation, depth, topology);
      const limitedSubtasks = subtasks.slice(0, this.maxSubtasks);

      if (limitedSubtasks.length > 1) {
        node.role = 'PLANNER';
        const children = limitedSubtasks.map((sub) => {
          return this.decompose(
            sub.goal,
            sub.deliberation as DeliberationPlan,
            nodeId,
            depth + 1,
            sub.availableTools ?? availableTools,
            topology,
          );
        });
        for (let i = 0; i < limitedSubtasks.length; i++) {
          children[i].dependencies = limitedSubtasks[i].dependencies
            .map((depIdx) => children[depIdx]?.id)
            .filter((id): id is string => !!id);
        }
        node.subtasks = children;
      } else {
        // Not enough subtasks generated — treat as atomic
        node.isAtomic = true;
      }
    }

    return node;
  }

  private shouldBeAtomic(goal: string, deliberation: DeliberationPlan, depth: number): boolean {
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
    topology?: OrchestrationTopology,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    if (
      topology &&
      topology !== 'SINGLE' &&
      topology !== 'CHAIN' &&
      topology !== 'DISPATCH' &&
      topology !== 'ORCHESTRATOR' &&
      topology !== 'REVIEW'
    ) {
      return this.decomposeByTopology(goal, deliberation, topology);
    }

    const strategy = deliberation.decompositionStrategy;

    switch (strategy) {
      case 'ASPECT':
        return this.decomposeByAspect(goal, deliberation);
      case 'STEP':
        return this.decomposeByStep(goal, deliberation);
      case 'RECURSIVE':
        return this.decomposeRecursive(goal, deliberation, depth);
      default:
        return [
          {
            goal,
            deliberation: { ...deliberation, decompositionStrategy: 'NONE' } as DeliberationPlan,
            dependencies: [],
          },
        ];
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
    // Fixed 3-aspect template: research, analysis, synthesis
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
      const outputFile = fileIntent || '/tmp/commander-output.md';
      const aspectFile = outputFile.replace(/\.md$/, `-${a.aspect}.md`);
      let subtaskGoal = `${a.prefix} for: ${goal}`;

      subtaskGoal += `\n\nTask: Complete the above analysis and write results to "${aspectFile}".
Structure: Executive summary → Detailed findings with line numbers → Risk assessment (CRITICAL/HIGH/MEDIUM/LOW) → Actionable recommendations.
Include specific code snippets with line numbers when referencing code.`;

      return {
        goal: subtaskGoal,
        deliberation: {
          ...deliberation,
          decompositionStrategy: 'NONE',
          estimatedAgentCount: Math.max(1, Math.floor((deliberation.estimatedAgentCount ?? 3) / 3)),
          estimatedSteps: Math.max(5, Math.floor((deliberation.estimatedSteps ?? 10) / 3)),
        },
        dependencies: i > 0 ? [i - 1] : [],
        availableTools: a.tools,
      };
    });
  }

  private decomposeByTopology(
    goal: string,
    deliberation: DeliberationPlan,
    topology: OrchestrationTopology,
  ): Array<{
    goal: string;
    deliberation: Partial<DeliberationPlan>;
    dependencies: number[];
    availableTools?: string[];
  }> {
    const t = topology as string;
    const minAgents = t === 'DEBATE' || t === 'ENSEMBLE' ? 3 : 2;
    const agentCount = Math.min(
      8,
      Math.max(minAgents, deliberation.estimatedAgentCount ?? minAgents),
    );
    const base: Partial<DeliberationPlan> = {
      ...deliberation,
      decompositionStrategy: 'NONE',
      estimatedAgentCount: 1,
      estimatedSteps: Math.max(3, Math.floor((deliberation.estimatedSteps ?? 10) / agentCount)),
    };
    const roleOf = (r: string): ROMARole => r as ROMARole;

    switch (t) {
      case 'HANDOFF':
        return Array.from({ length: agentCount }, (_, i) => ({
          goal:
            i === 0
              ? `[Handoff Agent ${i + 1}/${agentCount}] ${goal}`
              : `[Handoff Agent ${i + 1}/${agentCount}] Continue the task using context from the previous agent. Original task: ${goal}`,
          deliberation: { ...base, role: roleOf(`HANDOFF_AGENT_${i + 1}`) },
          dependencies: i > 0 ? [i - 1] : [],
        }));
      case 'DEBATE': {
        const debaterCount = agentCount - 1;
        // Feature 7: Free-MAD Anti-Conformity Prompts
        // Research basis: "Commander-BFT-C3" consensus report section 6 (Debate Layer).
        //
        // Free-MAD (Consensus-Free Multi-Agent Debate) uses anti-conformity prompts
        // to increase candidate diversity. Each debater is explicitly instructed to:
        //   1. Argue a DISTINCT position (not just rephrase the same answer)
        //   2. Challenge the consensus if they disagree
        //   3. NOT conform to other debaters' views for the sake of agreement
        //   4. Provide independent reasoning before seeing other positions
        //
        // This breaks the "conformity propagation chain" where agents copy each
        // other's errors (hallucination resonance). The anti-conformity directive
        // is varied per debater to prevent template-matching convergence.
        const antiConformityDirectives = [
          'You MUST take a DISTINCT and INDEPENDENT position. Do NOT agree with other debaters unless your own analysis independently arrives at the same conclusion. Challenge conventional wisdom if your reasoning supports it.',
          'Your job is to find the answer that others might MISS. Consider edge cases, contrarian viewpoints, and approaches that diverge from the obvious. Independence of thought is more valuable than agreement.',
          'Argue from a fundamentally different angle than you expect other debaters to take. If you suspect others will agree with X, seriously consider whether NOT-X might be correct. Do NOT conform to avoid conflict.',
          'Be the devil\'s advocate. Even if you lean toward the majority view, argue the strongest possible case for the minority position. Only concede if the evidence is overwhelming AND you cannot find any counterargument.',
          'Prioritize correctness over consensus. If you believe the popular answer is wrong, say so clearly with evidence. Do NOT cave to social pressure from other debaters. A wrong consensus is worse than a productive disagreement.',
          'Think from first principles. Ignore what other debaters might say. Build your argument from the ground up using only the evidence and reasoning you can verify yourself. If this leads to a unique position, embrace it.',
        ];
        const debaters = Array.from({ length: debaterCount }, (_, i) => ({
          goal: `[Debater ${i + 1}/${debaterCount}] ${goal}\n\n## Anti-Conformity Directive\n${antiConformityDirectives[i % antiConformityDirectives.length]}\n\nProvide your INDEPENDENT answer first, before considering what other debaters might say. Your unique perspective is valuable precisely because it differs from others.`,
          deliberation: { ...base, role: roleOf(`DEBATER_${i + 1}`) },
          dependencies: [],
        }));
        return [
          ...debaters,
          {
            goal: `[Judge] Evaluate the debate positions and select the best answer for: ${goal}\n\n## Judge Directive\nYou are evaluating a Free-MAD (anti-conformity) debate. Each debater was instructed to provide INDEPENDENT and DISTINCT positions. Evaluate each on its own merits — do NOT weight agreement between debaters as a positive signal. A single well-reasoned contrarian position can be correct even if all others disagree. Select the answer with the strongest evidence and reasoning, not the most popular one.`,
            deliberation: { ...base, role: roleOf('JUDGE') },
            dependencies: [],
          },
        ];
      }
      case 'ENSEMBLE': {
        const voterCount = agentCount - 1;
        const perspectives = [
          'pragmatic engineer (correctness + feasibility)',
          'senior architect (design quality + edge cases)',
          'creative problem solver (novel approaches)',
        ];
        const voters = Array.from({ length: voterCount }, (_, i) => ({
          goal: `[Voter ${i + 1}/${voterCount} — ${perspectives[i % perspectives.length]}] ${goal}`,
          deliberation: { ...base, role: roleOf(`VOTER_${i + 1}`) },
          dependencies: [],
        }));
        return [
          ...voters,
          {
            goal: `[Aggregator] Synthesize the voter outputs into the best final answer for: ${goal}`,
            deliberation: { ...base, role: roleOf('AGGREGATOR') },
            dependencies: [],
          },
        ];
      }
      case 'CONSENSUS':
        return Array.from({ length: agentCount }, (_, i) => ({
          goal: `[Consensus Agent ${i + 1}/${agentCount}] Refine your position toward agreement. Task: ${goal}`,
          deliberation: { ...base, role: roleOf(`CONSENSUS_AGENT_${i + 1}`) },
          dependencies: [],
        }));
      case 'EVALUATOR_OPTIMIZER':
        return [
          {
            goal: `[Implementer] Produce an initial solution for: ${goal}`,
            deliberation: { ...base, role: roleOf('IMPLEMENTER') },
            dependencies: [],
          },
          {
            goal: `[Evaluator] Critically evaluate the implementation against requirements for: ${goal}`,
            deliberation: { ...base, role: roleOf('EVALUATOR') },
            dependencies: [0],
          },
        ];
      default:
        return [{ goal, deliberation: base, dependencies: [] }];
    }
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
    // Fixed 4-step template
    const steps = [
      'Plan and design approach',
      'Implement core logic',
      'Review and verify',
      'Polish and finalize',
    ];

    const fileIntent = extractFileIntent(goal);
    return steps.map((step, i) => {
      const outputFile = fileIntent || '/tmp/commander-output.md';
      const stepFile = outputFile.replace(/\.md$/, `-step${i + 1}.md`);
      let subtaskGoal = `${step}: ${goal}`;

      // Claude Code-style comprehensive prompting
      subtaskGoal += `\n\nYou are an interactive agent that helps users with software engineering and analysis tasks. Use the instructions below and the tools available to you to complete the task.

# Doing tasks
- You are highly capable and can complete ambitious tasks that would otherwise be too complex
- In general, do not propose changes to code you haven't read. Read files first before analyzing them
- If an approach fails, diagnose why before switching tactics. Don't retry the identical action blindly
- Be careful not to introduce security vulnerabilities. Prioritize writing safe, secure, and correct code

# Using your tools
Do NOT use bash commands when a relevant dedicated tool is provided:
- To read files use file_read instead of cat, head, tail, or sed
- To edit files use file_edit instead of sed or awk
- To create files use file_write instead of cat with heredoc or echo redirection
- To search for files use file_list instead of find or ls
- To search file content use file_search instead of grep or rg

You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel.

# Task-specific instructions
1. Use file_read to read ALL relevant source files completely (up to 2000 lines each)
2. Analyze the content in detail — include specific code snippets with line numbers
3. Write your complete output to "${stepFile}" using file_write
4. Structure with clear headers, sections, and actionable recommendations
5. Include at least 1000 words of substantive content
6. Do NOT describe what you plan to do — actually do it and write the file

# Code quality
- Include specific line numbers when referencing code
- Provide concrete code examples for recommendations
- Structure output with clear headers and sections
- Focus on actionable insights, not generic advice
- Don't add unnecessary comments or explanations. Only add comments where the logic isn't self-evident
- Don't create helpers, utilities, or abstractions for one-time operations
- Report outcomes faithfully: if something fails, say so with the relevant output

# Output format
Write a comprehensive output with:
- Executive summary
- Detailed findings with line numbers and code snippets
- Risk assessment (CRITICAL/HIGH/MEDIUM/LOW)
- Actionable recommendations with code examples
- Clear structure with headers and sections`;

      return {
        goal: subtaskGoal,
        deliberation: {
          ...deliberation,
          decompositionStrategy: 'NONE',
          estimatedSteps: Math.max(5, Math.floor((deliberation.estimatedSteps ?? 10) / 4)),
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
        estimatedAgentCount: Math.max(
          1,
          Math.floor((deliberation.estimatedAgentCount ?? 4) / halves),
        ),
        estimatedSteps: Math.max(3, Math.floor((deliberation.estimatedSteps ?? 12) / halves)),
      },
      dependencies: i > 0 ? [i - 1] : [],
    }));
  }

  /**
   * Split text at paragraph boundaries. This is simple text chunking, not
   * semantic boundary detection.
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
    topology?: OrchestrationTopology,
  ): string {
    const role = deliberation.role
      ? this.roleToSystemPrompt(deliberation.role, topology)
      : isAtomic
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
      isAtomic
        ? 'Execute efficiently and return structured results.'
        : 'Decompose and delegate to sub-agents.',
      taskTypeGuidance,
      'Use the artifact pattern: write results to shared storage and return references.',
    ].join('\n');
  }

  private roleToSystemPrompt(role: string, topology?: OrchestrationTopology): string {
    if (role.startsWith('HANDOFF_AGENT_')) {
      return `You are a serial handoff agent. ${role.endsWith('_1') ? 'Start the task from scratch and pass forward a clear result.' : 'Continue from the previous agent’s output and move the task forward.'}`;
    }
    if (role.startsWith('DEBATER_')) {
      // Feature 7: Free-MAD anti-conformity system prompt for debaters
      return 'You are a Free-MAD debater. Argue your assigned position with FULL INDEPENDENCE. Do NOT conform to other debaters\' views for the sake of agreement. Your unique perspective — even if contrarian — is valuable. Prioritize correctness over consensus.';
    }
    if (role === 'JUDGE') {
      return 'You are a judge. Evaluate the debate positions and select the best answer with justification.';
    }
    if (role.startsWith('VOTER_')) {
      return 'You are an ensemble voter. Provide your independent perspective on the task.';
    }
    if (role === 'AGGREGATOR') {
      return 'You are a voting coordinator. Synthesize the voter outputs into the best final answer.';
    }
    if (role.startsWith('CONSENSUS_AGENT_')) {
      return 'You are a consensus participant. Refine your position toward group agreement while preserving correctness.';
    }
    if (role === 'IMPLEMENTER') {
      return 'You are an implementer. Produce a concrete initial solution.';
    }
    if (role === 'EVALUATOR') {
      return 'You are an evaluator. Critically assess the implementation against requirements and identify concrete improvements.';
    }
    if (topology) {
      return `You are executing the ${topology} topology. Fulfill your assigned role.`;
    }
    return `You are ${role}. Execute the assigned subtask directly and produce a concrete result.`;
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
