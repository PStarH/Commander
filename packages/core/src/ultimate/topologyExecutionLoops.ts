import type { ExecutionError, OrchestrationTopology, TaskTreeNode } from './types';
import type { SubAgentExecutor } from './subAgentExecutor';

type TopologyExecutor = Pick<SubAgentExecutor, 'executeNode'>;

interface ExecutionLoopParams {
  projectId: string;
  contextData?: Record<string, unknown>;
}

export interface TopologyExecutionRequest extends ExecutionLoopParams {
  topology: OrchestrationTopology;
  taskTree: TaskTreeNode;
  errors: ExecutionError[];
  reasoning: string[];
}

const EVALUATOR_OPTIMIZER_MAX_ITERATIONS = 3;
const EVALUATOR_OPTIMIZER_QUALITY_THRESHOLD = 0.8;
const EVALUATOR_OPTIMIZER_DEFAULT_SCORE = 0.5;
const CONSENSUS_MAX_ROUNDS = 3;

export class TopologyExecutionRunner {
  constructor(private readonly subAgentExecutor: TopologyExecutor) {}

  async execute(request: TopologyExecutionRequest): Promise<boolean> {
    const { topology, taskTree, errors, reasoning, ...params } = request;

    const t = topology as string;
    if ((t === 'REVIEW' || t === 'EVALUATOR_OPTIMIZER') && taskTree.subtasks.length >= 2) {
      await this.executeEvaluatorOptimizerLoop(taskTree, params, errors, reasoning);
      return true;
    }
    if ((t === 'CHAIN' || t === 'HANDOFF') && taskTree.subtasks.length >= 2) {
      await this.executeHandoffLoop(taskTree, params, errors, reasoning);
      return true;
    }
    if (t === 'DEBATE' && taskTree.subtasks.length >= 3) {
      await this.executeDebateLoop(taskTree, params, errors, reasoning);
      return true;
    }
    if (t === 'ENSEMBLE' && taskTree.subtasks.length >= 3) {
      await this.executeEnsembleLoop(taskTree, params, errors, reasoning);
      return true;
    }
    if (t === 'CONSENSUS' && taskTree.subtasks.length >= 2) {
      await this.executeConsensusLoop(taskTree, params, errors, reasoning);
      return true;
    }

    return false;
  }

  async executeEvaluatorOptimizerLoop(
    taskTree: TaskTreeNode,
    params: ExecutionLoopParams,
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    if (taskTree.subtasks.length < 2) {
      reasoning.push('E-O loop: insufficient subtasks, falling back to standard execution');
      await this.subAgentExecutor.executeNode(
        taskTree,
        params.projectId,
        params.contextData ?? {},
        errors,
      );
      return;
    }

    const generator = taskTree.subtasks[0];
    const evaluator = taskTree.subtasks[1];
    const optimizer = taskTree.subtasks.length > 2 ? taskTree.subtasks[2] : null;

    const originalGeneratorGoal = generator.goal;
    const originalEvaluatorGoal = evaluator.goal;
    const originalOptimizerGoal = optimizer?.goal;

    let currentOutput = '';
    let iteration = 0;
    let qualityScore = 0;

    try {
      while (iteration < EVALUATOR_OPTIMIZER_MAX_ITERATIONS) {
        iteration++;
        reasoning.push(`E-O loop iteration ${iteration}: generating...`);

        await this.subAgentExecutor.executeNode(
          generator,
          params.projectId,
          params.contextData ?? {},
          errors,
        );

        currentOutput = generator.result ?? '';
        if (!currentOutput) {
          reasoning.push('E-O loop: generator produced empty output');
          break;
        }

        reasoning.push(`E-O loop iteration ${iteration}: evaluating...`);
        evaluator.goal = `Evaluate this output for quality, correctness, and completeness:\n\n${currentOutput.slice(0, 2000)}`;
        await this.subAgentExecutor.executeNode(
          evaluator,
          params.projectId,
          params.contextData ?? {},
          errors,
        );

        const evalResult = evaluator.result ?? '';
        const scoreMatch = evalResult.match(/(?:quality|score|rating)[\s:]*(\d+(?:\.\d+)?)/i);
        const rawScore = scoreMatch
          ? parseFloat(scoreMatch[1])
          : EVALUATOR_OPTIMIZER_DEFAULT_SCORE * 100;
        qualityScore = rawScore > 1 ? rawScore / 100 : rawScore;

        reasoning.push(
          `E-O loop iteration ${iteration}: quality=${(qualityScore * 100).toFixed(0)}%`,
        );

        if (qualityScore >= EVALUATOR_OPTIMIZER_QUALITY_THRESHOLD) {
          reasoning.push('E-O loop: quality threshold met');
          break;
        }

        if (!optimizer) {
          reasoning.push('E-O loop: no optimizer agent, using generator feedback');
          generator.goal = `Improve this output based on feedback:\n\nEvaluation: ${evalResult.slice(0, 1000)}\n\nCurrent output:\n${currentOutput.slice(0, 2000)}`;
          continue;
        }

        reasoning.push(`E-O loop iteration ${iteration}: optimizing...`);
        optimizer.goal = `Optimize this output based on evaluation feedback:\n\nEvaluation: ${evalResult.slice(0, 1000)}\n\nCurrent output:\n${currentOutput.slice(0, 2000)}`;
        await this.subAgentExecutor.executeNode(
          optimizer,
          params.projectId,
          params.contextData ?? {},
          errors,
        );

        const optimizedOutput = optimizer.result ?? currentOutput;
        generator.goal = `Use this optimized version as your next generation baseline:\n\n${optimizedOutput.slice(0, 2000)}`;
      }
    } finally {
      generator.goal = originalGeneratorGoal;
      evaluator.goal = originalEvaluatorGoal;
      if (optimizer && originalOptimizerGoal !== undefined) {
        optimizer.goal = originalOptimizerGoal;
      }
    }

    generator.result = currentOutput;
    generator.status = 'COMPLETED';
    reasoning.push(
      `E-O loop completed: ${iteration} iterations, final quality=${(qualityScore * 100).toFixed(0)}%`,
    );
  }

