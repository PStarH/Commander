/**
 * Reflection Pipeline
 *
 * Synthesizes episodic memories into long-term insights.
 * Based on Generative Agents (Park et al., 2023) reflection mechanism.
 *
 * Key insight: Periodically synthesize raw memories into higher-level insights,
 * then store those insights as retrievable long-term memories.
 *
 * Token cost: ~200 tokens per reflection cycle (every 5 experiences)
 * Effective cost: ~40 tokens per experience
 *
 * @module memory/reflectionPipeline
 */

import type { MemoryEntry } from '../threeLayerMemory.js';
import type { ThreeLayerMemory } from '../threeLayerMemory.js';

/** A synthesized reflection insight */
export interface ReflectionInsight {
  id: string;
  insight: string;           // 1-2 sentence summary
  sourceMemoryIds: string[]; // Source memory IDs
  importance: number;        // 0-1
  timestamp: number;
  category: 'pattern' | 'lesson' | 'strategy' | 'warning';
}

/** Configuration for ReflectionPipeline */
export interface ReflectionPipelineConfig {
  /** Number of experiences between reflection cycles (default: 5) */
  reflectionInterval: number;
  /** Maximum reflections in buffer (default: 10) */
  maxBufferSize: number;
  /** Maximum tokens for LLM synthesis (default: 200) */
  maxSynthesisTokens: number;
  /** Minimum quality for storing reflection (default: 0.5) */
  minQuality: number;
  /** Auto-promote reflections to long-term memory (default: true) */
  autoPromote: boolean;
}

const DEFAULT_CONFIG: ReflectionPipelineConfig = {
  reflectionInterval: 5,
  maxBufferSize: 10,
  maxSynthesisTokens: 200,
  minQuality: 0.5,
  autoPromote: true,
};

/** LLM provider interface for synthesis */
interface LLMProvider {
  complete(prompt: string, options?: { maxTokens?: number }): Promise<string>;
}

/**
 * Reflection Pipeline
 *
 * Synthesizes episodic memories into long-term insights.
 * Integrates with ThreeLayerMemory for automatic memory management.
 */
export class ReflectionPipeline {
  private insightBuffer: ReflectionInsight[] = [];
  private pendingMemories: MemoryEntry[] = [];
  private config: ReflectionPipelineConfig;
  private llm: LLMProvider | null = null;
  private memory: ThreeLayerMemory | null = null;

