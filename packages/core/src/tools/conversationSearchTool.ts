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
import { getConversationStore } from '../memory/conversationStore';
import type { ConversationSearchOptions } from '../memory/conversationStore';
import { getGlobalLogger } from '../logging';

export class SearchConversationsTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'search_conversations',
    description:
      'Search all past conversations using full-text search (FTS5). Returns matching sessions and messages ranked by relevance. Use this to recall prior decisions, past discussions, and historical context across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Full-text search query. Supports phrases ("exact match"), prefix matching (term*), and multiple terms (all must match).',
        },
        projectId: {
          type: 'string',
          description:
            'Project scope (default: "default"). Use to limit search to a specific project.',
          default: 'default',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10, max: 50)',
          default: 10,
        },
        minImportance: {
          type: 'number',
          description:
            'Minimum importance threshold (0-1). Filters out low-value turns like greetings (default: 0.2)',
          default: 0.2,
        },
        sinceDays: {
          type: 'number',
          description:
            'Only search conversations from the last N days (default: 30). Set to 0 for all time.',
          default: 30,
        },
      },
      required: ['query'],
    },
    examples: [
      { name: 'search_conversations', arguments: { query: 'database schema design decision' } },
      {
        name: 'search_conversations',
        arguments: { query: 'API authentication', projectId: 'commander', limit: 5 },
      },
      {
        name: 'search_conversations',
        arguments: { query: 'bug fix deployment', sinceDays: 7, minImportance: 0.3 },
      },
    ],
    category: 'memory',
    costTier: 'low', // FTS5 search — ~1K output tokens, bounded by limit
  };

  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 15000;
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: query is required';

    try {
      const result = await searchConversationsCLI(query, {
        projectId: String(args.projectId ?? 'default'),
        limit: Math.min(Math.max(Number(args.limit ?? 10), 1), 50),
        minImportance: Number(args.minImportance ?? 0.2),
        sinceDays: Number(args.sinceDays ?? 30),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getGlobalLogger().warn('SearchConversationsTool', 'Search failed', { error: msg });
      return `Search failed: ${msg.slice(0, 200)}`;
    }
  }
}

/**
 * CLI-oriented search — searches conversations from the command line.
 * Returns raw JSON for programmatic consumption or formatted text for humans.
 */
export async function searchConversationsCLI(
  query: string,
  options?: {
    projectId?: string;
    limit?: number;
    minImportance?: number;
    sinceDays?: number;
    format?: 'text' | 'json';
  },
): Promise<string> {
  const store = getConversationStore();
  await store.init();

  const opts: ConversationSearchOptions = {
    query,
    projectId: options?.projectId ?? 'default',
    limit: options?.limit ?? 10,
    minImportance: options?.minImportance ?? 0.2,
    since:
      options?.sinceDays && options.sinceDays > 0
        ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    includeSummaries: true,
  };

  const results = await store.search(opts);

  if (options?.format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  // Text format
  if (results.length === 0) {
    const daysSuffix =
      options?.sinceDays && options.sinceDays > 0 ? ` in the last ${options.sinceDays} days` : '';
    return `No conversations found matching "${query}"${daysSuffix}.`;
  }

  const parts: string[] = [`Found ${results.length} conversation(s):`, ''];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const session = r.session;
    const date = new Date(session.startedAt).toLocaleString();
    parts.push(`--- Result ${i + 1} ---`);
    parts.push(`Session: ${session.goal || '(no goal)'}`);
    parts.push(`Date: ${date}`);
    if (session.summary) parts.push(`Summary: ${session.summary}`);
    parts.push(`Relevance: ${(r.relevanceScore * 100).toFixed(0)}%`);
    parts.push('');
    for (const turn of r.matchingTurns) {
      parts.push(`[${turn.role}] ${turn.content.slice(0, 300)}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
