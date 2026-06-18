import type { UltimateExecutionContext, UltimateExecutionResult, UltimateOrchestratorConfig, OrchestrationTopology, EffortLevel, TaskTreeNode } from './types';
import type { ModelTier } from '../runtime/types';
import type { AgentRuntimeInterface } from '../runtime';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import type { ExecutionExperience } from '../runtime/types';
import { ArtifactSystem } from './artifactSystem';
import { CapabilityRegistry } from './capabilityRegistry';
import { AgentTeamManager } from './agentTeamManager';
export interface PinnedSessionConfig {
    runId: string;
    configHash: string;
    topology: string;
    effortLevel: string;
    modelTierMapping: Record<string, string>;
    qualityGateThresholds: Record<string, number>;
    pinnedAt: string;
}
export declare class UltimateOrchestrator {
    private config;
    private telos;
    private runtime;
    private atomizer;
    private topologyRouter;
    private subAgentExecutor;
    private synthesizer;
    private artifactSystem;
    private capabilityRegistry;
    private teamManager;
    private topologyOptimizer;
    private evolutionEngine;
    private workCoordinator;
    private activeExecutions;
    private executionCounter;
    /** Session-pinned configs: per-run config snapshot to prevent mid-task changes */
    private pinnedSessions;
    private maxPinnedSessions;
    constructor(telos: TELOSOrchestrator, runtime: AgentRuntimeInterface, config?: Partial<UltimateOrchestratorConfig>, artifactSystem?: ArtifactSystem, capabilityRegistry?: CapabilityRegistry, teamManager?: AgentTeamManager);
    execute(params: {
        projectId: string;
        agentId: string;
        goal: string;
        contextData?: Record<string, unknown>;
        effortLevel?: EffortLevel;
        topology?: OrchestrationTopology;
        onProgress?: (phase: string, detail: string) => void;
    }): Promise<UltimateExecutionResult>;
    private buildContext;
    private computeMetrics;
    getExecution(id: string): UltimateExecutionContext | undefined;
    listExecutions(): UltimateExecutionContext[];
    getConfig(): UltimateOrchestratorConfig;
    /**
     * Live update of one (or all) quality gate thresholds. Mutates BOTH the
     * engine-side `config.qualityGates` (consumed by `runQualityGatesStrict`)
     * and the synthesis-side `config.defaultSynthesisConfig.qualityGates`
     * (consumed by `applyOptimizationSuggestions`). Threshold is clamped to
     * [0, 1]. Name "all" applies to every enabled gate.
     * Returns true if any gate was updated.
     */
    setQualityGateThreshold(name: string, threshold: number): boolean;
    /**
     * Live override of effort-level → model-tier mapping. Useful for forcing
     * all sub-agents onto a single tier mid-session (e.g., cost honeymoon).
     * Pass `undefined` for `tier` to reset to default tier for a level.
     */
    setModelTier(effortLevel: EffortLevel, tier: ModelTier | undefined): void;
    /** Snapshots the current config for a run, preventing mid-task mutations. */
    pinSessionConfig(runId: string, topology: string | undefined, effortLevel: string | undefined): void;
    /** Get pinned config for a session, or null if not pinned. */
    getSessionPinnedConfig(runId: string): PinnedSessionConfig | null;
    /** List all active pinned sessions. */
    getPinnedSessions(): PinnedSessionConfig[];
    /** Number of active pinned sessions. */
    getPinnedSessionCount(): number;
    /**
     * Fire-and-forget checkpoint trigger (MiMo-style).
     * Evaluates token usage against trigger points (20%/45%/70%) and writes
     * a structured checkpoint.md via an independent LLM call.
     *
     * This runs OUTSIDE the main agent's attention — the main execution loop
     * does not block on checkpoint completion.
     */
    private maybeCheckpoint;
    /** Simple hash of key config properties for version comparison. */
    private computeConfigHash;
    /**
     * Close the meta-learning feedback loop.
     * Reads optimization suggestions from the MetaLearner and applies them
     * to the orchestrator's live config — making the system self-optimizing.
     * When an experience is provided, creates a falsifiable prediction for each strategy change.
     */
    applyOptimizationSuggestions(exp?: ExecutionExperience): void;
    /**
     * Unified trajectory analysis + evolution cycle.
     * Single TrajectoryAnalyzer call feeds both failure classification and evolver mutations,
     * eliminating the duplicate LLM call that previously existed in analyzeExecution + runEvolutionCycle.
     */
    private analyzeAndEvolve;
    private sumTokenUsage;
    private collectCompletedNodes;
    /**
     * Build a TaskDAG from the deliberation plan for topology-aware routing.
     * Creates nodes based on estimated agent count and edges from decomposition strategy.
     */
    private buildDAGFromDeliberation;
    private executeEvaluatorOptimizerLoop;
    dispose(): void;
}
export declare function countNodes(node: TaskTreeNode): number;
export declare function measureDepth(node: TaskTreeNode): number;
export declare function flattenTree(node: TaskTreeNode): TaskTreeNode[];
//# sourceMappingURL=orchestrator.d.ts.map