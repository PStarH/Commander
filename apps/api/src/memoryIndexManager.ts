/**
 * Memory index facade.
 *
 * Domains are lightweight runtime metadata. Memory entries themselves are
 * stored exclusively by ProjectMemoryStoreAdapter, which delegates to the
 * tenant-scoped canonical MemoryService. This keeps the API's domain-oriented
 * endpoints without retaining a second JSON-file persistence owner.
 */
import type { ProjectMemoryKind } from '@commander/core';
import type { ProjectMemoryItem } from '@commander/core';
import { ProjectMemoryStoreAdapter } from './memoryStoreAdapter';

export interface MemoryPointer {
  domain: string;
  filePath: string;
  description: string;
  lastUpdated: string;
}

export interface MemoryDomainDefinition {
  domain: string;
  description: string;
}

export interface MemoryIndex {
  version: string;
  projectId: string;
  pointers: MemoryPointer[];
  lastReconciled?: string;
}

export interface DomainMemory {
  domain: string;
  entries: MemoryEntry[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    entryCount: number;
  };
}

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'decision' | 'context' | 'pattern' | 'preference' | 'issue' | 'lesson';
  title: string;
  content: string;
  tags: string[];
  importance?: number;
  accessCount?: number;
  lastAccessedAt?: string;
}

type MemoryEntryType = MemoryEntry['type'];

const DOMAIN_TAG_PREFIX = 'memory-index-domain:';
const TYPE_TAG_PREFIX = 'memory-index-type:';

function domainTag(domain: string): string {
  return `${DOMAIN_TAG_PREFIX}${domain}`;
}

function typeTag(type: MemoryEntryType): string {
  return `${TYPE_TAG_PREFIX}${type}`;
}

function isInternalTag(tag: string): boolean {
  return tag.startsWith(DOMAIN_TAG_PREFIX) || tag.startsWith(TYPE_TAG_PREFIX);
}

function typeToKind(type: MemoryEntryType): ProjectMemoryKind {
  switch (type) {
    case 'decision':
      return 'DECISION';
    case 'issue':
      return 'ISSUE';
    case 'lesson':
      return 'LESSON';
    case 'context':
    case 'pattern':
    case 'preference':
      return 'SUMMARY';
  }
}

function kindToType(item: ProjectMemoryItem): MemoryEntryType {
  const taggedType = item.tags.find((tag) => tag.startsWith(TYPE_TAG_PREFIX));
  if (taggedType) return taggedType.slice(TYPE_TAG_PREFIX.length) as MemoryEntryType;
  switch (item.kind) {
    case 'DECISION':
      return 'decision';
    case 'ISSUE':
      return 'issue';
    case 'LESSON':
      return 'lesson';
    case 'SUMMARY':
      return 'context';
  }
}

function toMemoryEntry(item: ProjectMemoryItem): MemoryEntry {
  return {
    id: item.id,
    timestamp: item.createdAt,
    type: kindToType(item),
    title: item.title,
    content: item.content,
    tags: item.tags.filter((tag) => !isInternalTag(tag)),
    importance: item.priority / 100,
    accessCount: 0,
    lastAccessedAt: item.lastAccessedAt,
  };
}

function toDomainMemory(domain: string, items: ProjectMemoryItem[]): DomainMemory {
  const entries = items.map(toMemoryEntry);
  const timestamps = entries.map((entry) => entry.timestamp).sort();
  return {
    domain,
    entries,
    metadata: {
      createdAt: timestamps[0] ?? new Date().toISOString(),
      updatedAt: timestamps.at(-1) ?? new Date().toISOString(),
      entryCount: entries.length,
    },
  };
}

export class MemoryIndexManager {
  private readonly index: MemoryIndex;
  private readonly bootstrapDomains: ReadonlyArray<Readonly<MemoryDomainDefinition>>;

  constructor(
    readonly projectId: string,
    private readonly projectMemoryAdapter: ProjectMemoryStoreAdapter,
    bootstrapDomains: readonly MemoryDomainDefinition[] = [],
  ) {
    this.bootstrapDomains = Object.freeze(
      bootstrapDomains.map((definition) => Object.freeze({ ...definition })),
    );
    this.index = { version: '2.0', projectId, pointers: [] };
    for (const { domain, description } of this.bootstrapDomains) {
      this.addDomain(domain, description);
    }
  }

  forProject(projectId: string): MemoryIndexManager {
    if (projectId === this.projectId) return this;

    return new MemoryIndexManager(projectId, this.projectMemoryAdapter, this.bootstrapDomains);
  }

