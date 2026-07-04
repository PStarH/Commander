import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Readable, Writable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleAtrHttpRequest, type AtrHttpDeps } from '../../src/atr/atrHttp';
import { ExecutionScheduler } from '../../src/atr/scheduler';
import { RunLedger } from '../../src/atr/runLedger';
import { LeaseManager } from '../../src/atr/leaseManager';
import { IdempotencyStore, resetIdempotencyStore } from '../../src/atr/idempotencyStore';
import { resetRunLedgerBundle } from '../../src/atr/runLedger';

class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.body += chunk.toString('utf-8');
    cb();
  }
  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(chunk?: string | Buffer): this {
    if (chunk) this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    return this;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body || '{}');
  }
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const stream = new Readable({ read() {} });
  if (body !== undefined) {
    stream.push(JSON.stringify(body));
    stream.push(null);
  } else {
    stream.push(null);
  }
  (stream as IncomingMessage & { method: string }).method = method;
  return stream as IncomingMessage;
}

interface Stack {
  scheduler: ExecutionScheduler;
  lm: LeaseManager;
  idem: IdempotencyStore;
  ledger: RunLedger;
  close: () => void;
}

function makeStack(tenantId?: string): Stack {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  resetRunLedgerBundle();
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
  const scheduler = new ExecutionScheduler({ lease: lm, idempotency: idem, ledger });
  return {
    scheduler,
    lm,
    idem,
    ledger,
    close: () => {
      lm.close();
      idem.close();
      ledger.close();
    },
  };
}

function makeDeps(stack: Stack, tenantId: string | undefined): AtrHttpDeps {
  return {
    scheduler: stack.scheduler,
    resolveTenant: () => tenantId,
  };
}

async function dispatch(
  deps: AtrHttpDeps,
  method: string,
  segments: string[],
  body?: unknown,
  queryStr = '',
): Promise<{ res: MockRes; result: { handled: boolean; status: number } }> {
  const req = makeReq(method, body);
  const res = new MockRes();
  const result = await handleAtrHttpRequest(req, res, deps, segments, queryStr, {
    maxBodyBytes: 1024 * 1024,
  });
  return { res, result };
}

