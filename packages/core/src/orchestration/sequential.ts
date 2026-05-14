/**
 * Sequential Orchestration Pattern Implementation
 * 
 * Based on research findings from Microsoft AI Agent Orchestration Patterns:
 * - Linear pipeline where each agent processes previous output
 * - Deterministic, predefined order
 * - Best for: Progressive refinement with clear step dependencies
 * 
 * Reference: research-notes.md - Multi-Agent Orchestration Patterns (2026-04-09)
 */

import type { CommanderAgentCard, CommanderRunContextV2 } from '../index';
import type { MultiAgentStrategy, TaskComplexity } from '../index';
import { measureTaskComplexity, shouldDecompose } from '../index';

/**
 * Represents a single step in a sequential pipeline.
 */
export interface SequentialStep {
  /** Unique step identifier */
  id: string;
  
  /** Human-readable step name */
  name: string;
  
  /** Agent responsible for this step */
  agentId: string;
  
  /** Step description/objective */
  objective: string;
  
  /** Expected input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
  
  /** Expected output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;
  
  /** Maximum time allowed for this step (ms) */
  timeout?: number;
  
  /** Number of retry attempts on failure */
  maxRetries?: number;
  
  /** Whether step can be skipped if previous step failed */
  skippable?: boolean;
  
  /** Step-specific validation function */
  validator?: (output: unknown) => ValidationResult;
}

/**
 * Result of a single step execution.
 */
export interface SequentialStepResult {
  stepId: string;
  agentId: string;
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'TIMEOUT';
  output?: unknown;
  error?: string;
  duration: number; // ms
  timestamp: string;
}

/**
 * Validation result for step output.
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Context passed through the sequential pipeline.
 */
export interface SequentialContext {
  /** Pipeline execution ID */
  executionId: string;
  
  /** Project context */
  projectId: string;
  
  /** Initial input to the pipeline */
  initialInput: unknown;
  
  /** Results from previous steps */
  previousResults: SequentialStepResult[];
  
  /** Current step index */
  currentStepIndex: number;
  
  /** Pipeline metadata */
  metadata: Record<string, unknown>;
  
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Status of a sequential pipeline execution.
 */
export type SequentialPipelineStatus = 
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PAUSED';

/**
 * Complete pipeline definition.
 */
export interface SequentialPipeline {
  /** Unique pipeline identifier */
  id: string;
  
  /** Human-readable pipeline name */
  name: string;
  
  /** Pipeline description */
  description?: string;
  
  /** Ordered list of steps */
  steps: SequentialStep[];
  
  /** Pipeline-level timeout (ms) */
  timeout?: number;
  
  /** Whether to stop on first failure */
  failFast?: boolean;
  
  /** Maximum parallel retries across pipeline */
  maxParallelRetries?: number;
  
  /** Checkpoint interval (number of steps between checkpoints) */
  checkpointInterval?: number;
}

/**
 * Result of a complete pipeline execution.
 */
export interface SequentialPipelineRun {
  pipelineId: string;
  executionId: string;
  status: SequentialPipelineStatus;
  startTime: string;
  endTime?: string;
  stepResults: SequentialStepResult[];
  finalOutput?: unknown;
  error?: string;
  metrics: OrchestrationMetrics;
}

/**
 * Metrics for orchestration performance.
 */
export interface OrchestrationMetrics {
  /** Total execution time (ms) */
  totalDuration: number;
  
  /** Sum of all step durations */
  stepDurationSum: number;
  
  /** Overhead time (coordination, validation, etc.) */
  overheadDuration: number;
  
  /** Number of successful steps */
  successCount: number;
  
  /** Number of failed steps */
  failureCount: number;
  
  /** Number of skipped steps */
  skippedCount: number;
  
  /** Number of timeout steps */
  timeoutCount: number;
  
  /** Total retry attempts */
  retryCount: number;
  
