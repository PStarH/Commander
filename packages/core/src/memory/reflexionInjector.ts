/**
 * Reflexion Injector
 *
 * Injects recent reflections into retry prompts for improved performance.
 * Based on Reflexion (Shinn et al., 2023) - achieved 91% pass@1 on HumanEval.
 *
 * Key insight: The last 3 reflections are injected into subsequent attempt prompts,
 * providing ~300 tokens of context that significantly improves retry success rate.
 *
 * Token cost: ~100 tokens (3 reflections x ~30 tokens each)
 *
 * @module memory/reflexionInjector
 */

import type { MetaLearner } from '../selfEvolution/metaLearner.js';

/** A reflection entry for injection */
export interface ReflectionEntry {
  id: string;
  insight: string;
  type: 'success' | 'failure';
  timestamp: number;
  taskType?: string;
}

/** Configuration for ReflexionInjector */
export interface ReflexionInjectorConfig {
  /** Maximum number of reflections to inject (default: 3) */
  maxReflections: number;
  /** Maximum tokens per reflection (default: 50) */
  maxTokensPerReflection: number;
  /** Whether to include task type in reflection (default: true) */
  includeTaskType: boolean;
  /** Whether to filter by same task type (default: false) */
  filterByTaskType: boolean;
}

const DEFAULT_CONFIG: ReflexionInjectorConfig = {
  maxReflections: 3,
  maxTokensPerReflection: 50,
  includeTaskType: true,
  filterByTaskType: false,
};

/**
 * Reflexion Injector
 *
 * Injects recent reflections from MetaLearner into retry prompts.
 * This is a zero-cost enhancement that leverages existing reflection data.
 */
export class ReflexionInjector {
  private config: ReflexionInjectorConfig;
  private reflectionBuffer: ReflectionEntry[] = [];
  private readonly MAX_BUFFER = 20;

  constructor(config?: Partial<ReflexionInjectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a reflection to the buffer
   *
   * Token cost: 0
   */
  addReflection(entry: ReflectionEntry): void {
    this.reflectionBuffer.push(entry);

    // Keep buffer bounded
    if (this.reflectionBuffer.length > this.MAX_BUFFER) {
      this.reflectionBuffer.shift();
    }
  }

  /**
   * Get the most recent N reflections from the in-process buffer.
   *
   * Tier 3.2: used by AgentRuntime to inject prior attempts into retry prompts
   * without requiring a MetaLearner instance.
   */
  getRecentReflections(limit: number = this.config.maxReflections): ReflectionEntry[] {
    return this.reflectionBuffer.slice(-limit);
  }

  /**
   * Get recent reflections from MetaLearner
   *
   * Token cost: 0 (reads existing data)
   */
  getRecentReflectionsFromMetaLearner(
    metaLearner: MetaLearner,
    taskType?: string
  ): ReflectionEntry[] {
    const rawReflections = metaLearner.getReflections(this.config.maxReflections * 2);

    const entries: ReflectionEntry[] = rawReflections.map((text, i) => ({
      id: `meta-${i}`,
      insight: this.extractInsight(text),
      type: text.includes('[Reflection: SUCCESS]') ? 'success' as const : 'failure' as const,
      timestamp: Date.now() - (i * 60000), // Approximate timestamps
      taskType: this.extractTaskType(text),
    }));

    // Optionally filter by task type
    let filtered = entries;
    if (this.config.filterByTaskType && taskType) {
      filtered = entries.filter(e => !e.taskType || e.taskType === taskType);
    }

    return filtered.slice(0, this.config.maxReflections);
  }

  /**
   * Inject reflections into a prompt
   *
   * Token cost: ~100 tokens (3 reflections)
   */
  injectReflections(
    originalPrompt: string,
    reflections: ReflectionEntry[]
  ): string {
    if (reflections.length === 0) return originalPrompt;

    const recent = reflections.slice(0, this.config.maxReflections);

    const reflectionText = recent
      .map((r, i) => {
        const typeLabel = r.type === 'success' ? '成功经验' : '失败教训';
        const taskLabel = this.config.includeTaskType && r.taskType
          ? ` (${r.taskType})`
          : '';
        return `[${typeLabel}${taskLabel}] ${r.insight}`;
      })
      .join('\n');

    return `${originalPrompt}

## 历史经验
${reflectionText}

基于以上经验，避免重复错误，利用成功模式。`;
  }

  /**
   * Inject reflections using MetaLearner directly
   *
   * Token cost: ~100 tokens
   */
  injectFromMetaLearner(
    originalPrompt: string,
    metaLearner: MetaLearner,
    taskType?: string
  ): string {
    const reflections = this.getRecentReflectionsFromMetaLearner(metaLearner, taskType);
    return this.injectReflections(originalPrompt, reflections);
  }

  /**
   * Extract insight from raw reflection text
   *
   * Token cost: 0 (string operations)
   */
  private extractInsight(text: string): string {
    // Remove prefix tags
    let insight = text
      .replace(/\[Reflection: (SUCCESS|FAILURE)\]\s*/i, '')
      .replace(/Task Type:.*?\n/i, '')
      .replace(/Strategy:.*?\n/i, '')
      .replace(/Duration:.*?\n/i, '')
      .replace(/Cost:.*?\n/i, '')
      .trim();

    // Truncate to max tokens (rough estimate: 1 token ≈ 4 chars)
    const maxChars = this.config.maxTokensPerReflection * 4;
    if (insight.length > maxChars) {
      insight = insight.slice(0, maxChars) + '...';
    }

    return insight;
  }

  /**
   * Extract task type from reflection text
   *
   * Token cost: 0 (string operations)
   */
  private extractTaskType(text: string): string | undefined {
    const match = text.match(/Task Type:\s*(\w+)/i);
    return match ? match[1] : undefined;
  }

  /**
   * Get buffer size
   */
  get size(): number {
    return this.reflectionBuffer.length;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.reflectionBuffer = [];
  }

  /**
   * Get all buffered reflections
   */
  getAll(): ReflectionEntry[] {
    return [...this.reflectionBuffer];
  }
}

/**
 * Create a ReflexionInjector from MetaLearner
 *
 * Convenience function for quick integration.
 */
export function createReflexionInjector(config?: Partial<ReflexionInjectorConfig>): ReflexionInjector {
  return new ReflexionInjector(config);
}
