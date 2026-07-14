/**
 * Memory Manager Agent — P1 prototype inspired by AgeMem / A-MEM.
 *
 * The agent treats memory operations as actions (store, retrieve, update,
 * summarize, discard) and decides which action to execute using either a
 * configurable rule engine or an optional LLM policy. It keeps a local,
 * in-memory working memory and can optionally project stored memories into a
 * semantic knowledge graph. Temporal relation chains (event A before event B)
 * are tracked via a dedicated TemporalGraph.
 *
 * Design goals:
 * - Local-first: no network or external service required.
 * - Zero new dependencies: only TypeScript built-ins and existing core types.
 * - Deterministic rule mode for testing and embedded use.
 * - Pluggable LLM policy for future learned controllers.
 */

import type { ISemanticStore } from '../contracts/pillarIV';
import { TemporalGraph } from './temporalGraph';

// ============================================================================
// Types
// ============================================================================

export type MemoryAction = 'store' | 'retrieve' | 'update' | 'summarize' | 'discard';

export interface MemoryObservation {
  id?: string;
  content: string;
  context?: string;
  timestamp?: number;
  importance?: number;
  tags?: string[];
  createdAt?: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  context: string;
  tags: string[];
  importance: number;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  summary?: string;
}

export interface MemoryQuery {
  content?: string;
  tags?: string[];
  context?: string;
  limit?: number;
}

export interface MemoryManagerStats {
  total: number;
  summaries: number;
  discarded: number;
}

export interface LLMPolicyInput {
  observation: MemoryObservation;
  workingMemories: MemoryItem[];
  stats: MemoryManagerStats;
}

export type LLMPolicy = (
  input: LLMPolicyInput,
) => Promise<{ action: MemoryAction; params?: Record<string, unknown> }>;

export interface MemoryManagerConfig {
  /** Decision engine: deterministic rules or custom LLM policy. */
  decisionMode?: 'llm' | 'rule';
  /** Required when decisionMode is 'llm'. */
  llmPolicy?: LLMPolicy;
  /** Minimum importance for a memory to avoid discard (0-1). */
  importanceThreshold?: number;
  /** Maximum working memories before low-importance items are discarded. */
  retentionLimit?: number;
  /** Number of old memories that trigger automatic summarization. */
  summarizationThreshold?: number;
  /** Age in days after which a memory is considered "old" for summarization. */
  summaryAgeDays?: number;
}

interface Decision {
  action: MemoryAction;
  params?: Record<string, unknown>;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<MemoryManagerConfig, 'llmPolicy'>> = {
  decisionMode: 'rule',
  importanceThreshold: 0.4,
  retentionLimit: 500,
  summarizationThreshold: 10,
  summaryAgeDays: 3,
};

// ============================================================================
// Memory Manager Agent
// ============================================================================

export class MemoryManagerAgent {
  private config: Required<Omit<MemoryManagerConfig, 'llmPolicy'>> & { llmPolicy?: LLMPolicy };
  private store = new Map<string, MemoryItem>();
  private temporal = new TemporalGraph();
  private semantic?: ISemanticStore;
  private stats: MemoryManagerStats = { total: 0, summaries: 0, discarded: 0 };
  private idCounter = 0;

  constructor(config?: MemoryManagerConfig, semanticStore?: ISemanticStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.decisionMode === 'llm' && !this.config.llmPolicy) {
      throw new Error('MemoryManagerAgent: llmPolicy is required when decisionMode is "llm"');
    }
    this.semantic = semanticStore;
  }

  // --------------------------------------------------------------------------
  // Observation loop
  // --------------------------------------------------------------------------

