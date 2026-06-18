/**
 * Orchestration Types for Commander Multi-Agent System
 *
 * Based on Microsoft AI Agent Orchestration Patterns:
 * https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
 */
/**
 * A single step in a sequential pipeline.
 * Each step processes the output from the previous step.
 */
export interface SequentialStep<TInput = unknown, TOutput = unknown> {
    id: string;
    name: string;
    description?: string;
    agentId: string;
    /** Optional transformation to apply before passing to agent */
    inputTransform?: (input: TInput, context: SequentialContext) => TInput;
    /** Optional transformation to apply after agent output */
    outputTransform?: (output: TOutput, context: SequentialContext) => TOutput;
    /** Maximum retries on failure */
    maxRetries?: number;
    /** Timeout in milliseconds */
    timeoutMs?: number;
    /** Whether to continue on error (default: false) */
    continueOnError?: boolean;
}
/**
 * Shared context passed through all steps in a sequential pipeline.
 */
export interface SequentialContext {
    pipelineId: string;
    projectId: string;
    startedAt: string;
    currentStepIndex: number;
    totalSteps: number;
    /** Accumulated results from completed steps */
    stepResults: Map<string, SequentialStepResult>;
    /** User-provided metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Result of executing a single step.
 */
export interface SequentialStepResult<TOutput = unknown> {
    stepId: string;
    status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
    startedAt?: string;
    completedAt?: string;
    output?: TOutput;
    error?: string;
    retryCount?: number;
    /** Token usage for this step */
    tokenUsage?: TokenUsage;
}
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
/**
 * Overall status of a sequential pipeline run.
 */
export type SequentialPipelineStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
/**
 * Complete definition of a sequential pipeline.
 */
export interface SequentialPipeline<TInput = unknown, TOutput = unknown> {
    id: string;
    name: string;
    description?: string;
    projectId: string;
    steps: SequentialStep<TInput, TOutput>[];
    /** Initial input for the first step */
    initialInput?: TInput;
    /** Whether to stop pipeline on first error (default: true) */
    stopOnError?: boolean;
    /** Global timeout for entire pipeline in milliseconds */
    globalTimeoutMs?: number;
    /** Maximum parallel steps (for hybrid concurrent execution) */
    maxParallelSteps?: number;
    /** Created timestamp */
    createdAt: string;
    /** Updated timestamp */
    updatedAt: string;
}
/**
 * Execution state for a running pipeline.
 */
export interface SequentialPipelineRun {
    id: string;
    pipelineId: string;
    projectId: string;
    status: SequentialPipelineStatus;
    context: SequentialContext;
    results: SequentialStepResult[];
    startedAt: string;
    completedAt?: string;
    error?: string;
    /** Total token usage across all steps */
    totalTokenUsage?: TokenUsage;
}
/**
 * Event emitted during pipeline execution.
 */
export type SequentialEvent = {
    type: 'PIPELINE_STARTED';
    pipelineId: string;
    runId: string;
    projectId: string;
} | {
    type: 'STEP_STARTED';
    pipelineId: string;
    runId: string;
    stepId: string;
    stepIndex: number;
} | {
    type: 'STEP_COMPLETED';
    pipelineId: string;
    runId: string;
    stepId: string;
    result: SequentialStepResult;
} | {
    type: 'STEP_FAILED';
    pipelineId: string;
    runId: string;
    stepId: string;
    error: string;
} | {
    type: 'PIPELINE_COMPLETED';
    pipelineId: string;
    runId: string;
    results: SequentialStepResult[];
} | {
    type: 'PIPELINE_FAILED';
    pipelineId: string;
    runId: string;
    error: string;
} | {
    type: 'PIPELINE_CANCELLED';
    pipelineId: string;
    runId: string;
    reason: string;
};
/**
 * Callback for handling events during execution.
 */
export type SequentialEventHandler = (event: SequentialEvent) => void | Promise<void>;
/**
 * Builder for creating sequential pipelines.
 */
export declare class SequentialPipelineBuilder<TInput = unknown, TOutput = unknown> {
    private pipeline;
    private constructor();
    static create<TInput = unknown, TOutput = unknown>(id: string, name: string, projectId: string): SequentialPipelineBuilder<TInput, TOutput>;
    withDescription(description: string): this;
    withInitialInput(input: TInput): this;
    withStopOnError(stop: boolean): this;
    withGlobalTimeout(ms: number): this;
    addStep(step: Omit<SequentialStep<TInput, TOutput>, 'id'>): this;
    build(): SequentialPipeline<TInput, TOutput>;
}
/**
 * Metrics for an orchestration run.
 */
export interface OrchestrationMetrics {
    pipelineId: string;
    runId: string;
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    totalDurationMs: number;
    averageStepDurationMs: number;
    totalTokenUsage: TokenUsage;
    /** Steps that took longer than average */
    slowSteps: Array<{
        stepId: string;
        durationMs: number;
    }>;
    /** Steps that failed and were retried */
    retriedSteps: Array<{
        stepId: string;
        retryCount: number;
    }>;
}
/**
 * Calculate metrics from a completed pipeline run.
 */
export declare function calculateOrchestrationMetrics(run: SequentialPipelineRun): OrchestrationMetrics;
//# sourceMappingURL=orchestration.d.ts.map