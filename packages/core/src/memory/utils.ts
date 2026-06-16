import { getGlobalLogger } from '../logging';
import type { MemoryStore, EpisodicMemoryItem, MemoryKind, MemoryDuration } from '../memory';
import { JsonMemoryStore } from './jsonStore';

export async function createMemoryStore(
  type: 'in-memory' | 'sqlite' | 'json' = 'in-memory',
): Promise<MemoryStore> {
  switch (type) {
    case 'in-memory': {
      const { InMemoryMemoryStore } = await import('../memory');
      return new InMemoryMemoryStore();
    }
    case 'sqlite': {
      try {
        const { SqliteMemoryStore } = await import('../runtime/sqliteMemoryStore');
        const store = new SqliteMemoryStore('.commander/memory.db');
        store.init().catch((err: Error) =>
          getGlobalLogger().warn('createMemoryStore', 'SqliteMemoryStore init failed', {
            error: err.message,
          }),
        );
        return store;
      } catch {
        getGlobalLogger().warn(
          'createMemoryStore',
          'SqliteMemoryStore not available, falling back to JSON store',
        );
        return new JsonMemoryStore('.commander/memory.json');
      }
    }
    case 'json':
      return new JsonMemoryStore('.commander/memory.json');
    default:
      throw new Error(`Unknown memory store type: ${type}`);
  }
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
