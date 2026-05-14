/**
 * End-to-End Test
 * Phase 4: 端到端测试 - 真实用户场景测试
 * 
 * 测试所有框架组件的完整协作
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import {
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
  InspectorAgent,
  getGlobalLogger,
  getGlobalMetrics,
} from '../src/index';
import type { OrchestrationMode } from '../src/adaptiveOrchestrator';

// ========================================
// Test Scenario: Build a Distributed Logging System
// ========================================

describe('Commander Framework - End-to-End Tests', () => {
  let orchestrator: AdaptiveOrchestrator;
  let budgetAllocator: TokenBudgetAllocator;
  let memory: ThreeLayerMemory;
  let reflection: ReflectionEngine;
  let consensus: ConsensusChecker;
  let inspector: InspectorAgent;

  before(() => {
    orchestrator = new AdaptiveOrchestrator();
    budgetAllocator = new TokenBudgetAllocator({ baseBudget: 100000 });
    memory = new ThreeLayerMemory();
    reflection = new ReflectionEngine();
    consensus = new ConsensusChecker({ minVoters: 3 });
    inspector = new InspectorAgent();
  });

  // ========================================
  // Scenario 1: Simple Task Execution
  // ========================================
  
  describe('Scenario 1: Simple Task (SEQUENTIAL mode)', () => {
    it('executes a simple task through the complete workflow', () => {
      // Step 1: Register agents
      orchestrator.registerAgent({
        id: 'lead-1',
        name: 'Lead Agent',
        role: 'architect',
        capabilities: ['design', 'code-review'],
      });
      
      assert.strictEqual(orchestrator.getAgents().length, 1);

      // Step 2: Create tasks
      const tasks = [{
        id: 'task-1',
        description: 'Create a simple hello world function',
        priority: 'low' as const,
        complexity: 20,
        dependencies: [],
        retryCount: 0,
        maxRetries: 3,
      }];

      // Step 3: Create plan
      const plan = orchestrator.createPlan(tasks, 'SEQUENTIAL');
      assert.strictEqual(plan.mode, 'SEQUENTIAL');
      assert.strictEqual(plan.tasks.length, 1);

      // Step 4: Allocate budget
      budgetAllocator.initialize(50000);
      const budget = budgetAllocator.allocate('SEQUENTIAL', 20);
      assert.ok(budget.total > 0);

      // Step 5: Record to memory
      const memoryEntry = memory.add(
        'Starting task: hello world function',
        'working',
        'task-1',
        0.8
      );
      assert.ok(memoryEntry.id !== undefined);

      // Step 6: Run reflection
      const sessionId = reflection.startSession('task-1');
      reflection.addReflection(
        sessionId,
        'post_execution',
        'How did the implementation go?',
        'Completed successfully'
      );
      reflection.completeSession(sessionId, 'success');

      const stats = reflection.getStats();
      assert.strictEqual(stats.totalSessions, 1);

      console.log('✓ Scenario 1: Simple task completed successfully');
    });
  });

  // ========================================
  // Scenario 2: Complex Task with Multiple Agents
  // ========================================
  
  describe('Scenario 2: Complex Task (PARALLEL mode)', () => {
    it('executes a complex task with multiple agents', () => {
      // Step 1: Register multiple agents
      orchestrator.registerAgent({
        id: 'lead-1',
        name: 'Lead Agent',
        role: 'architect',
        capabilities: ['design', 'code-review'],
      });
      orchestrator.registerAgent({
        id: 'spec-1',
        name: 'Backend Specialist',
        role: 'backend',
        capabilities: ['nodejs', 'database'],
      });
      orchestrator.registerAgent({
        id: 'spec-2',
        name: 'Frontend Specialist',
        role: 'frontend',
        capabilities: ['react', 'typescript'],
      });

      assert.strictEqual(orchestrator.getAgents().length, 3);

      // Step 2: Create complex task
      const tasks = [
        {
          id: 'task-1',
          description: 'Design database schema',
          priority: 'high' as const,
          complexity: 40,
          dependencies: [],
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'task-2',
          description: 'Implement API endpoints',
          priority: 'high' as const,
          complexity: 50,
          dependencies: ['task-1'],
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'task-3',
          description: 'Build frontend UI',
          priority: 'medium' as const,
          complexity: 45,
          dependencies: [],
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      // Step 3: Create plan
      const plan = orchestrator.createPlan(tasks, 'PARALLEL');
      assert.strictEqual(plan.tasks.length, 3);

      // Step 4: Allocate budget
      budgetAllocator.initialize(100000);
      const budget = budgetAllocator.allocate('PARALLEL', 50, 3);
      assert.ok(budget.total > 50000);

      // Step 5: Add to memory
      memory.add('Starting distributed logging system project', 'working', 'project-1', 0.9);
      memory.add('Database design completed', 'episodic', 'project-1', 0.8);
      memory.add('API implementation started', 'episodic', 'project-1', 0.7);

      // Step 6: Update health
      inspector.updateComponent('orchestrator', 'healthy', 0.9);
      inspector.updateComponent('memory', 'healthy', 0.85);
      inspector.updateComponent('budget', 'healthy', 0.9);

      // Step 7: Run inspection
      const report = inspector.inspect();
      assert.ok(report.overallHealth > 0.8);

      console.log('✓ Scenario 2: Complex task completed successfully');
    });
  });

  // ========================================
  // Scenario 3: Consensus for High-Risk Decision
  // ========================================
  
  describe('Scenario 3: Consensus Check', () => {
    it('reaches consensus on a technology decision', () => {
      // Step 1: Create consensus check
      const checkId = consensus.createCheck(
        'Which technology stack is best for the distributed logging system?'
      );

      // Step 2: Add votes from different models
      consensus.addVote(
        checkId,
        'model-a',
        'GPT-4',
        'Kafka + Elasticsearch + Grafana',
        0.9,
        'Industry standard for logging'
      );
      consensus.addVote(
        checkId,
        'model-b',
        'Claude',
        'Kafka + Elasticsearch + Grafana',
        0.85,
        'Scalable and proven'
      );
      consensus.addVote(
        checkId,
        'model-c',
        'Gemini',
        'Redis + Loki + Grafana',
        0.75,
        'Simpler to operate'
      );

      // Step 3: Get result
      const result = consensus.getResult(checkId);
      assert.ok(result !== undefined);
      assert.ok(result?.consensusLevel !== undefined);

      console.log(`Consensus reached: ${result?.consensusLevel} (${result?.consensusScore})`);
      console.log('✓ Scenario 3: Consensus check completed successfully');
    });
  });

  // ========================================
  // Scenario 4: Memory Layer Operations
  // ========================================
  
  describe('Scenario 4: Memory Layer Operations', () => {
    it('manages memory across all layers', () => {
      // Add to different layers
      const workingEntry = memory.add('Current task context', 'working', 'task-1', 0.9);
      const episodicEntry = memory.add('Previous implementation experience', 'episodic', 'task-1', 0.7);
      const longtermEntry = memory.add('Architecture best practices', 'longterm', 'project-1', 0.6);

      assert.strictEqual(workingEntry.layer, 'working');
      assert.strictEqual(episodicEntry.layer, 'episodic');
      assert.strictEqual(longtermEntry.layer, 'longterm');

      // Query memory
      const queryResults = memory.query({ keywords: ['context'], limit: 10 });
      assert.ok(queryResults.length > 0);

      // Get working context
      const workingContext = memory.getWorkingContext(5);
      assert.ok(workingContext.length > 0);

      // Get stats
      const stats = memory.getStats();
      assert.strictEqual(stats.totalEntries, 3);
      assert.strictEqual(stats.byLayer.working, 1);
      assert.strictEqual(stats.byLayer.episodic, 1);
      assert.strictEqual(stats.byLayer.longterm, 1);

      console.log('✓ Scenario 4: Memory operations completed successfully');
    });
  });

  // ========================================
  // Scenario 5: Reflection and Learning
  // ========================================
  
  describe('Scenario 5: Reflection and Learning', () => {
    it('performs reflection and detects patterns', () => {
      // Run multiple sessions
      for (let i = 0; i < 3; i++) {
        const sessionId = reflection.startSession(`task-${i}`);
        reflection.addReflection(
          sessionId,
          'post_execution',
          `How did task ${i} go?`,
          i % 2 === 0 ? 'Success' : 'Had some issues'
        );
        reflection.completeSession(sessionId, i % 2 === 0 ? 'success' : 'partial');
      }

      // Get stats
      const stats = reflection.getStats();
      assert.strictEqual(stats.totalSessions, 3);
      assert.ok(stats.averageQuality > 0);

      console.log('✓ Scenario 5: Reflection and learning completed successfully');
    });
  });

  // ========================================
  // Scenario 6: Inspector Monitoring
  // ========================================
  
  describe('Scenario 6: Inspector Monitoring', () => {
    it('detects and reports issues', () => {
      // Update component status
      inspector.updateComponent('api', 'healthy', 0.95);
      inspector.updateComponent('database', 'healthy', 0.9);
      inspector.updateComponent('cache', 'degraded', 0.6, { hitRate: 0.5 });

      // Auto-detect issues
      const issues = inspector.autoDetect('api', {
        responseTime: 1500,
        errorRate: 0.05,
        memoryUsage: 0.85,
      });

      // Run inspection
      const report = inspector.inspect();
      assert.ok(report.overallStatus !== undefined);
      assert.ok(report.openIssues.length > 0);

      // Get stats
      const stats = inspector.getStats();
      assert.ok(stats.totalIssues > 0);

      console.log('✓ Scenario 6: Inspector monitoring completed successfully');
    });
  });

  // ========================================
  // Scenario 7: Full Workflow Integration
  // ========================================
  
  describe('Scenario 7: Full Workflow Integration', () => {
    it('completes a full workflow from planning to execution', () => {
      // 1. Register agents
      orchestrator.registerAgent({ id: 'lead', name: 'Lead', role: 'architect', capabilities: ['design'] });
      orchestrator.registerAgent({ id: 'dev1', name: 'Dev1', role: 'developer', capabilities: ['backend'] });
      orchestrator.registerAgent({ id: 'dev2', name: 'Dev2', role: 'developer', capabilities: ['frontend'] });

      // 2. Create task plan
      const tasks = [{
        id: 'sys-design',
        description: 'Design distributed logging system',
        priority: 'high' as const,
        complexity: 60,
        dependencies: [],
        retryCount: 0,
        maxRetries: 3,
      }];
      const plan = orchestrator.createPlan(tasks, 'HANDOFF');

      // 3. Allocate budget
      budgetAllocator.initialize(150000);
      const budget = budgetAllocator.allocate('HANDOFF', 60, 3);

      // 4. Record planning
      memory.add('Starting project planning', 'working', 'project-1', 0.9);

      // 5. Consensus on architecture
      const checkId = consensus.createCheck('Architecture decision');
      consensus.addVote(checkId, 'm1', 'Model A', 'Microservices', 0.9, 'Scalable');
      consensus.addVote(checkId, 'm2', 'Model B', 'Microservices', 0.85, 'Proven');
      const consensusResult = consensus.getResult(checkId);
      assert.ok(consensusResult?.consensusScore > 0.7);

      // 6. Reflection
      const sessionId = reflection.startSession('project-1');
      reflection.addReflection(sessionId, 'pre_planning', 'What is the best approach?', 'Microservices');
      reflection.addReflection(sessionId, 'post_execution', 'How did it go?', 'Successful');
      reflection.completeSession(sessionId, 'success');

      // 7. Monitor
      inspector.updateComponent('system', 'healthy', 0.9);
      const report = inspector.inspect();

      // Verify all components worked together
      const memoryStats = memory.getStats();
      assert.ok(memoryStats.totalEntries > 0);
      
      const reflectionStats = reflection.getStats();
      assert.strictEqual(reflectionStats.totalSessions, 1);

      console.log('✓ Scenario 7: Full workflow integration completed successfully');
      console.log(`   - Plan mode: ${plan.mode}`);
      console.log(`   - Budget: ${budget.total} tokens`);
      console.log(`   - Consensus: ${consensusResult?.consensusLevel}`);
      console.log(`   - System health: ${report.overallHealth}`);
    });
  });
});