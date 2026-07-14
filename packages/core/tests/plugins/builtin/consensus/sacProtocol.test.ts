import { describe, it, expect, beforeEach } from 'vitest';
import {
  SACProtocol,
  getSACProtocol,
  resetSACProtocol,
  DEFAULT_CONFIG,
  type SACProposal,
  type SACEvaluation,
} from '../../../../src/plugins/builtin/consensus/sacProtocol';

describe('SACProtocol', () => {
  let protocol: SACProtocol;

  beforeEach(() => {
    protocol = new SACProtocol();
  });

  it('merges custom config with defaults', () => {
    const custom = new SACProtocol({ initialReputation: 0.7 });
    expect(custom.getConfig().initialReputation).toBe(0.7);
    expect(custom.getConfig().minReputation).toBe(DEFAULT_CONFIG.minReputation);
  });

  it('returns initial reputation for unknown agents', () => {
    expect(protocol.getReputation('new-agent')).toBe(DEFAULT_CONFIG.initialReputation);
  });

  it('computes overall score from dimension scores', () => {
    const scores = { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 };
    expect(protocol.computeOverallScore(scores)).toBeCloseTo(1);
  });

  it('submits an evaluation and computes overall score + timestamp', () => {
    const evalIn = {
      evaluatorId: 'e1',
      evaluatedAgentId: 'a1',
      scores: { relevance: 0.8, accuracy: 0.8, depth: 0.8, logic: 0.8, clarity: 0.8 },
    };
    const full = protocol.submitEvaluation(evalIn);
    expect(full.overall).toBeCloseTo(0.8);
    expect(full.timestamp).toBeGreaterThan(0);
    expect(protocol.getEvaluationHistory()).toHaveLength(1);
  });

  it('throws when computing consensus with no proposals', () => {
    expect(() => protocol.computeConsensus([], [])).toThrow('no proposals provided');
  });

  it('computes consensus and returns the winning proposal', () => {
    const proposals: SACProposal[] = [
      { agentId: 'a1', answer: 'A', reasoning: 'ra' },
      { agentId: 'a2', answer: 'B', reasoning: 'rb' },
    ];
    const evaluations: SACEvaluation[] = [
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0.5, accuracy: 0.5, depth: 0.5, logic: 0.5, clarity: 0.5 },
        overall: 0.5,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a1',
        scores: { relevance: 0.9, accuracy: 0.9, depth: 0.9, logic: 0.9, clarity: 0.9 },
        overall: 0.9,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0.4, accuracy: 0.4, depth: 0.4, logic: 0.4, clarity: 0.4 },
        overall: 0.4,
        timestamp: Date.now(),
      },
    ];
    const result = protocol.computeConsensus(proposals, evaluations);
    expect(result.winningAgentId).toBe('a1');
    expect(result.totalEvaluations).toBe(4);
    expect(result.reputationUpdates.length).toBeGreaterThan(0);
  });

  it('assigns zero weighted score when a proposal has too few evaluators', () => {
    const proposals: SACProposal[] = [{ agentId: 'a1', answer: 'A', reasoning: 'ra' }];
    const evaluations: SACEvaluation[] = [
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
    ];
    const result = protocol.computeConsensus(proposals, evaluations);
    const a1 = result.allScores.find((s) => s.agentId === 'a1');
    expect(a1!.weightedScore).toBe(0);
    expect(a1!.evaluatorCount).toBe(1);
  });

  it('detects unanimous consensus when the winner score is very high', () => {
    const proposals: SACProposal[] = [
      { agentId: 'a1', answer: 'A', reasoning: 'ra' },
      { agentId: 'a2', answer: 'B', reasoning: 'rb' },
    ];
    const evaluations: SACEvaluation[] = [
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0, accuracy: 0, depth: 0, logic: 0, clarity: 0 },
        overall: 0,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0, accuracy: 0, depth: 0, logic: 0, clarity: 0 },
        overall: 0,
        timestamp: Date.now(),
      },
    ];
    const result = protocol.computeConsensus(proposals, evaluations);
    expect(result.consensusLevel).toBe('unanimous');
    expect(result.byzantineSuspects).toContain('a2');
  });

  it('detects divided consensus when scores are close together', () => {
    const proposals: SACProposal[] = [
      { agentId: 'a1', answer: 'A', reasoning: 'ra' },
      { agentId: 'a2', answer: 'B', reasoning: 'rb' },
    ];
    const evaluations: SACEvaluation[] = [
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a1',
        scores: { relevance: 0.35, accuracy: 0.35, depth: 0.35, logic: 0.35, clarity: 0.35 },
        overall: 0.35,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a1',
        scores: { relevance: 0.35, accuracy: 0.35, depth: 0.35, logic: 0.35, clarity: 0.35 },
        overall: 0.35,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0.3, accuracy: 0.3, depth: 0.3, logic: 0.3, clarity: 0.3 },
        overall: 0.3,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a2',
        scores: { relevance: 0.3, accuracy: 0.3, depth: 0.3, logic: 0.3, clarity: 0.3 },
        overall: 0.3,
        timestamp: Date.now(),
      },
    ];
    const result = protocol.computeConsensus(proposals, evaluations);
    expect(result.consensusLevel).toBe('divided');
  });

  it('updates reputations for evaluators and proposers', () => {
    const proposals: SACProposal[] = [{ agentId: 'a1', answer: 'A', reasoning: 'ra' }];
    const evaluations: SACEvaluation[] = [
      {
        evaluatorId: 'e1',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
      {
        evaluatorId: 'e2',
        evaluatedAgentId: 'a1',
        scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
        overall: 1,
        timestamp: Date.now(),
      },
    ];
    protocol.computeConsensus(proposals, evaluations);
    expect(protocol.getReputation('e1')).toBeGreaterThan(DEFAULT_CONFIG.initialReputation);
    expect(protocol.getReputation('a1')).toBeGreaterThan(DEFAULT_CONFIG.initialReputation);
  });

  it('returns a sorted reputation board', () => {
    protocol.getReputation('a1');
    protocol.getReputation('a2');
    protocol['reputation'].set('a1', 0.9);
    protocol['reputation'].set('a2', 0.3);
    const board = protocol.getReputationBoard();
    expect(board[0].agentId).toBe('a1');
    expect(board[1].agentId).toBe('a2');
  });

  it('maintains consensus history capped at 100 entries', () => {
    const proposal: SACProposal = { agentId: 'a1', answer: 'A', reasoning: 'ra' };
    const evaluation: SACEvaluation = {
      evaluatorId: 'e1',
      evaluatedAgentId: 'a1',
      scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
      overall: 1,
      timestamp: Date.now(),
    };
    for (let i = 0; i < 105; i++) {
      protocol.computeConsensus([proposal], [evaluation]);
    }
    expect(protocol.getConsensusHistory()).toHaveLength(100);
  });

  it('resets all internal state', () => {
    protocol.submitEvaluation({
      evaluatorId: 'e1',
      evaluatedAgentId: 'a1',
      scores: { relevance: 1, accuracy: 1, depth: 1, logic: 1, clarity: 1 },
    });
    protocol.getReputation('a1');
    protocol.reset();
    expect(protocol.getEvaluationHistory()).toHaveLength(0);
    expect(protocol.getConsensusHistory()).toHaveLength(0);
    expect(protocol.getReputationBoard()).toHaveLength(0);
  });
});

describe('SACProtocol singleton', () => {
  it('returns the same tenant protocol instance', () => {
    const a = getSACProtocol();
    const b = getSACProtocol();
    expect(a).toBe(b);
  });

  it('can reset the singleton instance', () => {
    const before = getSACProtocol();
    resetSACProtocol();
    const after = getSACProtocol();
    expect(after).not.toBe(before);
  });
});
