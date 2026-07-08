/**
 * SAC (Self-Anchored Consensus) Protocol — Receiver-Side Independent Evaluation
 *
 * Research basis: "Commander-BFT-C3" consensus report section 6 (Consensus Layer).
 *
 * Core insight: Self-reported confidence from LLM agents is unreliable —
 * byzantine agents can game it by reporting high confidence. SAC replaces
 * self-reported confidence with RECEIVER-SIDE evaluation: each receiving agent
 * independently scores the quality of each proposal it receives.
 *
 * Key properties:
 *   1. Receiver-side evaluation: consumers score producers, not self-reporting
 *   2. Dynamic reputation weighting: agents with higher historical accuracy
 *      get more weight in consensus voting
 *   3. (F+1)-robust: tolerates up to 85.7% byzantine nodes when the
 *      communication graph satisfies the robustness condition
 *   4. "Default distrust": new agents start with neutral reputation, not trust
 *
 * Algorithm:
 *   1. Each agent produces a proposal (answer + reasoning, NO self-confidence)
 *   2. Each OTHER agent independently evaluates all proposals on 5 dimensions:
 *      relevance, accuracy, depth, logic, clarity (0-1 each)
 *   3. Weight each evaluation by the evaluator's reputation score
 *   4. The proposal with the highest weighted average score wins
 *   5. Update reputations: evaluators whose top choice won get reputation boost;
 *      evaluators whose choice lost get reputation penalty
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SACProposal {
  agentId: string;
  modelFamily?: string;
  answer: string;
  reasoning: string;
  /** Optional — but NOT used for consensus weighting (receiver-side only) */
  selfReportedConfidence?: number;
}

export interface SACEvaluation {
  evaluatorId: string;
  evaluatedAgentId: string;
  scores: {
    relevance: number; // 0-1
    accuracy: number; // 0-1
    depth: number; // 0-1
    logic: number; // 0-1
    clarity: number; // 0-1
  };
  /** Overall weighted score (computed from dimension scores) */
  overall: number;
  /** Optional critique text */
  critique?: string;
  timestamp: number;
}

export interface SACConsensusResult {
  winningProposal: SACProposal;
  winningAgentId: string;
  consensusScore: number; // 0-1, weighted average score of winner
  consensusLevel: 'unanimous' | 'strong' | 'moderate' | 'low' | 'divided';
  allScores: Array<{
    agentId: string;
    weightedScore: number;
    evaluatorCount: number;
    dimensionAverages: SACDimensionAverages;
  }>;
  reputationUpdates: ReputationUpdate[];
  totalEvaluations: number;
  byzantineSuspects: string[]; // agents whose proposals were universally rejected
}

export interface SACDimensionAverages {
  relevance: number;
  accuracy: number;
  depth: number;
  logic: number;
  clarity: number;
}

export interface ReputationUpdate {
  agentId: string;
  oldReputation: number;
  newReputation: number;
  delta: number;
  reason: string;
}

export interface SACConfig {
  /** Dimension weights for computing overall score */
  dimensionWeights: {
    relevance: number;
    accuracy: number;
    depth: number;
    logic: number;
    clarity: number;
  };
  /** Consensus level thresholds */
  thresholds: {
    unanimous: number;
    strong: number;
    moderate: number;
    low: number;
  };
  /** Reputation learning rate (how fast reputations update). Default 0.1 */
  reputationLearningRate: number;
  /** Initial reputation for new agents. Default 0.5 (neutral, "default distrust") */
  initialReputation: number;
  /** Minimum reputation (can't go below this). Default 0.01 */
  minReputation: number;
  /** Maximum reputation. Default 1.0 */
  maxReputation: number;
  /** Reputation boost for evaluators who picked the winner. Default 0.05 */
  winnerBoost: number;
  /** Reputation penalty for evaluators who picked a loser. Default 0.03 */
  loserPenalty: number;
  /** Score threshold below which an agent is flagged as byzantine suspect. Default 0.2 */
  byzantineScoreThreshold: number;
  /** Whether to require minimum number of evaluators per proposal. Default 2 */
  minEvaluatorsPerProposal: number;
}

export const DEFAULT_CONFIG: SACConfig = {
  dimensionWeights: {
    relevance: 0.25,
    accuracy: 0.3,
    depth: 0.15,
    logic: 0.2,
    clarity: 0.1,
  },
  thresholds: {
    unanimous: 0.95,
    strong: 0.8,
    moderate: 0.6,
    low: 0.4,
  },
  reputationLearningRate: 0.1,
  initialReputation: 0.5,
  minReputation: 0.01,
  maxReputation: 1.0,
  winnerBoost: 0.05,
  loserPenalty: 0.03,
  byzantineScoreThreshold: 0.2,
  minEvaluatorsPerProposal: 2,
};

// ── SAC Consensus Protocol ───────────────────────────────────────────────────

export class SACProtocol {
  private config: SACConfig;
  private reputation: Map<string, number> = new Map();
  private evaluationHistory: SACEvaluation[] = [];
  private consensusHistory: SACConsensusResult[] = [];

