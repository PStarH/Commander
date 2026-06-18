import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  createGitHubTools,
  defaultGitHubClient,
  getGitHubCompensationHandlers,
  GitHubClientError,
  type GitHubClient,
} from '../../../src/atr/adapters/github';
import { CompensationBridge } from '../../../src/atr/compensationBridge';
import { ExecutionScheduler } from '../../../src/atr/scheduler';
import { IdempotencyStore, resetIdempotencyStore } from '../../../src/atr/idempotencyStore';
import { LeaseManager } from '../../../src/atr/leaseManager';
import { RunLedger, resetRunLedgerBundle } from '../../../src/atr/runLedger';
import { resetCompensationBridge } from '../../../src/atr/compensationBridge';

class MockClient implements GitHubClient {
  createPrImpl?: (a: unknown) => Promise<{ number: number; url: string }>;
  closePrImpl?: (a: unknown) => Promise<void>;
  revertPrImpl?: (a: unknown) => Promise<{ sha: string }>;
  callCounts = { createPr: 0, mergePr: 0, revertPr: 0, closePr: 0 };
  closePrArgs: Array<{ repo: string; number: number }> = [];

  createPr = async (args: unknown) => {
    this.callCounts.createPr++;
    if (this.createPrImpl) return this.createPrImpl(args);
    return { number: 42, url: 'https://api.github.com/repos/o/r/pulls/42' };
  };
  mergePr = async () => {
    this.callCounts.mergePr++;
    return { merged: true, sha: 'abc' };
  };
  revertPr = async (args: unknown) => {
    this.callCounts.revertPr++;
    if (this.revertPrImpl) return this.revertPrImpl(args);
    return { sha: 'rev' };
  };
  closePr = async (args: unknown) => {
    this.callCounts.closePr++;
    this.closePrArgs.push(args as { repo: string; number: number });
    if (this.closePrImpl) return this.closePrImpl(args);
  };
}

