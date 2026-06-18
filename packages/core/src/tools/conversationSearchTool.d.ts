/**
 * SearchConversationsTool — FTS5-powered historical conversation search.
 *
 * Wraps the ConversationStore's FTS5 full-text search for use by agents.
 * Enables agents to recall past sessions, decisions, and context.
 *
 * Matches Hermes Agent's FTS5 session search capability:
 * - Full-text search across all past conversation turns
 * - Returns matching turns grouped by session with relevance scores
 * - Supports recency + importance filtering
 */
import type { Tool, ToolDefinition } from '../runtime/types';
export declare class SearchConversationsTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
/**
 * CLI-oriented search — searches conversations from the command line.
 * Returns raw JSON for programmatic consumption or formatted text for humans.
 */
export declare function searchConversationsCLI(query: string, options?: {
    projectId?: string;
    limit?: number;
    minImportance?: number;
    sinceDays?: number;
    format?: 'text' | 'json';
}): Promise<string>;
//# sourceMappingURL=conversationSearchTool.d.ts.map