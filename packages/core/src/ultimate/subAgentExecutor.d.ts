import type { TaskTreeNode, ExecutionError, HumanApprovalGate, UltimateOrchestratorConfig, EffortLevel } from './types';
import type { AgentRuntimeInterface } from '../runtime';
import type { StateCheckpointer } from '../runtime/stateCheckpointer';
import { ArtifactSystem } from './artifactSystem';
import type { RunHandle } from '../atr/scheduler';
export declare class SubAgentExecutor {
    private runtime;
    private artifactSystem;
    private maxParallel;
    private config;
    private currentEffortLevel;
    private currentTeamId;
    private currentRunId;
    private currentRunHandle;
    private checkpointer;
    private approvalGate;
    private skippedApprovals;
    constructor(runtime: AgentRuntimeInterface, artifactSystem?: ArtifactSystem, maxParallel?: number, config?: UltimateOrchestratorConfig);
    /**
     * Set the effort level for the current execution. Determines lead/specialist
     * model tier mapping for sub-agents.
     */
    setEffortLevel(level: EffortLevel): void;
    private getModelTiers;
    setTeam(teamId: string | null): void;
    setRunId(runId: string | null): void;
    setRunHandle(handle: RunHandle | null): void;
    setCheckpointer(cp: StateCheckpointer | null): void;
    setApprovalGate(gate: HumanApprovalGate | null): void;
    getSkippedApprovals(): Array<{
        nodeId: string;
        reason: string;
    }>;
    getCurrentRunId(): string | null;
    private writeCheckpoint;
    executeNode(node: TaskTreeNode, projectId: string, baseContext: Record<string, unknown>, errors: ExecutionError[]): Promise<void>;
    private executeSubtasks;
    /**
     * LAMaS: compute critical path using forward/backward pass.
     * Nodes on the critical path have zero slack — delaying them
     * delays the entire execution. These nodes get scheduling priority
     * and larger token budgets.
     */
    private computeCriticalPath;
    private executeAtomicNode;
    private synthesizeSubtasks;
    /**
     * Merge per-agent output directories into the workspace.
     * Later agents' files overwrite earlier ones for the same path.
     * Cleans up the per-agent directories after merging.
     */
    private mergeAgentOutputs;
    private copyDirRecursive;
    /**
     * Merge remaining per-agent output files into the workspace, then clean up.
     */
    private cleanupOutputDir;
    private buildDependencyMap;
    private topologicalLevels;
    /**
     * Build a narrow context for sub-agents (Anthropic fresh-context pattern).
     * Only includes governanceProfile and warRoomSnapshot — drops memoryItems,
     * agentState, and full orchestrator history that bloats sub-agent prompts.
     */
    private buildNarrowContext;
    /**
     * Filter tools per role — sub-agents don't need all tools.
     * Researchers need search/read; coders need read/write/edit/bash; etc.
     */
    private filterToolsForRole;
    /**
     * Get role-specific prompt template for sub-agents.
     * Research (Anthropic 2025): differentiated role prompts improve agent
     * performance by 10-20% vs generic prompts through better role alignment.
     */
    private getRolePrompt;
    private chunkArray;
}
//# sourceMappingURL=subAgentExecutor.d.ts.map