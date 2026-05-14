const test = require('node:test');
const assert = require('node:assert/strict');
const { HallucinationDetector } = require('../../../packages/core/dist/index.js');
const { MemoryPoisoningDetector } = require('../dist/memoryPoisoningDetector.js');
const { AgentSelfAssessment, SelfAssessmentManager } = require('../dist/selfAssessment.js');
const { AgentBenchmarkRunner, createCommanderHealthCheckBenchmark, calculatePassAtK } = require('../dist/agentBenchmarkRunner.js');
const { NamespacedMemoryStore } = require('../dist/namespacedMemoryStore.js');

// ============================================================================
// HallucinationDetector (via core module)
// ============================================================================

test('HallucinationDetector - clean output passes', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze(
    'Explain architecture.',
    'The framework uses a modular design with agents and orchestrator.'
  );
  assert.equal(report.riskScore, 0);
  assert.equal(report.recommendation, 'pass');
});

test('HallucinationDetector - detects overconfidence', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze(
    'Is this good?',
    'I am absolutely certain this is the best. Without a doubt.'
  );
  assert.ok(report.riskScore > 0);
  assert.ok(report.signals.some(s => s.type === 'overconfidence'));
});

test('HallucinationDetector - detects fabricated references', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze(
    'Tell me about research.',
    'A recent study by Dr. Smith and colleagues found significant improvement.'
  );
  assert.ok(report.signals.some(s => s.type === 'fabricated_reference'));
});

// ============================================================================
// MemoryPoisoningDetector
// ============================================================================

test('MemoryPoisoningDetector - assessCredibility', async () => {
  const detector = new MemoryPoisoningDetector();
  const result = await detector.assessCredibility({
    id: 'test-1',
    content: 'The sky is blue.',
    timestamp: new Date(),
    source: 'wikipedia.org',
  });
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(['accept', 'quarantine', 'reject'].includes(result.recommendation));
});

test('MemoryPoisoningDetector - detectPoisoning', async () => {
  const detector = new MemoryPoisoningDetector();
  const indicators = await detector.detectPoisoning(
    [{ id: 'new-1', content: 'test', timestamp: new Date(), source: 'unknown' }],
    [{ id: 'old-1', content: 'existing', timestamp: new Date(), source: 'system' }],
  );
  assert.ok(Array.isArray(indicators));
});

// ============================================================================
// AgentSelfAssessment
// ============================================================================

test('AgentSelfAssessment - assess returns confidence', () => {
  const assessor = new AgentSelfAssessment('test-agent', ['typescript', 'testing']);
  const result = assessor.assess({
    type: 'code-generation',
    requiredSkills: ['typescript'],
    complexity: 0.5,
  });
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(Array.isArray(result.gaps));
  assert.ok(typeof result.canHandle === 'boolean');
});

test('SelfAssessmentManager - getOrCreate and assess', () => {
  const manager = new SelfAssessmentManager();
  const result = manager.assess('agent-alpha', {
    type: 'analysis',
    requiredSkills: ['data-analysis'],
    complexity: 0.3,
  });
  assert.ok(result.confidence >= 0);
});

// ============================================================================
// AgentBenchmarkRunner
// ============================================================================

test('createCommanderHealthCheckBenchmark returns tasks', () => {
  const tasks = createCommanderHealthCheckBenchmark();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length > 0);
  assert.ok(tasks[0].id);
  assert.ok(tasks[0].prompt);
});

test('calculatePassAtK computes correctly', () => {
  const results = [
    { taskId: 'a', passed: true, output: '', latencyMs: 10 },
    { taskId: 'a', passed: true, output: '', latencyMs: 10 },
    { taskId: 'a', passed: false, output: '', latencyMs: 10 },
  ];
  const passAtK = calculatePassAtK(results);
  assert.ok(passAtK);
  assert.ok(passAtK.passAt1 !== undefined);
});

// ============================================================================
// NamespacedMemoryStore
// ============================================================================

test('NamespacedMemoryStore - write and read', () => {
  const store = new NamespacedMemoryStore();
  store.setNamespaceConfig({ name: 'test-ns', readRoles: ['*'], writeRoles: ['orchestrator'], ttlDays: 30 });

  const written = store.write(
    { namespace: 'test-ns', projectId: 'proj', kind: 'SUMMARY', title: 'Test', content: 'Hello', tags: [] },
    { agentId: 'agent-1', role: 'orchestrator', namespace: 'test-ns' }
  );
  assert.ok(written);
  assert.ok(written.id);

  const read = store.read(written.id, { agentId: 'agent-1', role: 'orchestrator', namespace: 'test-ns' });
  assert.ok(read);
  assert.equal(read.title, 'Test');
});

test('NamespacedMemoryStore - RBAC denies unauthorized write', () => {
  const store = new NamespacedMemoryStore();
  store.setNamespaceConfig({ name: 'secure-ns', readRoles: ['reviewer'], writeRoles: ['orchestrator'], ttlDays: 30 });

  const result = store.write(
    { namespace: 'secure-ns', projectId: 'proj', kind: 'SUMMARY', title: 'Hack', content: 'Bad', tags: [] },
    { agentId: 'intruder', role: 'reviewer', namespace: 'secure-ns' }
  );
  assert.equal(result, null);
});

test('NamespacedMemoryStore - audit log records actions', () => {
  const store = new NamespacedMemoryStore();
  store.setNamespaceConfig({ name: 'audit-ns', readRoles: ['*'], writeRoles: ['orchestrator'], ttlDays: 30 });

  store.write(
    { namespace: 'audit-ns', projectId: 'proj', kind: 'SUMMARY', title: 'Audit Test', content: 'Logged', tags: [] },
    { agentId: 'agent-1', role: 'orchestrator', namespace: 'audit-ns' }
  );

  const audit = store.getAuditLog({ namespace: 'audit-ns', limit: 10 });
  assert.ok(audit.length > 0);
});

test('NamespacedMemoryStore - search with RBAC', () => {
  const store = new NamespacedMemoryStore();
  store.setNamespaceConfig({ name: 'search-ns', readRoles: ['*'], writeRoles: ['orchestrator'], ttlDays: 30 });

  store.write(
    { namespace: 'search-ns', projectId: 'proj', kind: 'SUMMARY', title: 'Findable', content: 'Searchable content', tags: ['test'] },
    { agentId: 'agent-1', role: 'orchestrator', namespace: 'search-ns' }
  );

  const results = store.search(
    { projectId: 'proj', query: 'Findable', namespaces: ['search-ns'] },
    { agentId: 'agent-1', role: 'orchestrator', namespace: 'search-ns' }
  );
  assert.ok(results.items.length > 0);
});

// ============================================================================
// A2A Task Manager
// ============================================================================

test('TaskManager - create and get task', async () => {
  const { TaskManager } = require('../dist/a2aTask.js');
  const manager = new TaskManager();
  const task = manager.create('client-1', 'Test task', { type: 'test' });
  assert.ok(task);
  assert.ok(task.id);
  assert.equal(task.description, 'Test task');

  const retrieved = manager.get(task.id);
  assert.ok(retrieved);
  assert.equal(retrieved.description, 'Test task');
});
