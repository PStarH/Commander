/**
 * Semantic Memory Store — Entity-relationship knowledge graph
 *
 * Implements the ISemanticStore contract from Pillar IV.
 *
 * Architecture:
 *   Entities (nodes) → stored with vector embeddings for similarity search
 *   Relationships (edges) → typed, weighted, traversable
 *
 * Hybrid retrieval:
 *   1. Vector similarity search (find entities semantically close to query)
 *   2. Graph traversal (expand from seed entities via relationships)
 *   3. Merge and rank by combined score
 *
 * Storage: In-memory with optional SQLite persistence.
 * The in-memory graph uses adjacency lists for O(1) edge lookup.
 * Vector search uses brute-force cosine similarity (sufficient for
 * <10K entities; for larger scale, add HNSW or pgvector backend).
 *
 * Per constraint NFR-PERF-08, vector similarity search <5ms.
 * Brute-force on 10K × 256-dim vectors ≈ 2ms on modern hardware.
 */

import { getGlobalLogger } from '../logging';
import {
  type EmbeddingFunction,
  cosineSimilarity,
} from '../runtime/embedding';
import { LocalEmbeddingFunction } from '../runtime/embedding';
import { HNSWIndex } from './hnswIndex';
import type {
  ISemanticStore,
  ISemanticEntity,
  SemanticRelationship,
  SemanticQuery,
} from '../contracts/pillarIV';

// ============================================================================
// Internal Types
// ============================================================================

interface InternalEntity extends ISemanticEntity {
  /** Adjacency list: targetId → relationship */
  outgoingEdges: Map<string, SemanticRelationship>;
  /** Reverse adjacency: sourceId → relationship */
  incomingEdges: Map<string, SemanticRelationship>;
}

// ============================================================================
// Semantic Memory Store Implementation
// ============================================================================

export class SemanticMemoryStore implements ISemanticStore {
  private entities: Map<string, InternalEntity> = new Map();
  private nameIndex: Map<string, string> = new Map(); // name.lower → id
  private typeIndex: Map<string, Set<string>> = new Map(); // type → Set<id>
  private embeddingFn: EmbeddingFunction;
  private idCounter = 0;
  private vectorIndex: HNSWIndex;

  constructor(embeddingFn?: EmbeddingFunction) {
    this.embeddingFn = embeddingFn ?? new LocalEmbeddingFunction();
    this.vectorIndex = new HNSWIndex({ bruteForceThreshold: 1000 });
  }

  /**
   * Ingest a new entity with its relationships.
   * If an entity with the same name+type exists, merges relationships instead
   * of creating a duplicate.
   */
  async ingest(entity: Omit<ISemanticEntity, 'id'>): Promise<ISemanticEntity> {
    // Check for existing entity by name+type (deduplication)
    const nameKey = `${entity.name.toLowerCase()}::${entity.type}`;
    const existingId = this.nameIndex.get(nameKey);

    if (existingId) {
      const existing = this.entities.get(existingId);
      if (existing) {
        // Merge: update description if longer, add new relationships
        if (entity.description.length > existing.description.length) {
          existing.description = entity.description;
        }
        for (const rel of entity.relationships) {
          this.addRelationship(existing, rel);
        }
        // Update embedding if description changed
        if (entity.description && !existing.embedding) {
          existing.embedding = await this.embeddingFn.generate(
            `${entity.name} ${entity.description}`,
          );
          this.vectorIndex.add(existing.id, existing.embedding);
        }
        getGlobalLogger().debug('SemanticMemoryStore', 'Merged entity', {
          id: existing.id,
          name: existing.name,
        });
        return this.toPublicEntity(existing);
      }
    }

    // Create new entity
    const id = `sem-${++this.idCounter}`;
    const embedding = await this.embeddingFn.generate(
      `${entity.name} ${entity.description}`,
    );

    const internal: InternalEntity = {
      id,
      name: entity.name,
      type: entity.type,
      description: entity.description,
      embedding,
      relationships: [...entity.relationships],
      outgoingEdges: new Map(),
      incomingEdges: new Map(),
    };

    // Register in indexes
    this.entities.set(id, internal);
    this.nameIndex.set(nameKey, id);
    this.vectorIndex.add(id, embedding);

    const typeSet = this.typeIndex.get(entity.type) ?? new Set();
    typeSet.add(id);
    this.typeIndex.set(entity.type, typeSet);

    // Register relationships
    for (const rel of entity.relationships) {
      this.addRelationship(internal, rel);
    }

    getGlobalLogger().debug('SemanticMemoryStore', 'Ingested entity', {
      id,
      name: entity.name,
      type: entity.type,
      relationships: entity.relationships.length,
    });

    return this.toPublicEntity(internal);
  }

