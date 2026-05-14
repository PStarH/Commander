# Commander Ultimate Framework - API Reference

## Overview

Commander is a multi-agent orchestration framework with 7 core components:

| Component | Size | Purpose |
|-----------|------|---------|
| Task Complexity Analyzer | 14.1KB | Analyzes task complexity and selects orchestration mode |
| Adaptive Orchestrator | 16.2KB | Manages agent coordination and task execution |
| Token Budget Allocator | 9.9KB | Allocates and tracks token budgets |
| Three-Layer Memory | 9.6KB | Manages working, episodic, and long-term memory |
| Reflection Engine | 13.2KB | Self-reflection and pattern detection |
| Consensus Checker | 11.3KB | Multi-model consensus for high-risk decisions |
| Inspector Agent | 13.6KB | System health monitoring and issue detection |

---

## Task Complexity Analyzer

### Types

```typescript
type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'extreme';

type OrchestrationMode = 'SEQUENTIAL' | 'PARALLEL' | 'HANDOFF' | 'MAGENTIC' | 'CONSENSUS';

interface ComplexityScore {
  level: ComplexityLevel;
  score: number;           // 0-100
  factors: ComplexityFactors;
  recommendedMode: OrchestrationMode;
  tokenBudget: TokenBudget;
  confidence: number;      // 0-1
}

interface ComplexityFactors {
  treewidth: number;       // Dependency complexity (0-100)
  dependencyDepth: number; // How deep dependencies go (0-100)
  inputSize: number;       // Token count of input
  outputComplexity: number;// Expected output structure (0-100)
  domainKnowledge: number; // Need for specialized knowledge (0-100)
  riskLevel: number;       // Failure impact (0-100)
  uncertaintyLevel: number;// Ambiguity in requirements (0-100)
  timeConstraints: number; // Deadline pressure (0-100)
}

interface Task {
  id: string;
  description: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  priority?: 'low' | 'medium' | 'high' | 'critical';
}
```

### API

```typescript
// Create analyzer
const analyzer = new TaskComplexityAnalyzer();

// Analyze task complexity
const score = analyzer.analyze(task: Task): ComplexityScore;

// Batch analyze
const batchAnalyzer = new BatchComplexityAnalyzer();
const scores = batchAnalyzer.analyzeBatch(tasks: Task[]): ComplexityScore[];

// Get batch orchestration recommendation
const orch = batchAnalyzer.getBatchOrchestration(scores): {
  mode: OrchestrationMode;
  totalBudget: number;
  parallelGroups: number;
};
```

### Mode Selection Rules

| Condition | Mode |
|-----------|------|
| Complexity > 80 | CONSENSUS |
| Complexity > 60 + no dependencies | MAGENTIC |
| Complexity > 50 | HANDOFF |
| Has dependencies + complexity > 30 | HANDOFF |
| No dependencies + complexity < 30 | PARALLEL |
| Default | SEQUENTIAL |

---

## Adaptive Orchestrator

### Types

```typescript
interface Agent {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  load: number;         // 0-1
  successRate: number;  // 0-1
  isAvailable: boolean;
}

interface Task {
  id: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  complexity: number;   // 0-100
  dependencies: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

interface OrchestrationPlan {
  id: string;
  mode: OrchestrationMode;
  tasks: Task[];
  agents: Agent[];
  resourceAllocation: ResourceAllocation;
  estimatedDuration: number;
}

interface ResourceAllocation {
  leadAgentId?: string;
  specialistAgentIds: string[];
  maxConcurrent: number;
  tokenBudget: {
    lead: number;
    specialists: number;
    evaluation: number;
    overhead: number;
  };
}
```

### API

```typescript
// Create orchestrator
const orchestrator = new AdaptiveOrchestrator();

// Register agents
const agentId = orchestrator.registerAgent(agent: Omit<Agent, 'load' | 'successRate' | 'isAvailable'>): string;

// Create plan
const plan = orchestrator.createPlan(tasks: Task[], suggestedMode?: OrchestrationMode): OrchestrationPlan;

// Execute plan (async)
const results = await orchestrator.execute(plan): Map<string, Task>;

// Get metrics
const metrics = orchestrator.getMetrics(): ExecutionMetrics;

// Get current mode
const mode = orchestrator.getCurrentMode(): OrchestrationMode;

// Get agents and tasks
const agents = orchestrator.getAgents(): Agent[];
const tasks = orchestrator.getTasks(): Task[];

// Adapt plan based on metrics
const adaptedPlan = orchestrator.adapt(plan: OrchestrationPlan): OrchestrationPlan;
```

---

## Token Budget Allocator

### Types

