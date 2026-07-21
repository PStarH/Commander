import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  githubPrBodyMarker,
  servicenowCorrelationId,
} from '@commander/contracts';
import {
  AdapterExecutionError,
  buildEffectEvidenceBundle,
  verifyEvidenceBundle,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  type EffectExecutor,
  type EffectKernelPort,
} from '@commander/effect-broker';
import type { ActionAdapter } from '../types.js';
import { toEvidenceSummary } from '../types.js';
import { ActionAdapterRegistry } from '../registry.js';
import { buildConformanceIssueInput } from './grantFixture.js';

export interface ConformanceRemoteCounters {
  createCount: number;
  writeCount: number;
  compensateCount: number;
}

export interface ConformanceAdapterContext {
  adapter: ActionAdapter;
  counters: ConformanceRemoteCounters;
  destination: string;
  executeArgs: Record<string, unknown>;
  queryRequest: Record<string, unknown>;
  compensationPatch: Record<string, unknown>;
}

export interface ConformanceAdapterFactory {
  readonly name: string;
  createAdapter(): ConformanceAdapterContext;
  createAuthFailureAdapter?(): ActionAdapter;
  createMultiMarkerContext?(): ConformanceAdapterContext;
}

export interface ConformanceSuiteOptions {
  factory: ConformanceAdapterFactory;
}

const tenantId = 'tenant-a';
const idempotencyKey = 'conformance-idem';

function baseExecuteInput(ctx: ConformanceAdapterContext, args?: Record<string, unknown>) {
  return {
    tenantId,
    effectId: 'eff-conformance-1',
    idempotencyKey,
    destination: ctx.destination,
    args: args ?? ctx.executeArgs,
    signal: AbortSignal.timeout(10_000),
  };
}

function adapterExecutor(adapter: ActionAdapter): EffectExecutor {
  return {
    execute: async (input) => {
      const ctx = input.executionContext;
      if (!ctx?.tenantId || !ctx.effectId || typeof input.request.idempotencyKey !== 'string') {
        throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      }
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        return adapter.compensate({
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(
            (input.request as Record<string, unknown>).originalEffectId ?? '',
          ),
          idempotencyKey: input.request.idempotencyKey,
          destination,
          forwardResponse:
            ((input.request as Record<string, unknown>).forwardResponse as Record<string, unknown>) ??
            {},
          compensationPatch:
            ((input.request as Record<string, unknown>).compensationPatch as Record<string, unknown>) ??
            {},
          signal: input.signal,
        });
      }
      return adapter.execute({
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey: input.request.idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      });
    },
  };
}

function createChaosKernel(): {
  kernel: EffectKernelPort;
  getState: () => string;
} {
  const effects = new Map<
    string,
    {
      id: string;
      state: string;
      type: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
      response?: Record<string, unknown>;
      runId: string;
      stepId: string;
      tenantId: string;
    }
  >();
  const byKey = new Map<string, string>();
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => {
      const key = `${input.tenantId}:${input.idempotencyKey}`;
      const priorId = byKey.get(key);
      if (priorId) {
        return { admitted: true, replayed: true, effect: { ...effects.get(priorId)! } };
      }
      const effect = {
        id: input.id,
        state: 'ADMITTED',
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        request: input.request,
        runId: input.runId,
        stepId: input.stepId,
        tenantId: input.tenantId,
      };
      effects.set(effect.id, effect);
      byKey.set(key, effect.id);
      return { admitted: true, replayed: false, effect: { ...effect } };
    },
    completeEffect: async () => null,
    markEffectCompletionUnknown: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'ADMITTED') return null;
      effect.state = 'COMPLETION_UNKNOWN';
      return { ...effect };
    },
    getEffect: async (effectId, tenantId) => {
      const effect = effects.get(effectId);
      if (!effect || effect.tenantId !== tenantId) return null;
      return { ...effect };
    },
    reconcileEffect: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'COMPLETION_UNKNOWN') {
        return null;
      }
      effect.state = input.state;
      effect.response = input.response;
      return { ...effect };
    },
  };
  return {
    kernel,
    getState: () => effects.get('eff-conformance-chaos')?.state ?? 'MISSING',
  };
}

async function runTimeoutReconcileScenario(ctx: ConformanceAdapterContext): Promise<void> {
  const registry = new ActionAdapterRegistry([ctx.adapter]);
  const executor = adapterExecutor(ctx.adapter);
  const { kernel, getState } = createChaosKernel();
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'conformance',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { conformance: issuer.publicKey },
  });
  const request = {
    destination: ctx.destination,
    idempotencyKey,
    args: ctx.executeArgs,
  };
  const broker = new EffectBroker(
    tokens,
    {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'conformance',
        policySnapshotId: 'policy',
        reason: 'ok',
      }),
    },
    kernel,
    executor,
    { append: async () => {} },
    // 保持默认 requireRequestBinding=true；token 已绑定 canonicalRequestHash
    { localWorkerId: 'worker-1' },
  );
  const token = issuer.issue(
    buildConformanceIssueInput({
      jti: 'jti-conformance-chaos',
      tenantId,
      runId: 'run-conformance',
      stepId: 'step-conformance',
      effectTypes: [ctx.adapter.descriptor.effectType],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(request),
    }),
  );
  await assert.rejects(
    () =>
      broker.execute({
        effectId: 'eff-conformance-chaos',
        token,
        type: ctx.adapter.descriptor.effectType,
        request,
        idempotencyKey,
        lease: { workerId: 'worker-1', token: 'lease', fencingEpoch: 1 },
        actor: 'worker-1',
      }),
    (error: unknown) =>
      error instanceof EffectBrokerError && error.code === 'COMPLETION_UNCONFIRMED',
  );
  assert.equal(getState(), 'COMPLETION_UNKNOWN');
  const querier = registry.outcomeQuerierFor(ctx.adapter.descriptor.effectType);
  assert.ok(querier);
  const reconciled = await broker.reconcileUnknown({
    effectId: 'eff-conformance-chaos',
    tenantId,
    actor: 'conformance-reconciler',
    querier,
  });
  assert.equal(reconciled.status, 'COMPLETED');
  assert.equal(reconciled.invokedExecutor, false);
  assert.equal(getState(), 'COMPLETED');
}

