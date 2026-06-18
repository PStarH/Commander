/**
 * Sequential Pipeline Executor
 *
 * Implements the execution engine for sequential orchestration pattern.
 * Based on Microsoft AI Agent Orchestration Patterns - Sequential Pattern.
 *
 * Reference: research-notes.md - Multi-Agent Orchestration Patterns (2026-04-09)
 */

import type {
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialStep,
  SequentialStepResult,
  SequentialContext,
  SequentialEvent,
  SequentialEventHandler,
  TokenUsage,
  OrchestrationMetrics,
} from './sequential';
import { getGlobalLogger } from '../logging';

/**
 * Agent execution interface.
 * This should be implemented by the Commander agent system.
 */
export interface AgentExecutor {
  /**
   * Execute a task with an agent.
   * @param agentId - Agent to execute
   * @param input - Input for the agent
   * @param context - Execution context
   * @returns Agent output
   */
  execute(
    agentId: string,
    input: unknown,
    context: SequentialContext,
  ): Promise<{
    output: unknown;
    tokenUsage: TokenUsage;
  }>;
}

/**
 * Configuration for the sequential executor.
 */
export interface SequentialExecutorConfig {
  /** Default timeout for each step (ms) */
  defaultStepTimeout?: number;
  /** Default max retries for each step */
  defaultMaxRetries?: number;
  /** Whether to emit events */
  emitEvents?: boolean;
  /** Event handler */
  eventHandler?: SequentialEventHandler;
  /** Checkpoint callback - called after each step if provided */
  checkpointCallback?: (run: SequentialPipelineRun) => Promise<void>;
}

/**
 * Internal state for tracking execution.
 */
interface ExecutionState {
  run: SequentialPipelineRun;
  abortController: AbortController;
  currentStepIndex: number;
  stepResults: Map<string, SequentialStepResult>;
}

/**
 * Sequential Pipeline Executor
 *
 * Executes sequential pipelines with support for:
 * - Step-by-step execution with retry logic
 * - Timeout handling
 * - Checkpointing
 * - Event emission
 * - Error recovery
 */
export class SequentialPipelineExecutor {
  private config: {
    defaultStepTimeout: number;
    defaultMaxRetries: number;
    emitEvents: boolean;
    eventHandler: SequentialEventHandler;
    checkpointCallback: (run: SequentialPipelineRun) => Promise<void>;
  };
  private agentExecutor: AgentExecutor;
  // GAP-25: Track active abort controllers per execution for proper cancellation
  private activeAbortControllers: Map<string, AbortController> = new Map();

  constructor(agentExecutor: AgentExecutor, config?: SequentialExecutorConfig) {
    this.agentExecutor = agentExecutor;
    this.config = {
      defaultStepTimeout: config?.defaultStepTimeout ?? 180000, // 3 minutes
      defaultMaxRetries: config?.defaultMaxRetries ?? 2,
      emitEvents: config?.emitEvents ?? true,
      eventHandler: config?.eventHandler ?? {},
      checkpointCallback: config?.checkpointCallback ?? (async () => {}),
    };
  }

