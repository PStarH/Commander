import { describe, it, expect, beforeEach } from 'vitest';
import {
  BM25Scorer,
  BM25ToolDiscovery,
  getBM25ToolDiscovery,
  resetBM25ToolDiscovery,
} from '../../src/runtime/bm25ToolDiscovery';
import type { ToolDefinition } from '../../src/runtime/types';

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: overrides.name,
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  } as ToolDefinition;
}

describe('BM25Scorer', () => {
  let scorer: BM25Scorer;

  beforeEach(() => {
    scorer = new BM25Scorer();
  });

  it('returns empty results when no documents are indexed', () => {
    expect(scorer.score('search query')).toEqual([]);
    expect(scorer.size).toBe(0);
  });

  it('indexes documents and ranks them by relevance', () => {
    scorer.addDocument('read_file', 'read file contents from disk filesystem');
    scorer.addDocument('write_file', 'write file contents to disk filesystem');
    scorer.addDocument('search_web', 'search the web for information online');

    const results = scorer.score('read a file from the filesystem');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('read_file');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('filters out non-matching documents', () => {
    scorer.addDocument('weather', 'get current weather conditions');
    const results = scorer.score('database query sql');
    expect(results).toEqual([]);
  });

  it('updates average document length as documents are added', () => {
    scorer.addDocument('a', 'one two');
    scorer.addDocument('b', 'one two three four');
    expect(scorer.size).toBe(2);
    const results = scorer.score('one');
    expect(results.length).toBe(2);
  });

  it('clears all indexed documents', () => {
    scorer.addDocument('tool', 'description');
    scorer.clear();
    expect(scorer.size).toBe(0);
    expect(scorer.score('description')).toEqual([]);
  });
});

describe('BM25ToolDiscovery', () => {
  let discovery: BM25ToolDiscovery;

  beforeEach(() => {
    discovery = new BM25ToolDiscovery();
  });

  it('registers a single tool and exposes it', () => {
    discovery.registerTool(makeTool({ name: 'read_file', description: 'read file contents' }));
    expect(discovery.size).toBe(1);
    expect(discovery.getRegisteredTools()).toContain('read_file');
  });

  it('registers multiple tools', () => {
    discovery.registerTools([
      makeTool({ name: 'read_file', description: 'read file' }),
      makeTool({ name: 'write_file', description: 'write file' }),
    ]);
    expect(discovery.size).toBe(2);
  });

  it('discovers relevant tools not already active', () => {
    // Register enough dummy tools so that a rare term gets a high IDF score.
    for (let i = 0; i < 10; i++) {
      discovery.registerTool(makeTool({ name: `dummy_${i}`, description: `dummy tool ${i}` }));
    }
    discovery.registerTool(
      makeTool({ name: 'fetch_url', description: 'uniqueterm uniqueterm uniqueterm' }),
    );
    discovery.registerTool(makeTool({ name: 'read_file', description: 'read local files' }));

    const active = new Set<string>(['read_file']);
    const activations = discovery.discover('uniqueterm', active);

    expect(activations.length).toBe(1);
    expect(activations[0].toolName).toBe('fetch_url');
    expect(activations[0].score).toBeGreaterThanOrEqual(2);
  });

  it('does not activate tools below the score threshold', () => {
    discovery.registerTool(makeTool({ name: 'weather', description: 'get weather' }));
    const activations = discovery.discover('completely unrelated task', new Set());
    expect(activations).toEqual([]);
  });

  it('does not re-activate already activated tools', () => {
    for (let i = 0; i < 10; i++) {
      discovery.registerTool(makeTool({ name: `dummy_${i}`, description: `dummy tool ${i}` }));
    }
    discovery.registerTool(
      makeTool({ name: 'search_web', description: 'search web uniqueterm uniqueterm' }),
    );
    const first = discovery.discover('uniqueterm', new Set());
    expect(first.length).toBe(1);

    const second = discovery.discover('uniqueterm', new Set());
    expect(second).toEqual([]);
  });

  it('respects maxActivations limit', () => {
    for (let i = 0; i < 10; i++) {
      discovery.registerTool(makeTool({ name: `dummy_${i}`, description: `dummy tool ${i}` }));
    }
    discovery.registerTool(
      makeTool({ name: 'tool_a', description: 'uniqueterm uniqueterm uniqueterm' }),
    );
    discovery.registerTool(
      makeTool({ name: 'tool_b', description: 'uniqueterm uniqueterm uniqueterm' }),
    );
    discovery.registerTool(
      makeTool({ name: 'tool_c', description: 'uniqueterm uniqueterm uniqueterm' }),
    );

    const activations = discovery.discover('uniqueterm', new Set(), 2);
    expect(activations.length).toBe(2);
  });

  it('skips active tools in the discovery result', () => {
    for (let i = 0; i < 10; i++) {
      discovery.registerTool(makeTool({ name: `dummy_${i}`, description: `dummy tool ${i}` }));
    }
    discovery.registerTool(
      makeTool({ name: 'search_web', description: 'search web uniqueterm uniqueterm' }),
    );
    const activations = discovery.discover('uniqueterm', new Set(['search_web']));
    expect(activations).toEqual([]);
  });

  it('returns activated tools', () => {
    for (let i = 0; i < 10; i++) {
      discovery.registerTool(makeTool({ name: `dummy_${i}`, description: `dummy tool ${i}` }));
    }
    discovery.registerTool(
      makeTool({ name: 'search_web', description: 'search web uniqueterm uniqueterm' }),
    );
    discovery.discover('uniqueterm', new Set());
    expect(discovery.getActivatedTools()).toContain('search_web');
  });

  it('resets activation state without clearing registrations', () => {
    discovery.registerTool(makeTool({ name: 'search_web', description: 'search the web' }));
    discovery.discover('search the web', new Set());
    discovery.resetActivations();
    expect(discovery.getActivatedTools()).toEqual([]);
    expect(discovery.getRegisteredTools()).toContain('search_web');
  });

  it('clears all state', () => {
    discovery.registerTool(makeTool({ name: 'search_web', description: 'search the web' }));
    discovery.discover('search the web', new Set());
    discovery.clear();
    expect(discovery.size).toBe(0);
    expect(discovery.getRegisteredTools()).toEqual([]);
    expect(discovery.getActivatedTools()).toEqual([]);
  });
});

describe('BM25ToolDiscovery singleton', () => {
  it('returns the same global instance', () => {
    resetBM25ToolDiscovery();
    const a = getBM25ToolDiscovery();
    const b = getBM25ToolDiscovery();
    expect(a).toBe(b);
  });

  it('reset creates a new instance on next access', () => {
    resetBM25ToolDiscovery();
    const a = getBM25ToolDiscovery();
    resetBM25ToolDiscovery();
    const b = getBM25ToolDiscovery();
    expect(a).not.toBe(b);
  });
});
