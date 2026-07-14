import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import { wireGlobalThreeLayerMemory } from '../threeLayerMemory';
import type { MemoryStore, EpisodicMemoryItem, MemoryKind, MemoryDuration } from '../episodicMemory';
import { JsonMemoryStore } from './jsonStore';
import { getUnifiedMemory } from './unifiedMemory';

export type MemoryStoreType = 'in-memory' | 'sqlite' | 'json';

export interface MemoryBootstrapOptions {
  /** Base directory for json store or parent dir for sqlite file. */
  basePath?: string;
}

/**
 * Resolve which MemoryStore backend to use.
 * Explicit config wins, then COMMANDER_MEMORY_STORE env, then test-safe default.
 */
export function resolveMemoryStoreType(config?: {
  memoryStoreType?: MemoryStoreType;
}): MemoryStoreType {
  if (config?.memoryStoreType) return config.memoryStoreType;
  const env = process.env.COMMANDER_MEMORY_STORE;
  if (env === 'sqlite' || env === 'json' || env === 'in-memory') return env;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return 'in-memory';
  }
  return 'json';
}

export async function createMemoryStore(
  type: MemoryStoreType = 'in-memory',
  options?: MemoryBootstrapOptions,
): Promise<MemoryStore> {
  switch (type) {
    case 'in-memory': {
      const { InMemoryMemoryStore } = await import('../memory');
      return new InMemoryMemoryStore();
    }
    case 'sqlite': {
      try {
        const { SqliteMemoryStore } = await import('./sqliteMemoryStore');
        const store = new SqliteMemoryStore(options?.basePath ?? '.commander/memory.db');
        await store.init();
        return store;
      } catch (err) {
        reportSilentFailure(err, 'utils:sqliteFallback');
        getGlobalLogger().warn(
          'createMemoryStore',
          'SqliteMemoryStore not available, falling back to JSON store',
        );
        return new JsonMemoryStore(options?.basePath ?? '.commander');
      }
    }
    case 'json':
      return new JsonMemoryStore(options?.basePath ?? '.commander');
    default:
      throw new Error(`Unknown memory store type: ${type}`);
  }
}

/**
 * Wire persistent memory into the runtime hot path:
 * MemoryStore → ThreeLayerMemory → UnifiedMemory.
 *
 * Idempotent per store instance — safe to call on every AgentRuntime boot.
 */
export async function bootstrapMemoryPersistence(
  type: MemoryStoreType,
  options?: MemoryBootstrapOptions,
): Promise<MemoryStore> {
  const store = await createMemoryStore(type, options);
  wireGlobalThreeLayerMemory(store);
  const dataPath = options?.basePath ?? '.commander';
  await getUnifiedMemory({ dataPath }).init(store);
  getGlobalLogger().info('MemoryBootstrap', 'Persistent memory wired', {
    storeType: type,
    basePath: options?.basePath,
  });
  return store;
}

export function fromProjectMemoryItem(item: {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  duration?: MemoryDuration;
}): EpisodicMemoryItem {
  return {
    id: item.id,
    projectId: item.projectId,
    missionId: item.missionId,
    agentId: item.agentId,
    kind: item.kind,
    duration: item.duration ?? 'EPISODIC',
    title: item.title,
    content: item.content,
    tags: item.tags,
    priority: 50,
    createdAt: item.createdAt,
    lastAccessedAt: item.createdAt,
    confidence: 0.8,
  };
}

export function toProjectMemoryItem(item: EpisodicMemoryItem): {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  duration?: MemoryDuration;
} {
  return {
    id: item.id,
    projectId: item.projectId,
    missionId: item.missionId,
    agentId: item.agentId,
    kind: item.kind,
    title: item.title,
    content: item.content,
    tags: item.tags,
    createdAt: item.createdAt,
    duration: item.duration,
  };
}
