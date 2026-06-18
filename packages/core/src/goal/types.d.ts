/**
 * Goal Module — 多 Agent 目标驱动执行
 *
 * Phase 1 of the drive/swarm roadmap:
 * manager agent decomposes → worker agents execute → critic agent reviews → loop
 */
export interface GoalNode {
    id: string;
    goal: string;
    parentId: string | null;
    status: GoalStatus;
    workerOutput?: string;
    critique?: CritiqueResult;
    subGoals: GoalNode[];
    dependencies: string[];
    roundAssigned?: number;
    roundCompleted?: number;
    metadata?: Record<string, unknown>;
}
export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 're_opened';
export interface CritiqueResult {
    passed: boolean;
    findings: CritiqueFinding[];
    summary: string;
}
export interface CritiqueFinding {
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    category: CritiqueCategory;
    description: string;
    location?: string;
    suggestion?: string;
}
export type CritiqueCategory = 'correctness' | 'completeness' | 'edge_case' | 'security' | 'style' | 'performance' | 'maintainability' | 'test_coverage';
export interface RoundLedger {
    round: number;
    goalSnapshot: GoalNode[];
    findingsTotal: number;
    findingsResolved: number;
    findingsNew: number;
    improvementRate: number;
    tokensUsed: number;
    totalTokensUsed: number;
    decision: RoundDecision;
    decisionReason: string;
    summary: string;
    timestamp: string;
}
export type RoundDecision = 'continue' | 'stop_achieved' | 'stop_plateau' | 'stop_budget' | 'stop_max_rounds' | 'ask_user';
export interface GoalConfig {
    maxRounds: number;
    budgetTokens: number;
    mode: 'quick' | 'balanced' | 'thorough';
    /** Model to use for manager/critic LLM calls (default: gpt-4o-mini) */
    model?: string;
}
export declare const DEFAULT_GOAL_CONFIG: GoalConfig;
export interface GoalResult {
    goal: string;
    status: 'completed' | 'partial' | 'failed';
    totalRounds: number;
    totalTokensUsed: number;
    totalDurationMs: number;
    ledger: RoundLedger[];
    finalGoalTree: GoalNode[];
    summary: string;
}
/**
 * Manager's decomposition output: break a goal into sub-goals.
 */
export interface ManagerDecomposition {
    subGoals: Array<{
        goal: string;
        dependencies: string[];
        notes?: string;
    }>;
    reasoning: string;
}
/**
 * Manager's review output: assess a round of work.
 */
export interface ManagerReview {
    /** For each completed sub-goal: is it truly done? */
    goalAssessments: Array<{
        goalId: string;
        status: 'completed' | 'needs_rework' | 're_open';
        reason: string;
    }>;
    /** New sub-goals discovered during review */
    newSubGoals: Array<{
        goal: string;
        dependencies: string[];
    }>;
    /** Overall assessment */
    overallStatus: 'on_track' | 'needs_improvement' | 'stuck';
    overallSummary: string;
}
export interface CriticOutput {
    passed: boolean;
    findings: Array<{
        severity: CritiqueFinding['severity'];
        category: CritiqueCategory;
        description: string;
        location?: string;
        suggestion?: string;
    }>;
    summary: string;
}
//# sourceMappingURL=types.d.ts.map