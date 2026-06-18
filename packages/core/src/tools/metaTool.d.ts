/**
 * AWO-style Meta-Tool Compilation (arXiv 2601.22037)
 *
 * Research finding: Compiling recurring tool sequences into meta-tools
 * achieves 11.9% fewer LLM calls and 4.2% higher success rate.
 *
 * When the PatternTracker detects the same tool sequence ≥3 times,
 * we compile it into a single MetaTool. The model calls the meta-tool
 * once instead of N individual tools — fewer round trips, lower latency,
 * less token usage from tool definitions.
 *
 * Safety: Meta-tools are read-only observers. They don't modify tool
 * execution, they just bundle multiple calls. Each sub-tool still
 * runs with its own safety checks.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
export interface MetaToolStep {
    toolName: string;
    argumentMap: Record<string, string>;
    /** Constant values to always include in the sub-tool call (e.g., { action: 'search' }). */
    constants?: Record<string, unknown>;
}
export interface MetaToolSpec {
    /** The tool names in sequence, e.g. ['web_search', 'web_fetch'] */
    sequence: string[];
    /** Unique name for the compiled meta-tool */
    name: string;
    /** Description shown to LLM */
    description: string;
    /** How each step maps meta-tool args to sub-tool args */
    steps: MetaToolStep[];
    /** Execution function injected at runtime */
    executor?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
}
export declare class MetaTool implements Tool {
    readonly definition: ToolDefinition;
    readonly isConcurrencySafe = false;
    readonly isReadOnly = false;
    readonly timeout = 60000;
    readonly maxOutputSize = 50000;
    private spec;
    private subToolMap;
    private usageCount;
    constructor(spec: MetaToolSpec, subToolMap: Map<string, (args: Record<string, unknown>) => Promise<string>>);
    execute(args: Record<string, unknown>): Promise<string>;
    getUsageCount(): number;
}
/**
 * Check if a sequence of tool names matches a built-in meta-tool spec.
 */
export declare function findMatchingMetaSpec(sequence: string[], minFrequency: number, frequency: (seq: string[]) => number): MetaToolSpec | undefined;
export declare function getBuiltinMetaSpecs(): MetaToolSpec[];
//# sourceMappingURL=metaTool.d.ts.map