export function registerConformanceSuite(options: ConformanceSuiteOptions): void {
  const { factory } = options;

  describe(`L4-02 conformance — ${factory.name}`, () => {
    it('C1 double execute creates one remote resource', async () => {
      const ctx = factory.createAdapter();
      const input = baseExecuteInput(ctx);
      await ctx.adapter.execute(input);
      await ctx.adapter.execute(input);
      assert.equal(ctx.counters.createCount, 1);
    });

    it('C2 queryOutcome performs no write', async () => {
      const ctx = factory.createAdapter();
      await ctx.adapter.execute(baseExecuteInput(ctx));
      const writesBefore = ctx.counters.writeCount;
      await ctx.adapter.queryOutcome({
        tenantId,
        effectId: 'eff-conformance-1',
        idempotencyKey,
        destination: ctx.destination,
        request: ctx.queryRequest,
      });
      assert.equal(ctx.counters.writeCount, writesBefore);
    });

    it('C7 destination mismatch denies via manifest evaluation', () => {
      const descriptor = factory.createAdapter().adapter.descriptor;
      const mismatched =
        descriptor.adapterId === 'github.pull-request.create'
          ? 'github://octo/repo/issues'
          : 'servicenow://dev12345/change_request';
      assert.equal(
        findAdapterManifest({
          effectType: descriptor.effectType,
          toolName: descriptor.toolName,
          destination: mismatched,
        }),
        null,
      );
      assert.equal(evaluateManifestGatewayEffect(descriptor, mismatched), 'deny');
    });

    it('C8 unregistered tool/effect denies via manifest lookup', () => {
      const descriptor = factory.createAdapter().adapter.descriptor;
      assert.equal(
        findAdapterManifest({
          effectType: 'demo.ticket.create',
          toolName: 'ticket.create',
          destination:
            descriptor.adapterId === 'github.pull-request.create'
              ? 'github://octo/repo/pulls'
              : 'servicenow://dev12345/incident',
        }),
        null,
      );
    });

    it('C9 401/403 map to NOT_COMMITTED terminal classification', async () => {
      const ctx = factory.createAdapter();
      const adapter = factory.createAuthFailureAdapter?.() ?? ctx.adapter;
      await assert.rejects(
        () => adapter.execute(baseExecuteInput(ctx)),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.commitState, 'NOT_COMMITTED');
          assert.equal(error.retryMode, 'NEVER');
          return true;
        },
      );
    });

    it('C11 multi-marker queryOutcome returns UNKNOWN for escalation', async () => {
      const ctx = factory.createMultiMarkerContext?.();
      if (!ctx) return;
      const outcome = await ctx.adapter.queryOutcome({
        tenantId,
        effectId: 'eff-conformance-multi',
        idempotencyKey,
        destination: ctx.destination,
        request: ctx.queryRequest,
      });
      assert.equal(outcome.status, 'UNKNOWN');
    });

    it('C12 evidence summary passes DLP verification', async () => {
      const ctx = factory.createAdapter();
      const response = await ctx.adapter.execute(baseExecuteInput(ctx));
      const summary = toEvidenceSummary(ctx.adapter.descriptor, {
        ...response,
        token: 'must-not-appear',
        authorization: 'Bearer secret',
        args: { password: 'leak' },
      });
      const bundle = buildEffectEvidenceBundle({
        tenantId,
        runId: 'run-1',
        effectId: 'eff-1',
        policySnapshotId: 'ps-1',
        effects: [
          {
            id: 'eff-1',
            runId: 'run-1',
            stepId: 'step-1',
            tenantId,
            type: ctx.adapter.descriptor.effectType,
            state: 'COMPLETED',
            policyDecisionId: 'pd-1',
            requestHash: 'hash-1',
            request: { destination: ctx.destination },
            response: { ...summary },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        auditEvents: [],
      });
      const verification = verifyEvidenceBundle(bundle);
      assert.equal(verification.ok, true);
      const serialized = JSON.stringify(bundle);
      assert.equal(serialized.includes('must-not-appear'), false);
      assert.equal(serialized.includes('Bearer secret'), false);
    });

    it('C3 timeout reconcile COMPLETED', async () => {
      const ctx = factory.createAdapter();
      await runTimeoutReconcileScenario(ctx);
    });

    it('C4 reconcile no extra create', async () => {
      const ctx = factory.createAdapter();
      await runTimeoutReconcileScenario(ctx);
      assert.equal(ctx.counters.createCount, 1);
    });

    it('C5 double compensate one remote change', async () => {
      const ctx = factory.createAdapter();
      const forward = await ctx.adapter.execute(baseExecuteInput(ctx));
      const compensateInput = {
        tenantId,
        effectId: 'eff-conformance-cmp',
        originalEffectId: 'eff-conformance-1',
        idempotencyKey: 'cmp:eff-conformance-1:1.0.0',
        destination: ctx.destination,
        forwardResponse: forward,
        compensationPatch: ctx.compensationPatch,
        signal: AbortSignal.timeout(10_000),
      };
      await ctx.adapter.compensate(compensateInput);
      await ctx.adapter.compensate(compensateInput);
      assert.equal(ctx.counters.compensateCount, 1);
    });
  });
}

export { githubPrBodyMarker, servicenowCorrelationId };
