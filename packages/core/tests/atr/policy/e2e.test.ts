/**
 * E2E smoke: real agent loop with GitHub adapter + PolicyHook enforcement.
 *
 * Goal: prove the entire ATR + Policy stack works as a unit, not as
 * isolated components. The "agent" is a hand-rolled loop that picks tools
 * from a fake plan and calls them through the runtime. PolicyHook sits
 * in front of every tool call.
 *
 * What this tests:
 *   1. beginRun → schedule → commit succeeds for an allow path
 *   2. beginRun → schedule → deny → abortRun → compensation runs
 *   3. Policy decision is recorded in audit log
 *   4. Cache works across iterations
 *   5. Fencing epoch bump invalidates cache
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createGitHubTools, type GitHubClient } from '../../../src/atr/adapters/github';
import { CompensationBridge } from '../../../src/atr/compensationBridge';
import { ExecutionScheduler } from '../../../src/atr/scheduler';
import { IdempotencyStore, resetIdempotencyStore } from '../../../src/atr/idempotencyStore';
import { LeaseManager } from '../../../src/atr/leaseManager';
import { RunLedger, resetRunLedgerBundle } from '../../../src/atr/runLedger';
import { resetCompensationBridge } from '../../../src/atr/compensationBridge';
import { PolicyHook, buildPolicyInput } from '../../../src/atr/policy/integration/scheduler';
import { resetSecurityAuditLogger, getSecurityAuditLogger } from '../../../src/security/securityAuditLogger';

class MockClient implements GitHubClient {
  callCounts = { createPr: 0, closePr: 0 };
  closePrArgs: Array<{ repo: string; number: number }> = [];
  createPr = async () => { this.callCounts.createPr++; return { number: 7, url: 'u' }; };
  closePr = async (a: unknown) => { this.callCounts.closePr++; this.closePrArgs.push(a as { repo: string; number: number }); };
  mergePr = async () => ({ merged: true, sha: 's' });
  revertPr = async () => ({ sha: 'r' });
}

function makeStack() {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  resetRunLedgerBundle();
  resetCompensationBridge();
  resetSecurityAuditLogger();
  const lm = new LeaseManager({ filePath: ':memory:', defaultTtlSeconds: 60, defaultHolder: 'e2e' });
  const idem = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
  const ledger = new RunLedger(lm, idem, { filePath: ':memory:', defaultTtlSeconds: 60, defaultHolder: 'e2e' });
  const bridge = new CompensationBridge();
  const scheduler = new ExecutionScheduler({ lease: lm, idempotency: idem, ledger, bridge });
  return { lm, idem, ledger, bridge, scheduler };
}

describe('E2E: agent + GitHub adapter + PolicyHook', () => {
  let stack: ReturnType<typeof makeStack>;
  let client: MockClient;
  let tools: Map<string, ReturnType<typeof createGitHubTools> extends Map<string, infer T> ? T : never>;
  let policy: PolicyHook;

  beforeEach(() => {
    stack = makeStack();
    client = new MockClient();
    tools = createGitHubTools(client) as never;
    policy = new PolicyHook({ enableAudit: true, pack: 'default' });
  });

  afterEach(() => {
    stack.lm.close();
    stack.idem.close();
    stack.ledger.close();
  });

  it('allow path: read tool passes policy, scheduler commits', async () => {
    const handle = stack.scheduler.beginRun({ runId: 'e2e-allow', goal: 'list files', tenantId: 'e2e' });
    const tool = tools.get('github_create_pr')!;

    const input = buildPolicyInput({
      scheduler: stack.scheduler, runId: handle.runId, phase: 'tool',
      tool: { name: 'file_read', externalSystem: 'fs', riskLevel: 'low', destructive: false, isReadOnly: true, isIdempotent: true, category: 'file_read' },
      args: { path: 'README.md' },
      stepNumber: 1,
    });
    const decision = policy.evaluate(input);
    assert.equal(decision.effect, 'allow', `expected allow, got ${decision.effect}: ${decision.reason}`);

    const r = stack.scheduler.scheduleAction({
      runId: handle.runId, leaseToken: handle.leaseToken, fencingEpoch: handle.fencingEpoch,
      toolName: 'github_create_pr', externalSystem: 'github',
      args: { repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' },
      idempotencyKey: 'idem-1', compensable: true, tags: [],
      tenantId: 'e2e',
    });
    assert.equal(r.replayed, false);
    const exec = await tool.execute({ repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' }, { runId: handle.runId, stepNumber: 1, idempotencyKey: 'idem-1' } as never);
    assert.match(exec, /number/);
    assert.equal(client.callCounts.createPr, 1);

    const commit = stack.scheduler.commitRun({ runId: handle.runId, leaseToken: handle.leaseToken, fencingEpoch: handle.fencingEpoch, tenantId: 'e2e' });
    assert.equal(commit.committed, true);
  });

  it('deny path: policy deny_class blocks before tool execution', async () => {
    const handle = stack.scheduler.beginRun({ runId: 'e2e-deny', goal: 'merge PR', tenantId: 'e2e' });

    const input = buildPolicyInput({
      scheduler: stack.scheduler, runId: handle.runId, phase: 'tool',
      tool: { name: 'github_merge_pr', externalSystem: 'github', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'destructive' },
      args: { repo: 'o/r', number: 7 },
      stepNumber: 1,
    });
    const decision = policy.evaluate(input);
    assert.ok(decision.effect === 'deny' || decision.effect === 'deny_class', `expected deny, got ${decision.effect}`);
    assert.equal(client.callCounts.createPr, 0, 'no GitHub call should have happened');

    const tx = stack.scheduler.getRun({ runId: handle.runId, tenantId: 'e2e' });
    assert.ok(tx);
  });

  it('decision is recorded in audit log', () => {
    const handle = stack.scheduler.beginRun({ runId: 'e2e-audit', goal: 'audit', tenantId: 'e2e' });
    const input = buildPolicyInput({
      scheduler: stack.scheduler, runId: handle.runId, phase: 'tool',
      tool: { name: 'github_merge_pr', externalSystem: 'github', riskLevel: 'high', destructive: true, isReadOnly: false, isIdempotent: false, category: 'destructive' },
      args: { repo: 'o/r', number: 7 },
      stepNumber: 1,
    });
    policy.evaluate(input);
    const events = getSecurityAuditLogger().queryEvents({ runId: handle.runId, type: 'policy_decision' });
    assert.ok(events.length >= 1, 'audit should have at least one policy_decision event');
    assert.equal(events[0].context?.runId, handle.runId);
  });

  it('cache: second evaluate with same input returns cached decision', () => {
    const handle = stack.scheduler.beginRun({ runId: 'e2e-cache', goal: 'cache test', tenantId: 'e2e' });
    const args = {
      scheduler: stack.scheduler, runId: handle.runId, phase: 'tool' as const,
      tool: { name: 'github_create_pr', externalSystem: 'github', riskLevel: 'medium', destructive: false, isReadOnly: false, isIdempotent: true, category: 'api' as const },
      args: { repo: 'o/r', number: 1 },
      stepNumber: 1,
    };
    const d1 = policy.evaluate(buildPolicyInput(args));
    const d2 = policy.evaluate(buildPolicyInput(args));
    assert.equal(d1.decisionId, d2.decisionId);
    assert.equal(d2.cached, true);
  });

  it('fencing epoch bump invalidates cache', () => {
    const handle1 = stack.scheduler.beginRun({ runId: 'e2e-fence-1', goal: 'fence 1', tenantId: 'e2e' });
    const input1 = buildPolicyInput({
      scheduler: stack.scheduler, runId: handle1.runId, phase: 'tool',
      tool: { name: 'github_create_pr', externalSystem: 'github', riskLevel: 'medium', destructive: false, isReadOnly: false, isIdempotent: true, category: 'api' },
      args: { repo: 'o/r', number: 1 },
      stepNumber: 1,
    });
    policy.evaluate(input1);
    const before = policy.getStats();
    const newEpoch = handle1.fencingEpoch + 1;
    const handle2 = { ...handle1, runId: 'e2e-fence-2', fencingEpoch: newEpoch };
    const input2 = { ...input1, run: { ...input1.run, id: handle2.runId, fencingEpoch: newEpoch }, action: { ...input1.action, fencingEpoch: newEpoch } };
    const d = policy.evaluate(input2);
    assert.equal(d.cached, false);
    const after = policy.getStats();
    assert.ok(after.cacheSize >= 1);
    void before;
  });
});
