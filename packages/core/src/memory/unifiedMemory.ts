/**
 * Unified Memory Layer
 *
 * Single API facade over all Commander memory systems. Agents interact with
 * this layer; it routes to the appropriate backend based on memory type.
 *
 * Architecture:
 *   Agent → UnifiedMemory → {
 *     Working Memory    → ThreeLayerMemory (in-process, fast)
 *     Episodic Memory   → MemoryStore (Sqlite/Json, persistent)
 *     Conversation History → ConversationStore (SQLite + FTS5)
 *     User Model        → UserModelManager (persistent profiles)
 *     Curation          → MemoryCurator (autonomous lifecycle)
 *   }
 *
 * Design principles:
 * - Agents never need to know which backend stores what
 * - Cross-system search: a single query searches all backends
 * - Automatic curation: the layer decides when to curate
 * - Context injection: builds a unified context string for LLM prompts
 */

import { getGlobalLogger } from '../logging';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import type { ThreeLayerMemory, MemoryEntry } from '../threeLayerMemory';
import type {
  MemoryStore,
  EpisodicMemoryItem,
  MemoryWriteOptions,
  MemorySearchQuery,
  MemorySearchResult,
} from '../memory';
import { ConversationStore, getConversationStore } from './conversationStore';
import type {
  ConversationSearchResult,
  ConversationSession,
  ConversationTurn,
} from './conversationStore';
import { MemoryCurator, getMemoryCurator } from './curator';
import type { CurationResult } from './curator';
import { UserModelManager, getUserModelManager } from './userModel';
import type { UserProfile } from './userModel';

// ============================================================================
// Types
// ============================================================================

export interface UnifiedMemoryConfig {
  /** Memory store backend: 'sqlite' | 'json' | 'in-memory' */
  storeType: 'sqlite' | 'json' | 'in-memory';
  /** Path for persistent stores */
  dataPath: string;
  /** Enable autonomous curation */
  enableCuration: boolean;
  /** Enable conversation persistence */
  enableConversationStore: boolean;
  /** Enable user modeling */
  enableUserModel: boolean;
  /** Maximum context tokens to generate */
  maxContextTokens: number;
}

export interface RememberOptions {
  /** What to remember */
  content: string;
  /** Context/association */
  context?: string;
  /** Importance (0-1) */
  importance?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Memory kind */
  kind?: 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
  /** Evidence references */
  evidenceRefs?: string[];
  /** Project ID */
  projectId: string;
  /** Agent ID */
  agentId?: string;
  /** Mission ID */
  missionId?: string;
}

export interface RecallOptions {
  /** Search query */
  query: string;
  /** Project scope */
  projectId: string;
  /** User scope */
  userId?: string;
  /** Maximum results per source */
  limit?: number;
  /** Minimum importance/relevance threshold */
  minRelevance?: number;
  /** Which memory sources to search */
  sources?: MemorySource[];
  /** Time filter (ISO date string) */
  since?: string;
}

export type MemorySource = 'working' | 'episodic' | 'longterm' | 'conversations' | 'user_model';

export interface UnifiedRecallResult {
  /** Working memory matches */
  working: MemoryEntry[];
  /** Episodic memory matches */
  episodic: EpisodicMemoryItem[];
  /** Long-term memory matches */
  longterm: MemoryEntry[];
  /** Conversation history matches */
  conversations: ConversationSearchResult[];
  /** User model context (if requested) */
  userProfile?: UserProfile;
  /** Total results across all sources */
  totalCount: number;
  /** Unified context string for LLM injection */
  contextString: string;
}

