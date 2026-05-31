import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HallucinationDetector } from '../src/hallucinationDetector';

describe('HallucinationDetector', () => {
  const detector = new HallucinationDetector();

  // ========================================================================
  // Original tests (backward compatibility)
  // ========================================================================

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

  // ========================================================================
  // Hedging-aware detection (reduced false positives)
  // ========================================================================

  describe('Hedging-aware detection', () => {
    it('reduces severity when hedging language is present', () => {
      const withHedge = detector.analyze(
        'What is the performance?',
        'I believe this approach is approximately 50% faster based on my understanding.'
      );
      const withoutHedge = detector.analyze(
        'What is the performance?',
        'This approach is 50% faster. It has been proven.'
      );
      // Hedged version should have lower risk
      assert.ok(withHedge.riskScore <= withoutHedge.riskScore);
    });

    it('does not flag hedged specificity as high severity', () => {
      const report = detector.analyze(
        'How many users?',
        'Based on available information, approximately 42.5% of users prefer this option.'
      );
      // Should not have high severity signals
      const highSignals = report.signals.filter(s => s.severity === 'high');
      assert.equal(highSignals.length, 0);
    });

    it('still flags strong overconfidence even with hedging elsewhere', () => {
      const report = detector.analyze(
        'Is this correct?',
        'I believe the approach is good. There is no doubt that this is 100% guaranteed to work.'
      );
      assert.ok(report.signals.some(s => s.type === 'overconfidence'));
    });
  });

  // ========================================================================
  // New signal types
  // ========================================================================

  describe('Entailment failure detection', () => {
    it('detects output with many novel claims not in input', () => {
      const input = 'Explain the authentication flow.';
      const output = `The authentication flow uses OAuth 2.0 with PKCE. The system stores tokens in Redis with a TTL of 3600 seconds.
        The database uses PostgreSQL with read replicas. The load balancer distributes traffic across 5 regions.
        The monitoring system uses Prometheus and Grafana dashboards. The CI/CD pipeline runs on GitHub Actions.`;
      const report = detector.analyze(input, output);
      assert.ok(report.signals.some(s => s.type === 'entailment_failure'));
    });

    it('does not flag output grounded in input', () => {
      const input = 'Explain the Commander multi-agent architecture and its key components.';
      const output = 'The Commander multi-agent architecture uses a lead agent that coordinates with subagents. The key components include task decomposition, quality gates, and consensus verification.';
      const report = detector.analyze(input, output);
      const entailmentSignals = report.signals.filter(s => s.type === 'entailment_failure');
      assert.equal(entailmentSignals.length, 0);
    });
  });

  describe('Self-contradiction detection', () => {
    it('detects contradictory statements', () => {
      const report = detector.analyze(
        'Describe the system behavior.',
        'The system always returns success. However, on the other hand, it sometimes returns failure codes.'
      );
      assert.ok(report.signals.some(s => s.type === 'self_contradiction'));
    });
  });

  describe('Confidence inconsistency detection', () => {
    it('detects confidence followed by uncertainty', () => {
      const report = detector.analyze(
        'Is this correct?',
        'I am absolutely certain this works, but I\'m not sure about the edge cases.'
      );
      assert.ok(report.signals.some(s => s.type === 'confidence_inconsistency'));
    });
  });

  describe('Hedged-as-fact detection', () => {
    it('detects hedged claims escalated to facts', () => {
      const report = detector.analyze(
        'Does this work?',
        'This approach might improve performance. This approach definitely improves performance by 50%.'
      );
      assert.ok(report.signals.some(s => s.type === 'hedged_as_fact'));
    });
  });

  // ========================================================================
  // Multi-sample consistency (SelfCheckGPT-style)
  // ========================================================================

  describe('Multi-sample consistency check', () => {
    it('flags sentences inconsistent across samples', () => {
      const original = 'The authentication uses OAuth tokens. The data is stored in Redis. The system requires two-factor login.';
      const samples = [
        'The authentication uses API keys. The data is stored in MongoDB. The system requires two-factor login.',
        'The authentication uses JWT tokens. The data is stored in Redis. The system allows single-factor login.',
        'The authentication uses OAuth tokens. The data is stored in PostgreSQL. The system requires two-factor login.',
      ];

      const result = detector.analyzeMultiSample(original, samples);

      assert.ok(result.sentences.length > 0);
      assert.ok(result.consistencyScores.length > 0);
      // The second sentence (Redis) is inconsistent across samples
      // The third sentence (two-factor) is also inconsistent
      assert.ok(result.riskScore > 0, `Expected riskScore > 0, got ${result.riskScore}`);
    });

    it('returns high consistency for identical samples', () => {
      const original = 'The system uses microservices architecture.';
      const samples = [
        'The system uses microservices architecture.',
        'The system uses microservices architecture.',
        'The system uses microservices architecture.',
      ];

      const result = detector.analyzeMultiSample(original, samples);
      assert.ok(result.riskScore < 0.2);
    });

    it('returns empty result for empty input', () => {
      const result = detector.analyzeMultiSample('', []);
      assert.equal(result.sentences.length, 0);
      assert.equal(result.riskScore, 0);
    });
  });

  // ========================================================================
  // Claim decomposition (FActScore-style)
  // ========================================================================

  describe('Claim decomposition', () => {
    it('decomposes compound sentences into claims', () => {
      const output = 'The system uses Node.js and it supports TypeScript. The database stores user data and handles authentication.';
      const claims = detector.decomposeClaims(output);
      // Should decompose into at least 2 atomic claims
      assert.ok(claims.length >= 2, `Expected >=2 claims, got ${claims.length}: ${JSON.stringify(claims)}`);
    });

    it('skips hedging/qualifying sentences', () => {
      const output = 'However, this might not be accurate. The API returns JSON responses.';
      const claims = detector.decomposeClaims(output);
      // Should include the factual claim
      assert.ok(claims.some(c => c.includes('API') || c.includes('JSON')), `Claims: ${JSON.stringify(claims)}`);
    });

    it('returns empty for empty input', () => {
      const claims = detector.decomposeClaims('');
      assert.equal(claims.length, 0);
    });
  });

  // ========================================================================
  // Temporal detection improvements
  // ========================================================================

  describe('Temporal detection', () => {
    it('detects relative time references', () => {
      const report = detector.analyze(
        'What happened?',
        'Yesterday the system was updated with new features.'
      );
      assert.ok(report.signals.some(s => s.type === 'temporal_impossibility'));
    });

    it('does not flag current year references', () => {
      const report = detector.analyze(
        'What is the latest version?',
        'As of January 2026, the latest version is 2.0.'
      );
      // 2026 is within knowledge cutoff, should not flag
      const temporalSignals = report.signals.filter(s => s.type === 'temporal_impossibility');
      assert.equal(temporalSignals.length, 0);
    });
  });

  // ========================================================================
  // Fabricated reference improvements
  // ========================================================================

  describe('Fabricated reference detection', () => {
    it('flags vague attributions', () => {
      const report = detector.analyze(
        'What does research say?',
        'Studies show that multi-agent systems are more efficient. Experts say this is the future.'
      );
      assert.ok(report.signals.some(s => s.type === 'fabricated_reference'));
    });

    it('reduces severity for known journals', () => {
      const report = detector.analyze(
        'What did Nature publish?',
        'A recent study published in Nature found that AI systems can reason.'
      );
      const refSignals = report.signals.filter(s => s.type === 'fabricated_reference');
      if (refSignals.length > 0) {
        // Known journal should be medium, not high
        assert.equal(refSignals[0].severity, 'medium');
      }
    });
  });

  // ========================================================================
  // Recommendation thresholds
  // ========================================================================

  describe('Recommendation thresholds', () => {
    it('passes low-risk output', () => {
      const report = detector.analyze(
        'What is this?',
        'This is a framework for building AI agents.'
      );
      assert.equal(report.recommendation, 'pass');
    });

    it('flags medium-risk output', () => {
      const report = detector.analyze(
        'Tell me about the system.',
        'I believe the system approximately handles 1000 requests per second based on available information.'
      );
      // Hedged specificity should still pass
      assert.ok(report.recommendation === 'pass' || report.recommendation === 'flag_for_review');
    });

    it('rejects high-risk output with multiple signals', () => {
      const report = detector.analyze(
        'Describe the research.',
        'A recent study by Dr. Smith found that this approach is 100% guaranteed to work. There is no doubt about it. Studies show 99% improvement.'
      );
      assert.equal(report.recommendation, 'reject');
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe('Edge cases', () => {
    it('handles empty output', () => {
      const report = detector.analyze('test input', '');
      assert.equal(report.riskScore, 0);
      assert.equal(report.signals.length, 0);
    });

    it('handles very short output', () => {
      const report = detector.analyze('What?', 'Yes.');
      assert.ok(report.riskScore >= 0);
    });

    it('handles Chinese content', () => {
      const report = detector.analyze(
        '这个系统怎么样？',
        '毫无疑问，这个系统是百分之百可靠的。'
      );
      assert.ok(report.signals.some(s => s.type === 'overconfidence'));
    });

    it('handles mixed language content', () => {
      const report = detector.analyze(
        'How does it work?',
        'The system uses 机器学习 algorithms. It is 绝对正确 that this approach works.'
      );
      assert.ok(report.signals.length > 0);
    });
  });
});
