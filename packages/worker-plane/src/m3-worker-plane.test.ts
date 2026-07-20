import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ApiKeyWorkerAuthenticator, WorkerAuthError } from './apiKeyAuthenticator.js';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { EvaluatorStepExecutor } from './evaluatorStepExecutor.js';
import { CompositeStepExecutor } from './compositeStepExecutor.js';
import { InMemoryWorkerRegistry } from './registry.js';
import { WorkerExecutionError } from './types.js';
import type { ClaimedStep, StepExecutor, WorkerRecord, WorkerDefinition, WorkerIdentity } from './types.js';

// ── Helpers ──

function createMockWorker(): WorkerRecord {
  return {
    id: 'worker-1',
    kind: 'agent',
    version: '0.2.0',
    capabilities: ['agent', 'tool'],
    maxConcurrency: 10,
    status: 'ACTIVE',
    generation: 1,
    activeSteps: 0,
    identitySubject: 'test-worker',
    tenantIds: ['tenant-a'],
    registeredAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  };
}

function createMockStep(overrides?: Partial<ClaimedStep>): ClaimedStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-a',
    kind: 'tool',
    version: 1,
    attempt: 1,
    input: { toolName: 'echo', args: { message: 'hello' } },
    lease: { workerId: 'worker-1', token: 'token-1', fencingEpoch: 1, expiresAt: new Date(Date.now() + 30000).toISOString() },
    ...overrides,
  };
}

const ac = new AbortController();

// ── ApiKeyWorkerAuthenticator tests ──

describe('ApiKeyWorkerAuthenticator', () => {
  let authenticator: ApiKeyWorkerAuthenticator;
  const validToken = 'secret-token-12345678901234567890';
  const definition: WorkerDefinition = {
    id: 'worker-1', kind: 'agent', version: '0.2.0', capabilities: ['agent'], maxConcurrency: 10,
  };

  beforeEach(() => {
    authenticator = new ApiKeyWorkerAuthenticator({
      validTokens: new Set([validToken]),
      defaultTenantIds: ['tenant-a', 'tenant-b'],
      defaultCapabilities: ['agent', 'tool'],
    });
  });

  it('authenticates valid token', async () => {
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: validToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const auth = await authenticator.authenticate(identity, definition);
    assert.deepEqual(auth.tenantIds, ['tenant-a', 'tenant-b']);
    assert.deepEqual(auth.capabilities, ['agent', 'tool']);
  });

  it('rejects invalid token', async () => {
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: 'wrong-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    await assert.rejects(
      () => authenticator.authenticate(identity, definition),
      (err: WorkerAuthError) => err.code === 'TOKEN_INVALID',
    );
  });

  it('rejects expired token', async () => {
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: validToken,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await assert.rejects(
      () => authenticator.authenticate(identity, definition),
      (err: WorkerAuthError) => err.code === 'TOKEN_EXPIRED',
    );
  });

  it('rejects unauthorized capability', async () => {
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: validToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const defWithExtra: WorkerDefinition = {
      ...definition,
      capabilities: ['agent', 'evaluator'],
    };
    await assert.rejects(
      () => authenticator.authenticate(identity, defWithExtra),
      (err: WorkerAuthError) => err.code === 'CAPABILITY_DENIED',
    );
  });

  it('allows wildcard capabilities', async () => {
    const wildAuth = new ApiKeyWorkerAuthenticator({
      validTokens: new Set([validToken]),
      defaultTenantIds: ['*'],
      defaultCapabilities: ['*'],
    });
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: validToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const defAll: WorkerDefinition = {
      ...definition,
      capabilities: ['agent', 'tool', 'evaluator', 'connector', 'sandbox'],
    };
    const auth = await wildAuth.authenticate(identity, defAll);
    assert.deepEqual(auth.capabilities, ['*']);
  });

  it('supports per-token tenant override', async () => {
    const auth = new ApiKeyWorkerAuthenticator({
      validTokens: new Set([validToken]),
      defaultTenantIds: ['default-tenant'],
      defaultCapabilities: ['*'],
      tokenTenants: new Map([[validToken, ['custom-tenant-1', 'custom-tenant-2']]]),
    });
    const identity: WorkerIdentity = {
      subject: 'worker:worker-1',
      token: validToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const result = await auth.authenticate(identity, definition);
    assert.deepEqual(result.tenantIds, ['custom-tenant-1', 'custom-tenant-2']);
  });
});

