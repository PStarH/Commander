import type { ExecutionTrace } from '../runtime/types';
import type { ReplayResult, ReplaySpec } from './types';
export declare function dryReplay(trace: ExecutionTrace, spec: ReplaySpec): ReplayResult;
export interface LiveReplayContext {
    invokeLlm: (args: {
        spanId: string;
        model: string;
        prompt: string;
        originalTokens: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
    }) => Promise<{
        text: string;
        tokens: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
        costUsd: number;
    }>;
    signal?: AbortSignal;
}
export interface LiveReplayOptions {
    modelOverride?: string;
    onlySpanIds?: string[];
}
export declare function liveReplay(trace: ExecutionTrace, spec: ReplaySpec, ctx: LiveReplayContext, options?: LiveReplayOptions): Promise<ReplayResult & {
    mode: 'live' | 'dry';
    reExecutedSpans: string[];
}>;
//# sourceMappingURL=replay.d.ts.map