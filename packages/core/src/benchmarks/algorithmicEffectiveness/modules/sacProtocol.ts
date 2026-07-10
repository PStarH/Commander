import { SACProtocol } from '../../../plugins/builtin/consensus/sacProtocol';
import type { SACProposal, SACEvaluation } from '../../../plugins/builtin/consensus/sacProtocol';
import type { BenchmarkModule, Task } from '../types';

interface SACTask extends Task {
  correctAnswer: string;
  wrongAnswer: string;
  honestEvaluators: string[];
  byzantineEvaluators: string[];
  noiseEvaluators: string[];
}

interface EvalLike {
  evaluatorId: string;
  evaluatedAgentId: string;
  scores: SACEvaluation['scores'];
  overall: number;
}

const HONEST_IDS = ['honest-1', 'honest-2', 'honest-3'];
const BYZANTINE_IDS = ['byzantine-1', 'byzantine-2'];
const NOISE_IDS = ['noise-1', 'noise-2'];

function allDimensions(score: number): SACEvaluation['scores'] {
  return {
    relevance: score,
    accuracy: score,
    depth: score,
    logic: score,
    clarity: score,
  };
}

function makeProposal(agentId: string, answer: string): SACProposal {
  return {
    agentId,
    answer,
    reasoning: `${agentId} proposes ${answer}`,
  };
}

function buildEvaluations(task: SACTask, proposals: SACProposal[]): EvalLike[] {
  const honestProposal = proposals.find((p) => p.answer === task.correctAnswer)!;
  const byzantineProposal = proposals.find((p) => p.answer === task.wrongAnswer)!;

  const evaluations: EvalLike[] = [];

  for (const evaluatorId of task.honestEvaluators) {
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: honestProposal.agentId,
      scores: allDimensions(0.9),
      overall: 0.9,
    });
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: byzantineProposal.agentId,
      scores: allDimensions(0.2),
      overall: 0.2,
    });
  }

  for (const evaluatorId of task.byzantineEvaluators) {
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: honestProposal.agentId,
      scores: allDimensions(0.2),
      overall: 0.2,
    });
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: byzantineProposal.agentId,
      scores: allDimensions(0.9),
      overall: 0.9,
    });
  }

  // Low-confidence noise evaluators. Their scores are close to 0.5 but slightly
  // tilted toward the wrong answer so that simple majority is fooled, while
  // SAC's reputation weighting dilutes their impact.
  for (const evaluatorId of task.noiseEvaluators) {
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: honestProposal.agentId,
      scores: allDimensions(0.45),
      overall: 0.45,
    });
    evaluations.push({
      evaluatorId,
      evaluatedAgentId: byzantineProposal.agentId,
      scores: allDimensions(0.55),
      overall: 0.55,
    });
  }

  return evaluations;
}

function simpleMajorityWinner(proposals: SACProposal[], evaluations: EvalLike[]): SACProposal {
  const byEvaluator = new Map<string, EvalLike[]>();
  for (const e of evaluations) {
    if (!byEvaluator.has(e.evaluatorId)) {
      byEvaluator.set(e.evaluatorId, []);
    }
    byEvaluator.get(e.evaluatorId)!.push(e);
  }

  const voteCounts = new Map<string, number>();
  for (const [, evals] of byEvaluator) {
    const top = evals.sort((a, b) => b.overall - a.overall)[0];
    voteCounts.set(top.evaluatedAgentId, (voteCounts.get(top.evaluatedAgentId) ?? 0) + 1);
  }

  const ranked = [...proposals].sort(
    (a, b) => (voteCounts.get(b.agentId) ?? 0) - (voteCounts.get(a.agentId) ?? 0),
  );
  return ranked[0];
}

function runWarmup(protocol: SACProtocol): void {
  // Seed the protocol with a few honest-majority rounds so that honest
  // evaluators enter the real task suite with materially higher reputation
  // than Byzantine/noise evaluators.
  const correct = makeProposal('honest-proposer', 'warmup-correct');
  const wrong = makeProposal('byzantine-proposer', 'warmup-wrong');
  const proposals = [correct, wrong];

  for (let round = 0; round < 5; round++) {
    const evals: EvalLike[] = [];
    for (const id of HONEST_IDS) {
      evals.push({ evaluatorId: id, evaluatedAgentId: correct.agentId, scores: allDimensions(0.9), overall: 0.9 });
      evals.push({ evaluatorId: id, evaluatedAgentId: wrong.agentId, scores: allDimensions(0.2), overall: 0.2 });
    }
    for (const id of BYZANTINE_IDS) {
      evals.push({ evaluatorId: id, evaluatedAgentId: correct.agentId, scores: allDimensions(0.2), overall: 0.2 });
      evals.push({ evaluatorId: id, evaluatedAgentId: wrong.agentId, scores: allDimensions(0.9), overall: 0.9 });
    }

    const submitted = evals.map((e) =>
      protocol.submitEvaluation({
        evaluatorId: e.evaluatorId,
        evaluatedAgentId: e.evaluatedAgentId,
        scores: e.scores,
      }),
    );
    protocol.computeConsensus(proposals, submitted);
  }
}

