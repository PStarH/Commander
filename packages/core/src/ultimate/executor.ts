/**
 * Sequential Pipeline Executor
 *
 * Implements the execution engine for sequential orchestration pattern.
 * Based on Microsoft AI Agent Orchestration Patterns - Sequential Pattern.
 *
 * Reference: research-notes.md - Multi-Agent Orchestration Patterns (2026-04-09)
 *
 * Day 2 wire-through: each step boundary also commits a
 * `reliabilityEngine.checkpointAtomically(...)` row to the ATR WAL backend
 * so that a SIGKILL at any point leaves at most one step to re-execute.
 * Existing `checkpointCallback` is preserved for backward compatibility.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type {
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialStep,
  SequentialStepResult,
  SequentialContext,
  SequentialEvent,
  SequentialEventHandler,
  TokenUsage,
} from './sequential';
import { getGlobalLogger } from '../logging';
import type { ReliabilityEngine } from '../runtime/reliabilityEngine';
import {
  toSequentialCheckpoint,
  safeCheckpointAtomically,
  tryResumeFromATR,
  type ResumePoint,
} from './checkpointAdapters';
import { classifyLLMError, computeBackoff, type ClassifiedError } from '../runtime/llmRetry';
import type { CircuitBreakerRegistry } from '../runtime/circuitBreakerRegistry';
import { getAuditChainLedger } from '../security/auditChainLedger';

/**
 * Audit #1/#3 hardening — response on the maximum server-prescribed
 * `Retry-After` value we accept. A misconfigured upstream could emit an
 * absurd value (e.g., 1 week); we abort the step rather than block the
 * pipeline that long. Tuned for StepFun / OpenAI / Anthropic observed
 * ceilings (max reported so far: 60s); 5min gives headroom + a clean
 * deterministic abort.
 */
const MAX_RETRY_AFTER_MS = 300_000;
/**
 * Soft-cap applied to `computeBackoff` exponential growth. Default matches
 * `llmRetry.computeBackoff`'s internal default so the wire-through is
 * identity-by-default and only diverges when operators tighten it.
 */
const BACKOFF_MAX_MS = 30_000;

/**
 * Audit #4 hardening — Resolve the effective token-budget cap for a
 * pipeline. Precedence: explicit `pipeline.tokenBudget` > per-pipeline
 * env override > global `COMMANDER_SEQUENTIAL_TOKEN_BUDGET` > none.
 * Non-finite / non-positive values are ignored (caller passes undefined).
 */