  /**
   * HANDOFF: serially execute subtasks, passing the previous agent's output
   * into the next agent's context.
   */
  async executeHandoffLoop(
    taskTree: TaskTreeNode,
    params: ExecutionLoopParams,
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    reasoning.push(`HANDOFF: ${taskTree.subtasks.length} agents in serial handoff`);
    let handoffContext = '';
    const originalGoals = taskTree.subtasks.map((s) => s.goal);
    const originalPrompts = taskTree.subtasks.map((s) => s.context.systemPrompt);

    try {
      for (let i = 0; i < taskTree.subtasks.length; i++) {
        const sub = taskTree.subtasks[i];
        sub.context.systemPrompt =
          `You are Agent ${i + 1} of ${taskTree.subtasks.length}. ` +
          (i > 0
            ? 'Review the handoff context from the previous agent and continue the task.'
            : 'Start the task from scratch.');
        sub.goal =
          i === 0
            ? sub.goal
            : `Handoff from Agent ${i}. Prior context:\n${handoffContext.slice(0, 1500)}\n\nContinue: ${sub.goal}`;

        await this.subAgentExecutor.executeNode(
          sub,
          params.projectId,
          params.contextData ?? {},
          errors,
        );
        handoffContext = `Agent ${i + 1} completed. Result: ${(sub.result ?? '').slice(0, 1000)}`;
        if (sub.status !== 'COMPLETED') {
          reasoning.push(`HANDOFF: Agent ${i + 1} failed, stopping handoff`);
          break;
        }
      }
    } finally {
      for (let i = 0; i < taskTree.subtasks.length; i++) {
        taskTree.subtasks[i].goal = originalGoals[i];
        taskTree.subtasks[i].context.systemPrompt = originalPrompts[i];
      }
    }

    taskTree.status = 'COMPLETED';
    taskTree.result = taskTree.subtasks[taskTree.subtasks.length - 1]?.result ?? '';
    reasoning.push('HANDOFF: completed');
  }

  /**
   * DEBATE: run multiple debaters in parallel, then run a judge to pick/evaluate
   * the best answer. The last subtask is the judge.
   */
  async executeDebateLoop(
    taskTree: TaskTreeNode,
    params: ExecutionLoopParams,
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    const debaters = taskTree.subtasks.slice(0, -1);
    const judge = taskTree.subtasks[taskTree.subtasks.length - 1];
    reasoning.push(`DEBATE: ${debaters.length} debaters + 1 judge`);

    const originalDebateGoals = debaters.map((s) => s.goal);
    const originalJudgeGoal = judge.goal;

    try {
      await Promise.all(
        debaters.map(async (sub, i) => {
          sub.context.systemPrompt = `You are Debater ${i + 1}. Argue your position clearly and thoroughly.`;
          sub.goal = `[Debate position ${i + 1}] ${sub.goal}`;
          await this.subAgentExecutor.executeNode(
            sub,
            params.projectId,
            params.contextData ?? {},
            errors,
          );
        }),
      );

      const successfulDebaters = debaters.filter((d) => d.status === 'COMPLETED');
      if (successfulDebaters.length === 0) {
        reasoning.push('DEBATE: all debaters failed');
        return;
      }

      const debateResults = successfulDebaters
        .map((d, i) => `## Debater ${i + 1}\n${(d.result ?? '').slice(0, 1500)}`)
        .join('\n\n');
      judge.context.systemPrompt =
        'You are a judge. Evaluate the debater positions and select the best answer with justification.';
      judge.goal = `Evaluate these debate positions and pick the best answer:\n\n${debateResults}`;
      await this.subAgentExecutor.executeNode(
        judge,
        params.projectId,
        params.contextData ?? {},
        errors,
      );

      taskTree.status = judge.status;
      taskTree.result = judge.result ?? '';
      reasoning.push('DEBATE: judge completed');
    } finally {
      for (let i = 0; i < debaters.length; i++) {
        debaters[i].goal = originalDebateGoals[i];
      }
      judge.goal = originalJudgeGoal;
    }
  }

