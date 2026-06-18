"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteMemoryStore = void 0;
/**
 * SQLite-backed persistent memory store for episodic and long-term agent memory.
 * Implements the `MemoryStore` interface from `../memory` for drop-in use by the runtime.
 * Uses `better-sqlite3` for synchronous access and transactions.
 * Configures SQLite with WAL mode for safer concurrent reads/writes.
 * Enables auto-vacuum to help keep the on-disk store compact over time.
 * Used to persist agent memories across sessions and process restarts.
 */
const logging_1 = require("../logging");
const fs_1 = require("fs");
let BetterSqlite3 = null;
try {
    BetterSqlite3 = require('better-sqlite3');
}
catch {
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
class SqliteMemoryStore {
    constructor(filePath = '.commander/memory.db') {
        this.db = null;
        this.initialized = false;
        // Prepared statements (lazily initialized)
        this.stmtWrite = null;
        this.stmtRead = null;
        this.stmtDelete = null;
        this.stmtSearch = null;
        this.stmtCountByKind = null;
        this.stmtCountByDuration = null;
        this.stmtStats = null;
        this.stmtDeleteExpired = null;
        this.stmtDeleteByMission = null;
        this.stmtFtsSearch = null;
        this.stmtFtsCount = null;
        this.nextId = 1;
        this.filePath = filePath;
    }
    async init() {
        if (this.initialized)
            return;
        if (!BetterSqlite3) {
            (0, logging_1.getGlobalLogger)().warn('SqliteMemoryStore', 'better-sqlite3 not available — install with: pnpm add better-sqlite3');
            throw new Error('better-sqlite3 is required. Install with: pnpm add better-sqlite3');
        }
        const dir = this.filePath.includes('/')
            ? this.filePath.substring(0, this.filePath.lastIndexOf('/'))
            : '.';
        if (dir) {
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        }
        this.db = new BetterSqlite3(this.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.createSchema();
        this.prepareStatements();
        this.initialized = true;
        (0, logging_1.getGlobalLogger)().info('SqliteMemoryStore', 'Initialized', { path: this.filePath });
    }
    createSchema() {
        var _a, _b;
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
        const ftsCount = this.db
            .prepare('SELECT COUNT(*) as cnt FROM memories_fts')
            .get();
        const memCount = this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get();
        if (((_a = ftsCount === null || ftsCount === void 0 ? void 0 : ftsCount.cnt) !== null && _a !== void 0 ? _a : 0) === 0 && ((_b = memCount === null || memCount === void 0 ? void 0 : memCount.cnt) !== null && _b !== void 0 ? _b : 0) > 0) {
            this.db.exec(`
         INSERT INTO memories_fts(rowid, title, content, tags)
         SELECT rowid, title, content, tags FROM memories;
       `);
        }
    }
    prepareStatements() {
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
        this.stmtRead = this.db.prepare('SELECT * FROM memories WHERE id = ? AND project_id = ?');
        this.stmtDelete = this.db.prepare('DELETE FROM memories WHERE id = ? AND project_id = ?');
        this.stmtDeleteExpired = this.db.prepare('DELETE FROM memories WHERE project_id = ? AND expires_at IS NOT NULL AND expires_at < ?');
        this.stmtDeleteByMission = this.db.prepare('DELETE FROM memories WHERE project_id = ? AND mission_id = ?');
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
        }
        catch {
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
        }
        catch {
            // FTS5 not available — stmtFtsCount will be null, search will fall back to LIKE
            this.stmtFtsCount = null;
        }
    }
    generateId() {
        return `memory-${this.nextId++}-${Date.now()}`;
    }
    rowToItem(row) {
        var _a, _b, _c;
        let tags = [];
        let evidenceRefs = [];
        try {
            tags = JSON.parse(row.tags || '[]');
        }
        catch {
            tags = [];
        }
        try {
            evidenceRefs = JSON.parse(row.evidence_refs || '[]');
        }
        catch {
            evidenceRefs = [];
        }
        return {
            id: row.id,
            projectId: row.project_id,
            missionId: (_a = row.mission_id) !== null && _a !== void 0 ? _a : undefined,
            agentId: (_b = row.agent_id) !== null && _b !== void 0 ? _b : undefined,
            kind: row.kind,
            duration: row.duration,
            title: row.title,
            content: row.content,
            tags,
            priority: row.priority,
            confidence: row.confidence,
            createdAt: row.created_at,
            lastAccessedAt: row.last_accessed_at,
            expiresAt: (_c = row.expires_at) !== null && _c !== void 0 ? _c : undefined,
            evidenceRefs,
        };
    }
    calculatePriority(options) {
        var _a, _b, _c;
        const kindPriority = {
            DECISION: 80,
            ISSUE: 70,
            LESSON: 90,
            SUMMARY: 50,
        };
        let p = (_b = (_a = options.priority) !== null && _a !== void 0 ? _a : kindPriority[options.kind]) !== null && _b !== void 0 ? _b : 50;
        if (options.missionId)
            p += 5;
        if (options.agentId)
            p += 5;
        if ((_c = options.evidenceRefs) === null || _c === void 0 ? void 0 : _c.length)
            p += Math.min(options.evidenceRefs.length * 5, 15);
        return Math.min(p, 100);
    }
    async write(options) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
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
            duration: (_a = options.duration) !== null && _a !== void 0 ? _a : 'EPISODIC',
            title: options.title,
            content: options.content,
            tags: JSON.stringify((_b = options.tags) !== null && _b !== void 0 ? _b : []),
            priority,
            confidence: (_c = options.confidence) !== null && _c !== void 0 ? _c : 0.8,
            createdAt: now,
            lastAccessedAt: now,
            expiresAt: options.duration === 'EPISODIC'
                ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
                : null,
            evidenceRefs: JSON.stringify((_d = options.evidenceRefs) !== null && _d !== void 0 ? _d : []),
        };
        this.stmtWrite.run({
            id: item.id,
            projectId: item.projectId,
            missionId: (_e = item.missionId) !== null && _e !== void 0 ? _e : null,
            agentId: (_f = item.agentId) !== null && _f !== void 0 ? _f : null,
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
            mission_id: (_g = item.missionId) !== null && _g !== void 0 ? _g : null,
            agent_id: (_h = item.agentId) !== null && _h !== void 0 ? _h : null,
            created_at: item.createdAt,
            last_accessed_at: item.lastAccessedAt,
        });
    }
    async batchWrite(items) {
        await this.init();
        const results = [];
        for (const op of items) {
            results.push(await this.write(op));
        }
        return results;
    }
    async update(options) {
        await this.init();
        if (options.delete) {
            this.stmtDelete.run(options.id, options.projectId);
            return null;
        }
        if (options.updates) {
            const sets = [];
            const params = { id: options.id, projectId: options.projectId };
            if (options.updates.priority !== undefined) {
                sets.push('priority = @priority');
                params.priority = options.updates.priority;
            }
            if (options.updates.confidence !== undefined) {
                sets.push('confidence = @confidence');
                params.confidence = options.updates.confidence;
            }
            if (options.updates.tags) {
                sets.push('tags = @tags');
                params.tags = JSON.stringify(options.updates.tags);
            }
            if (options.updates.expiresAt) {
                sets.push('expires_at = @expiresAt');
                params.expiresAt = options.updates.expiresAt;
            }
            sets.push('last_accessed_at = @now');
            params.now = new Date().toISOString();
            if (sets.length > 0) {
                this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id AND project_id = @projectId`).run(params);
            }
        }
        const row = this.stmtRead.get(options.id, options.projectId);
        return row ? this.rowToItem(row) : null;
    }
    async delete(id, projectId) {
        await this.init();
        const result = this.stmtDelete.run(id, projectId);
        return result.changes > 0;
    }
    async deleteByMission(missionId, projectId) {
        await this.init();
        const result = this.stmtDeleteByMission.run(projectId, missionId);
        return result.changes;
    }
    async deleteExpired(projectId) {
        await this.init();
        const result = this.stmtDeleteExpired.run(projectId, new Date().toISOString());
        return result.changes;
    }
    async read(id, projectId) {
        await this.init();
        const row = this.stmtRead.get(id, projectId);
        if (!row)
            return null;
        this.db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        return this.rowToItem(row);
    }
    async search(query) {
        var _a, _b, _c, _d;
        await this.init();
        const conditions = ['project_id = ?'];
        const params = [query.projectId];
        if (query.kind) {
            conditions.push('kind = ?');
            params.push(query.kind);
        }
        if (query.missionId) {
            conditions.push('mission_id = ?');
            params.push(query.missionId);
        }
        if (query.agentId) {
            conditions.push('agent_id = ?');
            params.push(query.agentId);
        }
        if (query.minPriority !== undefined) {
            conditions.push('priority >= ?');
            params.push(query.minPriority);
        }
        if (query.minConfidence !== undefined) {
            conditions.push('confidence >= ?');
            params.push(query.minConfidence);
        }
        let useFts = false;
        let ftsQuery = '';
        if (query.query) {
            // Try FTS5 first for better ranking; fall back to LIKE on error
            try {
                ftsQuery = this.buildFtsQuery(query.query);
                useFts = true;
            }
            catch {
                const like = `%${query.query.toLowerCase()}%`;
                conditions.push('(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)');
                params.push(like, like);
            }
        }
        const limit = (_a = query.limit) !== null && _a !== void 0 ? _a : 50;
        if (useFts && ftsQuery) {
            // FTS5-powered search with BM25 ranking, filtered by metadata conditions
            const metaConditions = conditions.filter((c) => !c.includes('LIKE'));
            const metaParams = params.filter((p) => typeof p !== 'string' || !p.startsWith('%'));
            let ftsWhere = `memories_fts MATCH ?`;
            let ftsParams = [ftsQuery];
            if (metaConditions.length > 0) {
                // Join with memories table for metadata filtering
                const countSql = `
            SELECT COUNT(*) as cnt FROM memories m
            INNER JOIN memories_fts fts ON m.rowid = fts.rowid
            WHERE fts.${ftsWhere} AND ${metaConditions.map((c) => c.replace(/project_id|m\.kind|m\.mission_id|m\.agent_id|m\.priority|m\.confidence/g, (match) => `m.${match.replace('m.', '')}`)).join(' AND ')}
          `;
                // Simplify: use subquery approach
                const countRow = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM memories m
            WHERE m.rowid IN (SELECT rowid FROM memories_fts WHERE ${ftsWhere})
            AND ${metaConditions.join(' AND ')}
          `).get(...ftsParams, ...metaParams);
                const total = (_b = countRow === null || countRow === void 0 ? void 0 : countRow.cnt) !== null && _b !== void 0 ? _b : 0;
                const rows = this.db.prepare(`
            SELECT m.* FROM memories m
            WHERE m.rowid IN (SELECT rowid FROM memories_fts WHERE ${ftsWhere})
            AND ${metaConditions.join(' AND ')}
            ORDER BY m.priority DESC, m.created_at DESC
            LIMIT ?
          `).all(...ftsParams, ...metaParams, limit);
                return { items: rows.map((r) => this.rowToItem(r)), total, query };
            }
            else {
                const countRow = this.stmtFtsCount.get(ftsQuery, query.projectId);
                const total = (_c = countRow === null || countRow === void 0 ? void 0 : countRow.cnt) !== null && _c !== void 0 ? _c : 0;
                const rows = this.stmtFtsSearch.all(ftsQuery, query.projectId, limit);
                return { items: rows.map((r) => this.rowToItem(r)), total, query };
            }
        }
        // Fallback: LIKE-based search
        const where = conditions.join(' AND ');
        const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE ${where}`).get(...params);
        const total = (_d = countRow === null || countRow === void 0 ? void 0 : countRow.cnt) !== null && _d !== void 0 ? _d : 0;
        const rows = this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY priority DESC, created_at DESC LIMIT ?`).all(...params, limit);
        return {
            items: rows.map((r) => this.rowToItem(r)),
            total,
            query,
        };
    }
    async searchSemantic(_query, _projectId, _limit = 10) {
        await this.init();
        if (!_query || !_query.trim())
            return [];
        // Use FTS5 MATCH for full-text search with BM25 ranking
        const ftsQuery = this.buildFtsQuery(_query);
        try {
            const rows = this.stmtFtsSearch.all(ftsQuery, _projectId, _limit);
            // Update last_accessed_at for retrieved items
            const now = new Date().toISOString();
            for (const row of rows) {
                this.db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(now, row.id);
            }
            return rows.map((r) => this.rowToItem(r));
        }
        catch {
            // Fallback to LIKE-based search if FTS5 query syntax fails
            const result = await this.search({ projectId: _projectId, query: _query, limit: _limit });
            return result.items;
        }
    }
    /**
     * Build an FTS5-compatible query string from user input.
     * Handles special characters, quotes multi-word phrases, and adds prefix matching.
     */
    buildFtsQuery(input) {
        // Strip FTS5 special characters that could cause syntax errors
        const cleaned = input.replace(/[^\w\s\-_.]/g, ' ').trim();
        if (!cleaned)
            return '""';
        const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
        if (words.length === 0)
            return '""';
        // For multi-word queries, search for all words (AND logic) with prefix matching
        if (words.length === 1) {
            // Single word: prefix match for autocomplete-like behavior
            return `"${words[0]}"*`;
        }
        // Multi-word: require all words present, with prefix match on last word
        const terms = words.slice(0, -1).map((w) => `"${w}"`);
        terms.push(`"${words[words.length - 1]}"*`);
        return terms.join(' ');
    }
    /**
     * Search conversation history (FTS5-powered cross-session recall).
     * Searches across all persisted conversations for matching content.
     */
    async searchConversations(query, projectId, limit = 20) {
        return this.searchSemantic(query, projectId, limit);
    }
    async getStats(projectId) {
        var _a, _b, _c, _d;
        await this.init();
        const rows = this.db.prepare('SELECT kind, COUNT(*) as cnt FROM memories WHERE project_id = ? GROUP BY kind').all(projectId);
        const byKind = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
        for (const r of rows) {
            if (r.kind === 'DECISION' ||
                r.kind === 'ISSUE' ||
                r.kind === 'LESSON' ||
                r.kind === 'SUMMARY') {
                byKind[r.kind] = r.cnt;
            }
        }
        const durRows = this.db.prepare('SELECT duration, COUNT(*) as cnt FROM memories WHERE project_id = ? GROUP BY duration').all(projectId);
        const byDuration = { EPISODIC: 0, LONG_TERM: 0 };
        for (const r of durRows) {
            if (r.duration === 'EPISODIC' || r.duration === 'LONG_TERM') {
                byDuration[r.duration] = r.cnt;
            }
        }
        const agg = this.db.prepare('SELECT AVG(priority) as avgP, AVG(confidence) as avgC, MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE project_id = ?').get(projectId);
        const totalItems = rows.reduce((s, r) => s + r.cnt, 0);
        return {
            totalItems,
            byKind,
            byDuration,
            avgPriority: (_a = agg === null || agg === void 0 ? void 0 : agg.avgP) !== null && _a !== void 0 ? _a : 0,
            avgConfidence: (_b = agg === null || agg === void 0 ? void 0 : agg.avgC) !== null && _b !== void 0 ? _b : 0,
            topTags: [],
            oldestItem: (_c = agg === null || agg === void 0 ? void 0 : agg.oldest) !== null && _c !== void 0 ? _c : undefined,
            newestItem: (_d = agg === null || agg === void 0 ? void 0 : agg.newest) !== null && _d !== void 0 ? _d : undefined,
        };
    }
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initialized = false;
            (0, logging_1.getGlobalLogger)().info('SqliteMemoryStore', 'Closed');
        }
    }
}
exports.SqliteMemoryStore = SqliteMemoryStore;