  constructor(config?: Partial<ReflectionPipelineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the LLM provider for synthesis
   */
  setLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

  /**
   * Set the memory system for promotion
   */
  setMemory(memory: ThreeLayerMemory): void {
    this.memory = memory;
  }

  /**
   * Record an experience for future reflection
   *
   * Token cost: 0 (just buffering)
   */
  recordExperience(memory: MemoryEntry): void {
    this.pendingMemories.push(memory);

    // Auto-reflect when interval is reached
    if (this.pendingMemories.length >= this.config.reflectionInterval) {
      this.reflect().catch(() => {
        // Reflection failed, continue silently
      });
    }
  }

  /**
   * Trigger a reflection cycle
   *
   * Token cost: ~200 tokens (one LLM call)
   */
  async reflect(): Promise<ReflectionInsight | null> {
    if (!this.llm) return null;
    if (this.pendingMemories.length < 2) return null;

    // Take memories for reflection
    const toReflect = this.pendingMemories.slice(0, this.config.reflectionInterval);
    this.pendingMemories = this.pendingMemories.slice(this.config.reflectionInterval);

    try {
      const insight = await this.synthesize(toReflect);

      if (insight && insight.insight.length > 10) {
        // Add to buffer
        this.insightBuffer.push(insight);
        if (this.insightBuffer.length > this.config.maxBufferSize) {
          this.insightBuffer.shift();
        }

        // Auto-promote to long-term memory
        if (this.config.autoPromote && this.memory) {
          this.promoteToMemory(insight);
        }

        return insight;
      }
    } catch {
      // Synthesis failed, put memories back
      this.pendingMemories.unshift(...toReflect);
    }

    return null;
  }

  /**
   * Synthesize memories into an insight using LLM
   *
   * Token cost: ~200 tokens
   */
  private async synthesize(memories: MemoryEntry[]): Promise<ReflectionInsight | null> {
    if (!this.llm) return null;

    const memoryTexts = memories.map(m => `- ${m.content}`).join('\n');

    const prompt = `基于以下经历，总结一条可复用的经验洞察。

要求：
1. 1-2句话，简洁明确
2. 提取可复用的模式或教训
3. 避免重复已知信息

经历：
${memoryTexts}

洞察（1-2句话）:`;

    const response = await this.llm.complete(prompt, {
      maxTokens: this.config.maxSynthesisTokens / 4, // ~50 tokens for insight
    });

    if (!response || response.length < 5) return null;

    // Determine category based on content
    const category = this.categorizeInsight(response);

    return {
      id: `insight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      insight: response.trim(),
      sourceMemoryIds: memories.map(m => m.id),
      importance: this.calculateInsightImportance(memories),
      timestamp: Date.now(),
      category,
    };
  }

  /**
   * Categorize insight based on content
   *
   * Token cost: 0 (keyword matching)
   */
  private categorizeInsight(text: string): ReflectionInsight['category'] {
    const lower = text.toLowerCase();

    if (lower.includes('pattern') || lower.includes('always') || lower.includes('typically')) {
      return 'pattern';
    }
    if (lower.includes('lesson') || lower.includes('learned') || lower.includes('insight')) {
      return 'lesson';
    }
    if (lower.includes('strategy') || lower.includes('approach') || lower.includes('method')) {
      return 'strategy';
    }
    if (lower.includes('warning') || lower.includes('avoid') || lower.includes('careful')) {
      return 'warning';
    }

    return 'lesson'; // Default
  }

  /**
   * Calculate insight importance from source memories
   *
   * Token cost: 0 (pure computation)
   */
  private calculateInsightImportance(memories: MemoryEntry[]): number {
    if (memories.length === 0) return 0.5;

    // Average importance of source memories, with boost for multiple sources
    const avgImportance = memories.reduce((sum, m) => sum + m.importance, 0) / memories.length;
    const sourceBoost = Math.min(memories.length / 5, 0.2); // Max 0.2 boost

    return Math.min(avgImportance + sourceBoost, 1);
  }

  /**
   * Promote insight to long-term memory
   *
   * Token cost: 0 (memory operation)
   */
  private promoteToMemory(insight: ReflectionInsight): void {
    if (!this.memory) return;

    this.memory.add(
      insight.insight,
      'longterm',
      `Reflection: ${insight.category}`,
      insight.importance,
      ['reflection', insight.category],
      {
        reflectionId: insight.id,
        sourceMemoryIds: insight.sourceMemoryIds,
        category: insight.category,
      }
    );
  }

  /**
   * Get recent insights for injection into prompts
   *
   * Token cost: 0 (reads buffer)
   */
  getRecentInsights(n?: number): ReflectionInsight[] {
    const count = n ?? this.config.reflectionInterval;
    return this.insightBuffer.slice(-count);
  }

  /**
   * Get insights formatted for prompt injection
   *
   * Token cost: ~50 tokens
   */
  getInsightsForPrompt(n?: number): string {
    const insights = this.getRecentInsights(n);
    if (insights.length === 0) return '';

    return insights
      .map((ins, i) => `[经验${i + 1}] ${ins.insight}`)
      .join('\n');
  }

  /**
   * Get buffer size
   */
  get bufferSize(): number {
    return this.insightBuffer.length;
  }

  /**
   * Get pending experience count
   */
  get pendingCount(): number {
    return this.pendingMemories.length;
  }

  /**
   * Force a reflection even if interval not reached
   */
  async forceReflect(): Promise<ReflectionInsight | null> {
    if (this.pendingMemories.length < 2) return null;
    return this.reflect();
  }

  /**
   * Clear all buffers
   */
  clear(): void {
    this.insightBuffer = [];
    this.pendingMemories = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    bufferSize: number;
    pendingCount: number;
    totalInsights: number;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    for (const insight of this.insightBuffer) {
      categories[insight.category] = (categories[insight.category] || 0) + 1;
    }

    return {
      bufferSize: this.insightBuffer.length,
      pendingCount: this.pendingMemories.length,
      totalInsights: this.insightBuffer.length,
      categories,
    };
  }
}
