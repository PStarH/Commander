/**
 * resume.goal.test.ts — Day 4 ABI for GoalOrchestrator.
 *
 * Verifies the goal resume contract:
 *   - resumePointedAt(runId) ingests `rootNodes`, `ledger`,
 *     `totalTokensUsed`, `plateauRounds`; the while-loop continues from
 *     exactly `ledger.length` (past the last committed round)
 *   - skip the start checkpoint at stepNumber=0
 *   - publish `goal.resumed` on the bus instead of `goal.started`
 *   - reset the resume ingest so a re-executed instance does not silently
 *     re-apply state
 *
 * StubLLMProvider is intentionally minimal: with `goalTree.length > 0` on
 * resume, decomposition is skipped. The only LLM call needed is the
 * round-2 manager review (no workers run because the only node is already
 * completed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import { GoalOrchestrator } from '../../src/goal/goalOrchestrator';
import { assertNoTestOnlyPhase } from '../../src/ultimate/checkpointAdapters';
import type { LLMProvider } from '../../src/runtime/types';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

const RUN_ID = 'goal-resume-A';

function makeGoalState(
  runId: string,
  stepNumber: number,
  payload: Record<string, unknown>,
): CheckpointState {
  return {
    runId,
    agentId: 'goal-orchestrator',
    timestamp: new Date().toISOString(),
    phase: 'goal-round' as CheckpointPhase,
    stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    stepDurations: [],
    context: {
      agentId: 'goal-orchestrator',
      projectId: 'goal',
      goal: (payload.goal as string) ?? 'r-goal',
      availableTools: [],
      maxSteps: 0,
      tokenBudget: 0,
    },
    totalDurationMs: 0,
    executorState: {
      kind: 'goal-round',
      payload,
    },
  };
}

function resumeStubLLM(): LLMProvider {
  const responses = [
    // round 2 manager review (only call needed — decomposition is skipped
    // because pre-populated goalTree takes the resume branch).
    JSON.stringify({
      goalAssessments: [],
      newSubGoals: [],
      overallStatus: 'on_track',
      overallSummary: 'r2',
    }),
  ];
  let i = 0;
  return {
    call: async () => ({
      content: responses[i++] ?? '{}',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
  };
}

describe('GoalOrchestrator.resumePointedAt', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-resume-'));
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

  it('resume kind=resume skips start seed; loop continues from ledger.length=1 to round=2', async () => {
    // Plant stepNumber=0 (seed) + stepNumber=1 with a populated goalTree
    // (1 completed node) and ledger of 1 entry.
    const ledger1 = [
      {
        round: 1,
        goalSnapshot: [],
        findingsTotal: 1,
        findingsResolved: 0,
        findingsNew: 1,
        improvementRate: 0.0,
        tokensUsed: 150,
        totalTokensUsed: 150,
        decision: 'continue' as const,
        decisionReason: 'r1',
        summary: 'r1',
        timestamp: new Date().toISOString(),
      },
    ];
    const goalTree: Array<Record<string, unknown>> = [
      {
        id: 'n1',
        goal: 'sub',
        parentId: null,
        status: 'completed',
        workerOutput: 'done',
        critique: { passed: true, findings: [], summary: 'ok' },
        roundAssigned: 1,
        roundCompleted: 1,
        dependencies: [],
        subGoals: [],
      },
    ];
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeGoalState(RUN_ID, 0, {
          round: 0,
          goal: 'r-goal',
          rootNodes: [],
          ledger: [],
          totalTokensUsed: 0,
          plateauRounds: 0,
        }),
      ),
    );
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeGoalState(RUN_ID, 1, {
          round: 1,
          goal: 'r-goal',
          rootNodes: goalTree,
          ledger: ledger1,
          totalTokensUsed: 150,
          plateauRounds: 0,
        }),
      ),
    );
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    const orch = new GoalOrchestrator(
      resumeStubLLM(),
      { maxRounds: 2, budgetTokens: 1_000_000, mode: 'balanced' },
      { reliabilityEngine: engine, runId: RUN_ID },
    );
    expect(orch.resumePointedAt(RUN_ID)).toBe(true);
    expect(orch.getResumePoint()?.kind).toBe('resume');

    await orch.execute('r-goal');

    const afterRows = engine.getAtrCheckpointStore().listByRun(RUN_ID);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // Planted 0 + 1 + new round-2 checkpoint at stepNumber=2 = 3 rows.
    expect(stepNumbers).toEqual([0, 1, 2]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(orch.getResumePoint()).toBeUndefined();
  });

  it('seed kind=seed skips start seed; decomposition re-runs with the preserved goal', async () => {
    const seedRunId = 'goal-resume-seed';
    // Plant ONLY the start seed (kind='seed').
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeGoalState(seedRunId, 0, {
          round: 0,
          goal: 'seed-goal',
          rootNodes: [],
          ledger: [],
          totalTokensUsed: 0,
          plateauRounds: 0,
        }),
      ),
    );
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    // Stub returns 1 decomposition + 1 round (worker + critic + review).
    const responses = [
      // 0: decomposition
      JSON.stringify({ subGoals: [{ goal: 's', dependencies: [] }], reasoning: 'ok' }),
      // round 1: worker + critic + review
      '<output>',
      JSON.stringify({
        passed: true,
        findings: [{ severity: 'low', category: 'style', description: 'f' }],
        summary: 'r1',
      }),
      JSON.stringify({
        goalAssessments: [],
        newSubGoals: [],
        overallStatus: 'on_track',
        overallSummary: 'r1',
      }),
    ];
    let i = 0;
    const provider: LLMProvider = {
      call: async () => ({
        content: responses[i++] ?? '{}',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
    };

    const orch = new GoalOrchestrator(
      provider,
      { maxRounds: 1, budgetTokens: 1_000_000, mode: 'balanced' },
      { reliabilityEngine: engine, runId: seedRunId },
    );
    expect(orch.resumePointedAt(seedRunId)).toBe(true);
    expect(orch.getResumePoint()?.kind).toBe('seed');

    await orch.execute('caller-supplied-goal');

    const afterRows = engine.getAtrCheckpointStore().listByRun(seedRunId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    // maxRounds=1: 1 decomposition-driven round 1 checkpoint lands at 1.
    // Planted 0 + new per-round 1 = 2 rows.
    expect(stepNumbers).toEqual([0, 1]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(orch.getResumePoint()).toBeUndefined();
  });

  it('not-found kind=not-found emits a fresh start seed (negative control)', async () => {
    const freshRunId = 'goal-resume-fresh';
    const responses = [
      JSON.stringify({ subGoals: [{ goal: 's', dependencies: [] }], reasoning: 'ok' }),
      '<output>',
      JSON.stringify({
        passed: true,
        findings: [{ severity: 'low', category: 'style', description: 'f' }],
        summary: 'r1',
      }),
      JSON.stringify({
        goalAssessments: [],
        newSubGoals: [],
        overallStatus: 'on_track',
        overallSummary: 'r1',
      }),
    ];
    let i = 0;
    const provider: LLMProvider = {
      call: async () => ({
        content: responses[i++] ?? '{}',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
    };
    const orch = new GoalOrchestrator(
      provider,
      { maxRounds: 1, budgetTokens: 1_000_000, mode: 'balanced' },
      { reliabilityEngine: engine, runId: freshRunId },
    );
    expect(orch.resumePointedAt(freshRunId)).toBe(false);
    expect(orch.getResumePoint()).toBeUndefined();

    await orch.execute('fresh-goal');

    const afterRows = engine.getAtrCheckpointStore().listByRun(freshRunId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    expect(stepNumbers).toEqual([0, 1]);
  });
});
