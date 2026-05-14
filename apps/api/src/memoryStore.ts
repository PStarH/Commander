import fs from 'fs';
import path from 'path';
import { ProjectMemoryItem, ProjectMemoryKind, ProjectMemoryOverview } from '@commander/core';

const MEMORY_FILE = path.resolve(__dirname, '../data/project-memory.json');

export interface CreateProjectMemoryInput {
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: ProjectMemoryKind;
  title: string;
  content: string;
  tags?: string[];
}

export interface ProjectMemorySearchOptions {
  kind?: ProjectMemoryKind;
  tags?: string[];
  query?: string;
  limit?: number;
}

export class ProjectMemoryStore {
  private items: ProjectMemoryItem[];

  constructor(private readonly filePath = MEMORY_FILE) {
    this.items = this.load();
  }

  list(projectId: string, limit?: number): ProjectMemoryItem[] {
    return this.search(projectId, { limit });
  }

  overview(projectId: string): ProjectMemoryOverview {
    const items = this.items.filter(item => item.projectId === projectId);
    const kindCounts: Record<ProjectMemoryKind, number> = {
      DECISION: 0,
      ISSUE: 0,
      LESSON: 0,
      SUMMARY: 0,
    };

    const tagCounts = new Map<string, number>();

    for (const item of items) {
      kindCounts[item.kind] += 1;
      for (const tag of item.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count }));

    return {
      totalItems: items.length,
      kindCounts,
      topTags,
      missionLinkedCount: items.filter(item => Boolean(item.missionId)).length,
      agentLinkedCount: items.filter(item => Boolean(item.agentId)).length,
      latestCreatedAt: items[0]?.createdAt,
    };
  }

  search(projectId: string, options: ProjectMemorySearchOptions = {}): ProjectMemoryItem[] {
    const { kind, tags, query, limit } = options;

    let items = this.items.filter(item => item.projectId === projectId);

    if (kind) {
      items = items.filter(item => item.kind === kind);
    }

    if (tags && tags.length > 0) {
      items = items.filter(item => item.tags.some(tag => tags.includes(tag)));
    }

    if (query && query.trim()) {
      const needle = query.trim().toLowerCase();
      items = items.filter(item => {
        return (
          item.title.toLowerCase().includes(needle) ||
          item.content.toLowerCase().includes(needle) ||
          item.tags.some(tag => tag.toLowerCase().includes(needle))
        );
      });
    }

    items = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return items.slice(0, limit);
    }

    return items;
  }

  append(input: CreateProjectMemoryInput): ProjectMemoryItem {
    const now = new Date().toISOString();
    const item: ProjectMemoryItem = {
      id: this.nextId('memory'),
      projectId: input.projectId,
      missionId: input.missionId,
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: now,
    };

    this.items.unshift(item);
    this.persist();
    return item;
  }

  private load(): ProjectMemoryItem[] {
    if (!fs.existsSync(this.filePath)) {
      this.write([]);
      return [];
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as ProjectMemoryItem[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [];
    } catch {
      return [];
    }
  }

  private persist() {
    this.write(this.items);
  }

  private write(items: ProjectMemoryItem[]) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2));
  }

  private nextId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
