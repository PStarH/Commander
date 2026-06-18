"use strict";
/**
 * Conversation Persistence Layer
 *
 * Persists agent conversation history (messages, tool calls, decisions) to SQLite
 * with FTS5 full-text search. Enables cross-session conversation recall, similar
 * to Hermes Agent's FTS5 session search with LLM summarization.
 *
 * Key capabilities:
 * - Persist complete conversation turns (user, assistant, tool, system messages)
 * - FTS5-powered full-text search across all past conversations
 * - Session grouping and metadata tracking
 * - Automatic summarization of old sessions for context compression
 * - Integration with MemoryStore for knowledge extraction
 *
 * Design inspired by:
 * - Hermes Agent's FTS5 session search
 * - Honcho's dialectic user modeling
 * - Generative Agents' retrieval scoring (recency + importance + relevance)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationStore = void 0;
exports.getConversationStore = getConversationStore;
const logging_1 = require("../logging");
const fs_1 = require("fs");
// ============================================================================
// Default Config
// ============================================================================
const DEFAULT_CONFIG = {
    dbPath: '.commander/conversations.db',
    maxTurnsPerSession: 500,
    maxSessions: 10000,
    autoSummarizeAfterTurns: 100,
    importanceThreshold: 0.3,
};
let BetterSqlite3 = null;
try {
    BetterSqlite3 = require('better-sqlite3');
}
catch {
    // better-sqlite3 not installed
}
// ============================================================================
// ConversationStore
// ============================================================================
class ConversationStore {
    constructor(config) {
        this.db = null;
        this.initialized = false;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    async init() {
        if (this.initialized)
            return;
        if (!BetterSqlite3) {
            throw new Error('better-sqlite3 is required. Install with: pnpm add better-sqlite3');
        }
        const dir = this.config.dbPath.includes('/')
            ? this.config.dbPath.substring(0, this.config.dbPath.lastIndexOf('/'))
            : '.';
        if (dir) {
            (0, fs_1.mkdirSync)(dir, { recursive: true, mode: 0o700 });
            try {
                (0, fs_1.chmodSync)(dir, 0o700);
            }
            catch {
                /* best-effort */
            }
        }
        this.db = new BetterSqlite3(this.config.dbPath);
        try {
            (0, fs_1.chmodSync)(this.config.dbPath, 0o600);
        }
        catch {
            /* best-effort */
        }
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.createSchema();
        this.prepareStatements();
        this.initialized = true;
        (0, logging_1.getGlobalLogger)().info('ConversationStore', 'Initialized', { path: this.config.dbPath });
    }
    createSchema() {
        this.db.exec(`
      -- Conversation sessions
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT,
        user_id TEXT,
        goal TEXT,
        summary TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_conv_sessions_project
        ON conversation_sessions(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_sessions_user
        ON conversation_sessions(user_id, started_at DESC) WHERE user_id IS NOT NULL;

      -- Conversation turns (individual messages)
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        token_count INTEGER,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_turns_session
        ON conversation_turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conv_turns_importance
        ON conversation_turns(importance DESC);

      -- FTS5 index for full-text search across all conversation content
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
        content,
        tool_name,
        content='conversation_turns',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS5 in sync
      CREATE TRIGGER IF NOT EXISTS conv_turns_ai AFTER INSERT ON conversation_turns BEGIN
        INSERT INTO conversation_fts(rowid, content, tool_name)
        VALUES (new.rowid, new.content, new.tool_name);
      END;

      CREATE TRIGGER IF NOT EXISTS conv_turns_ad AFTER DELETE ON conversation_turns BEGIN
        INSERT INTO conversation_fts(conversation_fts, rowid, content, tool_name)
        VALUES ('delete', old.rowid, old.content, old.tool_name);
      END;

      CREATE TRIGGER IF NOT EXISTS conv_turns_au AFTER UPDATE ON conversation_turns BEGIN
        INSERT INTO conversation_fts(conversation_fts, rowid, content, tool_name)
        VALUES ('delete', old.rowid, old.content, old.tool_name);
        INSERT INTO conversation_fts(rowid, content, tool_name)
        VALUES (new.rowid, new.content, new.tool_name);
      END;
    `);
    }
    prepareStatements() {
        const d = this.db;
        this.stmtInsertSession = d.prepare(`
      INSERT INTO conversation_sessions (id, project_id, agent_id, user_id, goal, started_at, tags, metadata)
      VALUES (@id, @projectId, @agentId, @userId, @goal, @startedAt, @tags, @metadata)
    `);
        this.stmtInsertTurn = d.prepare(`
      INSERT INTO conversation_turns (id, session_id, role, content, tool_name, tool_call_id, token_count, importance, created_at)
      VALUES (@id, @sessionId, @role, @content, @toolName, @toolCallId, @tokenCount, @importance, @createdAt)
    `);
        this.stmtGetSession = d.prepare('SELECT * FROM conversation_sessions WHERE id = ?');
        this.stmtGetTurns = d.prepare('SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY created_at ASC');
        this.stmtUpdateSummary = d.prepare('UPDATE conversation_sessions SET summary = ? WHERE id = ?');
        this.stmtEndSession = d.prepare('UPDATE conversation_sessions SET ended_at = ?, turn_count = ?, total_tokens = ? WHERE id = ?');
        this.stmtFtsSearch = d.prepare(`
      SELECT t.*, s.project_id, s.goal, s.summary, s.user_id
      FROM conversation_turns t
      INNER JOIN conversation_sessions s ON t.session_id = s.id
      WHERE t.rowid IN (
        SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?
        ORDER BY rank
      )
      AND s.project_id = ?
      LIMIT ?
    `);
        this.stmtRecentSessions = d.prepare(`
      SELECT * FROM conversation_sessions
      WHERE project_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
        this.stmtDeleteOldSessions = d.prepare(`
      DELETE FROM conversation_sessions
      WHERE id IN (
        SELECT id FROM conversation_sessions
        WHERE project_id = ?
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ?
      )
    `);
    }
    // --------------------------------------------------------------------------
    // Session Management
    // --------------------------------------------------------------------------
    /**
     * Start a new conversation session.
     */
    async startSession(params) {
        var _a, _b, _c, _d, _e;
        await this.init();
        const session = {
            id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            projectId: params.projectId,
            agentId: params.agentId,
            userId: params.userId,
            goal: params.goal,
            turnCount: 0,
            totalTokens: 0,
            startedAt: new Date().toISOString(),
            tags: (_a = params.tags) !== null && _a !== void 0 ? _a : [],
            metadata: (_b = params.metadata) !== null && _b !== void 0 ? _b : {},
        };
        this.stmtInsertSession.run({
            id: session.id,
            projectId: session.projectId,
            agentId: (_c = session.agentId) !== null && _c !== void 0 ? _c : null,
            userId: (_d = session.userId) !== null && _d !== void 0 ? _d : null,
            goal: (_e = session.goal) !== null && _e !== void 0 ? _e : null,
            startedAt: session.startedAt,
            tags: JSON.stringify(session.tags),
            metadata: JSON.stringify(session.metadata),
        });
        return session;
    }
    /**
     * End a conversation session.
     */
    async endSession(sessionId) {
        await this.init();
        const turns = this.stmtGetTurns.all(sessionId);
        const totalTokens = turns.reduce((sum, t) => { var _a; return sum + ((_a = t.token_count) !== null && _a !== void 0 ? _a : 0); }, 0);
        this.stmtEndSession.run(new Date().toISOString(), turns.length, totalTokens, sessionId);
    }
    /**
     * Get a session by ID.
     */
    async getSession(sessionId) {
        await this.init();
        const row = this.stmtGetSession.get(sessionId);
        return row ? this.rowToSession(row) : null;
    }
    /**
     * Get recent sessions for a project.
     */
    async getRecentSessions(projectId, limit = 20) {
        await this.init();
        const rows = this.stmtRecentSessions.all(projectId, limit);
        return rows.map((r) => this.rowToSession(r));
    }
    // --------------------------------------------------------------------------
    // Turn Management
    // --------------------------------------------------------------------------
    /**
     * Record a conversation turn (message).
     */
    async addTurn(params) {
        var _a, _b, _c;
        await this.init();
        const turn = {
            id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: params.sessionId,
            role: params.role,
            content: params.content,
            toolName: params.toolName,
            toolCallId: params.toolCallId,
            tokenCount: params.tokenCount,
            importance: this.calculateImportance(params.content, params.role),
            createdAt: new Date().toISOString(),
        };
        this.stmtInsertTurn.run({
            id: turn.id,
            sessionId: turn.sessionId,
            role: turn.role,
            content: turn.content,
            toolName: (_a = turn.toolName) !== null && _a !== void 0 ? _a : null,
            toolCallId: (_b = turn.toolCallId) !== null && _b !== void 0 ? _b : null,
            tokenCount: (_c = turn.tokenCount) !== null && _c !== void 0 ? _c : null,
            importance: turn.importance,
            createdAt: turn.createdAt,
        });
        return turn;
    }
    /**
     * Get all turns for a session.
     */
    async getTurns(sessionId) {
        await this.init();
        const rows = this.stmtGetTurns.all(sessionId);
        return rows.map((r) => this.rowToTurn(r));
    }
    // --------------------------------------------------------------------------
    // Search (FTS5-powered)
    // --------------------------------------------------------------------------
    /**
     * Search across all conversation history using FTS5 full-text search.
     * Returns matching turns grouped by session, ranked by relevance.
     * This is the key feature that matches Hermes' FTS5 session search.
     */
    async search(options) {
        var _a;
        await this.init();
        if (!options.query.trim())
            return [];
        const ftsQuery = this.buildFtsQuery(options.query);
        const limit = (_a = options.limit) !== null && _a !== void 0 ? _a : 20;
        try {
            const rows = this.stmtFtsSearch.all(ftsQuery, options.projectId, limit * 3); // Fetch more to group by session
            // Group by session
            const sessionMap = new Map();
            for (const row of rows) {
                const sessionId = row.session_id;
                if (!sessionMap.has(sessionId)) {
                    // Fetch full session
                    const sessionRow = this.stmtGetSession.get(sessionId);
                    if (sessionRow) {
                        sessionMap.set(sessionId, {
                            session: this.rowToSession(sessionRow),
                            turns: [],
                        });
                    }
                }
                const entry = sessionMap.get(sessionId);
                if (entry) {
                    entry.turns.push(this.rowToTurn(row));
                }
            }
            // Build results with relevance scoring
            const results = [];
            const sessionEntries = Array.from(sessionMap.entries());
            for (const [, entry] of sessionEntries) {
                // Filter by importance if specified
                const filteredTurns = options.minImportance
                    ? entry.turns.filter((t) => t.importance >= options.minImportance)
                    : entry.turns;
                if (filteredTurns.length === 0)
                    continue;
                // Filter by date if specified
                if (options.since) {
                    const sinceDate = new Date(options.since);
                    const sessionDate = new Date(entry.session.startedAt);
                    if (sessionDate < sinceDate)
                        continue;
                }
                // Filter by user if specified
                if (options.userId && entry.session.userId !== options.userId)
                    continue;
                results.push({
                    session: entry.session,
                    matchingTurns: filteredTurns,
                    relevanceScore: this.calculateRelevance(entry.session, filteredTurns),
                });
            }
            // Sort by relevance and return top results
            results.sort((a, b) => b.relevanceScore - a.relevanceScore);
            return results.slice(0, limit);
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().warn('ConversationStore', 'FTS search failed, falling back', {
                error: String(err),
            });
            return [];
        }
    }
    /**
     * Get a summary of recent conversations for context injection.
     * Useful for providing the agent with "what happened before" context.
     */
    async getRecentContext(projectId, limit = 5) {
        const sessions = await this.getRecentSessions(projectId, limit);
        if (sessions.length === 0)
            return '';
        const parts = ['## Recent Conversation History\n'];
        for (const session of sessions) {
            const date = new Date(session.startedAt).toLocaleDateString();
            const goal = session.goal || 'No specific goal';
            const summary = session.summary || '(no summary)';
            parts.push(`### Session ${date}: ${goal}`);
            parts.push(`Summary: ${summary}`);
            parts.push(`Turns: ${session.turnCount}, Tokens: ${session.totalTokens}\n`);
        }
        return parts.join('\n');
    }
    /**
     * Set an LLM-generated summary for a session.
     */
    async setSummary(sessionId, summary) {
        await this.init();
        this.stmtUpdateSummary.run(summary, sessionId);
    }
    /**
     * Prune old sessions to stay within maxSessions limit.
     */
    async prune(projectId) {
        var _a, _b;
        await this.init();
        const before = this.db.prepare('SELECT COUNT(*) as cnt FROM conversation_sessions WHERE project_id = ?').get(projectId);
        const currentCount = (_a = before === null || before === void 0 ? void 0 : before.cnt) !== null && _a !== void 0 ? _a : 0;
        if (currentCount <= this.config.maxSessions)
            return 0;
        this.stmtDeleteOldSessions.run(projectId, this.config.maxSessions);
        const after = this.db.prepare('SELECT COUNT(*) as cnt FROM conversation_sessions WHERE project_id = ?').get(projectId);
        return currentCount - ((_b = after === null || after === void 0 ? void 0 : after.cnt) !== null && _b !== void 0 ? _b : 0);
    }
    // --------------------------------------------------------------------------
    // Internal Helpers
    // --------------------------------------------------------------------------
    /**
     * Calculate importance of a conversation turn based on content analysis.
     * Higher importance = more likely to be useful for future recall.
     */
    calculateImportance(content, role) {
        let score = 0.5; // baseline
        // Role-based boost
        if (role === 'user')
            score += 0.1; // User messages are intent signals
        if (role === 'system')
            score += 0.2; // System messages are structural
        // Content-based signals
        const lower = content.toLowerCase();
        // Decision signals
        if (/\b(decided?|choosing|selected|picked|went with)\b/.test(lower))
            score += 0.15;
        if (/\b(because|reason|rationale|trade-?off)\b/.test(lower))
            score += 0.1;
        // Error/issue signals
        if (/\b(error|bug|issue|problem|failed|broken|fix)\b/.test(lower))
            score += 0.1;
        // Learning signals
        if (/\b(learned|realized|insight|key takeaway|important)\b/.test(lower))
            score += 0.15;
        // Code/file references boost (concrete = more retrievable)
        if (/\b[\w/]+\.(ts|js|py|rs|go|java|cpp|md)\b/.test(content))
            score += 0.1;
        // Length penalty for very short turns (low information density)
        if (content.length < 20)
            score -= 0.2;
        // Length boost for substantial turns
        if (content.length > 500)
            score += 0.05;
        return Math.max(0, Math.min(1, score));
    }
    /**
     * Calculate relevance score for search results.
     * Uses Generative Agents-style scoring: recency + importance + match quality.
     */
    calculateRelevance(session, turns) {
        // Recency: exponential decay from session start
        const ageMs = Date.now() - new Date(session.startedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const recency = Math.exp(-ageHours / 168); // Half-life ~1 week
        // Importance: average of matching turns
        const avgImportance = turns.reduce((s, t) => s + t.importance, 0) / turns.length;
        // Match density: more matching turns = more relevant
        const matchDensity = Math.min(turns.length / 5, 1);
        return recency * 0.3 + avgImportance * 0.4 + matchDensity * 0.3;
    }
    /**
     * Build FTS5 query from user input.
     * Handles edge cases: special chars, single chars, CJK text.
     */
    buildFtsQuery(input) {
        const cleaned = input.replace(/[^\w\s\-_.一-鿿]/g, ' ').trim();
        if (!cleaned)
            return '""';
        // Allow single-char tokens for CJK and meaningful short words (ts, go, etc.)
        const words = cleaned.split(/\s+/).filter((w) => w.length >= 1);
        if (words.length === 0)
            return '""';
        if (words.length === 1)
            return `"${words[0]}"*`;
        // Last word gets prefix matching for typeahead-style search
        const terms = words.slice(0, -1).map((w) => `"${w}"`);
        terms.push(`"${words[words.length - 1]}"*`);
        return terms.join(' ');
    }
    rowToSession(row) {
        let tags = [];
        let metadata = {};
        try {
            tags = JSON.parse(row.tags || '[]');
        }
        catch {
            /* ok */
        }
        try {
            metadata = JSON.parse(row.metadata || '{}');
        }
        catch {
            /* ok */
        }
        return {
            id: row.id,
            projectId: row.project_id,
            agentId: row.agent_id || undefined,
            userId: row.user_id || undefined,
            goal: row.goal || undefined,
            summary: row.summary || undefined,
            turnCount: row.turn_count,
            totalTokens: row.total_tokens,
            startedAt: row.started_at,
            endedAt: row.ended_at || undefined,
            tags,
            metadata,
        };
    }
    rowToTurn(row) {
        return {
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            toolName: row.tool_name || undefined,
            toolCallId: row.tool_call_id || undefined,
            tokenCount: row.token_count || undefined,
            importance: row.importance,
            createdAt: row.created_at,
        };
    }
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initialized = false;
        }
    }
}
exports.ConversationStore = ConversationStore;
// ============================================================================
// Singleton
// ============================================================================
let globalConversationStore = null;
function getConversationStore(config) {
    if (!globalConversationStore) {
        globalConversationStore = new ConversationStore(config);
    }
    return globalConversationStore;
}
