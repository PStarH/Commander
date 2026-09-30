const test = require('node:test');
const assert = require('node:assert/strict');
const { HallucinationDetector } = require('../../../packages/core/dist/index.js');
const { MemoryPoisoningDetector } = require('../dist/memoryPoisoningDetector.js');
const { SelfAssessmentManager } = require('../dist/selfAssessment.js');
const {
  AgentBenchmarkRunner,
  createCommanderHealthCheckBenchmark,
  calculatePassAtK,
} = require('../dist/agentBenchmarkRunner.js');
const { MemoryPoisoningDetector: MPD } = require('../dist/memoryPoisoningDetector.js');

// ============================================================================
// HallucinationDetector
// ============================================================================

test('HallucinationDetector - overconfidence detection', () => {
  const detector = new HallucinationDetector();
  const report = detector.analyze('What is X?', 'I am absolutely certain this is 100% correct.');
  assert.ok(report.riskScore > 0);
  assert.ok(report.signals.length > 0);
  // AUDIT F-A-21: the old third assertion was `recommendation !== 'pass' ||
  // riskScore < 0.6`, true for essentially any output. Pin the documented
  // score→recommendation contract from src/hallucinationDetector.ts instead.
  const expected =
    report.riskScore >= 0.5 ? 'reject' : report.riskScore >= 0.2 ? 'flag_for_review' : 'pass';
  assert.equal(report.recommendation, expected);
  assert.ok(report.riskScore <= 1, 'riskScore must stay clamped to 1.0');
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
  // AUDIT F-A-21: `typeof score === 'number'` and `Array.isArray(factors)` are
  // true for any implementation. Pin the actual credibility contract.
  const trusted = await detector.assessCredibility({
    id: 'test-1',
    content: 'The sky is blue and water is wet.',
    timestamp: new Date(),
    source: 'https://wikipedia.org',
  });
  assert.equal(trusted.recommendation, 'accept');
  assert.equal(trusted.score, 0.7733333333333334);
  assert.equal(trusted.factors.length, 4);
  assert.equal(
    trusted.factors.find((f) => f.name === 'domain_reputation').score,
    0.95,
    'a trusted domain must score 0.95, not the unknown-domain fallback',
  );

  const unknown = await detector.assessCredibility({
    id: 'test-2',
    content: 'The sky is blue and water is wet.',
    timestamp: new Date(),
    source: 'https://unvetted-host.example',
  });
  assert.equal(unknown.recommendation, 'quarantine');
  assert.ok(
    unknown.score < trusted.score,
    `unknown source (${unknown.score}) must score below trusted (${trusted.score})`,
  );
});

test('MemoryPoisoningDetector - detect poisoning in batch', async () => {
  const detector = new MemoryPoisoningDetector();
  const indicators = await detector.detectPoisoning(
    [{ id: 'new-1', content: 'test', timestamp: new Date(), source: 'unknown' }],
    [{ id: 'old-1', content: 'existing memory', timestamp: new Date(), source: 'trusted' }],
  );
  // AUDIT F-A-21: `Array.isArray(indicators)` is tautological for a function
  // declared to return an array. Pin the empty-batch result instead.
  assert.deepEqual(indicators, []);
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
// BenchmarkRunner
// ============================================================================

test('calculatePassAtK computes correctly', () => {
  const results = [
    // task 1 never passes in any trial; task 2 passes → 1 of 2 tasks resolved.
    { taskId: '1', trials: [{ passed: false }, { passed: false }, { passed: false }] },
    { taskId: '2', trials: [{ passed: true }, { passed: true }, { passed: false }] },
  ];
  const passAtK = calculatePassAtK(results, 3);
  // AUDIT F-A-21: `typeof x === 'number'` accepts NaN. Pin exact values.
  assert.equal(passAtK.passAt1, 0.5);
  assert.equal(passAtK.passAt3, 0.5);
  assert.equal(passAtK.passAtK, 0.5);

  // All-pass and all-fail controls pin the ratio, not just the type.
  assert.equal(calculatePassAtK([{ taskId: 'a', trials: [{ passed: true }] }], 1).passAt1, 1);
  assert.equal(calculatePassAtK([{ taskId: 'a', trials: [{ passed: false }] }], 1).passAt1, 0);
  assert.equal(calculatePassAtK([], 1).passAt1, 0);
});

test('createCommanderHealthCheckBenchmark returns tasks', () => {
  const tasks = createCommanderHealthCheckBenchmark();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length > 0);
  assert.ok(tasks[0].prompt);
  assert.ok(tasks[0].expectedOutcome);
});