  /**
   * Execute a sequential pipeline.
   */
  async execute(
    pipeline: SequentialPipeline,
    initialInput?: unknown,
  ): Promise<SequentialPipelineRun> {
    const runId = `${pipeline.id}-run-${Date.now()}`;
    const abortController = new AbortController();
    // GAP-25: Register abort controller so cancel() can abort in-flight steps
    this.activeAbortControllers.set(runId, abortController);

    // Initialize context (matching sequential.ts SequentialContext)
    const context: SequentialContext = {
      executionId: runId,
      projectId: pipeline.projectId || 'default-project',
      initialInput: initialInput,
      previousResults: [],
      currentStepIndex: 0,
      metadata: {},
    };

    // Initialize run (matching sequential.ts SequentialPipelineRun)
    const run: SequentialPipelineRun = {
      pipelineId: pipeline.id,
      executionId: runId,
      status: 'RUNNING',
      startTime: new Date().toISOString(),
      stepResults: [],
      metrics: {
        totalDuration: 0,
        stepDurationSum: 0,
        overheadDuration: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        timeoutCount: 0,
        retryCount: 0,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        averageStepDuration: 0,
        stepDurationVariance: 0,
      },
    };

    // State tracking
    const state: ExecutionState = {
      run,
      abortController,
      currentStepIndex: 0,
      stepResults: new Map(),
    };

    try {
      // Emit start event (using PIPELINE_START, not PIPELINE_STARTED)
      await this.emitEvent({
        type: 'PIPELINE_START',
        pipelineId: pipeline.id,
        executionId: runId,
      });

      // Execute steps sequentially
      let currentInput = initialInput ?? pipeline.initialInput;

      for (let i = 0; i < pipeline.steps.length; i++) {
        if (abortController.signal.aborted) {
          run.status = 'CANCELLED';
          run.error = 'Pipeline execution was cancelled';
          break;
        }

        const step = pipeline.steps[i];
        state.currentStepIndex = i;
        context.currentStepIndex = i;

        // Execute step with retries
        const result = await this.executeStep(step, currentInput, context, state, i);

        run.stepResults.push(result);
        context.previousResults.push(result);

        // Handle step result
        if (result.status === 'SUCCESS') {
          currentInput = result.output;
        } else if (result.status === 'FAILURE') {
          if (pipeline.stopOnError !== false) {
            run.status = 'FAILED';
            run.error = result.error;
            await this.emitEvent({
              type: 'PIPELINE_ERROR',
              pipelineId: pipeline.id,
              executionId: runId,
              error: new Error(result.error || 'Step failed'),
            });
            break;
          }
          // Continue on error if configured
        } else if (result.status === 'SKIPPED') {
          // Skip step, keep previous output
        }

        // Checkpoint after each step
        await this.config.checkpointCallback(run);
      }

      // Mark as completed if all steps succeeded
      if (run.status === 'RUNNING') {
        run.status = 'COMPLETED';
        run.completedAt = new Date().toISOString();
        await this.emitEvent({
          type: 'PIPELINE_COMPLETE',
          pipelineId: pipeline.id,
          executionId: runId,
          run,
        });
      }

      return run;
    } catch (error) {
      run.status = 'FAILED';
      run.error = error instanceof Error ? error.message : 'Unknown error';
      run.completedAt = new Date().toISOString();

      await this.emitEvent({
        type: 'PIPELINE_ERROR',
        pipelineId: pipeline.id,
        executionId: runId,
        error: error instanceof Error ? error : new Error('Unknown error'),
      });

      return run;
    } finally {
      // GAP-25: Always clean up the abort controller
      this.activeAbortControllers.delete(runId);
    }
  }

