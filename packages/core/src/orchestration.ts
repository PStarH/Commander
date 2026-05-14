/**
 * Orchestration Types for Commander Multi-Agent System
 * 
 * Based on Microsoft AI Agent Orchestration Patterns:
 * https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
 */

// ========================================
// Sequential Orchestration Pattern (P0)
// ========================================

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
export type SequentialPipelineStatus = 
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

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
export type SequentialEvent = 
  | { type: 'PIPELINE_STARTED'; pipelineId: string; runId: string; projectId: string }
  | { type: 'STEP_STARTED'; pipelineId: string; runId: string; stepId: string; stepIndex: number }
  | { type: 'STEP_COMPLETED'; pipelineId: string; runId: string; stepId: string; result: SequentialStepResult }
  | { type: 'STEP_FAILED'; pipelineId: string; runId: string; stepId: string; error: string }
  | { type: 'PIPELINE_COMPLETED'; pipelineId: string; runId: string; results: SequentialStepResult[] }
  | { type: 'PIPELINE_FAILED'; pipelineId: string; runId: string; error: string }
  | { type: 'PIPELINE_CANCELLED'; pipelineId: string; runId: string; reason: string };

/**
 * Callback for handling events during execution.
 */
export type SequentialEventHandler = (event: SequentialEvent) => void | Promise<void>;

// ========================================
// Pipeline Builder Helper
// ========================================

/**
 * Builder for creating sequential pipelines.
 */
export class SequentialPipelineBuilder<TInput = unknown, TOutput = unknown> {
  private pipeline: Omit<SequentialPipeline<TInput, TOutput>, 'createdAt' | 'updatedAt'>;

  private constructor(
    id: string,
    name: string,
    projectId: string
  ) {
    this.pipeline = {
      id,
      name,
      projectId,
      steps: [],
      stopOnError: true,
    };
  }

  static create<TInput = unknown, TOutput = unknown>(
    id: string,
    name: string,
    projectId: string
  ): SequentialPipelineBuilder<TInput, TOutput> {
    return new SequentialPipelineBuilder<TInput, TOutput>(id, name, projectId);
  }

  withDescription(description: string): this {
    this.pipeline.description = description;
    return this;
  }

  withInitialInput(input: TInput): this {
    this.pipeline.initialInput = input;
    return this;
  }

  withStopOnError(stop: boolean): this {
    this.pipeline.stopOnError = stop;
    return this;
  }

  withGlobalTimeout(ms: number): this {
    this.pipeline.globalTimeoutMs = ms;
    return this;
  }

  addStep(
    step: Omit<SequentialStep<TInput, TOutput>, 'id'>
  ): this {
    this.pipeline.steps.push({
      ...step,
      id: `${this.pipeline.id}-step-${this.pipeline.steps.length + 1}`,
    });
    return this;
  }

  build(): SequentialPipeline<TInput, TOutput> {
    const now = new Date().toISOString();
    return {
      ...this.pipeline,
      createdAt: now,
      updatedAt: now,
    } as SequentialPipeline<TInput, TOutput>;
  }
}

// ========================================
// Orchestration Metrics
// ========================================

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
  slowSteps: Array<{ stepId: string; durationMs: number }>;
  /** Steps that failed and were retried */
  retriedSteps: Array<{ stepId: string; retryCount: number }>;
}

/**
 * Calculate metrics from a completed pipeline run.
 */
export function calculateOrchestrationMetrics(
  run: SequentialPipelineRun
): OrchestrationMetrics {
  const completedSteps = run.results.filter(r => r.status === 'SUCCESS').length;
  const failedSteps = run.results.filter(r => r.status === 'FAILED').length;
  const skippedSteps = run.results.filter(r => r.status === 'SKIPPED').length;

  const stepDurations = run.results
    .filter(r => r.startedAt && r.completedAt)
    .map(r => ({
      stepId: r.stepId,
      durationMs: new Date(r.completedAt!).getTime() - new Date(r.startedAt!).getTime(),
    }));

  const totalDurationMs = run.completedAt
    ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
    : 0;

  const averageStepDurationMs = stepDurations.length > 0
    ? stepDurations.reduce((sum, d) => sum + d.durationMs, 0) / stepDurations.length
    : 0;

  const slowThreshold = averageStepDurationMs * 1.5;
  const slowSteps = stepDurations.filter(d => d.durationMs > slowThreshold);

  const retriedSteps = run.results
    .filter(r => r.retryCount && r.retryCount > 0)
    .map(r => ({ stepId: r.stepId, retryCount: r.retryCount! }));

  const totalTokenUsage = run.results.reduce<TokenUsage>(
    (acc, r) => {
      if (!r.tokenUsage) return acc;
      return {
        promptTokens: acc.promptTokens + r.tokenUsage.promptTokens,
        completionTokens: acc.completionTokens + r.tokenUsage.completionTokens,
        totalTokens: acc.totalTokens + r.tokenUsage.totalTokens,
      };
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );

  return {
    pipelineId: run.pipelineId,
    runId: run.id,
    totalSteps: run.results.length,
    completedSteps,
    failedSteps,
    skippedSteps,
    totalDurationMs,
    averageStepDurationMs,
    totalTokenUsage,
    slowSteps,
    retriedSteps,
  };
}
