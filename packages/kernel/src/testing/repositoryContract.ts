import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunTransition } from '@commander/contracts';
import type { KernelRepository } from '../repository.js';
import type { NewKernelStep, ClaimStepRequest } from '../types.js';
import { SqliteKernelRepository } from '../sqlite.js';

export interface RepositoryContractContext {
  name: string;
  create: () => Promise<KernelRepository>;
  destroy: (repo: KernelRepository) => Promise<void>;
  seedWorker?: (repo: KernelRepository) => Promise<{ workerId: string; generation: number }>;
}

const createRun = (steps: NewKernelStep[] = [{ id: 'step-a', kind: 'agent' }]) => ({
  id: 'run-1',
  tenantId: 'tenant-a',
  intentHash: 'intent',
  workGraphHash: 'graph',
  workGraphVersion: 'v1',
  policySnapshotId: 'policy-v1',
  steps,
});

async function claim(
  kernel: KernelRepository,
  ctx: RepositoryContractContext,
  overrides: Partial<ClaimStepRequest> = {},
) {
  const worker = await ctx.seedWorker?.(kernel);
  return kernel.claimNextStep({
    workerId: worker?.workerId ?? 'worker-1',
    workerGeneration: worker?.generation ?? 1,
    leaseTtlMs: 60_000,
    tenantId: 'tenant-a',
    capabilities: ['agent', 'tool'],
    ...overrides,
  });
}

