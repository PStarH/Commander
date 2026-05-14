/**
 * Commander Framework End-to-End Demo
 * Phase 2: 端到端演示
 * 
 * 演示所有组件协同工作处理一个复杂任务的全流程
 */

import {
  // Phase 1 Components
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
  OrchestrationMode,
  
  // Types
  Task,
  Agent,
  MemoryEntry
} from '../packages/core/src/index';

// ========================================
// Demo: Building a Distributed Task System
// ========================================

async function runDemo() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          Commander Framework End-to-End Demo                  ║
║  "Building a Distributed Task Management System"              ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Initialize all Phase 1 components
  const analyzer = new TaskComplexityAnalyzer();
  const orchestrator = new AdaptiveOrchestrator();
  const budgetAllocator = new TokenBudgetAllocator({ baseBudget: 100000 });
  const memory = new ThreeLayerMemory();
  const reflectionEngine = createReflectionEngine();
  const consensusChecker = createConsensusChecker({ minVoters: 3 });
  const inspector = createInspector();

  // Register agents
  const agentIds = [
    orchestrator.registerAgent({ id: 'orchestrator-lead', name: 'Lead Agent', role: 'lead', capabilities: ['planning', 'coordination'] }),
    orchestrator.registerAgent({ id: 'orchestrator-worker-1', name: 'Worker Agent 1', role: 'worker', capabilities: ['coding', 'testing'] }),
    orchestrator.registerAgent({ id: 'orchestrator-worker-2', name: 'Worker Agent 2', role: 'worker', capabilities: ['coding', 'review'] }),
  ];

  console.log('📋 Step 1: Analyzing Task Complexity');
  console.log('─'.repeat(60));

  // Complex task description
  const taskDescription = `
    Build a distributed task management system with the following requirements:
    1. Multi-tenant architecture with role-based access control
    2. Real-time task synchronization across nodes using WebSocket
    3. Persistent storage with PostgreSQL and Redis caching
    4. Comprehensive API documentation with OpenAPI spec
    5. End-to-end tests with 90% code coverage
    6. Docker containerization with Kubernetes manifests
    7. CI/CD pipeline with automated deployment
  `;

  const task: Task = {
    id: 'demo-task-1',
    description: taskDescription,
    priority: 'high',
    riskLevel: 'high',
    complexity: 0 // Will be calculated
  };

  // Analyze complexity
  const complexityResult = analyzer.analyze(task);
  console.log(`Task: Build Distributed Task Management System`);
  console.log(`Complexity Score: ${complexityResult.score}/100`);
  console.log(`Complexity Level: ${complexityResult.level}`);
  console.log(`Recommended Mode: ${complexityResult.recommendedMode}`);
  console.log(`Confidence: ${(complexityResult.confidence * 100).toFixed(1)}%`);
  console.log('');

  // Store in memory
  memory.add(`Analyzing task: ${task.description.substring(0, 50)}...`, 'working', task.id, 0.9);
  memory.add(`Complexity: ${complexityResult.level} (score: ${complexityResult.score})`, 'working', task.id, 0.85);

  console.log('💰 Step 2: Allocating Token Budget');
  console.log('─'.repeat(60));

  // Allocate budget based on complexity and mode
  const budget = budgetAllocator.allocate(
    complexityResult.recommendedMode,
    complexityResult.score,
    agentIds.length
  );

  console.log(`Mode: ${complexityResult.recommendedMode}`);
  console.log(`Total Budget: ${budget.total.toLocaleString()} tokens`);
  console.log(`├── Lead Agent: ${budget.leadAgent.toLocaleString()} (${(budget.leadAgent / budget.total * 100).toFixed(1)}%)`);
  console.log(`├── Specialists: ${budget.specialistAgents.toLocaleString()} (${(budget.specialistAgents / budget.total * 100).toFixed(1)}%)`);
  console.log(`├── Evaluation: ${budget.evaluation.toLocaleString()} (${(budget.evaluation / budget.total * 100).toFixed(1)}%)`);
  console.log(`└── Overhead: ${budget.overhead.toLocaleString()} (${(budget.overhead / budget.total * 100).toFixed(1)}%)`);
  console.log('');

  // Simulate usage
  budgetAllocator.recordUsage('lead', budget.leadAgent * 0.3, 'execution');
  budgetAllocator.recordUsage('specialist-0', budget.specialistAgents * 0.25, 'execution');

  console.log('📊 Step 3: Creating Orchestration Plan');
  console.log('─'.repeat(60));

  // Create tasks for the complex project
  const subTasks: Task[] = [
    { id: 'sub-1', description: 'Design multi-tenant database schema', priority: 'high', complexity: 65, dependencies: [], status: 'pending', retryCount: 0, maxRetries: 3 },
    { id: 'sub-2', description: 'Implement WebSocket real-time sync', priority: 'high', complexity: 75, dependencies: ['sub-1'], status: 'pending', retryCount: 0, maxRetries: 3 },
    { id: 'sub-3', description: 'Set up Redis caching layer', priority: 'medium', complexity: 55, dependencies: ['sub-1'], status: 'pending', retryCount: 0, maxRetries: 3 },
    { id: 'sub-4', description: 'Create OpenAPI documentation', priority: 'medium', complexity: 40, dependencies: ['sub-2'], status: 'pending', retryCount: 0, maxRetries: 3 },
    { id: 'sub-5', description: 'Write E2E tests', priority: 'high', complexity: 60, dependencies: ['sub-2', 'sub-3'], status: 'pending', retryCount: 0, maxRetries: 3 },
  ];

  const plan = orchestrator.createPlan(subTasks, complexityResult.recommendedMode);
  
  console.log(`Plan ID: ${plan.id}`);
  console.log(`Orchestration Mode: ${plan.mode}`);
  console.log(`Tasks: ${plan.tasks.length}`);
  console.log(`Agents: ${plan.agents.length}`);
  console.log(`Max Concurrent: ${plan.resourceAllocation.maxConcurrent}`);
  console.log(`Estimated Duration: ${plan.estimatedDuration}s`);
  console.log('');

  console.log('🧠 Step 4: Memory Context');
  console.log('─'.repeat(60));

  // Add tasks to memory
  subTasks.forEach(t => {
    memory.add(`Task: ${t.description}`, 'working', t.id, t.priority === 'high' ? 0.9 : 0.7);
  });

  // Simulate completed work stored in episodic memory
  memory.add('Completed: Database schema design patterns', 'episodic', 'past-project', 0.8);
  memory.archiveToEpisodic(memory.add('Completed: WebSocket implementation', 'working', 'current', 0.9).id);

  const stats = memory.getStats();
  console.log(`Total Memories: ${stats.totalEntries}`);
  console.log(`├── Working: ${stats.byLayer.working}`);
  console.log(`├── Episodic: ${stats.byLayer.episodic}`);
  console.log(`└── Long-term: ${stats.byLayer.longterm}`);
  console.log('');

  console.log('🤔 Step 5: Reflection Session');
  console.log('─'.repeat(60));

  // Start reflection session
  const reflectionSessionId = reflectionEngine.startSession(task.id);
  
  reflectionEngine.addReflection(
    reflectionSessionId,
    'pre_planning',
    'What is the optimal architecture approach?',
    'Microservices architecture with API Gateway for better scalability'
  );

  reflectionEngine.addReflection(
    reflectionSessionId,
    'post_execution',
    'What worked well in the database design?',
    'Using UUIDs for tenant isolation worked better than expected. Query performance is 40% better than our baseline.'
  );

  reflectionEngine.addReflection(
    reflectionSessionId,
    'error_analysis',
    'What issues were encountered?',
    'Redis connection pooling needed tuning. Default settings caused connection exhaustion under load.'
  );

  reflectionEngine.completeSession(reflectionSessionId, 'success');

  const reflectionStats = reflectionEngine.getStats();
  console.log(`Session ID: ${reflectionSessionId}`);
  console.log(`Reflections: ${reflectionStats.totalSessions}`);
  console.log(`Average Quality: ${(reflectionStats.averageQuality * 100).toFixed(1)}%`);
  console.log(`Patterns Detected: ${reflectionStats.patternCount}`);
  console.log(`Trend: ${reflectionStats.improvementTrend}`);
  console.log('');

  console.log('🗳️ Step 6: Consensus Check (Critical Decision)');
  console.log('─'.repeat(60));

  // Critical decision: Which database to use?
  const consensusId = consensusChecker.createCheck(
    'Should we use PostgreSQL or MongoDB for the multi-tenant data store?',
    'PostgreSQL offers better consistency, MongoDB offers better horizontal scaling'
  );

  consensusChecker.addVote(
    consensusId,
    'model-gpt4',
    'GPT-4',
    'PostgreSQL with row-level security',
    0.92,
    'Better ACID guarantees and mature ecosystem'
  );

  consensusChecker.addVote(
    consensusId,
    'model-claude',
    'Claude',
    'PostgreSQL with row-level security',
    0.89,
    'Consistent performance and strong typing'
  );

  consensusChecker.addVote(
    consensusId,
    'model-gemini',
    'Gemini',
    'PostgreSQL',
    0.85,
    'Mature tooling and excellent documentation'
  );

  consensusChecker.completeCheck(consensusId);
  const consensusResult = consensusChecker.getResult(consensusId);

  console.log(`Decision: ${consensusResult?.decision}`);
  console.log(`Consensus Level: ${consensusResult?.consensusLevel}`);
  console.log(`Consensus Score: ${((consensusResult?.consensusScore || 0) * 100).toFixed(1)}%`);
  console.log(`Action: ${consensusResult?.actionType}`);
  console.log('');

  console.log('🔍 Step 7: System Inspection');
  console.log('─'.repeat(60));

  // Update component health
  inspector.updateComponent('analyzer', 'healthy', 0.95, { tasksAnalyzed: 10 });
  inspector.updateComponent('orchestrator', 'healthy', 0.88, { plansCreated: 5, tasksCompleted: 12 });
  inspector.updateComponent('memory', 'healthy', 0.92, { entries: stats.totalEntries });
  inspector.updateComponent('reflection', 'healthy', 0.85, { sessions: reflectionStats.totalSessions });
  inspector.updateComponent('consensus', 'healthy', 0.91, { checks: 3 });

  // Auto-detect any issues
  const detectedIssues = inspector.autoDetect('orchestrator', {
    responseTime: 850,
    errorRate: 0.03,
    queueDepth: 45,
    successRate: 0.94
  });

  detectedIssues.forEach(issue => {
    console.log(`⚠️  Detected: [${issue.severity}] ${issue.title}`);
    if (issue.suggestions.length > 0) {
      console.log(`   Suggestion: ${issue.suggestions[0]}`);
    }
  });

  const inspectionReport = inspector.inspect();
  
  console.log('');
  console.log(`Overall Health: ${(inspectionReport.overallHealth * 100).toFixed(1)}%`);
  console.log(`System Status: ${inspectionReport.overallStatus.toUpperCase()}`);
  console.log(`Open Issues: ${inspectionReport.openIssues.length}`);
  console.log(`Components: ${inspectionReport.components.length}`);
  console.log('');

  console.log('📈 Step 8: Final Metrics Dashboard');
  console.log('─'.repeat(60));

  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                    COMMANDER FRAMEWORK                       │
