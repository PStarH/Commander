import { describe, it, expect } from 'vitest';
import { RecursiveAtomizer } from '../../src/ultimate/atomizer';
import type { DeliberationPlan, OrchestrationTopology } from '../../src/ultimate/types';

const LONG_GOAL =
  'We need to design and implement a comprehensive multi-agent research pipeline that can read source files, analyze dependencies, identify refactoring opportunities, and produce a detailed written report with actionable recommendations for the engineering team.';

function makeDeliberation(overrides: Partial<DeliberationPlan> = {}): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType: 'REASONING',
    recommendedTopology: 'SINGLE',
    estimatedAgentCount: 4,
    estimatedSteps: 12,
    estimatedTokens: 2000,
    estimatedDurationMs: 60000,
    tokenBudget: { thinking: 500, execution: 1000, synthesis: 500 },
    decompositionStrategy: 'ASPECT',
    capabilitiesNeeded: [],
    confidence: 0.8,
    reasoning: [],
    suitableForSpeculation: false,
    taskNature: 'COMPUTE_BOUND',
    timeBudgetPerAgentMs: 15000,
    ...overrides,
  };
}

describe('RecursiveAtomizer topology-aware decomposition', () => {
  it('produces handoff agents with serial dependencies', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation({ estimatedAgentCount: 3 }),
      null,
      0,
      [],
      'HANDOFF',
    );

    expect(tree.subtasks.length).toBe(3);
    expect(tree.subtasks[0].role).toBe('HANDOFF_AGENT_1');
    expect(tree.subtasks[1].role).toBe('HANDOFF_AGENT_2');
    expect(tree.subtasks[1].dependencies).toContain(tree.subtasks[0].id);
    expect(tree.subtasks[2].dependencies).toContain(tree.subtasks[1].id);
    expect(tree.subtasks[0].context.systemPrompt).toContain('handoff agent');
    expect(tree.subtasks[0].isAtomic).toBe(true);
  });

  it('produces debaters and a judge for DEBATE', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation({ estimatedAgentCount: 4 }),
      null,
      0,
      [],
      'DEBATE',
    );

    expect(tree.subtasks.length).toBe(4);
    expect(tree.subtasks[0].role).toBe('DEBATER_1');
    expect(tree.subtasks[1].role).toBe('DEBATER_2');
    expect(tree.subtasks[2].role).toBe('DEBATER_3');
    expect(tree.subtasks[3].role).toBe('JUDGE');
    expect(tree.subtasks[3].goal).toContain('Judge');
    expect(tree.subtasks[3].context.systemPrompt).toContain('judge');
  });

  it('produces voters and an aggregator for ENSEMBLE', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation({ estimatedAgentCount: 3 }),
      null,
      0,
      [],
      'ENSEMBLE',
    );

    expect(tree.subtasks.length).toBe(3);
    expect(tree.subtasks[0].role).toBe('VOTER_1');
    expect(tree.subtasks[1].role).toBe('VOTER_2');
    expect(tree.subtasks[2].role).toBe('AGGREGATOR');
    expect(tree.subtasks[0].goal).toContain('pragmatic engineer');
    expect(tree.subtasks[2].context.systemPrompt).toContain('voting coordinator');
  });

  it('produces consensus agents for CONSENSUS', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation({ estimatedAgentCount: 2 }),
      null,
      0,
      [],
      'CONSENSUS',
    );

    expect(tree.subtasks.length).toBe(2);
    expect(tree.subtasks[0].role).toBe('CONSENSUS_AGENT_1');
    expect(tree.subtasks[1].role).toBe('CONSENSUS_AGENT_2');
    expect(tree.subtasks[0].context.systemPrompt).toContain('consensus participant');
  });

  it('produces implementer and evaluator for EVALUATOR_OPTIMIZER', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation(),
      null,
      0,
      [],
      'EVALUATOR_OPTIMIZER',
    );

    expect(tree.subtasks.length).toBe(2);
    expect(tree.subtasks[0].role).toBe('IMPLEMENTER');
    expect(tree.subtasks[1].role).toBe('EVALUATOR');
    expect(tree.subtasks[1].dependencies).toContain(tree.subtasks[0].id);
  });

  it('falls back to decompositionStrategy when topology is a standard topology', () => {
    const atomizer = new RecursiveAtomizer();
    const tree = atomizer.decompose(
      LONG_GOAL,
      makeDeliberation({ decompositionStrategy: 'ASPECT' }),
      null,
      0,
      [],
      'SINGLE',
    );

    expect(tree.subtasks.length).toBe(3);
    expect(tree.subtasks[0].role).toBe('EXECUTOR');
    expect(tree.subtasks[0].goal).toContain('Research and gather information');
  });
});
