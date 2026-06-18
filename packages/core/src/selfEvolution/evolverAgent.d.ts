import type { EvolutionInsight, ExecutionExperience, FailureCategory } from '../runtime/types';
import type { UltimateOrchestratorConfig } from '../ultimate/types';
/**
 * A single config mutation produced by the evolver.
 * Stores old and new values so the mutation can be reverted.
 */
export interface EvolverMutation {
    /** Unique mutation ID */
    id: string;
    /** Which config domain this mutation targets */
    domain: 'quality_gate' | 'thinking_budget' | 'model_tier' | 'synthesis' | 'runtime';
    /** Human-readable description */
    description: string;
    /** Which failure category prompted this mutation */
    triggeredBy: FailureCategory;
    /** Confidence that prompted the mutation */
    confidence: number;
    /** Dot-separated path in the config object (e.g. "defaultSynthesisConfig.consensusThreshold") */
    configPath: string;
    /** Value before mutation */
    oldValue: unknown;
    /** Value after mutation */
    newValue: unknown;
}
/**
 * Result of an evolution cycle.
 */
export interface EvolutionCycle {
    mutations: EvolverMutation[];
    applied: number;
    reverted: number;
    cycleId: string;
}
export interface CanaryDeployment {
    /** Pending mutations waiting for verification */
    mutations: EvolverMutation[];
    /** Fraction of runs that use canary config (0.0-1.0) */
    rolloutFraction: number;
    /** Run IDs that participated in the canary */
    runIds: string[];
    /** When the canary was created */
    startedAt: number;
    /** Minimum canary runs before auto-decision */
    minRuns: number;
    /** Accumulated verdicts from canary runs */
    verdicts: Array<{
        runId: string;
        success: boolean;
        timestamp: string;
    }>;
    /** Whether the canary has been decided (promoted or rejected) */
    decided: boolean;
}
export interface CanaryStatus {
    active: boolean;
    mutations: number;
    runCount: number;
    rolloutFraction: number;
    startedAt: number;
    successRate: number;
    decided: boolean;
    pendingRuns: number;
}
export declare class EvolverAgent {
    private lastMutationTime;
    private currentCanary;
    private defaultRolloutFraction;
    /** Returns ms until the cooldown expires (0 = ready) */
    get cooldownRemaining(): number;
    /**
     * Given trajectory analysis insights, produce config mutations tuned to the
     * observed failure patterns. Does NOT mutate config — just returns the plan.
     */
    evolve(insights: EvolutionInsight[], config: UltimateOrchestratorConfig): EvolverMutation[];
    /**
     * Apply mutations to the config object. Mutations are idempotent — applying
     * the same mutation twice is a no-op (oldValue already matches newValue).
     */
    applyMutations(config: UltimateOrchestratorConfig, mutations: EvolverMutation[]): number;
    /**
     * Revert mutations, restoring config to old values.
     */
    revertMutations(config: UltimateOrchestratorConfig, mutations: EvolverMutation[]): number;
    /**
     * Create falsifiable predictions for each mutation via MetaLearner.
     */
    createPredictions(mutations: EvolverMutation[], exp: ExecutionExperience, taskTypes: string[]): void;
    /**
     * Run a full evolution cycle: analyze insights → produce mutations →
     * apply → create predictions. Returns what was done.
     */
    runCycle(insights: EvolutionInsight[], config: UltimateOrchestratorConfig, exp: ExecutionExperience, taskTypes: string[]): EvolutionCycle;
    /**
     * Check whether this run should use the canary config.
     * Returns true for a random fraction of runs when a canary is active.
     */
    shouldUseCanary(): boolean;
    /**
     * Get the pending canary mutations that should be applied.
     * Returns null if no canary is active or run shouldn't use canary.
     */
    getCanaryMutations(): EvolverMutation[] | null;
    /**
     * Record the outcome of a canary run.
     * Accumulates verdicts and auto-decides when enough data is collected.
     */
    recordCanaryVerdict(runId: string, success: boolean): void;
    /**
     * Promote the canary — apply to 100% of subsequent runs.
     */
    promoteCanary(): void;
    /**
     * Reject the canary — discard pending mutations.
     */
    rejectCanary(): void;
    /**
     * Get current canary deployment status.
     */
    getCanaryStatus(): CanaryStatus;
    /**
     * Force-promote or force-reject a canary (admin action).
     */
    forceCanaryDecision(promote: boolean): void;
    private startCanary;
}
export declare function getEvolverAgent(): EvolverAgent;
export declare function resetEvolverAgent(): void;
//# sourceMappingURL=evolverAgent.d.ts.map