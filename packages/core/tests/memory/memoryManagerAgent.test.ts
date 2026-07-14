import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManagerAgent } from '../../src/memory/memoryManagerAgent';
import type { ISemanticStore, ISemanticEntity } from '../../src/contracts/pillarIV';

function createFakeSemanticStore(): ISemanticStore {
  const entities = new Map<string, ISemanticEntity>();
  let id = 0;
  return {
    ingest: async (entity) => {
      const e: ISemanticEntity = {
        id: `sem-${++id}`,
        ...entity,
      } as ISemanticEntity;
      entities.set(e.id, e);
      return e;
    },
    query: async (q) => {
      let results = Array.from(entities.values());
      if (q.text) {
        results = results.filter((e) =>
          `${e.name} ${e.description}`.toLowerCase().includes(q.text!.toLowerCase()),
        );
      }
      if (q.type) {
        results = results.filter((e) => e.type === q.type);
      }
      return results.slice(0, q.limit ?? 10);
    },
    traverse: async () => [],
  };
}

describe('MemoryManagerAgent', () => {
  let agent: MemoryManagerAgent;

  beforeEach(() => {
    agent = new MemoryManagerAgent({
      decisionMode: 'rule',
      importanceThreshold: 0.4,
      retentionLimit: 100,
      summarizationThreshold: 1000,
    });
  });

  describe('core actions', () => {
    it('stores a memory item', async () => {
      const result = await agent.observe({ content: 'User prefers dark mode' });
      expect(result.action).toBe('store');
      expect(result.result.id).toBeTruthy();
      const retrieved = await agent.retrieve({ content: 'dark mode' });
      expect(retrieved.length).toBeGreaterThan(0);
    });

    it('retrieves by content substring', async () => {
      await agent.observe({ content: 'Deploy to production' });
      await agent.observe({ content: 'Buy groceries' });
      const found = await agent.retrieve({ content: 'production' });
      expect(found.length).toBe(1);
      expect(found[0].content).toContain('production');
    });

    it('retrieves by tag', async () => {
      await agent.observe({ content: 'Critical alert', tags: ['ops'] });
      await agent.observe({ content: 'Note', tags: ['idea'] });
      const found = await agent.retrieve({ tags: ['ops'] });
      expect(found.length).toBe(1);
      expect(found[0].tags).toContain('ops');
    });

    it('updates an existing item', async () => {
      const { result } = await agent.observe({ content: 'User prefers light mode' });
      const updated = await agent.update(result.id, {
        content: 'User prefers dark mode',
        importance: 0.9,
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toContain('dark mode');
      expect(updated!.importance).toBe(0.9);
    });

    it('summarizes selected items into one memory', async () => {
      const a = await agent.observe({ content: 'Explored option A' });
      const b = await agent.observe({ content: 'Explored option B' });
      const summary = await agent.summarize([a.result.id, b.result.id], {
        title: 'Exploration summary',
      });
      expect(summary.content).toContain('Explored option A');
      expect(summary.content).toContain('Explored option B');
      expect(agent.retrieve({ content: 'Exploration summary' }).length).toBeGreaterThan(0);
    });

    it('discards an item', async () => {
      const { result } = await agent.observe({ content: 'Temporary note' });
      const ok = await agent.discard(result.id);
      expect(ok).toBe(true);
      expect(agent.retrieve({ content: 'Temporary note' })).toHaveLength(0);
    });
  });

  describe('decision policy', () => {
    it('rule mode treats query-like input as retrieve', async () => {
      await agent.observe({ content: 'Remember the milk', tags: ['todo'] });
      const result = await agent.observe({ content: 'query: milk' });
      expect(result.action).toBe('retrieve');
      expect(result.result.length).toBeGreaterThan(0);
    });

    it('rule mode stores temporal relation input', async () => {
      const result = await agent.observe({ content: 'Event A happened before Event B' });
      expect(result.action).toBe('store');
      const chain = agent.queryTemporalChain('A', 'B');
      expect(chain.length).toBeGreaterThanOrEqual(2);
      expect(chain[0].label).toContain('A');
      expect(chain[chain.length - 1].label).toContain('B');
    });

    it('llm mode uses custom policy', async () => {
      const llmAgent = new MemoryManagerAgent({
        decisionMode: 'llm',
        llmPolicy: async () => ({ action: 'discard', params: { id: 'unknown' } }),
      });
      const result = await llmAgent.observe({ content: 'anything' });
      expect(result.action).toBe('discard');
    });
  });

  describe('lifecycle rules', () => {
    it('discards low-importance items when retention limit exceeded', async () => {
      const constrained = new MemoryManagerAgent({
        decisionMode: 'rule',
        retentionLimit: 2,
        importanceThreshold: 0.1,
      });
      await constrained.observe({ content: 'One', importance: 0.2 });
      await constrained.observe({ content: 'Two', importance: 0.2 });
      await constrained.observe({ content: 'Three', importance: 0.2 });
      expect(constrained.size()).toBeLessThanOrEqual(2);
    });

    it('summarizes old memories when threshold reached', async () => {
      const summarizing = new MemoryManagerAgent({
        decisionMode: 'rule',
        summarizationThreshold: 2,
      });
      await summarizing.observe({
        content: 'First meeting notes',
        createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
      });
      const result = await summarizing.observe({
        content: 'Second meeting notes',
        createdAt: new Date(Date.now() - 86400000 * 6).toISOString(),
      });
      expect(result.action).toBe('summarize');
      expect(summarizing.getStats().summaries).toBeGreaterThan(0);
    });
  });

  describe('semantic memory integration', () => {
    it('ingests stored memories into the semantic store when provided', async () => {
      const semantic = createFakeSemanticStore();
      const integrated = new MemoryManagerAgent({ decisionMode: 'rule' }, semantic);
      await integrated.observe({ content: 'User likes TypeScript', tags: ['preference'] });
      const results = await semantic.query({ text: 'TypeScript' });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('temporal chain', () => {
    it('records explicit before relations and answers chain queries', async () => {
      agent.addTemporalEvent({ id: 'login', label: 'User logged in', timestamp: 1 });
      agent.addTemporalEvent({ id: 'purchase', label: 'User purchased', timestamp: 3 });
      agent.addTemporalRelation('login', 'purchase', 'before');
      const chain = agent.queryTemporalChain('login', 'purchase');
      expect(chain.map((e) => e.label)).toEqual(['User logged in', 'User purchased']);
    });
  });
});