function defaultResolveBudget(pipeline: SequentialPipeline): number | undefined {
  if (typeof pipeline.tokenBudget === 'number' && pipeline.tokenBudget > 0) {
    return pipeline.tokenBudget;
  }
  if (pipeline.envTokenBudgetKey) {
    const v = Number(process.env[pipeline.envTokenBudgetKey]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const global = Number(process.env.COMMANDER_SEQUENTIAL_TOKEN_BUDGET);
  if (Number.isFinite(global) && global > 0) return global;
  return undefined;
}

/**
 * Compute the (provider, model) breaker key for a step. Falls back to a
 * stable sentinel so absence-of-metadata still aggregates into a NAMED
 * breaker (not a fresh one per call — that defeats the Hystrix volume +
 * error-rate thresholds by making every call a CLOSED trip). The
 * `default-model` sentinel lives alongside `default` provider so
 * un-keyed legacy pipelines share fault isolation without polluting
 * the keyed breakers.
 */
function breakerKeyFor(step: SequentialStep): string {
  const provider = step.metadata?.provider ?? 'default';
  const model = step.metadata?.model ?? 'default-model';
  return `${provider}|${model}`;
}

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
  /**
   * Day 2 wire-through: optional ATR-backed ReliabilityEngine. When set,
   * every step boundary commits a `sequential-step` row to WAL before
   * the next step starts. Callers can still wire `checkpointCallback`
   * for observers; the two paths are independent.
   */
  reliabilityEngine?: ReliabilityEngine;
  /**
   * Day 2 wire-through: optional explicit runId for checkpoint rows.
   * Defaults to `executionId` if not provided. Pass this when resuming
   * an existing run so checkpoints land on the same `runId` row.
   */
  runId?: string;
  /**
   * Audit #1 hardening — optional circuit-breaker registry. When set,
   * each step is keyed to `(metadata.provider, metadata.model)` (or
   * `agentId` fallback) so a degraded provider cannot lock other
   * providers out. Pre-flight checks `isAvailable()`; transient failures
   * call `onFailure()`; successes call `onSuccess()`.
   */
  breakerRegistry?: CircuitBreakerRegistry;
  /**
   * Audit #4 hardening — optional token-budget resolver. Invoked once per
   * pipeline with the pipeline config; returns the effective per-run cap
   * (in tokens) or `undefined` to skip enforcement. The default
   * implementation falls back to:
   *   1. `pipeline.tokenBudget` if set and > 0
   *   2. env-var `pipeline.envTokenBudgetKey` if defined
   *   3. global env `COMMANDER_SEQUENTIAL_TOKEN_BUDGET` if set
   *   4. `undefined` (no cap enforced)
   */
  resolveBudget?: (pipeline: SequentialPipeline) => number | undefined;
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
    reliabilityEngine?: ReliabilityEngine;
    runId?: string;
    breakerRegistry?: CircuitBreakerRegistry;
    resolveBudget?: (pipeline: SequentialPipeline) => number | undefined;
  };
  private agentExecutor: AgentExecutor;
  // GAP-25: Track active abort controllers per execution for proper cancellation
  private activeAbortControllers: Map<string, AbortController> = new Map();
  /**
   * Day 2 fix (reviewer finding §d): high-water mark for stepNumber committed
   * via safeCheckpointAtomically. Decouples terminal stepNumber from
   * `run.stepResults.length` so a legacy `checkpointCallback` mutation cannot
   * inflate the count and break the monotonic stepNumber contract that the
   * kill9 SIGKILL test relies on.
   */
  private lastCommittedStepNumber = 0;
  /**
   * Day 4 ABI: latest ResumePoint consumed by `resumePointedAt`. Cleared
   * before each `execute()` call so a re-executed pipeline cannot silently
   * re-apply a previous session's payload.
   */
  private resumeIngest?: ResumePoint;

  /**
   * Day 4 ABI: consult the WAL for `runId` and ingest the durable
   * execution state into this executor. Returns `true` when the WAL
   * contains a `sequential-step` row that can be re-applied.
   *
   *   - not-found: fresh start, execute() emits a seed at stepNumber=0
   *   - seed:      re-use the existing runId partition; skip the start
   *                seed; payload doesn't carry enough for true replay
   *                (output fields are stripped) so we acknowledge the
   *                gap and continue with a partially-rehydrated state
   *   - resume:    re-hydrate `lastCommittedStepNumber` from
   *                `payload.stepResults.length` and pre-populate
   *                `run.stepResults`; the for-loop below will re-run
   *                those steps unless the caller passes a pipeline
   *                whose `steps` already skip the recovered frontier;
   *                callers wanting strict O(Nᴿ) replay should pair
   *                this with a pipeline-decision of their own.
   *
   * Documented limitation: `stripSequentialStepResult` drops the per-step
   * `output` field, so the resumption frontier has known gaps in the
   * input/output chain. Day 4 tests cover the skip-start-seed invariant
   * only — full output replay is a Day 5+ topic.
   */
  resumePointedAt(runId: string): boolean {
    if (!this.config.reliabilityEngine) return false;
    const point = tryResumeFromATR(this.config.reliabilityEngine, runId, {
      phase: 'sequential-step',
    });
    if (point.kind === 'not-found') {
      this.resumeIngest = undefined;
      return false;
    }
    this.resumeIngest = point;
    return true;
  }

  /** Day 4 ABI: read-only inspection of the last ingest result. */
  getResumePoint(): ResumePoint | undefined {
    return this.resumeIngest;
  }

  constructor(agentExecutor: AgentExecutor, config?: SequentialExecutorConfig) {
    this.agentExecutor = agentExecutor;
    this.config = {
      defaultStepTimeout: config?.defaultStepTimeout ?? 180000, // 3 minutes
      defaultMaxRetries: config?.defaultMaxRetries ?? 2,
      emitEvents: config?.emitEvents ?? true,
      eventHandler: config?.eventHandler ?? {},
      checkpointCallback: config?.checkpointCallback ?? (async () => {}),
      reliabilityEngine: config?.reliabilityEngine,
      runId: config?.runId,
      breakerRegistry: config?.breakerRegistry,
      resolveBudget: config?.resolveBudget ?? defaultResolveBudget,
    };
  }

  /**
   * Execute a sequential pipeline.
   */
  async execute(
    pipeline: SequentialPipeline,
    initialInput?: unknown,
  ): Promise<SequentialPipelineRun> {
    // Day 4 ABI: capture and clear the resume ingest before any work.
    const ingest = this.resumeIngest;
    this.resumeIngest = undefined;
    const isResume = ingest?.kind === 'resume';
    const isSeed = ingest?.kind === 'seed';

    const runId = this.config.runId ?? `${pipeline.id}-run-${Date.now()}`;
    // Day 2 fix (reviewer finding §b round-up): reset the stepNumber
    // high-water mark right next to runId so an early-return path (e.g.
    // pipeline validation failure) cannot leave it stale from a previous
    // execute() call. Day 4 ABI: when resuming, override with the
    // rehydrated count so the next `++this.lastCommittedStepNumber`
    // advances past the durable frontier instead of restarting at 0.
    this.lastCommittedStepNumber = 0;
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

    // Day 4 ABI: rehydrate run.stepResults + lastCommittedStepNumber when
    // resuming. We deliberately do NOT pre-fill run.metrics — the metrics
    // were captured for the *prior* run shape and would invalidate the
    // current run's tallies if merged. The next per-step checkpoint below
    // emits a fresh snapshot reflecting the resumed frontier.
    if (isResume && ingest.kind === 'resume') {
      const priorStepResults = (ingest.payload.stepResults as SequentialStepResult[]) ?? [];
      run.stepResults = [...priorStepResults];
      this.lastCommittedStepNumber = priorStepResults.length;
    }

    try {
      // Emit start event (using PIPELINE_START, not PIPELINE_STARTED)
      await this.emitEvent({
        type: 'PIPELINE_START',
        pipelineId: pipeline.id,
        executionId: runId,
      });

      if (!isResume && !isSeed) {
        // Day 2: emit a `sequential-step` checkpoint at stepNumber=0. The
        // high-water mark was reset at the top of execute() alongside
        // runId — see reviewer finding §b. Subsequent per-step checkpoints
        // below advance lastCommittedStepNumber to 1, 2, 3, ... ,
        // independently of any external `checkpointCallback` mutation
        // of run.stepResults.
        safeCheckpointAtomically(
          this.config.reliabilityEngine,
          toSequentialCheckpoint(runId, this.lastCommittedStepNumber, run),
        );
      }
      // Resume branches: SKIP the start seed. The prior row at
      // stepNumber=0 is intact in WAL and satisfies the kill9 "≥1 row at
      // all times" contract; the next per-step checkpoint will land at
      // stepNumber = lastCommittedStepNumber + 1 (already set above for
      // 'resume', or 0 + 1 = 1 for 'seed').

      // Execute steps sequentially
      let currentInput = initialInput ?? pipeline.initialInput;

      // Audit #4 hardening — resolve a single effective token-budget cap.
      // Cached before the loop so a mid-run resolveBudget call cannot
      // silently raise the cap.
      const effectiveTokenBudget = this.config.resolveBudget
        ? this.config.resolveBudget(pipeline)
        : undefined;
      let accumulatedTokens = 0;
      let budgetExceeded = false;

      for (let i = 0; i < pipeline.steps.length; i++) {
        if (abortController.signal.aborted) {
          run.status = 'CANCELLED';
          run.error = 'Pipeline execution was cancelled';
          break;
        }

        const step = pipeline.steps[i];
        state.currentStepIndex = i;
        context.currentStepIndex = i;

        // Audit #4 hardening — once the soft-cap is tripped, stop launching
        // expensive new calls. The current step is allowed to complete to
        // preserve the agent's non-truncatable LLM response, but we surface
        // an explicit FAILURE rather than continuing to spend.
        if (budgetExceeded) {
          const failResult: SequentialStepResult = {
            stepId: step.id,
            agentId: step.agentId,
            status: 'FAILURE',
            duration: 0,
            timestamp: new Date().toISOString(),
            error:
              `Token budget (${effectiveTokenBudget}) already exceeded ` +
              `(accumulated=${accumulatedTokens}); skipping remaining steps`,
            errorClass: 'permanent',
            tokensUsed: 0,
          };
          run.stepResults.push(failResult);
          context.previousResults.push(failResult);
          run.status = 'FAILED';
          run.error = failResult.error ?? 'token budget exceeded';
          break;
        }

        // Execute step with retries
        const result = await this.executeStep(step, currentInput, context, state, i);

        run.stepResults.push(result);
        context.previousResults.push(result);

        // Audit #4 hardening — accumulate per-step tokens and check the
        // soft cap. The current step has already paid for its work; we
        // log + audit + trip semantic circuit so SUBSEQUENT steps (above)
        // short-circuit.
        if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) {
          accumulatedTokens += result.tokensUsed;
          run.metrics.tokenUsage.totalTokens += result.tokensUsed;
          if (
            effectiveTokenBudget !== undefined &&
            accumulatedTokens > effectiveTokenBudget &&
            !budgetExceeded
          ) {
            budgetExceeded = true;
            getGlobalLogger().warn(
              'SequentialPipelineExecutor',
              `Run ${runId} exceeded soft token budget ` +
                `(accumulated=${accumulatedTokens}, cap=${effectiveTokenBudget})`,
            );
            try {
              getAuditChainLedger().logEvent({
                type: 'token_budget_breach',
                severity: 'medium',
                source: 'SequentialPipelineExecutor',
                message: `Token budget breached (run=${runId})`,
                details: {
                  runId,
                  pipelineId: pipeline.id,
                  accumulated: accumulatedTokens,
                  cap: effectiveTokenBudget,
                  lastStepId: result.stepId,
                },
              });
            } catch (err) {
              reportSilentFailure(err, 'executor:456');
              /* best-effort */
            }
          }
        }

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

        // Day 2: checkpoint after each step boundary via ATR WAL.
        // stepNumber advances from a stateful field rather than recomputing
        // run.stepResults.length, decoupling the durable stepNumber from any
        // legacy checkpointCallback mutation of the run. Soft-fails inside
        // safeCheckpointAtomically.
        this.lastCommittedStepNumber++;
        safeCheckpointAtomically(
          this.config.reliabilityEngine,
          toSequentialCheckpoint(runId, this.lastCommittedStepNumber, run),
        );

        // Existing in-memory observer checkpoint callback (kept for back-compat).
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

        // Day 2: terminal checkpoint captures the COMPLETED state. stepNumber
        // = lastCommittedStepNumber + 1, disambiguated from the final per-step
        // checkpoint row.
        this.lastCommittedStepNumber++;
        safeCheckpointAtomically(
          this.config.reliabilityEngine,
          toSequentialCheckpoint(runId, this.lastCommittedStepNumber, run),
        );
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

      // Day 2: checkpoint the FAILED state on the way out so recovery
      // can resume from the exact failed frontier. stepNumber =
      // lastCommittedStepNumber + 1; safeCheckpointAtomically already
      // soft-fails on errors so an additional try/catch is unnecessary.
      this.lastCommittedStepNumber++;
      safeCheckpointAtomically(
        this.config.reliabilityEngine,
        toSequentialCheckpoint(runId, this.lastCommittedStepNumber, run),
      );

      return run;
    } finally {
      // GAP-25: Always clean up the abort controller
      this.activeAbortControllers.delete(runId);
    }
  }

  /**
   * Execute a single step with classified retry logic (Audit #1 hardening).
   *
   * The retry loop now uses `llmRetry.classifyLLMError` to differentiate
   * permanent failures (400/401/403/422) from transient ones (408/429/5xx
   * + network). Transient-with-Retry-After uses the server-prescribed
   * delay; otherwise exponential backoff with jitter via `computeBackoff`.
   *
   * `(provider, model)` circuit breaker pre-flight + post-failure hooks
   * prevent a degraded model from draining the budget.
   *
   * On permanent failure OR `step.maxRetries` exhaustion, returns FAILURE
   * with `errorClass` so AuditChain entries are classifiable downstream.
   */
  private async executeStep(
    step: SequentialPipeline['steps'][0],
    input: unknown,
    context: SequentialContext,
    state: ExecutionState,
    _stepIndex: number,
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

    // Audit #1 hardening — circuit-breaker pre-flight. A `provider|model`
    // key isolates one degraded model from harming other provider traffic.
    const breakerKey = breakerKeyFor(step);
    const breaker = this.config.breakerRegistry?.register(breakerKey, {
      threshold: 5,
      recoveryTimeMs: 30_000,
      halfOpenMaxTests: 1,
    });
    if (breaker && !breaker.isAvailable()) {
      const endTime = Date.now();
      result.status = 'FAILURE';
      result.error = `Circuit OPEN for ${breakerKey}; step short-circuited before invocation`;
      result.errorClass = 'transient';
      result.duration = endTime - Date.now();
      result.timestamp = new Date().toISOString();
      getGlobalLogger().warn(
        'SequentialPipelineExecutor',
        `Step ${stepId} blocked — circuit OPEN for ${breakerKey}`,
      );
      try {
        getAuditChainLedger().logEvent({
          type: 'circuit_breaker_short_circuit',
          severity: 'medium',
          source: 'SequentialPipelineExecutor',
          message: `Step ${stepId} short-circuited (circuit OPEN)`,
          details: { stepId, breakerKey, pipelineId: state.run.pipelineId },
        });
      } catch (err) {
        reportSilentFailure(err, 'executor:609');
        /* best-effort */
      }
      await this.emitEvent({
        type: 'STEP_COMPLETE',
        pipelineId: state.run.pipelineId,
        executionId: state.run.executionId,
        stepId,
        result,
      });
      return result;
    }

    // Emit step start event (using STEP_START)
    await this.emitEvent({
      type: 'STEP_START',
      pipelineId: state.run.pipelineId,
      executionId: state.run.executionId,
      stepId,
    });

    const startTime = Date.now();

    // Retry loop — classified-retry with circuit-breaker hooks
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

        // Success — record on the breaker so it can recover from HALF_OPEN
        breaker?.onSuccess();

        const endTime = Date.now();
        result.status = 'SUCCESS';
        result.output = output;
        result.tokensUsed = tokenUsage?.totalTokens;
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
        const classified: ClassifiedError = classifyLLMError(error);
        const errorMessage = classified.message;

        breaker?.onFailure();

        // Audit #1 hardening — permanent failures short-circuit ahead of
        // step.maxRetries. Retrying a 401/403 has zero upside and burns
        // budget / generates useless audit traffic.
        if (!classified.retryable) {
          const endTime = Date.now();
          result.status = 'FAILURE';
          result.error = errorMessage;
          result.errorClass = classified.errorClass;
          result.duration = endTime - startTime;
          result.timestamp = new Date().toISOString();

          getGlobalLogger().warn(
            'SequentialPipelineExecutor',
            `Step ${stepId} failed (non-retryable ${classified.statusCode ?? classified.errorClass})`,
            { error: errorMessage },
          );
          await this.emitEvent({
            type: 'STEP_COMPLETE',
            pipelineId: state.run.pipelineId,
            executionId: state.run.executionId,
            stepId,
            result,
          });
          return result;
        }

        if (attempt < maxRetries) {
          // Audit #1 hardening — Retry-After precedence. A server-prescribed
          // delay wins over computeBackoff, but a runaway value aborts the
          // step (caller is told immediately so they can re-route).
          let backoffMs = computeBackoff(attempt, 1000, BACKOFF_MAX_MS);
          if (classified.retryAfter !== undefined) {
            if (classified.retryAfter === 0) {
              backoffMs = 0;
            } else if (classified.retryAfter > MAX_RETRY_AFTER_MS) {
              const endTime = Date.now();
              result.status = 'FAILURE';
              result.error =
                `Provider Retry-After=${classified.retryAfter}ms exceeds ceiling ` +
                `(${MAX_RETRY_AFTER_MS}ms); aborting step rather than blocking pipeline`;
              result.errorClass = 'transient';
              result.duration = endTime - startTime;
              result.timestamp = new Date().toISOString();
              getGlobalLogger().warn(
                'SequentialPipelineExecutor',
                `Step ${stepId} aborted — Retry-After too large`,
                { retryAfterMs: classified.retryAfter },
              );
              await this.emitEvent({
                type: 'STEP_COMPLETE',
                pipelineId: state.run.pipelineId,
                executionId: state.run.executionId,
                stepId,
                result,
              });
              return result;
            } else {
              backoffMs = classified.retryAfter;
            }
          }

          getGlobalLogger().warn(
            'SequentialPipelineExecutor',
            `Step ${stepId} retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms ` +
              `(${classified.statusCode ?? classified.errorClass})${
                classified.retryAfter !== undefined ? ` Retry-After=${classified.retryAfter}ms` : ''
              }`,
            { error: errorMessage },
          );
          if (backoffMs > 0) {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, backoffMs);
              t.unref();
            });
          }
        } else {
          // Final failure (maxRetries exhausted)
          const endTime = Date.now();
          result.status = 'FAILURE';
          result.error = errorMessage;
          result.errorClass = classified.errorClass;
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
  config?: SequentialExecutorConfig,
): SequentialPipelineExecutor {
  const executor = agentExecutor ?? new InMemoryAgentExecutor();
  return new SequentialPipelineExecutor(executor, {
    defaultStepTimeout: 180000, // 3 minutes
    defaultMaxRetries: 2,
    emitEvents: true,
    ...config,
  });
}
