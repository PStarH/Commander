import { getGlobalLogger } from '../logging';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { wireGlobalThreeLayerMemory } from '../threeLayerMemory';
import type {
  MemoryStore,
  EpisodicMemoryItem,
  MemoryKind,
  MemoryDuration,
} from '../episodicMemory';
import { getUnifiedMemory } from './unifiedMemory';
import { InMemoryMemoryService } from './inMemoryMemoryService';
import { MemoryStoreFacade } from './memoryStoreFacade';
import { PostgresMemoryService } from './postgresMemoryService';
import type { MemoryRetentionPolicy } from './memoryService';

export type MemoryStoreType = 'postgres' | 'in-memory';

export interface MemoryBootstrapOptions {
  basePath?: string;
  /** PostgreSQL connection string for the canonical production service. */
  connectionString?: string;
  /** Retention policy applied by the canonical service. */
  retention?: MemoryRetentionPolicy;
  /** Explicit scope used by test/bootstrap callers that are outside a request context. */
  tenantId?: string;
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
  if (env === 'postgres' || env === 'in-memory') return env;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return 'in-memory';
  }
  if (process.env.COMMANDER_POSTGRES_URL || process.env.DATABASE_URL) return 'postgres';
  // Local-First (CLAUDE.md §4/§6): without an explicit Postgres DSN, fall back
  // to the in-memory store rather than crashing. Postgres remains an explicit
  // opt-in via COMMANDER_MEMORY_STORE=postgres or a DSN — it is not forced.
  getGlobalLogger().warn(
    'memory',
    'No Postgres DSN configured; using in-memory store. Set COMMANDER_POSTGRES_URL or COMMANDER_MEMORY_STORE=postgres for durable persistence.',
  );
  return 'in-memory';
}

export async function createMemoryStore(
  type: MemoryStoreType = 'in-memory',
  options?: MemoryBootstrapOptions,
): Promise<MemoryStore> {
  switch (type) {
    case 'in-memory': {
      return new MemoryStoreFacade(
        new InMemoryMemoryService({ retention: options?.retention }),
        options?.tenantId ?? getCurrentTenantId,
      );
    }
    case 'postgres': {
      const service = new PostgresMemoryService({
        connectionString:
          options?.connectionString ??
          process.env.COMMANDER_POSTGRES_URL ??
          process.env.DATABASE_URL,
        retention: options?.retention,
      });
      await service.initialize();
      return new MemoryStoreFacade(service);
    }
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