  /** Token usage across all steps */
  tokenUsage: TokenUsage;
  
  /** Average step duration */
  averageStepDuration: number;
  
  /** Step duration variance */
  stepDurationVariance: number;
}

/**
 * Token usage tracking.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost?: number;
}

/**
 * Event handler for pipeline lifecycle events.
 */
export interface SequentialEventHandler {
  onPipelineStart?: (pipeline: SequentialPipeline, context: SequentialContext) => void | Promise<void>;
  onStepStart?: (step: SequentialStep, context: SequentialContext) => void | Promise<void>;
  onStepComplete?: (step: SequentialStep, result: SequentialStepResult, context: SequentialContext) => void | Promise<void>;
  onPipelineComplete?: (run: SequentialPipelineRun) => void | Promise<void>;
  onPipelineError?: (error: Error, context: SequentialContext) => void | Promise<void>;
}

/**
 * Builder for creating sequential pipelines.
 */
export class SequentialPipelineBuilder {
  private pipeline: SequentialPipeline;
  private steps: SequentialStep[] = [];
  
  constructor(id: string, name: string) {
    this.pipeline = {
      id,
      name,
      steps: [],
      failFast: true,
    };
  }
  
  /**
   * Add a step to the pipeline.
   */
  addStep(step: Omit<SequentialStep, 'id'>): this {
    const stepId = `${this.pipeline.id}-step-${this.steps.length + 1}`;
    this.steps.push({
      ...step,
      id: stepId,
    });
    return this;
  }
  
  /**
   * Set pipeline description.
   */
  setDescription(description: string): this {
    this.pipeline.description = description;
    return this;
  }
  
  /**
   * Set pipeline timeout.
   */
  setTimeout(timeout: number): this {
    this.pipeline.timeout = timeout;
    return this;
  }
  
  /**
   * Set fail-fast behavior.
   */
  setFailFast(failFast: boolean): this {
    this.pipeline.failFast = failFast;
    return this;
  }
  
  /**
   * Set checkpoint interval.
   */
  setCheckpointInterval(interval: number): this {
    this.pipeline.checkpointInterval = interval;
    return this;
  }
  
