/**
 * Memory Quality Gate
 *
 * Multi-layer quality gate for memory storage decisions.
 * Based on Self-RAG (Asai et al., 2023) and Multi-Agent Debate (Liang et al., 2023).
 *
 * Layers:
 * 1. Rule filter (0 tokens) - fast rejection of low-quality content
 * 2. Quality gate (0 tokens) - heuristic quality checks
 * 3. Deduplication (0-100 tokens) - embedding similarity check
 * 4. Consensus voting (0 tokens) - multi-signal agreement
 *
 * @module memory/memoryQualityGate
 */

import type { MemoryEntry } from '../threeLayerMemory.js';
import type { InMemoryEmbeddingStore } from '../runtime/embedding.js';
import { cosineSimilarity } from '../runtime/embedding.js';

/** A single consensus vote */
export interface ConsensusVote {
  signal: string;
  shouldStore: boolean;
  confidence: number;
  reason: string;
}

/** Result of quality gate evaluation */
export interface QualityGateResult {
  store: boolean;
  confidence: number;
  reason: string;
  votes: ConsensusVote[];
  layer: 'rule_filter' | 'quality_gate' | 'dedup' | 'consensus' | 'passed';
}

/** Configuration for MemoryQualityGate */
export interface QualityGateConfig {
  /** Minimum content length (default: 20) */
  minContentLength: number;
  /** Maximum content length before compression required (default: 500) */
  maxContentLength: number;
  /** Minimum information density (uniqueWords / totalWords, default: 0.3) */
  minDensity: number;
  /** Embedding similarity threshold for dedup (default: 0.85) */
  dedupThreshold: number;
  /** Consensus threshold for final decision (default: 0.6) */
  consensusThreshold: number;
  /** Action keywords that indicate actionable content */
  actionKeywords: string[];
  /** Fact keywords that indicate factual content */
  factKeywords: string[];
}

const DEFAULT_CONFIG: QualityGateConfig = {
  minContentLength: 2,
  maxContentLength: 500,
  minDensity: 0.3,
  dedupThreshold: 0.85,
  consensusThreshold: 0.6,
  actionKeywords: [
    'should', 'need', 'must', 'recommend', 'fix', 'use', 'avoid',
    'preference', 'always', 'never', 'important', 'remember',
    '应该', '需要', '必须', '建议', '修复', '使用', '避免', '偏好', '总是', '从不', '重要', '记住',
  ],
  factKeywords: [
    'version', 'port', 'password', 'address', 'config', 'path',
    'error', 'bug', 'issue', 'solution', 'answer',
    '版本', '端口', '密码', '地址', '配置', '路径', '错误', '问题', '解决方案', '答案',
  ],
};

/**
 * Memory Quality Gate
 *
 * Multi-layer quality gate for memory storage decisions.
 * All checks are zero-cost (no LLM calls) except optional embedding dedup.
 */
export class MemoryQualityGate {
  private config: QualityGateConfig;