  addDomain(domain: string, description: string): MemoryPointer {
    const existing = this.index.pointers.find((pointer) => pointer.domain === domain);
    if (existing) return existing;

    const pointer: MemoryPointer = {
      domain,
      filePath: `memory-service://${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(domain)}`,
      description,
      lastUpdated: new Date().toISOString(),
    };
    this.index.pointers.push(pointer);
    return pointer;
  }

  getPointer(domain: string): MemoryPointer | undefined {
    return this.index.pointers.find((pointer) => pointer.domain === domain);
  }

  listDomains(): MemoryPointer[] {
    return this.index.pointers.map((pointer) => ({ ...pointer }));
  }

  async readDomain(domain: string): Promise<DomainMemory | null> {
    if (!this.getPointer(domain)) return null;
    const items = await this.projectMemoryAdapter.search(this.projectId, {
      tags: [domainTag(domain)],
      limit: 500,
    });
    return toDomainMemory(domain, items);
  }

  async writeEntry(
    domain: string,
    entry: Omit<MemoryEntry, 'id' | 'timestamp'>,
  ): Promise<MemoryEntry | null> {
    const pointer = this.getPointer(domain);
    if (!pointer) return null;

    const current = await this.readDomain(domain);
    const existing = current?.entries.find(
      (candidate) =>
        candidate.type === entry.type &&
        candidate.title.toLowerCase().trim() === entry.title.toLowerCase().trim(),
    );
    const tags = [...new Set([...(entry.tags ?? []), domainTag(domain), typeTag(entry.type)])];
    const priority = Math.round((entry.importance ?? 0.5) * 100);

    if (existing) {
      const updated = await this.projectMemoryAdapter.update(this.projectId, existing.id, {
        title: entry.title,
        content: entry.content,
        tags,
        priority,
        confidence: 0.8,
        expiresAt: undefined,
      });
      if (updated) {
        pointer.lastUpdated = new Date().toISOString();
        return toMemoryEntry(updated);
      }
    }

    const item = await this.projectMemoryAdapter.append({
      projectId: this.projectId,
      kind: typeToKind(entry.type),
      title: entry.title,
      content: entry.content,
      tags,
      duration: 'LONG_TERM',
    });
    pointer.lastUpdated = new Date().toISOString();
    return toMemoryEntry(item);
  }

  async deleteEntry(domain: string, entryId: string): Promise<boolean> {
    if (!this.getPointer(domain)) return false;
    return this.projectMemoryAdapter.delete(this.projectId, entryId);
  }

  async search(
    query: string,
    options?: {
      domains?: string[];
      type?: MemoryEntryType;
      tags?: string[];
      limit?: number;
    },
  ): Promise<Array<{ domain: string; entry: MemoryEntry; score: number }>> {
    const domains = options?.domains ?? this.index.pointers.map((pointer) => pointer.domain);
    const results: Array<{ domain: string; entry: MemoryEntry; score: number }> = [];
    for (const domain of domains) {
      if (!this.getPointer(domain)) continue;
      const items = await this.projectMemoryAdapter.search(this.projectId, {
        query,
        tags: [domainTag(domain), ...(options?.tags ?? [])],
        limit: options?.limit ?? 20,
      });
      for (const item of items) {
        const entry = toMemoryEntry(item);
        if (options?.type && entry.type !== options.type) continue;
        results.push({ domain, entry, score: item.priority / 100 });
      }
    }
    return results.sort((left, right) => right.score - left.score).slice(0, options?.limit ?? 20);
  }

  async reconcile(): Promise<{ removed: number; merged: number }> {
    let removed = 0;
    for (const pointer of this.index.pointers) {
      const domain = await this.readDomain(pointer.domain);
      if (!domain) continue;
      const seen = new Set<string>();
      for (const entry of domain.entries) {
        const key = `${entry.type}:${entry.title.toLowerCase().trim()}`;
        if (seen.has(key) && (await this.deleteEntry(pointer.domain, entry.id))) removed++;
        else seen.add(key);
      }
    }
    this.index.lastReconciled = new Date().toISOString();
    return { removed, merged: removed };
  }
}

export const DEFAULT_DOMAINS = [
  { domain: 'Project Context', description: 'Project goals, constraints, architecture' },
  { domain: 'Decisions', description: 'Architectural decisions and rationale' },
  { domain: 'Patterns', description: 'Code patterns and conventions' },
  { domain: 'Preferences', description: 'User preferences and settings' },
  { domain: 'Issues', description: 'Known issues and workarounds' },
  { domain: 'Lessons', description: 'Lessons learned from iterations' },
];
