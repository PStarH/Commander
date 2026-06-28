/**
 * RunRecovery — load a checkpoint and resume execution.
 *
 * Phase 2: Extended with 3-path recovery strategy:
 *   Path A: Event replay recovery (strongest — reconstructs state event-by-event)
 *   Path B: Checkpoint recovery (fast path — resumes from last checkpoint)
 *   Path C: Abort + compensate (fallback — compensates external side effects)
 *
 * The strategy selector checks for complete event logs first (Path A),
 * then falls back to checkpoint (Path B), then to compensation (Path C).
 *
 * Recovery flow:
 *   1. Check if DeterminismCapture has recordings for this run → Path A
 *   2. If not, load latest checkpoint via checkpointer.loadCheckpoint() → Path B
 *   3. If no checkpoint either, return 'not_found' → caller aborts+compensates → Path C
 *   4. Validate lease (checkpointer enforces fencing internally)
 *   5. Reconstruct completed-tool-call set from steps
 *   6. Return resume state for AgentRuntime to continue from
 */

import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
import type { LeaseManager } from '../atr/leaseManager';
import { getGlobalLogger } from '../logging';
import {
  getGlobalDeterminismCapture,
  type ReplayContext,
} from './determinismCapture';

export type RecoveryStatus =
  | 'recovered'
  | 'recovered_via_replay'
  | 'fenced'
  | 'not_found'
  | 'lease_lost';

export interface RunRecoveryResult {
  status: RecoveryStatus;
  /** Which recovery strategy was used */
  strategy?: 'replay' | 'checkpoint' | 'none';
  resumeFromStep?: number;
  completedToolCallIds: Set<string>;
  state?: CheckpointState;
  /** Replay context for event replay recovery (Path A) */
  replayContext?: ReplayContext;
  errorMessage?: string;
}

export interface RunRecoveryOptions {
  tenantId?: string;
  maxLeaseAgeMs?: number;
  /** Override recovery strategy (default: auto-select) */
  forceStrategy?: 'replay' | 'checkpoint';
  /** Disable replay recovery entirely (fallback to checkpoint-only) */
  disableReplay?: boolean;
}

export class RunRecovery {
  constructor(
    private checkpointer: StateCheckpointer,
    private leaseManager: LeaseManager,
  ) {}

  async attempt(runId: string, options: RunRecoveryOptions = {}): Promise<RunRecoveryResult> {
    const log = getGlobalLogger();

    // ── Path A: Event replay recovery (strongest) ──────────────────────
    if (!options.disableReplay) {
      const capture = getGlobalDeterminismCapture();
      if (capture.hasCaptures(runId) || options.forceStrategy === 'replay') {
        const replayContext = capture.buildReplayContext(runId);
        if (replayContext) {
          log.info('RunRecovery', 'Recovering via event replay', {
            runId,
            capturedInputs: replayContext.size(),
          });

          return {
            status: 'recovered_via_replay',
            strategy: 'replay',
            resumeFromStep: 0, // replay starts from beginning
            completedToolCallIds: new Set(),
            replayContext,
          };
        }
      }
    }

    // ── Path B: Checkpoint recovery (fast path) ────────────────────────
    if (options.forceStrategy === 'replay') {
      // Replay was forced but failed — don't fall through to checkpoint
      return {
        status: 'not_found',
        strategy: 'none',
        completedToolCallIds: new Set(),
        errorMessage: 'Replay forced but no captures found',
      };
    }

    const state = this.checkpointer.loadCheckpoint(runId);
    if (!state) {
      // ── Path C: No recovery possible → caller should abort+compensate ─
      return {
        status: 'not_found',
        strategy: 'none',
        completedToolCallIds: new Set(),
      };
    }

    if (state.leaseToken && typeof state.fencingEpoch === 'number') {
      const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
        tenantId: options.tenantId,
      });
      if (!live) {
        log.warn('RunRecovery', 'Lease lost on resume', { runId });
        return {
          status: 'lease_lost',
          strategy: 'checkpoint',
          completedToolCallIds: new Set(),
          state,
          errorMessage: 'Lease no longer valid. The run was likely fenced by another worker.',
        };
      }
    }

    const completedToolCallIds = new Set<string>();
    for (const msg of state.messages ?? []) {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (toolCallId && msg.role === 'tool') {
        completedToolCallIds.add(toolCallId);
      }
    }

    log.info('RunRecovery', 'Run recovered from checkpoint', {
      runId,
      resumeFromStep: state.stepNumber,
      completedCount: completedToolCallIds.size,
    });

    return {
      status: 'recovered',
      strategy: 'checkpoint',
      resumeFromStep: state.stepNumber,
      completedToolCallIds,
      state,
    };
  }

  listRecoverableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointer.listCheckpoints().map((entry) => ({
      runId: entry.runId,
      phase: entry.phase,
      timestamp: entry.timestamp,
    }));
  }

  /**
   * Check which recovery strategies are available for a run.
   * Useful for diagnostics and the recovery drill test.
   */
  diagnose(runId: string): {
    hasCaptures: boolean;
    captureCount: number;
    hasCheckpoint: boolean;
    recommendedStrategy: 'replay' | 'checkpoint' | 'none';
  } {
    const capture = getGlobalDeterminismCapture();
    const hasCaptures = capture.hasCaptures(runId);
    const captureCount = capture.getCaptureCount(runId);
    const hasCheckpoint = this.checkpointer.loadCheckpoint(runId) !== null;

    let recommendedStrategy: 'replay' | 'checkpoint' | 'none';
    if (hasCaptures) {
      recommendedStrategy = 'replay';
    } else if (hasCheckpoint) {
      recommendedStrategy = 'checkpoint';
    } else {
      recommendedStrategy = 'none';
    }

    return { hasCaptures, captureCount, hasCheckpoint, recommendedStrategy };
  }
}
