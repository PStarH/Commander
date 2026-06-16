/**
 * BM25 Tool Discovery — dynamically activate tools mid-session.
 *
 * Inspired by oh-my-pi's search_tool_bm25. When the model's task involves
 * a domain that has a relevant tool not currently in Tier 1, this system
 * can activate it mid-session based on keyword relevance scoring.
 *
 * BM25 (Best Matching 25) is a ranking function used by search engines.
 * We use it to match tool descriptions against the current task context.
 */

import type { ToolDefinition } from './types';

// ============================================================================
// BM25 Parameters
// ============================================================================

const BM25_K1 = 1.2; // Term frequency saturation parameter
const BM25_B = 0.75; // Length normalization parameter
const BM25_SCORE_THRESHOLD = 2.0; // Minimum score to activate a tool

// ============================================================================
// BM25 Scorer
// ============================================================================

interface BM25Document {
  id: string;
  text: string;
  tokens: string[];
  length: number;
}

export class BM25Scorer {
  private documents: BM25Document[] = [];
  private avgDocLength = 0;
  private docFreqs = new Map<string, number>(); // term → document frequency

  /**
   * Add a document (tool description) to the index.
   */
  addDocument(id: string, text: string): void {
    const tokens = this.tokenize(text);
    const doc: BM25Document = { id, text, tokens, length: tokens.length };
    this.documents.push(doc);

    // Update document frequencies
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this.docFreqs.set(token, (this.docFreqs.get(token) ?? 0) + 1);
    }

    // Recompute average document length
    this.avgDocLength =
      this.documents.reduce((sum, d) => sum + d.length, 0) / this.documents.length;
  }

  /**
   * Score a query against all documents. Returns sorted results.
   */
  score(query: string): Array<{ id: string; score: number }> {
    const queryTokens = this.tokenize(query);
    const n = this.documents.length;

    if (n === 0) return [];

    const scores: Array<{ id: string; score: number }> = [];

    for (const doc of this.documents) {
      let score = 0;

      for (const term of queryTokens) {
        // Term frequency in document
        const tf = doc.tokens.filter((t) => t === term).length;
        if (tf === 0) continue;

        // Document frequency
        const df = this.docFreqs.get(term) ?? 0;

        // IDF (Inverse Document Frequency)
        const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);

        // BM25 score for this term
        const tfNorm =
          (tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this.avgDocLength)));
        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ id: doc.id, score });
      }
    }

    // Sort by score descending
    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * Clear all documents.
   */
  clear(): void {
    this.documents = [];
    this.avgDocLength = 0;
    this.docFreqs.clear();
  }

  /**
   * Get document count.
   */
  get size(): number {
    return this.documents.length;
  }

  // ── Internal ──

  private tokenize(text: string): string[] {
    // Simple tokenization: lowercase, split on non-alphanumeric, filter short tokens
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}

// ============================================================================
// Tool Discovery Manager
// ============================================================================

export interface ToolActivation {
  toolName: string;
  score: number;
  reason: string;
}

export class BM25ToolDiscovery {
  private scorer = new BM25Scorer();
  private toolDescriptions = new Map<string, string>();
  private activatedTools = new Set<string>();

  /**
   * Get the number of indexed tools.
   */
  get size(): number {
    return this.scorer.size;
  }

  /**
   * Register a tool for discovery.
   */
  registerTool(tool: ToolDefinition): void {
    // Combine name, description, and category for rich matching
    const text = [
      tool.name,
      tool.description,
      tool.category ?? '',
      // Add example arguments as context
      ...(tool.examples ?? []).map((ex) => JSON.stringify(ex.arguments)),
    ].join(' ');

    this.scorer.addDocument(tool.name, text);
    this.toolDescriptions.set(tool.name, tool.description);
  }

  /**
   * Register multiple tools.
   */
  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Discover relevant tools for a task.
   * Returns tools that should be activated (not already in Tier 1).
   */
  discover(
    taskDescription: string,
    activeTools: Set<string>,
    maxActivations: number = 3,
  ): ToolActivation[] {
    const results = this.scorer.score(taskDescription);

    const activations: ToolActivation[] = [];

    for (const result of results) {
      // Skip already active tools
      if (activeTools.has(result.id)) continue;

      // Skip already activated tools (don't re-activate)
      if (this.activatedTools.has(result.id)) continue;

      // Only activate if score exceeds threshold
      if (result.score < BM25_SCORE_THRESHOLD) continue;

      activations.push({
        toolName: result.id,
        score: result.score,
        reason: `BM25 relevance: ${result.score.toFixed(2)}`,
      });

      // Mark as activated
      this.activatedTools.add(result.id);

      if (activations.length >= maxActivations) break;
    }

    return activations;
  }

  /**
   * Get all registered tool names.
   */
  getRegisteredTools(): string[] {
    return Array.from(this.toolDescriptions.keys());
  }

  /**
   * Get activated tools.
   */
  getActivatedTools(): string[] {
    return Array.from(this.activatedTools);
  }

  /**
   * Reset activation state (e.g., for a new session).
   */
  resetActivations(): void {
    this.activatedTools.clear();
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this.scorer.clear();
    this.toolDescriptions.clear();
    this.activatedTools.clear();
  }
}

// ============================================================================
// Global singleton
// ============================================================================

let globalDiscovery: BM25ToolDiscovery | null = null;

export function getBM25ToolDiscovery(): BM25ToolDiscovery {
  if (!globalDiscovery) {
    globalDiscovery = new BM25ToolDiscovery();
  }
  return globalDiscovery;
}

export function resetBM25ToolDiscovery(): void {
  globalDiscovery = null;
}