  /**
   * Main entry point. Decide and execute one memory action for the given
   * observation. Returns the chosen action and its raw result.
   */
  async observe(
    observation: MemoryObservation,
  ): Promise<{ action: MemoryAction; result: unknown }> {
    const decision = await this.decideAction(observation);

    switch (decision.action) {
      case 'store': {
        const item = this.storeItem(observation);
        await this.projectToSemantic(item);
        this.applyTemporalRelations(observation.content);
        this.runLifecycleMaintenance();
        return { action: 'store', result: item };
      }
      case 'retrieve': {
        const query = (decision.params ?? { content: observation.content }) as MemoryQuery;
        const results = this.retrieve(query);
        return { action: 'retrieve', result: results };
      }
      case 'update': {
        const params = decision.params as { id: string } & Partial<MemoryItem>;
        const updated = this.update(params.id, params);
        return { action: 'update', result: updated };
      }
      case 'summarize': {
        const ids = decision.params?.ids as string[] | undefined;
        const title = (decision.params?.title as string | undefined) ?? 'Summary';
        const summary = this.summarize(ids, { title });
        return { action: 'summarize', result: summary };
      }
      case 'discard': {
        const id = decision.params?.id as string;
        const ok = this.discard(id);
        return { action: 'discard', result: ok };
      }
      default:
        // Exhaustive fallback — should never happen with the union above.
        return { action: 'store', result: this.storeItem(observation) };
    }
  }

  /**
   * Decide the next action. Public so callers can inspect the policy.
   */
  async decideAction(observation: MemoryObservation): Promise<Decision> {
    if (this.config.decisionMode === 'llm' && this.config.llmPolicy) {
      return this.config.llmPolicy({
        observation,
        workingMemories: Array.from(this.store.values()),
        stats: this.getStats(),
      });
    }
    return this.ruleDecide(observation);
  }

  // --------------------------------------------------------------------------
  // Explicit actions
  // --------------------------------------------------------------------------

