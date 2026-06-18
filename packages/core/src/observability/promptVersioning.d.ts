import type { TraceEvent, ExecutionTrace } from '../runtime/types';
interface PromptVersion {
    versionId: string;
    promptHash: string;
    promptPreview: string;
    firstSeen: string;
    lastSeen: string;
    runCount: number;
    avgTokens: number;
    avgDurationMs: number;
    successRate: number;
}
interface PromptVersionDiff {
    versionA: string;
    versionB: string;
    similarity: number;
    tokenDelta: number;
    costDelta: number;
}
export declare class PromptVersionTracker {
    private versions;
    private eventVersions;
    recordEvent(event: TraceEvent): void;
    recordFromTrace(trace: ExecutionTrace): void;
    getVersion(versionId: string): PromptVersion | undefined;
    getAllVersions(): PromptVersion[];
    getVersionForEvent(spanId: string): PromptVersion | undefined;
    compareVersions(versionIdA: string, versionIdB: string): PromptVersionDiff | undefined;
    getSummary(): {
        totalVersions: number;
        totalEvents: number;
        mostUsedVersion: PromptVersion | undefined;
        avgTokensByVersion: Array<{
            versionId: string;
            avgTokens: number;
            runCount: number;
        }>;
    };
}
export declare function getPromptVersionTracker(): PromptVersionTracker;
export declare function resetPromptVersionTracker(): void;
export {};
//# sourceMappingURL=promptVersioning.d.ts.map