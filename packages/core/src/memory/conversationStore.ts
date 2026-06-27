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

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import { walCheckpoint } from '../storage/walCheckpoint';
import { getCurrentTenantId } from '../runtime/tenantContext';

// ============================================================================
// Types
// ============================================================================

export interface ConversationTurn {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolCallId?: string;
  tokenCount?: number;
  importance: number; // 0-1, computed from content analysis
  createdAt: string;
}

export interface ConversationSession {
  id: string;
  projectId: string;
  agentId?: string;
  userId?: string;
  goal?: string;
  summary?: string; // LLM-generated summary of the session
  turnCount: number;
  totalTokens: number;
  startedAt: string;
  endedAt?: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ConversationSearchResult {
  session: ConversationSession;
  matchingTurns: ConversationTurn[];
  relevanceScore: number;
}

export interface ConversationSearchOptions {
  query: string;
  projectId: string;
  userId?: string;
  limit?: number;
  minImportance?: number;
  since?: string; // ISO date string
  includeSummaries?: boolean;
}

export interface ConversationStoreConfig {
  dbPath?: string;
  maxTurnsPerSession?: number;
  maxSessions?: number;
  autoSummarizeAfterTurns?: number;
  importanceThreshold?: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ConversationStoreConfig = {
  dbPath: '.commander/conversations.db',
  maxTurnsPerSession: 500,
  maxSessions: 10000,
  autoSummarizeAfterTurns: 100,
  importanceThreshold: 0.3,
};

// ============================================================================
// SQLite Types (local to avoid circular deps)
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
  reportSilentFailure(err, 'conversationStore:117');
  // better-sqlite3 not installed
}

// ============================================================================
// ConversationStore
// ============================================================================

export class ConversationStore {
  private db: BetterSqlite3DB | null = null;
  private config: ConversationStoreConfig;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Prepared statements
  private stmtInsertSession!: BetterSqlite3Stmt;
  private stmtInsertTurn!: BetterSqlite3Stmt;
  private stmtGetSession!: BetterSqlite3Stmt;
  private stmtGetTurns!: BetterSqlite3Stmt;
  private stmtUpdateSummary!: BetterSqlite3Stmt;
  private stmtEndSession!: BetterSqlite3Stmt;
  private stmtFtsSearch!: BetterSqlite3Stmt;
  private stmtRecentSessions!: BetterSqlite3Stmt;
  private stmtDeleteOldSessions!: BetterSqlite3Stmt;
  private stmtDeleteByUser!: BetterSqlite3Stmt;
  private stmtGetSessionsByUser!: BetterSqlite3Stmt;

  constructor(config?: Partial<ConversationStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 is required. Install with: pnpm add better-sqlite3');
    }

    this.initPromise = (async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const dbPath = this.config.dbPath!;
      const dir = path.dirname(dbPath);
      if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        try {
          await fs.chmod(dir, 0o700);
        } catch (err) {
          reportSilentFailure(err, 'conversationStore:163');
          /* best-effort */
        }
      }

      this.db = new BetterSqlite3(dbPath);
      try {
        await fs.chmod(dbPath, 0o600);
      } catch (err) {
        reportSilentFailure(err, 'conversationStore:172');
        /* best-effort */
      }
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      this.createSchema();
      this.prepareStatements();
      this.initialized = true;

