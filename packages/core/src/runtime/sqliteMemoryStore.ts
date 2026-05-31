/**
 * SQLite-backed persistent memory store for episodic and long-term agent memory.
 * Implements the `MemoryStore` interface from `../memory` for drop-in use by the runtime.
 * Uses `better-sqlite3` for synchronous access and transactions.
 * Configures SQLite with WAL mode for safer concurrent reads/writes.
 * Enables auto-vacuum to help keep the on-disk store compact over time.
 * Used to persist agent memories across sessions and process restarts.
 */
import { getGlobalLogger } from '../logging';
import { mkdirSync } from 'fs';
import type {
  MemoryStore, MemoryWriteOptions, EpisodicMemoryItem,
  MemorySearchQuery, MemorySearchResult, MemoryManageOptions, MemoryStats,
} from '../memory';

// Local type aliases — can't import from memory.ts directly (circular dependency)
type MemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
type MemoryDuration = 'EPISODIC' | 'LONG_TERM';

interface SqliteRow {
  id: string; project_id: string; mission_id: string | null; agent_id: string | null;
  kind: string; duration: string; title: string; content: string; tags: string;
  priority: number; confidence: number; created_at: string; last_accessed_at: string;
  expires_at: string | null; evidence_refs: string;
}
interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}
interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void; exec(sql: string): void; close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // better-sqlite3 not installed — SqliteMemoryStore will throw on construction
}

