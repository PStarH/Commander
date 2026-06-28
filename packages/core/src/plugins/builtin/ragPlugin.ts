/**
 * ragPlugin — Built-in CommanderPlugin for enterprise RAG knowledge retrieval.
 *
 * Registers as `builtin-rag` (category: 'integration'). On load it initializes
 * a KnowledgeBaseStore (creating the storage directory and loading any
 * persisted index). It declares a `knowledge_search` tool that the LLM can
 * invoke, and — when `autoInject` is enabled — installs a `beforeLLMCall`
 * hook that automatically retrieves relevant context and injects it as a
 * system message ahead of the user's message.
 *
 * Embeddings: OpenAI (when OPENAI_API_KEY is set) → LocalEmbeddingFunction
 * fallback (zero-dependency, offline). Vector search uses the existing HNSW
 * index from `packages/core/src/memory/hnswIndex.ts`.
 */
import type { CommanderPlugin, BeforeLLMCallContext } from '../../pluginManager';
import type { LLMRequest, LLMMessage } from '../../runtime/types';
import {
  KnowledgeBaseStore,
  getSharedKnowledgeBaseStore,
  setSharedKnowledgeBaseStore,
} from './knowledgeBaseStore';
import { getGlobalLogger } from '../../logging';

// ============================================================================
// RAG Plugin factory
// ============================================================================

/**
 * Create the built-in RAG CommanderPlugin.
 *
 * The store is exposed process-wide via `getSharedKnowledgeBaseStore()` so the
 * API endpoints can reach the same instance the plugin uses (without having to
 * thread the plugin object through Express).
 */
export function createRagPlugin(): CommanderPlugin {
  // The store is created during onLoad once config is available; this closure
  // variable tracks the live instance for the hook + tool handlers.
  let store: KnowledgeBaseStore | null = null;
  let autoInject = false;
  let maxResults = 5;

  return {
    name: 'builtin-rag',
    version: '0.1.0',
    description: 'Enterprise knowledge base with RAG retrieval',
    category: 'integration',
    configSchema: {
      type: 'object',
      properties: {
        kbPath: {
          type: 'string',
          description: 'Knowledge base storage directory',
          default: '.commander/knowledge-base',
        },
        embeddingModel: {
          type: 'string',
          description: 'OpenAI embedding model (used only when OPENAI_API_KEY is set)',
          default: 'text-embedding-3-small',
        },
        chunkSize: {
          type: 'number',
          description: 'Maximum characters per chunk',
          default: 512,
        },
        chunkOverlap: {
          type: 'number',
          description: 'Character overlap between consecutive chunks',
          default: 50,
        },
        maxResults: {
          type: 'number',
          description: 'Default number of retrieval results',
          default: 5,
        },
        autoInject: {
          type: 'boolean',
          description:
            'When true, automatically inject retrieved context into LLM calls via beforeLLMCall',
          default: false,
        },
      },
    },

    // ── Lifecycle ──────────────────────────────────────────────────────────

    onLoad: async (ctx) => {
      const cfg = ctx.config;
      autoInject = Boolean(cfg.autoInject);
      maxResults = Number(cfg.maxResults) || 5;

      store = new KnowledgeBaseStore({
        kbPath: cfg.kbPath as string,
        embeddingModel: cfg.embeddingModel as string,
        chunkSize: cfg.chunkSize as number,
        chunkOverlap: cfg.chunkOverlap as number,
        maxResults,
      });
      // Publish the instance so the API endpoints share it.
      setSharedKnowledgeBaseStore(store);
      await store.init();
      getGlobalLogger().info(
        'RagPlugin',
        `Knowledge base loaded (autoInject=${autoInject}, docs=${store.documentCount}, vectors=${store.vectorCount})`,
      );
    },

    onUnload: async () => {
      if (store) {
        try {
          await store.save();
          getGlobalLogger().info('RagPlugin', 'Knowledge base persisted on unload');
        } catch (err) {
          getGlobalLogger().warn(
            'RagPlugin',
            `Failed to persist knowledge base on unload: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      setSharedKnowledgeBaseStore(null);
      store = null;
    },

    // ── Declarative tools (host wires these into the ToolRegistry) ──────────

    tools: [
      {
        name: 'knowledge_search',
        description:
          'Search the enterprise knowledge base for context relevant to a query. ' +
          'Returns the top-K matching document chunks (content + source + score). ' +
          'Use this to ground answers in internal documentation before responding.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The natural-language search query',
            },
            topK: {
              type: 'number',
              description: 'Maximum number of results to return (default: 5, max: 50)',
              minimum: 1,
              maximum: 50,
            },
          },
          required: ['query'],
        },
        execute: async (args) => {
          const kb = store ?? getSharedKnowledgeBaseStore();
          const query = String(args.query ?? '').trim();
          if (!query) {
            return JSON.stringify({ error: 'query is required', results: [] });
          }
          const topK = args.topK !== undefined ? Number(args.topK) : undefined;
          const results = await kb.search(query, topK);
          return JSON.stringify({ query, count: results.length, results });
        },
      },
    ],

    // ── beforeLLMCall hook (auto-inject retrieved context) ──────────────────

    beforeLLMCall: async (ctx: BeforeLLMCallContext): Promise<LLMRequest> => {
      if (!autoInject || !store) return ctx.request;

      const request = ctx.request;
      const messages = request.messages ?? [];
      if (messages.length === 0) return request;

      // Find the last user message to use as the retrieval query.
      let lastUser: LLMMessage | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUser = messages[i];
          break;
        }
      }
      if (!lastUser) return request;

      const query = (lastUser.content ?? '').trim();
      if (query.length === 0) return request;

      try {
        const results = await store.search(query, maxResults);
        if (results.length === 0) return request;

        // Assemble a system message with the retrieved context.
        const parts: string[] = [
          'You have access to the following retrieved knowledge-base context. ' +
            'Use it to ground your answer, and cite the source when relevant.',
          '',
        ];
        results.forEach((r, i) => {
          parts.push(
            `--- [${i + 1}] Source: ${r.source} (score ${r.score.toFixed(3)}) ---`,
          );
          parts.push(r.content);
          parts.push('');
        });

        const contextMessage: LLMMessage = {
          role: 'system',
          content: parts.join('\n'),
        };

        // Inject the context message at the front of the conversation so the
        // LLM sees it before the user's question. We avoid mutating the
        // original array (defensive copy).
        return {
          ...request,
          messages: [contextMessage, ...messages],
        };
      } catch (err) {
        getGlobalLogger().warn(
          'RagPlugin',
          `beforeLLMCall retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return request;
      }
    },
  };
}
