import { createHash } from 'node:crypto';
import type { KernelRepository } from '../repository.js';
import type { ClaimStepRequest, NewKernelStep } from '../types.js';

export interface KernelTranscriptOptions {
  clock: { now: () => string };
  ids: { uuid: () => string };
}

export interface KernelTranscriptEntry {
  kind: 'event' | 'effect' | 'step' | 'error';
  name: string;
  payload: Record<string, unknown>;
}

const TENANT = 'tenant-transcript';
const ACTOR = 'transcript';

function createRun(
  runId: string,
  steps?: NewKernelStep[],
) {
  const defaultSteps: NewKernelStep[] = [{ id: `${runId}-step-a`, kind: 'agent' }];
  return {
    id: runId,
    tenantId: TENANT,
    intentHash: 'intent',
    workGraphHash: 'graph',
    workGraphVersion: 'v1',
    policySnapshotId: 'policy-v1',
    steps: steps ?? defaultSteps,
  };
}

async function claim(
  kernel: KernelRepository,
  worker: { workerId: string; generation: number },
  overrides: Partial<ClaimStepRequest> = {},
) {
  return kernel.claimNextStep({
    workerId: worker.workerId,
    workerGeneration: worker.generation,
    leaseTtlMs: 60_000,
    tenantId: TENANT,
    capabilities: ['agent', 'tool'],
    ...overrides,
  });
}

function pushEvent(
  entries: KernelTranscriptEntry[],
  events: Awaited<ReturnType<KernelRepository['listEvents']>>,
) {
  for (const event of events) {
    entries.push({
      kind: 'event',
      name: event.type,
      payload: { ...(event.payload as Record<string, unknown>), runId: event.runId },
    });
  }
}