describe('ATR HTTP router', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    resetRunLedgerBundle();
  });

  afterEach(() => {
    resetIdempotencyStore();
    resetRunLedgerBundle();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  describe('dispatching', () => {
    it('returns handled=false for non-atr paths', async () => {
      const stack = makeStack();
      try {
        const { result } = await dispatch(makeDeps(stack, undefined), 'GET', ['mcp']);
        assert.strictEqual(result.handled, false);
      } finally {
        stack.close();
      }
    });

    it('returns handled=false for unknown atr subroutes', async () => {
      const stack = makeStack();
      try {
        const { result } = await dispatch(makeDeps(stack, undefined), 'GET', ['atr', 'unknown']);
        assert.strictEqual(result.handled, false);
      } finally {
        stack.close();
      }
    });
  });

  describe('POST /api/v1/atr/runs (beginRun)', () => {
    it('creates a new run and returns 201 with handle', async () => {
      const stack = makeStack();
      try {
        const { res, result } = await dispatch(
          makeDeps(stack, 'tenant-a'),
          'POST',
          ['atr', 'runs'],
          { runId: 'http-1', goal: 'fix bug', metadata: { source: 'http' } },
        );
        assert.strictEqual(result.handled, true);
        assert.strictEqual(result.status, 201);
        const body = res.json();
        assert.strictEqual(body.runId, 'http-1');
        assert.strictEqual(body.state, 'EXECUTING');
        assert.strictEqual(body.acquired, true);
        assert.ok(body.leaseToken);
        assert.strictEqual(body.tenantId, 'tenant-a');
      } finally {
        stack.close();
      }
    });

    it('returns 400 when goal is missing', async () => {
      const stack = makeStack();
      try {
        const { res, result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs'],
          {},
        );
        assert.strictEqual(result.status, 400);
        assert.match(res.body, /goal is required/);
      } finally {
        stack.close();
      }
    });

    it('returns 400 on invalid JSON', async () => {
      const stack = makeStack();
      try {
        const stream = new Readable({ read() {} });
        stream.push('not-json');
        stream.push(null);
        (stream as IncomingMessage & { method: string }).method = 'POST';
        const res = new MockRes();
        await handleAtrHttpRequest(
          stream as IncomingMessage,
          res,
          makeDeps(stack, undefined),
          ['atr', 'runs'],
          '',
          { maxBodyBytes: 1024 * 1024 },
        );
        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body, /Invalid JSON/);
      } finally {
        stack.close();
      }
    });
  });

  describe('GET /api/v1/atr/runs (list)', () => {
    it('returns all runs for the tenant', async () => {
      const stack = makeStack('tenant-a');
      try {
        await dispatch(makeDeps(stack, 'tenant-a'), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        await dispatch(makeDeps(stack, 'tenant-a'), 'POST', ['atr', 'runs'], {
          runId: 'r-2',
          goal: 'g',
        });

        const { res, result } = await dispatch(makeDeps(stack, 'tenant-a'), 'GET', ['atr', 'runs']);
        assert.strictEqual(result.status, 200);
        const body = res.json();
        const ids = (body.runs as Array<{ runId: string }>).map((r) => r.runId);
        assert.ok(ids.includes('r-1'));
        assert.ok(ids.includes('r-2'));
      } finally {
        stack.close();
      }
    });

    it('filters by ?state=', async () => {
      const stack = makeStack();
      try {
        const begin = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const h = begin.res.json();
        await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs', 'r-1', 'commit'], {
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
        });

        const { res } = await dispatch(
          makeDeps(stack, undefined),
          'GET',
          ['atr', 'runs'],
          undefined,
          'state=COMMITTED',
        );
        const body = res.json();
        const states = (body.runs as Array<{ state: string }>).map((r) => r.state);
        assert.ok(states.every((s) => s === 'COMMITTED'));
      } finally {
        stack.close();
      }
    });
  });

  describe('GET /api/v1/atr/runs/:runId', () => {
    it('returns run with full action history', async () => {
      const stack = makeStack();
      try {
        const begin = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const h = begin.res.json();

        const sched = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {});
        void sched;

        const stack2 = makeStack();
        try {
          const s2 = new ExecutionScheduler({
            lease: stack2.lm,
            idempotency: stack2.idem,
            ledger: stack2.ledger,
            bridge: stack2.bridge,
          });
          const handle = s2.beginRun({ runId: 'r-2', goal: 'g' });
          const a = s2.scheduleAction({
            runId: handle.runId,
            leaseToken: handle.leaseToken,
            fencingEpoch: handle.fencingEpoch,
            toolName: 't',
            externalSystem: 's',
            args: { x: 1 },
            idempotencyKey: 'k1',
            compensable: true,
          });
          s2.recordResult({
            runId: handle.runId,
            leaseToken: handle.leaseToken,
            fencingEpoch: handle.fencingEpoch,
            actionId: a.actionId,
            result: 'ok',
          });

          const deps2 = makeDeps(stack2, undefined);
          const res = new MockRes();
          await handleAtrHttpRequest(makeReq('GET'), res, deps2, ['atr', 'runs', 'r-2'], '', {
            maxBodyBytes: 1024 * 1024,
          });
          assert.strictEqual(res.statusCode, 200);
          const body = res.json();
          assert.strictEqual(body.runId, 'r-2');
          assert.strictEqual(body.actions.length, 1);
          assert.strictEqual(body.actions[0].toolName, 't');
          assert.strictEqual(body.actions[0].result, 'ok');
        } finally {
          stack2.close();
        }
      } finally {
        stack.close();
      }
    });

    it('returns 404 for unknown run', async () => {
      const stack = makeStack();
      try {
        const { res, result } = await dispatch(makeDeps(stack, undefined), 'GET', [
          'atr',
          'runs',
          'missing',
        ]);
        assert.strictEqual(result.status, 404);
      } finally {
        stack.close();
      }
    });
  });

  describe('POST /api/v1/atr/runs/:runId/commit', () => {
    it('commits and returns 200 with committed=true', async () => {
      const stack = makeStack();
      try {
        const begin = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const h = begin.res.json();

        const { res, result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs', 'r-1', 'commit'],
          { leaseToken: h.leaseToken, fencingEpoch: h.fencingEpoch },
        );
        assert.strictEqual(result.status, 200);
        assert.strictEqual(res.json().committed, true);
      } finally {
        stack.close();
      }
    });

    it('returns 409 on stale lease', async () => {
      const stack = makeStack();
      try {
        await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const { result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs', 'r-1', 'commit'],
          { leaseToken: 'fake', fencingEpoch: 999 },
        );
        assert.strictEqual(result.status, 409);
      } finally {
        stack.close();
      }
    });

    it('returns 400 when body missing required fields', async () => {
      const stack = makeStack();
      try {
        const { result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs', 'r-1', 'commit'],
          { leaseToken: 'x' },
        );
        assert.strictEqual(result.status, 400);
      } finally {
        stack.close();
      }
    });
  });

  describe('POST /api/v1/atr/runs/:runId/abort', () => {
    it('aborts and runs saga compensation', async () => {
      const stack = makeStack();
      try {
        const begin = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const h = begin.res.json();
        const a = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'tool_x',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        stack.scheduler.registerCompensation('tool_x', async () => ({ success: true }));
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'r',
        });

        const { res, result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs', 'r-1', 'abort'],
          { leaseToken: h.leaseToken, fencingEpoch: h.fencingEpoch, reason: 'http cancel' },
        );
        assert.strictEqual(result.status, 200);
        const body = res.json();
        assert.strictEqual(body.aborted, true);
        assert.strictEqual(body.outcome.succeeded, 1);
      } finally {
        stack.close();
      }
    });
  });

  describe('POST /api/v1/atr/runs/:runId/kill', () => {
    it('releases lease without compensation', async () => {
      const stack = makeStack();
      try {
        const begin = await dispatch(makeDeps(stack, undefined), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        const h = begin.res.json();

        const { res, result } = await dispatch(
          makeDeps(stack, undefined),
          'POST',
          ['atr', 'runs', 'r-1', 'kill'],
          { leaseToken: h.leaseToken, fencingEpoch: h.fencingEpoch },
        );
        assert.strictEqual(result.status, 200);
        assert.strictEqual(res.json().killed, true);
      } finally {
        stack.close();
      }
    });
  });

  describe('GET /api/v1/atr/audit', () => {
    it('returns recent actions across runs', async () => {
      const stack = makeStack();
      try {
        const h = stack.scheduler.beginRun({ runId: 'r-1', goal: 'g' });
        const a = stack.scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        stack.scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'r',
        });

        const { res, result } = await dispatch(makeDeps(stack, undefined), 'GET', ['atr', 'audit']);
        assert.strictEqual(result.status, 200);
        const body = res.json();
        assert.ok(body.count >= 1);
        assert.ok(body.actions[0].toolName);
      } finally {
        stack.close();
      }
    });
  });

  describe('tenant isolation', () => {
    it('tenant A cannot see tenant B runs (resolver returns A only)', async () => {
      const stack = makeStack();
      try {
        await dispatch(makeDeps(stack, 'tenant-a'), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });
        await dispatch(makeDeps(stack, 'tenant-b'), 'POST', ['atr', 'runs'], {
          runId: 'r-1',
          goal: 'g',
        });

        const { res: resA } = await dispatch(makeDeps(stack, 'tenant-a'), 'GET', [
          'atr',
          'runs',
          'r-1',
        ]);
        const bodyA = resA.json();
        assert.strictEqual(bodyA.tenantId, 'tenant-a', 'tenant A sees only its own record');

        const { res: resB } = await dispatch(makeDeps(stack, 'tenant-b'), 'GET', [
          'atr',
          'runs',
          'r-1',
        ]);
        const bodyB = resB.json();
        assert.strictEqual(bodyB.tenantId, 'tenant-b');
      } finally {
        stack.close();
      }
    });
  });

  describe('GET /api/v1/atr/policy/decisions', () => {
    it('returns policy decisions filtered by runId', async () => {
      const { resetSecurityAuditLogger, getSecurityAuditLogger } =
        await import('../../src/security/securityAuditLogger');
      resetSecurityAuditLogger();
      const stack = makeStack();
      try {
        const { res: r1 } = await dispatch(makeDeps(stack, 'tenant-x'), 'POST', ['atr', 'runs'], {
          runId: 'r-pol-1',
          goal: 'policy test',
        });
        assert.strictEqual(r1.statusCode, 201);

        const audit = getSecurityAuditLogger();
        audit.logEvent({
          type: 'policy_decision' as never,
          severity: 'high',
          source: 'PolicyEngine:defaultCoding@1',
          message: 'deny: shell command',
          context: { runId: 'r-pol-1', tenantId: 'tenant-x' },
          details: { effect: 'deny', decisionId: 'd-1' },
        });
        audit.logEvent({
          type: 'policy_decision' as never,
          severity: 'low',
          source: 'PolicyEngine:defaultCoding@1',
          message: 'allow: read',
          context: { runId: 'r-other', tenantId: 'tenant-x' },
          details: { effect: 'allow' },
        });
        audit.logEvent({
          type: 'approval_denied' as never,
          severity: 'medium',
          source: 'ApprovalSystem',
          message: 'legacy denied',
          context: { runId: 'r-pol-1', tenantId: 'tenant-x' },
        });

        const { res } = await dispatch(
          makeDeps(stack, 'tenant-x'),
          'GET',
          ['atr', 'policy', 'decisions'],
          undefined,
          '?runId=r-pol-1',
        );
        const body = res.json();
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(body.count, 1, 'only PolicyEngine events for r-pol-1');
        assert.strictEqual(body.decisions[0].details.decisionId, 'd-1');
      } finally {
        stack.close();
      }
    });

    it('returns empty array when no policy decisions match', async () => {
      const { resetSecurityAuditLogger } = await import('../../src/security/securityAuditLogger');
      resetSecurityAuditLogger();
      const stack = makeStack();
      try {
        const { res } = await dispatch(makeDeps(stack, 'tenant-y'), 'GET', [
          'atr',
          'policy',
          'decisions',
        ]);
        const body = res.json();
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(body.count, 0);
        assert.deepStrictEqual(body.decisions, []);
      } finally {
        stack.close();
      }
    });
  });
});
