/**
 * Step 1 of the agentRuntime refactor — CheckpointingPhase.
 *
 * Extracted from `agentRuntime.ts` (4,571-line God object). Owns:
 *   - 3 inline `this.checkpointer.checkpoint(...)` calls (started, tool_execution, verification)
 *   - 4 inline `this.checkpointer.terminalCheckpoint(...)` calls (interrupted,
 *     completed_early_exit, completed, failed)
 *   - 9 public AgentRuntime methods related to run lifecycle + recovery
 *     (listUnfinishedRuns, resume, listResumableRuns, pauseRun, unpauseRun,
 *     isPaused, getActiveRuns, getActiveRunCount, isRunActive)
 *   - The `checkpointer.setLeaseManager(...)` binding (was line 654 of agentRuntime)
 *
 * State.Payload model: each method takes `(ctx, state, payload)`. Fields common
 * across all checkpoints are derived from `(ctx, state)`; per-phase fields
 * come from `payload`.
 *
 * Behavior-preserving contract: every parameter passed to
 * StateCheckpointer.checkpoint(...) / terminalCheckpoint(...) is byte-identical
 * to the prior inline call site. Phase names + ordering MUST NOT change
 * without a schema-versioned migration.
 */

import { reportSilentFailure } from '../../silentFailureReporter';
import type { AgentExecutionContext } from '../types';
import { RunRecovery } from '../runRecovery';
import type { RunRecoveryResult } from '../runRecovery';
import type { LeaseManager } from '../../atr/leaseManager';
import type { StateCheckpointer } from '../stateCheckpointer';
import type { RunLifecycleManager } from '../runLifecycleManager';
import { now, generateId } from '../runtimeHelpers';
import { getGlobalLogger } from '../../logging';
import type {
  AgentExecutionState,
  CheckpointPhaseLabel,
  CheckpointStartPayload,
  CheckpointStepPayload,
  CheckpointTerminalPayload,
} from './AgentExecutionState';

// ── Public service-construction interface ────────────────────────────────────

export interface CheckpointingPhaseServices {
  checkpointer: StateCheckpointer;
  runLifecycle: RunLifecycleManager;
  leaseManager: LeaseManager;
  /**
   * Optional factory for a fresh `RunRecovery` per call. Defaults to
   * `new RunRecovery(checkpointer, leaseManager)` — kept as a factory so
   * tests can inject a stub without leaking constructor side-effects.
   */
  makeRunRecovery?: (checkpointer: StateCheckpointer, leaseManager: LeaseManager) => RunRecovery;
}

// ── Public method types (preserve AgentRuntimeInterface contract) ─────────────

export interface UnfinishedRunEntry {
  runId: string;
  phase: string;
  timestamp: string;
}

export interface ResumableRunEntry {
  runId: string;
  phase: string;
  timestamp: string;
}

export interface ActiveRunEntry {
  runId: string;
  paused: boolean;
  checkpointPhase?: string;
}

// ── Phase class ───────────────────────────────────────────────────────────────

export class CheckpointingPhase {
  private readonly checkpointer: StateCheckpointer;
  private readonly runLifecycle: RunLifecycleManager;
  private readonly leaseManager: LeaseManager;
  private readonly makeRunRecovery: (
    checkpointer: StateCheckpointer,
    leaseManager: LeaseManager,
  ) => RunRecovery;

  constructor(services: CheckpointingPhaseServices) {
    this.checkpointer = services.checkpointer;
    this.runLifecycle = services.runLifecycle;
    this.leaseManager = services.leaseManager;
    this.makeRunRecovery = services.makeRunRecovery ?? ((cp, lm) => new RunRecovery(cp, lm));

    // Bind lease manager for run recovery validation (was line 654 of agentRuntime).
    // Done in the constructor so callers don't accidentally forget it.
    this.checkpointer.setLeaseManager(this.leaseManager);
  }

  // ── Checkpoint methods (private — called from agentRuntime.execute()) ──

  /** Phase 0 — write 'started' checkpoint after prompt is built. */
  async checkpointStart(
    ctx: AgentExecutionContext,
    state: AgentExecutionState,
    payload: CheckpointStartPayload,
  ): Promise<void> {
    this.checkpointer.checkpoint(this.buildCheckpointPayload(ctx, state, 'started', payload, 0, 0));
    state.phaseCheckpointIds.started = state.runId;
  }

  /**
   * Phase 4 / Phase 5 — write 'tool_execution' or 'verification' checkpoint
   * after a step in the core execution loop.
   *
   * The 'verification' checkpoint variant carries `payload.lastError` for
   * downstream reflection / recovery — pass it through unchanged.
   */
  async checkpointAfterStep(
    ctx: AgentExecutionContext,
    state: AgentExecutionState,
    label: 'tool_execution' | 'verification',
    payload: CheckpointStepPayload,
  ): Promise<void> {
    this.checkpointer.checkpoint(
      this.buildCheckpointPayload(
        ctx,
        state,
        label,
        payload,
        payload.stepNumber,
        payload.attempt,
        payload.lastError,
      ),
    );
    state.phaseCheckpointIds[label] = state.runId;
  }

  /**
   * Terminal-phase checkpoint. Writes via `terminalCheckpoint(...)` so the
   * completed/ subdirectory receives the snapshot and active files are removed.
   */
  async checkpointTerminal(
    ctx: AgentExecutionContext,
    state: AgentExecutionState,
    label: 'interrupted' | 'completed_early_exit' | 'completed' | 'failed',
    payload: CheckpointTerminalPayload,
  ): Promise<void> {
    this.checkpointer.terminalCheckpoint(
      this.buildCheckpointPayload(
        ctx,
        state,
        label,
        payload,
        payload.stepNumber,
        payload.attempt,
        payload.lastError,
        payload.exitSummary,
      ),
    );
    state.phaseCheckpointIds[label] = state.runId;
  }