```typescript
interface TokenBudget {
  total: number;
  leadAgent: number;
  specialistAgents: number;
  evaluation: number;
  overhead: number;
  reserved: number;
}

interface BudgetAllocation {
  phase: 'planning' | 'execution' | 'evaluation' | 'reporting';
  allocated: number;
  used: number;
  remaining: number;
  efficiency: number;
}

interface BudgetConfig {
  baseBudget: number;
  maxBudget: number;
  efficiencyTarget: number;
  reserveRatio: number;
  warnThreshold: number;   // Default: 0.8
  cutoffThreshold: number; // Default: 0.95
}
```

### API

```typescript
// Create allocator (optional config)
const allocator = new TokenBudgetAllocator(config?: Partial<BudgetConfig>);

// Initialize budget
allocator.initialize(totalBudget: number): void;

// Allocate budget based on mode and complexity
const budget = allocator.allocate(mode: OrchestrationMode, complexity: number, agentCount: number): TokenBudget;

// Record usage
allocator.recordUsage(agentId: string, tokens: number, phase?: string): void;

// Get remaining budget
const remaining = allocator.getRemaining(): number;

// Get usage rate
const usageRate = allocator.getUsageRate(): number;

// Check thresholds
allocator.isWarningThreshold(): boolean;  // ≥80%
allocator.isCutoffThreshold(): boolean;    // ≥95%

// Get agent remaining
allocator.getAgentRemaining(agentId: string): number;

// Get warnings
allocator.getWarnings(): string[];

// Get efficiency analysis
allocator.getEfficiencyAnalysis(): {
  overall: number;
  byPhase: Record<string, number>;
  trend: 'improving' | 'declining' | 'stable';
  recommendations: string[];
};

// Get snapshot
allocator.getSnapshot(): BudgetSnapshot;

// Global allocator
const global = getGlobalBudgetAllocator();
```

### Allocation by Mode

| Mode | Lead | Specialists | Evaluation | Overhead |
|------|------|-------------|------------|----------|
| SEQUENTIAL | 70% | 10% | 15% | 5% |
| PARALLEL | 25% | 55% | 15% | 5% |
| HANDOFF | 35% | 45% | 15% | 5% |
| MAGENTIC | 30% | 40% | 15% | 15% |
| CONSENSUS | 25% | 30% | 40% | 5% |

---

## Three-Layer Memory

### Types

```typescript
type MemoryLayer = 'working' | 'episodic' | 'longterm';

interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  context: string;
  importance: number;      // 0-1
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  decayScore: number;      // For episodic layer
  tags: string[];
  metadata: Record<string, any>;
}

interface MemoryQuery {
  layer?: MemoryLayer;
  keywords?: string[];
  context?: string;
  importanceThreshold?: number;
  limit?: number;
  since?: string;
}

interface MemoryStats {
  totalEntries: number;
  byLayer: Record<MemoryLayer, number>;
  averageImportance: number;
  averageAccessCount: number;
  totalMemoryUsed: number;
}
```

### API

```typescript
// Create memory (optional config)
const memory = new ThreeLayerMemory(config?: Partial<Record<MemoryLayer, LayerConfig>>);

// Add memory
const entry = memory.add(
  content: string,
  layer: MemoryLayer,
  context?: string,
  importance?: number,  // Default: 0.5
  tags?: string[],
  metadata?: Record<string, any>
): MemoryEntry;

// Get memory
memory.get(id: string): MemoryEntry | undefined;

// Query memories
memory.query(query: MemoryQuery): MemoryEntry[];

// Get by layer
memory.getByLayer(layer: MemoryLayer, limit?: number): MemoryEntry[];

// Get working context
memory.getWorkingContext(maxEntries?: number): MemoryEntry[];

// Delete memory
memory.delete(id: string): boolean;

// Promote to long-term
memory.promoteToLongTerm(id: string): boolean;

// Archive to episodic
memory.archiveToEpisodic(id: string): boolean;

// Apply time decay (for episodic layer)
memory.applyTimeDecay(hoursElapsed: number): number;

// Get statistics
memory.getStats(): MemoryStats;

// Search related
memory.searchRelated(content: string, limit?: number): MemoryEntry[];

// Clear layer
memory.clearLayer(layer: MemoryLayer): number;

// Global memory
const global = getGlobalThreeLayerMemory();
```

### Layer Configuration

| Layer | Max Entries | Max Memory | Decay |
|-------|-------------|------------|-------|
| Working | 50 | 100KB | None |
| Episodic | 500 | 500KB | Time-based |
| Long-term | 10000 | 5MB | None |

---

## Reflection Engine

### Types