function makeStack(client: GitHubClient) {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  resetRunLedgerBundle();
  resetCompensationBridge();
  const lm = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const idem = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
  const ledger = new RunLedger(lm, idem, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const bridge = new CompensationBridge();
  const scheduler = new ExecutionScheduler({ lease: lm, idempotency: idem, ledger, bridge });
  const handlers = getGitHubCompensationHandlers(client);
  for (const [name, h] of Object.entries(handlers)) {
    scheduler.registerCompensation(name, h);
  }
  return {
    scheduler,
    lm,
    idem,
    ledger,
    bridge,
    close: () => {
      lm.close();
      idem.close();
      ledger.close();
    },
  };
}

describe('GitHub adapter', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    resetRunLedgerBundle();
    resetCompensationBridge();
  });

  afterEach(() => {
    resetIdempotencyStore();
    resetRunLedgerBundle();
    resetCompensationBridge();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  describe('defaultGitHubClient', () => {
    it('throws if no GITHUB_TOKEN env var and no explicit token', () => {
      const prev = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        assert.throws(() => defaultGitHubClient(), /GITHUB_TOKEN/);
      } finally {
        if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
      }
    });

    it('accepts an explicit token', () => {
      const c = defaultGitHubClient('test-token');
      assert.ok(c.createPr);
      assert.ok(c.mergePr);
      assert.ok(c.revertPr);
      assert.ok(c.closePr);
    });
  });

  describe('tool factory', () => {
    it('returns 4 tools with correct metadata', () => {
      const c = new MockClient();
      const tools = createGitHubTools(c);
      assert.strictEqual(tools.size, 4);
      for (const [name, tool] of tools) {
        assert.strictEqual(tool.externalSystem, 'github');
        assert.strictEqual(tool.isIdempotent, true);
        assert.ok(tool.idempotencyKey, `${name} should have idempotencyKey`);
        assert.ok(typeof tool.execute === 'function');
      }
    });

    it('marks destructive tools', () => {
      const tools = createGitHubTools(new MockClient());
      assert.strictEqual(tools.get('github_merge_pr')!.destructive, true);
      assert.strictEqual(tools.get('github_revert_pr')!.destructive, true);
      assert.strictEqual(tools.get('github_create_pr')!.destructive, false);
      assert.strictEqual(tools.get('github_close_pr')!.destructive, false);
    });

    it('idempotencyKey is deterministic across calls with same args', () => {
      const tools = createGitHubTools(new MockClient());
      const create = tools.get('github_create_pr')!;
      const k1 = (create.idempotencyKey as Function)(
        { repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' },
        { runId: 'r', stepId: 's1' },
      );
      const k2 = (create.idempotencyKey as Function)(
        { repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' },
        { runId: 'r', stepId: 's2' },
      );
      assert.strictEqual(k1, k2, 'same args → same key (independent of step)');
    });

    it('idempotencyKey differs for different args', () => {
      const tools = createGitHubTools(new MockClient());
      const create = tools.get('github_create_pr')!;
      const k1 = (create.idempotencyKey as Function)(
        { repo: 'o/r', title: 'A', body: '', head: 'h', base: 'main' },
        { runId: 'r', stepId: 's' },
      );
      const k2 = (create.idempotencyKey as Function)(
        { repo: 'o/r', title: 'B', body: '', head: 'h', base: 'main' },
        { runId: 'r', stepId: 's' },
      );
      assert.notStrictEqual(k1, k2);
    });
  });

  describe('tool execution', () => {
    it('github_create_pr calls client and returns JSON result', async () => {
      const client = new MockClient();
      const tools = createGitHubTools(client);
      const r = await tools
        .get('github_create_pr')!
        .execute({ repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' });
      assert.strictEqual(client.callCounts.createPr, 1);
      const parsed = JSON.parse(r);
      assert.strictEqual(parsed.number, 42);
    });

    it('github_merge_pr calls client', async () => {
      const client = new MockClient();
      const tools = createGitHubTools(client);
      await tools.get('github_merge_pr')!.execute({ repo: 'o/r', number: 5, method: 'squash' });
      assert.strictEqual(client.callCounts.mergePr, 1);
    });

    it('propagates client errors', async () => {
      const client = new MockClient();
      client.createPrImpl = async () => {
        throw new GitHubClientError('forbidden', 403);
      };
      const tools = createGitHubTools(client);
      await assert.rejects(
        () =>
          tools
            .get('github_create_pr')!
            .execute({ repo: 'o/r', title: 't', body: 'b', head: 'h', base: 'main' }),
        /forbidden/,
      );
    });
  });

  describe('saga rollback', () => {
    it('on abort, github_create_pr is compensated by github_close_pr (REVERSE order)', async () => {
      const client = new MockClient();
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-1', goal: 'open PR then merge' });
        const create = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', title: 'fix', body: '', head: 'feat', base: 'main' },
          idempotencyKey: 'k1',
          compensable: true,
        });
        assert.ok(create);
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: create.actionId,
          result: JSON.stringify({ number: 42, url: 'x' }),
        });

        const res = await stack.scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'test abort',
        });

        assert.strictEqual(res.aborted, true);
        assert.strictEqual(res.outcome.succeeded, 1);
        assert.strictEqual(client.callCounts.closePr, 1, 'closePr was called to compensate');
        assert.deepStrictEqual(client.closePrArgs[0], { repo: 'o/r', number: 42 });
      } finally {
        stack.close();
      }
    });

    it('on abort, github_merge_pr is compensated by github_revert_pr', async () => {
      const client = new MockClient();
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-2', goal: 'merge PR' });
        const merge = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_merge_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', number: 7, method: 'merge' },
          idempotencyKey: 'k2',
          compensable: true,
        });
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: merge.actionId,
          result: JSON.stringify({ merged: true, sha: 'abc' }),
        });

        await stack.scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'x',
        });

        assert.strictEqual(client.callCounts.revertPr, 1, 'revertPr was called');
      } finally {
        stack.close();
      }
    });

    it('on commit (success), no compensation runs', async () => {
      const client = new MockClient();
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-3', goal: 'happy path' });
        const create = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', title: 't', body: '', head: 'h', base: 'main' },
          idempotencyKey: 'k3',
          compensable: true,
        });
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: create.actionId,
          result: JSON.stringify({ number: 1, url: 'x' }),
        });

        const res = stack.scheduler.commitRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
        });
        assert.strictEqual(res.committed, true);
        assert.strictEqual(client.callCounts.closePr, 0, 'no compensation on success');
      } finally {
        stack.close();
      }
    });

    it('compensation failure is reported in outcome', async () => {
      const client = new MockClient();
      client.closePrImpl = async () => {
        throw new Error('network down');
      };
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-4', goal: 'g' });
        const create = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', title: 't', body: '', head: 'h', base: 'main' },
          idempotencyKey: 'k4',
          compensable: true,
        });
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: create.actionId,
          result: JSON.stringify({ number: 99, url: 'x' }),
        });

        const res = await stack.scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'x',
        });
        assert.strictEqual(res.outcome.failed, 1);
        assert.strictEqual(res.outcome.errors[0].toolName, 'github_create_pr');
        assert.match(res.outcome.errors[0].error, /network down/);
      } finally {
        stack.close();
      }
    });
  });

  describe('idempotency through scheduler', () => {
    it('replays cached result on second schedule with same key', async () => {
      const client = new MockClient();
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-5', goal: 'g' });
        const first = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', title: 't', body: '', head: 'h', base: 'main' },
          idempotencyKey: 'shared-key',
          compensable: true,
        });
        assert.strictEqual(first.replayed, false);
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: first.actionId,
          result: JSON.stringify({ number: 7, url: 'x' }),
        });

        const second = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { repo: 'o/r', title: 't', body: '', head: 'h', base: 'main' },
          idempotencyKey: 'shared-key',
          compensable: true,
        });
        assert.strictEqual(second.replayed, true);
        assert.strictEqual(second.cachedResult, JSON.stringify({ number: 7, url: 'x' }));
      } finally {
        stack.close();
      }
    });
  });

  describe('fence protection', () => {
    it('abort rejected on stale lease', async () => {
      const client = new MockClient();
      const stack = makeStack(client);
      try {
        const h = stack.scheduler.beginRun({ runId: 'gh-6', goal: 'g' });
        const res = await stack.scheduler.abortRun({
          runId: h.runId,
          leaseToken: 'fake',
          fencingEpoch: 999,
          reason: 'x',
        });
        assert.strictEqual(res.aborted, false);
        assert.strictEqual(res.reason, 'fenced');
        assert.strictEqual(client.callCounts.closePr, 0);
      } finally {
        stack.close();
      }
    });
  });
});