  /**
   * Search working memory by content substring, tags, or context.
   */
  retrieve(query: MemoryQuery): MemoryItem[] {
    const { content, tags, context, limit = 50 } = query;
    const contentLower = content?.toLowerCase();
    const contextLower = context?.toLowerCase();

    const results: MemoryItem[] = [];
    for (const item of this.store.values()) {
      let match = true;
      if (contentLower) {
        match &&=
          item.content.toLowerCase().includes(contentLower) ||
          (item.summary?.toLowerCase().includes(contentLower) ?? false);
      }
      if (match && tags && tags.length > 0) {
        match &&= tags.some((t) => item.tags.includes(t));
      }
      if (match && contextLower) {
        match &&= item.context.toLowerCase().includes(contextLower);
      }
      if (match) {
        item.accessCount++;
        item.lastAccessedAt = new Date().toISOString();
        results.push(item);
      }
    }

    results.sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount);
    return results.slice(0, limit);
  }

  /**
   * Update an existing memory item.
   */
  update(id: string, patch: Partial<MemoryItem>): MemoryItem | null {
    const item = this.store.get(id);
    if (!item) return null;

    if (patch.content !== undefined) item.content = patch.content;
    if (patch.context !== undefined) item.context = patch.context;
    if (patch.tags !== undefined) item.tags = [...patch.tags];
    if (patch.importance !== undefined) item.importance = patch.importance;
    item.lastAccessedAt = new Date().toISOString();
    item.accessCount++;
    return item;
  }

  /**
   * Summarize a set of memories into one compact memory.
   * If `ids` is omitted, the oldest memories are summarized automatically.
   */
  summarize(ids?: string[], options?: { title?: string }): MemoryItem {
    const title = options?.title ?? 'Summary';
    let sources: MemoryItem[];

    if (ids && ids.length > 0) {
      sources = ids.map((id) => this.store.get(id)).filter((item): item is MemoryItem => !!item);
    } else {
      sources = this.selectOldMemories(this.config.summarizationThreshold);
    }

    if (sources.length === 0) {
      const empty = this.createMemoryItem({ content: `${title}: (no items to summarize)` });
      this.store.set(empty.id, empty);
      return empty;
    }

    const combined = sources.map((s) => `- ${s.content}`).join('\n');
    const summaryItem = this.createMemoryItem({
      content: `${title}:\n${combined}`,
      context: sources.map((s) => s.context).join(' | '),
      tags: Array.from(new Set(sources.flatMap((s) => s.tags))),
      importance: Math.max(...sources.map((s) => s.importance)),
    });
    summaryItem.summary = title;

    for (const source of sources) {
      this.store.delete(source.id);
    }

    this.store.set(summaryItem.id, summaryItem);
    this.stats.summaries++;
    return summaryItem;
  }

  /**
   * Remove a memory item from working memory.
   */
  discard(id: string): boolean {
    const existed = this.store.delete(id);
    if (existed) {
      this.stats.discarded++;
    }
    return existed;
  }

  // --------------------------------------------------------------------------
  // Temporal graph integration
  // --------------------------------------------------------------------------

  /**
   * Add an event to the temporal graph. Returns the created event.
   */
  addTemporalEvent(event: {
    id?: string;
    label: string;
    timestamp?: number;
    description?: string;
  }) {
    return this.temporal.addEvent(event);
  }

  /**
   * Add a temporal relation between two events in the graph.
   */
  addTemporalRelation(fromId: string, toId: string, type: 'before' | 'after' = 'before') {
    return this.temporal.addRelation(fromId, toId, type);
  }

  /**
   * Query the temporal chain between two events. `fromLabel` and `toLabel` can
   * be substrings of the stored event labels.
   */
  queryTemporalChain(fromLabel: string, toLabel: string) {
    const fromId = this.findTemporalEventId(fromLabel);
    const toId = this.findTemporalEventId(toLabel);
    if (!fromId || !toId) return [];
    return this.temporal.getChain(fromId, toId);
  }

  // --------------------------------------------------------------------------
  // Introspection
  // --------------------------------------------------------------------------

  size(): number {
    return this.store.size;
  }

  getStats(): MemoryManagerStats {
    return { ...this.stats, total: this.store.size };
  }

  // --------------------------------------------------------------------------
  // Rule engine
  // --------------------------------------------------------------------------

  private ruleDecide(observation: MemoryObservation): Decision {
    const content = observation.content.trim();

    // 1. Explicit retrieval requests.
    if (isQueryLike(content)) {
      const stripped = stripQueryPrefix(content);
      return { action: 'retrieve', params: { content: stripped } };
    }

    // 2. Summarize old memories when enough of them have accumulated.
    // The current observation counts toward the threshold if it is explicitly
    // back-dated, allowing the agent to summarize on the N-th old input.
    const oldMemories = this.selectOldMemories(this.config.summarizationThreshold);
    const observationIsOld =
      observation.createdAt !== undefined &&
      new Date(observation.createdAt).getTime() <
        Date.now() - this.config.summaryAgeDays * 24 * 60 * 60 * 1000;
    if (oldMemories.length + (observationIsOld ? 1 : 0) >= this.config.summarizationThreshold) {
      return {
        action: 'summarize',
        params: { ids: oldMemories.map((m) => m.id), title: 'Auto-summary' },
      };
    }

    // 3. Duplicate detection -> update.
    const duplicate = this.findDuplicate(content);
    if (duplicate) {
      return {
        action: 'update',
        params: {
          id: duplicate.id,
          content: mergeContent(duplicate.content, content),
          importance: Math.min(1, duplicate.importance + 0.1),
        },
      };
    }

    // 4. Default: store.
    return { action: 'store' };
  }

  private runLifecycleMaintenance(): void {
    // Discard low-importance memories if we exceed the retention limit.
    while (this.store.size > this.config.retentionLimit) {
      const victim = this.selectDiscardCandidate();
      if (!victim) break;
      this.discard(victim.id);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private storeItem(observation: MemoryObservation): MemoryItem {
    const item = this.createMemoryItem(observation);
    this.store.set(item.id, item);
    this.stats.total = this.store.size;
    return item;
  }

  private createMemoryItem(observation: MemoryObservation): MemoryItem {
    const now = new Date().toISOString();
    return {
      id: observation.id ?? this.nextId(),
      content: observation.content,
      context: observation.context ?? '',
      tags: observation.tags ?? [],
      importance: observation.importance ?? this.config.importanceThreshold,
      createdAt: observation.createdAt ?? now,
      lastAccessedAt: now,
      accessCount: 0,
    };
  }

  private nextId(): string {
    return `mem-${++this.idCounter}`;
  }

  private findDuplicate(content: string): MemoryItem | undefined {
    const lower = content.toLowerCase();
    for (const item of this.store.values()) {
      if (item.content.toLowerCase() === lower) return item;
      if (
        item.content.toLowerCase().includes(lower) ||
        lower.includes(item.content.toLowerCase())
      ) {
        return item;
      }
    }
    return undefined;
  }

  private selectOldMemories(threshold: number): MemoryItem[] {
    const cutoff = Date.now() - this.config.summaryAgeDays * 24 * 60 * 60 * 1000;
    const old = Array.from(this.store.values())
      .filter((item) => new Date(item.createdAt).getTime() < cutoff)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return old.slice(0, threshold);
  }

  private selectDiscardCandidate(): MemoryItem | undefined {
    // Prefer items below the importance threshold, then fall back to the
    // lowest-importance / least-recently-accessed item overall.
    const values = Array.from(this.store.values());
    const belowThreshold = values
      .filter((item) => item.importance <= this.config.importanceThreshold)
      .sort(
        (a, b) =>
          a.importance - b.importance ||
          new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime(),
      );
    if (belowThreshold.length > 0) return belowThreshold[0];

    return values
      .sort(
        (a, b) =>
          a.importance - b.importance ||
          new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime(),
      )
      .shift();
  }

  private async projectToSemantic(item: MemoryItem): Promise<void> {
    if (!this.semantic) return;
    const name = item.content.slice(0, 60).replace(/\n/g, ' ');
    try {
      await this.semantic.ingest({
        name,
        type: 'memory',
        description: item.content,
        relationships: item.tags.map((tag) => ({
          targetId: tag,
          type: 'tagged_as',
          strength: 0.8,
        })),
      });
    } catch {
      // Semantic projection is best-effort; do not fail the working-memory store.
    }
  }

  private applyTemporalRelations(content: string): void {
    const parsed = parseTemporalRelation(content);
    if (!parsed) return;

    const fromId = this.labelToId(parsed.from);
    const toId = this.labelToId(parsed.to);

    this.temporal.addEvent({ id: fromId, label: parsed.from });
    this.temporal.addEvent({ id: toId, label: parsed.to });
    this.temporal.addRelation(fromId, toId, parsed.relation);
  }

  private labelToId(label: string): string {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  private findTemporalEventId(labelOrId: string): string | undefined {
    const lower = labelOrId.toLowerCase();
    const events = this.temporal.getTimeline();
    // Prefer exact id match, then label substring match.
    for (const evt of events) {
      if (evt.id.toLowerCase() === lower) return evt.id;
    }
    for (const evt of events) {
      if (evt.label.toLowerCase().includes(lower)) return evt.id;
    }
    return undefined;
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function isQueryLike(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.startsWith('query:') ||
    lower.startsWith('retrieve:') ||
    lower.startsWith('find ') ||
    lower.startsWith('search ') ||
    /^\b(what|how|when|where|who|why|which|is|are|did|does|can|do|tell me|look up)\b/.test(lower)
  );
}

function stripQueryPrefix(content: string): string {
  return content.replace(/^\s*(query|retrieve)\s*:\s*/i, '').trim();
}

function mergeContent(existing: string, incoming: string): string {
  if (existing.includes(incoming)) return existing;
  return `${existing}\n${incoming}`;
}

function parseTemporalRelation(
  content: string,
): { from: string; to: string; relation: 'before' | 'after' } | null {
  // Match patterns like "X happened before Y" or "X before Y".
  const beforeMatch = content.match(
    /(.{2,80}?)\s+(?:happened\s+)?before\s+(?:happened\s+)?(.{2,80})/i,
  );
  if (beforeMatch) {
    return {
      from: cleanLabel(beforeMatch[1]),
      to: cleanLabel(beforeMatch[2]),
      relation: 'before',
    };
  }

  const afterMatch = content.match(
    /(.{2,80}?)\s+(?:happened\s+)?after\s+(?:happened\s+)?(.{2,80})/i,
  );
  if (afterMatch) {
    return {
      from: cleanLabel(afterMatch[1]),
      to: cleanLabel(afterMatch[2]),
      relation: 'after',
    };
  }

  return null;
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/^\s*(event|the)\s+/i, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}
