/**
 * Ranking Fusion — RRF + Cross-Encoder Reranking
 *
 * Implements Reciprocal Rank Fusion (RRF) to merge multiple ranked lists
 * from heterogeneous memory sources into a single unified ranking, with
 * optional cross-encoder reranking for top-K precision improvement.
 *
 * Theory:
 * - RRF (Cormack et al., 2009): score(d) = Σ 1/(k + rank_i(d))
 *   Simple, parameter-light, robust across domains. k=60 is the standard
 *   constant that dampens the influence of highly-ranked items.
 * - Cross-encoder reranking: re-score top-K candidates with a finer-grained
 *   model (LLM-based or feature-based) to improve precision@K.
 *
 * Zero external dependencies — TypeScript-first per architecture constraint.
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

/**
 * A single ranked item from any memory source.
 * Generic over the item type T so it can wrap MemoryEntry, EpisodicMemoryItem,
 * ConversationSearchResult, or any other result type.
 */
export interface RankedItem<T = unknown> {
  /** The underlying item */
  item: T;
  /** A stable identifier for deduplication across sources */
  id: string;
  /** Human-readable text for cross-encoder scoring */
  text: string;
  /** Which source this came from */
  source: string;
  /** Original rank within its source (0-based) */
  sourceRank: number;
}

/**
 * A fused result after RRF combination.
 */
export interface FusedResult<T = unknown> {
  item: T;
  id: string;
  text: string;
  sources: string[];
  rrfScore: number;
  /** Final score after optional cross-encoder reranking (equals rrfScore if no reranking) */
  finalScore: number;
}

/**
 * Configuration for ranking fusion.
 */
export interface RankingFusionConfig {
  /** RRF constant k (default: 60, per Cormack et al. 2009) */
  rrfK: number;
  /** Number of top items to rerank with cross-encoder (default: 10) */
  rerankTopK: number;
  /** Whether to enable cross-encoder reranking (default: false — needs a scorer) */
  enableReranking: boolean;
  /** Weight of RRF score vs cross-encoder score in final ranking (default: 0.4 = 40% RRF, 60% CE) */
  rrfWeight: number;
}

const DEFAULT_CONFIG: RankingFusionConfig = {
  rrfK: 60,
  rerankTopK: 10,
  enableReranking: false,
  rrfWeight: 0.4,
};

// ============================================================================
// Cross-Encoder Scorer Interface
// ============================================================================

/**
 * Interface for cross-encoder scoring.
 *
 * A cross-encoder takes a (query, document) pair and produces a relevance
 * score. This is more accurate than bi-encoder similarity because the
 * query and document are processed jointly.
 *
 * Implementations:
 * - LLM-based: ask the LLM to rate relevance 0-1
 * - Feature-based: lexical overlap, semantic similarity, etc.
 * - Model-based: use a dedicated reranking model
 */
export interface ICrossEncoderScorer {
  /** Score a (query, document) pair, returning 0-1 relevance */
  score(query: string, document: string): Promise<number>;
}

/**
 * Feature-based cross-encoder scorer (zero-token cost).
 *
 * Uses lexical overlap, term coverage, and length-normalized
 * Jaccard similarity to approximate relevance. No LLM calls.
 */
export class LexicalCrossEncoderScorer implements ICrossEncoderScorer {
  async score(query: string, document: string): Promise<number> {
    const queryTerms = tokenize(query);
    const docTerms = tokenize(document);
    if (queryTerms.length === 0 || docTerms.length === 0) return 0;

    const querySet = new Set(queryTerms);
    const docSet = new Set(docTerms);

    // Term coverage: fraction of query terms present in document
    let covered = 0;
    for (const term of querySet) {
      if (docSet.has(term)) covered++;
    }
    const coverage = covered / querySet.size;

    // Jaccard similarity
    const intersection = new Set([...querySet].filter((t) => docSet.has(t)));
    const union = new Set([...querySet, ...docSet]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;

    // Phrase bonus: check for contiguous query term matches
    let phraseBonus = 0;
    const docLower = document.toLowerCase();
    for (let i = 0; i < queryTerms.length - 1; i++) {
      const phrase = `${queryTerms[i]} ${queryTerms[i + 1]}`;
      if (docLower.includes(phrase)) phraseBonus += 0.1;
    }
    phraseBonus = Math.min(phraseBonus, 0.3);

    // Weighted combination
    return Math.min(coverage * 0.5 + jaccard * 0.3 + phraseBonus, 1.0);
  }
}

// ============================================================================
// RRF Fusion
// ============================================================================

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param rankedLists - Array of ranked item lists (each already sorted by relevance)
 * @param config - Fusion configuration
 * @returns Fused results sorted by RRF score (descending)
 */
export function reciprocalRankFusion<T>(
  rankedLists: RankedItem<T>[][],
  config: Partial<RankingFusionConfig> = {},
): FusedResult<T>[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // Validate k > 0 to prevent division by zero
  const k = Math.max(1, cfg.rrfK);

  // Map: id → accumulated RRF score + metadata
  const fusedMap = new Map<
    string,
    {
      item: T;
      text: string;
      sources: Set<string>;
      rrfScore: number;
    }
  >();

  for (const rankedList of rankedLists) {
    for (let rank = 0; rank < rankedList.length; rank++) {
      const ranked = rankedList[rank];
      const rrfContribution = 1 / (k + rank);

      const existing = fusedMap.get(ranked.id);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.sources.add(ranked.source);
      } else {
        fusedMap.set(ranked.id, {
          item: ranked.item,
          text: ranked.text,
          sources: new Set([ranked.source]),
          rrfScore: rrfContribution,
        });
      }
    }
  }

