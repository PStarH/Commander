/**
 * Capture all metadata about an evaluation run that matters for
 * reproducibility: git state, model config, parameters, environment.
 */
export interface RunProvenance {
    runId: string;
    timestamp: string;
    git: {
        commitHash: string;
        branch: string;
        dirty: boolean;
    };
    model: {
        provider: string;
        modelId: string;
        tier: string;
        temperature?: number;
        maxTokens?: number;
        reasoningConfig?: {
            enabled: boolean;
            budget?: number;
            effort?: string;
        };
    };
    system: {
        nodeVersion: string;
        platform: string;
        arch: string;
    };
    /** Arbitrary extra context (evaluation name, task set, etc.) */
    tags: Record<string, string>;
}
export declare function captureProvenance(): Omit<RunProvenance, 'runId' | 'timestamp' | 'model' | 'tags'>;
export declare function createRunProvenance(runId: string, model: RunProvenance['model'], tags?: Record<string, string>): RunProvenance;
//# sourceMappingURL=provenance.d.ts.map