```typescript
type ReflectionType = 'post_execution' | 'pre_planning' | 'error_analysis' | 'pattern_detection';

interface Reflection {
  id: string;
  type: ReflectionType;
  context: string;
  question: string;
  answer?: string;
  quality: number;         // 0-1
  actionable: boolean;
  insights: string[];
  recommendations: string[];
  createdAt: string;
  relatedOutcome?: 'success' | 'partial' | 'failure';
}

interface ReflectionSession {
  id: string;
  taskId: string;
  reflections: Reflection[];
  overallQuality: number;
  keyInsight: string;
  createdAt: string;
  completedAt?: string;
}

interface ReflectionPattern {
  id: string;
  pattern: string;
  frequency: number;
  severity: number;
  firstSeen: string;
  lastSeen: string;
  resolution?: string;
}

interface ReflectionStats {
  totalSessions: number;
  averageQuality: number;
  patternCount: number;
  topPatterns: ReflectionPattern[];
  improvementTrend: 'improving' | 'declining' | 'stable';
}
```

### API

```typescript
// Create engine
const engine = new ReflectionEngine();

// Start session
const sessionId = engine.startSession(taskId: string): string;

// Add reflection
const reflection = engine.addReflection(
  sessionId: string,
  context: string,
  question: string,
  answer?: string
): Reflection;

// Complete session
engine.completeSession(sessionId: string, outcome?: 'success' | 'partial' | 'failure'): void;

// Get session
engine.getSession(sessionId: string): ReflectionSession | undefined;

// Get recommendations
engine.getRecommendations(reflectionId?: string): string[];

// Get statistics
engine.getStats(): ReflectionStats;

// Get related patterns
engine.getRelatedPatterns(context: string): ReflectionPattern[];

// Generate report
engine.generateReport(sessionId: string): string;

// Global engine
const global = getGlobalReflectionEngine();
```

---

## Consensus Checker

### Types

```typescript
type ConsensusLevel = 'unanimous' | 'strong' | 'moderate' | 'low' | 'diverged';

interface ModelVote {
  modelId: string;
  modelName: string;
  decision: string;
  confidence: number;  // 0-1
  reasoning: string;
  timestamp: string;
}

interface ConsensusCheck {
  id: string;
  question: string;
  context: string;
  votes: ModelVote[];
  consensusLevel: ConsensusLevel;
  consensusScore: number;  // 0-1
  agreedDecision?: string;
  disagreementSummary?: string;
  createdAt: string;
  completedAt?: string;
  requiresDiscussion: boolean;
}

interface ConsensusConfig {
  minVoters: number;                    // Default: 3
  agreementThreshold: number;           // Default: 0.8
  strongAgreementThreshold: number;     // Default: 0.95
  lowConsensusThreshold: number;        // Default: 0.5
  timeoutMs: number;                    // Default: 30000
  enableDiscussion: boolean;            // Default: true
}

interface ConsensusResult {
  decision: string;
  consensusLevel: ConsensusLevel;
  consensusScore: number;
  confidence: 'high' | 'medium' | 'low';
  requiresAction: boolean;
  actionType?: 'proceed' | 'discuss' | 'rethink' | 'escalate';
}
```

### API

```typescript
// Create checker
const checker = new ConsensusChecker(config?: Partial<ConsensusConfig>);

// Create check
const checkId = checker.createCheck(question: string, context?: string): string;

// Add vote
checker.addVote(
  checkId: string,
  modelId: string,
  modelName: string,
  decision: string,
  confidence: number,
  reasoning: string
): boolean;

// Complete check
checker.completeCheck(checkId: string): ConsensusCheck | undefined;

// Get check
checker.getCheck(checkId: string): ConsensusCheck | undefined;

// Get result
checker.getResult(checkId: string): ConsensusResult | undefined;

// Wait for votes (async)
await checker.waitForVotes(checkId: string): Promise<ConsensusCheck | null>;

// Get statistics
checker.getStats(): {
  totalChecks: number;
  completedChecks: number;
  averageConsensusScore: number;
  byLevel: Record<ConsensusLevel, number>;
};

// Clear old checks
checker.clearOldChecks(olderThanMs?: number): number;

// Generate report
checker.generateReport(checkId: string): string;

// Global checker
const global = getGlobalConsensusChecker();
```

### Consensus Thresholds

| Level | Threshold | Action |
|-------|-----------|--------|
| Unanimous | ≥95% | Proceed |
| Strong | ≥80% | Proceed |
| Moderate | ≥50% | Discuss |
| Low | >0 | Rethink |
| Diverged | 0 | Escalate |

---

## Inspector Agent

### Types

```typescript
type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type IssueCategory = 'performance' | 'reliability' | 'security' | 'memory' | 'coordination' | 'configuration';

interface Issue {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  description: string;
  affectedComponent?: string;
  detectedAt: string;
  resolvedAt?: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'ignored';
  suggestions: string[];
  metrics?: Record<string, number>;
}

interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  score: number;          // 0-1
  lastChecked: string;
  issues: Issue[];
  metrics: Record<string, number>;
}

interface InspectionReport {
  id: string;
  timestamp: string;
  overallHealth: number;
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  components: ComponentHealth[];
  openIssues: Issue[];
  resolvedIssues: Issue[];
  recommendations: string[];
  summary: string;
}
```

