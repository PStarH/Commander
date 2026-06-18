import type { ExecutionTrace, TraceEvent } from '../runtime/types';
interface EventDiff {
    type: 'added' | 'removed' | 'unchanged' | 'modified';
    spanId: string;
    event?: TraceEvent;
    changes?: string[];
}
interface TraceComparison {
    runIdA: string;
    runIdB: string;
    summary: {
        totalEventsA: number;
        totalEventsB: number;
        added: number;
        removed: number;
        modified: number;
        unchanged: number;
    };
    eventDiffs: EventDiff[];
    costDelta: {
        totalCostA: number;
        totalCostB: number;
        deltaUsd: number;
        deltaPercent: number;
    };
    tokenDelta: {
        totalTokensA: number;
        totalTokensB: number;
        delta: number;
        deltaPercent: number;
    };
    durationDelta: {
        durationA: number;
        durationB: number;
        deltaMs: number;
        deltaPercent: number;
    };
}
export declare function compareTraces(traceA: ExecutionTrace, traceB: ExecutionTrace): TraceComparison;
export {};
//# sourceMappingURL=traceComparison.d.ts.map