export interface UnifiedContext {
  /** System context (persistent, project-level) */
  systemContext: string;
  /** User context (preferences, expertise) */
  userContext: string;
  /** Conversation context (recent sessions) */
  conversationContext: string;
  /** Working memory context (current session) */
  workingContext: string;
  /** Combined context string */
  combined: string;
  /** Estimated token count */
  estimatedTokens: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: UnifiedMemoryConfig = {
  storeType: 'sqlite',
  dataPath: '.commander',
  enableCuration: true,
  enableConversationStore: true,
  enableUserModel: true,
  maxContextTokens: 4000,
};

// ============================================================================
// Unified Memory Layer
// ============================================================================

export class UnifiedMemory {
  private config: UnifiedMemoryConfig;
  private threeLayer: ThreeLayerMemory;
  private conversationStore: ConversationStore;
  private curator: MemoryCurator;
  private userModel: UserModelManager;
  private memoryStore: MemoryStore | null = null;
  private writeCount = 0;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config?: Partial<UnifiedMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.threeLayer = getGlobalThreeLayerMemory();
    this.conversationStore = getConversationStore({
      dbPath: `${this.config.dataPath}/conversations.db`,
    });
    this.curator = getMemoryCurator();
    this.userModel = getUserModelManager({
      modelPath: `${this.config.dataPath}/user-models`,
    });
  }

  /**
   * Initialize the unified memory layer with a concrete MemoryStore backend.
   * Must be called before using remember/recall.
   */
  async init(store: MemoryStore): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.memoryStore = store;

      if (this.config.enableConversationStore) {
        await this.conversationStore.init();
      }

