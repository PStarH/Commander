import type { LLMProvider } from '../runtime/types';
import type { AnalysisMode, ExecutionExperience, EvolutionInsight } from '../runtime/types';
export declare class TrajectoryAnalyzer {
    private mode;
    private provider?;
    private model?;
    constructor(mode: AnalysisMode, provider?: LLMProvider | undefined, model?: string | undefined);
    /**
     * Analyse a batch of execution experiences.
     *
     * light:     heuristic-only, zero LLM calls
     * balanced:  heuristic first, LLM fallback for unclassified failures
     * thorough:  LLM for every failure, successes use heuristic
     */
    analyze(experiences: ExecutionExperience[]): Promise<EvolutionInsight[]>;
}
//# sourceMappingURL=trajectoryAnalyzer.d.ts.map