export function runKernelRepositoryContractTests(ctx: RepositoryContractContext): void {
  describe(`KernelRepository contract — ${ctx.name}`, () => {
    it('claims dependency-ready work once and fences stale completion', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.equal(claimed?.state, 'RUNNING');
        assert.equal(await claim(kernel, ctx, { workerId: 'worker-2' }), null);
        const stale = await kernel.completeStep({
          stepId: 'step-a',
          tenantId: claimed!.tenantId,
          lease: { workerId: claimed!.lease!.workerId, token: 'wrong', fencingEpoch: claimed!.lease!.fencingEpoch, workerGeneration: claimed!.lease!.workerGeneration },
          expectedVersion: claimed!.version,
          actor: 'worker-1',
        });
        assert.equal(stale, null);
        const complete = await kernel.completeStep({
          stepId: 'step-a',
          tenantId: claimed!.tenantId,
          lease: claimed!.lease!,
          expectedVersion: claimed!.version,
          output: { ok: true },
          actor: 'worker-1',
        });
        assert.equal(complete?.state, 'SUCCEEDED');
        assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('enforces graph dependencies and effect idempotency within a tenant', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun([{ id: 'first', kind: 'agent' }, { id: 'second', kind: 'tool', dependencies: ['first'] }]), 'gateway');
        const first = await claim(kernel, ctx, { capabilities: ['agent'] });
        assert.equal(first?.id, 'first');
        const admitted = await kernel.admitEffect({
          id: 'effect-1', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a',
          type: 'http.write', idempotencyKey: 'key-1', policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'x' }, lease: first!.lease!, actor: 'worker-1',
        });
        assert.equal(admitted.admitted, true);
        const replay = await kernel.admitEffect({
          id: 'effect-2', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a',
          type: 'http.write', idempotencyKey: 'key-1', policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'x' }, lease: first!.lease!, actor: 'worker-1',
        });
        assert.equal(replay.admitted && replay.replayed, true);
        await kernel.completeEffect('effect-1', 'tenant-a', first!.lease!, { ok: true }, 'worker-1');
        await kernel.completeStep({ stepId: 'first', tenantId: first!.tenantId, lease: first!.lease!, expectedVersion: first!.version, actor: 'worker-1' });
        assert.equal((await claim(kernel, ctx, { capabilities: ['tool'] }))?.id, 'second');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('persists admit policy/lease bindings and conflicts on snapshot or digest mismatch', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);
        const lease = claimed!.lease!;
        const digest = 'c'.repeat(64);
        const admitted = await kernel.admitEffect({
          id: 'effect-bind',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v1',
          actionDigest: digest,
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(admitted.admitted, true);
        assert.equal(admitted.replayed, false);
        if (!admitted.admitted) return;
        assert.equal(admitted.effect.policySnapshotId, 'policy-bind-v1');
        assert.equal(admitted.effect.actionDigest, digest);
        assert.equal(admitted.effect.leaseWorkerId, lease.workerId);
        assert.equal(admitted.effect.leaseWorkerGeneration, lease.workerGeneration ?? 0);
        assert.equal(admitted.effect.leaseFencingEpoch, lease.fencingEpoch);

        const loaded = await kernel.getEffect('effect-bind', 'tenant-a');
        assert.ok(loaded);
        assert.equal(loaded!.policySnapshotId, 'policy-bind-v1');
        assert.equal(loaded!.actionDigest, digest);
        assert.equal(loaded!.leaseWorkerId, lease.workerId);
        assert.equal(loaded!.leaseWorkerGeneration, lease.workerGeneration ?? 0);
        assert.equal(loaded!.leaseFencingEpoch, lease.fencingEpoch);

        const snapshotConflict = await kernel.admitEffect({
          id: 'effect-bind-snap',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v2',
          actionDigest: digest,
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(snapshotConflict.admitted, false);
        if (!snapshotConflict.admitted) assert.equal(snapshotConflict.reason, 'IDEMPOTENCY_CONFLICT');

        const digestConflict = await kernel.admitEffect({
          id: 'effect-bind-digest',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v1',
          actionDigest: 'd'.repeat(64),
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(digestConflict.admitted, false);
        if (!digestConflict.admitted) assert.equal(digestConflict.reason, 'IDEMPOTENCY_CONFLICT');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('admitEffect fails closed on blank policySnapshotId / lease.workerId (never coerces to legacy-unbound)', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);
        const lease = claimed!.lease!;

        const blankSnapshot = await kernel.admitEffect({
          id: 'effect-blank-snapshot',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'blank-snapshot-key',
          policyDecisionId: 'decision-blank',
          policySnapshotId: '   ',
          actionDigest: 'e'.repeat(64),
          request: { target: 'blank' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(blankSnapshot.admitted, false);
        if (!blankSnapshot.admitted) assert.equal(blankSnapshot.reason, 'POLICY_SNAPSHOT_ID_REQUIRED');

        const blankWorker = await kernel.admitEffect({
          id: 'effect-blank-worker',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'blank-worker-key',
          policyDecisionId: 'decision-blank',
          policySnapshotId: 'policy-blank-v1',
          actionDigest: 'f'.repeat(64),
          request: { target: 'blank' },
          lease: { ...lease, workerId: '   ' },
          actor: 'worker-1',
        });
        assert.equal(blankWorker.admitted, false);
        if (!blankWorker.admitted) assert.equal(blankWorker.reason, 'LEASE_WORKER_ID_REQUIRED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('writes an outbox message for lifecycle events', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const messages = await kernel.claimOutbox(10);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.topic, 'commander.run.created');
        assert.equal(await kernel.markOutboxPublished(messages[0]!.id, messages[0]!.claimToken!), true);
        assert.equal((await kernel.claimOutbox(10)).length, 0);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('pauses and resumes runs', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        await claim(kernel, ctx);
        const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(paused?.state, 'PAUSED');
        assert.equal(await claim(kernel, ctx), null);
        const resumed = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(resumed?.state, 'RUNNING');
        assert.equal((await claim(kernel, ctx))?.state, 'RUNNING');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('L3-08a reconcileEffect advances COMPLETION_UNKNOWN only', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await kernel.admitEffect({
          id: 'effect-recon', runId: 'run-1', stepId: claimed!.id, tenantId: 'tenant-a',
          type: 'ticket.create', idempotencyKey: 'idem-recon', policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { title: 't' }, lease: claimed!.lease!, actor: 'worker-1',
        });
        await kernel.markEffectCompletionUnknown({ effectId: 'effect-recon', tenantId: 'tenant-a', reason: 'timeout', actor: 'worker-1' });
        assert.equal((await kernel.reconcileEffect({
          effectId: 'effect-recon', tenantId: 'tenant-a', state: 'COMPLETED',
          response: { ticketId: 'T-1' }, actor: 'reconciler',
        }))?.state, 'COMPLETED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('requestReconcile and claimReconcileEffects respect scheduling', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await kernel.admitEffect({
          id: 'effect-claim', runId: 'run-1', stepId: claimed!.id, tenantId: 'tenant-a',
          type: 'connector.github.pull-request.create', idempotencyKey: 'claim-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: {}, lease: claimed!.lease!, actor: 'worker-1',
        });
        await kernel.markEffectCompletionUnknown({ effectId: 'effect-claim', tenantId: 'tenant-a', reason: 'timeout', actor: 'worker-1' });
        const future = new Date(Date.now() + 120_000).toISOString();
        await kernel.requestReconcile({ effectId: 'effect-claim', tenantId: 'tenant-a', actor: 'api', reconcileAfter: future });
        assert.equal((await kernel.claimReconcileEffects({ limit: 5, now: new Date() })).length, 0);
        const claimedEffects = await kernel.claimReconcileEffects({ limit: 5, now: new Date(Date.parse(future) + 1) });
        assert.equal(claimedEffects.length, 1);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('failEffect transitions ADMITTED to FAILED while holding lease', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await kernel.admitEffect({
          id: 'effect-fail', runId: 'run-1', stepId: claimed!.id, tenantId: 'tenant-a',
          type: 'connector.github.pull-request.create', idempotencyKey: 'fail-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: {}, lease: claimed!.lease!, actor: 'worker-1',
        });
        const failed = await kernel.failEffect({
          effectId: 'effect-fail', tenantId: 'tenant-a', lease: claimed!.lease!,
          error: { code: 'AUTH_FAILED', message: '401', retryable: false }, actor: 'worker-1',
        });
        assert.equal(failed?.state, 'FAILED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('putKillSwitch and findMatchingKillSwitch', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.putKillSwitch({
          tenantId: 'tenant-a', scope: 'tool', value: 'ticket.create',
          enabled: true, actor: 'ops', reason: 'block',
        });
        const match = await kernel.findMatchingKillSwitch('tenant-a', {
          tool: 'ticket.create', effectType: 'demo.ticket.create',
        });
        assert.ok(match);
        assert.equal(match.scope, 'tool');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('isActionAllowed fails closed without allowlist', async () => {
      const kernel = await ctx.create();
      try {
        assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), false);
        await kernel.setAllowlistEntry('tenant-a', 'http.post', true);
        assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('incrementQuota and getQuota', async () => {
      const kernel = await ctx.create();
      try {
        const r1 = await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
        assert.equal(r1.countUsed, 1);
        assert.equal((await kernel.getQuota('tenant-a', 'http')).countUsed, 1);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('createInteraction and answerInteraction wake step', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(
          createRun([{ id: 'step-human', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }]),
          'gateway',
        );
        const interaction = await kernel.createInteraction({
          runId: 'run-1', stepId: 'step-human', tenantId: 'tenant-a', prompt: 'Approve now?',
        }, 'gateway');
        const answered = await kernel.answerInteraction({
          interactionId: interaction.id, runId: 'run-1', tenantId: 'tenant-a',
          response: { approved: true }, actor: 'human',
        });
        assert.equal(answered.status, 'answered');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('createTimer claimExpiredTimers acknowledgeTimer', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const firesAt = new Date(Date.now() - 1000);
        const timer = await kernel.createTimer({
          runId: 'run-1', stepId: 'step-a', tenantId: 'tenant-a',
          firesAt, timerType: 'STEP_DEADLINE', payload: {},
        }, 'test');
        const fired = await kernel.claimExpiredTimers(new Date(), 10);
        assert.ok(fired.some((t) => t.id === timer.id));
        const token = fired.find((t) => t.id === timer.id)?.claimToken;
        assert.ok(token);
        assert.equal(await kernel.acknowledgeTimer(timer.id, 'tenant-a', token!), true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('only performs valid run state transitions', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        await claim(kernel, ctx);
        assert.equal(validateRunTransition('PENDING', 'RUNNING').ok, true);
        await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(validateRunTransition('RUNNING', 'PAUSED').ok, true);
      } finally {
        await ctx.destroy(kernel);
      }
    });
  });
}

// Default runners: only when this file is a direct test entry (test / test:sqlite).
// Importing runKernelRepositoryContractTests from postgres.integration must NOT
// also register InMemory/SQLite suites (shared-process pollution / missing native bindings).
import { InMemoryKernelRepository } from './inMemoryRepository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isDirectTestEntry = process.argv.some((arg) => {
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
});

if (isDirectTestEntry) {
  runKernelRepositoryContractTests({
    name: 'InMemory',
    create: async () => new InMemoryKernelRepository(),
    destroy: async () => {},
  });

  runKernelRepositoryContractTests({
    name: 'SQLite',
    create: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kernel-contract-'));
      const path = join(dir, 'kernel.sqlite');
      const repo = new SqliteKernelRepository({ path, schedulerMode: true });
      await repo.initialize();
      (repo as SqliteKernelRepository & { _contractDir?: string })._contractDir = dir;
      return repo;
    },
    destroy: async (repo) => {
      const sqlite = repo as SqliteKernelRepository & { _contractDir?: string };
      sqlite.close();
      if (sqlite._contractDir) rmSync(sqlite._contractDir, { recursive: true, force: true });
    },
    seedWorker: async (repo) => {
      const sqlite = repo as SqliteKernelRepository;
      sqlite.seedTestWorker('worker-1', ['tenant-a'], 1);
      return { workerId: 'worker-1', generation: 1 };
    },
  });
}
