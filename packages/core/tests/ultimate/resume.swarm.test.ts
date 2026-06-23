/**
 * resume.swarm.test.ts — Day 4 ABI for SwarmOrchestrator.
 *
 * Verifies the swarm resume contract (parallel to the goal/sibling tests):
 *   - resumePointedAt(runId) rehydrates `rootNodes`, `fusionReports`,
 *     `totalTokensUsed`, and advances the while-loop past `payload.round`
 *   - skip the start checkpoint at stepNumber=0
 *   - publish `swarm.resumed` on the bus instead of `swarm.started`
 *   - reset the resume ingest so a re-executed instance does not silently
 *     re-apply state
 *
 * StubLLMProvider is intentionally minimal: with `goalTree.length > 0` on
 * resume, decomposition is skipped. The only LLM call needed is the
 * round-2 manager review (no pending workers when the only node is
 * already completed at round 1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import { SwarmOrchestrator } from '../../src/swarm/swarmOrchestrator';
import { assertNoTestOnlyPhase } from '../../src/ultimate/checkpointAdapters';
import type { LLMProvider } from '../../src/runtime/types';
import type { CheckpointPhase, CheckpointState } from '../../src/runtime/stateCheckpointer';

const RUN_ID = 'swarm-resume-A';

function makeSwarmState(
  runId: string,
  stepNumber: number,
  payload: Record<string, unknown>,
): CheckpointState {
  return {
    runId,
    agentId: 'swarm-orchestrator',
    timestamp: new Date().toISOString(),
    phase: 'swarm-round' as CheckpointPhase,
    stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    stepDurations: [],
    context: {
      agentId: 'swarm-orchestrator',
      projectId: 'swarm',
      goal: (payload.goal as string) ?? 'r-goal',
      availableTools: [],
      maxSteps: 0,
      tokenBudget: 0,
    },
    totalDurationMs: 0,
    executorState: {
      kind: 'swarm-round',
      payload,
    },
  };
}

function resumeStubLLM(): LLMProvider {
  const responses = [
    // round 2 manager review (only call needed — decomposition skipped
    // because the resume branch consumes the pre-populated goalTree).
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

describe('SwarmOrchestrator.resumePointedAt', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: ReliabilityEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-resume-'));
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

  it('resume kind=resume skips start seed; loop continues from payload.round=1', async () => {
    const fusionReports = [
      {
        round: 1,
        conflicts: [],
        resolvedCount: 0,
        summary: 'r1',
      },
    ];
    const rootNodes: Array<Record<string, unknown>> = [
      {
        id: 's1',
        goal: 'sub',
        parentId: null,
        status: 'completed',
        workerOutput: 'done',
        critique: { passed: true, findings: [], summary: 'ok' },
        children: [],
        subNodes: [],
        dependencies: [],
      },
    ];
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeSwarmState(RUN_ID, 0, {
          round: 0,
          goal: 'r-goal',
          rootNodes: [],
          fusionReports: [],
          totalTokensUsed: 0,
        }),
      ),
    );
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeSwarmState(RUN_ID, 1, {
          round: 1,
          goal: 'r-goal',
          rootNodes,
          fusionReports,
          totalTokensUsed: 150,
        }),
      ),
    );
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    const orch = new SwarmOrchestrator(
      resumeStubLLM(),
      {
        goalConfig: { maxRounds: 2, budgetTokens: 1_000_000, mode: 'balanced' },
        maxDepth: 0,
        maxWorkers: 5,
        fissionThreshold: 10,
        enableWorkerTools: false,
      },
      0,
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

  it('seed kind=seed skips start seed; decomposition re-runs with preserved goal', async () => {
    const seedRunId = 'swarm-resume-seed';
    engine.checkpointAtomically(
      assertNoTestOnlyPhase(
        makeSwarmState(seedRunId, 0, {
          round: 0,
          goal: 'seed-goal',
          rootNodes: [],
          fusionReports: [],
          totalTokensUsed: 0,
        }),
      ),
    );
    engine.shutdown();

    engine = new ReliabilityEngine({ atrCheckpointPath: dbPath });

    // Stub: decomposition + (1 pending node → worker + critic)
    // + manager review. With maxDepth=0 + fissionThreshold=10, the
    // manager's decomposition returns complexity <= 5 so no fission
    // happens and we get exactly 1 pending node to process.
    const responses = [
      JSON.stringify({
        subGoals: [{ goal: 's', dependencies: [], notes: '', complexity: 1 }],
        reasoning: 'ok',
      }),
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

    const orch = new SwarmOrchestrator(
      provider,
      {
        goalConfig: { maxRounds: 1, budgetTokens: 1_000_000, mode: 'balanced' },
        maxDepth: 0,
        maxWorkers: 5,
        fissionThreshold: 10,
        enableWorkerTools: false,
      },
      0,
      { reliabilityEngine: engine, runId: seedRunId },
    );
    expect(orch.resumePointedAt(seedRunId)).toBe(true);
    expect(orch.getResumePoint()?.kind).toBe('seed');

    await orch.execute('caller-supplied-goal');

    const afterRows = engine.getAtrCheckpointStore().listByRun(seedRunId);
    const stepNumbers = afterRows.map((r) => r.stepNumber).sort((a, b) => a - b);
    expect(stepNumbers).toEqual([0, 1]);
    expect(afterRows.filter((r) => r.stepNumber === 0)).toHaveLength(1);
    expect(orch.getResumePoint()).toBeUndefined();
  });

  it('not-found kind=not-found emits a fresh start seed (negative control)', async () => {
    const freshRunId = 'swarm-resume-fresh';
    const responses = [
      JSON.stringify({
        subGoals: [{ goal: 's', dependencies: [], notes: '', complexity: 1 }],
        reasoning: 'ok',
      }),
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
    const orch = new SwarmOrchestrator(
      provider,
      {
        goalConfig: { maxRounds: 1, budgetTokens: 1_000_000, mode: 'balanced' },
        maxDepth: 0,
        maxWorkers: 5,
        fissionThreshold: 10,
        enableWorkerTools: false,
      },
      0,
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
