"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchConversationsTool = void 0;
exports.searchConversationsCLI = searchConversationsCLI;
const conversationStore_1 = require("../memory/conversationStore");
const logging_1 = require("../logging");
class SearchConversationsTool {
    constructor() {
        this.definition = {
            name: 'search_conversations',
            description: 'Search all past conversations using full-text search (FTS5). Returns matching sessions and messages ranked by relevance. Use this to recall prior decisions, past discussions, and historical context across sessions.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Full-text search query. Supports phrases ("exact match"), prefix matching (term*), and multiple terms (all must match).',
                    },
                    projectId: {
                        type: 'string',
                        description: 'Project scope (default: "default"). Use to limit search to a specific project.',
                        default: 'default',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum results to return (default: 10, max: 50)',
                        default: 10,
                    },
                    minImportance: {
                        type: 'number',
                        description: 'Minimum importance threshold (0-1). Filters out low-value turns like greetings (default: 0.2)',
                        default: 0.2,
                    },
                    sinceDays: {
                        type: 'number',
                        description: 'Only search conversations from the last N days (default: 30). Set to 0 for all time.',
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
        };
        this.isConcurrencySafe = true;
        this.isReadOnly = true;
        this.timeout = 15000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e;
        const query = String((_a = args.query) !== null && _a !== void 0 ? _a : '').trim();
        if (!query)
            return 'Error: query is required';
        try {
            const result = await searchConversationsCLI(query, {
                projectId: String((_b = args.projectId) !== null && _b !== void 0 ? _b : 'default'),
                limit: Math.min(Math.max(Number((_c = args.limit) !== null && _c !== void 0 ? _c : 10), 1), 50),
                minImportance: Number((_d = args.minImportance) !== null && _d !== void 0 ? _d : 0.2),
                sinceDays: Number((_e = args.sinceDays) !== null && _e !== void 0 ? _e : 30),
            });
            return result;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logging_1.getGlobalLogger)().warn('SearchConversationsTool', 'Search failed', { error: msg });
            return `Search failed: ${msg.slice(0, 200)}`;
        }
    }
}
exports.SearchConversationsTool = SearchConversationsTool;
/**
 * CLI-oriented search — searches conversations from the command line.
 * Returns raw JSON for programmatic consumption or formatted text for humans.
 */
async function searchConversationsCLI(query, options) {
    var _a, _b, _c;
    const store = (0, conversationStore_1.getConversationStore)();
    await store.init();
    const opts = {
        query,
        projectId: (_a = options === null || options === void 0 ? void 0 : options.projectId) !== null && _a !== void 0 ? _a : 'default',
        limit: (_b = options === null || options === void 0 ? void 0 : options.limit) !== null && _b !== void 0 ? _b : 10,
        minImportance: (_c = options === null || options === void 0 ? void 0 : options.minImportance) !== null && _c !== void 0 ? _c : 0.2,
        since: (options === null || options === void 0 ? void 0 : options.sinceDays) && options.sinceDays > 0
            ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000).toISOString()
            : undefined,
        includeSummaries: true,
    };
    const results = await store.search(opts);
    if ((options === null || options === void 0 ? void 0 : options.format) === 'json') {
        return JSON.stringify(results, null, 2);
    }
    // Text format
    if (results.length === 0) {
        const daysSuffix = (options === null || options === void 0 ? void 0 : options.sinceDays) && options.sinceDays > 0 ? ` in the last ${options.sinceDays} days` : '';
        return `No conversations found matching "${query}"${daysSuffix}.`;
    }
    const parts = [`Found ${results.length} conversation(s):`, ''];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const session = r.session;
        const date = new Date(session.startedAt).toLocaleString();
        parts.push(`--- Result ${i + 1} ---`);
        parts.push(`Session: ${session.goal || '(no goal)'}`);
        parts.push(`Date: ${date}`);
        if (session.summary)
            parts.push(`Summary: ${session.summary}`);
        parts.push(`Relevance: ${(r.relevanceScore * 100).toFixed(0)}%`);
        parts.push('');
        for (const turn of r.matchingTurns) {
            parts.push(`[${turn.role}] ${turn.content.slice(0, 300)}`);
        }
        parts.push('');
    }
    return parts.join('\n');
}
