/**
 * HNSW (Hierarchical Navigable Small World) Vector Index
 *
 * Replaces brute-force O(n) cosine similarity with approximate nearest
 * neighbor search at O(log n) complexity.
 *
 * This is a pure-TypeScript implementation with no external dependencies.
 * It uses the standard HNSW algorithm:
 * - Multi-layer skip-list graph with exponentially decreasing connectivity
 * - Layer 0 contains all points; layer L contains ~1/L points
 * - Search navigates from top layer down, narrowing candidates at each level
 *
 * Parameters:
 *   M: max connections per node per layer (default 16)
 *   efConstruction: dynamic candidate list size during insertion (default 200)
 *   efSearch: dynamic candidate list size during search (default 50)
 *   mL: level generation factor = 1/ln(M)
 *
 * For <1K vectors, falls back to brute-force (HNSW overhead not worth it).
 * For ≥1K vectors, uses the HNSW graph for O(log n) search.
 *
 * Per constraint NFR-PERF-08, vector similarity search <5ms.
 */

import { cosineSimilarity } from '../runtime/embedding';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

interface HNSWNode {
  /** Vector ID */
  id: string;
  /** The embedding vector */
  vector: number[];
  /** Connections per layer: layer → Set<nodeId> */
  connections: Map<number, Set<string>>;
  /** Maximum layer this node appears on */
  maxLayer: number;
}

interface SearchResult {
  id: string;
  score: number;
}

// ============================================================================
// HNSW Index Implementation
// ============================================================================

export class HNSWIndex {
  private nodes: Map<string, HNSWNode> = new Map();
  private entryPoint: string | null = null;
  private maxLayer: number = -1;
  private readonly M: number;
  private readonly Mmax0: number; // M*2 at layer 0
  private readonly efConstruction: number;
  private readonly efSearch: number;
  private readonly mL: number;
  private readonly bruteForceThreshold: number;

  // Brute-force cache for small datasets
  private allVectors: Map<string, number[]> = new Map();

  constructor(options?: {
    M?: number;
    efConstruction?: number;
    efSearch?: number;
    bruteForceThreshold?: number;
  }) {
    this.M = options?.M ?? 16;
    this.Mmax0 = this.M * 2;
    this.efConstruction = options?.efConstruction ?? 200;
    this.efSearch = options?.efSearch ?? 50;
    this.mL = 1 / Math.log(this.M);
    this.bruteForceThreshold = options?.bruteForceThreshold ?? 1000;
  }

  /**
   * Add a vector to the index.
   * If the ID already exists, updates the vector.
   */
  add(id: string, vector: number[]): void {
    // Always store in brute-force cache
    this.allVectors.set(id, vector);

    // If below threshold, don't build HNSW graph yet
    if (this.allVectors.size <= this.bruteForceThreshold) {
      return;
    }

    // If we just crossed the threshold, build the full HNSW graph from scratch
    if (this.nodes.size === 0 && this.allVectors.size > this.bruteForceThreshold) {
      this.buildFromScratch();
      return;
    }

    // Normal HNSW insertion
    this.insertHNSW(id, vector);
  }

  /**
   * Remove a vector from the index.
   */
  remove(id: string): void {
    this.allVectors.delete(id);
    this.nodes.delete(id);

    // Remove from all connection lists
    for (const node of this.nodes.values()) {
      for (const connSet of node.connections.values()) {
        connSet.delete(id);
      }
    }

    // If entry point was removed, pick a new one
    if (this.entryPoint === id) {
      if (this.nodes.size > 0) {
        const nextNode = this.nodes.values().next().value;
        if (nextNode) {
          this.entryPoint = nextNode.id;
          this.maxLayer = this.nodes.get(this.entryPoint)!.maxLayer;
        }
      } else {
        this.entryPoint = null;
        this.maxLayer = -1;
      }
    }
  }

