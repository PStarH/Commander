/**
 * Memory Index System
 * Based on Claude Code's three-layer memory architecture
 *
 * Architecture:
 * - Layer 1: In-Context Memory (active window) - handled by LLM
 * - Layer 2: memory/index.json (pointer index) - this module
 * - Layer 3: PROJECT.md (project-level config) - static
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface MemoryPointer {
  domain: string;
  filePath: string;
  description: string;
  lastUpdated: string;
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
  /** Importance score 0-1 for retrieval prioritization */
  importance?: number;
  /** Access count for frequency tracking */
  accessCount?: number;
  /** Last accessed timestamp */
  lastAccessedAt?: string;
}

/**
 * MemoryIndexManager persistence directory. Override `COMMANDER_MEMORY_INDEX`
 * to relocate the index + per-domain file directory (e.g. per-launcher in
 * parallel test scaffolding); default keeps the original
 * `__dirname/../../memory/` so production runs are untouched. The index file
 * path is derived as `path.join(MEMORY_DIR, 'index.json')`, so relocating
 * MEMORY_DIR also relocates the index. Env var must be set before this
 * module is required (module-load capture).
 */
const MEMORY_DIR =
  process.env['COMMANDER_MEMORY_INDEX'] ?? path.resolve(__dirname, '../../memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');

export class MemoryIndexManager {
  private index: MemoryIndex | null = null;

  constructor(private readonly projectId: string) {
    this.loadIndex();
  }

  /**
   * Get or create memory index
   */
  private loadIndex(): void {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }

    if (fs.existsSync(INDEX_FILE)) {
      try {
        const raw = fs.readFileSync(INDEX_FILE, 'utf8');
        this.index = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`[MemoryIndexManager] Error: ${(e as Error)?.message ?? String(e)}\n`);
        this.index = null;
      }
    }

    if (!this.index) {
      this.index = {
        version: '1.0',
        projectId: this.projectId,
        pointers: [],
      };
      this.persistIndex();
    }
  }

  /**
   * Add a new memory domain
   */
  addDomain(domain: string, description: string): MemoryPointer {
    const fileName = `${domain.toLowerCase().replace(/\s+/g, '-')}.json`;
    const filePath = path.join(MEMORY_DIR, fileName);

    const pointer: MemoryPointer = {
      domain,
      filePath: fileName,
      description,
      lastUpdated: new Date().toISOString(),
    };

    // Check if domain already exists
    const existing = this.index!.pointers.find((p) => p.domain === domain);
    if (existing) {
      return existing;
    }

    this.index!.pointers.push(pointer);
    this.persistIndex();

    // Initialize domain file if not exists
    if (!fs.existsSync(filePath)) {
      const domainMemory: DomainMemory = {
        domain,
        entries: [],
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entryCount: 0,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
    }

    return pointer;
  }

  /**
   * Get pointer for a domain
   */
  getPointer(domain: string): MemoryPointer | undefined {
    return this.index!.pointers.find((p) => p.domain === domain);
  }

  /**
   * List all domains
   */
  listDomains(): MemoryPointer[] {
    return this.index!.pointers;
  }

  /**
   * Read domain memory
   */
  readDomain(domain: string): DomainMemory | null {
    const pointer = this.getPointer(domain);
    if (!pointer) return null;

    const filePath = path.join(MEMORY_DIR, pointer.filePath);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`[MemoryIndexManager] Error: ${(e as Error)?.message ?? String(e)}\n`);
      return null;
    }
  }

  /**
   * Write entry to domain memory (self-healing: append, don't overwrite)
   */
  writeEntry(domain: string, entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry | null {
    const pointer = this.getPointer(domain);
    if (!pointer) return null;

    const filePath = path.join(MEMORY_DIR, pointer.filePath);
    const domainMemory = this.readDomain(domain) || {
      domain,
      entries: [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entryCount: 0,
      },
    };

    // Check for duplicates before writing
    const entryTitle = entry.title.toLowerCase().trim();
    const existing = domainMemory.entries.find(
      (e) => e.type === entry.type && e.title.toLowerCase().trim() === entryTitle,
    );

    if (existing) {
      // Update existing entry instead of creating duplicate
      existing.content = entry.content;
      existing.tags = [...new Set([...existing.tags, ...(entry.tags ?? [])])];
      existing.importance = Math.max(existing.importance ?? 0.5, entry.importance ?? 0.5);
      existing.lastAccessedAt = new Date().toISOString();
      domainMemory.metadata.updatedAt = new Date().toISOString();

      fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
      pointer.lastUpdated = new Date().toISOString();
      this.persistIndex();
      return existing;
    }

    const newEntry: MemoryEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
      importance: 0.5,
      ...entry,
    };

    domainMemory.entries.push(newEntry);
    domainMemory.metadata.updatedAt = new Date().toISOString();
    domainMemory.metadata.entryCount = domainMemory.entries.length;

    fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));

    // Update pointer
    pointer.lastUpdated = new Date().toISOString();
    this.persistIndex();

    return newEntry;
  }

  /**
   * Delete entry from domain memory
   */
  deleteEntry(domain: string, entryId: string): boolean {
    const pointer = this.getPointer(domain);
    if (!pointer) return false;

    const domainMemory = this.readDomain(domain);
    if (!domainMemory) return false;

    const index = domainMemory.entries.findIndex((e) => e.id === entryId);
    if (index === -1) return false;

    domainMemory.entries.splice(index, 1);
    domainMemory.metadata.entryCount = domainMemory.entries.length;
    domainMemory.metadata.updatedAt = new Date().toISOString();

    const filePath = path.join(MEMORY_DIR, pointer.filePath);
    fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));

    pointer.lastUpdated = new Date().toISOString();
    this.persistIndex();

    return true;
  }

  /**
   * Search across all domains for entries matching a query.
   * Returns results sorted by relevance (keyword match + recency + importance).
   */
  search(
    query: string,
    options?: {
      domains?: string[];
      type?: MemoryEntry['type'];
      tags?: string[];
      limit?: number;
    },
  ): Array<{ domain: string; entry: MemoryEntry; score: number }> {
    const { domains, type, tags, limit = 20 } = options ?? {};
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length >= 2);

    const results: Array<{ domain: string; entry: MemoryEntry; score: number }> = [];

    const searchDomains = domains ?? this.index!.pointers.map((p) => p.domain);

    for (const domainName of searchDomains) {
      const domainMemory = this.readDomain(domainName);
      if (!domainMemory) continue;

      for (const entry of domainMemory.entries) {
        // Filter by type
        if (type && entry.type !== type) continue;
        // Filter by tags
        if (tags && tags.length > 0 && !tags.some((t) => entry.tags.includes(t))) continue;

        // Score: keyword match + recency + importance
        const text = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
        const termHits = queryTerms.filter((t) => text.includes(t)).length;
        const keywordScore = queryTerms.length > 0 ? termHits / queryTerms.length : 0;

        const ageHours = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60);
        const recency = Math.exp(-ageHours / 168); // 7-day half-life

        const importance = entry.importance ?? 0.5;

        const score = keywordScore * 0.5 + recency * 0.2 + importance * 0.3;

        if (score > 0) {
          results.push({ domain: domainName, entry, score });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Reconcile memory (remove duplicates, fix inconsistencies)
   */
  reconcile(): { removed: number; merged: number } {
    let removed = 0;
    let merged = 0;

    for (const pointer of this.index!.pointers) {
      const domainMemory = this.readDomain(pointer.domain);
      if (!domainMemory) continue;

      // Find duplicates by title + type, and by content similarity
      const seen = new Map<string, MemoryEntry>();
      const contentSeen = new Map<string, MemoryEntry>();
      const newEntries: MemoryEntry[] = [];

      for (const entry of domainMemory.entries) {
        const key = `${entry.type}:${entry.title.toLowerCase().trim()}`;
        const contentKey = `${entry.type}:${entry.content.substring(0, 100).toLowerCase().trim()}`;

        if (seen.has(key) || contentSeen.has(contentKey)) {
          // Merge: keep the newer entry, merge tags and content
          const existing = seen.get(key) ?? contentSeen.get(contentKey)!;
          // Keep the newer entry's timestamp, merge tags
          existing.tags = [...new Set([...existing.tags, ...entry.tags])];
          // Keep higher importance
          if ((entry.importance ?? 0.5) > (existing.importance ?? 0.5)) {
            existing.importance = entry.importance;
          }
          merged++;
        } else {
          seen.set(key, entry);
          contentSeen.set(contentKey, entry);
          newEntries.push(entry);
        }
      }

      removed += domainMemory.entries.length - newEntries.length;
      domainMemory.entries = newEntries;
      domainMemory.metadata.entryCount = newEntries.length;

      const filePath = path.join(MEMORY_DIR, pointer.filePath);
      fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
    }

    this.index!.lastReconciled = new Date().toISOString();
    this.persistIndex();

    return { removed, merged };
  }

  private persistIndex(): void {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2));
  }
}

// Default domains for Commander
export const DEFAULT_DOMAINS = [
  { domain: 'Project Context', description: 'Project goals, constraints, architecture' },
  { domain: 'Decisions', description: 'Architectural decisions and rationale' },
  { domain: 'Patterns', description: 'Code patterns and conventions' },
  { domain: 'Preferences', description: 'User preferences and settings' },
  { domain: 'Issues', description: 'Known issues and workarounds' },
  { domain: 'Lessons', description: 'Lessons learned from iterations' },
];