// ── ToolStepExecutor tests ──

describe('ToolStepExecutor', () => {
  it('executes a tool and returns result', async () => {
    const mockRegistry = {
      get: (name: string) => name === 'echo' ? {
        execute: async (args: Record<string, unknown>) => ({ echo: args.message }),
      } : null,
    };
    const executor = new ToolStepExecutor(mockRegistry);
    const step = createMockStep();
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.ok(result);
    assert.deepEqual((result as any).result, { echo: 'hello' });
    assert.equal((result as any).toolName, 'echo');
  });

  it('throws on missing toolName', async () => {
    const executor = new ToolStepExecutor();
    const step = createMockStep({ input: { args: {} } });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'INVALID_INPUT',
    );
  });

  it('throws on unknown tool', async () => {
    const executor = new ToolStepExecutor();
    const step = createMockStep({ input: { toolName: 'nonexistent', args: {} } });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'TOOL_NOT_FOUND',
    );
  });

  it('handles tool execution errors', async () => {
    const mockRegistry = {
      get: () => ({
        execute: async () => { throw new Error('Connection refused'); },
      }),
    };
    const executor = new ToolStepExecutor(mockRegistry);
    const step = createMockStep();
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'TOOL_EXECUTION_FAILED',
    );
  });

  it('fails closed for external effects when no broker is configured', async () => {
    let invoked = false;
    const executor = new ToolStepExecutor({ get: () => ({ execute: async () => { invoked = true; return {}; } }) });
    const step = createMockStep({ input: { toolName: 'http.post', args: {}, hasExternalEffects: true, effectId: 'effect-1', idempotencyKey: 'idem-1', capabilityToken: 'token' } });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'EFFECT_BROKER_UNAVAILABLE',
    );
    assert.equal(invoked, false);
  });

  it('routes external effects through the broker instead of invoking the tool handler', async () => {
    let invoked = false;
    let brokerInput: Record<string, unknown> | undefined;
    const executor = new ToolStepExecutor(
      { get: () => ({ execute: async () => { invoked = true; return {}; } }) },
      { execute: async (input) => { brokerInput = input as unknown as Record<string, unknown>; return { effectId: input.effectId, replayed: false, response: { accepted: true } }; } },
    );
    const step = createMockStep({ input: { toolName: 'http.post', args: { url: 'https://example.test' }, hasExternalEffects: true, effectId: 'effect-1', idempotencyKey: 'idem-1', capabilityToken: 'cap-token' } });
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.deepEqual((result as any).result, { accepted: true });
    assert.equal(invoked, false);
    assert.equal(brokerInput?.type, 'http.post');
  });

  it('aborts the tool handler signal on timeout instead of only racing the promise', async () => {
    let sawAbort = false;
    const mockRegistry = {
      get: () => ({
        execute: async (_args: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
          await new Promise<void>((resolve, reject) => {
            if (ctx.signal.aborted) {
              sawAbort = true;
              reject(new Error('aborted early'));
              return;
            }
            ctx.signal.addEventListener(
              'abort',
              () => {
                sawAbort = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
          return { never: true };
        },
      }),
    };
    const executor = new ToolStepExecutor(mockRegistry);
    const step = createMockStep({ input: { toolName: 'slow', args: {}, timeoutMs: 30 } });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'TIMEOUT' && err.options.retryable === true,
    );
    assert.equal(sawAbort, true);
  });
});

// ── EvaluatorStepExecutor tests ──

describe('EvaluatorStepExecutor', () => {
  it('evaluates with rules and passes', async () => {
    const executor = new EvaluatorStepExecutor();
    const step = createMockStep({
      kind: 'evaluator',
      input: {
        subject: { name: 'test', value: 42 },
        method: 'rules',
        minScore: 0.5,
        criteria: {
          rules: [
            { name: 'has-name', path: 'name', check: 'exists', weight: 1 },
            { name: 'value-is-42', path: 'value', check: 'equals', expected: 42, weight: 1 },
          ],
        },
      },
    });
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.ok(result);
    assert.equal((result as any).passed, true);
    assert.equal((result as any).score, 1.0);
  });

  it('evaluates with rules and fails', async () => {
    const executor = new EvaluatorStepExecutor();
    const step = createMockStep({
      kind: 'evaluator',
      input: {
        subject: { name: 'test' },
        method: 'rules',
        minScore: 0.8,
        criteria: {
          rules: [
            { name: 'has-name', path: 'name', check: 'exists', weight: 1 },
            { name: 'has-value', path: 'value', check: 'exists', weight: 1 },
          ],
        },
      },
    });
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.equal((result as any).passed, false);
    assert.equal((result as any).score, 0.5);
  });

  it('passes with no rules', async () => {
    const executor = new EvaluatorStepExecutor();
    const step = createMockStep({
      kind: 'evaluator',
      input: {
        subject: {},
        method: 'rules',
        criteria: { rules: [] },
      },
    });
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.equal((result as any).passed, true);
    assert.equal((result as any).score, 1.0);
  });

  it('throws on missing criteria', async () => {
    const executor = new EvaluatorStepExecutor();
    const step = createMockStep({
      kind: 'evaluator',
      input: { subject: {} },
    });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'INVALID_INPUT',
    );
  });

  it('supports minLength and maxLength checks', async () => {
    const executor = new EvaluatorStepExecutor();
    const step = createMockStep({
      kind: 'evaluator',
      input: {
        subject: { description: 'hello world' },
        method: 'rules',
        minScore: 0.5,
        criteria: {
          rules: [
            { name: 'min-length', path: 'description', check: 'minLength', expected: 5, weight: 1 },
            { name: 'max-length', path: 'description', check: 'maxLength', expected: 100, weight: 1 },
          ],
        },
      },
    });
    const result = await executor.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.equal((result as any).passed, true);
  });
});

