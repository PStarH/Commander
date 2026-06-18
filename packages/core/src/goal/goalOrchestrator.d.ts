import type { LLMProvider } from '../runtime/types';
import type { GoalNode, GoalConfig, GoalResult, RoundLedger } from './types';
export declare class GoalOrchestrator {
    private provider;
    private config;
    private model;
    private rootNodes;
    private currentRound;
    private checkpointPath;
    constructor(provider: LLMProvider, config?: Partial<GoalConfig>);
    /**
     * Set the checkpoint path for persistence.
     * State is saved after each round and can be resumed.
     */
    setCheckpointPath(filePath: string): void;
    /**
     * Save current state to disk (atomic write-tmp-rename).
     */
    private checkpoint;
    /**
     * Resume from a checkpoint file.
     * Returns the saved state or null if no checkpoint exists.
     */
    resumeFromCheckpoint(): {
        goal: string;
        rootNodes: GoalNode[];
        currentRound: number;
        ledger: RoundLedger[];
        plateauRounds: number;
    } | null;
    /**
     * Clear the checkpoint file.
     */
    clearCheckpoint(): void;
    /**
     * Get the current goal tree (for status display).
     */
    getGoalTree(): GoalNode[];
    /**
     * Get the current round number.
     */
    getCurrentRound(): number;
    execute(goal: string): Promise<GoalResult>;
    private managerDecompose;
    private managerReview;
    private workerExecute;
    private criticEvaluate;
    private makeDecision;
    private buildGoalTree;
    private getPendingNodes;
    private applyReview;
    private buildSummary;
}
//# sourceMappingURL=goalOrchestrator.d.ts.map