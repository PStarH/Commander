/**
 * Component Integration Tests
 * Phase 2: 组件集成测试
 * 
 * 测试所有 Phase 1 组件的协同工作能力
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { 
  TaskComplexityAnalyzer, 
  AdaptiveOrchestrator, 
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
 InspectorAgent,
 createReflectionEngine,
 createConsensusChecker,
 createInspector,
  OrchestrationMode
} from '../src/index';

describe('Phase 1 Component Integration Tests', () => {
  
  // ========================================
  // Test 1: Task Complexity → Orchestrator
  // ========================================
  
  describe('TaskComplexityAnalyzer → AdaptiveOrchestrator', () => {
    let analyzer: TaskComplexityAnalyzer;
    let orchestrator: AdaptiveOrchestrator;

    before(() => {
      analyzer = new TaskComplexityAnalyzer();
      orchestrator = new AdaptiveOrchestrator();
    });

    it('should select correct mode based on complexity', () => {
      // Simple task → SEQUENTIAL
      const simpleTask = {
        id: '1',
        description: 'Write a simple hello world function',
        riskLevel: 'low' as const
      };
      const simpleScore = analyzer.analyze(simpleTask);
      orchestrator.createPlan([{ ...simpleTask, complexity: simpleScore.score }], simpleScore.recommendedMode);
      assert.strictEqual(orchestrator.getCurrentMode(), 'SEQUENTIAL');

      // Complex task with dependencies → HANDOFF
      const complexTask = {
        id: '2',
        description: 'Build a distributed database with multiple services that need expert coordination',
        riskLevel: 'high' as const
      };
      const complexScore = analyzer.analyze(complexTask);
      orchestrator.createPlan([{ ...complexTask, complexity: complexScore.score }], complexScore.recommendedMode);
      assert.ok(['HANDOFF', 'MAGENTIC', 'CONSENSUS'].includes(orchestrator.getCurrentMode()));
    });

    it('should allocate more agents for parallel tasks', () => {
      orchestrator.registerAgent({ id: 'agent-1', name: 'Agent 1', role: 'coder', capabilities: ['coding'] });
      orchestrator.registerAgent({ id: 'agent-2', name: 'Agent 2', role: 'coder', capabilities: ['coding'] });
      orchestrator.registerAgent({ id: 'agent-3', name: 'Agent 3', role: 'coder', capabilities: ['coding'] });

      const task = {
        id: 'parallel-1',
        description: 'Process 10 independent data files',
        priority: 'medium' as const,
        complexity: 25
      };

      const plan = orchestrator.createPlan([task], 'PARALLEL');
      assert.ok(plan.resourceAllocation.maxConcurrent > 1);
    });
  });

  // ========================================
  // Test 2: Token Budget + Task Complexity
  // ========================================
  
  describe('TokenBudgetAllocator', () => {
    let allocator: TokenBudgetAllocator;

    before(() => {
      allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
    });

    it('should allocate more budget for complex tasks', () => {
      const lowBudget = allocator.allocate('SEQUENTIAL', 20, 1);
      const highBudget = allocator.allocate('SEQUENTIAL', 80, 1);
      
      assert.ok(highBudget.total > lowBudget.total);
    });

    it('should allocate differently per mode', () => {
      const sequential = allocator.allocate('SEQUENTIAL', 50, 1);
      const parallel = allocator.allocate('PARALLEL', 50, 3);
      
      // SEQUENTIAL: Lead gets more
      assert.ok(sequential.leadAgent > sequential.specialistAgents);
      
      // PARALLEL: Specialists get more
      assert.ok(parallel.specialistAgents > parallel.leadAgent);
    });

    it('should track usage correctly', () => {
      allocator.initialize(100000);
      allocator.recordUsage('lead', 5000, 'execution');
      allocator.recordUsage('specialist-0', 3000, 'execution');
      
      assert.strictEqual(allocator.getUsageRate(), 0.08); // 8000 / 100000
      assert.strictEqual(allocator.getRemaining(), 92000);
    });

    it('should warn at threshold', () => {
      allocator.initialize(10000);
      allocator.recordUsage('lead', 8500);
      
      assert.strictEqual(allocator.isWarningThreshold(), true);
      assert.strictEqual(allocator.isCutoffThreshold(), false);
    });
  });

  // ========================================
  // Test 3: Three-Layer Memory
  // ========================================
  
  describe('ThreeLayerMemory', () => {
    let memory: ThreeLayerMemory;

    before(() => {
      memory = new ThreeLayerMemory();
    });

    it('should store and retrieve memories by layer', () => {
      memory.add('Current context', 'working', 'session-1', 0.9);
      memory.add('Past experience', 'episodic', 'project-x', 0.7);
      memory.add('Persistent knowledge', 'longterm', 'architecture', 0.8);

      const working = memory.getByLayer('working');
      const episodic = memory.getByLayer('episodic');
      const longterm = memory.getByLayer('longterm');

      assert.strictEqual(working.length, 1);
      assert.strictEqual(episodic.length, 1);
      assert.strictEqual(longterm.length, 1);
    });

    it('should apply time decay to episodic memory', () => {
      memory.add('Experience 1', 'episodic', 'context', 0.5);
      
      // Simulate 1 hour passing with decay
      const decayed = memory.applyTimeDecay(1);
      assert.ok(decayed >= 0);
    });

    it('should promote memories to long-term', () => {
      const entry = memory.add('Important learning', 'episodic', 'context', 0.9);
      memory.promoteToLongTerm(entry.id);
      
      const retrieved = memory.get(entry.id);
      assert.strictEqual(retrieved?.layer, 'longterm');
    });

    it('should query by keywords', () => {
      memory.add('TypeScript is a typed language', 'longterm', 'coding', 0.8);
      memory.add('Python is dynamically typed', 'longterm', 'coding', 0.7);

      const results = memory.query({ keywords: ['TypeScript', 'typed'] });
      assert.ok(results.length > 0);
    });

    it('should get working context', () => {
      memory.add('Current task', 'working', 'context', 0.9);
      memory.add('Recent work', 'episodic', 'context', 0.8);
      memory.add('Old knowledge', 'longterm', 'context', 0.7);

      const context = memory.getWorkingContext(5);
      assert.ok(context.length > 0);
    });
  });

  // ========================================
  // Test 4: Reflection Engine
  // ========================================
  
  describe('ReflectionEngine', () => {
    let engine: ReflectionEngine;

    before(() => {
      engine = createReflectionEngine();
    });

    it('should create and complete reflection sessions', () => {
      const sessionId = engine.startSession('task-1');
      engine.addReflection(sessionId, 'post_execution', 'How did the task go?', 'It succeeded well');
      engine.completeSession(sessionId, 'success');

      const session = engine.getSession(sessionId);
      assert.ok(session !== undefined);
      assert.strictEqual(session?.reflections.length, 1);
      assert.ok(session?.overallQuality > 0);
    });

    it('should detect patterns', () => {
      const sessionId = engine.startSession('task-error');
      engine.addReflection(sessionId, 'error_analysis', 'What went wrong?', 'Timeout error occurred');
      engine.addReflection(sessionId, 'error_analysis', 'What went wrong?', 'Timeout error again');
      
      const stats = engine.getStats();
      assert.ok(stats.patternCount > 0);
    });

    it('should generate recommendations', () => {
      const sessionId = engine.startSession('task-improve');
      engine.addReflection(
        sessionId, 
        'post_execution', 
        'What could be improved?', 
        'Should add retry logic for network calls'
      );

      const recommendations = engine.getRecommendations();
      assert.ok(recommendations.length > 0);
    });

    it('should track improvement trend', () => {
      for (let i = 0; i < 12; i++) {
        const sessionId = engine.startSession(`task-${i}`);
        const quality = 0.5 + (i * 0.03); // Improving
        engine.addReflection(sessionId, 'post_execution', 'Quality?', `Quality score: ${quality}`);
        engine.completeSession(sessionId, 'success');
      }

      const stats = engine.getStats();
      assert.strictEqual(stats.improvementTrend, 'improving');
    });
  });

  // ========================================
  // Test 5: Consensus Checker
  // ========================================
  
  describe('ConsensusChecker', () => {
    let checker: ConsensusChecker;

    before(() => {
      checker = createConsensusChecker({ minVoters: 3 });
    });

    it('should reach consensus with similar decisions', () => {
      const checkId = checker.createCheck('What is the best approach?');
      
      checker.addVote(checkId, 'model-1', 'Model A', 'Use Option A', 0.9, 'More efficient');
      checker.addVote(checkId, 'model-2', 'Model B', 'Use Option A', 0.85, 'Good performance');
      checker.addVote(checkId, 'model-3', 'Model C', 'Use Option A', 0.88, 'Reliable');

      const result = checker.getResult(checkId);
      assert.strictEqual(result?.consensusLevel, 'unanimous');
      assert.strictEqual(result?.actionType, 'proceed');
    });

    it('should detect disagreements', () => {
      const checkId = checker.createCheck('Which is better?');
      
      checker.addVote(checkId, 'model-1', 'Model A', 'Use Option A', 0.9, 'Better performance');
      checker.addVote(checkId, 'model-2', 'Model B', 'Use Option B', 0.85, 'More reliable');
      checker.addVote(checkId, 'model-3', 'Model C', 'Use Option C', 0.88, 'Simpler');

      const result = checker.getResult(checkId);
      assert.ok(['moderate', 'low', 'diverged'].includes(result?.consensusLevel));
    });

    it('should require discussion for low consensus', () => {
      const checkId = checker.createCheck('Complex decision?');
      
      checker.addVote(checkId, 'model-1', 'Model A', 'Yes', 0.6, 'Possible');
      checker.addVote(checkId, 'model-2', 'Model B', 'No', 0.65, 'Risky');
      checker.addVote(checkId, 'model-3', 'Model C', 'Maybe', 0.5, 'Uncertain');

      const check = checker.getCheck(checkId);
      assert.strictEqual(check?.requiresDiscussion, true);
    });
  });

  // ========================================
  // Test 6: Inspector Agent
  // ========================================
  
  describe('InspectorAgent', () => {
    let inspector: InspectorAgent;

    before(() => {
      inspector = createInspector();
    });

    it('should detect issues from metrics', () => {
      const issues = inspector.autoDetect('api-service', {
        responseTime: 5000,
        errorRate: 0.15,
        memoryUsage: 0.92
      });

      assert.ok(issues.length > 0);
      assert.strictEqual(issues.some(i => i.category === 'performance'), true);
      assert.strictEqual(issues.some(i => i.category === 'reliability'), true);
    });

    it('should generate inspection report', () => {
      inspector.updateComponent('db-service', 'healthy', 0.95, { latency: 10 });
      inspector.updateComponent('cache-service', 'degraded', 0.6, { hitRate: 0.7 });

      inspector.autoDetect('api-service', { responseTime: 2000 });

      const report = inspector.inspect();
      
      assert.strictEqual(report.components.length, 2);
      assert.strictEqual(report.openIssues.length, 1);
      assert.strictEqual(report.overallStatus, 'degraded');
    });

    it('should track health trend', () => {
      // Simulate degrading then improving health
      inspector.updateComponent('service', 'degraded', 0.55, {});
      inspector.inspect();

      inspector.updateComponent('service', 'healthy', 0.85, {});
      inspector.inspect();

      inspector.updateComponent('service', 'healthy', 0.9, {});
      const report = inspector.inspect();

      const trend = inspector.getHealthTrend();
      assert.ok(['improving', 'stable'].includes(trend.trend));
    });

    it('should resolve issues', () => {
      const issues = inspector.autoDetect('service', { errorRate: 0.3 });
      const issueId = issues[0].id;

      inspector.resolveIssue(issueId);
      
      const open = inspector.getOpenIssues();
      assert.strictEqual(open.some(i => i.id === issueId), false);
    });
  });

  // ========================================
  // Test 7: End-to-End Workflow
  // ========================================
  
  describe('Full Workflow Integration', () => {
    it('should complete a task through all phases', () => {
      // Phase 1: Analyze complexity
      const analyzer = new TaskComplexityAnalyzer();
      const task = { id: 'e2e-1', description: 'Build and test a new feature', riskLevel: 'medium' };
      const complexity = analyzer.analyze(task);

      // Phase 2: Allocate budget
      const allocator = new TokenBudgetAllocator({ baseBudget: 50000 });
      const budget = allocator.allocate(complexity.recommendedMode, complexity.score, 2);

      // Phase 3: Create plan
      const orchestrator = new AdaptiveOrchestrator();
      const plan = orchestrator.createPlan(
        [{ ...task, complexity: complexity.score, priority: 'medium' as const }],
        complexity.recommendedMode
      );

      // Phase 4: Store in memory
      const memory = new ThreeLayerMemory();
      memory.add(`Executing task ${task.id}`, 'working', task.id, 0.8);
      memory.add(`Plan: ${plan.mode} mode`, 'working', task.id, 0.9);

      // Phase 5: Reflect
      const engine = new ReflectionEngine();
      const sessionId = engine.startSession(task.id);
      engine.addReflection(sessionId, 'post_execution', 'Task result?', 'Completed successfully');
      engine.completeSession(sessionId, 'success');

      // Phase 6: Consensus if needed
      const checker = new ConsensusChecker({ minVoters: 2 });
      if (complexity.score > 70) {
        const checkId = checker.createCheck('High complexity decision');
        checker.addVote(checkId, 'model-1', 'Model A', 'Proceed', 0.9, 'Looks good');
        checker.addVote(checkId, 'model-2', 'Model B', 'Proceed', 0.85, 'Agreed');
      }

      // Phase 7: Inspect
      const inspector = new InspectorAgent();
      inspector.updateComponent('orchestrator', 'healthy', 0.9, { tasksCompleted: 1 });
      const report = inspector.inspect();

      // Verify all phases completed
      assert.ok(complexity.score > 0);
      assert.ok(budget.total > 0);
      assert.ok(plan.id !== undefined);
      assert.ok(memory.getByLayer('working').length > 0);
      assert.strictEqual(engine.getStats().totalSessions, 1);
      assert.ok(report.overallHealth > 0);
    });
  });
});