  /**
   * ENSEMBLE: run multiple voters with different perspectives in parallel,
   * then aggregate into a single vote.
   */
  async executeEnsembleLoop(
    taskTree: TaskTreeNode,
    params: ExecutionLoopParams,
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    const voters = taskTree.subtasks.slice(0, -1);
    const aggregator = taskTree.subtasks[taskTree.subtasks.length - 1];
    reasoning.push(`ENSEMBLE: ${voters.length} voters + 1 aggregator`);

    const originalVoterGoals = voters.map((s) => s.goal);
    const originalAggregatorGoal = aggregator.goal;
    const voterPrompts = [
      'You are a pragmatic engineer. Focus on correctness and feasibility.',
      'You are a senior architect. Focus on design quality and edge cases.',
      'You are a creative problem solver. Focus on novel approaches.',
    ];

    try {
      await Promise.all(
        voters.map(async (sub, i) => {
          sub.context.systemPrompt = voterPrompts[i % voterPrompts.length];
          sub.goal = `[Voter ${i + 1}] ${sub.goal}`;
          await this.subAgentExecutor.executeNode(
            sub,
            params.projectId,
            params.contextData ?? {},
            errors,
          );
        }),
      );

      const successfulVoters = voters.filter((v) => v.status === 'COMPLETED');
      if (successfulVoters.length === 0) {
        reasoning.push('ENSEMBLE: all voters failed');
        return;
      }

      const votes = successfulVoters
        .map((v, i) => `## Voter ${i + 1}\n${(v.result ?? '').slice(0, 1200)}`)
        .join('\n\n');
      aggregator.context.systemPrompt =
        'You are a voting coordinator. Synthesize the voter outputs into the best final answer.';
      aggregator.goal = `Synthesize these voter outputs into the best final answer:\n\n${votes}`;
      await this.subAgentExecutor.executeNode(
        aggregator,
        params.projectId,
        params.contextData ?? {},
        errors,
      );

      taskTree.status = aggregator.status;
      taskTree.result = aggregator.result ?? '';
      reasoning.push('ENSEMBLE: aggregation completed');
    } finally {
      for (let i = 0; i < voters.length; i++) {
        voters[i].goal = originalVoterGoals[i];
      }
      aggregator.goal = originalAggregatorGoal;
    }
  }

  /**
   * CONSENSUS: run multiple agents across several rounds, sharing context each
   * round, until convergence or max rounds.
   */
  async executeConsensusLoop(
    taskTree: TaskTreeNode,
    params: ExecutionLoopParams,
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    const agents = taskTree.subtasks;
    reasoning.push(`CONSENSUS: ${agents.length} agents x up to ${CONSENSUS_MAX_ROUNDS} rounds`);

    const originalGoals = agents.map((s) => s.goal);
    let sharedContext = '';

    try {
      for (let round = 0; round < CONSENSUS_MAX_ROUNDS; round++) {
        reasoning.push(`CONSENSUS: round ${round + 1}`);
        await Promise.all(
          agents.map(async (sub, i) => {
            sub.context.systemPrompt = `You are Consensus Agent ${i + 1}. Refine your position toward agreement with the group.`;
            sub.goal =
              round === 0
                ? `[Round 1] ${originalGoals[i]}`
                : `[Round ${round + 1}] Shared context:\n${sharedContext.slice(0, 1200)}\n\nRefine your answer.`;
            await this.subAgentExecutor.executeNode(
              sub,
              params.projectId,
              params.contextData ?? {},
              errors,
            );
          }),
        );

        const successful = agents.filter((a) => a.status === 'COMPLETED');
        if (successful.length === 0) {
          reasoning.push('CONSENSUS: all agents failed');
          break;
        }

        sharedContext = successful
          .map(
            (a, i) => `## Agent ${i + 1} (round ${round + 1})\n${(a.result ?? '').slice(0, 800)}`,
          )
          .join('\n\n');

        if (round >= 1) {
          const lengths = successful.map((a) => (a.result ?? '').length);
          const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
          const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length;
          if (Math.sqrt(variance) < avg * 0.2) {
            reasoning.push(`CONSENSUS: converged after ${round + 1} rounds`);
            break;
          }
        }
      }
    } finally {
      for (let i = 0; i < agents.length; i++) {
        agents[i].goal = originalGoals[i];
      }
    }

    const successful = agents.filter((a) => a.status === 'COMPLETED');
    taskTree.status = successful.length > 0 ? 'COMPLETED' : 'FAILED';
    taskTree.result = successful[0]?.result ?? '';
    reasoning.push('CONSENSUS: completed');
  }
}
