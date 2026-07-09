import {
  AdaptiveStoppingController,
  type DebateRound,
} from '../../../plugins/builtin/consensus/adaptiveStopping';
import type { BenchmarkModule, Task, TokenUsage } from '../types';

/**
 * Benchmark module for AdaptiveStoppingController.
 *
 * Baseline: fixed-round debate that always runs the full MAX_ROUNDS.
 * Treatment: AdaptiveStoppingController stops early when the Beta-Binomial
 * novelty probability drops below a threshold. The KS-test arm is configured
 * conservatively for these small synthetic panels so that it does not fire on
 * transient count-structure coincidences; the Beta-Binomial signal is the
 * primary stopping driver.
 *
 * The task suite is fully scripted: no real LLM calls are required.
 */

const MAX_ROUNDS = 8;
const TOKENS_PER_ROUND = 20;
const LATENCY_PER_ROUND_MS = 2;

interface DebateScenario {
  id: string;
  prompt: string;
  /** One array of agent answers per round. */
  answers: string[][];
  correctAnswer: string;
}

const taskSuite: Task[] = [
  {
    id: 'converging-consensus',
    prompt: 'All agents quickly agree on A. Adaptive stopping should halt early.',
    expected: (output: string) => output === 'A',
  },
  {
    id: 'noisy-then-converge',
    prompt:
      'Round 1 is noisy, then all agents settle on A. Adaptive stopping should not halt on the first noisy round.',
    expected: (output: string) => output === 'A',
  },
  {
    id: 'persistent-disagreement',
    prompt:
      'Agents keep proposing genuinely new answers. Adaptive stopping should run the full debate.',
    expected: (output: string) => output === 'A',
  },
  {
    id: 'polarized-deadlock',
    prompt:
      'Two camps A and B keep switching majority. Adaptive stopping should not stop prematurely.',
    expected: (output: string) => output === 'A',
  },
  {
    id: 'late-consensus-new-idea',
    prompt:
      'A new winning answer D only appears late. Adaptive stopping must not halt before D emerges.',
    expected: (output: string) => output === 'D',
  },
];

const scenarios: Record<string, DebateScenario> = {
  'converging-consensus': {
    id: 'converging-consensus',
    prompt: taskSuite[0].prompt,
    answers: Array.from({ length: MAX_ROUNDS }, () => ['A', 'A', 'A', 'A', 'A']),
    correctAnswer: 'A',
  },
  'noisy-then-converge': {
    id: 'noisy-then-converge',
    prompt: taskSuite[1].prompt,
    answers: [
      ['B', 'B', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
      ['A', 'A', 'A', 'A', 'A'],
    ],
    correctAnswer: 'A',
  },
  'persistent-disagreement': {
    id: 'persistent-disagreement',
    prompt: taskSuite[2].prompt,
    answers: [
      ['A', 'X1', 'X2', 'X3', 'X4'],
      ['A', 'X5', 'X6', 'X7', 'X8'],
      ['A', 'X9', 'X10', 'X11', 'X12'],
      ['A', 'X13', 'X14', 'X15', 'X16'],
      ['A', 'X17', 'X18', 'X19', 'X20'],
      ['A', 'X21', 'X22', 'X23', 'X24'],
      ['A', 'X25', 'X26', 'X27', 'X28'],
      ['A', 'X29', 'X30', 'X31', 'X32'],
    ],
    correctAnswer: 'A',
  },
  'polarized-deadlock': {
    id: 'polarized-deadlock',
    prompt: taskSuite[3].prompt,
    answers: [
      ['A', 'A', 'A', 'B', 'Xa1'],
      ['A', 'B', 'B', 'B', 'Xb1'],
      ['A', 'A', 'A', 'B', 'Xa2'],
      ['A', 'B', 'B', 'B', 'Xb2'],
      ['A', 'A', 'A', 'B', 'Xa3'],
      ['A', 'B', 'B', 'B', 'Xb3'],
      ['A', 'A', 'A', 'B', 'Xa4'],
      ['A', 'A', 'A', 'B', 'Xa5'],
    ],
    correctAnswer: 'A',
  },
  'late-consensus-new-idea': {
    id: 'late-consensus-new-idea',
    prompt: taskSuite[4].prompt,
    answers: [
      ['A', 'B', 'C', 'A', 'B'],
      ['A', 'B', 'C', 'A', 'B'],
      ['A', 'B', 'C', 'A', 'B'],
      ['D', 'D', 'D', 'D', 'D'],
      ['D', 'D', 'D', 'D', 'D'],
      ['D', 'D', 'D', 'D', 'D'],
      ['D', 'D', 'D', 'D', 'D'],
      ['D', 'D', 'D', 'D', 'D'],
    ],
    correctAnswer: 'D',
  },
};

function majorityAnswer(answers: string[]): string {
  const counts = new Map<string, number>();
  let winner = answers[answers.length - 1];
  let maxCount = -1;

  // Iterate front-to-back so later-occurring answers win ties (recency bias).
  for (const answer of answers) {
    const count = (counts.get(answer) ?? 0) + 1;
    counts.set(answer, count);
    if (count >= maxCount) {
      maxCount = count;
      winner = answer;
    }
  }

  return winner;
}

function runDebate(
  implementation: { controller?: AdaptiveStoppingController },
  scenario: DebateScenario,
): { output: string; roundsRun: number; tokenUsage: TokenUsage; latencyMs: number } {
  const controller = implementation.controller;
  if (controller) {
    controller.reset();
  }

  let roundsRun = 0;

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    const round: DebateRound = {
      roundNumber: i,
      answers: scenario.answers[i - 1],
      tokenCost: TOKENS_PER_ROUND,
    };

    roundsRun = i;

    if (controller) {
      const result = controller.recordRound(round);
      if (result.shouldStop) {
        break;
      }
    }
  }

  const flatAnswers = scenario.answers.slice(0, roundsRun).flat();
  const output = majorityAnswer(flatAnswers);

  return {
    output,
    roundsRun,
    tokenUsage: {
      input: roundsRun * (TOKENS_PER_ROUND / 2),
      output: roundsRun * (TOKENS_PER_ROUND / 2),
      total: roundsRun * TOKENS_PER_ROUND,
      cached: 0,
      reasoning: 0,
    },
    latencyMs: roundsRun * LATENCY_PER_ROUND_MS,
  };
}

export const adaptiveStoppingModule: BenchmarkModule = {
  id: 'adaptiveStopping',
  name: 'Adaptive Stopping Controller',
  description:
    'Validates that AdaptiveStoppingController reaches the same correct consensus as a fixed-round baseline while consuming fewer rounds when the debate converges.',
  path: 'plugins/builtin/consensus/adaptiveStopping.ts',
  baselineFactory: () => ({}),
  treatmentFactory: () => ({
    controller: new AdaptiveStoppingController({
      maxRounds: MAX_ROUNDS,
      minRounds: 2,
      noveltyThreshold: 0.4,
      // Disable the KS-test stop arm for these synthetic small panels so that
      // transient count-structure similarities do not halt the debate early.
      ksAlpha: 1.0,
      requireBothSignals: false,
    }),
  }),
  runTrial: async ({ implementation, task }) => {
    const scenario = scenarios[task.id];
    if (!scenario) {
      throw new Error(`Unknown adaptive stopping task: ${task.id}`);
    }
    return runDebate(implementation as { controller?: AdaptiveStoppingController }, scenario);
  },
  taskSuite,
  metrics: ['successRate', 'cost', 'latency'],
};
