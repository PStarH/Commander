import { describe, it, expect } from 'vitest';
import { CycleDetector } from '../../src/runtime/cycleDetector';

describe('CycleDetector', () => {
  it('returns not detected on first call', () => {
    const cd = new CycleDetector();
    const result = cd.check('read_file', { path: '/test' }, 1);
    expect(result.detected).toBe(false);
  });

  it('detects consecutive identical tool calls', () => {
    const cd = new CycleDetector({ maxConsecutiveSameTool: 3 });
    cd.check('read_file', { path: '/a' }, 1);
    cd.check('read_file', { path: '/a' }, 2);
    // 3rd call triggers detection (count=3 >= threshold=3)
    const result = cd.check('read_file', { path: '/a' }, 3);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('consecutive');
  });

  it('resets consecutive counter when tool changes', () => {
    const cd = new CycleDetector({ maxConsecutiveSameTool: 3 });
    cd.check('read_file', { path: '/a' }, 1);
    cd.check('read_file', { path: '/a' }, 2);
    cd.check('write_file', { path: '/b' }, 3); // different tool resets
    cd.check('read_file', { path: '/a' }, 4); // restart: count=1
    cd.check('read_file', { path: '/a' }, 5); // count=2
    // 6th call triggers detection: count=3 >= 3
    const result = cd.check('read_file', { path: '/a' }, 6);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('consecutive');
  });

  it('detects alternating pattern A-B-A-B-A-B', () => {
    const cd = new CycleDetector({ alternatingPatternWindow: 6 });
    cd.check('tool_a', {}, 1);
    cd.check('tool_b', {}, 2);
    cd.check('tool_a', {}, 3);
    cd.check('tool_b', {}, 4);
    cd.check('tool_a', {}, 5);
    const result = cd.check('tool_b', {}, 6);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('alternating');
  });

  it('does not detect alternating pattern with less than 4 calls', () => {
    const cd = new CycleDetector({ alternatingPatternWindow: 6 });
    cd.check('tool_a', {}, 1);
    cd.check('tool_b', {}, 2);
    const result = cd.check('tool_a', {}, 3);
    expect(result.detected).toBe(false);
  });

  it('does not detect alternating when tools are the same', () => {
    const cd = new CycleDetector({ alternatingPatternWindow: 6 });
    cd.check('tool_a', {}, 1);
    cd.check('tool_a', {}, 2);
    cd.check('tool_a', {}, 3);
    cd.check('tool_a', {}, 4);
    cd.check('tool_a', {}, 5);
    const result = cd.check('tool_a', {}, 6);
    expect(result.type).not.toBe('alternating');
  });

  it('detects drift pattern (same tool with same args many times)', () => {
    const cd = new CycleDetector({ maxDriftIterations: 3, maxConsecutiveSameTool: 10 });
    // Drift triggers when count >= maxDriftIterations (3), so 3rd call triggers
    cd.check('edit_file', { path: '/test' }, 1);
    cd.check('edit_file', { path: '/test' }, 2);
    const result = cd.check('edit_file', { path: '/test' }, 3);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('drift');
  });

  it('reset clears all state', () => {
    const cd = new CycleDetector({ maxConsecutiveSameTool: 2 });
    cd.check('read_file', {}, 1);
    cd.check('read_file', {}, 2);
    expect(cd.check('read_file', {}, 3).detected).toBe(true);

    cd.reset();
    expect(cd.check('read_file', {}, 1).detected).toBe(false);
    // After reset, count restarts: call2=count=2 which meets threshold=2
    expect(cd.check('read_file', {}, 2).detected).toBe(true);
  });

  it('getDebugInfo returns state information', () => {
    const cd = new CycleDetector();
    cd.check('tool_a', { x: 1 }, 1);
    cd.check('tool_b', { y: 2 }, 2);

    const info = cd.getDebugInfo();
    expect(info.historyLength).toBe(2);
    expect(info.lastToolName).toBe('tool_b');
    expect(info.consecutiveSameToolCount).toBe(1);
  });

  it('trims history when it grows too large', () => {
    const cd = new CycleDetector({ alternatingPatternWindow: 5 });
    // alternatingPatternWindow * 3 = 15 max
    for (let i = 0; i < 30; i++) {
      cd.check(`tool_${i % 2}`, {}, i + 1);
    }
    const info = cd.getDebugInfo();
    expect(info.historyLength).toBeLessThanOrEqual(15);
  });

  it('returns advice text in detection result', () => {
    const cd = new CycleDetector({ maxConsecutiveSameTool: 1 });
    const result = cd.check('stuck_tool', {}, 1);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.description).toContain('stuck_tool');
      expect(result.advice.length).toBeGreaterThan(10);
    }
  });

  it('handles empty args for drift detection', () => {
    const cd = new CycleDetector({ maxDriftIterations: 2, maxConsecutiveSameTool: 10 });
    cd.check('noop', {}, 1);
    cd.check('noop', {}, 2);
    const result = cd.check('noop', {}, 3);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('drift');
  });

  it('consecutive detection respects different tools interrupting', () => {
    const cd = new CycleDetector({ maxConsecutiveSameTool: 3 });
    cd.check('a', {}, 1);
    cd.check('a', {}, 2);
    cd.check('b', {}, 3); // interrupt
    cd.check('a', {}, 4);
    cd.check('a', {}, 5);
    cd.check('a', {}, 6); // 3 consecutive a's now (4,5,6)
    expect(cd.check('a', {}, 7).detected).toBe(true);
  });

  it('custom config values override defaults', () => {
    const cd = new CycleDetector({
      maxConsecutiveSameTool: 5,
      alternatingPatternWindow: 8,
      paramSimilarityThreshold: 0.5,
      maxDriftIterations: 10,
    });
    expect(cd.check('tool', {}, 1).detected).toBe(false);
  });

  describe('checkOutput — semantic stagnation', () => {
    it('returns not detected on first output', () => {
      const cd = new CycleDetector();
      expect(cd.checkOutput('hello world').detected).toBe(false);
    });

    it('returns not detected for different outputs', () => {
      const cd = new CycleDetector();
      cd.checkOutput('the quick brown fox jumps over the lazy dog');
      const result = cd.checkOutput('a completely different sentence about something else');
      expect(result.detected).toBe(false);
    });

    it('detects semantic stagnation on 3 similar outputs', () => {
      const cd = new CycleDetector();
      cd.checkOutput('the analysis shows the code needs refactoring for better performance');
      cd.checkOutput('the analysis shows the code needs refactoring for better performance');
      const result = cd.checkOutput(
        'the analysis shows the code needs refactoring for better performance',
      );
      expect(result.detected).toBe(true);
      expect(result.type).toBe('semantic_stagnation');
      if (result.detected) {
        expect(result.similarity).toBeGreaterThan(0.85);
      }
    });

    it('resets output history on cycleDetector.reset()', () => {
      const cd = new CycleDetector();
      cd.checkOutput('same output text repeated again and again');
      cd.checkOutput('same output text repeated again and again');
      cd.reset();
      const result = cd.checkOutput('same output text repeated again and again');
      expect(result.detected).toBe(false);
    });

    it('caps output history at maxOutputHistory', () => {
      const cd = new CycleDetector();
      for (let i = 0; i < 10; i++) {
        cd.checkOutput(`unique output number ${i} with different content`);
      }
      const info = cd.getDebugInfo();
      expect(info.historyLength).toBeLessThanOrEqual(15);
    });
  });

  describe('detectRepetition — character-level degeneration', () => {
    it('detects immediate phrase repetition (TheTheThe pattern)', () => {
      const text = 'TheTheTheTheTheTheTheTheTheTheTheThe service is down';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('semantic_stagnation');
      if (result.detected) {
        expect(result.similarity).toBeGreaterThan(0.9);
      }
    });

    it('detects word repetition with spaces (the the the the the)', () => {
      const text = 'The the the the the the the the the the the the the the the service is down';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(true);
    });

    it('detects phrase repetition (I willI willI will)', () => {
      const text = 'I willI willI willI willI willI willI willI willI will fix the issue now';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(true);
    });

    it('does NOT flag normal text', () => {
      const text =
        'The payment service is experiencing elevated latency. I recommend restarting the service and checking the database connection pool.';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(false);
    });

    it('does NOT flag text with minor repetition (false positive guard)', () => {
      const text = 'I went to the the store to buy milk and eggs for the recipe.';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(false);
    });

    it('does NOT flag short text (< 20 chars)', () => {
      const result = CycleDetector.detectRepetition('TheTheTheThe');
      expect(result.detected).toBe(false);
    });

    it('detects long token repetition (step step step step step)', () => {
      const text =
        'step step step step step step step step step step step step step step step done';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(true);
    });

    it('detects degeneration from benchmark data (long TheTheThe pattern)', () => {
      const text = 'The'.repeat(200) + ' — service is down';
      const result = CycleDetector.detectRepetition(text);
      expect(result.detected).toBe(true);
    });

    it('checkOutput integrates detectRepetition for degenerate text', () => {
      const cd = new CycleDetector();
      const degenerate = 'The'.repeat(100) + ' service is down';
      const result = cd.checkOutput(degenerate);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('semantic_stagnation');
    });

    it('checkOutput still works for semantic similarity (original behavior)', () => {
      const cd = new CycleDetector();
      cd.checkOutput('the analysis shows the code needs refactoring for better performance');
      cd.checkOutput('the analysis shows the code needs refactoring for better performance');
      const result = cd.checkOutput(
        'the analysis shows the code needs refactoring for better performance',
      );
      expect(result.detected).toBe(true);
      expect(result.type).toBe('semantic_stagnation');
    });
  });
});
