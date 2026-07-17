import { getCurrentTenantId } from '../runtime/tenantContext';
import type {
  EpisodicMemoryItem,
  MemoryManageOptions,
  MemoryMeta,
  MemorySearchQuery,
  MemorySearchResult as LegacyMemorySearchResult,
  MemoryStats,
  MemoryStore,
  MemoryWriteOptions,
} from '../episodicMemory';
import type {
  MemoryRecord,
  MemoryScope,
  MemoryService,
  MemoryServiceAudit,
  MemoryServiceMaintenance,
} from './memoryService';
import { assertMemoryScope, MemoryServiceValidationError } from './memoryService';

export type TenantResolver = string | (() => string | undefined);

function toLegacyItem(record: MemoryRecord): EpisodicMemoryItem {
  return {
    id: record.id,
    projectId: record.projectId,
    missionId: record.missionId,
    agentId: record.agentId,
    kind: record.kind,
    duration: record.duration,
    title: record.title,
    content: record.content,
    tags: [...record.tags],
    priority: record.priority,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    expiresAt: record.expiresAt,
    evidenceRefs: record.evidenceRefs ? [...record.evidenceRefs] : undefined,
    confidence: record.confidence,
    meta: record.meta as MemoryMeta | undefined,
  };
}

function toRecordInput(item: MemoryWriteOptions, scope: MemoryScope) {
  return {
    scope,
    id: item.id,
    missionId: item.missionId,
    agentId: item.agentId,
    kind: item.kind,
    duration: item.duration,
    title: item.title,
    content: item.content,
    tags: item.tags,
    priority: item.priority,
    confidence: item.confidence,
    evidenceRefs: item.evidenceRefs,
    meta: item.meta as Record<string, unknown> | undefined,
    namespaceAcl: item.namespaceAcl,
  };
}

export class MemoryStoreFacade implements MemoryStore {
  constructor(
    private readonly service: MemoryService,
    private readonly tenant: TenantResolver = getCurrentTenantId,
  ) {}

  /** Product durable write — prefer writeProductMemory() at call sites (L3-10a). */
  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    const scope = this.scope(options.projectId, options.agentId);
    return toLegacyItem(await this.service.store(toRecordInput(options, scope)));
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const written: EpisodicMemoryItem[] = [];
    for (const item of items) written.push(await this.write(item));
    return written;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const scope = this.scope(options.projectId);
    const current = await this.service.retrieve({ scope, id: options.id });
    if (!current) return null;
    if (options.delete) {
      await this.service.forget({ scope, id: options.id });
      return null;
    }
    const updates = options.updates ?? {};
    const updated = await this.service.store({
      scope,
      id: current.id,
      missionId: current.missionId,
      agentId: current.agentId,
      kind: current.kind,
      duration: current.duration,
      title: current.title,
      content: current.content,
      tags: updates.tags ?? current.tags,
      priority: updates.priority ?? current.priority,
      confidence: updates.confidence ?? current.confidence,
      lastAccessedAt: updates.lastAccessedAt ?? current.lastAccessedAt,
      expiresAt: updates.expiresAt ?? current.expiresAt,
      evidenceRefs: current.evidenceRefs,
      meta: current.meta,
    });
    return toLegacyItem(updated);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const scope = this.scope(projectId);
    return this.service.forget({ scope, id });
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    const scope = this.scope(projectId);
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await this.service.list({ scope, missionId, cursor, limit: 500 });
      count += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    if (count === 0) return 0;
    return (await this.service.forget({ scope, missionId })) ? count : 0;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const scope = this.scope(projectId);
    const maintenance = this.service as MemoryService & Partial<MemoryServiceMaintenance>;
    if (typeof maintenance.purgeExpired !== 'function') {
      throw new Error('MemoryService does not provide scoped retention maintenance');
    }
    return maintenance.purgeExpired(scope);
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const scope = this.scope(projectId);
    const item = await this.service.retrieve({ scope, id });
    return item ? toLegacyItem(item) : null;
  }

  async search(query: MemorySearchQuery): Promise<LegacyMemorySearchResult> {
    const scope = this.scope(query.projectId, query.agentId ?? query.readerAgentId);
    const result = await this.service.search({
      scope,
      query: query.query,
      kind: query.kind,
      missionId: query.missionId,
      agentId: query.agentId,
      tags: query.tags,
      limit: query.limit,
      minPriority: query.minPriority,
      minConfidence: query.minConfidence,
    });
    return {
      items: result.items.map(toLegacyItem),
      total: result.total,
      query,
    };
  }

  async searchSemantic(
    query: string,
    projectId: string,
    limit = 10,
  ): Promise<EpisodicMemoryItem[]> {
    const scope = this.scope(projectId);
    const result = await this.service.search({ scope, query, mode: 'semantic', limit });
    return result.items.map(toLegacyItem);
  }

  async getStats(projectId: string): Promise<MemoryStats> {
    const scope = this.scope(projectId);
    const records: MemoryRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.service.list({ scope, cursor, limit: 500 });
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    const byKind = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 } as MemoryStats['byKind'];
    const byDuration = { EPISODIC: 0, LONG_TERM: 0 } as MemoryStats['byDuration'];
    const tagCounts = new Map<string, number>();
    let priorityTotal = 0;
    let confidenceTotal = 0;
    for (const record of records) {
      byKind[record.kind]++;
      byDuration[record.duration]++;
      priorityTotal += record.priority;
      confidenceTotal += record.confidence;
      for (const tag of record.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    return {
      totalItems: records.length,
      byKind,
      byDuration,
      avgPriority: records.length ? priorityTotal / records.length : 0,
      avgConfidence: records.length ? confidenceTotal / records.length : 0,
      topTags: [...tagCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([tag, count]) => ({ tag, count })),
      oldestItem: records.map((record) => record.createdAt).sort()[0],
      newestItem: records
        .map((record) => record.createdAt)
        .sort()
        .at(-1),
    };
  }

  async queryAudit(options: {
    projectId: string;
    namespace?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{
      id: string;
      tenantId: string;
      projectId: string;
      memoryId?: string;
      action: string;
      actorId?: string;
      success: boolean;
      createdAt: string;
      tags?: string[];
    }>;
    count: number;
    unavailable: boolean;
  }> {
    const audit = this.service as MemoryService & Partial<MemoryServiceAudit>;
    if (typeof audit.queryAudit !== 'function') {
      return { entries: [], count: 0, unavailable: true };
    }
    const scope = this.scope(options.projectId);
    const page = await audit.queryAudit({
      scope,
      namespace: options.namespace,
      limit: options.limit,
    });
    return { entries: page.entries, count: page.count, unavailable: false };
  }

  async close(): Promise<void> {
    await this.service.close();
  }

  private scope(projectId: string, agentId?: string): MemoryScope {
    const tenantId = typeof this.tenant === 'string' ? this.tenant : this.tenant();
    if (!tenantId) throw new MemoryServiceValidationError('tenant context is required');
    const scope = { tenantId, projectId, ...(agentId ? { agentId } : {}) };
    assertMemoryScope(scope);
    return scope;
  }
}
