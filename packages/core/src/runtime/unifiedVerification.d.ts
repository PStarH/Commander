/**
 * Unified Verification Pipeline (UVP)
 *
 * Tiered verification: zero-cost patterns first, LLM verification only when needed.
 *
 * Key improvements over naive verification:
 * - Context-aware error detection (avoids false positives on normal language)
 * - Task-type-aware verification strictness
 * - Actionable feedback with problem snippets so LLM fixes in one attempt
 * - Budget-gated LLM verification
 */
import type { LLMProvider } from './types';
import type { VerificationReport, UVPTaskContext, UVPConfig } from './unifiedVerificationTypes';
export type { TaskType, VerificationSignal, VerificationReport, UVPTaskContext, UVPConfig, } from './unifiedVerificationTypes';
export { DEFAULT_UVP_CONFIG } from './unifiedVerificationTypes';
export { detectTaskType, classifyProvisionIntent } from './taskAnalyzer';
export declare class UnifiedVerificationPipeline {
    private config;
    private provider?;
    private runtime?;
    private memory;
    private totalTokensUsed;
    constructor(config?: Partial<UVPConfig>, provider?: LLMProvider);
    setRuntime(runtime: {
        getProvider(name: string): LLMProvider | undefined;
    }): void;
    setEvaluatorProvider(provider: LLMProvider): void;
    verify(ctx: UVPTaskContext): Promise<VerificationReport>;
    /**
     * Convert verification report into actionable feedback.
     * Includes the problematic snippet so the LLM knows exactly what to fix.
     * When confidence is very low, includes ALL signals (not just top 3).
     */
    toFeedback(report: VerificationReport): string | null;
    getTotalTokensUsed(): number;
    private buildReport;
}
//# sourceMappingURL=unifiedVerification.d.ts.map