      getGlobalLogger().info('ConversationStore', 'Initialized', { path: this.config.dbPath });
    })();

    return this.initPromise;
  }

  private createSchema(): void {
    this.db!.exec(`
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
        metadata TEXT NOT NULL DEFAULT '{}',
        tenant_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conv_sessions_project
        ON conversation_sessions(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_sessions_user
        ON conversation_sessions(user_id, started_at DESC) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_conv_sessions_tenant
        ON conversation_sessions(tenant_id, project_id) WHERE tenant_id IS NOT NULL;

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

    this.migrate();
  }

  /**
   * Idempotent column-based migrations for existing databases.
   * CREATE TABLE IF NOT EXISTS won't add new columns to an existing table,
   * so we check PRAGMA table_info and ALTER TABLE when the column is missing.
   */
  private migrate(): void {
    if (!this.db) return;
    const cols = (
      this.db.prepare('PRAGMA table_info(conversation_sessions)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    // Add tenant_id column if it doesn't exist (migration for existing DBs)
    if (!cols.includes('tenant_id')) {
      this.db.exec('ALTER TABLE conversation_sessions ADD COLUMN tenant_id TEXT');
    }
  }

  private prepareStatements(): void {
    const d = this.db!;

    this.stmtInsertSession = d.prepare(`
      INSERT INTO conversation_sessions (id, project_id, agent_id, user_id, goal, started_at, tags, metadata, tenant_id)
      VALUES (@id, @projectId, @agentId, @userId, @goal, @startedAt, @tags, @metadata, @tenantId)
    `);

    this.stmtInsertTurn = d.prepare(`
      INSERT INTO conversation_turns (id, session_id, role, content, tool_name, tool_call_id, token_count, importance, created_at)
      VALUES (@id, @sessionId, @role, @content, @toolName, @toolCallId, @tokenCount, @importance, @createdAt)
    `);

    this.stmtGetSession = d.prepare(
      'SELECT * FROM conversation_sessions WHERE id = ? AND (tenant_id IS ? OR ? IS NULL)',
    );

    this.stmtGetTurns = d.prepare(
      'SELECT t.* FROM conversation_turns t INNER JOIN conversation_sessions s ON t.session_id = s.id WHERE t.session_id = ? AND (s.tenant_id IS ? OR ? IS NULL) ORDER BY t.created_at ASC',
    );

    this.stmtUpdateSummary = d.prepare(
      'UPDATE conversation_sessions SET summary = ? WHERE id = ? AND (tenant_id IS ? OR ? IS NULL)',
    );

    this.stmtEndSession = d.prepare(
      'UPDATE conversation_sessions SET ended_at = ?, turn_count = ?, total_tokens = ? WHERE id = ? AND (tenant_id IS ? OR ? IS NULL)',
    );

    this.stmtFtsSearch = d.prepare(`
      SELECT t.*, s.project_id, s.goal, s.summary, s.user_id
      FROM conversation_turns t
      INNER JOIN conversation_sessions s ON t.session_id = s.id
      WHERE t.rowid IN (
        SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?
        ORDER BY rank
      )
      AND s.project_id = ?
      AND (s.tenant_id IS ? OR ? IS NULL)
      LIMIT ?
    `);

    this.stmtRecentSessions = d.prepare(`
      SELECT * FROM conversation_sessions
      WHERE project_id = ? AND (tenant_id IS ? OR ? IS NULL)
      ORDER BY started_at DESC
      LIMIT ?
    `);

    this.stmtDeleteOldSessions = d.prepare(`
      DELETE FROM conversation_sessions
      WHERE id IN (
        SELECT id FROM conversation_sessions
        WHERE project_id = ? AND (tenant_id IS ? OR ? IS NULL)
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ?
      )
    `);

    // GDPR: Delete all sessions for a specific user
    this.stmtDeleteByUser = d.prepare(`
      DELETE FROM conversation_sessions WHERE user_id = ?
    `);

    // GDPR: Get all sessions for a specific user (for DSAR export)
    this.stmtGetSessionsByUser = d.prepare(`
      SELECT * FROM conversation_sessions WHERE user_id = ? ORDER BY started_at DESC
    `);
  }

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------

  /**
   * Start a new conversation session.
   */
  async startSession(params: {
    projectId: string;
    agentId?: string;
    userId?: string;
    goal?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<ConversationSession> {
    await this.init();

    const session: ConversationSession = {
      id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: params.projectId,
      agentId: params.agentId,
      userId: params.userId,
      goal: params.goal,
      turnCount: 0,
      totalTokens: 0,
      startedAt: new Date().toISOString(),
      tags: params.tags ?? [],
      metadata: params.metadata ?? {},
    };

    this.stmtInsertSession.run({
      id: session.id,
      projectId: session.projectId,
      agentId: session.agentId ?? null,
      userId: session.userId ?? null,
      goal: session.goal ?? null,
      startedAt: session.startedAt,
      tags: JSON.stringify(session.tags),
      metadata: JSON.stringify(session.metadata),
      tenantId: getCurrentTenantId() ?? null,
    });

    return session;
  }

  /**
   * End a conversation session.
   */
  async endSession(sessionId: string): Promise<void> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    const turns = this.stmtGetTurns.all<SqliteRow>(sessionId, tenantId, tenantId);
    const totalTokens = turns.reduce(
      (sum: number, t: SqliteRow) => sum + ((t.token_count as number) ?? 0),
      0,
    );
    this.stmtEndSession.run(
      new Date().toISOString(),
      turns.length,
      totalTokens,
      sessionId,
      tenantId,
      tenantId,
    );
  }

  /**
   * Get a session by ID.
   */
  async getSession(sessionId: string): Promise<ConversationSession | null> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    const row = this.stmtGetSession.get<SqliteRow>(sessionId, tenantId, tenantId);
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get recent sessions for a project.
   */
  async getRecentSessions(projectId: string, limit = 20): Promise<ConversationSession[]> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    const rows = this.stmtRecentSessions.all<SqliteRow>(projectId, tenantId, tenantId, limit);
    return rows.map((r) => this.rowToSession(r));
  }

  // --------------------------------------------------------------------------
  // Turn Management
  // --------------------------------------------------------------------------

  /**
   * Record a conversation turn (message).
   */
  async addTurn(params: {
    sessionId: string;
    role: ConversationTurn['role'];
    content: string;
    toolName?: string;
    toolCallId?: string;
    tokenCount?: number;
  }): Promise<ConversationTurn> {
    await this.init();

    const turn: ConversationTurn = {
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
      toolName: turn.toolName ?? null,
      toolCallId: turn.toolCallId ?? null,
      tokenCount: turn.tokenCount ?? null,
      importance: turn.importance,
      createdAt: turn.createdAt,
    });

    return turn;
  }

  /**
   * Get all turns for a session.
   */
  async getTurns(sessionId: string): Promise<ConversationTurn[]> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    const rows = this.stmtGetTurns.all<SqliteRow>(sessionId, tenantId, tenantId);
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
  async search(options: ConversationSearchOptions): Promise<ConversationSearchResult[]> {
    await this.init();
    if (!options.query.trim()) return [];

    const ftsQuery = this.buildFtsQuery(options.query);
    const limit = options.limit ?? 20;
    const tenantId = getCurrentTenantId() ?? null;

    try {
      const rows = this.stmtFtsSearch.all<
        SqliteRow & {
          project_id: string;
          goal: string | null;
          summary: string | null;
          user_id: string | null;
        }
      >(ftsQuery, options.projectId, tenantId, tenantId, limit * 3); // Fetch more to group by session

      // Group by session
      const sessionMap = new Map<
        string,
        {
          session: ConversationSession;
          turns: ConversationTurn[];
        }
      >();

      for (const row of rows) {
        const sessionId = row.session_id as string;
        if (!sessionMap.has(sessionId)) {
          // Fetch full session
          const sessionRow = this.stmtGetSession.get<SqliteRow>(sessionId, tenantId, tenantId);
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
      const results: ConversationSearchResult[] = [];
      const sessionEntries = Array.from(sessionMap.entries());
      for (const [, entry] of sessionEntries) {
        // Filter by importance if specified
        const filteredTurns = options.minImportance
          ? entry.turns.filter((t: ConversationTurn) => t.importance >= options.minImportance!)
          : entry.turns;

        if (filteredTurns.length === 0) continue;

        // Filter by date if specified
        if (options.since) {
          const sinceDate = new Date(options.since);
          const sessionDate = new Date(entry.session.startedAt);
          if (sessionDate < sinceDate) continue;
        }

        // Filter by user if specified
        if (options.userId && entry.session.userId !== options.userId) continue;

        results.push({
          session: entry.session,
          matchingTurns: filteredTurns,
          relevanceScore: this.calculateRelevance(entry.session, filteredTurns),
        });
      }

      // Sort by relevance and return top results
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return results.slice(0, limit);
    } catch (err) {
      getGlobalLogger().warn('ConversationStore', 'FTS search failed, falling back', {
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Get a summary of recent conversations for context injection.
   * Useful for providing the agent with "what happened before" context.
   */
  async getRecentContext(projectId: string, limit = 5): Promise<string> {
    const sessions = await this.getRecentSessions(projectId, limit);
    if (sessions.length === 0) return '';

    const parts: string[] = ['## Recent Conversation History\n'];
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
  async setSummary(sessionId: string, summary: string): Promise<void> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    this.stmtUpdateSummary.run(summary, sessionId, tenantId, tenantId);
  }

  /**
   * Prune old sessions to stay within maxSessions limit.
   */
  async prune(projectId: string): Promise<number> {
    await this.init();
    const tenantId = getCurrentTenantId() ?? null;
    const before = this.db!.prepare(
      'SELECT COUNT(*) as cnt FROM conversation_sessions WHERE project_id = ? AND (tenant_id IS ? OR ? IS NULL)',
    ).get<{ cnt: number }>(projectId, tenantId, tenantId);
    const currentCount = before?.cnt ?? 0;

    if (currentCount <= this.config.maxSessions!) return 0;

    this.stmtDeleteOldSessions.run(projectId, tenantId, tenantId, this.config.maxSessions!);

    const after = this.db!.prepare(
      'SELECT COUNT(*) as cnt FROM conversation_sessions WHERE project_id = ? AND (tenant_id IS ? OR ? IS NULL)',
    ).get<{ cnt: number }>(projectId, tenantId, tenantId);
    return currentCount - (after?.cnt ?? 0);
  }

  /**
   * GDPR Article 17: Delete all conversation sessions for a specific user.
   * Turns are automatically cascade-deleted (ON DELETE CASCADE).
   * Returns the number of deleted sessions.
   */
  async deleteByUser(userId: string): Promise<number> {
    await this.init();
    const result = this.stmtDeleteByUser.run(userId);
    return result.changes;
  }

  /**
   * GDPR Article 15 (DSAR): Get all sessions for a specific user.
   * Used for data subject access requests.
   */
  async getSessionsByUser(userId: string): Promise<ConversationSession[]> {
    await this.init();
    const rows = this.stmtGetSessionsByUser.all(userId) as ConversationSession[];
    return rows;
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  /**
   * Calculate importance of a conversation turn based on content analysis.
   * Higher importance = more likely to be useful for future recall.
   */
  private calculateImportance(content: string, role: ConversationTurn['role']): number {
    let score = 0.5; // baseline

    // Role-based boost
    if (role === 'user') score += 0.1; // User messages are intent signals
    if (role === 'system') score += 0.2; // System messages are structural

    // Content-based signals
    const lower = content.toLowerCase();

    // Decision signals
    if (/\b(decided?|choosing|selected|picked|went with)\b/.test(lower)) score += 0.15;
    if (/\b(because|reason|rationale|trade-?off)\b/.test(lower)) score += 0.1;

    // Error/issue signals
    if (/\b(error|bug|issue|problem|failed|broken|fix)\b/.test(lower)) score += 0.1;

    // Learning signals
    if (/\b(learned|realized|insight|key takeaway|important)\b/.test(lower)) score += 0.15;

    // Code/file references boost (concrete = more retrievable)
    if (/\b[\w/]+\.(ts|js|py|rs|go|java|cpp|md)\b/.test(content)) score += 0.1;

    // Length penalty for very short turns (low information density)
    if (content.length < 20) score -= 0.2;

    // Length boost for substantial turns
    if (content.length > 500) score += 0.05;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate relevance score for search results.
   * Uses Generative Agents-style scoring: recency + importance + match quality.
   */
  private calculateRelevance(session: ConversationSession, turns: ConversationTurn[]): number {
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
  private buildFtsQuery(input: string): string {
    const cleaned = input.replace(/[^\w\s\-_.一-鿿]/g, ' ').trim();
    if (!cleaned) return '""';
    // Allow single-char tokens for CJK and meaningful short words (ts, go, etc.)
    const words = cleaned.split(/\s+/).filter((w) => w.length >= 1);
    if (words.length === 0) return '""';
    if (words.length === 1) return `"${words[0]}"*`;
    // Last word gets prefix matching for typeahead-style search
    const terms = words.slice(0, -1).map((w) => `"${w}"`);
    terms.push(`"${words[words.length - 1]}"*`);
    return terms.join(' ');
  }

  private rowToSession(row: SqliteRow): ConversationSession {
    let tags: string[] = [];
    let metadata: Record<string, unknown> = {};
    try {
      tags = JSON.parse((row.tags as string) || '[]');
    } catch (err) {
      reportSilentFailure(err, 'conversationStore:663');
      /* ok */
    }
    try {
      metadata = JSON.parse((row.metadata as string) || '{}');
    } catch (err) {
      reportSilentFailure(err, 'conversationStore:669');
      /* ok */
    }

    return {
      id: row.id as string,
      projectId: row.project_id as string,
      agentId: (row.agent_id as string) || undefined,
      userId: (row.user_id as string) || undefined,
      goal: (row.goal as string) || undefined,
      summary: (row.summary as string) || undefined,
      turnCount: row.turn_count as number,
      totalTokens: row.total_tokens as number,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at as string) || undefined,
      tags,
      metadata,
    };
  }

  private rowToTurn(row: SqliteRow): ConversationTurn {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as ConversationTurn['role'],
      content: row.content as string,
      toolName: (row.tool_name as string) || undefined,
      toolCallId: (row.tool_call_id as string) || undefined,
      tokenCount: (row.token_count as number) || undefined,
      importance: row.importance as number,
      createdAt: row.created_at as string,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      walCheckpoint(this.db);
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalConversationStore: ConversationStore | null = null;

export function getConversationStore(config?: Partial<ConversationStoreConfig>): ConversationStore {
  if (!globalConversationStore) {
    globalConversationStore = new ConversationStore(config);
  }
  return globalConversationStore;
}
