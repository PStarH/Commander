/**
 * Smoke tests for the skill extractor.
 *
 * SkillExtractor mines run traces for reusable skill patterns
 * (sequences of tool calls that achieve a goal).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillExtractor } from '../../src/intelligence/skillExtractor';

describe('SkillExtractor', () => {
  it('exports a class and a singleton accessor', async () => {
    assert.strictEqual(typeof SkillExtractor, 'function');
    const mod = await import('../../src/intelligence/skillExtractor');
    assert.strictEqual(typeof mod.getSkillExtractor, 'function');
    const instance = mod.getSkillExtractor();
    assert.ok(instance instanceof SkillExtractor);
  });

  it('extractSkills returns an array (possibly empty)', async () => {
    const { getSkillExtractor } = await import('../../src/intelligence/skillExtractor');
    const extractor = getSkillExtractor();
    const skills = extractor.extractSkills({
      runId: 'test-run',
      traces: [],
    });
    assert.ok(Array.isArray(skills));
  });
});
