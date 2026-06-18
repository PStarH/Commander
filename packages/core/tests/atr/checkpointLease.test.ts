import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateCheckpointer, CheckpointState } from '../../src/runtime/stateCheckpointer';
import { LeaseManager } from '../../src/atr/leaseManager';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-ckpt-lease-'));
}

function newLeaseManager(): LeaseManager {
  return new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 30,
    defaultHolder: 'test',
  });
}

function baseState(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    runId: 'run-1',
    agentId: 'a-1',
    timestamp: new Date().toISOString(),
    phase: 'tool_execution',
    stepNumber: 1,
    attemptNumber: 1,
    messages: [],
    tokenUsage: { input: 0, output: 0, total: 0 },
    stepDurations: [],
    context: {
      agentId: 'a-1',
      projectId: 'p-1',
      goal: 'test',
      availableTools: [],
      maxSteps: 10,
      tokenBudget: 1000,
    },
    totalDurationMs: 0,
    ...overrides,
  };
}

describe('StateCheckpointer + LeaseManager', () => {
  let tmp: string;
  let cp: StateCheckpointer;
  let lm: LeaseManager;

  beforeEach(() => {
    tmp = tempDir();
    lm = newLeaseManager();
    cp = new StateCheckpointer(tmp, undefined, { leaseManager: lm });
  });

  afterEach(() => {
    lm.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('writes checkpoint when lease is valid and bumps version', () => {
    const lease = lm.acquire('run-1').lease;
    const state = baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch });
    cp.checkpoint(state);

    const written = cp.resume('run-1');
    assert.ok(written, 'checkpoint file must exist');
    assert.strictEqual(written!.version, 1, 'first write sets version=1');
    assert.strictEqual(written!.leaseToken, lease.token);
    assert.strictEqual(written!.fencingEpoch, lease.fencingEpoch);
  });

  it('bumps version on every successful write', () => {
    const lease = lm.acquire('run-1').lease;
    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));
    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));
    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));

    const written = cp.resume('run-1');
    assert.strictEqual(written!.version, 3);
  });

  it('rejects write when fencing epoch is stale (zombie process)', async () => {
    const old = lm.acquire('run-1', { ttlSeconds: 1 }).lease;
    cp.checkpoint(baseState({ leaseToken: old.token, fencingEpoch: old.fencingEpoch }));
    const v1 = cp.resume('run-1')!.version;
    assert.strictEqual(v1, 1);

    await new Promise((r) => setTimeout(r, 1100));

    const fresh = lm.acquire('run-1');
    assert.strictEqual(fresh.acquired, true);
    assert.strictEqual(fresh.reclaimed, true, 'expired lease must be reclaimed');
    assert.notStrictEqual(fresh.lease.token, old.token);
    assert.strictEqual(fresh.lease.fencingEpoch, old.fencingEpoch + 1);

    cp.checkpoint(baseState({ leaseToken: old.token, fencingEpoch: old.fencingEpoch }));

    const written = cp.resume('run-1')!;
    assert.strictEqual(written.version, 1, 'zombie write rejected; version unchanged');
    assert.strictEqual(written.leaseToken, old.token, 'file untouched');
  });

  it('rejects write when token does not match any lease', () => {
    lm.acquire('run-1');
    cp.checkpoint(baseState({ leaseToken: 'fake-token-xyz', fencingEpoch: 1 }));

    assert.strictEqual(cp.resume('run-1'), null, 'file never created');
  });

  it('rejects write when state lacks lease credentials', () => {
    lm.acquire('run-1');
    cp.checkpoint(baseState({ leaseToken: undefined, fencingEpoch: undefined }));

    assert.strictEqual(cp.resume('run-1'), null);
  });

  it('rejects terminalCheckpoint when fenced', async () => {
    const old = lm.acquire('run-1', { ttlSeconds: 1 }).lease;
    cp.checkpoint(baseState({ leaseToken: old.token, fencingEpoch: old.fencingEpoch }));

    await new Promise((r) => setTimeout(r, 1100));
    const fresh = lm.acquire('run-1');
    assert.strictEqual(fresh.reclaimed, true, 'expired lease must be reclaimed');

    const terminal = baseState({
      phase: 'completed',
      leaseToken: old.token,
      fencingEpoch: old.fencingEpoch,
    });
    cp.terminalCheckpoint(terminal);

    const completed = path.join(tmp, 'completed', 'run-1.json');
    assert.strictEqual(fs.existsSync(completed), false, 'terminal write must be rejected');
  });

  it('accepts terminalCheckpoint when lease is still valid', () => {
    const lease = lm.acquire('run-1').lease;
    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));

    const terminal = baseState({
      phase: 'completed',
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
    });
    cp.terminalCheckpoint(terminal);

    const completed = path.join(tmp, 'completed', 'run-1.json');
    assert.ok(fs.existsSync(completed), 'terminal file written');

    const raw = JSON.parse(fs.readFileSync(completed, 'utf-8'));
    assert.strictEqual(raw.phase, 'completed');
    assert.ok(raw.version && raw.version >= 2);
  });

  it('heartbeat refresh keeps the same token and epoch — write still accepted', () => {
    const lease = lm.acquire('run-1', { ttlSeconds: 30 }).lease;
    const ok = lm.heartbeat('run-1', lease.token, { ttlSeconds: 60 });
    assert.ok(ok);

    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));
    const written = cp.resume('run-1')!;
    assert.strictEqual(written.version, 1);
  });

  it('write rejected after lease release', () => {
    const lease = lm.acquire('run-1').lease;
    assert.ok(lm.release('run-1', lease.token));

    cp.checkpoint(baseState({ leaseToken: lease.token, fencingEpoch: lease.fencingEpoch }));
    assert.strictEqual(cp.resume('run-1'), null);
  });

  it('works without LeaseManager bound (back-compat)', () => {
    const cpSolo = new StateCheckpointer(tmp);
    cpSolo.checkpoint(baseState());
    const written = cpSolo.resume('run-1');
    assert.ok(written);
    assert.strictEqual(written!.version, undefined, 'no version bump when no lease manager');
  });

  it('tenant-isolated leases: tenant A cannot write into tenant B run', () => {
    const lmShared = new LeaseManager({
      filePath: ':memory:',
      defaultTtlSeconds: 30,
      defaultHolder: 'test',
    });
    const cpA = new StateCheckpointer(tmp, 'tenant-a', { leaseManager: lmShared });
    const cpB = new StateCheckpointer(tmp, 'tenant-b', { leaseManager: lmShared });

    const leaseA = lmShared.acquire('run-1', { tenantId: 'tenant-a' }).lease;
    const leaseB = lmShared.acquire('run-1', { tenantId: 'tenant-b' }).lease;
    assert.notStrictEqual(leaseA.token, leaseB.token);

    cpB.checkpoint(baseState({ leaseToken: leaseA.token, fencingEpoch: leaseA.fencingEpoch }));
    assert.strictEqual(cpB.resume('run-1'), null, 'tenant B using tenant A lease → rejected');

    cpB.checkpoint(baseState({ leaseToken: leaseB.token, fencingEpoch: leaseB.fencingEpoch }));
    assert.ok(cpB.resume('run-1'));
    lmShared.close();
  });
});
