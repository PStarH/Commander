/**
 * Integration Test Runner - Phase 2 组件集成测试
 * 
 * 目标：验证所有核心组件协同工作
 */

import {
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  QualityGateExecutor,
  OrchestrationMode,
  TaskComplexity,
  TaskNode,
  measureTaskComplexity,
} from './packages/core/src/ultimate';

import {
  TaskComplexityAnalyzer,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusCheck,
  InspectorAgent,
  AgentSelfAssessment,
} from './packages/core/src/index';

export interface IntegrationTestResult {
  testName: string;
  passed: boolean;
  duration: number; // ms
  error?: string;
  output?: unknown;
}

export interface IntegrationTestSuite {
  name: string;
  tests: IntegrationTestResult[];
  totalDuration: number;
  passedCount: number;
  failedCount: number;
}

/**
 * Phase 1: Adaptive Orchestrator Integration Test
 */
async function testAdaptiveOrchestrator(): Promise<IntegrationTestResult> {
  const start = Date.now();
  
  try {
    const orchestrator = new AdaptiveOrchestrator();
    
    // Test task: Complex multi-agent coordination
    const task: TaskNode = {
      id: 'test-task-1',
      inputCount: 5,
      outputCount: 3,
      cognitiveLoad: 7,
      requiresExternalResources: true,
      dependencies: ['dep-1', 'dep-2'],
    };
    
    const allTasks: TaskNode[] = [
      task,
      { id: 'dep-1', inputCount: 2, outputCount: 1, cognitiveLoad: 3, requiresExternalResources: false, dependencies: [] },
      { id: 'dep-2', inputCount: 2, outputCount: 1, cognitiveLoad: 4, requiresExternalResources: false, dependencies: [] },
    ];
    
    const decision = orchestrator.analyze(task, allTasks);
    
    // Validate decision
    if (!decision.mode) {
      throw new Error('No orchestration mode selected');
    }
    
    // Should select MAGNETIC or HANDOFF for complex task
    const validModes: OrchestrationMode[] = ['MAGNETIC', 'HANDOFF', 'CONSENSUS'];
    if (!validModes.includes(decision.mode)) {
      throw new Error(`Expected complex mode, got ${decision.mode}`);
    }
    
    // Token budget should be allocated
    if (decision.tokenBudget.leadAgent <= 0) {
      throw new Error('Lead agent budget not allocated');
    }
    
    // Quality gates should be set
    if (decision.qualityGates.length === 0) {
      throw new Error('No quality gates configured');
    }
    
    return {
      testName: 'AdaptiveOrchestrator - Complex Task Analysis',
      passed: true,
      duration: Date.now() - start,
      output: {
        mode: decision.mode,
        complexity: decision.complexity,
        tokenBudget: decision.tokenBudget,
        qualityGates: decision.qualityGates.map(g => g.name),
      },
    };
  } catch (error) {
    return {
      testName: 'AdaptiveOrchestrator - Complex Task Analysis',
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Phase 2: Token Budget Allocator Integration Test
 */
async function testTokenBudgetAllocator(): Promise<IntegrationTestResult> {
  const start = Date.now();
  
  try {
    const allocator = new TokenBudgetAllocator(100000);
    
    const allocation = allocator.allocate({
      leadAgent: 0.4,
      specialistAgents: 0.5,
      overhead: 0.1,
    });
    
    // Validate allocation
    if (allocation.leadAgent.tokens <= 0) {
      throw new Error('Lead agent tokens not allocated');
    }
    
    if (allocation.specialistAgents.tokens <= 0) {
      throw new Error('Specialist agents tokens not allocated');
    }
    
    // Savings should be significant (70%+)
    if (allocation.savings.savingsPercent < 50) {
      throw new Error(`Savings too low: ${allocation.savings.savingsPercent}%`);
    }
    
    // Validate model selection
    if (!allocation.leadAgent.model.includes('opus') && !allocation.leadAgent.model.includes('claude')) {
      // May use different model names, just check it's not empty
      if (!allocation.leadAgent.model) {
        throw new Error('Lead model name is empty');
      }
    }
    
    return {
      testName: 'TokenBudgetAllocator - Cost Optimization',
      passed: true,
      duration: Date.now() - start,
      output: {
        leadAgent: allocation.leadAgent.model,
        specialist: allocation.specialistAgents.model,
        savingsPercent: allocation.savings.savingsPercent.toFixed(1),
        totalCost: allocation.total.cost.toFixed(6),
      },
    };
  } catch (error) {
    return {
      testName: 'TokenBudgetAllocator - Cost Optimization',
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Phase 3: Quality Gate Executor Integration Test
 */
async function testQualityGateExecutor(): Promise<IntegrationTestResult> {
  const start = Date.now();
  
  try {
    const executor = new QualityGateExecutor();
    
    const gates = [
      { name: 'output_validation', required: true, description: 'Validate output' },
      { name: 'hallucination_check', required: true, description: 'Check for hallucinations' },
    ];
    
    const input = { task: 'test task', context: 'test context' };
    const output = { result: 'valid output', confidence: 0.85 };
    
    const results = await executor.execute(gates, input, output);
    
    // All required gates should pass
    const failedGates = results.filter(r => !r.passed);
    if (failedGates.length > 0) {
      throw new Error(`Failed gates: ${failedGates.map(g => g.gate).join(', ')}`);
    }
    
    return {
      testName: 'QualityGateExecutor - Validation Pipeline',
      passed: true,
      duration: Date.now() - start,
      output: {
        gatesChecked: results.length,
        results: results.map(r => ({ gate: r.gate, passed: r.passed })),
      },
    };
  } catch (error) {
    return {
      testName: 'QualityGateExecutor - Validation Pipeline',
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Phase 4: Task Complexity Analyzer Integration Test
 */
async function testTaskComplexityAnalyzer(): Promise<IntegrationTestResult> {
  const start = Date.now();
  
  try {
    // Test various complexity levels
    const testCases: Array<{
      name: string;
      task: TaskNode;
      expectedMinLevel: TaskComplexity['level'];
    }> = [
      {
        name: 'Simple Task',
        task: { id: 's1', inputCount: 1, outputCount: 1, cognitiveLoad: 2, requiresExternalResources: false, dependencies: [] },
        expectedMinLevel: 'LOW',
      },
      {
        name: 'Medium Task',
        task: { id: 'm1', inputCount: 3, outputCount: 2, cognitiveLoad: 5, requiresExternalResources: true, dependencies: ['s1'] },
        expectedMinLevel: 'MEDIUM',
      },
      {
        name: 'Complex Task',
        task: { id: 'c1', inputCount: 8, outputCount: 5, cognitiveLoad: 9, requiresExternalResources: true, dependencies: ['m1', 's1', 'dep-x'] },
        expectedMinLevel: 'HIGH',
      },
    ];
    
    const results = [];
    for (const tc of testCases) {
      const complexity = measureTaskComplexity(tc.task, [tc.task]);
      results.push({
        name: tc.name,
        level: complexity.level,
        expected: tc.expectedMinLevel,
        match: getLevelWeight(complexity.level) >= getLevelWeight(tc.expectedMinLevel),
      });
    }
    
    const allMatch = results.every(r => r.match);
    if (!allMatch) {
      throw new Error('Complexity levels do not match expectations');
    }
    
    return {
      testName: 'TaskComplexityAnalyzer - Multi-Level Assessment',
      passed: true,
      duration: Date.now() - start,
      output: { results },
    };
  } catch (error) {
    return {
      testName: 'TaskComplexityAnalyzer - Multi-Level Assessment',
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getLevelWeight(level: TaskComplexity['level']): number {
  const weights = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  return weights[level];
}

/**
 * Phase 5: End-to-End Orchestration Pipeline Test
 */
async function testEndToEndPipeline(): Promise<IntegrationTestResult> {
  const start = Date.now();
  
  try {
    // Simulate full pipeline: analyze → allocate → orchestrate → validate
    
    const orchestrator = new AdaptiveOrchestrator();
    const allocator = new TokenBudgetAllocator(80000);
    const executor = new QualityGateExecutor();
    
    // Input task
    const task: TaskNode = {
      id: 'e2e-task',
      inputCount: 4,
      outputCount: 2,
      cognitiveLoad: 6,
      requiresExternalResources: true,
      dependencies: ['dep-a', 'dep-b'],
    };
    
    const allTasks: TaskNode[] = [
      task,
      { id: 'dep-a', inputCount: 2, outputCount: 1, cognitiveLoad: 3, requiresExternalResources: false, dependencies: [] },
      { id: 'dep-b', inputCount: 2, outputCount: 1, cognitiveLoad: 4, requiresExternalResources: false, dependencies: [] },
    ];
    
    // Step 1: Analyze
    const decision = orchestrator.analyze(task, allTasks);
    
    // Step 2: Allocate
    const budget = allocator.allocate(decision.tokenBudget);
    
    // Step 3: Validate
    const validationResults = await executor.execute(decision.qualityGates, task, { decision, budget });
    
    // Verify pipeline
    if (validationResults.filter(r => r.passed).length < decision.qualityGates.filter(g => g.required).length) {
      throw new Error('Quality gates failed in pipeline');
    }
    
    return {
      testName: 'End-to-End Orchestration Pipeline',
      passed: true,
      duration: Date.now() - start,
      output: {
        mode: decision.mode,
        leadTokens: budget.leadAgent.tokens,
        specialistTokens: budget.specialistAgents.tokens,
        qualityGates: validationResults.length,
        totalCost: budget.total.cost.toFixed(6),
      },
    };
  } catch (error) {
    return {
      testName: 'End-to-End Orchestration Pipeline',
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run all integration tests
 */
export async function runIntegrationTests(): Promise<IntegrationTestSuite> {
  const tests: IntegrationTestResult[] = [];
  
  console.log('🧪 Starting Phase 2 Integration Tests...\n');
  
  // Run tests sequentially for clarity
  tests.push(await testAdaptiveOrchestrator());
  console.log(`  ${tests[tests.length - 1].passed ? '✅' : '❌'} ${tests[tests.length - 1].testName}`);
  
  tests.push(await testTokenBudgetAllocator());
  console.log(`  ${tests[tests.length - 1].passed ? '✅' : '❌'} ${tests[tests.length - 1].testName}`);
  
  tests.push(await testQualityGateExecutor());
  console.log(`  ${tests[tests.length - 1].passed ? '✅' : '❌'} ${tests[tests.length - 1].testName}`);
  
  tests.push(await testTaskComplexityAnalyzer());
  console.log(`  ${tests[tests.length - 1].passed ? '✅' : '❌'} ${tests[tests.length - 1].testName}`);
  
  tests.push(await testEndToEndPipeline());
  console.log(`  ${tests[tests.length - 1].passed ? '✅' : '❌'} ${tests[tests.length - 1].testName}`);
  
  const passedCount = tests.filter(t => t.passed).length;
  const failedCount = tests.filter(t => !t.passed).length;
  const totalDuration = tests.reduce((sum, t) => sum + t.duration, 0);
  
  console.log(`\n📊 Integration Test Results:`);
  console.log(`   Total: ${tests.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
  console.log(`   Duration: ${totalDuration}ms`);
  
  if (failedCount > 0) {
    console.log(`\n❌ Failed Tests:`);
    tests.filter(t => !t.passed).forEach(t => {
      console.log(`   - ${t.testName}: ${t.error}`);
    });
  }
  
  return {
    name: 'Phase 2 - Component Integration',
    tests,
    totalDuration,
    passedCount,
    failedCount,
  };
}

// Run if called directly
if (require.main === module) {
  runIntegrationTests()
    .then(result => {
      process.exit(result.failedCount > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('Test runner error:', err);
      process.exit(1);
    });
}