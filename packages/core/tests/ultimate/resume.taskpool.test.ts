/**
 * resume.taskpool.test.ts — Day 4 ABI for TaskPool.
 *
 * Verifies the same contract as the sibling tests:
 *   - resumePointedAt(runId) returns true iff a WAL row exists
 *   - skip the start seed on resume / seed branches
 *   - dispatch() emits per-batch checkpoints with monotonic, advancing
 *     stepNumbers that build on the previously committed frontier
 *
 * The TaskPool-specific nuance is that `batchIndex` (the per-batch step
 * counter) is derived from already-completed results: with maxWorkers=1
 * and 1 already-completed result, the resume branch derives batchIndex=1
 * and continues dispatching from there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import { TaskPool, type PoolTask } from '../../src/ultimate/taskPool';
import type { AgentRuntimeInterface } from '../../src/runtime';
import { assertNoTestOnlyPhase } from '../../src/ultimate/checkpointAdapters';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

const RUN_ID = 'pool-resume-A';

function makeBatchState(runId: string, stepNumber: number, resultCount: number): CheckpointState {
  const results = [];
  for (let i = 0; i < resultCount; i++) {
    results.push({
      taskId: `t${i + 1}`,
      status: 'success' as const,
      summary: 'ok',
      tokens: 0,
      durationMs: 1,
    });
  }
  return {
    runId,
    agentId: 'task-pool',
    timestamp: new Date().toISOString(),
    phase: 'task-pool-batch' as CheckpointPhase,
    stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    stepDurations: results.map(() => 1),
    context: {
      agentId: 'task-pool',
      projectId: 'pool',
      goal: runId,
      availableTools: [],
      maxSteps: results.length,
      tokenBudget: 0,
    },
    totalDurationMs: results.length,
    executorState: {
      kind: 'task-pool',
      payload: {
        totalTokensUsed: 0,
        results,
      },
    },
  };
}

/** In-memory AgentRuntime stub that always returns success. */
function stubRuntime(): AgentRuntimeInterface {
  return {
    execute: async () => ({
      status: 'success' as const,
      summary: 'ok',
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalDurationMs: 1,
      error: undefined,
      artifacts: [],
      messages: [],
    }),
  } as unknown as AgentRuntimeInterface;
}

describe('TaskPool.resumePointedAt', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-resume-'));
    dbPath = path.join(tmpDir, 'atr.db');
    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('resume kind=resume skips start seed; new batch checkpoint advances stepNumber', async () => {
    // Plant: start seed + 1 batch-1 result row (1 result).
    engine.checkpointAtomically(assertNoTestOnlyPhase(makeBatchState(RUN_ID, 0, 0)));
    engine.checkpointAtomically(assertNoTestOnlyPhase(makeBatchState(RUN_ID, 1, 1)));
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    const plantedRows = engine.getAtrCheckpointStore().listByRun(RUN_ID);
    expect(plantedRows).toHaveLength(2);

    const pool = new TaskPool(stubRuntime(), {
      maxWorkers: 1,
      reliabilityEngine: engine,
      runId: RUN_ID,
    });
    expect(pool.resumePointedAt(RUN_ID)).toBe(true);
    expect(pool.getResumePoint()?.kind).toBe('resume');

    // Dispatch 1 fresh task → with maxWorkers=1, 1 batch lands at the
    // next available batchIndex. Resume branch computed
    // `batchIndex = ceil(results.length / maxWorkers) = 1`; the loop
    // increments to 2 and writes a checkpoint at stepNumber=2.
    const freshTasks: PoolTask[] = [{ id: 't-fresh', goal: 'fresh' }];
    await pool.dispatch(freshTasks);

    const afterRows = engine.getAtrCheckpointStore().listByRun(RUN_ID);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // Planted 0 + 1 + new batch checkpoint at stepNumber=2 = 3 rows.
    expect(stepNumbers).toEqual([0, 1, 2]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(pool.getResumePoint()).toBeUndefined();
  });

  it('seed kind=seed skips start seed; first batch checkpoint lands at stepNumber=1', async () => {
    const seedRunId = 'pool-resume-seed';
    // Plant ONLY the start seed (kind='seed').
    engine.checkpointAtomically(assertNoTestOnlyPhase(makeBatchState(seedRunId, 0, 0)));
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    const pool = new TaskPool(stubRuntime(), {
      maxWorkers: 1,
      reliabilityEngine: engine,
      runId: seedRunId,
    });
    expect(pool.resumePointedAt(seedRunId)).toBe(true);
    expect(pool.getResumePoint()?.kind).toBe('seed');

    await pool.dispatch([{ id: 't-fresh', goal: 'fresh' }]);

    const afterRows = engine.getAtrCheckpointStore().listByRun(seedRunId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // Planted 0 + new batch at 1 = 2 rows.
    expect(stepNumbers).toEqual([0, 1]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(pool.getResumePoint()).toBeUndefined();
  });

  it('not-found kind=not-found emits a fresh start seed (negative control)', async () => {
    const freshRunId = 'pool-resume-fresh';
    const pool = new TaskPool(stubRuntime(), {
      maxWorkers: 1,
      reliabilityEngine: engine,
      runId: freshRunId,
    });
    expect(pool.resumePointedAt(freshRunId)).toBe(false);
    expect(pool.getResumePoint()).toBeUndefined();

    await pool.dispatch([{ id: 't1', goal: 'a' }]);

    const afterRows = engine.getAtrCheckpointStore().listByRun(freshRunId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    expect(stepNumbers).toEqual([0, 1]);
  });
});