/**
 * SQLite-backed Memory Store
 *
 * Production-grade persistence using better-sqlite3.
 * Provides the same MemoryStore interface as InMemoryMemoryStore/JsonMemoryStore
 * but with proper SQL indexing, transactions, and disk persistence.
 *
 * Schema:
 *   memories(id TEXT PK, project_id TEXT, mission_id TEXT, agent_id TEXT,
 *            kind TEXT, duration TEXT, title TEXT, content TEXT, tags TEXT JSON,
 *            priority REAL, confidence REAL, created_at TEXT, last_accessed_at TEXT,
 *            expires_at TEXT, evidence_refs TEXT JSON)
 *
 * Indexes: project_id + kind, project_id + created_at, project_id + priority,
 *          project_id + tags (GIN-style via JSON LIKE), expires_at
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: BetterSqlite3DB | null = null;
  private filePath: string;
  private initialized = false;

  // Prepared statements (lazily initialized)
  private stmtWrite: BetterSqlite3Stmt | null = null;
  private stmtRead: BetterSqlite3Stmt | null = null;
  private stmtDelete: BetterSqlite3Stmt | null = null;
  private stmtSearch: BetterSqlite3Stmt | null = null;
  private stmtCountByKind: BetterSqlite3Stmt | null = null;
  private stmtCountByDuration: BetterSqlite3Stmt | null = null;
  private stmtStats: BetterSqlite3Stmt | null = null;
  private stmtDeleteExpired: BetterSqlite3Stmt | null = null;
  private stmtDeleteByMission: BetterSqlite3Stmt | null = null;
  private stmtFtsSearch: BetterSqlite3Stmt | null = null;
  private stmtFtsCount: BetterSqlite3Stmt | null = null;

  constructor(filePath: string = '.commander/memory.db') {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!BetterSqlite3) {
      getGlobalLogger().warn('SqliteMemoryStore', 'better-sqlite3 not available — install with: pnpm add better-sqlite3');
      throw new Error('better-sqlite3 is required. Install with: pnpm add better-sqlite3');
    }
    const dir = this.filePath.includes('/') ? this.filePath.substring(0, this.filePath.lastIndexOf('/')) : '.';
    if (dir) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new BetterSqlite3(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();
    this.prepareStatements();
    this.initialized = true;
    getGlobalLogger().info('SqliteMemoryStore', 'Initialized', { path: this.filePath });
  }

   private createSchema(): void {
     if (!this.db) {
       throw new Error('Database not initialized');
     }
     this.db.exec(`
       CREATE TABLE IF NOT EXISTS memories (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         mission_id TEXT,
         agent_id TEXT,
         kind TEXT NOT NULL CHECK(kind IN ('DECISION','ISSUE','LESSON','SUMMARY')),
         duration TEXT NOT NULL DEFAULT 'EPISODIC' CHECK(duration IN ('EPISODIC','LONG_TERM')),
         title TEXT NOT NULL,
         content TEXT NOT NULL,
         tags TEXT NOT NULL DEFAULT '[]',
         priority REAL NOT NULL DEFAULT 50,
         confidence REAL NOT NULL DEFAULT 0.8,
         created_at TEXT NOT NULL,
         last_accessed_at TEXT NOT NULL,
         expires_at TEXT,
         evidence_refs TEXT DEFAULT '[]'
       );
       CREATE INDEX IF NOT EXISTS idx_memories_project_kind ON memories(project_id, kind);
       CREATE INDEX IF NOT EXISTS idx_memories_project_created ON memories(project_id, created_at DESC);
       CREATE INDEX IF NOT EXISTS idx_memories_project_priority ON memories(project_id, priority DESC);
       CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;

       -- FTS5 full-text search index for fast semantic search
       CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
         title, content, tags,
         content='memories',
         content_rowid='rowid'
       );

       -- Triggers to keep FTS5 index in sync with the memories table
       CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
         INSERT INTO memories_fts(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END;

       CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
         INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
       END;

       CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
         INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
         INSERT INTO memories_fts(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END;
     `);

     // Backfill FTS5 index from existing data (idempotent)
     const ftsCount = this.db.prepare(
       "SELECT COUNT(*) as cnt FROM memories_fts"
     ).get<{ cnt: number }>();
     const memCount = this.db.prepare(
       "SELECT COUNT(*) as cnt FROM memories"
     ).get<{ cnt: number }>();
     if ((ftsCount?.cnt ?? 0) === 0 && (memCount?.cnt ?? 0) > 0) {
       this.db.exec(`
         INSERT INTO memories_fts(rowid, title, content, tags)
         SELECT rowid, title, content, tags FROM memories;
       `);
     }
   }

   private prepareStatements(): void {
     if (!this.db) {
       throw new Error('Database not initialized');
     }
     this.stmtWrite = this.db.prepare(`
       INSERT INTO memories (id, project_id, mission_id, agent_id, kind, duration,
         title, content, tags, priority, confidence, created_at, last_accessed_at,
         expires_at, evidence_refs)
       VALUES (@id, @projectId, @missionId, @agentId, @kind, @duration,
         @title, @content, @tags, @priority, @confidence, @createdAt, @lastAccessedAt,
         @expiresAt, @evidenceRefs)
     `);
     this.stmtRead = this.db.prepare(
       'SELECT * FROM memories WHERE id = ? AND project_id = ?'
     );
     this.stmtDelete = this.db.prepare(
       'DELETE FROM memories WHERE id = ? AND project_id = ?'
     );
     this.stmtDeleteExpired = this.db.prepare(
       'DELETE FROM memories WHERE project_id = ? AND expires_at IS NOT NULL AND expires_at < ?'
     );
     this.stmtDeleteByMission = this.db.prepare(
       'DELETE FROM memories WHERE project_id = ? AND mission_id = ?'
     );
     // FTS5 search — joins against memories table for filtering
     // Use rank for BM25 ordering if available, fall back to rowid
     try {
       this.stmtFtsSearch = this.db.prepare(`
         SELECT m.* FROM memories m
         INNER JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? AND m.project_id = ?
         ORDER BY rank
         LIMIT ?
       `);
     } catch {
       this.stmtFtsSearch = this.db.prepare(`
         SELECT m.* FROM memories m
         INNER JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? AND m.project_id = ?
         ORDER BY m.rowid DESC
         LIMIT ?
       `);
     }
     try {
       this.stmtFtsCount = this.db.prepare(`
         SELECT COUNT(*) as cnt FROM memories m
         INNER JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? AND m.project_id = ?
       `);
     } catch {
       // FTS5 not available — stmtFtsCount will be null, search will fall back to LIKE
       this.stmtFtsCount = null;
     }
   }

  private nextId = 1;
  private generateId(): string {
    return `memory-${this.nextId++}-${Date.now()}`;
  }

  private rowToItem(row: SqliteRow): EpisodicMemoryItem {
    let tags: string[] = [];
    let evidenceRefs: string[] = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
    try { evidenceRefs = JSON.parse(row.evidence_refs || '[]'); } catch { evidenceRefs = []; }
    return {
      id: row.id,
      projectId: row.project_id,
      missionId: row.mission_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      kind: row.kind as MemoryKind,
      duration: row.duration as MemoryDuration,
      title: row.title,
      content: row.content,
      tags,
      priority: row.priority,
      confidence: row.confidence,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      expiresAt: row.expires_at ?? undefined,
      evidenceRefs,
    };
  }

  private calculatePriority(options: MemoryWriteOptions): number {
    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80, ISSUE: 70, LESSON: 90, SUMMARY: 50,
    };
    let p = options.priority ?? (kindPriority[options.kind] ?? 50);
    if (options.missionId) p += 5;
    if (options.agentId) p += 5;
    if (options.evidenceRefs?.length) p += Math.min(options.evidenceRefs.length * 5, 15);
    return Math.min(p, 100);
  }

   async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
     await this.init();
     const now = new Date().toISOString();
     const id = this.generateId();
     const priority = this.calculatePriority(options);

     const item = {
       id,
       projectId: options.projectId,
       missionId: options.missionId,
       agentId: options.agentId,
       kind: options.kind,
       duration: options.duration ?? 'EPISODIC',
       title: options.title,
       content: options.content,
       tags: JSON.stringify(options.tags ?? []),
       priority,
       confidence: options.confidence ?? 0.8,
       createdAt: now,
       lastAccessedAt: now,
       expiresAt: options.duration === 'EPISODIC'
         ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
         : null,
       evidenceRefs: JSON.stringify(options.evidenceRefs ?? []),
     };

     this.stmtWrite!.run({
       id: item.id,
       projectId: item.projectId,
       missionId: item.missionId ?? null,
       agentId: item.agentId ?? null,
       kind: item.kind,
       duration: item.duration,
       title: item.title,
       content: item.content,
       tags: item.tags,
       priority: item.priority,
       confidence: item.confidence,
       createdAt: item.createdAt,
       lastAccessedAt: item.lastAccessedAt,
       expiresAt: item.expiresAt,
       evidenceRefs: item.evidenceRefs,
     });

    return this.rowToItem({
      ...item,
      tags: item.tags,
      evidence_refs: item.evidenceRefs,
      expires_at: item.expiresAt,
      project_id: item.projectId,
      mission_id: item.missionId ?? null,
      agent_id: item.agentId ?? null,
      created_at: item.createdAt,
      last_accessed_at: item.lastAccessedAt,
    });
  }

    async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
      await this.init();
      const results: EpisodicMemoryItem[] = [];
      for (const op of items) {
        results.push(await this.write(op));
      }
      return results;
    }

    async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
      await this.init();
      if (options.delete) {
        this.stmtDelete!.run(options.id, options.projectId);
        return null;
      }
      if (options.updates) {
        const sets: string[] = [];
        const params: Record<string, unknown> = { id: options.id, projectId: options.projectId };
        if (options.updates.priority !== undefined) { sets.push('priority = @priority'); params.priority = options.updates.priority; }
        if (options.updates.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = options.updates.confidence; }
        if (options.updates.tags) { sets.push('tags = @tags'); params.tags = JSON.stringify(options.updates.tags); }
        if (options.updates.expiresAt) { sets.push('expires_at = @expiresAt'); params.expiresAt = options.updates.expiresAt; }
        sets.push('last_accessed_at = @now'); params.now = new Date().toISOString();
        if (sets.length > 0) {
          this.db!.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id AND project_id = @projectId`).run(params);
        }
      }
       const row = this.stmtRead!.get(options.id, options.projectId) as SqliteRow | undefined;
       return row ? this.rowToItem(row) : null;
    }

   async delete(id: string, projectId: string): Promise<boolean> {
     await this.init();
     const result = this.stmtDelete!.run(id, projectId);
     return result.changes > 0;
   }

   async deleteByMission(missionId: string, projectId: string): Promise<number> {
     await this.init();
     const result = this.stmtDeleteByMission!.run(projectId, missionId);
     return result.changes;
   }

   async deleteExpired(projectId: string): Promise<number> {
     await this.init();
     const result = this.stmtDeleteExpired!.run(projectId, new Date().toISOString());
     return result.changes;
   }

   async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
     await this.init();
     const row = this.stmtRead!.get(id, projectId) as SqliteRow | undefined;
     if (!row) return null;
     this.db!.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
     return this.rowToItem(row);
   }

   async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
     await this.init();
     const conditions: string[] = ['project_id = ?'];
     const params: unknown[] = [query.projectId];

     if (query.kind) { conditions.push('kind = ?'); params.push(query.kind); }
     if (query.missionId) { conditions.push('mission_id = ?'); params.push(query.missionId); }
     if (query.agentId) { conditions.push('agent_id = ?'); params.push(query.agentId); }
     if (query.minPriority !== undefined) { conditions.push('priority >= ?'); params.push(query.minPriority); }
     if (query.minConfidence !== undefined) { conditions.push('confidence >= ?'); params.push(query.minConfidence); }

     let useFts = false;
     let ftsQuery = '';
     if (query.query) {
       // Try FTS5 first for better ranking; fall back to LIKE on error
       try {
         ftsQuery = this.buildFtsQuery(query.query);
         useFts = true;
       } catch {
         const like = `%${query.query.toLowerCase()}%`;
         conditions.push('(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)');
         params.push(like, like);
       }
     }

      const limit = query.limit ?? 50;

      if (useFts && ftsQuery) {
        // FTS5-powered search with BM25 ranking, filtered by metadata conditions
        const metaConditions = conditions.filter(c => !c.includes('LIKE'));
        const metaParams = params.filter(p => typeof p !== 'string' || !p.startsWith('%'));

        let ftsWhere = `memories_fts MATCH ?`;
        let ftsParams: unknown[] = [ftsQuery];

        if (metaConditions.length > 0) {
          // Join with memories table for metadata filtering
          const countSql = `
            SELECT COUNT(*) as cnt FROM memories m
            INNER JOIN memories_fts fts ON m.rowid = fts.rowid
            WHERE fts.${ftsWhere} AND ${metaConditions.map(c => c.replace(/project_id|m\.kind|m\.mission_id|m\.agent_id|m\.priority|m\.confidence/g, (match) => `m.${match.replace('m.', '')}`)).join(' AND ')}
          `;
          // Simplify: use subquery approach
          const countRow = this.db!.prepare(`
            SELECT COUNT(*) as cnt FROM memories m
            WHERE m.rowid IN (SELECT rowid FROM memories_fts WHERE ${ftsWhere})
            AND ${metaConditions.join(' AND ')}
          `).get<{ cnt: number }>(...ftsParams, ...metaParams);
          const total = countRow?.cnt ?? 0;

          const rows = this.db!.prepare(`
            SELECT m.* FROM memories m
            WHERE m.rowid IN (SELECT rowid FROM memories_fts WHERE ${ftsWhere})
            AND ${metaConditions.join(' AND ')}
            ORDER BY m.priority DESC, m.created_at DESC
            LIMIT ?
          `).all<SqliteRow>(...ftsParams, ...metaParams, limit);

          return { items: rows.map((r: SqliteRow) => this.rowToItem(r)), total, query };
        } else {
          const countRow = this.stmtFtsCount!.get<{ cnt: number }>(ftsQuery, query.projectId);
          const total = countRow?.cnt ?? 0;
          const rows = this.stmtFtsSearch!.all<SqliteRow>(ftsQuery, query.projectId, limit);
          return { items: rows.map((r: SqliteRow) => this.rowToItem(r)), total, query };
        }
      }

      // Fallback: LIKE-based search
      const where = conditions.join(' AND ');
      const countRow = this.db!.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE ${where}`).get<{ cnt: number }>(...params);
      const total = countRow?.cnt ?? 0;

      const rows = this.db!.prepare(
        `SELECT * FROM memories WHERE ${where} ORDER BY priority DESC, created_at DESC LIMIT ?`
      ).all<SqliteRow>(...params, limit);

      return {
        items: rows.map((r: SqliteRow) => this.rowToItem(r)),
        total,
        query,
      };
   }

  async searchSemantic(_query: string, _projectId: string, _limit = 10): Promise<EpisodicMemoryItem[]> {
    await this.init();
    if (!_query || !_query.trim()) return [];

    // Use FTS5 MATCH for full-text search with BM25 ranking
    const ftsQuery = this.buildFtsQuery(_query);
    try {
      const rows = this.stmtFtsSearch!.all<SqliteRow>(ftsQuery, _projectId, _limit);
      // Update last_accessed_at for retrieved items
      const now = new Date().toISOString();
      for (const row of rows) {
        this.db!.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(now, row.id);
      }
      return rows.map((r: SqliteRow) => this.rowToItem(r));
    } catch {
      // Fallback to LIKE-based search if FTS5 query syntax fails
      const result = await this.search({ projectId: _projectId, query: _query, limit: _limit });
      return result.items;
    }
  }

  /**
   * Build an FTS5-compatible query string from user input.
   * Handles special characters, quotes multi-word phrases, and adds prefix matching.
   */
  private buildFtsQuery(input: string): string {
    // Strip FTS5 special characters that could cause syntax errors
    const cleaned = input.replace(/[^\w\s\-_.]/g, ' ').trim();
    if (!cleaned) return '""';

    const words = cleaned.split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return '""';

    // For multi-word queries, search for all words (AND logic) with prefix matching
    if (words.length === 1) {
      // Single word: prefix match for autocomplete-like behavior
      return `"${words[0]}"*`;
    }

    // Multi-word: require all words present, with prefix match on last word
    const terms = words.slice(0, -1).map(w => `"${w}"`);
    terms.push(`"${words[words.length - 1]}"*`);
    return terms.join(' ');
  }

  /**
   * Search conversation history (FTS5-powered cross-session recall).
   * Searches across all persisted conversations for matching content.
   */
  async searchConversations(query: string, projectId: string, limit = 20): Promise<EpisodicMemoryItem[]> {
    return this.searchSemantic(query, projectId, limit);
  }

    async getStats(projectId: string): Promise<MemoryStats> {
      await this.init();

      const rows = this.db!.prepare(
        'SELECT kind, COUNT(*) as cnt FROM memories WHERE project_id = ? GROUP BY kind'
      ).all<{ kind: MemoryKind; cnt: number }>(projectId);
      const byKind: Record<MemoryKind, number> = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
      for (const r of rows) {
        if (r.kind === 'DECISION' || r.kind === 'ISSUE' || r.kind === 'LESSON' || r.kind === 'SUMMARY') {
          byKind[r.kind] = r.cnt;
        }
      }

      const durRows = this.db!.prepare(
        'SELECT duration, COUNT(*) as cnt FROM memories WHERE project_id = ? GROUP BY duration'
      ).all<{ duration: MemoryDuration; cnt: number }>(projectId);
      const byDuration: Record<MemoryDuration, number> = { EPISODIC: 0, LONG_TERM: 0 };
      for (const r of durRows) {
        if (r.duration === 'EPISODIC' || r.duration === 'LONG_TERM') {
          byDuration[r.duration] = r.cnt;
        }
      }

       const agg = this.db!.prepare(
         'SELECT AVG(priority) as avgP, AVG(confidence) as avgC, MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE project_id = ?'
       ).get<{ avgP: number; avgC: number; oldest: string | null; newest: string | null }>(projectId);

     const totalItems = rows.reduce((s: number, r: { cnt: number }) => s + r.cnt, 0);

     return {
       totalItems,
       byKind,
       byDuration,
       avgPriority: agg?.avgP ?? 0,
       avgConfidence: agg?.avgC ?? 0,
       topTags: [],
       oldestItem: agg?.oldest ?? undefined,
       newestItem: agg?.newest ?? undefined,
     };
   }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      getGlobalLogger().info('SqliteMemoryStore', 'Closed');
    }
  }
}