  /**
   * Execute a single step with retry logic.
   */
  private async executeStep(
    step: SequentialPipeline['steps'][0],
    input: unknown,
    context: SequentialContext,
    state: ExecutionState,
    stepIndex: number,
  ): Promise<SequentialStepResult> {
    const maxRetries = step.maxRetries ?? this.config.defaultMaxRetries;
    const timeoutMs = step.timeout ?? this.config.defaultStepTimeout;

    const stepId = step.id;
    const result: SequentialStepResult = {
      stepId,
      agentId: step.agentId,
      status: 'SUCCESS',
      duration: 0,
      timestamp: new Date().toISOString(),
    };

    // Emit step start event (using STEP_START)
    await this.emitEvent({
      type: 'STEP_START',
      pipelineId: state.run.pipelineId,
      executionId: state.run.executionId,
      stepId,
    });

    const startTime = Date.now();

    // Retry loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Execute with timeout
        const executionPromise = this.agentExecutor.execute(step.agentId, input, context);

        let timeoutTimer: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new Error(`Step timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutTimer.unref();
        });

        const { output, tokenUsage } = await Promise.race([
          executionPromise.finally(() => clearTimeout(timeoutTimer)),
          timeoutPromise,
        ]);

        // Success
        const endTime = Date.now();
        result.status = 'SUCCESS';
        result.output = output;
        result.duration = endTime - startTime;
        result.timestamp = new Date().toISOString();

        await this.emitEvent({
          type: 'STEP_COMPLETE',
          pipelineId: state.run.pipelineId,
          executionId: state.run.executionId,
          stepId,
          result,
        });

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (attempt < maxRetries) {
          // Retry
          getGlobalLogger().warn(
            'SequentialPipelineExecutor',
            `Step ${stepId} failed (attempt ${attempt + 1}/${maxRetries})`,
            { error: errorMessage },
          );
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => {
            const t = setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000));
            t.unref();
          });
        } else {
          // Final failure
          const endTime = Date.now();
          result.status = 'FAILURE';
          result.error = errorMessage;
          result.duration = endTime - startTime;
          result.timestamp = new Date().toISOString();

          await this.emitEvent({
            type: 'STEP_COMPLETE',
            pipelineId: state.run.pipelineId,
            executionId: state.run.executionId,
            stepId,
            result,
          });

          return result;
        }
      }
    }

    return result;
  }

  /**
   * Emit an event if events are enabled.
   */
  private async emitEvent(event: SequentialEvent): Promise<void> {
    if (this.config.emitEvents) {
      try {
        const handler = this.config.eventHandler;
        switch (event.type) {
          case 'PIPELINE_START':
            await handler.onPipelineStart?.(
              { id: event.pipelineId, name: '', steps: [] } as SequentialPipeline,
              {} as SequentialContext,
            );
            break;
          case 'STEP_START':
            await handler.onStepStart?.(
              { id: event.stepId || '', name: '', agentId: '' } as SequentialStep,
              {} as SequentialContext,
            );
            break;
          case 'STEP_COMPLETE':
            await handler.onStepComplete?.(
              { id: event.stepId || '', name: '', agentId: '' } as SequentialStep,
              event.result as SequentialStepResult,
              {} as SequentialContext,
            );
            break;
          case 'PIPELINE_COMPLETE':
            await handler.onPipelineComplete?.(event.run as SequentialPipelineRun);
            break;
          case 'PIPELINE_ERROR':
            await handler.onPipelineError?.(event.error as Error, {} as SequentialContext);
            break;
        }
      } catch (error) {
        getGlobalLogger().error(
          'SequentialPipelineExecutor',
          'Event handler error',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /**
   * Cancel a running pipeline.
   * GAP-25: Now actually aborts the in-flight step via AbortController.
   */
  cancel(run: SequentialPipelineRun): void {
    if (run.status === 'RUNNING') {
      run.status = 'CANCELLED';
      run.completedAt = new Date().toISOString();
      run.error = 'Cancelled by user';
      // Abort any in-flight step execution
      this.activeAbortControllers.get(run.executionId)?.abort();
      this.activeAbortControllers.delete(run.executionId);
    }
  }
}

/**
 * In-memory agent executor for testing.
 * In production, this should be replaced with actual Commander agent integration.
 */
export class InMemoryAgentExecutor implements AgentExecutor {
  async execute(
    agentId: string,
    input: unknown,
    context: SequentialContext,
  ): Promise<{ output: unknown; tokenUsage: TokenUsage }> {
    // Simulate agent execution
    getGlobalLogger().info(
      'InMemoryAgentExecutor',
      `Executing agent ${agentId} for step ${context.currentStepIndex}`,
    );

    // Return mock output
    return {
      output: {
        agentId,
        input,
        result: `Output from step ${context.currentStepIndex}`,
        timestamp: new Date().toISOString(),
      },
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    };
  }
}

/**
 * Create a sequential pipeline executor with default configuration.
 */
export function createSequentialExecutor(
  agentExecutor?: AgentExecutor,
): SequentialPipelineExecutor {
  const executor = agentExecutor ?? new InMemoryAgentExecutor();
  return new SequentialPipelineExecutor(executor, {
    defaultStepTimeout: 180000, // 3 minutes
    defaultMaxRetries: 2,
    emitEvents: true,
  });
}