### API

```typescript
// Create inspector
const inspector = new InspectorAgent();

// Update component status
inspector.updateComponent(
  name: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
  score: number,
  metrics?: Record<string, number>
): void;

// Detect issue manually
const issue = inspector.detectIssue(
  category: IssueCategory,
  severity: IssueSeverity,
  title: string,
  description: string,
  affectedComponent?: string,
  suggestions?: string[]
): Issue;

// Auto-detect issues from metrics
inspector.autoDetect(componentName: string, metrics: Record<string, number>): Issue[];

// Get open issues
inspector.getOpenIssues(): Issue[];

// Resolve issue
inspector.resolveIssue(issueId: string): boolean;

// Ignore issue
inspector.ignoreIssue(issueId: string): boolean;

// Run inspection
inspector.inspect(): InspectionReport;

// Get history
inspector.getHistory(limit?: number): InspectionReport[];

// Get health trend
inspector.getHealthTrend(): {
  trend: 'improving' | 'declining' | 'stable';
  change: number;
  history: Array<{ timestamp: string; health: number }>;
};

// Get statistics
inspector.getStats(): {
  totalIssues: number;
  openIssues: number;
  resolvedIssues: number;
  byCategory: Record<IssueCategory, number>;
  bySeverity: Record<IssueSeverity, number>;
  avgResolutionTime?: number;
};

// Clear resolved
inspector.clearResolved(olderThanMs?: number): number;

// Global inspector
const global = getGlobalInspector();
```

### Auto-Detection Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Response Time | >1000ms | >5000ms |
| Error Rate | >5% | >20% |
| Memory Usage | >90% | >95% |
| Queue Depth | >100 | >500 |
| Success Rate | <80% | <50% |

---

## Configuration

### Default Thresholds

```typescript
const DEFAULT_CONFIG = {
  // Task Complexity
  complexityWeights: {
    treewidth: 0.20,
    dependencyDepth: 0.15,
    inputSize: 0.10,
    outputComplexity: 0.15,
    domainKnowledge: 0.15,
    riskLevel: 0.10,
    uncertaintyLevel: 0.10,
    timeConstraints: 0.05
  },

  // Token Budget
  warnThreshold: 0.8,
  cutoffThreshold: 0.95,

  // Consensus
  minVoters: 3,
  agreementThreshold: 0.8,
  strongAgreementThreshold: 0.95,
  lowConsensusThreshold: 0.5,
  consensusTimeout: 30000,

  // Memory Layers
  memoryLayers: {
    working: { maxEntries: 50, maxMemoryBytes: 100000 },
    episodic: { maxEntries: 500, maxMemoryBytes: 500000, decayRate: 0.05 },
    longterm: { maxEntries: 10000, maxMemoryBytes: 5000000 }
  },

  // Health Thresholds
  healthyThreshold: 0.8,
  degradedThreshold: 0.5
};
```

---

## Examples

### Complete Workflow

```typescript
import {
  TaskComplexityAnalyzer,
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
  InspectorAgent
} from '@commander/core';

// 1. Analyze task
const analyzer = new TaskComplexityAnalyzer();
const complexity = analyzer.analyze({
  id: 'task-1',
  description: 'Build distributed logging system',
  riskLevel: 'high'
});

// 2. Allocate budget
const allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
const budget = allocator.allocate(complexity.recommendedMode, complexity.score, 3);

// 3. Create plan
const orchestrator = new AdaptiveOrchestrator();
orchestrator.registerAgent({ id: 'lead', name: 'Lead', role: 'architect', capabilities: [] });
const plan = orchestrator.createPlan([{ id: 'task-1', description: '...', complexity: complexity.score }], complexity.recommendedMode);

// 4. Store in memory
const memory = new ThreeLayerMemory();
memory.add('Starting task', 'working', 'task-1', 0.9);

// 5. Consensus for high-risk
const checker = new ConsensusChecker();
const checkId = checker.createCheck('Best technology stack?');
checker.addVote(checkId, 'm1', 'Model A', 'Kafka + ES', 0.9, 'Industry standard');
checker.addVote(checkId, 'm2', 'Model B', 'Kafka + ES', 0.85, 'Scalable');
const result = checker.getResult(checkId);

// 6. Reflect
const engine = new ReflectionEngine();
const sessionId = engine.startSession('task-1');
engine.addReflection(sessionId, 'post_execution', 'Result?', 'Succeeded');
engine.completeSession(sessionId, 'success');

// 7. Inspect
const inspector = new InspectorAgent();
inspector.updateComponent('orchestrator', 'healthy', 0.9);
const report = inspector.inspect();
```

---

## License

MIT