  // Convert to array and sort by RRF score descending
  const results: FusedResult<T>[] = Array.from(fusedMap.entries()).map(([id, data]) => ({
    item: data.item,
    id,
    text: data.text,
    sources: Array.from(data.sources),
    rrfScore: data.rrfScore,
    finalScore: data.rrfScore, // Will be updated by reranking if enabled
  }));

  results.sort((a, b) => b.rrfScore - a.rrfScore);

  return results;
}

// ============================================================================
// Cross-Encoder Reranking
// ============================================================================

/**
 * Rerank the top-K fused results using a cross-encoder scorer.
 *
 * After RRF fusion, the top-K candidates are re-scored by the cross-encoder
 * for finer-grained relevance. The final score is a weighted combination
 * of RRF score (normalized) and cross-encoder score.
 *
 * @param query - The original search query
 * @param fused - RRF-fused results (will be mutated and re-sorted)
 * @param scorer - Cross-encoder scorer
 * @param config - Fusion configuration
 * @returns Reranked results
 */
export async function crossEncoderRerank<T>(
  query: string,
  fused: FusedResult<T>[],
  scorer: ICrossEncoderScorer,
  config: Partial<RankingFusionConfig> = {},
): Promise<FusedResult<T>[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const topK = Math.min(cfg.rerankTopK, fused.length);

  if (topK === 0) return fused;

  // Normalize RRF scores to 0-1 range for combination with CE scores
  const maxRrf = fused[0]?.rrfScore ?? 1;
  const minRrf = fused[topK - 1]?.rrfScore ?? 0;
  const rrfRange = maxRrf - minRrf || 1;

  // Score top-K with cross-encoder (parallelized for performance)
  const scoringPromises: Promise<number>[] = [];
  for (let i = 0; i < topK; i++) {
    scoringPromises.push(
      scorer.score(query, fused[i].text).catch((e) => {
        getGlobalLogger().debug('RankingFusion', 'cross-encoder scoring failed', {
          index: i,
          error: (e as Error)?.message,
        });
        return 0; // Default to 0 on failure
      }),
    );
  }
  const ceScoreResults = await Promise.allSettled(scoringPromises);
  const ceScores: number[] = ceScoreResults.map((r, i) => (r.status === 'fulfilled' ? r.value : 0));

  // Combine scores: weighted average of normalized RRF and CE
  const rrfWeight = cfg.rrfWeight;
  const ceWeight = 1 - rrfWeight;

  for (let i = 0; i < topK; i++) {
    const normalizedRrf = (fused[i].rrfScore - minRrf) / rrfRange;
    fused[i].finalScore = rrfWeight * normalizedRrf + ceWeight * ceScores[i];
  }

  // Re-sort only the top-K by final score, keep the rest in RRF order
  const rerankedTop = fused.slice(0, topK);
  rerankedTop.sort((a, b) => b.finalScore - a.finalScore);

  return [...rerankedTop, ...fused.slice(topK)];
}

// ============================================================================
// Full Pipeline
// ============================================================================

/**
 * Full ranking fusion pipeline: RRF + optional cross-encoder reranking.
 *
 * @param query - The original search query
 * @param rankedLists - Array of ranked item lists from different sources
 * @param scorer - Optional cross-encoder scorer (enables reranking if provided)
 * @param config - Fusion configuration
 * @returns Fused and optionally reranked results
 */
export async function fuseAndRerank<T>(
  query: string,
  rankedLists: RankedItem<T>[][],
  scorer?: ICrossEncoderScorer,
  config: Partial<RankingFusionConfig> = {},
): Promise<FusedResult<T>[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Step 1: RRF fusion
  let fused = reciprocalRankFusion(rankedLists, cfg);

  // Step 2: Cross-encoder reranking (if scorer provided and enabled)
  if (cfg.enableReranking && scorer && fused.length > 0) {
    fused = await crossEncoderRerank(query, fused, scorer, cfg);
  }

  return fused;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simple tokenizer for lexical scoring.
 * Handles English and CJK characters.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// ============================================================================
// Singleton Scorer
// ============================================================================

let globalScorer: ICrossEncoderScorer | null = null;

/**
 * Get the global cross-encoder scorer (defaults to lexical).
 */
export function getGlobalCrossEncoderScorer(): ICrossEncoderScorer {
  if (!globalScorer) {
    globalScorer = new LexicalCrossEncoderScorer();
  }
  return globalScorer;
}

/**
 * Set the global cross-encoder scorer (e.g., to use an LLM-based scorer).
 */
export function setGlobalCrossEncoderScorer(scorer: ICrossEncoderScorer | null): void {
  globalScorer = scorer;
}
