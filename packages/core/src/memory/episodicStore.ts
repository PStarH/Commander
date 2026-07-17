/**
 * Episodic Memory Store — time-indexed experiences with ACT-R activation decay
 *
 * Implements the IEpisodicStore contract from Pillar IV.
 *
 * L3-10a: non-product internal (Pillar IV ACT-R helper). Not the durable product
 * write authority — product writes use writeProductMemory → MemoryStore →
 * MemoryService.store (MEMORY-001). Kept for ThreeLayerMemory recall enrichment.
 *
 * ACT-R Base-Level Activation:
 *   B_i(t) = ln(Σ_j (t - t_j)^(-d))
 *
 * Where:
 *   t = current time, t_j = time of j-th practice/use
 *   d = decay parameter (default: 0.5)
 *
 * Episodic memories:
 * - Record experiences with context, action, outcome
 * - Recall by context similarity + temporal proximity + activation level
 * - Reinforce on access (increases activation, slows decay)
 * - Apply time-based decay (memories fade unless reinforced)
 *
 * Per constraint PIV-FR-02, uses temporal graph representation.
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import type { IEpisodicStore, IEpisodicRecord, EpisodicQuery } from '../contracts/pillarIV';

// ============================================================================
// Types
// ============================================================================

interface StoredEpisodicRecord extends IEpisodicRecord {
  /** Times this record was accessed (for activation computation) */
  accessTimestamps: number[];
  /** Original creation timestamp */
  createdAt: number;
}

// ============================================================================
// EpisodicMemoryStore Implementation
// ============================================================================

export class EpisodicMemoryStore implements IEpisodicStore {
  private records: Map<string, StoredEpisodicRecord> = new Map();
  private decayParameter: number;
  private baseActivationOffset: number;
  private reinforcementBonus: number;

  constructor(options?: {
    decayParameter?: number;
    baseActivationOffset?: number;
    reinforcementBonus?: number;
  }) {
    this.decayParameter = options?.decayParameter ?? 0.5;
    this.baseActivationOffset = options?.baseActivationOffset ?? 0.0;
    this.reinforcementBonus = options?.reinforcementBonus ?? 1.0;
  }

  /**
   * Record a new experience.
   * Initial activation is computed based on the current time.
   */
  async record(experience: Omit<IEpisodicRecord, 'id' | 'activation'>): Promise<IEpisodicRecord> {
    const id = crypto.randomUUID();
    const now = Date.now();

    const record: StoredEpisodicRecord = {
      ...experience,
      id,
      activation: this.computeActivation([now], now),
      accessTimestamps: [now],
      createdAt: now,
    };

    this.records.set(id, record);

    getGlobalLogger().debug('EpisodicMemoryStore', 'Recorded experience', {
      id,
      context: experience.context,
      action: experience.action,
      activation: record.activation,
    });

    return this.toPublicRecord(record);
  }

  /**
   * Recall experiences matching context and time range.
   * Results are ranked by:
   * 1. Context similarity (text matching)
   * 2. Temporal proximity (recent first)
   * 3. Activation level (ACT-R)
   */
  async recall(query: EpisodicQuery): Promise<IEpisodicRecord[]> {
    const now = Date.now();
    const results: StoredEpisodicRecord[] = [];

    // Filter by time range
    const sinceMs = query.since ? new Date(query.since).getTime() : 0;
    const untilMs = query.until ? new Date(query.until).getTime() : Infinity;

    for (const record of this.records.values()) {
      // Time range filter
      if (record.timestamp < sinceMs || record.timestamp > untilMs) continue;

      // Tag filter
      if (query.tags && query.tags.length > 0) {
        const hasTag = query.tags.some((tag) => record.tags.includes(tag));
        if (!hasTag) continue;
      }

      // Context similarity scoring
      let contextScore = 0;
      if (query.context) {
        contextScore = this.computeContextSimilarity(
          query.context,
          record.context,
          record.action,
          record.outcome,
        );
      }

      // Minimum activation threshold
      const activation = this.computeActivation(record.accessTimestamps, now);
      record.activation = activation;

      if (query.minActivation !== undefined && activation < query.minActivation) continue;

      // Combined score: context similarity + activation + temporal proximity
      const temporalProximity = 1 / (1 + Math.abs(now - record.timestamp) / (1000 * 60 * 60)); // hours decay
      const combinedScore = contextScore * 0.5 + activation * 0.3 + temporalProximity * 0.2;

      results.push({ ...record, activation });
    }

    // Sort by combined score (highest first)
    results.sort((a, b) => {
      const scoreA = this.scoreRecord(a, query, now);
      const scoreB = this.scoreRecord(b, query, now);
      return scoreB - scoreA;
    });

    // Apply limit
    const limit = query.limit ?? 10;
    const limited = results.slice(0, limit);

    // Reinforce accessed records (access increases activation)
    for (const record of limited) {
      const stored = this.records.get(record.id);
      if (stored) {
        stored.accessTimestamps.push(now);
      }
    }

    return limited.map((r) => this.toPublicRecord(r));
  }

