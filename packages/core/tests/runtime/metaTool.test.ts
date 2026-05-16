import { describe, it, expect } from 'vitest';
import { MetaTool, getBuiltinMetaSpecs, findMatchingMetaSpec } from '../../src/tools/metaTool';

describe('MetaTool', () => {
  it('creates a valid tool definition from a spec', () => {
    const subToolMap = new Map();
    subToolMap.set('web_search', async (args) => `Search results for ${args.query}`);
    subToolMap.set('web_fetch', async (args) => `Content from ${args.url}`);

    const spec = {
      sequence: ['web_search', 'web_fetch'],
      name: 'research_topic',
      description: 'Search and fetch',
      steps: [
        { toolName: 'web_search', argumentMap: { query: 'query' } },
        { toolName: 'web_fetch', argumentMap: { url: 'url' } },
      ],
    };

    const meta = new MetaTool(spec, subToolMap);
    expect(meta.definition.name).toBe('research_topic');
    expect(meta.definition.description).toBe('Search and fetch');
    expect(meta.definition.inputSchema.properties).toHaveProperty('query');
    expect(meta.definition.inputSchema.properties).toHaveProperty('url');
  });

  it('executes sub-tools in sequence', async () => {
    const executionLog: string[] = [];
    const subToolMap = new Map();
    subToolMap.set('web_search', async (args) => {
      executionLog.push(`search:${args.query}`);
      return `Result URL: https://example.com`;
    });
    subToolMap.set('web_fetch', async (args) => {
      executionLog.push(`fetch:${args.url}`);
      return `Page content`;
    });

    const spec = {
      sequence: ['web_search', 'web_fetch'],
      name: 'research_topic',
      description: '',
      steps: [
        { toolName: 'web_search', argumentMap: { query: 'query' } },
        { toolName: 'web_fetch', argumentMap: { url: 'url' } },
      ],
    };

    const meta = new MetaTool(spec, subToolMap);
    await meta.execute({ query: 'AI news', url: 'https://example.com' });

    expect(executionLog).toEqual([
      'search:AI news',
      'fetch:https://example.com',
    ]);
  });

  it('handles missing sub-tools gracefully', async () => {
    const subToolMap = new Map();
    const spec = {
      sequence: ['nonexistent_tool'],
      name: 'broken_meta',
      description: '',
      steps: [{ toolName: 'nonexistent_tool', argumentMap: {} }],
    };

    const meta = new MetaTool(spec, subToolMap);
    const result = await meta.execute({});
    expect(result).toContain('SKIPPED');
  });

  it('tracks usage count', async () => {
    const subToolMap = new Map();
    subToolMap.set('web_search', async () => 'results');
    subToolMap.set('web_fetch', async () => 'content');

    const spec = {
      sequence: ['web_search', 'web_fetch'],
      name: 'counter_test',
      description: '',
      steps: [
        { toolName: 'web_search', argumentMap: { query: 'query' } },
        { toolName: 'web_fetch', argumentMap: { url: 'url' } },
      ],
    };

    const meta = new MetaTool(spec, subToolMap);
    expect(meta.getUsageCount()).toBe(0);
    await meta.execute({ query: 'test', url: 'http://example.com' });
    expect(meta.getUsageCount()).toBe(1);
  });
});

describe('getBuiltinMetaSpecs', () => {
  it('returns predefined specs', () => {
    const specs = getBuiltinMetaSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(3);
    const names = specs.map(s => s.name);
    expect(names).toContain('research_topic');
    expect(names).toContain('find_and_read');
    expect(names).toContain('research_and_save');
  });

  it('each spec has valid steps', () => {
    const specs = getBuiltinMetaSpecs();
    for (const spec of specs) {
      expect(spec.sequence.length).toBeGreaterThan(0);
      expect(spec.steps.length).toBe(spec.sequence.length);
      for (let i = 0; i < spec.steps.length; i++) {
        expect(spec.steps[i].toolName).toBe(spec.sequence[i]);
      }
    }
  });
});

describe('findMatchingMetaSpec', () => {
  it('matches exact sequences', () => {
    const match = findMatchingMetaSpec(
      ['web_search', 'web_fetch'],
      1,
      () => 5,
    );
    expect(match).toBeDefined();
    expect(match!.name).toBe('research_topic');
  });

  it('returns undefined for unknown sequences', () => {
    const match = findMatchingMetaSpec(
      ['unknown_tool'],
      1,
      () => 100,
    );
    expect(match).toBeUndefined();
  });

  it('returns undefined for below-minimum frequency', () => {
    const match = findMatchingMetaSpec(
      ['web_search', 'web_fetch'],
      10,
      () => 3,
    );
    expect(match).toBeUndefined();
  });
});
