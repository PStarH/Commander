/**
 * Procedural Memory Store
 *
 * Phase D activation: implements the IProceduralStore contract from
 * the architecture blueprint. Reads and writes procedural memory
 * entries (tool-use patterns, SOPs, workflows, heuristics) with
 * utility tracking and context-based selection.
 *
 * Production rules: IF context ∧ goal THEN action
 * Ordered by specificity + utility (success_count / invocation_count).
 */

import type { MemoryStore, EpisodicMemoryItem, MemoryWriteOptions } from '../memory';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface ProceduralEntry {
  id: string;
  proceduralType: 'sop' | 'tool' | 'workflow' | 'heuristic';
  content: string;
  conditions: string[];
  goal: string;
  action: string;
  successRate: number;
  invocationCount: number;
  successCount: number;
  tags: string[];
  createdAt: string;
  lastUsedAt: string;
}

export interface ProceduralSelectOptions {
  /** Context to match against conditions */
  context: string;
  /** Optional goal filter */
  goal?: string;
  /** Maximum results */
  limit?: number;
  /** Minimum success rate threshold */
  minSuccessRate?: number;
  /** Filter by procedural type */
  proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
}

export interface ProceduralLearnOptions {
  proceduralType: 'sop' | 'tool' | 'workflow' | 'heuristic';
  content: string;
  conditions: string[];
  goal: string;
  action: string;
  tags?: string[];
  projectId: string;
}

// ============================================================================
// Procedural Memory Store
// ============================================================================

/**
 * Procedural memory store backed by the persistent MemoryStore.
 *
 * Procedural entries are stored as EpisodicMemoryItem rows with
 * `meta.proceduralType`, `meta.successRate`, `meta.usageCount`,
 * and `meta.conditions` fields. This class provides a typed API
 * for querying and updating them.
 */
export class ProceduralMemoryStore {
  private store: MemoryStore;
  private projectId: string;

  constructor(store: MemoryStore, projectId: string = 'default') {
    this.store = store;
    this.projectId = projectId;
  }

  /**
   * Learn a new procedural rule.
   * Creates a persistent memory entry with procedural metadata.
   */
  async learn(options: ProceduralLearnOptions): Promise<ProceduralEntry> {
    const writeOptions: MemoryWriteOptions = {
      projectId: this.projectId,
      kind: 'LESSON',
      duration: 'EPISODIC',
      title: `[${options.proceduralType}] ${options.goal}: ${options.action.substring(0, 60)}`,
      content: options.content,
      tags: options.tags ?? [options.proceduralType, 'procedural'],
      priority: 70,
      confidence: 0.7,
      meta: {
        proceduralType: options.proceduralType,
        successRate: 0.5, // Start at 50% — neutral prior
        usageCount: 0,
        successCount: 0,
        conditions: options.conditions,
        goal: options.goal,
        action: options.action,
      },
    };

    const item = await this.store.write(writeOptions);

    return this.itemToEntry(item);
  }

