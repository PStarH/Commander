/**
 * RunRecovery — load a checkpoint and resume execution.
 *
 * Closes the "automatic resume from checkpoint" gap from the reversibility audit.
 * Without this, a crashed run has to be manually restarted from scratch, losing
 * all completed tool results and wasting tokens re-executing them.
 *
 * Recovery flow:
 *   1. Load latest checkpoint via checkpointer.loadCheckpoint()
 *   2. Validate lease (checkpointer enforces fencing internally)
 *   3. Reconstruct completed-tool-call set from steps
 *   4. Return resume state for AgentRuntime to continue from
 */

import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
import type { LeaseManager } from '../atr/leaseManager';
import { getGlobalLogger } from '../logging';

export type RecoveryStatus = 'recovered' | 'fenced' | 'not_found' | 'lease_lost';

export interface RunRecoveryResult {
  status: RecoveryStatus;
  resumeFromStep?: number;
  completedToolCallIds: Set<string>;
  state?: CheckpointState;
  errorMessage?: string;
}

export interface RunRecoveryOptions {
  tenantId?: string;
  maxLeaseAgeMs?: number;
}

export class RunRecovery {
  constructor(
    private checkpointer: StateCheckpointer,
    private leaseManager: LeaseManager,
  ) {}

  async attempt(runId: string, options: RunRecoveryOptions = {}): Promise<RunRecoveryResult> {
    const log = getGlobalLogger();

    const state = this.checkpointer.loadCheckpoint(runId);
    if (!state) {
      return { status: 'not_found', completedToolCallIds: new Set() };
    }

    if (state.leaseToken && typeof state.fencingEpoch === 'number') {
      const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
        tenantId: options.tenantId,
      });
      if (!live) {
        log.warn('RunRecovery', 'Lease lost on resume', { runId });
        return {
          status: 'lease_lost',
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
      resumeFromStep: state.stepNumber,
      completedToolCallIds,
      state,
    };
  }

  listRecoverableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointer.listCheckpoints().map(entry => ({
      runId: entry.runId,
      phase: entry.phase,
      timestamp: entry.timestamp,
    }));
  }
}