  // ── Public AgentRuntimeInterface methods ──────────────────────────────

  /** List runs whose last checkpoint is not 'completed' or 'failed'. */
  listUnfinishedRuns(): UnfinishedRunEntry[] {
    try {
      return this.checkpointer
        .listCheckpoints()
        .filter((cp) => cp.phase !== 'completed' && cp.phase !== 'failed');
    } catch (err) {
      reportSilentFailure(err, 'checkpointing:168');
      return [];
    }
  }

  /** Resume a crashed run via RunRecovery; returns null on unrecoverable. */
  async resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null> {
    try {
      const recovery = this.makeRunRecovery(this.checkpointer, this.leaseManager);
      const result = await recovery.attempt(runId, { tenantId });
      if (result.status === 'not_found' || result.status === 'lease_lost') {
        getGlobalLogger().warn('CheckpointingPhase', 'Run recovery failed', {
          runId,
          status: result.status,
        });
        return null;
      }
      return result;
    } catch (err) {
      reportSilentFailure(err, 'checkpointing:187');
      return null;
    }
  }

  /** List all runs with recoverable checkpoints. */
  listResumableRuns(): ResumableRunEntry[] {
    try {
      return this.checkpointer.listCheckpoints().map((entry) => ({
        runId: entry.runId,
        phase: entry.phase,
        timestamp: entry.timestamp,
      }));
    } catch (err) {
      reportSilentFailure(err, 'checkpointing:201');
      return [];
    }
  }

  // ── Pause + active-run lifecycle ──────────────────────────────────────

  /** Signal a running execution to pause at the next checkpoint boundary. */
  pauseRun(runId: string): boolean {
    return this.runLifecycle.pauseRun(runId);
  }

  /** Clear the pause flag for a run. */
  unpauseRun(runId: string): void {
    this.runLifecycle.unpauseRun(runId);
  }

  /** Check whether a run is currently paused. */
  isPaused(runId: string): boolean {
    return this.runLifecycle.isPaused(runId);
  }

  /**
   * List all active runs with their pause state and the latest checkpoint
   * phase. RunLifecycleManager.getActiveRuns() returns string[] of runIds;
   * we lookup each run's paused state and last checkpoint phase individually.
   */
  getActiveRuns(): ActiveRunEntry[] {
    return this.runLifecycle.getActiveRuns().map((runId: string): ActiveRunEntry => {
      const checkpoint = this.checkpointer.resume(runId);
      return {
        runId,
        paused: this.runLifecycle.isPaused(runId),
        checkpointPhase: checkpoint?.phase,
      };
    });
  }

  /** Return the number of currently active runs. */
  getActiveRunCount(): number {
    return this.runLifecycle.getActiveRunCount();
  }

  /** Check whether a given runId is active. */
  isRunActive(runId: string): boolean {
    return this.runLifecycle.isActive(runId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Assemble the CheckpointState object passed to StateCheckpointer.
   * Identical field-by-field to the prior inline call sites. Fields not
   * declared explicitly are computed from ctx+state.
   *
   * Optional `lastError` and `exitSummary` map to the `lastError` and
   * `context` overrides used by terminal-checkpoint callers.
   */
  private buildCheckpointPayload(
    ctx: AgentExecutionContext,
    state: AgentExecutionState,
    phase: CheckpointPhaseLabel,
    payload: CheckpointStartPayload | CheckpointStepPayload | CheckpointTerminalPayload,
    stepNumber: number,
    attemptNumber: number,
    lastErrorOverride?: string,
    exitSummaryOverride?: string,
  ): {
    runId: string;
    agentId: string;
    missionId?: string;
    timestamp: string;
    phase: CheckpointPhaseLabel;
    stepNumber: number;
    attemptNumber: number;
    messages: CheckpointStartPayload['request']['messages'];
    tokenUsage: AgentExecutionState['totalTokenUsage'];
    stepDurations: number[];
    context: {
      agentId: string;
      missionId?: string;
      projectId: string;
      goal: string;
      availableTools: string[];
      maxSteps: number;
      tokenBudget: number;
      projectContextCacheKey?: string;
      projectContextFiles?: string[];
      exitSummary?: string;
    };
    lastError?: string;
    totalDurationMs: number;
  } {
    const baseMessages = 'messages' in payload.request ? payload.request.messages : [];
    const tokenUsage = state.totalTokenUsage;
    const stepDurations = state.steps.map((s) => s.durationMs);
    const projectContext =
      'projectContext' in payload ? payload.projectContext : state.activeProjectContext;

    return {
      runId: state.runId,
      agentId: state.agentId,
      missionId: state.missionId,
      timestamp: now(),
      phase,
      stepNumber,
      attemptNumber,
      messages: baseMessages,
      tokenUsage: { ...tokenUsage },
      stepDurations,
      context: {
        agentId: state.agentId,
        missionId: state.missionId,
        projectId: ctx.projectId,
        goal: ctx.goal,
        availableTools: ctx.availableTools,
        maxSteps: ctx.maxSteps,
        tokenBudget: ctx.tokenBudget,
        projectContextCacheKey: projectContext?.cacheKey,
        projectContextFiles: projectContext?.filesRead,
        exitSummary: exitSummaryOverride,
      },
      lastError: lastErrorOverride ?? state.lastError,
      totalDurationMs: Date.now() - state.startedAt,
    };
  }
}

// Re-export the `now()` helper used by `runtimeHelpers.now` so callers that
// already import from runtimeHelpers keep their existing imports.
export { now, generateId };
