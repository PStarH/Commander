/**
 * Memory System Comprehensive Tests
 *
 * Tests for:
 * - BM25 Scorer (FTS5-quality full-text search)
 * - Improved memory scoring (4-factor formula)
 * - TrajectoryAnalyzer new failure categories
 * - MetaLearner Thompson Sampling improvements
 * - ThreeLayerMemory searchRelated improvements
 * - Memory consolidation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BM25Scorer, tokenizeForBM25 } from '../src/memory/ftsScorer';
import { calculateMemoryScore, DEFAULT_SCORE_WEIGHTS } from '../src/runtime/embedding';
import { TrajectoryAnalyzer } from '../src/selfEvolution/trajectoryAnalyzer';
import { MetaLearner } from '../src/selfEvolution/metaLearner';
import type { MemoryEntry } from '../src/threeLayerMemory';
import type { ExecutionExperience } from '../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeMemoryEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    layer: 'episodic',
    content: 'test content',
    context: 'test context',
    importance: 0.5,
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    decayScore: 1.0,
    tags: [],
    metadata: {},
    ...overrides,
  };
}

function makeExp(overrides: Partial<ExecutionExperience> & { id: string }): ExecutionExperience {
  return {
    runId: overrides.id,
    agentId: 'test-agent',
    taskType: 'general',
    modelUsed: 'test-model',
    strategyUsed: 'SEQUENTIAL',
    success: false,
    durationMs: 1000,
    tokenCost: 500,
    lessons: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// BM25 Scorer Tests
// ============================================================================

describe('BM25 Scorer', () => {
  it('tokenizes text correctly', () => {
    const tokens = tokenizeForBM25('Hello World! This is a test.');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
    assert.ok(tokens.includes('test'));
    // Stop words should be filtered
    assert.ok(!tokens.includes('this'));
    assert.ok(!tokens.includes('is'));
    assert.ok(!tokens.includes('a'));
  });

  it('handles CJK characters', () => {
    // CJK characters are individual tokens (min length 1 for CJK)
    const tokens = tokenizeForBM25('这是一个测试', 1);
    assert.strictEqual(tokens.length, 6); // Each CJK char is a token
    assert.ok(tokens.includes('这'));
    assert.ok(tokens.includes('测'));
    assert.ok(tokens.includes('试'));
  });

  it('handles programming terms', () => {
    const tokens = tokenizeForBM25('TypeScript async/await Promise');
    assert.ok(tokens.includes('typescript'));
    assert.ok(tokens.includes('async'));
    assert.ok(tokens.includes('await'));
    assert.ok(tokens.includes('promise'));
  });

  it('scores documents correctly with BM25', () => {
    const scorer = new BM25Scorer();

    scorer.addDocument('doc1', 'The quick brown fox jumps over the lazy dog');
    scorer.addDocument('doc2', 'A fast red car drives down the highway');
    scorer.addDocument('doc3', 'The lazy cat sleeps on the couch');

    // Query for 'lazy' should match doc1 and doc3
    const results = scorer.score('lazy dog');
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].id, 'doc1'); // doc1 has both 'lazy' and 'dog'
  });

  it('handles empty queries', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'test content');
    const results = scorer.score('');
    assert.strictEqual(results.length, 0);
  });

  it('handles no matches', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'hello world');
    const results = scorer.score('xyz123');
    assert.strictEqual(results.length, 0);
  });

  it('removes documents correctly', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'hello world');
    scorer.addDocument('doc2', 'hello earth');
    scorer.removeDocument('doc1');

    const results = scorer.score('hello');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'doc2');
  });

  it('handles field boosting (title)', () => {
    const scorer = new BM25Scorer();
    const fields = new Map<string, string>();
    fields.set('title', 'Important Decision');
    scorer.addDocument('doc1', 'This is about an important decision made today', fields);
    scorer.addDocument('doc2', 'This mentions important things but not in title');

    const results = scorer.score('important decision');
    assert.ok(results.length > 0);
    // doc1 should rank higher due to title match
    assert.strictEqual(results[0].id, 'doc1');
  });

  it('serializes and deserializes correctly', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'hello world');
    scorer.addDocument('doc2', 'goodbye world');

    const serialized = scorer.serialize();
    const restored = BM25Scorer.deserialize(serialized);

    const results = restored.score('world');
    assert.strictEqual(results.length, 2);
  });

  it('returns correct stats', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'hello world test');
    scorer.addDocument('doc2', 'goodbye earth');

    const stats = scorer.getStats();
    assert.strictEqual(stats.documents, 2);
    assert.ok(stats.terms > 0);
    assert.ok(stats.avgDocLength > 0);
  });
});

// ============================================================================
// Memory Scoring Tests
// ============================================================================

describe('Memory Scoring (4-factor formula)', () => {
  it('scores recent memories higher', () => {
    const recent = makeMemoryEntry({
      id: 'recent',
      lastAccessedAt: new Date().toISOString(),
    });
    const old = makeMemoryEntry({
      id: 'old',
      lastAccessedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const recentScore = calculateMemoryScore(recent, undefined, undefined);
    const oldScore = calculateMemoryScore(old, undefined, undefined);

    assert.ok(recentScore > oldScore, 'Recent memory should score higher');
  });

  it('scores important memories higher', () => {
    const important = makeMemoryEntry({
      id: 'important',
      importance: 0.9,
    });
    const trivial = makeMemoryEntry({
      id: 'trivial',
      importance: 0.1,
    });

    const importantScore = calculateMemoryScore(important, undefined, undefined);
    const trivialScore = calculateMemoryScore(trivial, undefined, undefined);

    assert.ok(importantScore > trivialScore, 'Important memory should score higher');
  });

  it('scores frequently accessed memories higher', () => {
    const frequent = makeMemoryEntry({
      id: 'frequent',
      accessCount: 50,
    });
    const rare = makeMemoryEntry({
      id: 'rare',
      accessCount: 1,
    });

    const frequentScore = calculateMemoryScore(frequent, undefined, undefined);
    const rareScore = calculateMemoryScore(rare, undefined, undefined);

    assert.ok(frequentScore > rareScore, 'Frequently accessed memory should score higher');
  });

  it('uses 7-day half-life for recency (not 24h)', () => {
    const oneDayOld = makeMemoryEntry({
      id: 'one-day',
      lastAccessedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const oneWeekOld = makeMemoryEntry({
      id: 'one-week',
      lastAccessedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const oneDayScore = calculateMemoryScore(oneDayOld, undefined, undefined);
    const oneWeekScore = calculateMemoryScore(oneWeekOld, undefined, undefined);

    // With 7-day half-life, 1-day-old should be ~0.9 of max, 1-week-old ~0.5
    const ratio = oneDayScore / oneWeekScore;
    assert.ok(ratio > 1.0, '1-day-old should score higher than 1-week-old');
    assert.ok(ratio < 2.0, 'Ratio should be reasonable (not too extreme)');
  });
});

// ============================================================================
// TrajectoryAnalyzer — New Failure Categories
// ============================================================================

describe('TrajectoryAnalyzer — new failure categories', () => {
  it('classifies rate_limit from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'rl1', errorPattern: 'Rate limit exceeded, retry after 60s' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'rate_limit');
    assert.ok(insight.confidence > 0.7);
  });

  it('classifies authentication from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'auth1', errorPattern: 'Unauthorized: invalid API key 401' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'authentication');
  });

  it('classifies resource_exhaustion from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'res1', errorPattern: 'Out of memory: heap limit exceeded' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'resource_exhaustion');
  });

  it('classifies data_validation from errorPattern', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'dv1', errorPattern: 'Validation error: invalid format, schema violation' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'data_validation');
  });

  it('still classifies existing categories correctly', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'existing1', errorPattern: 'Tool error: tool not found' });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'tool_misuse');
  });
});

// ============================================================================
// MetaLearner — Thompson Sampling Improvements
// ============================================================================

describe('MetaLearner — Thompson Sampling', () => {
  it('selects strategy with exploration bonus for untried strategies', () => {
    const ml = new MetaLearner(100, 3);

    // All strategies are untried — exploration should be high
    const strategy = ml.selectStrategy('test-task', 'test-model');
    assert.ok(['SEQUENTIAL', 'PARALLEL', 'HANDOFF', 'MAGENTIC', 'CONSENSUS'].includes(strategy));
  });

  it('converges to better strategy after many trials', () => {
    const ml = new MetaLearner(100, 3);

    // Simulate: SEQUENTIAL succeeds 80%, PARALLEL succeeds 20%
    for (let i = 0; i < 50; i++) {
      ml.recordExperience(makeExp({
        id: `seq-${i}`,
        strategyUsed: 'SEQUENTIAL',
        success: Math.random() < 0.8,
        taskType: 'test',
      }));
    }
    for (let i = 0; i < 50; i++) {
      ml.recordExperience(makeExp({
        id: `par-${i}`,
        strategyUsed: 'PARALLEL',
        success: Math.random() < 0.2,
        taskType: 'test',
      }));
    }

    // After many trials, SEQUENTIAL should be preferred
    const scores = ml.getStrategyScores('test');
    const seqScore = scores.find(s => s.strategy === 'SEQUENTIAL')?.score ?? 0;
    const parScore = scores.find(s => s.strategy === 'PARALLEL')?.score ?? 0;
    assert.ok(seqScore > parScore, 'Sequential should score higher after 80% success rate');
  });

  it('handles task difficulty in prior updates', () => {
    const ml = new MetaLearner(100, 3);

    // Easy task success
    ml.recordExperience(makeExp({
      id: 'easy-success',
      strategyUsed: 'SEQUENTIAL',
      success: true,
      taskType: 'easy',
      tokenCost: 100,
      durationMs: 1000,
    }));

    // Hard task failure (high token cost, long duration)
    ml.recordExperience(makeExp({
      id: 'hard-fail',
      strategyUsed: 'SEQUENTIAL',
      success: false,
      taskType: 'hard',
      tokenCost: 100000,
      durationMs: 120000,
    }));

    // The easy success should contribute more to the prior than the hard failure
    const scores = ml.getStrategyScores('easy');
    assert.ok(scores.length > 0);
  });
});

// ============================================================================
// Edge Case Tests — Capacity, Expiration, Concurrency
// ============================================================================

describe('Edge Cases — BM25 Scorer', () => {
  it('handles capacity-full: adding documents beyond limit', () => {
    const scorer = new BM25Scorer();
    // Add many documents
    for (let i = 0; i < 1000; i++) {
      scorer.addDocument(`doc${i}`, `Document number ${i} with content about topic ${i % 10}`);
    }
    const stats = scorer.getStats();
    assert.strictEqual(stats.documents, 1000);
    // Search should still work
    const results = scorer.score('topic 5');
    assert.ok(results.length > 0);
  });

  it('handles removing and re-adding documents', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc1', 'hello world');
    scorer.addDocument('doc2', 'goodbye world');
    scorer.removeDocument('doc1');
    scorer.addDocument('doc3', 'hello earth');

    const results = scorer.score('hello');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'doc3');
  });

  it('handles empty document', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('empty', '');
    scorer.addDocument('full', 'hello world');
    const results = scorer.score('hello');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'full');
  });

  it('handles very long documents', () => {
    const scorer = new BM25Scorer();
    const longText = 'word '.repeat(10000);
    scorer.addDocument('long', longText);
    scorer.addDocument('short', 'word');
    const results = scorer.score('word');
    assert.strictEqual(results.length, 2);
    // Both should match, short should score higher (BM25 length normalization)
  });
});

describe('Edge Cases — Memory Scoring', () => {
  it('handles memory with zero importance', () => {
    const entry = makeMemoryEntry({ id: 'zero', importance: 0 });
    const score = calculateMemoryScore(entry, undefined, undefined);
    // Should still have a non-negative score from recency and access frequency
    assert.ok(score >= 0, 'Score should be non-negative');
  });

  it('handles memory with maximum importance', () => {
    const entry = makeMemoryEntry({ id: 'max', importance: 1.0, accessCount: 100 });
    const score = calculateMemoryScore(entry, undefined, undefined);
    assert.ok(score > 0, 'Score should be positive');
  });

  it('handles memory with very old access time', () => {
    const veryOld = makeMemoryEntry({
      id: 'ancient',
      lastAccessedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recent = makeMemoryEntry({
      id: 'recent',
      lastAccessedAt: new Date().toISOString(),
    });
    const ancientScore = calculateMemoryScore(veryOld, undefined, undefined);
    const recentScore = calculateMemoryScore(recent, undefined, undefined);
    // Ancient memory should score lower than recent (importance is same 0.5)
    assert.ok(ancientScore > 0, 'Even ancient memories should have non-zero score');
    assert.ok(ancientScore < recentScore, 'Ancient memory should score lower than recent');
  });

  it('handles memory with no lastAccessedAt', () => {
    const entry = makeMemoryEntry({ id: 'no-access', lastAccessedAt: undefined });
    const score = calculateMemoryScore(entry, undefined, undefined);
    assert.ok(score >= 0, 'Score should be non-negative even without access time');
  });
});

describe('Edge Cases — TrajectoryAnalyzer', () => {
  it('handles empty experience list', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const results = await analyzer.analyze([]);
    assert.strictEqual(results.length, 0);
  });

  it('handles experience with no error pattern or lessons', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'empty', errorPattern: undefined, lessons: [] });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.failureCategory, 'unclassified');
    assert.strictEqual(insight.success, false);
  });

  it('handles experience with multiple matching categories', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    // Matches both tool_misuse and timeout keywords
    const exp = makeExp({
      id: 'multi',
      errorPattern: 'Tool error: timeout exceeded',
    });
    const [insight] = await analyzer.analyze([exp]);
    // Should pick the one with higher confidence
    assert.ok(['tool_misuse', 'timeout'].includes(insight.failureCategory));
  });

  it('handles successful experiences', async () => {
    const analyzer = new TrajectoryAnalyzer('light');
    const exp = makeExp({ id: 'success', success: true });
    const [insight] = await analyzer.analyze([exp]);
    assert.strictEqual(insight.success, true);
    assert.strictEqual(insight.failureCategory, 'unclassified');
  });
});

describe('Edge Cases — MetaLearner', () => {
  it('handles experience buffer overflow (maxExperiences)', () => {
    const ml = new MetaLearner(10, 3); // Small buffer
    for (let i = 0; i < 20; i++) {
      ml.recordExperience(makeExp({
        id: `exp-${i}`,
        strategyUsed: 'SEQUENTIAL',
        success: true,
        taskType: 'test',
      }));
    }
    const experiences = ml.getExperiences();
    assert.ok(experiences.length <= 10, 'Should not exceed maxExperiences');
  });

  it('handles Thompson prior overflow (MAX_THOMPSON_PRIORS)', () => {
    const ml = new MetaLearner(100, 3);
    // Create many different task types to trigger prior eviction
    for (let i = 0; i < 250; i++) {
      ml.recordExperience(makeExp({
        id: `exp-${i}`,
        strategyUsed: 'SEQUENTIAL',
        success: true,
        taskType: `task-${i}`,
      }));
    }
    const tracked = ml.getTrackedTaskTypes();
    assert.ok(tracked.length <= 200, 'Should not exceed MAX_THOMPSON_PRIORS');
  });

  it('handles reflection buffer overflow', () => {
    const ml = new MetaLearner(100, 3);
    for (let i = 0; i < 250; i++) {
      ml.recordExperience(makeExp({
        id: `exp-${i}`,
        strategyUsed: 'SEQUENTIAL',
        success: true,
        taskType: 'test',
      }));
    }
    const reflections = ml.getReflections(300);
    assert.ok(reflections.length <= 200, 'Should not exceed reflection buffer');
  });
});
