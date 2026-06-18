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
/**
 * Reflexion Injector
 *
 * Injects recent reflections from MetaLearner into retry prompts.
 * This is a zero-cost enhancement that leverages existing reflection data.
 */
export declare class ReflexionInjector {
    private config;
    private reflectionBuffer;
    private readonly MAX_BUFFER;
    constructor(config?: Partial<ReflexionInjectorConfig>);
    /**
     * Add a reflection to the buffer
     *
     * Token cost: 0
     */
    addReflection(entry: ReflectionEntry): void;
    /**
     * Get the most recent N reflections from the in-process buffer.
     *
     * Tier 3.2: used by AgentRuntime to inject prior attempts into retry prompts
     * without requiring a MetaLearner instance.
     */
    getRecentReflections(limit?: number): ReflectionEntry[];
    /**
     * Get recent reflections from MetaLearner
     *
     * Token cost: 0 (reads existing data)
     */
    getRecentReflectionsFromMetaLearner(metaLearner: MetaLearner, taskType?: string): ReflectionEntry[];
    /**
     * Inject reflections into a prompt
     *
     * Token cost: ~100 tokens (3 reflections)
     */
    injectReflections(originalPrompt: string, reflections: ReflectionEntry[]): string;
    /**
     * Inject reflections using MetaLearner directly
     *
     * Token cost: ~100 tokens
     */
    injectFromMetaLearner(originalPrompt: string, metaLearner: MetaLearner, taskType?: string): string;
    /**
     * Extract insight from raw reflection text
     *
     * Token cost: 0 (string operations)
     */
    private extractInsight;
    /**
     * Extract task type from reflection text
     *
     * Token cost: 0 (string operations)
     */
    private extractTaskType;
    /**
     * Get buffer size
     */
    get size(): number;
    /**
     * Clear the buffer
     */
    clear(): void;
    /**
     * Get all buffered reflections
     */
    getAll(): ReflectionEntry[];
}
/**
 * Create a ReflexionInjector from MetaLearner
 *
 * Convenience function for quick integration.
 */
export declare function createReflexionInjector(config?: Partial<ReflexionInjectorConfig>): ReflexionInjector;
//# sourceMappingURL=reflexionInjector.d.ts.map