  /**
   * Search for the k nearest neighbors of a query vector.
   * Returns results sorted by descending similarity.
   */
  search(queryVector: number[], k: number, minScore?: number): SearchResult[] {
    if (this.allVectors.size === 0) return [];

    // Use brute-force for small datasets
    if (this.allVectors.size <= this.bruteForceThreshold || this.entryPoint === null) {
      return this.bruteForceSearch(queryVector, k, minScore);
    }

    // HNSW search
    return this.hnswSearch(queryVector, k, minScore);
  }

  /**
   * Get the total number of vectors in the index.
   */
  get size(): number {
    return this.allVectors.size;
  }

  /**
   * Check if HNSW graph is active (vs brute-force mode).
   */
  get isHNSWActive(): boolean {
    return this.nodes.size > this.bruteForceThreshold;
  }

  // ------------------------------------------------------------------------
  // Brute-force search (for small datasets)
  // ------------------------------------------------------------------------

  private bruteForceSearch(query: number[], k: number, minScore?: number): SearchResult[] {
    const results: SearchResult[] = [];

    for (const [id, vector] of this.allVectors) {
      const sim = cosineSimilarity(query, vector);
      if (minScore === undefined || sim >= minScore) {
        results.push({ id, score: sim });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  // ------------------------------------------------------------------------
  // HNSW graph operations
  // ------------------------------------------------------------------------

  /**
   * Build the HNSW graph from all stored vectors.
   * Called when the dataset crosses the brute-force threshold.
   */
  private buildFromScratch(): void {
    getGlobalLogger().info('HNSWIndex', 'Building graph from scratch', {
      vectorCount: this.allVectors.size,
    });

    this.nodes.clear();
    this.entryPoint = null;
    this.maxLayer = -1;

    for (const [id, vector] of this.allVectors) {
      this.insertHNSW(id, vector);
    }

    getGlobalLogger().info('HNSWIndex', 'Graph built', {
      nodes: this.nodes.size,
      maxLayer: this.maxLayer,
      entryPoint: this.entryPoint,
    });
  }

  /**
   * Insert a node into the HNSW graph.
   */
  private insertHNSW(id: string, vector: number[]): void {
    // Generate random level for this node
    const level = this.randomLevel();

    const node: HNSWNode = {
      id,
      vector,
      connections: new Map(),
      maxLayer: level,
    };

    // Initialize connection sets for each layer
    for (let l = 0; l <= level; l++) {
      node.connections.set(l, new Set());
    }

    this.nodes.set(id, node);

    // First node — becomes entry point
    if (this.entryPoint === null) {
      this.entryPoint = id;
      this.maxLayer = level;
      return;
    }

    // Find entry point at the top layer
    let currentEntryPoint = this.entryPoint;
    let currentMaxLayer = this.maxLayer;

    // Navigate from top layer down to level+1 (greedy search)
    for (let l = currentMaxLayer; l > level; l--) {
      currentEntryPoint = this.greedySearchLayer(vector, currentEntryPoint, l, 1)[0] ?? currentEntryPoint;
    }

    // From level down to 0, connect to M nearest neighbors
    for (let l = Math.min(level, currentMaxLayer); l >= 0; l--) {
      const candidates = this.greedySearchLayer(vector, currentEntryPoint, l, this.efConstruction);

      // Select M nearest neighbors
      const M = l === 0 ? this.Mmax0 : this.M;
      const selected = this.selectNeighbors(candidates, M);

      // Add bidirectional connections
 for (const candidateId of selected) {
        const candidateNode = this.nodes.get(candidateId);
        if (!candidateNode) continue;

        node.connections.get(l)!.add(candidateId);

        const candidateConns = candidateNode.connections.get(l);
        if (candidateConns) {
          candidateConns.add(id);

          // Prune connections if exceeding M
          if (candidateConns.size > M) {
            const toPrune = this.selectNeighbors(
              [...candidateConns].map(cid => ({
                id: cid,
                score: cosineSimilarity(
                  candidateNode.vector,
                  this.nodes.get(cid)?.vector ?? [],
                ),
              })),
              M,
            );
            candidateConns.clear();
            for (const pid of toPrune) {
              candidateConns.add(pid);
            }
          }
        }
      }

      currentEntryPoint = candidates[0] ?? currentEntryPoint;
    }

    // Update entry point if this node has a higher level
    if (level > this.maxLayer) {
      this.maxLayer = level;
      this.entryPoint = id;
    }
  }

  /**
   * Greedy search at a single layer.
   * Returns candidate IDs sorted by descending similarity.
   */
  private greedySearchLayer(
    query: number[],
    entryPointId: string,
    layer: number,
    ef: number,
  ): string[] {
    const visited = new Set<string>([entryPointId]);
    const candidates: Array<{ id: string; score: number }> = [];
    const entryNode = this.nodes.get(entryPointId);
    if (!entryNode) return [];

    const entryScore = cosineSimilarity(query, entryNode.vector);
    candidates.push({ id: entryPointId, score: entryScore });

    const result: Array<{ id: string; score: number }> = [{ id: entryPointId, score: entryScore }];

    while (candidates.length > 0) {
      // Get closest unexplored candidate
      candidates.sort((a, b) => b.score - a.score);
      const current = candidates.shift()!;
      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      const neighbors = currentNode.connections.get(layer);
      if (!neighbors) continue;

      let foundBetter = false;
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const score = cosineSimilarity(query, neighborNode.vector);
        candidates.push({ id: neighborId, score });

        if (result.length < ef || score > result[result.length - 1].score) {
          result.push({ id: neighborId, score });
          result.sort((a, b) => b.score - a.score);
          if (result.length > ef) {
            result.pop();
          }
          foundBetter = true;
        }
      }

      if (!foundBetter && candidates.length === 0) {
        break;
      }
    }

    return result.map(r => r.id);
  }

  /**
   * Select the M nearest neighbors from a list of candidates.
   */
  private selectNeighbors(
    candidates: string[] | Array<{ id: string; score: number }>,
    M: number,
  ): string[] {
    let scored: Array<{ id: string; score: number }>;

    if (typeof candidates[0] === 'string') {
      // Need to compute scores
      scored = (candidates as string[]).map(id => ({
        id,
        score: 0, // Will be set by caller context
      }));
    } else {
      scored = [...(candidates as Array<{ id: string; score: number }>)];
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, M).map(s => s.id);
  }

  /**
   * HNSW search: navigate from top layer down.
   */
  private hnswSearch(query: number[], k: number, minScore?: number): SearchResult[] {
    if (this.entryPoint === null) return [];

    let currentEntryPoint = this.entryPoint;

    // Navigate from top layer to layer 1 (greedy, ef=1)
    for (let l = this.maxLayer; l > 0; l--) {
      const result = this.greedySearchLayer(query, currentEntryPoint, l, 1);
      currentEntryPoint = result[0] ?? currentEntryPoint;
    }

    // At layer 0, search with ef = max(efSearch, k)
    const ef = Math.max(this.efSearch, k);
    const candidates = this.greedySearchLayer(query, currentEntryPoint, 0, ef);

    // Convert to SearchResult with scores
    const results: SearchResult[] = [];
    for (const id of candidates) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const score = cosineSimilarity(query, node.vector);
      if (minScore === undefined || score >= minScore) {
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /**
   * Generate a random level for a new node.
   * Uses the geometric distribution: P(level = L) = exp(-L / mL)
   */
  private randomLevel(): number {
    const r = Math.random();
    return Math.floor(-Math.log(r) * this.mL);
  }

  /**
   * Clear all data from the index.
   */
  clear(): void {
    this.nodes.clear();
    this.allVectors.clear();
    this.entryPoint = null;
    this.maxLayer = -1;
  }
}