  /**
   * Hybrid vector + graph retrieval.
   *
   * 1. Generate query embedding
   * 2. Brute-force cosine similarity against all entity embeddings
   * 3. If relationshipType specified, expand via graph traversal
   * 4. Merge, deduplicate, and rank by combined score
   */
  async query(query: SemanticQuery): Promise<ISemanticEntity[]> {
    if (this.entities.size === 0) return [];

    const limit = query.limit ?? 10;
    const minSimilarity = query.minSimilarity ?? 0.1;

    // Step 1: Vector similarity search
    let candidates: Array<{ entity: InternalEntity; score: number }> = [];

    if (query.text) {
      const queryEmbedding = await this.embeddingFn.generate(query.text);

      // Use HNSW index for O(log n) approximate nearest neighbor search.
      // Falls back to brute-force for small datasets (< threshold).
      const searchResults = this.vectorIndex.search(
        queryEmbedding,
        limit * 3, // Over-fetch for graph expansion
        minSimilarity,
      );

      for (const result of searchResults) {
        const entity = this.entities.get(result.id);
        if (!entity) continue;
        if (query.type && entity.type !== query.type) continue;
        candidates.push({ entity, score: result.score });
      }
    } else if (query.type) {
      // No text query — return all entities of the given type
      const ids = this.typeIndex.get(query.type) ?? new Set();
      for (const id of ids) {
        const entity = this.entities.get(id);
        if (entity) {
          candidates.push({ entity, score: 0.5 });
        }
      }
    }

    // Step 2: Graph expansion via relationship traversal
    if (query.relationshipType) {
      const expanded = new Map<string, { entity: InternalEntity; score: number }>();

      // Start from vector search candidates
      for (const { entity, score } of candidates) {
        for (const rel of entity.outgoingEdges.values()) {
          if (rel.type === query.relationshipType) {
            const target = this.entities.get(rel.targetId);
            if (target) {
              // Expansion score: parent score * relationship strength
              const expScore = score * rel.strength * 0.7;
              const existing = expanded.get(target.id);
              if (!existing || expScore > existing.score) {
                expanded.set(target.id, { entity: target, score: expScore });
              }
            }
          }
        }
      }

      // Merge expanded results with original candidates
      for (const { entity, score } of expanded.values()) {
        const existing = candidates.find((c) => c.entity.id === entity.id);
        if (!existing) {
          candidates.push({ entity, score });
        } else {
          // Boost score if found via both vector and graph (one-time boost, not cumulative)
          existing.score = Math.max(existing.score, score * 1.1);
        }
      }
    }

    // Step 3: Sort by score and return top-K
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, limit).map((c) => this.toPublicEntity(c.entity));
  }

  /**
   * Navigate graph paths between two entities.
   * Uses BFS up to maxDepth (default 3).
   */
  async traverse(
    fromId: string,
    toId: string,
    maxDepth: number = 3,
  ): Promise<SemanticRelationship[][]> {
    const paths: SemanticRelationship[][] = [];
    const visited = new Set<string>();

    const queue: Array<{ id: string; path: SemanticRelationship[] }> = [
      { id: fromId, path: [] },
    ];

    while (queue.length > 0 && paths.length < 10) {
      const { id, path } = queue.shift()!;

      if (id === toId && path.length > 0) {
        paths.push(path);
        continue;
      }

      if (path.length >= maxDepth) continue;
      if (visited.has(id)) continue;
      visited.add(id);

      const entity = this.entities.get(id);
      if (!entity) continue;

      for (const rel of entity.outgoingEdges.values()) {
        if (!visited.has(rel.targetId)) {
          queue.push({
            id: rel.targetId,
            path: [...path, rel],
          });
        }
      }
    }

    return paths;
  }

  /**
   * Get entity by ID.
   */
  get(id: string): ISemanticEntity | undefined {
    const internal = this.entities.get(id);
    return internal ? this.toPublicEntity(internal) : undefined;
  }

  /**
   * Get entity by name (case-insensitive).
   */
  getByName(name: string): ISemanticEntity | undefined {
    // Try all types for this name
    for (const [nameKey, id] of this.nameIndex) {
      if (nameKey.startsWith(`${name.toLowerCase()}::`)) {
        return this.get(id);
      }
    }
    return undefined;
  }

  /**
   * Get all entities of a given type.
   */
  getByType(type: string): ISemanticEntity[] {
    const ids = this.typeIndex.get(type) ?? new Set();
    return Array.from(ids)
      .map((id) => this.entities.get(id))
      .filter((e): e is InternalEntity => e !== undefined)
      .map((e) => this.toPublicEntity(e));
  }

  /**
   * Get total entity count.
   */
  get size(): number {
    return this.entities.size;
  }

  /**
   * Get total relationship count.
   */
  get relationshipCount(): number {
    let count = 0;
    for (const entity of this.entities.values()) {
      count += entity.outgoingEdges.size;
    }
    return count;
  }

  /**
   * Export all entities as JSON (for persistence/inspection).
   */
  exportAll(): ISemanticEntity[] {
    return Array.from(this.entities.values()).map((e) => this.toPublicEntity(e));
  }

  /**
   * Clear all entities (for testing).
   */
  clear(): void {
    this.entities.clear();
    this.nameIndex.clear();
    this.typeIndex.clear();
    this.idCounter = 0;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private addRelationship(entity: InternalEntity, rel: SemanticRelationship): void {
    entity.outgoingEdges.set(rel.targetId, rel);

    // Register reverse edge on target
    const target = this.entities.get(rel.targetId);
    if (target) {
      target.incomingEdges.set(entity.id, rel);
    }

    // Ensure it's in the relationships array
    const exists = entity.relationships.some(
      (r) => r.targetId === rel.targetId && r.type === rel.type,
    );
    if (!exists) {
      entity.relationships.push(rel);
    }
  }

  private toPublicEntity(internal: InternalEntity): ISemanticEntity {
    return {
      id: internal.id,
      name: internal.name,
      type: internal.type,
      description: internal.description,
      embedding: internal.embedding,
      relationships: [...internal.relationships],
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalSemanticStore: SemanticMemoryStore | null = null;

export function getGlobalSemanticMemoryStore(): SemanticMemoryStore {
  if (!globalSemanticStore) {
    globalSemanticStore = new SemanticMemoryStore();
  }
  return globalSemanticStore;
}

export function setGlobalSemanticMemoryStore(store: SemanticMemoryStore | null): void {
  globalSemanticStore = store;
}
