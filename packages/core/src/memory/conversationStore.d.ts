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
export interface ConversationTurn {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    toolName?: string;
    toolCallId?: string;
    tokenCount?: number;
    importance: number;
    createdAt: string;
}
export interface ConversationSession {
    id: string;
    projectId: string;
    agentId?: string;
    userId?: string;
    goal?: string;
    summary?: string;
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
    since?: string;
    includeSummaries?: boolean;
}
export interface ConversationStoreConfig {
    dbPath?: string;
    maxTurnsPerSession?: number;
    maxSessions?: number;
    autoSummarizeAfterTurns?: number;
    importanceThreshold?: number;
}
export declare class ConversationStore {
    private db;
    private config;
    private initialized;
    private stmtInsertSession;
    private stmtInsertTurn;
    private stmtGetSession;
    private stmtGetTurns;
    private stmtUpdateSummary;
    private stmtEndSession;
    private stmtFtsSearch;
    private stmtRecentSessions;
    private stmtDeleteOldSessions;
    constructor(config?: Partial<ConversationStoreConfig>);
    init(): Promise<void>;
    private createSchema;
    private prepareStatements;
    /**
     * Start a new conversation session.
     */
    startSession(params: {
        projectId: string;
        agentId?: string;
        userId?: string;
        goal?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<ConversationSession>;
    /**
     * End a conversation session.
     */
    endSession(sessionId: string): Promise<void>;
    /**
     * Get a session by ID.
     */
    getSession(sessionId: string): Promise<ConversationSession | null>;
    /**
     * Get recent sessions for a project.
     */
    getRecentSessions(projectId: string, limit?: number): Promise<ConversationSession[]>;
    /**
     * Record a conversation turn (message).
     */
    addTurn(params: {
        sessionId: string;
        role: ConversationTurn['role'];
        content: string;
        toolName?: string;
        toolCallId?: string;
        tokenCount?: number;
    }): Promise<ConversationTurn>;
    /**
     * Get all turns for a session.
     */
    getTurns(sessionId: string): Promise<ConversationTurn[]>;
    /**
     * Search across all conversation history using FTS5 full-text search.
     * Returns matching turns grouped by session, ranked by relevance.
     * This is the key feature that matches Hermes' FTS5 session search.
     */
    search(options: ConversationSearchOptions): Promise<ConversationSearchResult[]>;
    /**
     * Get a summary of recent conversations for context injection.
     * Useful for providing the agent with "what happened before" context.
     */
    getRecentContext(projectId: string, limit?: number): Promise<string>;
    /**
     * Set an LLM-generated summary for a session.
     */
    setSummary(sessionId: string, summary: string): Promise<void>;
    /**
     * Prune old sessions to stay within maxSessions limit.
     */
    prune(projectId: string): Promise<number>;
    /**
     * Calculate importance of a conversation turn based on content analysis.
     * Higher importance = more likely to be useful for future recall.
     */
    private calculateImportance;
    /**
     * Calculate relevance score for search results.
     * Uses Generative Agents-style scoring: recency + importance + match quality.
     */
    private calculateRelevance;
    /**
     * Build FTS5 query from user input.
     * Handles edge cases: special chars, single chars, CJK text.
     */
    private buildFtsQuery;
    private rowToSession;
    private rowToTurn;
    close(): Promise<void>;
}
export declare function getConversationStore(config?: Partial<ConversationStoreConfig>): ConversationStore;
//# sourceMappingURL=conversationStore.d.ts.map