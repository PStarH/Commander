import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ApprovalManager,
  InMemoryApprovalStore,
  FileApprovalStore,
  ApprovalError,
  ApprovalStoreError,
} from '../../src/saga/approvalManager';
import type { ApprovalRequest, ApprovalResult } from '../../src/saga/approvalManager';

function makeRequest(runId: string, nodeId: string, approver: string): ApprovalRequest {
  return {
    runId,
    nodeId,
    approver,
    payload: { test: true },
    requestedAt: new Date().toISOString(),
  };
}

function makeResult(decision: 'approve' | 'reject', decidedBy: string): ApprovalResult {
  return {
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy,
  };
}

describe('InMemoryApprovalStore', () => {
  it('creates and retrieves an approval request', async () => {
    const store = new InMemoryApprovalStore();
    const req = makeRequest('r1', 'a', 'alice');
    await store.create(req);
    const got = await store.get('r1', 'a');
    assert.deepStrictEqual(got, req);
  });

  it('throws on duplicate create', async () => {
    const store = new InMemoryApprovalStore();
    await store.create(makeRequest('r1', 'a', 'alice'));
    await assert.rejects(store.create(makeRequest('r1', 'a', 'alice')), ApprovalStoreError);
  });

  it('records a decision and retrieves outcome', async () => {
    const store = new InMemoryApprovalStore();
    const req = makeRequest('r1', 'a', 'alice');
    await store.create(req);
    const result = makeResult('approve', 'alice');
    await store.record(req, result);
    const outcome = await store.outcome('r1', 'a');
    assert.deepStrictEqual(outcome, result);
  });

  it('lists pending requests for an approver', async () => {
    const store = new InMemoryApprovalStore();
    await store.create(makeRequest('r1', 'a', 'alice'));
    await store.create(makeRequest('r2', 'b', 'alice'));
    await store.create(makeRequest('r3', 'c', 'bob'));
    const pending = await store.listPending('alice');
    assert.strictEqual(pending.length, 2);
  });

  it('excludes decided requests from pending', async () => {
    const store = new InMemoryApprovalStore();
    const req = makeRequest('r1', 'a', 'alice');
    await store.create(req);
    await store.record(req, makeResult('approve', 'alice'));
    const pending = await store.listPending('alice');
    assert.strictEqual(pending.length, 0);
  });

  it('deletes an approval', async () => {
    const store = new InMemoryApprovalStore();
    await store.create(makeRequest('r1', 'a', 'alice'));
    await store.delete('r1', 'a');
    const got = await store.get('r1', 'a');
    assert.strictEqual(got, undefined);
  });
});

describe('FileApprovalStore', () => {
  let baseDir: string;

  before(async () => {
    baseDir = join(tmpdir(), 'approval-test-' + Date.now());
    await fs.mkdir(baseDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('persists approval to disk', async () => {
    const store = new FileApprovalStore({ baseDir });
    const req = makeRequest('r1', 'a', 'alice');
    await store.create(req);
    const got = await store.get('r1', 'a');
    assert.deepStrictEqual(got, req);
  });

  it('records outcome', async () => {
    const store = new FileApprovalStore({ baseDir });
    const req = makeRequest('r1', 'b', 'alice');
    await store.create(req);
    await store.record(req, makeResult('approve', 'alice'));
    const outcome = await store.outcome('r1', 'b');
    assert.strictEqual(outcome?.decision, 'approve');
  });

  it('lists pending by approver', async () => {
    const store = new FileApprovalStore({ baseDir });
    await store.create(makeRequest('r-pending-1', 'a', 'carol'));
    await store.create(makeRequest('r-pending-2', 'b', 'carol'));
    const pending = await store.listPending('carol');
    assert.ok(pending.length >= 2);
  });

  it('sanitizes nodeId in path', async () => {
    const store = new FileApprovalStore({ baseDir });
    const req = makeRequest('r-special', 'a/b/c', 'alice');
    await store.create(req);
    const got = await store.get('r-special', 'a/b/c');
    assert.ok(got);
  });

  it('listPending ignores non-approval JSON files (e.g. snapshot.json)', async () => {
    const store = new FileApprovalStore({ baseDir });
    const mixedRunId = 'mixed-run';
    const runDir = join(baseDir, mixedRunId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      join(runDir, 'snapshot.json'),
      JSON.stringify({ runId: mixedRunId, state: 'COMMITTED' }),
      'utf8',
    );
    await store.create(makeRequest(mixedRunId, 'real-approval', 'dave'));
    const pending = await store.listPending('dave');
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0]!.runId, mixedRunId);
  });
});

describe('ApprovalManager', () => {
  it('waitForDecision resolves when decision is recorded', async () => {
    const store = new InMemoryApprovalStore();
    const mgr = new ApprovalManager({ store });
    const req = makeRequest('r1', 'a', 'alice');
    await mgr.request(req);
    const waitPromise = mgr.waitForDecision('r1', 'a', { pollIntervalMs: 10 });
    setTimeout(async () => {
      await mgr.decide('r1', 'a', makeResult('approve', 'alice'));
    }, 30);
    const result = await waitPromise;
    assert.strictEqual(result.decision, 'approve');
  });

  it('waitForDecision aborts on signal', async () => {
    const store = new InMemoryApprovalStore();
    const mgr = new ApprovalManager({ store });
    await mgr.request(makeRequest('r1', 'a', 'alice'));
    const controller = new AbortController();
    const waitPromise = mgr.waitForDecision('r1', 'a', {
      pollIntervalMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(waitPromise, ApprovalError);
  });

  it('decide throws if no request', async () => {
    const store = new InMemoryApprovalStore();
    const mgr = new ApprovalManager({ store });
    await assert.rejects(mgr.decide('r1', 'a', makeResult('approve', 'alice')), ApprovalError);
  });

  it('cancel removes the request', async () => {
    const store = new InMemoryApprovalStore();
    const mgr = new ApprovalManager({ store });
    await mgr.request(makeRequest('r1', 'a', 'alice'));
    await mgr.cancel('r1', 'a');
    const got = await store.get('r1', 'a');
    assert.strictEqual(got, undefined);
  });
});
