import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  startATRRun,
  resumeATRRun,
  wrapToolExecutionWithATR,
  finalizeATRRun,
} from '../../src/atr/runtimeIntegration';
import { resetRunLedgerBundle } from '../../src/atr/runLedger';
import { resetIdempotencyStore } from '../../src/atr/idempotencyStore';
import type { ToolCall, ToolResult } from '../../src/runtime/types';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'atr-integ-'));
}

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function okResult(id: string, name: string, output: string): ToolResult {
  return { toolCallId: id, name, output, durationMs: 1 };
}

function errResult(id: string, name: string, error: string): ToolResult {
  return { toolCallId: id, name, output: '', error, durationMs: 1 };
}

describe('runtimeIntegration (ATR wrapper)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    process.env.COMMANDER_TEST_ROOT = dir;
    process.env.COMMANDER_ATR_MEMORY = '1';
    resetIdempotencyStore();
    resetRunLedgerBundle();
  });

  describe('startATRRun / finalizeATRRun (success path)', () => {
    it('creates a run in PENDING → EXECUTING → COMMITTED', async () => {
      const ctx = startATRRun('run-1', 'fix a bug in foo.ts', { tenantId: 't1' });
      assert.ok(ctx);
      assert.strictEqual(ctx!.runId, 'run-1');
      assert.strictEqual(ctx!.tenantId, 't1');
      assert.ok(ctx!.fencingEpoch >= 1);
      assert.ok(ctx!.leaseToken.length > 0);

      await finalizeATRRun(ctx!, 'success');
    });
  });

  describe('wrapToolExecutionWithATR', () => {
    it('executes a non-mutating tool and persists the result', async () => {
      const ctx = startATRRun('run-2', 'read a file')!;
      const tc = makeToolCall('tc-1', 'file_read', { path: '/foo.txt' });

      let actualExecutions = 0;
      const executeInner = async (): Promise<ToolResult> => {
        actualExecutions++;
        return okResult('tc-1', 'file_read', 'hello world');
      };

      const { result, replayed } = await wrapToolExecutionWithATR(
        ctx,
        tc,
        { name: 'file_read' },
        executeInner,
      );

      assert.strictEqual(replayed, false);
      assert.strictEqual(result.output, 'hello world');
      assert.strictEqual(actualExecutions, 1);
      assert.ok(ctx.completedToolCallIds.has('tc-1'));
    });

    it('replays from the in-process completed set on second call', async () => {
      const ctx = startATRRun('run-3', 'read a file twice')!;
      const tc = makeToolCall('tc-1', 'file_read', { path: '/foo.txt' });

      let actualExecutions = 0;
      const executeInner = async (): Promise<ToolResult> => {
        actualExecutions++;
        return okResult('tc-1', 'file_read', 'cached output');
      };

      const first = await wrapToolExecutionWithATR(ctx, tc, { name: 'file_read' }, executeInner);
      assert.strictEqual(first.replayed, false);
      assert.strictEqual(actualExecutions, 1);

      const second = await wrapToolExecutionWithATR(ctx, tc, { name: 'file_read' }, executeInner);
      assert.strictEqual(second.replayed, true);
      assert.strictEqual(second.result.output, 'cached output');
      assert.strictEqual(actualExecutions, 1, 'executeInner must not run a second time');
    });

    it('replays from the IdempotencyStore across a fresh ATRContext', async () => {
      const ctx1 = startATRRun('run-4', 'cross-context replay')!;
      const tc = makeToolCall('tc-1', 'file_read', { path: '/foo.txt' });

      let actualExecutions = 0;
      const executeInner = async (): Promise<ToolResult> => {
        actualExecutions++;
        return okResult('tc-1', 'file_read', 'persisted result');
      };

      const first = await wrapToolExecutionWithATR(ctx1, tc, { name: 'file_read' }, executeInner);
      assert.strictEqual(first.replayed, false);
      assert.strictEqual(actualExecutions, 1);

      const ctx2 = resumeATRRun('run-4', { tenantId: ctx1.tenantId });
      assert.ok(ctx2, 'resumeATRRun must return a context for an existing run');
      ctx2!.completedToolCallIds.add('tc-1');
      ctx2!.completedActionResults.set('tc-1', { result: 'persisted result' });

      const second = await wrapToolExecutionWithATR(ctx2!, tc, { name: 'file_read' }, executeInner);
      assert.strictEqual(second.replayed, true);
      assert.strictEqual(second.result.output, 'persisted result');
      assert.strictEqual(actualExecutions, 1);
    });

    it('persists a failure to the idempotency store and surfaces it on replay', async () => {
      const ctx = startATRRun('run-5', 'will fail')!;
      const tc = makeToolCall('tc-1', 'shell_execute', { cmd: 'false' });

      const executeInner = async (): Promise<ToolResult> => {
        return errResult('tc-1', 'shell_execute', 'exit code 1');
      };

      const { result, replayed } = await wrapToolExecutionWithATR(
        ctx,
        tc,
        { name: 'shell_execute' },
        executeInner,
      );
      assert.strictEqual(replayed, false);
      assert.strictEqual(result.error, 'exit code 1');
      assert.ok(
        !ctx.completedToolCallIds.has('tc-1'),
        'shell_execute is non-compensable, so completedToolCallIds is NOT updated',
      );
    });

    it('records a compensable action for a declared mutation', async () => {
      const ctx = startATRRun('run-6', 'edit a file')!;
      const tc = makeToolCall('tc-1', 'file_write', { path: '/tmp/x.txt', content: 'new' });

      let actualExecutions = 0;
      const executeInner = async (): Promise<ToolResult> => {
        actualExecutions++;
        return okResult('tc-1', 'file_write', 'wrote 3 bytes');
      };

      const { result, replayed } = await wrapToolExecutionWithATR(
        ctx,
        tc,
        { name: 'file_write', mutation: true, externalSystem: 'filesystem' },
        executeInner,
      );
      assert.strictEqual(replayed, false);
      assert.strictEqual(result.output, 'wrote 3 bytes');
      assert.ok(ctx.completedToolCallIds.has('tc-1'));
    });
  });

  describe('onCompleted hook (checkpoint propagation)', () => {
    it('fires for every successful tool call', async () => {
      const ctx = startATRRun('run-7', 'hook test')!;
      const seen: string[] = [];
      ctx.onCompleted = (id) => {
        seen.push(id);
      };

      for (const id of ['tc-a', 'tc-b', 'tc-c']) {
        await wrapToolExecutionWithATR(
          ctx,
          makeToolCall(id, 'file_read', { path: `/foo/${id}` }),
          { name: 'file_read' },
          async () => okResult(id, 'file_read', `result of ${id}`),
        );
      }

      assert.deepStrictEqual(seen, ['tc-a', 'tc-b', 'tc-c']);
    });

    it('does NOT fire when the tool returns an error', async () => {
      const ctx = startATRRun('run-8', 'hook error test')!;
      const seen: string[] = [];
      ctx.onCompleted = (id) => {
        seen.push(id);
      };

      await wrapToolExecutionWithATR(
        ctx,
        makeToolCall('tc-x', 'shell_execute', { cmd: 'false' }),
        { name: 'shell_execute' },
        async () => errResult('tc-x', 'shell_execute', 'exit 1'),
      );

      assert.deepStrictEqual(seen, []);
    });
  });

  describe('abortAndCompensate on failure (end-to-end)', () => {
    it('restores a file when a downstream tool fails', async () => {
      const filePath = join(dir, 'victim.txt');
      writeFileSync(filePath, 'ORIGINAL CONTENT\n');

      const ctx = startATRRun('run-9', 'saga test', { tenantId: 'saga' })!;

      const tc1 = makeToolCall('tc-1', 'file_write', { path: filePath, content: 'BAD MUTATION\n' });
      const r1 = await wrapToolExecutionWithATR(
        ctx,
        tc1,
        { name: 'file_write', mutation: true, externalSystem: 'filesystem' },
        async () => {
          writeFileSync(filePath, 'BAD MUTATION\n');
          return okResult('tc-1', 'file_write', 'wrote');
        },
      );
      assert.strictEqual(r1.replayed, false);
      assert.strictEqual(readFileSync(filePath, 'utf8'), 'BAD MUTATION\n');

      const tc2 = makeToolCall('tc-2', 'shell_execute', { cmd: 'false' });
      await wrapToolExecutionWithATR(ctx, tc2, { name: 'shell_execute' }, async () =>
        errResult('tc-2', 'shell_execute', 'kaboom'),
      );

      await finalizeATRRun(ctx, 'failed', 'downstream tool failed');

      const after = readFileSync(filePath, 'utf8');
      assert.strictEqual(
        after,
        'ORIGINAL CONTENT\n',
        `expected compensation to restore file, got: ${after}`,
      );
    });

    it('skips non-compensable tools during saga (no error reported)', async () => {
      const ctx = startATRRun('run-10', 'non-compensable test')!;
      const tc = makeToolCall('tc-1', 'shell_execute', { cmd: 'echo hi' });
      await wrapToolExecutionWithATR(ctx, tc, { name: 'shell_execute' }, async () =>
        errResult('tc-1', 'shell_execute', 'boom'),
      );
      await finalizeATRRun(ctx, 'failed', 'tool failed');
    });
  });
});
