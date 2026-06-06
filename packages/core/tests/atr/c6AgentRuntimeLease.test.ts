import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { LeaseManager } from '../../src/atr/leaseManager';
import { generateIdempotencyKey } from '../../src/atr/canonicalJson';

function newLeaseManager(): LeaseManager {
  return new LeaseManager({ filePath: ':memory:', defaultTtlSeconds: 30, defaultHolder: 'test' });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-c6-'));
}

describe('C6 — agentRuntime ↔ LeaseManager wiring', () => {
  let lm: LeaseManager;
  let tmp: string;

  beforeEach(() => {
    lm = newLeaseManager();
    tmp = tempDir();
  });

  afterEach(() => {
    lm.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('setLeaseManager enables fencing on subsequent checkpoint writes', () => {
    const cp = new StateCheckpointer(tmp);
    assert.strictEqual((cp as any).leaseManager, undefined, 'no lease manager initially');

    cp.setLeaseManager(lm);
    assert.strictEqual((cp as any).leaseManager, lm, 'lease manager bound after setter');
  });

  it('checkpoint state with leaseToken matches the live lease', () => {
    const cp = new StateCheckpointer(tmp);
    cp.setLeaseManager(lm);
    const lease = lm.acquire('run-c6-1').lease;
    const state = {
      runId: 'run-c6-1',
      agentId: 'a-1',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution' as const,
      stepNumber: 1,
      attemptNumber: 1,
      messages: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      stepDurations: [],
      context: { agentId: 'a-1', projectId: 'p-1', goal: 'test', availableTools: [], maxSteps: 1, tokenBudget: 1000 },
      totalDurationMs: 0,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
    };
    cp.checkpoint(state);
    const written = cp.resume('run-c6-1');
    assert.ok(written);
    assert.strictEqual(written!.leaseToken, lease.token);
    assert.strictEqual(written!.fencingEpoch, lease.fencingEpoch);
  });

  it('zombie process holding stale token cannot overwrite the live lease', async () => {
    const cp = new StateCheckpointer(tmp);
    cp.setLeaseManager(lm);
    const old = lm.acquire('run-c6-2', { ttlSeconds: 1 }).lease;
    cp.checkpoint({
      runId: 'run-c6-2',
      agentId: 'a-1',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution' as const,
      stepNumber: 1,
      attemptNumber: 1,
      messages: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      stepDurations: [],
      context: { agentId: 'a-1', projectId: 'p-1', goal: 'test', availableTools: [], maxSteps: 1, tokenBudget: 1000 },
      totalDurationMs: 0,
      leaseToken: old.token,
      fencingEpoch: old.fencingEpoch,
    });
    const v1 = cp.resume('run-c6-2')!.version;
    assert.strictEqual(v1, 1);

    await new Promise(r => setTimeout(r, 1100));
    const fresh = lm.acquire('run-c6-2');
    assert.strictEqual(fresh.reclaimed, true);

    cp.checkpoint({
      runId: 'run-c6-2',
      agentId: 'a-1',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution' as const,
      stepNumber: 2,
      attemptNumber: 1,
      messages: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      stepDurations: [],
      context: { agentId: 'a-1', projectId: 'p-1', goal: 'test', availableTools: [], maxSteps: 1, tokenBudget: 1000 },
      totalDurationMs: 100,
      leaseToken: old.token,
      fencingEpoch: old.fencingEpoch,
    });

    const written = cp.resume('run-c6-2')!;
    assert.strictEqual(written.version, 1, 'zombie write rejected');
  });

  it('release in finally allows next process to acquire a fresh lease', () => {
    const cp = new StateCheckpointer(tmp);
    cp.setLeaseManager(lm);
    const lease = lm.acquire('run-c6-3').lease;
    assert.ok(lm.release('run-c6-3', lease.token));

    const next = lm.acquire('run-c6-3');
    assert.strictEqual(next.acquired, true);
    assert.ok(!next.reclaimed, 'released lease is not reclaimed; fresh slot created');
    assert.notStrictEqual(next.lease.token, lease.token);
    assert.strictEqual(next.lease.fencingEpoch, 1, 'fresh lease starts at epoch 1');
  });

  it('idempotency key and lease token are independent identifiers', () => {
    const runId = 'run-c6-4';
    const actionId = 'action-1';
    const idempotencyKey = generateIdempotencyKey({
      externalSystem: 'agent',
      toolName: 'file_write',
      args: { path: '/tmp/x.txt' },
      intentHash: runId,
      runId,
      stepId: actionId,
    });
    const lease = lm.acquire(runId).lease;
    assert.notStrictEqual(idempotencyKey, lease.token);
    assert.strictEqual(typeof idempotencyKey, 'string');
    assert.strictEqual(lease.token.length, 36);
  });
});
