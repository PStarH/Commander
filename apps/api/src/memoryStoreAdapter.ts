import type {
  MemoryStore,
  MemorySearchQuery,
  ProjectMemoryItem,
  ProjectMemoryOverview,
  ProjectMemorySearchOptions,
} from '@commander/core';

/**
 * Adapter that exposes project-level memory operations on top of the canonical
 * MemoryStore interface from @commander/core.
 *
 * This is the convergence layer recommended by the memory mechanism research:
 * API-layer semantics (list/overview/search/append) are implemented as a thin
 * translation over the core MemoryStore, eliminating the duplicated JSON-file
 * persistence paths in apps/api while keeping the HTTP/project DTO contract
 * stable during migration.
 */
export class ProjectMemoryStoreAdapter {
  constructor(private readonly store: MemoryStore) {}

  async list(projectId: string, limit?: number): Promise<ProjectMemoryItem[]> {
    const result = await this.store.search({ projectId, limit });
    return result.items.map((item) => this.toProjectMemoryItem(item));
  }

  async overview(projectId: string): Promise<ProjectMemoryOverview> {
    const stats = await this.store.getStats(projectId);
    return {
      totalItems: stats.totalItems,
      kindCounts: stats.byKind,
      topTags: stats.topTags.slice(0, 8),
      missionLinkedCount: 0, // store stats don't expose this; can be derived later
      agentLinkedCount: 0,
      latestCreatedAt: stats.newestItem,
    };
  }

  async search(
    projectId: string,
    options: ProjectMemorySearchOptions = {},
  ): Promise<ProjectMemoryItem[]> {
    const query: MemorySearchQuery = {
      projectId,
      kind: options.kind,
      tags: options.tags,
      query: options.query,
      limit: options.limit,
      minPriority: options.minPriority,
      minConfidence: options.minConfidence,
    };
    const result = await this.store.search(query);
    return result.items.map((item) => this.toProjectMemoryItem(item));
  }

  async append(
    input: Omit<
      ProjectMemoryItem,
      'id' | 'priority' | 'confidence' | 'lastAccessedAt' | 'createdAt'
    >,
  ): Promise<ProjectMemoryItem> {
    const item = await this.store.write({
      projectId: input.projectId,
      missionId: input.missionId,
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
      duration: input.duration,
      evidenceRefs: input.evidenceRefs,
    });
    return this.toProjectMemoryItem(item);
  }

  async update(
    projectId: string,
    id: string,
    updates: Pick<
      ProjectMemoryItem,
      'title' | 'content' | 'tags' | 'priority' | 'confidence' | 'expiresAt'
    >,
  ): Promise<ProjectMemoryItem | null> {
    const item = await this.store.update({ id, projectId, updates });
    return item ? this.toProjectMemoryItem(item) : null;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    return this.store.delete(id, projectId);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private toProjectMemoryItem(
    item: NonNullable<Awaited<ReturnType<MemoryStore['read']>>>,
  ): ProjectMemoryItem {
    return {
      id: item.id,
      projectId: item.projectId,
      missionId: item.missionId,
      agentId: item.agentId,
      kind: item.kind,
      duration: item.duration,
      title: item.title,
      content: item.content,
      // memory-index-* tags are the MemoryIndexManager's internal retrieval
      // keys (mirror lookups filter on them) — implementation detail, not
      // part of the user-facing project-memory surface.
      tags: item.tags.filter((tag) => !tag.startsWith('memory-index-')),
      priority: item.priority,
      confidence: item.confidence,
      createdAt: item.createdAt,
      lastAccessedAt: item.lastAccessedAt,
      expiresAt: item.expiresAt,
      evidenceRefs: item.evidenceRefs,
    };
  }
}