  constructor(config?: Partial<QualityGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Full quality gate evaluation
   *
   * Runs all layers in order. Stops at first rejection.
   *
   * Token cost: 0-100 (only if dedup uses embedding)
   */
  async evaluate(
    entry: MemoryEntry,
    embedStore?: InMemoryEmbeddingStore,
    queryEmbedding?: number[]
  ): Promise<QualityGateResult> {
    // Layer 1: Rule filter (0 tokens)
    const ruleResult = this.passesRuleFilter(entry.content);
    if (!ruleResult.passed) {
      return {
        store: false,
        confidence: 0,
        reason: ruleResult.reason,
        votes: [],
        layer: 'rule_filter',
      };
    }

    // Layer 2: Quality gate (0 tokens)
    const qualityResult = this.passesQualityGate(entry);
    if (!qualityResult.passed) {
      return {
        store: false,
        confidence: 0,
        reason: qualityResult.reason,
        votes: [],
        layer: 'quality_gate',
      };
    }

    // Layer 3: Deduplication (0-100 tokens)
    if (embedStore && queryEmbedding) {
      const dedupResult = await this.checkDuplicate(entry.content, embedStore, queryEmbedding);
      if (dedupResult.isDuplicate) {
        return {
          store: false,
          confidence: 0,
          reason: `Duplicate of existing memory (similarity: ${dedupResult.similarity.toFixed(2)})`,
          votes: [],
          layer: 'dedup',
        };
      }
    }

    // Layer 4: Consensus voting (0 tokens)
    const votes = this.collectVotes(entry);
    const consensus = this.evaluateConsensus(votes);

    return {
      store: consensus.store,
      confidence: consensus.confidence,
      reason: consensus.store ? 'Passed all quality gates' : 'Consensus threshold not met',
      votes,
      layer: consensus.store ? 'passed' : 'consensus',
    };
  }

  /**
   * Rule filter - fast rejection of obviously low-quality content
   *
   * Token cost: 0 (pure string operations)
   */
  passesRuleFilter(content: string): { passed: boolean; reason: string } {
    // Too short
    if (content.length < this.config.minContentLength) {
      return { passed: false, reason: `Content too short (${content.length} < ${this.config.minContentLength})` };
    }

    // Pure tool call logs
    if (/^<tool_call>.*<\/tool>$/s.test(content.trim())) {
      return { passed: false, reason: 'Pure tool call log' };
    }

    // Error stack traces
    if (content.includes('at Object.<anonymous>') || content.includes('at Module._compile')) {
      return { passed: false, reason: 'Error stack trace' };
    }

    // JSON blobs (not useful as memory)
    if (content.trim().startsWith('{') && content.trim().endsWith('}')) {
      try {
        JSON.parse(content);
        return { passed: false, reason: 'Raw JSON blob' };
      } catch {
        // Not valid JSON, continue
      }
    }

    // Repetitive content (same line repeated)
    const lines = content.split('\n');
    if (lines.length > 3) {
      const uniqueLines = new Set(lines.map(l => l.trim()));
      if (uniqueLines.size / lines.length < 0.3) {
        return { passed: false, reason: 'Highly repetitive content' };
      }
    }

    return { passed: true, reason: 'Passed rule filter' };
  }

  /**
   * Quality gate - heuristic quality checks
   *
   * Token cost: 0 (pure computation)
   */
  passesQualityGate(entry: MemoryEntry): { passed: boolean; reason: string } {
    const content = entry.content;

    // Information density check
    const words = content.split(/\s+/).filter(w => w.length > 0);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    const density = words.length > 0 ? uniqueWords.size / words.length : 0;

    if (density < this.config.minDensity) {
      return { passed: false, reason: `Low information density (${density.toFixed(2)} < ${this.config.minDensity})` };
    }

    // Must contain action or fact keywords
    const lowerContent = content.toLowerCase();
    const hasAction = this.config.actionKeywords.some(kw => lowerContent.includes(kw));
    const hasFact = this.config.factKeywords.some(kw => lowerContent.includes(kw));

    if (!hasAction && !hasFact && entry.importance < 0.5) {
      return { passed: false, reason: 'No action/fact keywords and low importance' };
    }

    return { passed: true, reason: 'Passed quality gate' };
  }

  /**
   * Check for duplicate memories using embedding similarity
   *
   * Token cost: 0 (uses existing embeddings)
   */
  async checkDuplicate(
    content: string,
    embedStore: InMemoryEmbeddingStore,
    queryEmbedding: number[]
  ): Promise<{ isDuplicate: boolean; similarity: number; duplicateId?: string }> {
    // Get all entries and their embeddings
    const entries = embedStore.getAllEntries();

    let maxSimilarity = 0;
    let duplicateId: string | undefined;

    for (const entry of entries) {
      const entryEmbedding = embedStore.getEmbedding(entry.id);
      if (!entryEmbedding) continue;

      const similarity = cosineSimilarity(queryEmbedding, entryEmbedding);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        if (similarity >= this.config.dedupThreshold) {
          duplicateId = entry.id;
        }
      }
    }

    return {
      isDuplicate: maxSimilarity >= this.config.dedupThreshold,
      similarity: maxSimilarity,
      duplicateId,
    };
  }

  /**
   * Collect consensus votes from multiple signals
   *
   * Token cost: 0 (uses existing data)
   */
  private collectVotes(entry: MemoryEntry): ConsensusVote[] {
    const votes: ConsensusVote[] = [];

    // Signal 1: Importance score
    votes.push({
      signal: 'importance',
      shouldStore: entry.importance > 0.6,
      confidence: entry.importance,
      reason: `Importance: ${entry.importance.toFixed(2)}`,
    });

    // Signal 2: Access frequency
    votes.push({
      signal: 'access_frequency',
      shouldStore: entry.accessCount > 2,
      confidence: Math.min(entry.accessCount / 5, 1),
      reason: `Access count: ${entry.accessCount}`,
    });

    // Signal 3: Content length (not too short, not too long)
    const lengthScore = Math.min(entry.content.length / 100, 1) *
      (entry.content.length < this.config.maxContentLength ? 1 : 0.5);
    votes.push({
      signal: 'content_quality',
      shouldStore: lengthScore > 0.3,
      confidence: lengthScore,
      reason: `Content length: ${entry.content.length}`,
    });

    // Signal 4: Has context (more contextual = more useful)
    const hasContext = !!(entry.context && entry.context.length > 10);
    votes.push({
      signal: 'context',
      shouldStore: hasContext,
      confidence: hasContext ? 0.7 : 0.3,
      reason: hasContext ? 'Has context' : 'No context',
    });

    return votes;
  }

  /**
   * Evaluate consensus from votes
   *
   * Token cost: 0 (pure computation)
   */
  private evaluateConsensus(votes: ConsensusVote[]): { store: boolean; confidence: number } {
    if (votes.length === 0) {
      return { store: false, confidence: 0 };
    }

    const totalWeight = votes.reduce((sum, v) => sum + v.confidence, 0);
    const storeWeight = votes
      .filter(v => v.shouldStore)
      .reduce((sum, v) => sum + v.confidence, 0);

    const consensusRatio = totalWeight > 0 ? storeWeight / totalWeight : 0;

    return {
      store: consensusRatio >= this.config.consensusThreshold,
      confidence: consensusRatio,
    };
  }
}

/**
 * Lightweight quality check for fast path (no async, no embedding)
 *
 * Token cost: 0
 */
export function quickQualityCheck(content: string, importance: number): boolean {
  // Too short
  if (content.length < 2) return false;

  // Too low importance
  if (importance < 0.3) return false;

  // Pure tool call
  if (/^<tool_call>.*<\/tool>$/s.test(content.trim())) return false;

  // Error stack
  if (content.includes('at Object.<anonymous>')) return false;

  return true;
}
