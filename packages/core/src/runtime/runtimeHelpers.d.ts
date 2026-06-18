import type { AgentRuntimeConfig, ToolCall } from './types';
export declare const DEFAULT_CONFIG: AgentRuntimeConfig;
export declare function generateId(): string;
export declare function now(): string;
export declare function delay(ms: number): Promise<void>;
/**
 * Descending scheduler: reorder tools so broad/capacity tools run first.
 * Research finding (W&D, arXiv Feb 2026): +7.3% on BrowseComp.
 */
export declare function descendingToolOrder(toolCalls: ToolCall[]): ToolCall[];
export declare function applyObservationMask(toolResults: Array<{
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
}>, windowSize: number): Promise<Array<{
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
}>>;
export declare function isMutationTool(name: string): boolean;
//# sourceMappingURL=runtimeHelpers.d.ts.map