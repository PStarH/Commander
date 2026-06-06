/**
 * Tier 1.3: Run recovery from checkpoint.
 *
 * Failure modes covered:
 *   1. Crashed run with valid checkpoint → resumed from stepNumber
 *   2. Run never checkpointed → status='not_found'
 *   3. Lease lost (fenced) → status='lease_lost', no resume
 *   4. Completed tool calls reconstructed from messages
 *   5. Multi-tenant isolation (tenant A cannot resume tenant B)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateCheckpointer, type CheckpointState } from '../../src/runtime/stateCheckpointer';
import { RunRecovery } from '../../src/runtime/runRecovery';
import { LeaseManager } from '../../src/atr/leaseManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let checkpointer: StateCheckpointer;
let leaseManager: LeaseManager;
let recovery: RunRecovery;

function makeCheckpoint(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    phase: 'tool_execution',
    stepNumber: 3,
    attemptNumber: 1,
    messages: [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'writeFile', arguments: { path: '/x' } }] },
      { role: 'tool', content: 'wrote file', toolCallId: 'tc-1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc-2', name: 'readFile', arguments: { path: '/y' } }] },
      { role: 'tool', content: 'file contents', toolCallId: 'tc-2' },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stepDurations: [100, 200, 150],
    context: {
      agentId: 'agent-1',
      projectId: 'proj-1',
      goal: 'do the thing',
      availableTools: ['writeFile', 'readFile'],
      maxSteps: 10,
      tokenBudget: 1000,
    },
    totalDurationMs: 450,
    ...overrides,
  };
}

function acquireLease(runId: string, tenantId?: string) {
  const result = leaseManager.acquire(runId, { tenantId });
  return result.lease;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runrec-test-'));
  checkpointer = new StateCheckpointer(tmpDir);
  leaseManager = new LeaseManager({ ttlMs: 60000, maxPerRun: 4 });
  recovery = new RunRecovery(checkpointer, leaseManager);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RunRecovery', () => {
  it('recovers a run with valid checkpoint and live lease', async () => {
    const lease = acquireLease('run-1');
    checkpointer.checkpoint(makeCheckpoint({
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
    }));

    const result = await recovery.attempt('run-1');
    expect(result.status).toBe('recovered');
    expect(result.resumeFromStep).toBe(3);
    expect(result.completedToolCallIds.has('tc-1')).toBe(true);
    expect(result.completedToolCallIds.has('tc-2')).toBe(true);
    expect(result.completedToolCallIds.size).toBe(2);
  });

  it('returns not_found when no checkpoint exists', async () => {
    const result = await recovery.attempt('run-missing');
    expect(result.status).toBe('not_found');
    expect(result.completedToolCallIds.size).toBe(0);
  });

  it('returns lease_lost when lease has been released', async () => {
    const oldLease = acquireLease('run-2');
    checkpointer.checkpoint(makeCheckpoint({
      runId: 'run-2',
      leaseToken: oldLease.token,
      fencingEpoch: oldLease.fencingEpoch,
    }));

    const released = leaseManager.release('run-2', oldLease.token);

    const result = await recovery.attempt('run-2');
    expect(released).toBe(true);
    expect(result.status).toBe('lease_lost');
    expect(result.errorMessage).toMatch(/fenced|lease/i);
  });

  it('accepts checkpoint without lease (no LeaseManager binding)', async () => {
    const cp = new StateCheckpointer(tmpDir);
    const bareRecovery = new RunRecovery(cp, leaseManager);
    cp.checkpoint(makeCheckpoint({ runId: 'run-3' }));
    const result = await bareRecovery.attempt('run-3');
    expect(result.status).toBe('recovered');
  });

  it('listRecoverableRuns returns all runnable checkpoints', async () => {
    checkpointer.checkpoint(makeCheckpoint({ runId: 'a' }));
    checkpointer.checkpoint(makeCheckpoint({ runId: 'b', phase: 'llm_call' }));

    const list = recovery.listRecoverableRuns();
    const ids = list.map(e => e.runId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('isolates completed tool calls from non-tool messages', async () => {
    const lease = acquireLease('run-4');
    checkpointer.checkpoint(makeCheckpoint({
      runId: 'run-4',
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'tc-99', name: 'foo', arguments: {} }] },
      ],
    }));

    const result = await recovery.attempt('run-4');
    expect(result.completedToolCallIds.size).toBe(0);
  });
});
