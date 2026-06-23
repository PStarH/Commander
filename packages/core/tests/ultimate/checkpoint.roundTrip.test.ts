/**
 * checkpoint.roundTrip.test.ts — Day 3 executor-level atomicity contract.
 *
 * Each `it` proves the kill9 WAL contract for one of the four orchestrator
 *   paths:
 *     1. Drive the executor through exactly 2 step boundaries.
 *     2. engine.shutdown() drops the WAL handle from the process.
 *     3. Open a fresh ReliabilityEngine against the SAME dbPath.
 *     4. getLatestCheckpoint(runId).stepNumber === 2  (strict).
 *     5. executorState, serialized into the `state_json` TEXT column, is
 *        parseable and preserves the JSON-safe `kind` discriminator.
 *
 * Note: CheckpointRecord exposes the WAL row as `stateJson: string`, NOT
 * `executorState`. The executor state lives INSIDE stateJson's JSON content;
 * tests must parse + assert against the inner envelope.
 *
 * The 4 paths exercise every long-lived executor in Commander:
 *   - Sequential (1-step pipeline → start + per-step + terminal = 3 rows)
 *   - TaskPool   (2 maxWorkers=1 batches → start + 2 batches = 3 rows)
 *   - Goal       (maxRounds=2 + stub LLM that returns 1 finding/round to
 *                  block the stop_achieved branch)
 *   - Swarm      (same stub + maxDepth=0 + fissionThreshold=10 to suppress
 *                  recurrent nesting)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReliabilityEngine } from '../../src/runtime/reliabilityEngine';
import { SequentialPipelineExecutor, InMemoryAgentExecutor } from '../../src/ultimate/executor';
import { TaskPool } from '../../src/ultimate/taskPool';
import { GoalOrchestrator } from '../../src/goal/goalOrchestrator';
import { SwarmOrchestrator } from '../../src/swarm/swarmOrchestrator';
import type { LLMProvider } from '../../src/runtime/types';

let tmpDir: string;
let dbPath: string;
let engine: ReliabilityEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundTrip-'));
  dbPath = path.join(tmpDir, 'atr_checkpoints.db');
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

/**
 * Stub LLM provider used by Goal + Swarm.  Emits canned JSON strings in
 * a fixed ordinal sequence (decomposition + 5 round-cell responses).
 * The `findings > 0` per round is intentional — without it, the goal
 * orchestrator falls into the stop_achieved branch (activeCount=0 AND
 * findingsCount=0) and the loop exits after round 1.
 */