  constructor(config?: Partial<SACConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the current reputation of an agent.
   */
  getReputation(agentId: string): number {
    if (!this.reputation.has(agentId)) {
      this.reputation.set(agentId, this.config.initialReputation);
    }
    return this.reputation.get(agentId)!;
  }

  /**
   * Compute the overall weighted score from dimension scores.
   */
  computeOverallScore(scores: SACEvaluation['scores']): number {
    const w = this.config.dimensionWeights;
    return (
      scores.relevance * w.relevance +
      scores.accuracy * w.accuracy +
      scores.depth * w.depth +
      scores.logic * w.logic +
      scores.clarity * w.clarity
    );
  }

  /**
   * Submit an evaluation from one agent about another agent's proposal.
   */
  submitEvaluation(evaluation: Omit<SACEvaluation, 'overall' | 'timestamp'>): SACEvaluation {
    const overall = this.computeOverallScore(evaluation.scores);
    const fullEvaluation: SACEvaluation = {
      ...evaluation,
      overall,
      timestamp: Date.now(),
    };
    this.evaluationHistory.push(fullEvaluation);
    return fullEvaluation;
  }

  /**
   * Run the SAC consensus algorithm over a set of proposals and evaluations.
   *
   * @param proposals - All proposals from participating agents
   * @param evaluations - All receiver-side evaluations (each evaluator scores each proposal)
   * @returns Consensus result with winner, scores, and reputation updates
   */
  computeConsensus(proposals: SACProposal[], evaluations: SACEvaluation[]): SACConsensusResult {
    if (proposals.length === 0) {
      throw new Error('SAC: no proposals provided');
    }

    // Group evaluations by evaluated agent
    const evaluationsByAgent = new Map<string, SACEvaluation[]>();
    for (const eval_ of evaluations) {
      if (!evaluationsByAgent.has(eval_.evaluatedAgentId)) {
        evaluationsByAgent.set(eval_.evaluatedAgentId, []);
      }
      evaluationsByAgent.get(eval_.evaluatedAgentId)!.push(eval_);
    }

    // Compute weighted score for each proposal
    const allScores: SACConsensusResult['allScores'] = [];
    for (const proposal of proposals) {
      const evals = evaluationsByAgent.get(proposal.agentId) ?? [];

      // Filter to evaluations that meet minimum evaluator count
      if (evals.length < this.config.minEvaluatorsPerProposal) {
        allScores.push({
          agentId: proposal.agentId,
          weightedScore: 0,
          evaluatorCount: evals.length,
          dimensionAverages: { relevance: 0, accuracy: 0, depth: 0, logic: 0, clarity: 0 },
        });
        continue;
      }

      // Weight each evaluation by the evaluator's reputation
      let totalWeight = 0;
      let weightedSum = 0;
      const dimSums = { relevance: 0, accuracy: 0, depth: 0, logic: 0, clarity: 0 };

      for (const eval_ of evals) {
        const evaluatorRep = this.getReputation(eval_.evaluatorId);
        totalWeight += evaluatorRep;
        weightedSum += eval_.overall * evaluatorRep;
        dimSums.relevance += eval_.scores.relevance * evaluatorRep;
        dimSums.accuracy += eval_.scores.accuracy * evaluatorRep;
        dimSums.depth += eval_.scores.depth * evaluatorRep;
        dimSums.logic += eval_.scores.logic * evaluatorRep;
        dimSums.clarity += eval_.scores.clarity * evaluatorRep;
      }

      const weightedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
      const dimensionAverages: SACDimensionAverages = {
        relevance: totalWeight > 0 ? dimSums.relevance / totalWeight : 0,
        accuracy: totalWeight > 0 ? dimSums.accuracy / totalWeight : 0,
        depth: totalWeight > 0 ? dimSums.depth / totalWeight : 0,
        logic: totalWeight > 0 ? dimSums.logic / totalWeight : 0,
        clarity: totalWeight > 0 ? dimSums.clarity / totalWeight : 0,
      };

      allScores.push({
        agentId: proposal.agentId,
        weightedScore,
        evaluatorCount: evals.length,
        dimensionAverages,
      });
    }

    // Find the winning proposal (highest weighted score)
    allScores.sort((a, b) => b.weightedScore - a.weightedScore);
    const winningScore = allScores[0];
    const winningProposal = proposals.find((p) => p.agentId === winningScore.agentId)!;

    // Determine consensus level
    const consensusLevel = this.determineConsensusLevel(winningScore.weightedScore, allScores);

    // Identify byzantine suspects (proposals with very low scores)
    const byzantineSuspects = allScores
      .filter(
        (s) =>
          s.weightedScore < this.config.byzantineScoreThreshold &&
          s.evaluatorCount >= this.config.minEvaluatorsPerProposal,
      )
      .map((s) => s.agentId);

    // Update reputations based on which evaluators picked the winner
    const reputationUpdates = this.updateReputations(winningScore.agentId, evaluationsByAgent);

    const result: SACConsensusResult = {
      winningProposal,
      winningAgentId: winningScore.agentId,
      consensusScore: winningScore.weightedScore,
      consensusLevel,
      allScores,
      reputationUpdates,
      totalEvaluations: evaluations.length,
      byzantineSuspects,
    };

    this.consensusHistory.push(result);
    if (this.consensusHistory.length > 100) this.consensusHistory.shift();

    return result;
  }

  /**
   * Determine consensus level from the winning score and distribution.
   */
  private determineConsensusLevel(
    winningScore: number,
    allScores: SACConsensusResult['allScores'],
  ): SACConsensusResult['consensusLevel'] {
    const t = this.config.thresholds;

    if (winningScore >= t.unanimous) return 'unanimous';
    if (winningScore >= t.strong) return 'strong';
    if (winningScore >= t.moderate) return 'moderate';
    if (winningScore >= t.low) return 'low';

    // Check if scores are spread out (divided)
    const validScores = allScores.filter((s) => s.evaluatorCount > 0);
    if (validScores.length > 1) {
      const max = Math.max(...validScores.map((s) => s.weightedScore));
      const min = Math.min(...validScores.map((s) => s.weightedScore));
      if (max - min < 0.15) return 'divided';
    }

    return 'low';
  }

  /**
   * Update agent reputations based on consensus outcome.
   * Evaluators who scored the winner highly get a boost; evaluators who
   * scored a loser highly get a penalty.
   */
  private updateReputations(
    winnerId: string,
    evaluationsByAgent: Map<string, SACEvaluation[]>,
  ): ReputationUpdate[] {
    const updates: ReputationUpdate[] = [];

    // Phase 1: Update EVALUATOR reputations based on whether they picked the winner
    for (const [evaluatedId, evals] of evaluationsByAgent) {
      for (const eval_ of evals) {
        const evaluatorId = eval_.evaluatorId;
        const oldRep = this.getReputation(evaluatorId);

        let delta = 0;
        let reason = '';

        if (evaluatedId === winnerId && eval_.overall > 0.6) {
          // Evaluator correctly identified the winner with a high score
          delta = this.config.winnerBoost;
          reason = `Correctly scored winner ${winnerId} highly (${eval_.overall.toFixed(2)})`;
        } else if (evaluatedId !== winnerId && eval_.overall > 0.7) {
          // Evaluator gave a high score to a non-winner
          delta = -this.config.loserPenalty;
          reason = `Scored non-winner ${evaluatedId} highly (${eval_.overall.toFixed(2)}) while winner was ${winnerId}`;
        }

        if (delta !== 0) {
          const newRep = Math.max(
            this.config.minReputation,
            Math.min(this.config.maxReputation, oldRep + delta),
          );
          this.reputation.set(evaluatorId, newRep);

          updates.push({
            agentId: evaluatorId,
            oldReputation: oldRep,
            newReputation: newRep,
            delta,
            reason,
          });
        }
      }
    }

    // Phase 2: Update PROPOSER reputations based on average evaluation scores
    // (done ONCE per proposer, not per evaluator — prevents multiple shifts)
    for (const [evaluatedId, evals] of evaluationsByAgent) {
      if (evals.length === 0) continue;
      const avgScore = evals.reduce((sum, e) => sum + e.overall, 0) / evals.length;
      const proposerOldRep = this.getReputation(evaluatedId);
      const proposerDelta = (avgScore - 0.5) * this.config.reputationLearningRate;
      const proposerNewRep = Math.max(
        this.config.minReputation,
        Math.min(this.config.maxReputation, proposerOldRep + proposerDelta),
      );
      this.reputation.set(evaluatedId, proposerNewRep);

      // Only record an update entry if there was a meaningful change
      if (Math.abs(proposerDelta) > 0.001) {
        updates.push({
          agentId: evaluatedId,
          oldReputation: proposerOldRep,
          newReputation: proposerNewRep,
          delta: proposerDelta,
          reason: `Average evaluation score: ${avgScore.toFixed(3)} across ${evals.length} evaluators`,
        });
      }
    }

    return updates;
  }

  /**
   * Get reputation leaderboard.
   */
  getReputationBoard(): Array<{ agentId: string; reputation: number }> {
    return Array.from(this.reputation.entries())
      .map(([agentId, reputation]) => ({ agentId, reputation }))
      .sort((a, b) => b.reputation - a.reputation);
  }

  /**
   * Get consensus history.
   */
  getConsensusHistory(): SACConsensusResult[] {
    return [...this.consensusHistory];
  }

  /**
   * Get evaluation history.
   */
  getEvaluationHistory(): SACEvaluation[] {
    return [...this.evaluationHistory];
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.reputation.clear();
    this.evaluationHistory = [];
    this.consensusHistory = [];
  }

  getConfig(): SACConfig {
    return { ...this.config };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from '../../../runtime/tenantAwareSingleton';

const sacProtocolSingleton = createTenantAwareSingleton(() => new SACProtocol(), {});

export function getSACProtocol(): SACProtocol {
  return sacProtocolSingleton.get();
}

export function resetSACProtocol(): void {
  sacProtocolSingleton.reset();
}