│                    System Metrics                             │
├─────────────────────────────────────────────────────────────┤
│  Task Complexity Analyzer                                    │
│  ├── Score: ${complexityResult.score}/100                              │
│  ├── Level: ${complexityResult.level.padEnd(25)}                    │
│  └── Mode: ${complexityResult.recommendedMode.padEnd(25)}            │
├─────────────────────────────────────────────────────────────┤
│  Token Budget                                                │
│  ├── Total: ${budget.total.toLocaleString().padStart(10)} tokens                       │
│  ├── Used: ${((budgetAllocator.getUsageRate()) * 100).toFixed(1)}%                                     │
│  └── Remaining: ${budgetAllocator.getRemaining().toLocaleString()}                           │
├─────────────────────────────────────────────────────────────┤
│  Three-Layer Memory                                          │
│  ├── Working: ${stats.byLayer.working.toString().padStart(3)} entries                           │
│  ├── Episodic: ${stats.byLayer.episodic.toString().padStart(3)} entries                          │
│  └── Long-term: ${stats.byLayer.longterm.toString().padStart(3)} entries                         │
├─────────────────────────────────────────────────────────────┤
│  Reflection Engine                                           │
│  ├── Sessions: ${reflectionStats.totalSessions.toString().padStart(3)}                                 │
│  ├── Quality: ${(reflectionStats.averageQuality * 100).toFixed(1)}%                                    │
│  └── Trend: ${reflectionStats.improvementTrend.padEnd(25)}         │
├─────────────────────────────────────────────────────────────┤
│  Consensus Checker                                           │
│  ├── Level: ${consensusResult?.consensusLevel.padEnd(25)}          │
│  ├── Score: ${((consensusResult?.consensusScore || 0) * 100).toFixed(1)}%                                    │
│  └── Decision: Proceed                                       │
├─────────────────────────────────────────────────────────────┤
│  Inspector Agent                                             │
│  ├── Health: ${(inspectionReport.overallHealth * 100).toFixed(1)}%                                    │
│  ├── Status: ${inspectionReport.overallStatus.toUpperCase().padEnd(25)}   │
│  └── Issues: ${inspectionReport.openIssues.length.toString().padStart(3)} open                                  │
└─────────────────────────────────────────────────────────────┘
`);

  console.log('✅ End-to-End Demo Completed Successfully!\n');
  
  return {
    complexityResult,
    budget,
    plan,
    memoryStats: stats,
    reflectionStats,
    consensusResult,
    inspectionReport
  };
}

// Run the demo
if (require.main === module) {
  runDemo().catch(console.error);
}

export { runDemo };