function createStubLLMProvider(): LLMProvider {
  const responses = [
    // 0: decomposition (1 sub-goal, low complexity to suppress Swarm fission)
    JSON.stringify({
      subGoals: [{ goal: 'sub', dependencies: [], notes: '' }],
      reasoning: 'ok',
    }),
    // round 1: worker + critic + manager review
    '<output>',
    JSON.stringify({
      passed: true,
      findings: [{ severity: 'low', category: 'style', description: 'r1 finding' }],
      summary: 'r1',
    }),
    JSON.stringify({
      goalAssessments: [],
      newSubGoals: [],
      overallStatus: 'needs_improvement',
      overallSummary: 'r1',
    }),
    // round 2: worker + critic + manager review
    '<output>',
    JSON.stringify({
      passed: true,
      findings: [{ severity: 'low', category: 'style', description: 'r2 finding' }],
      summary: 'r2',
    }),
    JSON.stringify({
      goalAssessments: [],
      newSubGoals: [],
      overallStatus: 'needs_improvement',
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

function makeRunId(prefix: string): string {
  return `${prefix}-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read the executorState envelope out of the WAL `state_json` column.
 * Returns null when the row exists but executorState is missing, so the
 * caller gets a clear assertion rather than a JSON.parse TypeError.
 */
function readEnvelope(latest: { stateJson: string } | null): {
  kind: string;
  payload: Record<string, unknown>;
} | null {
  if (!latest || !latest.stateJson) return null;
  const parsed = JSON.parse(latest.stateJson);
  if (!parsed || typeof parsed.executorState !== 'object') return null;
  return parsed.executorState as { kind: string; payload: Record<string, unknown> };
}

describe('checkpoint round-trip — 4 execution paths', () => {
  it('Sequential: 1-step pipeline emits start + per-step + terminal rows', async () => {
    const runId = makeRunId('seq');
    const executor = new SequentialPipelineExecutor(new InMemoryAgentExecutor(), {
      reliabilityEngine: engine,
      runId,
    });
    await executor.execute({
      id: 'rt-pipe',
      name: 'round-trip',
      steps: [{ id: 's1', name: 's1', agentId: 'a', objective: 'do' }],
      projectId: 'rt',
    });
    engine.shutdown();
    const reopened = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    try {
      const latest = reopened.getLatestCheckpoint(runId);
      expect(latest).not.toBeNull();
      expect(latest?.stepNumber).toBe(2);
      const envelope = readEnvelope(latest);
      expect(envelope).not.toBeNull();
      expect(envelope?.kind).toBe('sequential');
      // payload survives a JSON.parse(JSON.stringify(...)) roundtrip
      const payload = JSON.parse(JSON.stringify(envelope!.payload));
      expect(payload.pipelineId).toBe('rt-pipe');
      expect(Array.isArray(payload.stepResults)).toBe(true);
    } finally {
      reopened.shutdown();
    }
  });

  it('TaskPool: 2 sequential batches emit start + batch-1 + batch-2 rows', async () => {
    const runId = makeRunId('pool');
    const pool = new TaskPool(
      {
        execute: async () => ({
          status: 'success',
          summary: 'ok',
          totalTokenUsage: { totalTokens: 10 },
          totalDurationMs: 10,
        }),
      } as any,
      { maxWorkers: 1, reliabilityEngine: engine, runId },
    );
    await pool.dispatch([
      { id: 't1', goal: 'a' },
      { id: 't2', goal: 'b' },
    ]);
    engine.shutdown();
    const reopened = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    try {
      const latest = reopened.getLatestCheckpoint(runId);
      expect(latest).not.toBeNull();
      expect(latest?.stepNumber).toBe(2);
      const envelope = readEnvelope(latest);
      expect(envelope).not.toBeNull();
      expect(envelope?.kind).toBe('task-pool');
      const payload = JSON.parse(JSON.stringify(envelope!.payload));
      expect(payload.results).toHaveLength(2);
      expect(payload.totalTokensUsed).toBeGreaterThanOrEqual(0);
    } finally {
      reopened.shutdown();
    }
  });

  it('Goal: 2 rounds emit start + round-1 + round-2 rows', async () => {
    const runId = makeRunId('goal');
    const orch = new GoalOrchestrator(
      createStubLLMProvider(),
      { maxRounds: 2, budgetTokens: 1_000_000, mode: 'balanced' },
      { reliabilityEngine: engine, runId },
    );
    await orch.execute('test goal');
    engine.shutdown();
    const reopened = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    try {
      const latest = reopened.getLatestCheckpoint(runId);
      expect(latest).not.toBeNull();
      expect(latest?.stepNumber).toBe(2);
      const envelope = readEnvelope(latest);
      expect(envelope).not.toBeNull();
      expect(envelope?.kind).toBe('goal-round');
      const payload = JSON.parse(JSON.stringify(envelope!.payload));
      expect(payload.round).toBe(2);
      expect(payload.goal).toBe('test goal');
      expect(payload.ledger.length).toBe(2);
    } finally {
      reopened.shutdown();
    }
  });

  it('Swarm: 2 rounds emit start + round-1 + round-2 rows', async () => {
    const runId = makeRunId('swarm');
    const orch = new SwarmOrchestrator(
      createStubLLMProvider(),
      {
        goalConfig: { maxRounds: 2, budgetTokens: 1_000_000, mode: 'balanced' },
        maxDepth: 0,
        maxWorkers: 5,
        fissionThreshold: 10,
        enableWorkerTools: false,
      },
      0,
      { reliabilityEngine: engine, runId },
    );
    await orch.execute('test goal');
    engine.shutdown();
    const reopened = new ReliabilityEngine({ atrCheckpointPath: dbPath });
    try {
      const latest = reopened.getLatestCheckpoint(runId);
      expect(latest).not.toBeNull();
      expect(latest?.stepNumber).toBe(2);
      const envelope = readEnvelope(latest);
      expect(envelope).not.toBeNull();
      expect(envelope?.kind).toBe('swarm-round');
      const payload = JSON.parse(JSON.stringify(envelope!.payload));
      expect(payload.round).toBe(2);
      expect(payload.goal).toBe('test goal');
      expect(Array.isArray(payload.rootNodes)).toBe(true);
    } finally {
      reopened.shutdown();
    }
  });
});
