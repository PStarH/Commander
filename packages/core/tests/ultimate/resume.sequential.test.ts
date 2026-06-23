/**
 * resume.sequential.test.ts — Day 4 ABI for SequentialPipelineExecutor.
 *
 * Verifies that calling `resumePointedAt(runId)` BEFORE `execute(pipeline)`
 * correctly:
 *   - returns `true` when a WAL row exists for `runId`
 *   - ingests the durable payload into the executor's working memory
 *   - skips the start checkpoint at stepNumber=0 (no new seed row appears)
 *   - lets the for-loop advance the WAL with monotonic stepNumbers >= the
 *     previously committed frontier
 *
 * Three sub-tests cover the resume kind matrix:
 *   - kind='resume' : planted stepNumber>=1 with populated stepResults
 *   - kind='seed'   : planted stepNumber=0 only (started but no progress)
 *   - kind='not-found' (control) : execute() emits a fresh seed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import { SequentialPipelineExecutor, InMemoryAgentExecutor } from '../../src/ultimate/executor';
import { assertNoTestOnlyPhase } from '../../src/ultimate/checkpointAdapters';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

const PIPELINE_ID = 'resume-pipe';

function makePipeState(
  runId: string,
  stepNumber: number,
  pipelineId: string,
  stepResultsCount: number,
): CheckpointState {
  const stepResults = [];
  for (let i = 0; i < stepResultsCount; i++) {
    stepResults.push({
      stepId: `s${i + 1}`,
      agentId: 'a',
      status: 'SUCCESS' as const,
      duration: 50,
      timestamp: new Date().toISOString(),
      error: null,
      hasOutput: true,
    });
  }
  return {
    runId,
    agentId: 'sequential-pipeline',
    timestamp: new Date().toISOString(),
    phase: 'sequential-step' as CheckpointPhase,
    stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    stepDurations: stepResults.map(() => 50),
    context: {
      agentId: 'sequential-pipeline',
      projectId: 'resume',
      goal: pipelineId,
      availableTools: [],
      maxSteps: stepResults.length,
      tokenBudget: 0,
    },
    totalDurationMs: stepResults.length * 50,
    executorState: {
      kind: 'sequential',
      payload: {
        pipelineId,
        executionId: runId,
        status: 'RUNNING',
        startTime: new Date().toISOString(),
        endTime: null,
        completedAt: null,
        error: null,
        stepResults,
        metrics: {
          totalDuration: 50 * stepResults.length,
          stepDurationSum: 50 * stepResults.length,
          overheadDuration: 0,
          successCount: stepResults.length,
          failureCount: 0,
          skippedCount: 0,
          timeoutCount: 0,
          retryCount: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          averageStepDuration: 50,
          stepDurationVariance: 0,
        },
      },
    },
  };
}

describe('SequentialPipelineExecutor.resumePointedAt', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-resume-'));
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

  it('resume kind=resume skips start seed; for-loop advances stepNumber past planted frontier', async () => {
    const runId = 'seq-resume-A';
    // Plant start seed + 1 boundary row (1 stepResult synthesized)
    engine.checkpointAtomically(assertNoTestOnlyPhase(makePipeState(runId, 0, PIPELINE_ID, 0)));
    engine.checkpointAtomically(assertNoTestOnlyPhase(makePipeState(runId, 1, PIPELINE_ID, 1)));
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    const plantedRows = engine.getAtrCheckpointStore().listByRun(runId);
    expect(plantedRows).toHaveLength(2);
    expect(plantedRows.map((r) => r.stepNumber).sort((a, b) => a - b)).toEqual([0, 1]);

    const executor = new SequentialPipelineExecutor(new InMemoryAgentExecutor(), {
      reliabilityEngine: engine,
      runId,
    });
    expect(executor.resumePointedAt(runId)).toBe(true);
    expect(executor.getResumePoint()?.kind).toBe('resume');

    await executor.execute({
      id: PIPELINE_ID,
      name: 'resume-pipe',
      projectId: 'resume',
      steps: [
        { id: 's1', name: 's1', agentId: 'a', objective: 'do' },
        { id: 's2', name: 's2', agentId: 'b', objective: 'do' },
      ],
    });

    const afterRows = engine.getAtrCheckpointStore().listByRun(runId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // Planted 0, 1 + new per-step 2 (from s1), 3 (from s2), 4 (terminal) = 5 rows.
    expect(stepNumbers).toEqual([0, 1, 2, 3, 4]);
    // No NEW stepNumber=0 row was emitted after resume+execute.
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(executor.getResumePoint()).toBeUndefined();
  });

  it('seed kind=seed skips start seed; per-step checkpoint lands at stepNumber=1', async () => {
    const runId = 'seq-resume-seed';
    // Plant ONLY the start seed (representing "started but lost pipeline execution"); payload has empty stepResults.
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(makePipeState(runId, 0, `${PIPELINE_ID}-seed`, 0)),
    );
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    const executor = new SequentialPipelineExecutor(new InMemoryAgentExecutor(), {
      reliabilityEngine: engine,
      runId,
    });
    expect(executor.resumePointedAt(runId)).toBe(true);
    expect(executor.getResumePoint()?.kind).toBe('seed');

    await executor.execute({
      id: `${PIPELINE_ID}-seed`,
      name: 'seed-pipe',
      projectId: 'r',
      steps: [{ id: 's1', name: 's1', agentId: 'a', objective: 'do' }],
    });

    const afterRows = engine.getAtrCheckpointStore().listByRun(runId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // Planted 0 + new per-step 1, terminal 2 = 3 rows.
    expect(stepNumbers).toEqual([0, 1, 2]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(executor.getResumePoint()).toBeUndefined();
  });

  it('not-found kind=not-found emits a fresh start seed (negative control)', async () => {
    const runId = 'seq-resume-fresh';
    // No rows planted — fresh execution path.
    const executor = new SequentialPipelineExecutor(new InMemoryAgentExecutor(), {
      reliabilityEngine: engine,
      runId,
    });
    expect(executor.resumePointedAt(runId)).toBe(false);
    expect(executor.getResumePoint()).toBeUndefined();

    await executor.execute({
      id: 'fresh-pipe',
      name: 'fresh',
      projectId: 'r',
      steps: [{ id: 's1', name: 's1', agentId: 'a', objective: 'do' }],
    });

    const afterRows = engine.getAtrCheckpointStore().listByRun(runId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    expect(stepNumbers).toEqual([0, 1, 2]);
    expect(executor.getResumePoint()).toBeUndefined();
  });
});
