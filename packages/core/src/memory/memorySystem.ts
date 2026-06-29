/**
 * MemorySystem — unified facade over Commander's layered memory backends.
 *
 * This module exposes a single, coherent API for the three memory layers
 * required by a production agent:
 *   - Working memory: ephemeral, session-scoped context.
 *   - Episodic memory: persistent experiences with TTL and full-text search.
 *   - Long-term memory: promoted insights, reflections, and lessons.
 *   - Conversation memory: cross-session conversation history.
 *   - User model: persistent user preferences and communication style.
 *
 * Under the hood it composes the existing `UnifiedMemory`, `MemoryStore`,
 * `ConversationStore`, and `UserModelManager` implementations. Over time the
 * scattered `selfEvolution/` memory pieces should migrate behind this facade.
 */
import type { UnifiedMemory } from './unifiedMemory';
import type { EpisodicMemoryItem, MemorySearchQuery } from '../memory';
import type { ConversationStore } from './conversationStore';
import type { UserModelManager, UserProfile } from './userModel';

export interface MemorySystemConfig {
  unified: UnifiedMemory;
  conversation?: ConversationStore;
  userModel?: UserModelManager;
}

export interface WorkingMemoryEntry {
  id: string;
  content: string;
  importance: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface RememberOptions {
  projectId: string;
  missionId?: string;
  agentId?: string;
  content: string;
  kind?: EpisodicMemoryItem['kind'];
  importance?: number;
  tags?: string[];
  evidenceRefs?: string[];
}

export interface RecallOptions {
  projectId: string;
  missionId?: string;
  query: string;
  limit?: number;
}

export interface BuiltContext {
  workingContext: string;
  episodicContext: string;
  longTermContext: string;
  conversationContext: string;
  userContext: string;
}

export class MemorySystem {
  constructor(private readonly config: MemorySystemConfig) {}

  /**
   * Assert that a write target is within the calling agent's namespace.
   * O(1) — pure in-memory string comparison. No async I/O.
   *
   * Enforcement order:
   *   1. Path starts with writer's own namespace → allow
   *   2. ACL explicitly grants a namespace that contains the path → allow
   *   3. ACL grants 'tasks' and path is under tasks/ → allow (shared task scope)
   *   4. Otherwise → throw SecurityInvariantViolation (fail-closed)
   *
   * Orchestrator spawn contract: when spawning task-bound sub-agents, the
   * orchestrator MUST inject 'tasks' (or a specific tasks/<TID> prefix)
   * into the sub-agent's ACL namespaces, or the first task-log write will
   * trip this guard.
   */
  assertNamespaced(
    writerAgentId: string,
    targetPath: string,
    acl?: { role: string; namespaces: string[] },
  ): void {
    const writerNs = `agents/${writerAgentId}`;
    if (targetPath.startsWith(writerNs)) return;

    if (acl && acl.namespaces.some(ns => targetPath.startsWith(ns))) return;

    if (acl && acl.namespaces.includes('tasks') && targetPath.startsWith('tasks/')) return;

    throw new Error(
      `MEMORY-001: agent "${writerAgentId}" attempted to write outside its namespace: ${targetPath}`,
    );
  }

  // ============================================================================
  // Working memory (short-term, session-scoped)
  // ============================================================================

  addWorkingMemory(entry: WorkingMemoryEntry): void {
    this.config.unified
      .getWorkingMemory()
      .add(entry.content, 'working', '', entry.importance, entry.tags ?? [], entry.metadata ?? {});
  }

  getWorkingMemory(limit?: number): WorkingMemoryEntry[] {
    return this.config.unified
      .getWorkingMemory()
      .getWorkingContext(limit)
      .map((e) => ({
        id: e.id,
        content: e.content,
        importance: e.importance,
        tags: e.tags,
        metadata: e.metadata,
      }));
  }

  // ============================================================================
  // Episodic memory (persistent experiences)
  // ============================================================================

  async remember(options: RememberOptions): Promise<void> {
    await this.config.unified.remember({
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      content: options.content,
      kind: options.kind ?? 'SUMMARY',
      importance: options.importance ?? 0.5,
      tags: options.tags,
      evidenceRefs: options.evidenceRefs,
    });
  }

  async recall(options: RecallOptions): Promise<EpisodicMemoryItem[]> {
    const result = await this.config.unified.recall({
      projectId: options.projectId,
      query: options.query,
      limit: options.limit ?? 10,
    } as Parameters<UnifiedMemory['recall']>[0]);
    return (result as { episodic?: EpisodicMemoryItem[] }).episodic ?? [];
  }

  async searchEpisodic(query: MemorySearchQuery): Promise<EpisodicMemoryItem[]> {
    const store = this.config.unified.getPersistentStore();
    const result = await store.search(query);
    return (result as unknown as { items?: EpisodicMemoryItem[] }).items ?? [];
  }

  // ============================================================================
  // Long-term memory (promoted insights and reflections)
  // ============================================================================

  async consolidate(projectId: string): Promise<void> {
    await this.config.unified.consolidate(projectId);
  }

  // ============================================================================
  // Conversation memory
  // ============================================================================

  async addConversationTurn(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
  ): Promise<void> {
    if (!this.config.conversation) return;
    await this.config.conversation.addTurn({
      sessionId,
      role,
      content,
      tokenCount: Math.ceil(content.length / 4),
    });
  }

  async getConversationContext(sessionId: string, limit?: number): Promise<string> {
    if (!this.config.conversation) return '';
    return this.config.conversation.getRecentContext(sessionId, limit);
  }

  // ============================================================================
  // User model
  // ============================================================================

  async getUserProfile(userId: string): Promise<UserProfile | undefined> {
    if (!this.config.userModel) return undefined;
    return this.config.userModel.getProfile(userId);
  }

  async updateUserProfile(userId: string, updater: (profile: UserProfile) => void): Promise<void> {
    if (!this.config.userModel) return;
    const profile = await this.config.userModel.getProfile(userId);
    if (!profile) return;
    updater(profile);
    await this.config.userModel.saveProfile(userId);
  }

  // ============================================================================
  // Context assembly
  // ============================================================================

  async buildContext(
    projectId: string,
    sessionId: string | undefined,
    userId: string | undefined,
  ): Promise<BuiltContext> {
    const unifiedContext = await this.config.unified.buildContext({
      projectId,
      userId,
      maxTokens: 4000,
    });

    const [conversationContext, userContext] = await Promise.all([
      sessionId ? this.getConversationContext(sessionId) : Promise.resolve(''),
      userId ? this.getUserContext(userId) : Promise.resolve(''),
    ]);

    return {
      workingContext: (unifiedContext as { workingContext?: string }).workingContext ?? '',
      episodicContext: '',
      longTermContext: (unifiedContext as { systemContext?: string }).systemContext ?? '',
      conversationContext,
      userContext,
    };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async close(): Promise<void> {
    await this.config.unified.close();
    await this.config.conversation?.close();
    await this.config.userModel?.close();
  }

  private async getUserContext(userId: string): Promise<string> {
    const profile = await this.getUserProfile(userId);
    if (!profile) return '';
    const prefs = profile.preferences;
    return [
      `User: ${userId}`,
      `Style: ${prefs.codingStyle}`,
      `Explanation: ${prefs.explanationLevel}`,
      `Language: ${prefs.language}`,
      `Expertise: ${Array.from(profile.expertise.entries())
        .map(([k, v]) => `${k}=${v.level}`)
        .join(', ')}`,
    ].join('\n');
  }
}