  /**
   * Reinforce an experience (increase activation).
   * Adds an access timestamp, which slows future decay.
   */
  async reinforce(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      getGlobalLogger().warn('EpisodicMemoryStore', 'Record not found for reinforcement', { id });
      return;
    }

    const now = Date.now();
    record.accessTimestamps.push(now);
    record.activation = this.computeActivation(record.accessTimestamps, now);

    getGlobalLogger().debug('EpisodicMemoryStore', 'Reinforced record', {
      id,
      newActivation: record.activation,
      accessCount: record.accessTimestamps.length,
    });
  }

  /**
   * Apply time-based decay to all episodic memories.
   * Recomputes activation for all records and removes those below threshold.
   * Returns the number of records removed.
   */
  async applyDecay(hoursElapsed: number): Promise<number> {
    const now = Date.now();
    // Simulate time passage for decay computation
    const simulatedNow = now + hoursElapsed * 60 * 60 * 1000;
    let removedCount = 0;
    const minActivation = -3.0; // Records below this activation are removed

    for (const [id, record] of this.records) {
      const activation = this.computeActivation(record.accessTimestamps, simulatedNow);
      record.activation = activation;

      if (activation < minActivation) {
        this.records.delete(id);
        removedCount++;
      }
    }

    getGlobalLogger().info('EpisodicMemoryStore', 'Decay applied', {
      hoursElapsed,
      removed: removedCount,
      remaining: this.records.size,
    });

    return removedCount;
  }

  /**
   * Get the total number of stored records.
   */
  getRecordCount(): number {
    return this.records.size;
  }

  /**
   * Get a specific record by ID.
   */
  getRecord(id: string): IEpisodicRecord | undefined {
    const record = this.records.get(id);
    return record ? this.toPublicRecord(record) : undefined;
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  /**
   * ACT-R base-level activation:
   *   B_i(t) = ln(Σ_j (t - t_j)^(-d)) + offset
   */
  private computeActivation(accessTimestamps: number[], currentTime: number): number {
    if (accessTimestamps.length === 0) return this.baseActivationOffset;

    let sum = 0;
    for (const ts of accessTimestamps) {
      const timeDiff = (currentTime - ts) / 1000; // seconds
      if (timeDiff > 0) {
        sum += Math.pow(timeDiff, -this.decayParameter);
      } else {
        // Just accessed — maximum activation
        sum += 1.0;
      }
    }

    if (sum <= 0) return this.baseActivationOffset;
    return Math.log(sum) + this.baseActivationOffset;
  }

  /**
   * Compute context similarity using keyword overlap.
   * Returns a score in [0, 1].
   */
  private computeContextSimilarity(
    queryContext: string,
    recordContext: string,
    recordAction: string,
    recordOutcome: string,
  ): number {
    const queryTokens = this.tokenize(queryContext);
    if (queryTokens.length === 0) return 0.5; // No query context — neutral score

    const recordTokens = new Set([
      ...this.tokenize(recordContext),
      ...this.tokenize(recordAction),
      ...this.tokenize(recordOutcome),
    ]);

    let overlap = 0;
    for (const token of queryTokens) {
      if (recordTokens.has(token)) overlap++;
    }

    return overlap / queryTokens.length;
  }

  /**
   * Simple tokenizer: lowercase, split on non-alphanumeric.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
  }

  /**
   * Score a record for ranking (combines context, activation, temporal).
   */
  private scoreRecord(record: StoredEpisodicRecord, query: EpisodicQuery, now: number): number {
    const contextScore = query.context
      ? this.computeContextSimilarity(query.context, record.context, record.action, record.outcome)
      : 0.5;

    const activationScore = Math.max(0, record.activation);
    const temporalScore = 1 / (1 + Math.abs(now - record.timestamp) / (1000 * 60 * 60));

    return contextScore * 0.5 + activationScore * 0.3 + temporalScore * 0.2;
  }

  /**
   * Convert internal record to public interface (strip internal fields).
   */
  private toPublicRecord(record: StoredEpisodicRecord): IEpisodicRecord {
    return {
      id: record.id,
      timestamp: record.timestamp,
      context: record.context,
      action: record.action,
      outcome: record.outcome,
      activation: record.activation,
      tags: [...record.tags],
    };
  }
}

// ============================================================================
// Singleton — tenant-aware for multi-tenant isolation
// ============================================================================

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const episodicStoreSingleton = createTenantAwareSingleton(() => new EpisodicMemoryStore(), {
  componentName: 'EpisodicMemoryStore',
});

export function getGlobalEpisodicStore(): EpisodicMemoryStore {
  return episodicStoreSingleton.get();
}

export function resetGlobalEpisodicStore(): void {
  episodicStoreSingleton.reset();
}
