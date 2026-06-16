import { describe, it, expect } from 'vitest';
import { ReflexionInjector, createReflexionInjector } from '../../src/memory/reflexionInjector';

function makeReflection(overrides: Partial<Parameters<ReflexionInjector['addReflection']>[0]> = {}) {
  return {
    id: 'r-1',
    insight: 'keep it simple',
    type: 'success' as const,
    timestamp: 123,
    ...overrides,
  };
}

describe('ReflexionInjector', () => {
  it('constructor default config', () => {
    const injector = new ReflexionInjector();
    expect((injector as any).config).toEqual({
      maxReflections: 3,
      maxTokensPerReflection: 50,
      includeTaskType: true,
      filterByTaskType: false,
    });
  });

  it('constructor custom config', () => {
    const injector = new ReflexionInjector({
      maxReflections: 5,
      maxTokensPerReflection: 12,
      includeTaskType: false,
      filterByTaskType: true,
    });

    expect((injector as any).config).toEqual({
      maxReflections: 5,
      maxTokensPerReflection: 12,
      includeTaskType: false,
      filterByTaskType: true,
    });
  });

  it('addReflection() adds to buffer', () => {
    const injector = new ReflexionInjector();
    injector.addReflection(makeReflection({ id: 'r-1' }));

    expect(injector.size).toBe(1);
    expect(injector.getAll()).toHaveLength(1);
    expect(injector.getAll()[0].id).toBe('r-1');
  });

  it('addReflection() caps buffer at MAX_BUFFER (20)', () => {
    const injector = new ReflexionInjector();

    for (let i = 0; i < 21; i++) {
      injector.addReflection(makeReflection({ id: `r-${i}`, insight: `insight-${i}` }));
    }

    expect(injector.size).toBe(20);
    expect(injector.getAll()[0].id).toBe('r-1');
    expect(injector.getAll()[19].id).toBe('r-20');
  });

  it('getRecentReflections() returns most recent N entries', () => {
    const injector = new ReflexionInjector({ maxReflections: 3 });
    for (let i = 1; i <= 5; i++) {
      injector.addReflection(makeReflection({ id: `r-${i}`, insight: `insight-${i}` }));
    }

    expect(injector.getRecentReflections()).toEqual([
      expect.objectContaining({ id: 'r-3' }),
      expect.objectContaining({ id: 'r-4' }),
      expect.objectContaining({ id: 'r-5' }),
    ]);
    expect(injector.getRecentReflections(2).map((r) => r.id)).toEqual(['r-4', 'r-5']);
  });

  it('getRecentReflections() with limit=0 returns all (slice(-0) === slice(0))', () => {
    const injector = new ReflexionInjector();
    injector.addReflection(makeReflection());

    // Array.slice(-0) === Array.slice(0) → returns entire array
    expect(injector.getRecentReflections(0).length).toBe(1);
  });

  it('injectReflections() returns original prompt when reflections empty', () => {
    const injector = new ReflexionInjector();
    expect(injector.injectReflections('prompt text', [])).toBe('prompt text');
  });

  it('injectReflections() appends reflection text to prompt', () => {
    const injector = new ReflexionInjector();
    const prompt = 'Original prompt';
    const result = injector.injectReflections(prompt, [
      makeReflection({ insight: 'avoid overfitting', type: 'failure' }),
    ]);

    expect(result).toContain(prompt);
    expect(result).toContain('## 历史经验');
    expect(result).toContain('[失败教训] avoid overfitting');
    expect(result).toContain('基于以上经验，避免重复错误，利用成功模式。');
  });

  it('injectReflections() caps at maxReflections', () => {
    const injector = new ReflexionInjector({ maxReflections: 2 });
    const result = injector.injectReflections('Prompt', [
      makeReflection({ id: 'r-1', insight: 'first' }),
      makeReflection({ id: 'r-2', insight: 'second' }),
      makeReflection({ id: 'r-3', insight: 'third' }),
    ]);

    expect(result).toContain('[成功经验] first');
    expect(result).toContain('[成功经验] second');
    expect(result).not.toContain('third');
  });

  it('injectReflections() includes task type when includeTaskType=true', () => {
    const injector = new ReflexionInjector({ includeTaskType: true });
    const result = injector.injectReflections('Prompt', [
      makeReflection({ insight: 'keep going', taskType: 'coding' }),
    ]);

    expect(result).toContain('[成功经验 (coding)] keep going');
  });

  it('injectReflections() excludes task type when includeTaskType=false', () => {
    const injector = new ReflexionInjector({ includeTaskType: false });
    const result = injector.injectReflections('Prompt', [
      makeReflection({ insight: 'keep going', taskType: 'coding' }),
    ]);

    expect(result).toContain('[成功经验] keep going');
    expect(result).not.toContain('(coding)');
  });

  it('size getter returns buffer length', () => {
    const injector = new ReflexionInjector();
    expect(injector.size).toBe(0);
    injector.addReflection(makeReflection());
    expect(injector.size).toBe(1);
  });

  it('clear() empties buffer', () => {
    const injector = new ReflexionInjector();
    injector.addReflection(makeReflection());
    injector.clear();

    expect(injector.size).toBe(0);
    expect(injector.getAll()).toEqual([]);
  });

  it('getAll() returns copy of buffer', () => {
    const injector = new ReflexionInjector();
    injector.addReflection(makeReflection({ id: 'r-1' }));

    const all = injector.getAll();
    all.push(makeReflection({ id: 'r-2' }));

    expect(all).toHaveLength(2);
    expect(injector.size).toBe(1);
    expect(injector.getAll().map((r) => r.id)).toEqual(['r-1']);
  });

  it('createReflexionInjector() convenience function works', () => {
    const injector = createReflexionInjector({ maxReflections: 4 });

    expect(injector).toBeInstanceOf(ReflexionInjector);
    expect((injector as any).config.maxReflections).toBe(4);
  });

  it('extractInsight() truncates long text to maxTokensPerReflection', () => {
    const injector = new ReflexionInjector({ maxTokensPerReflection: 5 });
    const text = '[Reflection: SUCCESS]\nTask Type: coding\n' + 'a'.repeat(40) + 'b'.repeat(40);

    const insight = (injector as any).extractInsight(text);

    expect(insight).toBe('a'.repeat(20) + '...');
  });

  it('extractTaskType() extracts type from text', () => {
    const injector = new ReflexionInjector();
    expect((injector as any).extractTaskType('Task Type: debugging\nSomething else')).toBe('debugging');
    expect((injector as any).extractTaskType('no type here')).toBeUndefined();
  });
});