  /**
   * Select procedural rules matching the current context.
   *
   * Scoring: specificity (condition match count) + utility (success rate).
   * Rules with more matching conditions rank higher (specificity ordering).
   * Among equally specific rules, higher success rate wins (utility ordering).
   */
  async select(options: ProceduralSelectOptions): Promise<ProceduralEntry[]> {
    // Search for procedural entries — use semantic search on the context
    const results = await this.store.searchSemantic(
      options.context,
      this.projectId,
      100, // Fetch a larger pool, then filter and rank
    );

    // Filter to procedural entries only
    let procedural = results.filter((item) => item.meta?.proceduralType);

    // Filter by type if specified
    if (options.proceduralType) {
      procedural = procedural.filter(
        (item) => item.meta?.proceduralType === options.proceduralType,
      );
    }

    // Filter by goal if specified
    if (options.goal) {
      const goalLower = options.goal.toLowerCase();
      procedural = procedural.filter(
        (item) =>
          (item.meta?.goal as string | undefined)?.toLowerCase().includes(goalLower) ||
          item.title.toLowerCase().includes(goalLower),
      );
    }

    // Filter by minimum success rate
    const minRate = options.minSuccessRate ?? 0;
    procedural = procedural.filter(
      (item) => (item.meta?.successRate as number | undefined) ?? 0 >= minRate,
    );

    // Score and rank by specificity + utility
    const contextTerms = this.tokenize(options.context);
    const scored = procedural.map((item) => {
      const conditions = (item.meta?.conditions as string[] | undefined) ?? [];
      const successRate = (item.meta?.successRate as number | undefined) ?? 0.5;
      const invocationCount = (item.meta?.usageCount as number | undefined) ?? 0;

      // Specificity: how many conditions match the context
      let specificity = 0;
      for (const condition of conditions) {
        const condLower = condition.toLowerCase();
        if (contextTerms.some((term) => condLower.includes(term))) {
          specificity++;
        }
      }
      // Normalize specificity to 0-1
      const normalizedSpecificity = conditions.length > 0 ? specificity / conditions.length : 0;

      // Utility: success rate with confidence bonus for more invocations
      const confidenceBonus = Math.log(1 + invocationCount) / 10; // Small bonus for well-tested rules
      const utility = Math.min(successRate + confidenceBonus, 1.0);

      // Combined score: 60% specificity, 40% utility
      const score = normalizedSpecificity * 0.6 + utility * 0.4;

      return { entry: this.itemToEntry(item), score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const limit = options.limit ?? 5;
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /**
   * Update the utility of a procedural rule after execution.
   *
   * Implements the production rule utility update:
   *   success_count += success ? 1 : 0
   *   invocation_count += 1
   *   success_rate = success_count / invocation_count
   *
   * Atomicity: the read-delete-write sequence is wrapped in try-catch.
   * If delete succeeds but write fails, the original entry is re-written
   * with the old data to prevent data loss.
   */
  async updateUtility(entryId: string, success: boolean): Promise<void> {
    // Read the current entry
    const item = await this.store.read(entryId, this.projectId);
    if (!item || !item.meta?.proceduralType) {
      getGlobalLogger().debug(
        'ProceduralMemoryStore',
        'updateUtility: entry not found or not procedural',
        {
          entryId,
        },
      );
      return;
    }

    const currentSuccessCount = (item.meta.successCount as number | undefined) ?? 0;
    const currentInvocationCount = (item.meta.usageCount as number | undefined) ?? 0;

    const newSuccessCount = currentSuccessCount + (success ? 1 : 0);
    const newInvocationCount = currentInvocationCount + 1;
    const newSuccessRate = newSuccessCount / newInvocationCount;

    // Prepare the updated entry
    const updatedWriteOptions: MemoryWriteOptions = {
      id: entryId,
      projectId: this.projectId,
      kind: item.kind,
      duration: item.duration,
      title: item.title,
      content: item.content,
      tags: item.tags,
      priority: item.priority,
      confidence: newSuccessRate,
      meta: {
        ...item.meta,
        successRate: newSuccessRate,
        successCount: newSuccessCount,
        usageCount: newInvocationCount,
      },
    };

    // Backup the original for recovery if write fails
    const originalWriteOptions: MemoryWriteOptions = {
      id: entryId,
      projectId: this.projectId,
      kind: item.kind,
      duration: item.duration,
      title: item.title,
      content: item.content,
      tags: item.tags,
      priority: item.priority,
      confidence: item.confidence,
      meta: item.meta,
    };

    // Atomic update: delete then write, with recovery on failure
    try {
      await this.store.delete(entryId, this.projectId);
    } catch (err) {
      getGlobalLogger().error(
        'ProceduralMemoryStore',
        'Failed to delete entry for update',
        err as Error,
        { entryId },
      );
      return; // Entry still exists with old data — no data loss
    }

    try {
      await this.store.write(updatedWriteOptions);
    } catch (err) {
      // Write failed — attempt to restore the original entry
      getGlobalLogger().error(
        'ProceduralMemoryStore',
        'Write failed after delete — restoring original',
        err as Error,
        { entryId },
      );
      try {
        await this.store.write(originalWriteOptions);
      } catch (restoreErr) {
        // Critical: both write and restore failed — data is lost
        getGlobalLogger().error(
          'ProceduralMemoryStore',
          'CRITICAL: Failed to restore original entry after failed write',
          restoreErr as Error,
          { entryId },
        );
      }
      return;
    }

    getGlobalLogger().debug('ProceduralMemoryStore', 'Updated procedural utility', {
      entryId,
      success,
      newSuccessRate,
      newInvocationCount,
    });
  }

  /**
   * Transfer a procedural rule to another agent.
   * Returns true if the transfer was successful.
   */
  async transfer(entryId: string, targetAgentId: string): Promise<boolean> {
    const item = await this.store.read(entryId, this.projectId);
    if (!item || !item.meta?.proceduralType) return false;

    // Create a copy with the target agent ID
    const transferOptions: MemoryWriteOptions = {
      projectId: this.projectId,
      agentId: targetAgentId,
      kind: 'LESSON',
      duration: 'EPISODIC',
      title: `[transferred] ${item.title}`,
      content: item.content,
      tags: [...item.tags, 'transferred'],
      priority: item.priority,
      confidence: item.confidence,
      meta: {
        ...item.meta,
        // Reset invocation stats for the new agent — they start fresh
        successRate: 0.5,
        successCount: 0,
        usageCount: 0,
      },
    };

    await this.store.write(transferOptions);
    return true;
  }

  /**
   * Compile an episodic experience into a procedural rule.
   *
   * Extracts the pattern from a successful episodic memory and
   * creates a procedural entry. This is the declarative→procedural
   * compilation described in ACT-R.
   */
  async compile(episodicId: string): Promise<ProceduralEntry | null> {
    const item = await this.store.read(episodicId, this.projectId);
    if (!item) return null;

    // Only compile from successful experiences (high confidence)
    if (item.confidence < 0.7) return null;

    // Extract conditions from tags and context
    const conditions = [...item.tags.filter((t) => t !== 'transferred')];

    // Determine procedural type from kind
    const proceduralType: 'sop' | 'tool' | 'workflow' | 'heuristic' =
      item.kind === 'DECISION' ? 'sop' : item.kind === 'LESSON' ? 'heuristic' : 'workflow';

    return this.learn({
      proceduralType,
      content: item.content,
      conditions,
      goal: item.title,
      action: item.content.substring(0, 200),
      tags: item.tags,
      projectId: this.projectId,
    });
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private itemToEntry(item: EpisodicMemoryItem): ProceduralEntry {
    const meta = item.meta ?? {};
    return {
      id: item.id,
      proceduralType:
        (meta.proceduralType as 'sop' | 'tool' | 'workflow' | 'heuristic') ?? 'heuristic',
      content: item.content,
      conditions: (meta.conditions as string[]) ?? [],
      goal: (meta.goal as string) ?? item.title,
      action: (meta.action as string) ?? item.content.substring(0, 200),
      successRate: (meta.successRate as number) ?? 0.5,
      invocationCount: (meta.usageCount as number) ?? 0,
      successCount: (meta.successCount as number) ?? 0,
      tags: item.tags,
      createdAt: item.createdAt,
      lastUsedAt: item.lastAccessedAt,
    };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);
  }
}