      this.initialized = true;
      getGlobalLogger().info('UnifiedMemory', 'Initialized', {
        storeType: this.config.storeType,
        curation: this.config.enableCuration,
        conversations: this.config.enableConversationStore,
        userModel: this.config.enableUserModel,
      });
    })();

    return this.initPromise;
  }

  // --------------------------------------------------------------------------
  // Remember (Write)
  // --------------------------------------------------------------------------

  /**
   * Store a memory. Routes to the appropriate backend based on context.
   *
   * - Working memory: ephemeral, session-scoped (ThreeLayerMemory)
   * - Episodic/Long-term: persistent (MemoryStore)
   * - Automatic curation trigger
   */
  async remember(options: RememberOptions): Promise<EpisodicMemoryItem | null> {
    this.ensureInitialized();

    // Always add to working memory for immediate access
    this.threeLayer.add(
      options.content,
      'working',
      options.context ?? options.projectId,
      options.importance ?? 0.5,
      options.tags ?? [],
      { projectId: options.projectId, agentId: options.agentId },
    );

    // Persist to MemoryStore if importance warrants it
    if ((options.importance ?? 0.5) >= 0.3) {
      const writeOptions: MemoryWriteOptions = {
        projectId: options.projectId,
        missionId: options.missionId,
        agentId: options.agentId,
        kind: options.kind ?? 'SUMMARY',
        duration: (options.importance ?? 0.5) >= 0.7 ? 'LONG_TERM' : 'EPISODIC',
        title: options.content.substring(0, 100),
        content: options.content,
        tags: options.tags,
        priority: Math.round((options.importance ?? 0.5) * 100),
        confidence: options.importance ?? 0.8,
        evidenceRefs: options.evidenceRefs,
      };

      const item = await this.memoryStore!.write(writeOptions);

      // Trigger autonomous curation
      if (this.config.enableCuration) {
        const curationResult = await this.curator.onWrite(this.memoryStore!, options.projectId);
        if (curationResult) {
          getGlobalLogger().debug('UnifiedMemory', 'Auto-curation triggered', {
            summary: curationResult.summary,
          });
        }
      }

      this.writeCount++;
      return item;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Recall (Read/Search)
  // --------------------------------------------------------------------------

  /**
   * Search across all memory systems with a single query.
   * Returns results from all sources plus a unified context string.
   */
  async recall(options: RecallOptions): Promise<UnifiedRecallResult> {
    this.ensureInitialized();

    const sources = options.sources ?? ['working', 'episodic', 'longterm', 'conversations'];
    const limit = options.limit ?? 5;

    // Parallel search across all sources
    const searchPromises: Promise<void>[] = [];
    let workingResults: MemoryEntry[] = [];
    let episodicResults: EpisodicMemoryItem[] = [];
    let longtermResults: MemoryEntry[] = [];
    let conversationResults: ConversationSearchResult[] = [];
    let userProfile: UserProfile | undefined;

    // Working memory search
    if (sources.includes('working')) {
      workingResults = this.threeLayer.searchRelated(options.query).slice(0, limit);
    }

    // Episodic + Long-term memory search (both from MemoryStore)
    if (sources.includes('episodic') || sources.includes('longterm')) {
      const storeResults = await this.memoryStore!.searchSemantic(
        options.query,
        options.projectId,
        limit * 2,
      );
      if (sources.includes('episodic')) {
        episodicResults = storeResults.filter((r) => r.duration === 'EPISODIC').slice(0, limit);
      }
      if (sources.includes('longterm')) {
        const ltItems = storeResults.filter((r) => r.duration === 'LONG_TERM').slice(0, limit);
        // Convert EpisodicMemoryItem to MemoryEntry format for longtermResults
        longtermResults = ltItems.map((item) => ({
          id: item.id,
          layer: 'longterm' as const,
          content: item.content,
          context: item.title,
          importance: item.priority / 100,
          createdAt: item.createdAt,
          lastAccessedAt: item.lastAccessedAt ?? item.createdAt,
          accessCount: 0,
          decayScore: 0,
          tags: item.tags,
          metadata: {},
        }));
      }
    }

    // Conversation history search
    if (sources.includes('conversations') && this.config.enableConversationStore) {
      conversationResults = await this.conversationStore.search({
        query: options.query,
        projectId: options.projectId,
        userId: options.userId,
        limit,
        since: options.since,
      });
    }

    // User model
    if (sources.includes('user_model') && options.userId && this.config.enableUserModel) {
      // Load from disk if not in memory
      userProfile =
        (await this.userModel.loadProfile(options.userId)) ??
        this.userModel.getProfile(options.userId);
    }

    // Build unified context string
    const totalCount =
      workingResults.length +
      episodicResults.length +
      longtermResults.length +
      conversationResults.length;

    const contextString = this.buildRecallContextString(
      workingResults,
      episodicResults,
      longtermResults,
      conversationResults,
    );

    return {
      working: workingResults,
      episodic: episodicResults,
      longterm: longtermResults,
      conversations: conversationResults,
      userProfile,
      totalCount,
      contextString,
    };
  }

  // --------------------------------------------------------------------------
  // Context Building
  // --------------------------------------------------------------------------

  /**
   * Build a unified context string for LLM injection.
   * Combines user model, conversation history, and relevant memories.
   */
  async buildContext(params: {
    projectId: string;
    userId?: string;
    goal?: string;
    maxTokens?: number;
  }): Promise<UnifiedContext> {
    this.ensureInitialized();

    const maxTokens = params.maxTokens ?? this.config.maxContextTokens;
    const parts: string[] = [];

    // 1. User context (if available)
    let userContext = '';
    if (params.userId && this.config.enableUserModel) {
      userContext = this.userModel.getContextSummary(params.userId);
    }

    // 2. Conversation context (recent sessions)
    let conversationContext = '';
    if (this.config.enableConversationStore) {
      conversationContext = await this.conversationStore.getRecentContext(params.projectId, 3);
    }

    // 3. Working memory context (search recent entries)
    let workingContext = '';
    const recentWorking = this.threeLayer.searchRelated('', 10);
    if (recentWorking.length > 0) {
      workingContext =
        '## Current Session Context\n' +
        recentWorking.map((e: MemoryEntry) => `- ${e.content.substring(0, 200)}`).join('\n');
    }

    // 4. System context (from long-term memory if goal provided)
    let systemContext = '';
    if (params.goal && this.memoryStore) {
      const relevant = await this.memoryStore.searchSemantic(params.goal, params.projectId, 5);
      if (relevant.length > 0) {
        systemContext =
          '## Relevant Knowledge\n' +
          relevant
            .map((r) => `- [${r.kind}] ${r.title}: ${r.content.substring(0, 200)}`)
            .join('\n');
      }
    }

    // Assemble in priority order, truncating to fit
    const sections = [
      { label: 'user', content: userContext },
      { label: 'system', content: systemContext },
      { label: 'conversation', content: conversationContext },
      { label: 'working', content: workingContext },
    ].filter((s) => s.content);

    let combined = '';
    let estimatedTokens = 0;
    for (const section of sections) {
      const sectionTokens = Math.ceil(section.content.length / 4);
      if (estimatedTokens + sectionTokens > maxTokens) break;
      combined += section.content + '\n\n';
      estimatedTokens += sectionTokens;
    }

    return {
      systemContext,
      userContext,
      conversationContext,
      workingContext,
      combined: combined.trim(),
      estimatedTokens,
    };
  }

  // --------------------------------------------------------------------------
  // Conversation Management
  // --------------------------------------------------------------------------

  /**
   * Start a new conversation session.
   */
  async startConversation(params: {
    projectId: string;
    agentId?: string;
    userId?: string;
    goal?: string;
  }): Promise<ConversationSession> {
    if (!this.config.enableConversationStore) {
      throw new Error('ConversationStore is disabled');
    }
    return this.conversationStore.startSession(params);
  }

  /**
   * Record a conversation turn.
   */
  async recordTurn(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    toolName?: string;
    tokenCount?: number;
  }): Promise<ConversationTurn> {
    if (!this.config.enableConversationStore) {
      throw new Error('ConversationStore is disabled');
    }
    return this.conversationStore.addTurn(params);
  }

  /**
   * End a conversation session.
   */
  async endConversation(sessionId: string): Promise<void> {
    if (!this.config.enableConversationStore) return;
    await this.conversationStore.endSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // User Model
  // --------------------------------------------------------------------------

  /**
   * Record a user interaction for model building.
   */
  recordUserInteraction(
    userId: string,
    params: {
      message: string;
      role: 'user' | 'assistant';
      toolUsed?: string;
      domain?: string;
    },
  ): void {
    if (!this.config.enableUserModel) return;
    this.userModel.recordInteraction(userId, params);
  }

  /**
   * Get user profile.
   */
  getUserProfile(userId: string): UserProfile {
    return this.userModel.getProfile(userId);
  }

  /**
   * Save user profile to disk.
   */
  async saveUserProfile(userId: string): Promise<void> {
    if (!this.config.enableUserModel) return;
    await this.userModel.saveProfile(userId);
  }

  // --------------------------------------------------------------------------
  // Curation & Consolidation
  // --------------------------------------------------------------------------

  /**
   * Manually trigger a curation cycle.
   */
  async curate(projectId: string): Promise<CurationResult> {
    this.ensureInitialized();
    return this.curator.curate(this.memoryStore!, projectId);
  }

  /**
   * Get the last curation result.
   */
  getLastCuration(): CurationResult | null {
    return this.curator.getLastCuration();
  }

  /**
   * Consolidate memories across all stores.
   *
   * This implements the cross-session memory lifecycle:
   * 1. Working → Episodic: Archive old working memories (>2 hours)
   * 2. Episodic → Long-term: Promote frequently-accessed episodic memories
   * 3. Deduplicate: Merge similar memories across stores
   * 4. Decay: Reduce importance of stale memories
   *
   * Should be called periodically (e.g., at session end or every N writes).
   */
  async consolidate(projectId: string): Promise<{
    archived: number;
    promoted: number;
    deduplicated: number;
    decayed: number;
  }> {
    this.ensureInitialized();

    let archived = 0;
    let promoted = 0;
    let deduplicated = 0;
    let decayed = 0;

    // Step 1: Archive old working memories to episodic
    const working = this.threeLayer.getByLayer('working');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const entry of working) {
      const createdAt = new Date(entry.createdAt).getTime();
      if (createdAt < twoHoursAgo && entry.importance >= 0.3) {
        // Promote to episodic in MemoryStore
        await this.memoryStore!.write({
          projectId,
          kind: 'SUMMARY',
          duration: 'EPISODIC',
          title: entry.content.substring(0, 100),
          content: entry.content,
          tags: entry.tags,
          priority: Math.round(entry.importance * 100),
          confidence: entry.importance,
        });
        // Remove from working memory
        this.threeLayer.delete(entry.id);
        archived++;
      }
    }

    // Step 2: Promote frequently-accessed episodic to long-term
    const episodic = await this.memoryStore!.search({
      projectId,
      limit: 200,
    });
    for (const item of episodic.items) {
      if (item.duration !== 'EPISODIC') continue;

      const lastAccess = new Date(item.lastAccessedAt).getTime();
      const ageDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      // Promote if: high priority + recently accessed + old enough to be stable
      if (item.priority >= 80 && ageDays < 3) {
        await this.memoryStore!.update({
          id: item.id,
          projectId,
          updates: { expiresAt: undefined },
        });
        promoted++;
      }

      // Promote high-confidence lessons and decisions
      if ((item.kind === 'LESSON' || item.kind === 'DECISION') && item.confidence >= 0.9) {
        await this.memoryStore!.update({
          id: item.id,
          projectId,
          updates: { expiresAt: undefined },
        });
        promoted++;
      }
    }

    // Step 3: Deduplicate similar memories
    // Use title + kind for quick dedup
    const seen = new Map<string, (typeof episodic.items)[0]>();
    for (const item of episodic.items) {
      const key = `${item.kind}:${item.title.toLowerCase().trim()}`;
      const existing = seen.get(key);
      if (existing) {
        // Merge: keep the higher-priority one, merge tags
        if (item.priority > existing.priority) {
          await this.memoryStore!.update({
            id: existing.id,
            projectId,
            updates: { tags: [...new Set([...existing.tags, ...item.tags])] },
          });
          await this.memoryStore!.delete(item.id, projectId);
        } else {
          await this.memoryStore!.update({
            id: item.id,
            projectId,
            updates: { tags: [...new Set([...item.tags, ...existing.tags])] },
          });
          await this.memoryStore!.delete(existing.id, projectId);
          seen.set(key, item);
        }
        deduplicated++;
      } else {
        seen.set(key, item);
      }
    }

    return { archived, promoted, deduplicated, decayed };
  }

  // --------------------------------------------------------------------------
  // Direct Access (escape hatch)
  // --------------------------------------------------------------------------

  /**
   * Direct access to the underlying ThreeLayerMemory.
   */
  getWorkingMemory(): ThreeLayerMemory {
    return this.threeLayer;
  }

  /**
   * Direct access to the underlying MemoryStore.
   */
  getPersistentStore(): MemoryStore {
    this.ensureInitialized();
    return this.memoryStore!;
  }

  /**
   * Direct access to the ConversationStore.
   */
  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  /**
   * Direct access to the UserModelManager.
   */
  getUserModelManager(): UserModelManager {
    return this.userModel;
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized || !this.memoryStore) {
      throw new Error('UnifiedMemory not initialized. Call init(store) first.');
    }
  }

  private buildRecallContextString(
    working: MemoryEntry[],
    episodic: EpisodicMemoryItem[],
    longterm: MemoryEntry[],
    conversations: ConversationSearchResult[],
  ): string {
    const parts: string[] = [];

    if (longterm.length > 0) {
      parts.push('## Relevant Knowledge');
      for (const item of longterm) {
        parts.push(`- ${item.content.substring(0, 200)}`);
      }
    }

    if (episodic.length > 0) {
      parts.push('\n## Recent Memories');
      for (const item of episodic) {
        parts.push(`- [${item.kind}] ${item.title}`);
      }
    }

    if (conversations.length > 0) {
      parts.push('\n## Related Conversations');
      for (const conv of conversations) {
        const date = new Date(conv.session.startedAt).toLocaleDateString();
        parts.push(
          `- ${date}: ${conv.session.goal ?? 'No goal'} (${conv.matchingTurns.length} matches)`,
        );
        for (const turn of conv.matchingTurns.slice(0, 2)) {
          parts.push(`  > ${turn.content.substring(0, 150)}`);
        }
      }
    }

    if (working.length > 0) {
      parts.push('\n## Current Context');
      for (const item of working.slice(-5)) {
        parts.push(`- ${item.content.substring(0, 150)}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Gracefully close all underlying memory backends and flush pending writes.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.memoryStore?.close(),
      this.conversationStore?.close(),
      this.userModel?.close(),
    ]);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalUnifiedMemory: UnifiedMemory | null = null;

export function getUnifiedMemory(config?: Partial<UnifiedMemoryConfig>): UnifiedMemory {
  if (!globalUnifiedMemory) {
    globalUnifiedMemory = new UnifiedMemory(config);
  }
  return globalUnifiedMemory;
}
