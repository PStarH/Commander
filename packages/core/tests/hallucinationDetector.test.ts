import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HallucinationDetector } from '../src/hallucinationDetector';

describe('HallucinationDetector', () => {
  const detector = new HallucinationDetector();

  it('detects overconfidence markers', () => {
    const report = detector.analyze(
      'What is the best framework?',
      'I am absolutely certain that Commander is the best framework. There is no doubt about it.'
    );
    assert.ok(report.riskScore > 0);
    assert.ok(report.signals.some(s => s.type === 'overconfidence'));
  });

  it('detects fabricated references', () => {
    const report = detector.analyze(
      'Tell me about AI research.',
      'A recent study by Dr. Smith and colleagues found that multi-agent systems are superior.'
    );
    assert.ok(report.signals.some(s => s.type === 'fabricated_reference'));
    assert.equal(report.recommendation, 'reject'); // High severity
  });

  it('detects future temporal references', () => {
    const report = detector.analyze(
      'What will happen?',
      'In January 2099, the technology will be available.'
    );
    assert.ok(report.signals.some(s => s.type === 'temporal_impossibility'));
  });

  it('passes clean output without false positives', () => {
    const report = detector.analyze(
      'Explain the architecture.',
      'The Commander framework uses a multi-agent architecture with a lead agent and subagents.'
    );
    assert.equal(report.riskScore, 0);
    assert.equal(report.signals.length, 0);
    assert.equal(report.recommendation, 'pass');
  });

  it('detects numeric anomalies', () => {
    const report = detector.analyze(
      'Summarize the survey results.',
      'The results show 45% preferred A, 35% preferred B, and 30% preferred C.'
    );
    assert.ok(report.signals.some(s => s.type === 'numeric_anomaly'));
  });

  it('flags long output for review', () => {
    const shortInput = 'Explain the framework architecture and its key components in detail.';
    const longOutput = 'word '.repeat(200); // 200 words from a short input
    const report = detector.analyze(shortInput, longOutput);
    // Short input without question should flag expansion
    assert.ok(report.signals.some(s => s.type === 'inconsistency'));
  });

  it('returns risk score between 0 and 1', () => {
    const report = detector.analyze('test', 'I am 100% certain and without doubt. A recent study by Dr. Jones found 99% improvement.');
    assert.ok(report.riskScore >= 0 && report.riskScore <= 1);
    assert.ok(report.signals.length > 0);
  });
});
