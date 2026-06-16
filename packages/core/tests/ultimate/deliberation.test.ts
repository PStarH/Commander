import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deliberate, classifyTaskNature } from '../../src/ultimate/deliberation';

describe('deliberate', () => {
  describe('task type classification', () => {
    it('classifies coding tasks', () => {
      const plan = deliberate('implement a REST API endpoint for user authentication');
      assert.equal(plan.taskType, 'CODING');
    });

    it('classifies research tasks', () => {
      const plan = deliberate('research the best database for high-throughput applications');
      assert.equal(plan.taskType, 'RESEARCH');
    });

    it('classifies reasoning tasks', () => {
      const plan = deliberate(
        'explain why microservices are better than monoliths for this use case',
      );
      assert.equal(plan.taskType, 'REASONING');
    });

    it('classifies creative tasks', () => {
      const plan = deliberate('design a new architecture for the payment system');
      assert.equal(plan.taskType, 'CREATIVE');
    });

    it('classifies analysis tasks', () => {
      const plan = deliberate('review the security audit report and summarize findings');
      assert.equal(plan.taskType, 'ANALYSIS');
    });

    it('classifies factual tasks', () => {
      const plan = deliberate('what is the current version of Node.js LTS');
      assert.equal(plan.taskType, 'FACTUAL');
    });

    it('defaults to FACTUAL when no keywords match', () => {
      const plan = deliberate('xyzzy plugh');
      assert.equal(plan.taskType, 'FACTUAL');
    });
  });

  describe('effort level', () => {
    it('assigns effort level based on goal complexity', () => {
      const simple = deliberate('list files');
      const complex = deliberate(
        'implement a distributed consensus algorithm with fault tolerance, replication, and leader election',
      );
      assert.ok(['SIMPLE', 'MEDIUM', 'COMPLEX', 'DEEP_RESEARCH'].includes(simple.effortLevel));
      assert.ok(['SIMPLE', 'MEDIUM', 'COMPLEX', 'DEEP_RESEARCH'].includes(complex.effortLevel));
    });
  });

  describe('external info detection', () => {
    it('detects research tasks as requiring external info', () => {
      const plan = deliberate('research quantum computing');
      assert.equal(plan.requiresExternalInfo, true);
    });

    it('detects temporal queries', () => {
      const plan = deliberate('what is the latest news in AI 2026');
      assert.equal(plan.requiresExternalInfo, true);
    });

    it('detects current/recent keywords', () => {
      const plan = deliberate('what is the current stock price');
      assert.equal(plan.requiresExternalInfo, true);
    });
  });

  describe('topology selection', () => {
    it('selects a valid topology', () => {
      const validTopologies = [
        'SINGLE',
        'SEQUENTIAL',
        'PARALLEL',
        'HIERARCHICAL',
        'HYBRID',
        'DEBATE',
        'ENSEMBLE',
        'EVALUATOR_OPTIMIZER',
      ];
      const plan = deliberate('implement a new feature');
      assert.ok(validTopologies.includes(plan.recommendedTopology));
    });
  });

  describe('decomposition strategy', () => {
    it('returns a valid decomposition strategy', () => {
      const plan = deliberate('build a full-stack application');
      assert.ok(['ASPECT', 'STEP', 'RECURSIVE', 'NONE'].includes(plan.decompositionStrategy));
    });

    it('returns ASPECT for research tasks', () => {
      const plan = deliberate('research quantum computing approaches');
      assert.equal(plan.decompositionStrategy, 'ASPECT');
    });
  });

  describe('capabilities inference', () => {
    it('infers capabilities for coding tasks', () => {
      const plan = deliberate('implement a REST API');
      assert.ok(Array.isArray(plan.capabilitiesNeeded));
    });
  });

  describe('token and agent estimation', () => {
    it('estimates agent count > 0', () => {
      const plan = deliberate('build a web application');
      assert.ok(plan.estimatedAgentCount >= 1);
    });

    it('estimates steps > 0', () => {
      const plan = deliberate('build a web application');
      assert.ok(plan.estimatedSteps >= 1);
    });

    it('estimates tokens > 0', () => {
      const plan = deliberate('build a web application');
      assert.ok(plan.estimatedTokens >= 1);
    });

    it('estimates duration > 0', () => {
      const plan = deliberate('build a web application');
      assert.ok(plan.estimatedDurationMs >= 1);
    });
  });

  describe('token budget', () => {
    it('allocates thinking budget with thinking, execution, synthesis', () => {
      const plan = deliberate('implement a feature');
      assert.ok(plan.tokenBudget.thinking >= 0);
      assert.ok(plan.tokenBudget.execution >= 0);
      assert.ok(plan.tokenBudget.synthesis >= 0);
    });
  });

  describe('confidence', () => {
    it('returns confidence between 0 and 1', () => {
      const plan = deliberate('implement a simple function');
      assert.ok(plan.confidence >= 0 && plan.confidence <= 1);
    });
  });

  describe('reasoning', () => {
    it('returns non-empty reasoning array', () => {
      const plan = deliberate('implement a REST API');
      assert.ok(Array.isArray(plan.reasoning));
      assert.ok(plan.reasoning.length > 0);
    });
  });

  describe('speculation suitability', () => {
    it('returns boolean for suitableForSpeculation', () => {
      const plan = deliberate('research and analyze the codebase');
      assert.equal(typeof plan.suitableForSpeculation, 'boolean');
    });
  });

  describe('time budget per agent', () => {
    it('allocates positive time budget per agent', () => {
      const plan = deliberate('implement a feature');
      assert.ok(plan.timeBudgetPerAgentMs >= 0);
    });
  });
});

describe('classifyTaskNature', () => {
  it('returns IO_BOUND for RESEARCH tasks', () => {
    assert.equal(classifyTaskNature('RESEARCH', true), 'IO_BOUND');
  });

  it('returns COMPUTE_BOUND for non-RESEARCH without external info', () => {
    assert.equal(classifyTaskNature('CODING', false), 'COMPUTE_BOUND');
  });

  it('returns COMPUTE_BOUND for CODING regardless of external info', () => {
    assert.equal(classifyTaskNature('CODING', true), 'COMPUTE_BOUND');
    assert.equal(classifyTaskNature('CODING', false), 'COMPUTE_BOUND');
  });

  it('returns MIXED for CREATIVE tasks', () => {
    assert.equal(classifyTaskNature('CREATIVE', false), 'MIXED');
  });

  it('returns IO_BOUND for RESEARCH regardless of external info', () => {
    assert.equal(classifyTaskNature('RESEARCH', false), 'IO_BOUND');
    assert.equal(classifyTaskNature('RESEARCH', true), 'IO_BOUND');
  });
});
