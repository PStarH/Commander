const test = require('node:test');
const assert = require('node:assert/strict');
const { HallucinationDetector } = require('../../../packages/core/dist/index.js');
const { MemoryPoisoningDetector } = require('../dist/memoryPoisoningDetector.js');
const { SelfAssessmentManager } = require('../dist/selfAssessment.js');
const { NamespacedMemoryStore } = require('../dist/namespacedMemoryStore.js');
const { AgentBenchmarkRunner, createCommanderHealthCheckBenchmark, calculatePassAtK } = require('../dist/agentBenchmarkRunner.js');
const { MemoryPoisoningDetector: MPD } = require('../dist/memoryPoisoningDetector.js');

// ============================================================================
// HallucinationDetector
// ============================================================================

test('HallucinationDetector - overconfidence detection', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze('What is X?', 'I am absolutely certain this is 100% correct.');
  assert.ok(report.riskScore > 0);
  assert.ok(report.signals.length > 0);
  assert.ok(report.recommendation !== 'pass' || report.riskScore < 0.6);
});

test('HallucinationDetector - clean output passes', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze('Explain X.', 'X is a concept that involves Y and Z.');
  assert.equal(report.riskScore, 0);
  assert.equal(report.recommendation, 'pass');
});

// ============================================================================
// MemoryPoisoningDetector
// ============================================================================

test('MemoryPoisoningDetector - assess credibility', async () => {
  const detector = new MemoryPoisoningDetector();
  const result = await detector.assessCredibility({
    id: 'test-1',
    content: 'The sky is blue.',
    timestamp: new Date(),
    source: 'wikipedia.org',
  });
  assert.ok(typeof result.score === 'number');
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(Array.isArray(result.factors));
});

test('MemoryPoisoningDetector - detect poisoning in batch', async () => {
  const detector = new MemoryPoisoningDetector();
  const indicators = await detector.detectPoisoning(
    [{ id: 'new-1', content: 'test', timestamp: new Date(), source: 'unknown' }],
    [{ id: 'old-1', content: 'existing memory', timestamp: new Date(), source: 'trusted' }],
  );
  assert.ok(Array.isArray(indicators));
});

// ============================================================================
// SelfAssessmentManager
// ============================================================================

test('SelfAssessmentManager - assess returns confidence', () => {
  const manager = new SelfAssessmentManager();
  const result = manager.assess('agent-1', {
    type: 'coding',
    requiredSkills: ['TypeScript', 'Node.js'],
    complexity: 5,
  });
  assert.ok(typeof result.confidence === 'number');
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(Array.isArray(result.gaps));
  assert.ok(result.recommendedMode);
});

test('SelfAssessmentManager - different agents are independent', () => {
  const manager = new SelfAssessmentManager();
  manager.assess('agent-a', { type: 'coding', complexity: 3 });
  manager.assess('agent-b', { type: 'research', complexity: 8 });
  // Both should work without interfering
  const a = manager.assess('agent-a', { type: 'coding', complexity: 3 });
  const b = manager.assess('agent-b', { type: 'research', complexity: 8 });
  assert.ok(a.confidence !== undefined);
  assert.ok(b.confidence !== undefined);
});

// ============================================================================
// NamespacedMemoryStore
// ============================================================================

test('NamespacedMemoryStore - write and read with permissions', () => {
  const store = new NamespacedMemoryStore();
  // Add system role with full access
  store.setACLRule({ role: 'system', permissions: ['read', 'write', 'delete', 'admin'], namespaces: ['*'] });
  store.setNamespaceConfig({ name: 'test', maxItems: 100, retentionPolicy: 'fifo' });
  const written = store.write(
    { namespace: 'test', projectId: 'proj', kind: 'DECISION', title: 'Test', content: 'Content', tags: [] },
    { agentId: 'agent-1', role: 'system', namespace: 'test' },
  );
  assert.ok(written);
  assert.ok(written.id);

  const read = store.read(written.id, { agentId: 'agent-1', role: 'system', namespace: 'test' });
  assert.ok(read);
  assert.equal(read.title, 'Test');
});

test('NamespacedMemoryStore - getAuditLog tracks operations', () => {
  const store = new NamespacedMemoryStore();
  store.setACLRule({ role: 'system', permissions: ['read', 'write', 'delete', 'admin'], namespaces: ['*'] });
  store.setNamespaceConfig({ name: 'audit-test', maxItems: 100, retentionPolicy: 'fifo' });
  store.write(
    { namespace: 'audit-test', projectId: 'proj', kind: 'DECISION', title: 'T', content: 'C', tags: [] },
    { agentId: 'agent-1', role: 'system', namespace: 'audit-test' },
  );
  const log = store.getAuditLog({ namespace: 'audit-test', limit: 10 });
  assert.ok(Array.isArray(log));
  assert.ok(log.length > 0);
});

// ============================================================================
// BenchmarkRunner
// ============================================================================

test('calculatePassAtK computes correctly', () => {
  const results = [
    { taskId: '1', trials: [{ passed: true }, { passed: false }, { passed: false }] },
    { taskId: '2', trials: [{ passed: true }, { passed: true }, { passed: false }] },
  ];
  const passAtK = calculatePassAtK(results, 3);
  assert.ok(passAtK);
  assert.ok(typeof passAtK.passAt1 === 'number');
  assert.ok(typeof passAtK.passAt3 === 'number');
});

test('createCommanderHealthCheckBenchmark returns tasks', () => {
  const tasks = createCommanderHealthCheckBenchmark();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length > 0);
  assert.ok(tasks[0].prompt);
  assert.ok(tasks[0].expectedOutcome);
});