  /**
   * Build the final pipeline.
   */
  build(): SequentialPipeline {
    return {
      ...this.pipeline,
      steps: [...this.steps],
    };
  }
}

/**
 * Calculate orchestration metrics from step results.
 */
export function calculateOrchestrationMetrics(
  startTime: number,
  endTime: number,
  stepResults: SequentialStepResult[],
  tokenUsage: TokenUsage
): OrchestrationMetrics {
  const totalDuration = endTime - startTime;
  const stepDurationSum = stepResults.reduce((sum, r) => sum + r.duration, 0);
  const overheadDuration = totalDuration - stepDurationSum;
  
  const successCount = stepResults.filter(r => r.status === 'SUCCESS').length;
  const failureCount = stepResults.filter(r => r.status === 'FAILURE').length;
  const skippedCount = stepResults.filter(r => r.status === 'SKIPPED').length;
  const timeoutCount = stepResults.filter(r => r.status === 'TIMEOUT').length;
  
  const durations = stepResults.map(r => r.duration);
  const averageStepDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
  
  const stepDurationVariance = durations.length > 1
    ? durations.reduce((sum, d) => sum + Math.pow(d - averageStepDuration, 2), 0) / durations.length
    : 0;
  
  // Count retries (steps that appear multiple times)
  const seenSteps = new Set<string>();
  let retryCount = 0;
  for (const result of stepResults) {
    if (seenSteps.has(result.stepId)) {
      retryCount++;
    }
    seenSteps.add(result.stepId);
  }
  
  return {
    totalDuration,
    stepDurationSum,
    overheadDuration,
    successCount,
    failureCount,
    skippedCount,
    timeoutCount,
    retryCount,
    tokenUsage,
    averageStepDuration,
    stepDurationVariance,
  };
}

/**
 * Sequential Event type for event bus.
 */
export type SequentialEvent =
  | { type: 'PIPELINE_START'; pipelineId: string; executionId: string }
  | { type: 'STEP_START'; pipelineId: string; executionId: string; stepId: string }
  | { type: 'STEP_COMPLETE'; pipelineId: string; executionId: string; stepId: string; result: SequentialStepResult }
  | { type: 'PIPELINE_COMPLETE'; pipelineId: string; executionId: string; run: SequentialPipelineRun }
  | { type: 'PIPELINE_ERROR'; pipelineId: string; executionId: string; error: Error };

/**
 * Create a sequential pipeline from a strategy and context.
 * This is the main entry point for using sequential orchestration.
 */
export function createSequentialPipelineFromStrategy(
  strategy: MultiAgentStrategy,
  context: CommanderRunContextV2,
  taskComplexity?: TaskComplexity
): SequentialPipeline {
  const pipelineId = `seq-${context.projectId}-${Date.now()}`;
  const builder = new SequentialPipelineBuilder(
    pipelineId,
    `Sequential Pipeline for ${context.projectId}`
  );
  
  // Get agent roster
  const agents = context.agentRoster;
  
  // Primary agent as first step
  if (strategy.primaryAgentId) {
    const primaryAgent = agents.find(a => a.id === strategy.primaryAgentId);
    if (primaryAgent) {
      builder.addStep({
        name: `Primary Execution by ${primaryAgent.name}`,
        agentId: primaryAgent.id,
        objective: 'Execute primary task and produce initial output',
        timeout: taskComplexity && taskComplexity.level === 'CRITICAL' ? 300000 : 180000, // 5min for critical, 3min otherwise
        maxRetries: 2,
        skippable: false,
      });
    }
  }
  
  // Reviewer agents as subsequent steps (sequential review)
  if (strategy.reviewerAgentIds && strategy.reviewerAgentIds.length > 0) {
    for (const reviewerId of strategy.reviewerAgentIds) {
      const reviewer = agents.find(a => a.id === reviewerId);
      if (reviewer) {
        builder.addStep({
          name: `Review by ${reviewer.name}`,
          agentId: reviewer.id,
          objective: 'Review previous output and provide feedback',
          timeout: 120000, // 2min for review
          maxRetries: 1,
          skippable: true, // Reviews can be skipped if primary failed
          validator: (output: unknown) => {
            // Basic validation: reviewer must provide structured feedback
            if (typeof output === 'object' && output !== null) {
              return { valid: true };
            }
            return { valid: false, errors: ['Reviewer output must be an object'] };
          },
        });
      }
    }
  }
  
  // Set pipeline-level configuration
  builder
    .setFailFast(strategy.kind === 'MANUAL_APPROVAL_GATE') // Fail fast for manual approval
    .setCheckpointInterval(2) // Checkpoint every 2 steps
    .setTimeout(taskComplexity && taskComplexity.level === 'CRITICAL' ? 600000 : 300000); // 10min for critical, 5min otherwise
  
  return builder.build();
}

/**
 * Estimate if a task should use sequential orchestration.
 * Based on complexity metrics and strategy analysis.
 */
export function shouldUseSequentialOrchestration(
  strategy: MultiAgentStrategy,
  complexity: TaskComplexity
): boolean {
  // Sequential is best when:
  // 1. Strategy involves multiple agents in sequence
  if (strategy.kind === 'GUARDED_EXECUTION' || strategy.kind === 'SENATE_REVIEW') {
    return true;
  }
  
  // 2. Complexity is HIGH (but not CRITICAL, which might need parallel)
  if (complexity.level === 'HIGH' || complexity.level === 'MEDIUM') {
    return true;
  }
  
  // 3. Task has clear step dependencies
  if (complexity.dependencyDepth >= 2) {
    return true;
  }
  
  return false;
}