interface SACBaseline {
  decide: (task: SACTask) => string;
}

interface SACTreatment {
  protocol: SACProtocol;
  decide: (task: SACTask) => string;
}

const taskSuite: SACTask[] = [
  {
    id: 'honest-majority',
    prompt: 'Consensus round with a clear honest majority.',
    correctAnswer: 'Alpha',
    wrongAnswer: 'Beta',
    honestEvaluators: HONEST_IDS,
    byzantineEvaluators: ['byzantine-1'],
    noiseEvaluators: ['noise-1'],
  },
  {
    id: 'byzantine-evaluators',
    prompt: 'Byzantine evaluators outnumber honest evaluators.',
    correctAnswer: 'Gamma',
    wrongAnswer: 'Delta',
    honestEvaluators: ['honest-1', 'honest-2'],
    byzantineEvaluators: ['byzantine-1', 'byzantine-2', 'byzantine-3'],
    noiseEvaluators: [],
  },
  {
    id: 'byzantine-proposers',
    prompt: 'Byzantine proposers and evaluators try to push the wrong answer.',
    correctAnswer: 'Epsilon',
    wrongAnswer: 'Zeta',
    honestEvaluators: ['honest-1', 'honest-2'],
    byzantineEvaluators: BYZANTINE_IDS,
    noiseEvaluators: NOISE_IDS,
  },
  {
    id: 'low-confidence-noise',
    prompt: 'Most evaluators are noisy and low-confidence.',
    correctAnswer: 'Eta',
    wrongAnswer: 'Theta',
    honestEvaluators: ['honest-1', 'honest-2'],
    byzantineEvaluators: ['byzantine-1'],
    noiseEvaluators: ['noise-1', 'noise-2', 'noise-3'],
  },
  {
    id: 'mixed-drift',
    prompt: 'Honest majority is barely smaller than the Byzantine+noise coalition.',
    correctAnswer: 'Iota',
    wrongAnswer: 'Kappa',
    honestEvaluators: HONEST_IDS,
    byzantineEvaluators: BYZANTINE_IDS,
    noiseEvaluators: NOISE_IDS,
  },
];

// Attach strict expected validators.
const taskSuiteWithExpected: SACTask[] = taskSuite.map((task) => ({
  ...task,
  expected: (output: string) => output === task.correctAnswer,
}));

export const sacProtocolModule: BenchmarkModule = {
  id: 'sacProtocol',
  name: 'SAC Protocol Consensus',
  description:
    'Validates that SAC receiver-side evaluation and dynamic reputation updates converge to the correct answer even when Byzantine agents dominate simple majority voting.',
  path: 'plugins/builtin/consensus/sacProtocol.ts',
  baselineFactory: () => ({
    decide: (task: SACTask) => {
      const proposals = [
        makeProposal('honest-proposer', task.correctAnswer),
        makeProposal('byzantine-proposer', task.wrongAnswer),
      ];
      const evaluations = buildEvaluations(task, proposals);
      return simpleMajorityWinner(proposals, evaluations).answer;
    },
  }),
  treatmentFactory: () => {
    const protocol = new SACProtocol();
    runWarmup(protocol);

    return {
      protocol,
      decide: (task: SACTask) => {
        const proposals = [
          makeProposal('honest-proposer', task.correctAnswer),
          makeProposal('byzantine-proposer', task.wrongAnswer),
        ];
        const evaluations = buildEvaluations(task, proposals);
        const submitted = evaluations.map((e) =>
          protocol.submitEvaluation({
            evaluatorId: e.evaluatorId,
            evaluatedAgentId: e.evaluatedAgentId,
            scores: e.scores,
          }),
        );
        const result = protocol.computeConsensus(proposals, submitted);
        return result.winningProposal.answer;
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as SACBaseline | SACTreatment;
    const output = impl.decide(task as SACTask);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuiteWithExpected as unknown as Task[],
  metrics: ['successRate'],
};