export async function runKernelTranscriptScenarios(
  repository: KernelRepository,
  options: KernelTranscriptOptions,
): Promise<KernelTranscriptEntry[]> {
  const entries: KernelTranscriptEntry[] = [];
  const worker = { workerId: 'worker-transcript', generation: 1 };
  const seedWorker = repository as KernelRepository & {
    seedTestWorker?: (id: string, tenants: string[], generation: number) => void;
  };
  seedWorker.seedTestWorker?.(worker.workerId, [TENANT], worker.generation);

  // T1 — createRun → claim → complete step
  await repository.createRun(createRun('run-t1'), ACTOR);
  const claimedT1 = await claim(repository, worker);
  entries.push({ kind: 'step', name: 'claimed', payload: { stepId: claimedT1?.id, state: claimedT1?.state } });
  if (claimedT1?.lease) {
    const completed = await repository.completeStep({
      stepId: claimedT1.id,
      tenantId: claimedT1.tenantId,
      lease: claimedT1.lease,
      expectedVersion: claimedT1.version,
      output: { ok: true },
      actor: worker.workerId,
    });
    entries.push({ kind: 'step', name: 'completed', payload: { stepId: completed?.id, state: completed?.state } });
  }
  pushEvent(entries, await repository.listEvents('run-t1', TENANT));

  // T2 — admitEffect → completeEffect
  await repository.createRun(createRun('run-t2'), ACTOR);
  const claimedT2 = await claim(repository, worker);
  if (claimedT2?.lease) {
    const admitted = await repository.admitEffect({
      id: options.ids.uuid(),
      runId: 'run-t2',
      stepId: claimedT2.id,
      tenantId: TENANT,
      type: 'demo.ticket.create',
      idempotencyKey: 't2-key',
      policyDecisionId: 'pd-t2',
      request: { title: 't2' },
      lease: claimedT2.lease,
      actor: worker.workerId,
    });
    if (admitted.admitted) {
      entries.push({
        kind: 'effect',
        name: 'admitted',
        payload: { admitted: true, replayed: admitted.replayed },
      });
      const effectId = admitted.effect.id;
      await repository.completeEffect(effectId, TENANT, claimedT2.lease, { ok: true }, worker.workerId);
      const effect = await repository.getEffect(effectId, TENANT);
      entries.push({ kind: 'effect', name: 'terminal', payload: { state: effect?.state } });
    }
  }

  // T3 — UNKNOWN → requestReconcile → reconcileEffect COMPLETED
  await repository.createRun(createRun('run-t3'), ACTOR);
  const claimedT3 = await claim(repository, worker);
  const effectT3 = options.ids.uuid();
  if (claimedT3?.lease) {
    await repository.admitEffect({
      id: effectT3,
      runId: 'run-t3',
      stepId: claimedT3.id,
      tenantId: TENANT,
      type: 'connector.github.pull-request.create',
      idempotencyKey: 't3-key',
      policyDecisionId: 'pd-t3',
      request: {},
      lease: claimedT3.lease,
      actor: worker.workerId,
    });
    await repository.markEffectCompletionUnknown({
      effectId: effectT3,
      tenantId: TENANT,
      reason: 'timeout',
      actor: worker.workerId,
    });
    const unknown = await repository.getEffect(effectT3, TENANT);
    entries.push({ kind: 'effect', name: 'unknown', payload: { state: unknown?.state } });
    await repository.requestReconcile({
      effectId: effectT3,
      tenantId: TENANT,
      actor: ACTOR,
      reconcileAfter: options.clock.now(),
    });
    const reconciled = await repository.reconcileEffect({
      effectId: effectT3,
      tenantId: TENANT,
      state: 'COMPLETED',
      response: { ticketId: 'T-3' },
      actor: 'reconciler',
    });
    entries.push({ kind: 'effect', name: 'reconciled', payload: { state: reconciled?.state } });
  }

  // T4 — failEffect NOT_COMMITTED path
  await repository.createRun(createRun('run-t4'), ACTOR);
  const claimedT4 = await claim(repository, worker);
  const effectT4 = options.ids.uuid();
  if (claimedT4?.lease) {
    await repository.admitEffect({
      id: effectT4,
      runId: 'run-t4',
      stepId: claimedT4.id,
      tenantId: TENANT,
      type: 'connector.github.pull-request.create',
      idempotencyKey: 't4-key',
      policyDecisionId: 'pd-t4',
      request: {},
      lease: claimedT4.lease,
      actor: worker.workerId,
    });
    const failed = await repository.failEffect({
      effectId: effectT4,
      tenantId: TENANT,
      lease: claimedT4.lease,
      error: { code: 'NOT_COMMITTED', message: 'not committed', retryable: false },
      actor: worker.workerId,
    });
    entries.push({ kind: 'effect', name: 'failed', payload: { state: failed?.state } });
  }

  // T5 — putKillSwitch → matching kill switch blocks admission path
  await repository.putKillSwitch({
    tenantId: TENANT,
    scope: 'tool',
    value: 'blocked.tool',
    enabled: true,
    actor: ACTOR,
    reason: 'transcript',
  });
  const killMatch = await repository.findMatchingKillSwitch(TENANT, {
    tool: 'blocked.tool',
    effectType: 'demo.blocked',
  });
  entries.push({
    kind: 'error',
    name: 'kill_switch',
    payload: { matched: Boolean(killMatch), scope: killMatch?.scope ?? null },
  });

  // T6 — createInteraction → answerInteraction
  await repository.createRun(
    createRun('run-t6', [{ id: 'run-t6-step-human', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }]),
    ACTOR,
  );
  const interaction = await repository.createInteraction(
    {
      runId: 'run-t6',
      stepId: 'run-t6-step-human',
      tenantId: TENANT,
      prompt: 'Approve?',
    },
    ACTOR,
  );
  entries.push({ kind: 'step', name: 'interaction.created', payload: { status: interaction.status } });
  const answered = await repository.answerInteraction({
    interactionId: interaction.id,
    runId: 'run-t6',
    tenantId: TENANT,
    response: { approved: true },
    actor: 'human',
  });
  entries.push({ kind: 'step', name: 'interaction.answered', payload: { status: answered.status } });

  // T7 — requestCompensation → outbox commander.compensation topic
  await repository.createRun(createRun('run-t7'), ACTOR);
  const claimedT7 = await claim(repository, worker);
  const effectT7 = options.ids.uuid();
  if (claimedT7?.lease) {
    await repository.admitEffect({
      id: effectT7,
      runId: 'run-t7',
      stepId: claimedT7.id,
      tenantId: TENANT,
      type: 'connector.github.pull-request.create',
      idempotencyKey: 't7-key',
      policyDecisionId: 'pd-t7',
      request: {},
      lease: claimedT7.lease,
      actor: worker.workerId,
    });
    await repository.completeEffect(effectT7, TENANT, claimedT7.lease, { prNumber: 1 }, worker.workerId);
    await repository.completeStep({
      stepId: claimedT7.id,
      tenantId: TENANT,
      lease: claimedT7.lease,
      expectedVersion: claimedT7.version,
      actor: worker.workerId,
    });
    const compensation = await repository.requestCompensation({
      tenantId: TENANT,
      originalRunId: 'run-t7',
      originalEffectId: effectT7,
      actor: ACTOR,
      adapterVersion: '1.0.0',
      compensationEffectType: 'compensate.github.pull-request.create',
    });
    entries.push({
      kind: 'event',
      name: 'compensation.requested',
      payload: { runId: compensation?.compensationRunId ?? null },
    });
    const outbox = await repository.claimOutboxByTopic('commander.compensation', 5);
    entries.push({
      kind: 'event',
      name: 'compensation.outbox',
      payload: { count: outbox.length, topic: outbox[0]?.topic ?? null },
    });
  }

  // T8 — persistence: pending approval + UNKNOWN survive reopen (caller handles reopen)
  await repository.createRun(
    createRun('run-t8', [{ id: 'run-t8-step', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }]),
    ACTOR,
  );
  await repository.createInteraction(
    { runId: 'run-t8', stepId: 'run-t8-step', tenantId: TENANT, prompt: 'persist?' },
    ACTOR,
  );
  await repository.createRun(createRun('run-t8b'), ACTOR);
  const claimedT8b = await claim(repository, worker);
  const effectT8b = options.ids.uuid();
  if (claimedT8b?.lease) {
    await repository.admitEffect({
      id: effectT8b,
      runId: 'run-t8b',
      stepId: claimedT8b.id,
      tenantId: TENANT,
      type: 'connector.github.pull-request.create',
      idempotencyKey: 't8b-key',
      policyDecisionId: 'pd-t8b',
      request: {},
      lease: claimedT8b.lease,
      actor: worker.workerId,
    });
    await repository.markEffectCompletionUnknown({
      effectId: effectT8b,
      tenantId: TENANT,
      reason: 'crash',
      actor: worker.workerId,
    });
  }
  const pending = await repository.listInteractions('run-t8', TENANT);
  const unknownT8 = await repository.getEffect(effectT8b, TENANT);
  entries.push({
    kind: 'step',
    name: 'persisted.snapshot',
    payload: {
      pendingApprovals: pending.filter((i) => i.status === 'pending').length,
      unknownState: unknownT8?.state ?? null,
    },
  });

  return entries;
}

const STRIP_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'occurredAt',
  'expiresAt',
  'leaseExpiresAt',
  'claimedAt',
  'availableAt',
  'terminalAt',
  'reconcileAfter',
  'firesAt',
  'token',
  'claimToken',
  'lease',
  'workerGeneration',
  'fencingEpoch',
]);

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  const object = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (STRIP_KEYS.has(key)) continue;
    normalized[key] = normalizeValue(object[key]);
  }
  return normalized;
}

export function normalizeTranscript(entries: KernelTranscriptEntry[]): string {
  const normalized = entries.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    payload: normalizeValue(entry.payload),
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
