/**
 * SQLite-backed MemoryStore
 *
 * Production-grade persistent memory storage using better-sqlite3.
 * Replaces file-based JSON storage with ACID transactions,
 * indexed queries, and FTS5 full-text search.
 *
 * Features:
 * - WAL mode for concurrent read/write
 * - FTS5 full-text search (matching Hermes)
 * - Automatic expiration via TTL
 * - Prepared statements for performance
 * - Transaction batching for bulk writes
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import { walCheckpoint } from '../storage/walCheckpoint';
import { getCurrentTenantId } from '../runtime/tenantContext';
import type {
  EpisodicMemoryItem,
  MemoryWriteOptions,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
  MemoryMeta,
} from '../episodicMemory';
import type { MemoryKind, MemoryDuration } from '../episodicMemory';

// ============================================================================
// SQLite Types
// ============================================================================

interface SqliteRow {
  [key: string]: unknown;
}

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (err) {
  reportSilentFailure(err, 'sqliteMemoryStore:55');
  // better-sqlite3 not installed
}

// ============================================================================
// SQLite Memory Store
// ============================================================================

export class SqliteMemoryStore implements MemoryStore {
  private db: BetterSqlite3DB | null = null;
  private filePath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Prepared statements
  private stmtInsert!: BetterSqlite3Stmt;
  private stmtGet!: BetterSqlite3Stmt;
  private stmtDelete!: BetterSqlite3Stmt;
  private stmtDeleteByMission!: BetterSqlite3Stmt;
  private stmtDeleteExpired!: BetterSqlite3Stmt;
  private stmtUpdate!: BetterSqlite3Stmt;
  private stmtSearch!: BetterSqlite3Stmt;
  private stmtFtsSearch!: BetterSqlite3Stmt;
  private stmtGetStats!: BetterSqlite3Stmt;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 is required. Install with: pnpm add better-sqlite3');
    }

    this.initPromise = (async () => {
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const dir = path.dirname(this.filePath);
        if (dir && dir !== '.') {
          await fs.mkdir(dir, { recursive: true });
        }

        this.db = new BetterSqlite3(this.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        this.createSchema();
        this.prepareStatements();
        this.initialized = true;

        getGlobalLogger().info('SqliteMemoryStore', 'Initialized', { path: this.filePath });
      } catch (err) {
        this.initPromise = null;
        throw err;
      }
    })();

    return this.initPromise;
  }

  private createSchema(): void {
    this.ensureInitialized().exec(`
      -- Main memory items table
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '__default__',
        project_id TEXT NOT NULL,
        mission_id TEXT,
        agent_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('DECISION','ISSUE','LESSON','SUMMARY')),
        duration TEXT NOT NULL CHECK(duration IN ('EPISODIC','LONG_TERM')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 50,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        expires_at TEXT,
        evidence_refs TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        meta TEXT
      );

      -- Indexes for common queries (tenant-scoped)
      CREATE INDEX IF NOT EXISTS idx_memory_project
        ON memory_items(tenant_id, project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_kind
        ON memory_items(tenant_id, project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_memory_expires
        ON memory_items(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_priority
        ON memory_items(tenant_id, project_id, priority DESC);

      -- FTS5 full-text search index
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        title,
        content,
        tags,
        content='memory_items',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS5 in sync
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memory_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;
    `);

    this.migrateSchema();
  }

  /**
   * Idempotent migrations for existing databases.
   * Adds tenant_id with a safe default and backfills any legacy rows.
   */
  private migrateSchema(): void {
    const db = this.ensureInitialized();
    const cols = (
      db.prepare('PRAGMA table_info(memory_items)').all() as Array<{ name: string }>
    ).map((c) => c.name);

    if (!cols.includes('tenant_id')) {
      db.exec("ALTER TABLE memory_items ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'");
    } else {
      // Backfill any rows that predate the NOT NULL constraint.
      db.exec("UPDATE memory_items SET tenant_id = '__default__' WHERE tenant_id IS NULL");
    }

    // Phase D: add meta column if it doesn't exist (migration for existing DBs)
    if (!cols.includes('meta')) {
      try {
        db.exec('ALTER TABLE memory_items ADD COLUMN meta TEXT');
      } catch {
        /* ignore race / schema mismatch */
      }
    }
  }

  private getTenantId(): string {
    return getCurrentTenantId() ?? '__default__';
  }

  private prepareStatements(): void {
    const d = this.ensureInitialized();

    this.stmtInsert = d.prepare(`
      INSERT INTO memory_items (id, tenant_id, project_id, mission_id, agent_id, kind, duration, title, content, tags, priority, created_at, last_accessed_at, expires_at, evidence_refs, confidence, meta)
      VALUES (@id, @tenantId, @projectId, @missionId, @agentId, @kind, @duration, @title, @content, @tags, @priority, @createdAt, @lastAccessedAt, @expiresAt, @evidenceRefs, @confidence, @meta)
    `);

    this.stmtGet = d.prepare(
      'SELECT * FROM memory_items WHERE id = ? AND project_id = ? AND tenant_id = ?',
    );

    this.stmtDelete = d.prepare(
      'DELETE FROM memory_items WHERE id = ? AND project_id = ? AND tenant_id = ?',
    );

    this.stmtDeleteByMission = d.prepare(
      'DELETE FROM memory_items WHERE mission_id = ? AND project_id = ? AND tenant_id = ?',
    );

    this.stmtDeleteExpired = d.prepare(
      'DELETE FROM memory_items WHERE project_id = ? AND tenant_id = ? AND expires_at IS NOT NULL AND expires_at < ?',
    );

    this.stmtUpdate = d.prepare(`
      UPDATE memory_items
      SET priority = COALESCE(@priority, priority),
          tags = COALESCE(@tags, tags),
          confidence = COALESCE(@confidence, confidence),
          last_accessed_at = @lastAccessedAt
      WHERE id = @id AND project_id = @projectId AND tenant_id = @tenantId
    `);

    this.stmtSearch = d.prepare(`
      SELECT * FROM memory_items
      WHERE tenant_id = @tenantId
        AND project_id = @projectId
        AND (@kind IS NULL OR kind = @kind)
        AND (@missionId IS NULL OR mission_id = @missionId)
        AND (@agentId IS NULL OR agent_id = @agentId)
        AND (@minPriority IS NULL OR priority >= @minPriority)
        AND (@minConfidence IS NULL OR confidence >= @minConfidence)
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY priority DESC, created_at DESC
      LIMIT @limit
    `);

    this.stmtFtsSearch = d.prepare(`
      SELECT m.*, bm25(memory_fts) as rank
      FROM memory_fts
      INNER JOIN memory_items m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ?
        AND m.tenant_id = ?
        AND m.project_id = ?
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY rank
      LIMIT ?
    `);

    this.stmtGetStats = d.prepare(`
      SELECT
        COUNT(*) as total_items,
        SUM(CASE WHEN kind = 'DECISION' THEN 1 ELSE 0 END) as decisions,
        SUM(CASE WHEN kind = 'ISSUE' THEN 1 ELSE 0 END) as issues,
        SUM(CASE WHEN kind = 'LESSON' THEN 1 ELSE 0 END) as lessons,
        SUM(CASE WHEN kind = 'SUMMARY' THEN 1 ELSE 0 END) as summaries,
        SUM(CASE WHEN duration = 'EPISODIC' THEN 1 ELSE 0 END) as episodic,
        SUM(CASE WHEN duration = 'LONG_TERM' THEN 1 ELSE 0 END) as long_term,
        AVG(priority) as avg_priority,
        AVG(confidence) as avg_confidence,
        MIN(created_at) as oldest_item,
        MAX(created_at) as newest_item
      FROM memory_items
      WHERE tenant_id = ? AND project_id = ?
    `);
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    await this.init();

    const now = new Date().toISOString();
    const id = options.id ?? `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80,
      ISSUE: 70,
      LESSON: 90,
      SUMMARY: 50,
    };
    let priority = options.priority ?? kindPriority[options.kind] ?? 50;
    if (options.missionId) priority += 5;
    if (options.agentId) priority += 5;
    if (options.evidenceRefs?.length) priority += Math.min(options.evidenceRefs.length * 5, 15);
    priority = Math.min(priority, 100);

    const duration = options.duration ?? 'EPISODIC';
    const expiresAt =
      duration === 'EPISODIC'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    const item: EpisodicMemoryItem = {
      id,
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      kind: options.kind,
      duration,
      title: options.title,
      content: options.content,
      tags: options.tags ?? [],
      priority,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt,
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.8,
      meta: options.meta,
    };

    const tenantId = this.getTenantId();
    this.stmtInsert.run({
      id: item.id,
      tenantId,
      projectId: item.projectId,
      missionId: item.missionId ?? null,
      agentId: item.agentId ?? null,
      kind: item.kind,
      duration: item.duration,
      title: item.title,
      content: item.content,
      tags: JSON.stringify(item.tags),
      priority: item.priority,
      createdAt: item.createdAt,
      lastAccessedAt: item.lastAccessedAt,
      expiresAt: item.expiresAt ?? null,
      evidenceRefs: item.evidenceRefs ? JSON.stringify(item.evidenceRefs) : null,
      confidence: item.confidence,
      meta: item.meta ? JSON.stringify(item.meta) : null,
    });

    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    await this.init();
    const results: EpisodicMemoryItem[] = [];

    type BatchTx = (
      fn: (batch: MemoryWriteOptions[]) => void,
    ) => (batch: MemoryWriteOptions[]) => void;
    const txFn = this.ensureInitialized().transaction as BatchTx;
    const insertMany = txFn((batch: MemoryWriteOptions[]) => {
      for (const options of batch) {
        // Reuse write logic inline for transaction
        const now = new Date().toISOString();
        const id = options.id ?? `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const kindPriority: Record<MemoryKind, number> = {
          DECISION: 80,
          ISSUE: 70,
          LESSON: 90,
          SUMMARY: 50,
        };
        let priority = options.priority ?? kindPriority[options.kind] ?? 50;
        if (options.missionId) priority += 5;
        if (options.agentId) priority += 5;
        if (options.evidenceRefs?.length) priority += Math.min(options.evidenceRefs.length * 5, 15);
        priority = Math.min(priority, 100);
        const duration = options.duration ?? 'EPISODIC';
        const expiresAt =
          duration === 'EPISODIC'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            : undefined;

        const item: EpisodicMemoryItem = {
          id,
          projectId: options.projectId,
          missionId: options.missionId,
          agentId: options.agentId,
          kind: options.kind,
          duration,
          title: options.title,
          content: options.content,
          tags: options.tags ?? [],
          priority,
          createdAt: now,
          lastAccessedAt: now,
          expiresAt,
          evidenceRefs: options.evidenceRefs,
          confidence: options.confidence ?? 0.8,
          meta: options.meta,
        };

        const tenantId = this.getTenantId();
        this.stmtInsert.run({
          id: item.id,
          tenantId,
          projectId: item.projectId,
          missionId: item.missionId ?? null,
          agentId: item.agentId ?? null,
          kind: item.kind,
          duration: item.duration,
          title: item.title,
          content: item.content,
          tags: JSON.stringify(item.tags),
          priority: item.priority,
          createdAt: item.createdAt,
          lastAccessedAt: item.lastAccessedAt,
          expiresAt: item.expiresAt ?? null,
          evidenceRefs: item.evidenceRefs ? JSON.stringify(item.evidenceRefs) : null,
          confidence: item.confidence,
          meta: item.meta ? JSON.stringify(item.meta) : null,
        });

        results.push(item);
      }
    });

    insertMany(items);
    return results;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    await this.init();
    const tenantId = this.getTenantId();
    const row = this.stmtGet.get<SqliteRow>(id, projectId, tenantId);
    if (!row) return null;

    // Update last accessed time
    const now = new Date().toISOString();
    this.ensureInitialized()
      .prepare('UPDATE memory_items SET last_accessed_at = ? WHERE id = ? AND tenant_id = ?')
      .run(now, id, tenantId);

    return this.rowToItem(row);
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    await this.init();
    const tenantId = this.getTenantId();

    if (options.delete) {
      this.stmtDelete.run(options.id, options.projectId, tenantId);
      return null;
    }

    if (options.updates) {
      this.stmtUpdate.run({
        id: options.id,
        projectId: options.projectId,
        tenantId,
        priority: options.updates.priority ?? null,
        tags: options.updates.tags ? JSON.stringify(options.updates.tags) : null,
        confidence: options.updates.confidence ?? null,
        lastAccessedAt: new Date().toISOString(),
      });
    }

    const row = this.stmtGet.get<SqliteRow>(options.id, options.projectId, tenantId);
    return row ? this.rowToItem(row) : null;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    await this.init();
    const result = this.stmtDelete.run(id, projectId, this.getTenantId());
    return result.changes > 0;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    await this.init();
    const result = this.stmtDeleteByMission.run(missionId, projectId, this.getTenantId());
    return result.changes;
  }

  async deleteExpired(projectId: string): Promise<number> {
    await this.init();
    const result = this.stmtDeleteExpired.run(
      projectId,
      this.getTenantId(),
      new Date().toISOString(),
    );
    return result.changes;
  }

  // ============================================================================
  // Search Operations
  // ============================================================================

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    await this.init();

    const now = new Date().toISOString();
    const limit = query.limit ?? 50;

    const rows = this.stmtSearch.all<SqliteRow>(
      {
        tenantId: this.getTenantId(),
        projectId: query.projectId,
        kind: query.kind ?? null,
        missionId: query.missionId ?? null,
        agentId: query.agentId ?? null,
        minPriority: query.minPriority ?? null,
        minConfidence: query.minConfidence ?? null,
        limit,
      },
      now,
    );

    let items = rows.map((r) => this.rowToItem(r));

    // Text search filter (if query provided)
    if (query.query && query.query.trim()) {
      const lowerQuery = query.query.toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(lowerQuery) ||
          item.content.toLowerCase().includes(lowerQuery) ||
          item.tags.some((t: string) => t.toLowerCase().includes(lowerQuery)),
      );
    }

    // Tag filter
    if (query.tags && query.tags.length > 0) {
      items = items.filter((item) => query.tags!.some((tag: string) => item.tags.includes(tag)));
    }

    return { items: items.slice(0, limit), total: items.length, query };
  }

  async searchSemantic(
    query: string,
    projectId: string,
    limit = 10,
  ): Promise<EpisodicMemoryItem[]> {
    await this.init();
    const tenantId = this.getTenantId();

    try {
      // Use FTS5 for full-text search
      const ftsQuery = this.buildFtsQuery(query);
      const rows = this.stmtFtsSearch.all<SqliteRow>(
        ftsQuery,
        tenantId,
        projectId,
        new Date().toISOString(),
        limit,
      );
      return rows.map((r: SqliteRow) => this.rowToItem(r));
    } catch (err) {
      getGlobalLogger().warn('SqliteMemoryStore', 'FTS search failed, falling back to LIKE', {
        error: String(err),
      });
      // Fallback to LIKE search
      const lowerQuery = query.toLowerCase();
      const rows = this.ensureInitialized()
        .prepare(
          `
        SELECT * FROM memory_items
        WHERE tenant_id = ? AND project_id = ? AND (title LIKE ? OR content LIKE ?)
        ORDER BY priority DESC, created_at DESC
        LIMIT ?
      `,
        )
        .all<SqliteRow>(tenantId, projectId, `%${lowerQuery}%`, `%${lowerQuery}%`, limit);
      return rows.map((r: SqliteRow) => this.rowToItem(r));
    }
  }

  // ============================================================================
  // Stats
  // ============================================================================

  async getStats(projectId: string): Promise<MemoryStats> {
    await this.init();
    const tenantId = this.getTenantId();

    const row = this.stmtGetStats.get<SqliteRow>(tenantId, projectId);
    if (!row) {
      return {
        totalItems: 0,
        byKind: { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 },
        byDuration: { EPISODIC: 0, LONG_TERM: 0 },
        avgPriority: 0,
        avgConfidence: 0,
        topTags: [],
        oldestItem: undefined,
        newestItem: undefined,
      };
    }

    // Get top tags
    const tagRows = this.ensureInitialized()
      .prepare(
        `
      SELECT tags FROM memory_items WHERE tenant_id = ? AND project_id = ?
    `,
      )
      .all<SqliteRow>(tenantId, projectId);

    const tagCounts = new Map<string, number>();
    for (const tagRow of tagRows) {
      try {
        const tags = JSON.parse(tagRow.tags as string) as string[];
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      } catch (err) {
        reportSilentFailure(err, 'sqliteMemoryStore:565');
        /* skip malformed */
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalItems: (row.total_items as number) ?? 0,
      byKind: {
        DECISION: (row.decisions as number) ?? 0,
        ISSUE: (row.issues as number) ?? 0,
        LESSON: (row.lessons as number) ?? 0,
        SUMMARY: (row.summaries as number) ?? 0,
      },
      byDuration: {
        EPISODIC: (row.episodic as number) ?? 0,
        LONG_TERM: (row.long_term as number) ?? 0,
      },
      avgPriority: (row.avg_priority as number) ?? 0,
      avgConfidence: (row.avg_confidence as number) ?? 0,
      topTags,
      oldestItem: row.oldest_item as string | undefined,
      newestItem: row.newest_item as string | undefined,
    };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async close(): Promise<void> {
    // Wait for any in-flight init before closing to avoid racing the DB handle.
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch (err) {
        reportSilentFailure(err, 'sqliteMemoryStore:605');
        /* init failed; close is still safe */
      }
    }
    if (this.db) {
      walCheckpoint(this.db);
      this.db.close();
    }
    this.db = null;
    this.initPromise = null;
    this.initialized = false;
  }

  private ensureInitialized(): BetterSqlite3DB {
    if (!this.db) {
      throw new Error('SqliteMemoryStore is not initialized or has been closed');
    }
    return this.db;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private rowToItem(row: SqliteRow): EpisodicMemoryItem {
    let tags: string[] = [];
    let evidenceRefs: string[] | undefined;
    let meta: MemoryMeta | undefined;
    try {
      tags = JSON.parse((row.tags as string) || '[]');
    } catch (err) {
      reportSilentFailure(err, 'sqliteMemoryStore:635');
      /* ok */
    }
    try {
      evidenceRefs = row.evidence_refs ? JSON.parse(row.evidence_refs as string) : undefined;
    } catch (err) {
      reportSilentFailure(err, 'sqliteMemoryStore:641');
      /* ok */
    }
    try {
      meta = row.meta ? JSON.parse(row.meta as string) : undefined;
    } catch (err) {
      reportSilentFailure(err, 'sqliteMemoryStore:meta');
      /* ok */
    }

    const kind = row.kind as string;
    if (!['DECISION', 'ISSUE', 'LESSON', 'SUMMARY'].includes(kind)) {
      throw new Error(`Invalid memory kind in DB: ${kind}`);
    }
    const duration = row.duration as string;
    if (!['EPISODIC', 'LONG_TERM'].includes(duration)) {
      throw new Error(`Invalid memory duration in DB: ${duration}`);
    }

    return {
      id: row.id as string,
      projectId: row.project_id as string,
      missionId: (row.mission_id as string) || undefined,
      agentId: (row.agent_id as string) || undefined,
      kind: kind as MemoryKind,
      duration: duration as MemoryDuration,
      title: row.title as string,
      content: row.content as string,
      tags,
      priority: row.priority as number,
      createdAt: row.created_at as string,
      lastAccessedAt: row.last_accessed_at as string,
      expiresAt: (row.expires_at as string) || undefined,
      evidenceRefs,
      confidence: row.confidence as number,
      meta,
    };
  }

  private buildFtsQuery(input: string): string {
    const cleaned = input.replace(/[^\w\s\-_.]/g, ' ').trim();
    if (!cleaned) return '""';
    const words = cleaned.split(/\s+/).filter((w) => w.length >= 1);
    if (words.length === 0) return '""';
    if (words.length === 1) return `"${words[0]}"*`;
    const terms = words.slice(0, -1).map((w) => `"${w}"`);
    terms.push(`"${words[words.length - 1]}"*`);
    return terms.join(' ');
  }
}