// ── CompositeStepExecutor tests ──

describe('CompositeStepExecutor', () => {
  it('routes to correct executor based on kind', async () => {
    const toolExecutor = new ToolStepExecutor({
      get: () => ({ execute: async () => 'tool-result' }),
    });
    const evalExecutor = new EvaluatorStepExecutor();
    const composite = new CompositeStepExecutor(new Map<string, StepExecutor>([
      ['tool', toolExecutor],
      ['evaluator', evalExecutor],
    ]));

    // Tool step
    const toolStep = createMockStep({ kind: 'tool' });
    const toolResult = await composite.execute(toolStep, { signal: ac.signal, worker: createMockWorker() });
    assert.ok(toolResult);

    // Evaluator step
    const evalStep = createMockStep({
      kind: 'evaluator',
      input: { subject: {}, method: 'rules', criteria: { rules: [] } },
    });
    const evalResult = await composite.execute(evalStep, { signal: ac.signal, worker: createMockWorker() });
    assert.ok(evalResult);
  });

  it('throws on unknown kind', async () => {
    const composite = new CompositeStepExecutor(new Map<string, StepExecutor>([
      ['tool', new ToolStepExecutor()],
    ]));
    const step = createMockStep({ kind: 'sandbox' });
    await assert.rejects(
      () => composite.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: WorkerExecutionError) => err.options.code === 'NO_EXECUTOR',
    );
  });

  it('supports runtime registration', async () => {
    const composite = new CompositeStepExecutor(new Map());
    composite.register('tool', new ToolStepExecutor({
      get: () => ({ execute: async () => 'ok' }),
    }));
    const step = createMockStep({ kind: 'tool' });
    const result = await composite.execute(step, { signal: ac.signal, worker: createMockWorker() });
    assert.ok(result);
  });
});
