import type { MemoryStore, EpisodicMemoryItem } from '../episodicMemory';
import { InMemoryMemoryService } from '../memory/inMemoryMemoryService';
import { MemoryStoreFacade } from '../memory/memoryStoreFacade';

/**
 * Normalized score for a single benchmark suite.
 * Scores are kept in [0, 1] so that suites are comparable and aggregable.
 */
export interface MemoryBenchmarkResult {
  name: string;
  score: number;
  details: Record<string, number>;
}

export interface MemoryBenchmarkSuite {
  name: string;
  run(store: MemoryStore): Promise<MemoryBenchmarkResult>;
}

/** Internal helper to keep benchmark code concise. */
function findRank(
  items: EpisodicMemoryItem[],
  predicate: (item: EpisodicMemoryItem) => boolean,
): number {
  const idx = items.findIndex(predicate);
  return idx === -1 ? items.length : idx;
}

/**
 * Retrieval benchmark: after writing two semantically distinct memories,
 * a query should surface the relevant item in the top results.
 *
 * Mirrors the "Accurate Retrieval" capability from MemoryAgentBench.
 */
export const retrievalBenchmark: MemoryBenchmarkSuite = {
  name: 'retrieval',
  async run(store) {
    await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'auth flow',
      content: 'Use OAuth2 PKCE for mobile auth',
      tags: ['auth'],
      duration: 'LONG_TERM',
    });
    await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'db config',
      content: 'Enable WAL mode for SQLite',
      tags: ['db'],
      duration: 'LONG_TERM',
    });

    const result = await store.search({ projectId: 'benchmark', query: 'PKCE', limit: 5 });
    const hit = result.items.some((item) => item.content.includes('PKCE'));
    const rank = findRank(result.items, (item) => item.content.includes('PKCE'));

    return {
      name: 'retrieval',
      score: hit ? 1 / (1 + rank) : 0,
      details: { topRank: rank, total: result.total },
    };
  },
};

/**
 * Test-time learning benchmark: a memory written after an initial mistake
 * should be retrievable and improve the corpus coverage for a follow-up query.
 */
export const testTimeLearningBenchmark: MemoryBenchmarkSuite = {
  name: 'test-time-learning',
  async run(store) {
    await store.write({
      projectId: 'benchmark',
      kind: 'DECISION',
      title: 'initial plan',
      content: 'Use basic password auth',
      tags: ['auth'],
      duration: 'LONG_TERM',
    });
    await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'correction',
      content: 'Switch to OAuth2 PKCE for mobile clients',
      tags: ['auth'],
      duration: 'LONG_TERM',
    });

    const result = await store.search({
      projectId: 'benchmark',
      query: 'mobile auth best practice',
      limit: 5,
    });
    const learned = result.items.some((item) => item.content.includes('PKCE'));

    return {
      name: 'test-time-learning',
      score: learned ? 1 : 0,
      details: { learned: learned ? 1 : 0 },
    };
  },
};

/**
 * Long-range understanding benchmark: a memory written early should still be
 * retrievable after many unrelated writes.
 */
export const longRangeBenchmark: MemoryBenchmarkSuite = {
  name: 'long-range',
  async run(store) {
    await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'foundational',
      content: 'The project naming convention is kebab-case',
      tags: ['convention'],
      duration: 'LONG_TERM',
    });

    for (let i = 0; i < 20; i++) {
      await store.write({
        projectId: 'benchmark',
        kind: 'LESSON',
        title: `filler ${i}`,
        content: `Unrelated note number ${i}`,
        tags: ['filler'],
        duration: 'EPISODIC',
      });
    }

    const result = await store.search({
      projectId: 'benchmark',
      query: 'naming convention',
      limit: 5,
    });
    const retained = result.items.some((item) => item.content.includes('kebab-case'));

    return {
      name: 'long-range',
      score: retained ? 1 : 0,
      details: { retained: retained ? 1 : 0 },
    };
  },
};

/**
 * Selective forgetting benchmark: expired episodic memories should be removable,
 * while long-term memories should remain.
 *
 * Mirrors the "Selective Forgetting" capability from MemoryAgentBench.
 */
export const forgettingBenchmark: MemoryBenchmarkSuite = {
  name: 'forgetting',
  async run(store) {
    const ephemeral = await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'temp',
      content: 'temporary note',
      tags: [],
      duration: 'EPISODIC',
    });

    await store.write({
      projectId: 'benchmark',
      kind: 'LESSON',
      title: 'permanent',
      content: 'permanent standard operating procedure',
      tags: [],
      duration: 'LONG_TERM',
    });

    await store.update({
      id: ephemeral.id,
      projectId: 'benchmark',
      updates: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });

    const removed = await store.deleteExpired('benchmark');
    const remaining = await store.search({ projectId: 'benchmark' });
    const keptPermanent = remaining.items.some((item) => item.duration === 'LONG_TERM');

    return {
      name: 'forgetting',
      score: removed >= 1 && keptPermanent ? 1 : 0,
      details: { removed, remaining: remaining.items.length },
    };
  },
};

export const DEFAULT_MEMORY_BENCHMARKS: MemoryBenchmarkSuite[] = [
  retrievalBenchmark,
  testTimeLearningBenchmark,
  longRangeBenchmark,
  forgettingBenchmark,
];

/**
 * Run the default memory benchmark suite against the provided store.
 * Returns one result per capability area.
 */
export async function runMemoryBenchmark(
  store: MemoryStore = new MemoryStoreFacade(new InMemoryMemoryService(), 'benchmark-tenant'),
): Promise<MemoryBenchmarkResult[]> {
  return Promise.all(DEFAULT_MEMORY_BENCHMARKS.map((suite) => suite.run(store)));
}

/**
 * Aggregate score across all benchmark suites.
 */
export function aggregateScore(results: MemoryBenchmarkResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.score, 0);
  return sum / results.length;
}
