/** Test-only model of the kernel repository. Never export from the package root. */
import { randomUUID } from 'node:crypto';
import type { KernelRepository } from '../repository.js';
import type {
  AdmitEffectRequest, AdmitEffectResult, AnswerInteractionRequest, ClaimStepRequest, CompleteStepRequest,
  CreateInteractionRequest, CreateKernelRun, CreateTimerRequest, FailStepRequest,
  KernelDlqEntry, KernelEffect, KernelEvent, KernelInteraction, KernelLease, KernelOutboxMessage, KernelRun, KernelStep, KernelTimer,
  MarkEffectCompletionUnknownRequest,
  ReconcileEffectRequest,
  RequestReconcileInput,
  ClaimReconcileEffectsInput,
  ClaimedReconcileEffect,
  RescheduleReconcileInput,
  EscalateReconcileInput,
  FailEffectRequest,
  RequestCompensationInput,
  RequestCompensationResult,
  TenantExecutionControl,
  KillSwitch,
  KillSwitchMatchDims,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
} from '../types.js';
import { findMatchingKillSwitchWithLookup } from '../killSwitchMatching.js';
import { KERNEL_COMPENSATION_TOPIC, LEGACY_COMPENSATION_TOPIC } from '../ops/compensationConsumer.js';
import { KernelInvariantError } from '../types.js';
import { assertRunTransition, assertStepTransition } from '../transitionValidation.js';
import { createHash } from 'node:crypto';
import {
  generateWorkerClaimSecret,
  hashWorkerClaimSecret,
  verifyWorkerClaimSecret,
} from '../claimSecret.js';

const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const live = (lease: KernelStep['lease'], supplied: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>) =>
  Boolean(lease && lease.workerId === supplied.workerId && lease.token === supplied.token && lease.fencingEpoch === supplied.fencingEpoch && (lease.workerGeneration ?? -1) === (supplied.workerGeneration ?? -1) && Date.parse(lease.expiresAt) > Date.now());
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const requestHash = (value: Record<string, unknown>): string => createHash('sha256').update(canonical(value)).digest('hex');
const reconcileDefaults = (): Pick<
  KernelEffect,
  | 'reconcileAttempts'
  | 'reconcileAfter'
  | 'reconcileClaimToken'
  | 'reconcileClaimExpiresAt'
  | 'reconcileLastError'
  | 'reconcileEscalatedAt'
> => ({
  reconcileAttempts: 0,
  reconcileAfter: null,
  reconcileClaimToken: null,
  reconcileClaimExpiresAt: null,
  reconcileLastError: null,
  reconcileEscalatedAt: null,
});
const TERMINAL_RUN_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED']);

export interface InMemoryKernelRepositoryOptions {
  /**
   * When false (worker claim path), authorize tenants from durable worker
   * records only — caller tenantIds cannot widen; empty caller tenantIds ≠ all.
   * Default true preserves legacy test fixtures that claim without seeding workers.
   */
  schedulerMode?: boolean;
}

type InMemoryWorkerRecord = {
  tenantIds: string[];
  status: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
  generation: number;
};

export class InMemoryKernelRepository implements KernelRepository {
  private readonly runs = new Map<string, KernelRun>();
  private readonly steps = new Map<string, KernelStep>();
  private readonly effectsByKey = new Map<string, KernelEffect>();
  private readonly effects = new Map<string, KernelEffect>();
  private readonly events: KernelEvent[] = [];
  private readonly outbox = new Map<string, KernelOutboxMessage>();
  private readonly outboxClaims = new Map<string, { token: string; expiresAt: number }>();
  private readonly tenantLimits = new Map<string, number>();
  private readonly tenantControls = new Map<string, TenantExecutionControl>();
  private readonly lastFencingEpoch = new Map<string, number>();
  private readonly interactions = new Map<string, KernelInteraction>();
  private readonly workers = new Map<string, InMemoryWorkerRecord>();
  // WS2 EffectBroker monopoly state
  private readonly capabilityRevocations = new Map<string, { tenantId: string; expiresAt: number; reason?: string }>();
  /** Key: `${tenantId}|${jti}|${nonce}` → expiresAt ms */
  private readonly capabilityReplays = new Map<string, number>();
  private readonly effectAllowlist = new Map<string, Map<string, boolean>>(); // tenantId -> (actionPattern -> allowed)
  private readonly effectQuota = new Map<string, { countUsed: number; tokensUsed: number }>(); // `${tenantId}|${actionClass}|${day}`
  private readonly killSwitches = new Map<string, KillSwitch>(); // `${tenantId}|${scope}|${value}`
  /** workerId → claim secret hash for worker-mode claims. */
  private readonly claimSecretHashes = new Map<string, { generation: number; hash: Buffer }>();
  // Outbox DLQ (declared early so claimOutboxByTopic can filter DLQ'd messages)
  private readonly dlq = new Map<string, KernelDlqEntry>();
  /** Test-only: configurable maximum publish attempts before an outbox message is moved to the DLQ. */
  outboxMaxAttempts = 10;
  private readonly schedulerMode: boolean;

  constructor(options: InMemoryKernelRepositoryOptions = {}) {
    this.schedulerMode = options.schedulerMode ?? true;
  }

  /** Test-only: enqueue an arbitrary outbox message (used by compensation DLQ proofs). */
  seedOutboxMessage(input: {
    topic: string;
    tenantId?: string;
    key?: string;
    payload?: Record<string, unknown>;
    attempts?: number;
  }): KernelOutboxMessage {
    const createdAt = now();
    const message: KernelOutboxMessage = {
      id: randomUUID(),
      eventId: `evt_${randomUUID()}`,
      tenantId: input.tenantId ?? 'tenant-a',
      topic: input.topic,
      key: input.key ?? 'key',
      payload: input.payload ?? {},
      attempts: input.attempts ?? 0,
      availableAt: createdAt,
      createdAt,
    };
    this.outbox.set(message.id, message);
    return clone(message);
  }


  /** DR drill support: snapshot internal state for backup/restore testing.
   *  Includes the transactional outbox so that unpublished messages survive
   *  a backup/restore cycle (mirrors a real Postgres outbox table). */
  snapshot(): { runs: Map<string, KernelRun>; steps: Map<string, KernelStep>; interactions: Map<string, KernelInteraction>; events: KernelEvent[]; outbox: Map<string, KernelOutboxMessage>; outboxClaims: Map<string, { token: string; expiresAt: number }> } {
    return {
      runs: new Map([...this.runs].map(([k, v]) => [k, structuredClone(v)])),
      steps: new Map([...this.steps].map(([k, v]) => [k, structuredClone(v)])),
      interactions: new Map([...this.interactions].map(([k, v]) => [k, structuredClone(v)])),
      events: this.events.map((e) => structuredClone(e)),
      outbox: new Map([...this.outbox].map(([k, v]) => [k, structuredClone(v)])),
      outboxClaims: new Map([...this.outboxClaims].map(([k, v]) => [k, structuredClone(v)])),
    };
  }

  /** DR drill support: restore from a snapshot into this instance.
   *  The outbox fields are optional for backward compatibility with older
   *  snapshots that only carried runs/steps/events. */
  loadSnapshot(snapshot: { runs: Map<string, KernelRun>; steps: Map<string, KernelStep>; interactions?: Map<string, KernelInteraction>; events: KernelEvent[]; outbox?: Map<string, KernelOutboxMessage>; outboxClaims?: Map<string, { token: string; expiresAt: number }> }): void {
    this.runs.clear();
    for (const [k, v] of snapshot.runs) this.runs.set(k, v);
    this.steps.clear();
    for (const [k, v] of snapshot.steps) this.steps.set(k, v);
    this.interactions.clear();
    if (snapshot.interactions) for (const [k, v] of snapshot.interactions) this.interactions.set(k, structuredClone(v));
    this.events.length = 0;
    for (const e of snapshot.events) this.events.push(e);
    this.outbox.clear();
    if (snapshot.outbox) for (const [k, v] of snapshot.outbox) this.outbox.set(k, structuredClone(v));
    this.outboxClaims.clear();
    if (snapshot.outboxClaims) for (const [k, v] of snapshot.outboxClaims) this.outboxClaims.set(k, structuredClone(v));
  }

  async initialize(): Promise<void> { /* explicit no-op for tests */ }

  /** Test helper: durable worker registry used by worker-mode claimNextStep. Returns claim secret. */
  seedTestWorker(
    workerId: string,
    tenantIds: string[],
    generation = 1,
    options?: { status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE'; claimSecret?: string },
  ): string {
    const claimSecret = options?.claimSecret ?? generateWorkerClaimSecret();
    this.workers.set(workerId, {
      tenantIds: [...tenantIds],
      status: options?.status ?? 'ACTIVE',
      generation,
    });
    this.claimSecretHashes.set(workerId, {
      generation,
      hash: hashWorkerClaimSecret(claimSecret),
    });
    return claimSecret;
  }

  private resolveDurableWorkerTenantScope(
    workerId: string,
    workerGeneration: number,
    claimSecret?: string,
  ): { tenantIds: string[]; openEnded: boolean } | null {
    if (!claimSecret || claimSecret.length === 0) return null;
    const stored = this.claimSecretHashes.get(workerId);
    if (
      !stored ||
      stored.generation !== workerGeneration ||
      !verifyWorkerClaimSecret(claimSecret, stored.hash)
    ) {
      return null;
    }
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'ACTIVE' || worker.generation !== workerGeneration) {
      return null;
    }
    const parsed = worker.tenantIds.filter((t) => typeof t === 'string' && t.length > 0);
    // Product decision: durable '*' fail-closed (parity with claim_* DEFINER / SQLite).
    if (parsed.includes('*')) return null;
    if (parsed.length === 0) return null;
    return { tenantIds: parsed, openEnded: false };
  }

  async createRun(command: CreateKernelRun, actor: string): Promise<KernelRun> {
    if (this.runs.has(command.id)) throw new KernelInvariantError('DUPLICATE_RUN', `Run ${command.id} already exists`);
    const ids = new Set(command.steps.map((step) => step.id));
    if (ids.size !== command.steps.length || [...ids].some((id) => this.steps.has(id))) throw new KernelInvariantError('DUPLICATE_STEP', 'Duplicate step ID');
    for (const step of command.steps) for (const dep of step.dependencies ?? []) if (!ids.has(dep)) throw new KernelInvariantError('INVALID_GRAPH', `Unknown dependency ${dep}`);
    const interactionIds = command.steps.flatMap((step) => step.interaction ? [step.interaction.id] : []);
    if (new Set(interactionIds).size !== interactionIds.length || interactionIds.some((id) => this.interactions.has(id))) {
      throw new KernelInvariantError('DUPLICATE_INTERACTION', 'Duplicate interaction ID');
    }
    const createdAt = now();
    const run: KernelRun = { id: command.id, tenantId: command.tenantId, intentHash: command.intentHash, workGraphHash: command.workGraphHash, workGraphVersion: command.workGraphVersion, policySnapshotId: command.policySnapshotId, state: 'PENDING', version: 1, metadata: command.metadata ?? {}, createdAt, updatedAt: createdAt };
    this.runs.set(run.id, run);
    for (const newStep of command.steps) {
      const step: KernelStep = { id: newStep.id, runId: run.id, tenantId: run.tenantId, kind: newStep.kind, state: newStep.initialState ?? 'PENDING', version: 1, attempt: 0, maxAttempts: newStep.maxAttempts ?? 1, priority: newStep.priority ?? 0, dependencies: newStep.dependencies ?? [], input: newStep.input ?? {}, scheduledAt: newStep.scheduledAt ?? createdAt, createdAt, updatedAt: createdAt };
      this.steps.set(step.id, step);
      if (newStep.interaction) {
        const interaction: KernelInteraction = {
          id: newStep.interaction.id,
          runId: run.id,
          stepId: step.id,
          tenantId: run.tenantId,
          status: 'pending',
          prompt: newStep.interaction.prompt,
          createdAt,
          expiresAt: newStep.interaction.expiresAt,
        };
        this.interactions.set(interaction.id, interaction);
        this.event('interaction', interaction.id, 0, 'interaction.created', run.tenantId, run.id, step.id, actor, {
          interactionId: interaction.id,
          prompt: interaction.prompt,
          expiresAt: interaction.expiresAt ?? null,
        });
      }
    }
    this.event('run', run.id, run.version, 'run.created', run.tenantId, run.id, undefined, actor, { stepCount: command.steps.length });
    return clone(run);
  }
  async setTenantConcurrencyLimit(tenantId: string, maxConcurrentSteps: number): Promise<void> {
    if (!Number.isInteger(maxConcurrentSteps) || maxConcurrentSteps <= 0) {
      throw new Error('maxConcurrentSteps must be a positive integer');
    }
    this.tenantLimits.set(tenantId, maxConcurrentSteps);
  }
  async getRun(runId: string, tenantId: string): Promise<KernelRun | null> { const record = this.runs.get(runId); return record?.tenantId === tenantId ? clone(record) : null; }
  async listRuns(tenantId: string, options?: { limit?: number }): Promise<KernelRun[]> {
    const requested = options?.limit ?? 50;
    const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 50));
    return [...this.runs.values()]
      .filter((run) => run.tenantId === tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(clone);
  }
  async getStep(stepId: string, tenantId: string): Promise<KernelStep | null> { const record = this.steps.get(stepId); return record?.tenantId === tenantId ? clone(record) : null; }
  async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const at = request.now ?? new Date();
    const workerGeneration = request.workerGeneration ?? -1;
    let tenantFilter: string[] | null; // null = open-ended (all tenants)
    if (!this.schedulerMode) {
      // Worker path: durable authz only — empty caller tenantIds must not mean all.
      const scope = this.resolveDurableWorkerTenantScope(
        request.workerId,
        workerGeneration,
        request.claimSecret,
      );
      if (!scope) return null;
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    } else {
      const caller = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
      tenantFilter = caller.length === 0 ? null : caller;
    }
    const candidate = [...this.steps.values()].filter((step) =>
      (tenantFilter === null || tenantFilter.includes(step.tenantId)) &&
      (!request.capabilities || request.capabilities.length === 0 || request.capabilities.includes(step.kind)) &&
      ['PENDING', 'RETRY_WAIT'].includes(step.state) &&
      !this.tenantControls.get(step.tenantId)?.paused &&
      ['PENDING', 'RUNNING'].includes(this.runs.get(step.runId)?.state ?? 'FAILED') &&
      Date.parse(step.scheduledAt) <= at.getTime() &&
      step.dependencies.every((id) => ['SUCCEEDED', 'SKIPPED'].includes(this.steps.get(id)?.state ?? 'FAILED')) &&
      [...this.steps.values()].filter((other) => other.tenantId === step.tenantId && other.state === 'RUNNING').length <
        (this.tenantLimits.get(step.tenantId) ?? Number.MAX_SAFE_INTEGER),
    ).sort((a, b) => {
      // Aging: boost priority by +1 per minute of waiting, capped at 1000
      const ageA = Math.floor((at.getTime() - Date.parse(a.scheduledAt)) / 60_000);
      const ageB = Math.floor((at.getTime() - Date.parse(b.scheduledAt)) / 60_000);
      const boostedA = Math.max(a.priority + ageA, 1000);
      const boostedB = Math.max(b.priority + ageB, 1000);
      // Sort by: fewest running steps for tenant → boosted priority → earliest scheduled
      const runningA = [...this.steps.values()].filter((s) => s.tenantId === a.tenantId && s.state === 'RUNNING').length;
      const runningB = [...this.steps.values()].filter((s) => s.tenantId === b.tenantId && s.state === 'RUNNING').length;
      return runningA - runningB || boostedB - boostedA || a.scheduledAt.localeCompare(b.scheduledAt);
    })[0];
    if (!candidate) return null;
    assertStepTransition(candidate.state, 'RUNNING');
    const run = this.runs.get(candidate.runId)!;
    if (run.state === 'PENDING') assertRunTransition(run.state, 'RUNNING');
    candidate.state = 'RUNNING'; candidate.version++; candidate.attempt++; candidate.updatedAt = at.toISOString();
    const lastEpoch = candidate.lease?.fencingEpoch ?? this.lastFencingEpoch.get(candidate.id) ?? 0;
    candidate.lease = {
      workerId: request.workerId,
      workerGeneration: request.workerGeneration ?? 0,
      token: randomUUID(),
      fencingEpoch: lastEpoch + 1,
      expiresAt: new Date(at.getTime() + request.leaseTtlMs).toISOString(),
    };
    this.lastFencingEpoch.delete(candidate.id);
    if (run.state === 'PENDING') { run.state = 'RUNNING'; run.version++; run.updatedAt = at.toISOString(); }
    this.event('step', candidate.id, candidate.version, 'step.claimed', candidate.tenantId, candidate.runId, candidate.id, request.workerId, { fencingEpoch: candidate.lease.fencingEpoch });
    return clone(candidate);
  }
  async heartbeatStep(stepId: string, tenantId: string, lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>, leaseTtlMs: number): Promise<KernelStep | null> {
    const step = this.steps.get(stepId); if (!step || step.tenantId !== tenantId || step.state !== 'RUNNING' || !live(step.lease, lease)) return null;
    step.lease!.expiresAt = new Date(Date.now() + leaseTtlMs).toISOString(); step.updatedAt = now(); return clone(step);
  }
  async reclaimExpiredLeases(at = new Date(), limit = 100): Promise<KernelStep[]> {
    const reclaimed: KernelStep[] = [];
    for (const step of [...this.steps.values()].filter((candidate) => candidate.state === 'RUNNING' && candidate.lease && Date.parse(candidate.lease.expiresAt) <= at.getTime()).slice(0, limit)) {
      const retryable = step.attempt < step.maxAttempts;
      const nextState = retryable ? 'RETRY_WAIT' : 'FAILED';
      assertStepTransition(step.state, nextState);
      const fencingEpoch = step.lease?.fencingEpoch ?? 0;
      if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
      step.state = nextState; step.version++; step.lease = undefined; step.updatedAt = at.toISOString();
      step.scheduledAt = retryable ? at.toISOString() : step.scheduledAt;
      step.error = { code: 'LEASE_EXPIRED', message: 'Worker lease expired before terminal transition', retryable };
      this.event('step', step.id, step.version, retryable ? 'step.lease_expired_requeued' : 'step.lease_expired_failed', step.tenantId, step.runId, step.id, 'kernel.recovery', { attempt: step.attempt });
      this.parkOrphanAdmittedEffects(step, 'lease_expired', 'kernel.recovery');
      if (!retryable) {
        const completedEffects = [...this.effects.values()].filter(
          (effect) => effect.runId === step.runId && effect.tenantId === step.tenantId && effect.state === 'COMPLETED',
        );
        if (completedEffects.length > 0) {
          const run = this.runs.get(step.runId)!;
          assertRunTransition(run.state, 'COMPENSATING');
          run.state = 'COMPENSATING'; run.version++; run.updatedAt = at.toISOString();
          this.event('run', run.id, run.version, 'run.compensating', run.tenantId, run.id, step.id, 'kernel.recovery', { fencingEpoch });
          const compensationKey = `${run.tenantId}/${run.id}/${fencingEpoch}`;
          this.event('effect', `compensation:${compensationKey}`, 1, 'kernel.compensation.requested', run.tenantId, run.id, step.id, 'kernel.recovery', {
            effectIds: completedEffects.map((effect) => effect.id), fencingEpoch,
          }, compensationKey);
        } else {
          this.finish(step.runId, 'kernel.recovery');
        }
      }
      reclaimed.push(clone(step));
    }
    return reclaimed;
  }
  async completeStep(request: CompleteStepRequest): Promise<KernelStep | null> {
    const step = this.steps.get(request.stepId); if (!step || step.tenantId !== request.tenantId || step.state !== 'RUNNING' || step.version !== request.expectedVersion || !live(step.lease, request.lease)) return null;
    assertStepTransition(step.state, 'SUCCEEDED');
    step.state = 'SUCCEEDED'; step.output = request.output; step.version++; step.lease = undefined; step.updatedAt = now();
    this.event('step', step.id, step.version, 'step.succeeded', step.tenantId, step.runId, step.id, request.actor, {});
    this.parkOrphanAdmittedEffects(step, 'step_succeeded', request.actor);
    this.finish(step.runId, request.actor); return clone(step);
  }
  async failStep(request: FailStepRequest): Promise<KernelStep | null> {
    const step = this.steps.get(request.stepId); if (!step || step.tenantId !== request.tenantId || step.state !== 'RUNNING' || step.version !== request.expectedVersion || !live(step.lease, request.lease)) return null;
    const retry = request.error.retryable && Boolean(request.retryAt) && step.attempt < step.maxAttempts;
    const nextState = retry ? 'RETRY_WAIT' : 'FAILED';
    assertStepTransition(step.state, nextState);
    step.state = nextState; step.error = request.error; step.scheduledAt = request.retryAt?.toISOString() ?? step.scheduledAt; step.version++; step.lease = undefined; step.updatedAt = now();
    this.event('step', step.id, step.version, retry ? 'step.retry_scheduled' : 'step.failed', step.tenantId, step.runId, step.id, request.actor, { error: request.error });
    this.parkOrphanAdmittedEffects(step, 'step_failed', request.actor);
    if (!retry) this.finish(step.runId, request.actor); return clone(step);
  }
  async wakeRetryStep(stepId: string, tenantId: string, actor: string): Promise<KernelStep | null> {
    const step = this.steps.get(stepId); if (!step || step.tenantId !== tenantId || step.state !== 'RETRY_WAIT') return null;
    step.scheduledAt = now(); step.version++; step.lease = undefined; step.updatedAt = step.scheduledAt;
    this.event('step', step.id, step.version, 'step.retry_woken', step.tenantId, step.runId, step.id, actor, {}); return clone(step);
  }
  async failStepByTimer(stepId: string, tenantId: string, error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }, actor: string): Promise<KernelStep | null> {
    const step = this.steps.get(stepId); if (!step || step.tenantId !== tenantId || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) return null;
    const wasRunning = step.state === 'RUNNING';
    assertStepTransition(step.state, 'FAILED');
    step.state = 'FAILED'; step.error = error; step.version++; step.lease = undefined; step.updatedAt = now();
    this.event('step', step.id, step.version, 'step.failed', step.tenantId, step.runId, step.id, actor, { error });
    if (wasRunning) this.parkOrphanAdmittedEffects(step, 'step_failed', actor);
    this.finish(step.runId, actor); return clone(step);
  }
  async pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId); if (!run || run.tenantId !== tenantId || !['PENDING', 'RUNNING'].includes(run.state)) return null;
    assertRunTransition(run.state, 'PAUSED');
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && step.state === 'RUNNING') {
        assertStepTransition(step.state, 'RETRY_WAIT');
      }
    }
    run.state = 'PAUSED'; run.version++; run.updatedAt = now(); run.pausedAt = run.updatedAt;
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && step.state === 'RUNNING') {
        if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
        step.state = 'RETRY_WAIT'; step.version++; step.lease = undefined; step.updatedAt = run.updatedAt;
        this.event('step', step.id, step.version, 'step.paused', step.tenantId, step.runId, step.id, actor, { previousState: 'RUNNING' });
      }
    }
    this.event('run', run.id, run.version, 'run.paused', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId); if (!run || run.tenantId !== tenantId || run.state !== 'PAUSED') return null;
    assertRunTransition(run.state, 'RUNNING');
    run.state = 'RUNNING'; run.version++; run.updatedAt = now(); run.pausedAt = undefined;
    this.event('run', run.id, run.version, 'run.resumed', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId); if (!run || run.tenantId !== tenantId || !['PENDING', 'RUNNING', 'PAUSED'].includes(run.state)) return null;
    assertRunTransition(run.state, 'CANCELLED');
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
        assertStepTransition(step.state, 'CANCELLED');
      }
    }
    run.state = 'CANCELLED'; run.version++; run.updatedAt = now(); run.terminalAt = run.updatedAt;
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
        const previousState = step.state;
        step.state = 'CANCELLED'; step.version++; step.lease = undefined; step.updatedAt = run.updatedAt;
        this.parkOrphanAdmittedEffects(step, 'run_cancelled', actor);
        this.event('step', step.id, step.version, 'step.cancelled', step.tenantId, step.runId, step.id, actor, { previousState });
      }
    }
    this.event('run', run.id, run.version, 'run.cancelled', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async pauseTenant(tenantId: string, actor: string, reason?: string): Promise<TenantExecutionControl> {
    const affected = [...this.steps.values()].filter(
      (step) => step.tenantId === tenantId && step.state === 'RUNNING',
    );
    for (const step of affected) assertStepTransition(step.state, 'RETRY_WAIT');
    const previous = this.tenantControls.get(tenantId);
    const pausedAt = now();
    const control: TenantExecutionControl = {
      tenantId,
      paused: true,
      generation: (previous?.generation ?? 0) + 1,
      actor,
      reason,
      pausedAt,
    };
    this.tenantControls.set(tenantId, control);
    for (const step of affected) {
      if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
      step.state = 'RETRY_WAIT';
      step.version++;
      step.lease = undefined;
      step.updatedAt = pausedAt;
      step.scheduledAt = pausedAt;
      this.event('step', step.id, step.version, 'step.tenant_paused', tenantId, step.runId, step.id, actor, { reason });
    }
    this.event('tenant', tenantId, control.generation, 'tenant.paused', tenantId, `tenant:${tenantId}`, undefined, actor, { reason });
    return clone(control);
  }
  async resumeTenant(tenantId: string, actor: string): Promise<TenantExecutionControl> {
    const previous = this.tenantControls.get(tenantId);
    const control: TenantExecutionControl = {
      tenantId,
      paused: false,
      generation: (previous?.generation ?? 0) + 1,
      actor,
      resumedAt: now(),
    };
    this.tenantControls.set(tenantId, control);
    this.event('tenant', tenantId, control.generation, 'tenant.resumed', tenantId, `tenant:${tenantId}`, undefined, actor, {});
    return clone(control);
  }
  async getTenantExecutionControl(tenantId: string): Promise<TenantExecutionControl> {
    const control = this.tenantControls.get(tenantId);
    return clone(control ?? { tenantId, paused: false, generation: 0, actor: 'kernel' });
  }
  async admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult> {
    // Fail-closed: never let a blank policySnapshotId / lease.workerId slip
    // through to storage where it would otherwise coerce to 'legacy-unbound'.
    if (!request.policySnapshotId || !request.policySnapshotId.trim()) {
      return { admitted: false, reason: 'POLICY_SNAPSHOT_ID_REQUIRED' };
    }
    if (!request.lease.workerId || !request.lease.workerId.trim()) {
      return { admitted: false, reason: 'LEASE_WORKER_ID_REQUIRED' };
    }
    const key = `${request.tenantId}:${request.idempotencyKey}`;
    const step = this.steps.get(request.stepId);
    const run = this.runs.get(request.runId);
    const compensationAdmit =
      request.type.startsWith('compensate.') &&
      !!run &&
      run.state === 'COMPENSATING' &&
      !!step &&
      step.runId === request.runId &&
      step.tenantId === request.tenantId;
    if (!compensationAdmit) {
      if (!step || step.runId !== request.runId || step.tenantId !== request.tenantId || step.state !== 'RUNNING' || !live(step.lease, request.lease)) {
        return { admitted: false, reason: 'LEASE_LOST' };
      }
    }
    const fingerprint = requestHash(request.request); const previous = this.effectsByKey.get(key);
    if (previous) {
      if (
        previous.runId !== request.runId ||
        previous.stepId !== request.stepId ||
        previous.type !== request.type ||
        previous.requestHash !== fingerprint ||
        previous.policyDecisionId !== request.policyDecisionId ||
        previous.policySnapshotId !== request.policySnapshotId ||
        previous.actionDigest !== request.actionDigest
      ) {
        return { admitted: false, reason: 'IDEMPOTENCY_CONFLICT' };
      }
      return { admitted: true, replayed: true, effect: clone(previous) };
    }
    const effect: KernelEffect = {
      id: request.id,
      runId: request.runId,
      stepId: request.stepId,
      tenantId: request.tenantId,
      type: request.type,
      idempotencyKey: request.idempotencyKey,
      requestHash: fingerprint,
      policyDecisionId: request.policyDecisionId,
      policySnapshotId: request.policySnapshotId,
      actionDigest: request.actionDigest,
      leaseWorkerId: request.lease.workerId,
      leaseWorkerGeneration: request.lease.workerGeneration ?? -1,
      leaseFencingEpoch: request.lease.fencingEpoch,
      state: 'ADMITTED',
      request: request.request,
      createdAt: now(),
      ...reconcileDefaults(),
    };
    this.effects.set(effect.id, effect); this.effectsByKey.set(key, effect); this.event('effect', effect.id, 1, 'effect.admitted', effect.tenantId, effect.runId, effect.stepId, request.actor, { type: effect.type, policySnapshotId: effect.policySnapshotId, actionDigest: effect.actionDigest }); return { admitted: true, replayed: false, effect: clone(effect) };
  }
  async completeEffect(effectId: string, tenantId: string, lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>, response: Record<string, unknown>, actor: string): Promise<KernelEffect | null> {
    const effect = this.effects.get(effectId); const step = effect ? this.steps.get(effect.stepId) : undefined;
    const run = effect ? this.runs.get(effect.runId) : undefined;
    const compensationComplete =
      !!effect &&
      effect.type.startsWith('compensate.') &&
      !!run &&
      run.state === 'COMPENSATING' &&
      !!step &&
      effect.tenantId === tenantId &&
      effect.state === 'ADMITTED';
    if (!compensationComplete) {
      if (!effect || !step || effect.tenantId !== tenantId || effect.state !== 'ADMITTED' || step.state !== 'RUNNING' || !live(step.lease, lease)) return null;
    }
    effect.state = 'COMPLETED'; effect.response = response; effect.completedAt = now(); this.event('effect', effect.id, 2, 'effect.completed', tenantId, effect.runId, effect.stepId, actor, {}); return clone(effect);
  }
  async markEffectCompletionUnknown(request: MarkEffectCompletionUnknownRequest): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    if (!effect || effect.tenantId !== request.tenantId || effect.state !== 'ADMITTED') return null;
    effect.state = 'COMPLETION_UNKNOWN';
    effect.response = { completionUnknownReason: request.reason };
    effect.reconcileAfter = now();
    effect.reconcileAttempts = 0;
    this.event('effect', effect.id, 2, 'effect.completion_unknown', effect.tenantId, effect.runId, effect.stepId, request.actor, { reason: request.reason });
    return clone(effect);
  }
  private parkOrphanAdmittedEffects(
    step: Pick<KernelStep, 'id' | 'tenantId' | 'runId'>,
    reason: string,
    actor: string,
  ): void {
    for (const effect of this.effects.values()) {
      if (effect.stepId === step.id && effect.tenantId === step.tenantId && effect.state === 'ADMITTED') {
        effect.state = 'COMPLETION_UNKNOWN';
        effect.response = { completionUnknownReason: reason };
        effect.reconcileAfter = now();
        effect.reconcileAttempts = 0;
        this.event('effect', effect.id, 2, 'effect.completion_unknown', effect.tenantId, effect.runId, effect.stepId, actor, { reason });
      }
    }
  }
  async getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null> {
    const effect = this.effects.get(effectId);
    if (!effect || effect.tenantId !== tenantId) return null;
    return clone(effect);
  }
  async reconcileEffect(request: ReconcileEffectRequest): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    if (!effect || effect.tenantId !== request.tenantId || effect.state !== 'COMPLETION_UNKNOWN') return null;
    effect.state = request.state;
    effect.response = request.response;
    effect.completedAt = now();
    this.event(
      'effect',
      effect.id,
      3,
      request.state === 'COMPLETED' ? 'effect.reconciled_completed' : 'effect.reconciled_failed',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      {},
    );
    return clone(effect);
  }
  async requestReconcile(input: RequestReconcileInput): Promise<KernelEffect | null> {
    const effect = this.effects.get(input.effectId);
    if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'COMPLETION_UNKNOWN') return null;
    effect.reconcileAfter = input.reconcileAfter ?? now();
    return clone(effect);
  }
  async claimReconcileEffects(input: ClaimReconcileEffectsInput): Promise<ClaimedReconcileEffect[]> {
    const at = input.now ?? new Date();
    const claimTtlMs = input.claimTtlMs ?? 60_000;
    const claimed: ClaimedReconcileEffect[] = [];
    let tenantFilter: string[] | null = null; // null = open-ended
    if (!this.schedulerMode) {
      const workerId = input.workerId?.trim();
      if (!workerId) return [];
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        input.workerGeneration ?? -1,
        input.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    }
    const candidates = [...this.effects.values()]
      .filter((effect) => {
        if (tenantFilter !== null && !tenantFilter.includes(effect.tenantId)) return false;
        if (effect.state !== 'COMPLETION_UNKNOWN' || effect.reconcileEscalatedAt) return false;
        if (!effect.reconcileAfter || Date.parse(effect.reconcileAfter) > at.getTime()) return false;
        if (
          effect.reconcileClaimExpiresAt &&
          Date.parse(effect.reconcileClaimExpiresAt) > at.getTime()
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(a.reconcileAfter ?? '') - Date.parse(b.reconcileAfter ?? ''));
    for (const effect of candidates.slice(0, input.limit)) {
      const claimToken = randomUUID();
      effect.reconcileClaimToken = claimToken;
      effect.reconcileClaimExpiresAt = new Date(at.getTime() + claimTtlMs).toISOString();
      claimed.push({ effect: clone(effect), claimToken });
    }
    return claimed;
  }
  async rescheduleReconcile(input: RescheduleReconcileInput): Promise<boolean> {
    const effect = this.effects.get(input.effectId);
    if (
      !effect ||
      effect.tenantId !== input.tenantId ||
      effect.state !== 'COMPLETION_UNKNOWN' ||
      effect.reconcileClaimToken !== input.claimToken
    ) {
      return false;
    }
    effect.reconcileAttempts += 1;
    effect.reconcileAfter = input.reconcileAfter;
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    if (input.lastError) {
      effect.reconcileLastError = input.lastError;
    }
    return true;
  }
  async escalateReconcile(input: EscalateReconcileInput): Promise<boolean> {
    const effect = this.effects.get(input.effectId);
    if (
      !effect ||
      effect.tenantId !== input.tenantId ||
      effect.state !== 'COMPLETION_UNKNOWN' ||
      effect.reconcileClaimToken !== input.claimToken
    ) {
      return false;
    }
    effect.reconcileEscalatedAt = now();
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    effect.reconcileLastError = { code: 'RECONCILE_ESCALATED', message: input.reason };
    this.event(
      'effect',
      effect.id,
      effect.reconcileAttempts + 100,
      'effect.reconcile_escalated',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      'reconciliation-daemon',
      { reason: input.reason },
    );
    return true;
  }
  async releaseReconcileClaim(effectId: string, tenantId: string, claimToken: string): Promise<boolean> {
    const effect = this.effects.get(effectId);
    if (
      !effect ||
      effect.tenantId !== tenantId ||
      effect.reconcileClaimToken !== claimToken
    ) {
      return false;
    }
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    return true;
  }
  async failEffect(request: FailEffectRequest): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    if (
      !effect ||
      !step ||
      effect.tenantId !== request.tenantId ||
      effect.state !== 'ADMITTED' ||
      step.state !== 'RUNNING' ||
      !live(step.lease, request.lease)
    ) {
      return null;
    }
    effect.state = 'FAILED';
    effect.response = request.error;
    effect.completedAt = now();
    this.event(
      'effect',
      effect.id,
      2,
      'effect.failed',
      request.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      { error: request.error },
    );
    return clone(effect);
  }
  async requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult | null> {
    const originalRun = this.runs.get(input.originalRunId);
    if (!originalRun || originalRun.tenantId !== input.tenantId) return null;
    if (!TERMINAL_RUN_STATES.has(originalRun.state)) return null;
    const forwardEffects = [...this.effects.values()].filter(
      (effect) =>
        effect.runId === input.originalRunId &&
        effect.tenantId === input.tenantId &&
        effect.state === 'COMPLETED' &&
        !effect.type.startsWith('compensate.'),
    );
    if (forwardEffects.length === 0) return null;
    const target =
      (input.originalEffectId
        ? forwardEffects.find((effect) => effect.id === input.originalEffectId)
        : forwardEffects[forwardEffects.length - 1]) ?? null;
    if (!target) return null;
    const idempotencyKey = `cmp:${target.id}:${input.adapterVersion}`;
    const compensationRunId = `run_${createHash('sha256')
      .update(`${input.tenantId}:compensation:${idempotencyKey}`)
      .digest('hex')
      .slice(0, 40)}`;
    const existingRun = this.runs.get(compensationRunId);
    if (existingRun) {
      return {
        compensationRunId,
        originalEffectId: target.id,
        originalRunId: input.originalRunId,
      };
    }
    const stepId = `step_${createHash('sha256').update(`${compensationRunId}:tool`).digest('hex').slice(0, 32)}`;
    await this.createRun(
      {
        id: compensationRunId,
        tenantId: input.tenantId,
        intentHash: createHash('sha256').update(`compensate:${target.id}`).digest('hex'),
        workGraphHash: createHash('sha256').update(stepId).digest('hex'),
        workGraphVersion: 'action-gateway-compensation/v1',
        policySnapshotId: 'compensation-enqueue-v1',
        metadata: {
          compensation: {
            originalRunId: input.originalRunId,
            originalEffectId: target.id,
            adapterVersion: input.adapterVersion,
          },
        },
        steps: [
          {
            id: stepId,
            kind: 'tool',
            input: {
              effectType: input.compensationEffectType,
              originalEffectId: target.id,
              idempotencyKey,
            },
          },
        ],
      },
      input.actor,
    );
    const compensationKey = `${input.tenantId}/${compensationRunId}/${target.id}`;
    this.event(
      'effect',
      `compensation:${compensationKey}`,
      1,
      'kernel.compensation.requested',
      input.tenantId,
      compensationRunId,
      stepId,
      input.actor,
      {
        type: 'kernel.compensation.requested',
        tenantId: input.tenantId,
        runId: compensationRunId,
        stepId,
        originalEffectId: target.id,
        compensationAction: input.compensationEffectType,
        compensationPayload: {
          originalEffectId: target.id,
          forwardResponse: target.response ?? {},
          // Derived from the original effect's own lease fencing — never invent
          // a literal epoch for the compensation consumer's admit lease.
          fencingEpoch: target.leaseFencingEpoch,
        },
        idempotencyKey,
      },
      compensationKey,
    );
    const outboxMessage = [...this.outbox.values()].find((message) => message.key === compensationKey);
    return {
      compensationRunId,
      originalEffectId: target.id,
      originalRunId: input.originalRunId,
      outboxMessageId: outboxMessage?.id,
    };
  }
  async claimOutbox(limit: number, at = new Date(), tenantId?: string): Promise<KernelOutboxMessage[]> {
    return [...this.outbox.values()].filter((message) => {
      if (message.publishedAt) return false;
      if (message.topic === KERNEL_COMPENSATION_TOPIC || message.topic === LEGACY_COMPENSATION_TOPIC) return false;
      if (tenantId && message.payload.tenantId !== tenantId) return false;
      if ([...this.dlq.values()].some((e) => e.originalId === message.id)) return false;
      if (message.attempts >= this.outboxMaxAttempts) return false;
      const claim = this.outboxClaims.get(message.id);
      return Date.parse(message.availableAt) <= at.getTime() && (!claim || claim.expiresAt <= at.getTime());
    }).slice(0, limit).map((message) => {
      const token = randomUUID();
      message.attempts++;
      message.claimToken = token;
      this.outboxClaims.set(message.id, { token, expiresAt: at.getTime() + 60_000 });
      return clone(message);
    });
  }
  async markOutboxPublished(messageId: string, claimToken: string, tenantId?: string): Promise<boolean> {
    const message = this.outbox.get(messageId);
    const claim = this.outboxClaims.get(messageId);
    if (!message || message.publishedAt || claim?.token !== claimToken) return false;
    if (tenantId && message.tenantId !== tenantId) return false;
    message.publishedAt = now();
    message.claimToken = undefined;
    this.outboxClaims.delete(messageId);
    return true;
  }
  async retryOutbox(
    messageId: string,
    claimToken: string,
    _error: { code: string; message: string },
    at = new Date(),
    tenantId?: string,
  ): Promise<boolean> {
    const message = this.outbox.get(messageId);
    const claim = this.outboxClaims.get(messageId);
    if (!message || message.publishedAt || claim?.token !== claimToken) return false;
    if (tenantId && message.tenantId !== tenantId) return false;
    message.availableAt = new Date(at.getTime() + Math.pow(2, Math.max(0, message.attempts - 1)) * 1000).toISOString();
    message.claimToken = undefined;
    this.outboxClaims.delete(messageId);
    return true;
  }

  // ── WS2 EffectBroker monopoly ──

  async claimOutboxByTopic(
    topic: string,
    limit: number,
    at = new Date(),
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<KernelOutboxMessage[]> {
    let tenantFilter: string[] | null = null;
    if (!this.schedulerMode) {
      const workerId = authz?.workerId?.trim();
      if (!workerId) {
        throw new Error('claimOutboxByTopic requires workerId on the worker LOGIN path');
      }
      if (typeof authz?.workerGeneration !== 'number' || !Number.isFinite(authz.workerGeneration)) {
        throw new Error('claimOutboxByTopic requires finite workerGeneration on the worker LOGIN path');
      }
      if (!authz.claimSecret) {
        throw new Error('claimOutboxByTopic requires claimSecret on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        authz.workerGeneration,
        authz.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    }
    return [...this.outbox.values()].filter((message) => {
      if (message.topic !== topic || message.publishedAt) return false;
      if (tenantFilter !== null && !tenantFilter.includes(message.tenantId)) return false;
      if ([...this.dlq.values()].some((e) => e.originalId === message.id)) return false;
      if (message.attempts >= this.outboxMaxAttempts) return false;
      const claim = this.outboxClaims.get(message.id);
      return Date.parse(message.availableAt) <= at.getTime() && (!claim || claim.expiresAt <= at.getTime());
    }).slice(0, limit).map((message) => {
      const token = randomUUID();
      message.attempts++;
      message.claimToken = token;
      this.outboxClaims.set(message.id, { token, expiresAt: at.getTime() + 60_000 });
      return clone(message);
    });
  }

  async isCapabilityRevoked(jti: string, tenantId: string): Promise<boolean> {
    const key = `${tenantId}\0${jti}`;
    const entry = this.capabilityRevocations.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) { this.capabilityRevocations.delete(key); return false; }
    return true;
  }

  async revokeCapability(input: { jti: string; tenantId: string; expiresAt: string; reason?: string }): Promise<void> {
    this.capabilityRevocations.set(`${input.tenantId}\0${input.jti}`, {
      tenantId: input.tenantId,
      expiresAt: Date.parse(input.expiresAt),
      reason: input.reason,
    });
  }

  async consumeCapabilityReplay(input: {
    tenantId: string;
    jti: string;
    nonce: string;
    expiresAt: string;
  }): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiry] of this.capabilityReplays) {
      if (expiry <= now) this.capabilityReplays.delete(key);
    }
    const key = `${input.tenantId}|${input.jti}|${input.nonce}`;
    if (this.capabilityReplays.has(key)) return true;
    this.capabilityReplays.set(key, Date.parse(input.expiresAt));
    return false;
  }

  async isActionAllowed(tenantId: string, action: string): Promise<boolean> {
    const tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap || tenantMap.size === 0) return false; // fail-closed
    let best: { allowed: boolean; exact: boolean; len: number } | null = null;
    for (const [pattern, allowed] of tenantMap) {
      const matches = pattern === action || (pattern.endsWith('.*') && action.startsWith(pattern.slice(0, -1)));
      if (!matches) continue;
      const candidate = { allowed, exact: pattern === action, len: pattern.length };
      if (!best || (candidate.exact && !best.exact) || (candidate.exact === best.exact && candidate.len > best.len)) best = candidate;
    }
    return best ? best.allowed : false;
  }

  async setAllowlistEntry(tenantId: string, actionPattern: string, allowed: boolean): Promise<void> {
    let tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap) { tenantMap = new Map(); this.effectAllowlist.set(tenantId, tenantMap); }
    tenantMap.set(actionPattern, allowed);
  }

  async ensureAllowlistDefault(tenantId: string, actionPattern: string, allowed: boolean): Promise<void> {
    let tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap) { tenantMap = new Map(); this.effectAllowlist.set(tenantId, tenantMap); }
    if (!tenantMap.has(actionPattern)) tenantMap.set(actionPattern, allowed);
  }

  async incrementQuota(input: { tenantId: string; actionClass: string; tokensUsed?: number; now?: Date }): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const key = `${input.tenantId}|${input.actionClass}|${day}`;
    const entry = this.effectQuota.get(key) ?? { countUsed: 0, tokensUsed: 0 };
    entry.countUsed += 1;
    entry.tokensUsed += input.tokensUsed ?? 0;
    this.effectQuota.set(key, entry);
    return { countUsed: entry.countUsed, tokensUsed: entry.tokensUsed };
  }

  async getQuota(tenantId: string, actionClass: string, at = new Date()): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = at.toISOString().slice(0, 10);
    const key = `${tenantId}|${actionClass}|${day}`;
    return this.effectQuota.get(key) ?? { countUsed: 0, tokensUsed: 0 };
  }

  private killSwitchKey(tenantId: string, scope: KillSwitch['scope'], value: string): string {
    return `${tenantId}|${scope}|${value}`;
  }

  async putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch> {
    const entry: KillSwitch = {
      tenantId: input.tenantId,
      scope: input.scope,
      value: input.value,
      enabled: input.enabled,
      reason: input.reason,
      actor: input.actor,
      updatedAt: now(),
    };
    this.killSwitches.set(this.killSwitchKey(input.tenantId, input.scope, input.value), entry);
    return clone(entry);
  }

  async removeKillSwitch(input: RemoveKillSwitchInput): Promise<void> {
    this.killSwitches.delete(this.killSwitchKey(input.tenantId, input.scope, input.value));
  }

  async listKillSwitches(tenantId: string): Promise<KillSwitch[]> {
    return [...this.killSwitches.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .map(clone)
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.value.localeCompare(b.value));
  }

  async findMatchingKillSwitch(tenantId: string, dims: KillSwitchMatchDims): Promise<KillSwitch | null> {
    return findMatchingKillSwitchWithLookup(tenantId, dims, (id) => this.listKillSwitches(id));
  }

  async listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> { return this.events.filter((event) => event.runId === runId && event.tenantId === tenantId).map(clone); }
  async listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]> {
    return [...this.effects.values()].filter((effect) => effect.runId === runId && effect.tenantId === tenantId).map(clone);
  }

  // ── Durable Timers ──
  private readonly timers = new Map<string, KernelTimer>();
  async createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer> {
    const timer: KernelTimer = {
      id: `tmr_${randomUUID()}`, runId: request.runId, stepId: request.stepId, tenantId: request.tenantId,
      firesAt: request.firesAt.toISOString(), timerType: request.timerType, state: 'PENDING',
      payload: request.payload ?? {}, createdAt: now(),
    };
    this.timers.set(timer.id, timer);
    this.event('run', request.runId, 0, 'timer.created', request.tenantId, request.runId, request.stepId, actor, { timerId: timer.id });
    return clone(timer);
  }
  async cancelTimer(timerId: string, tenantId: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (!timer || timer.tenantId !== tenantId || timer.state !== 'PENDING') return false;
    timer.state = 'CANCELLED';
    return true;
  }
  async claimExpiredTimers(at = new Date(), limit = 100): Promise<KernelTimer[]> {
    const expired = [...this.timers.values()]
      .filter((t) => t.state === 'PENDING' && Date.parse(t.firesAt) <= at.getTime())
      .sort((a, b) => a.firesAt.localeCompare(b.firesAt))
      .slice(0, limit);
    for (const t of expired) { t.state = 'PROCESSING'; t.claimToken = randomUUID(); }
    return expired.map(clone);
  }
  async acknowledgeTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (!timer || timer.tenantId !== tenantId || timer.state !== 'PROCESSING' || timer.claimToken !== claimToken) return false;
    timer.state = 'FIRED'; timer.firedAt = now(); timer.claimToken = undefined; return true;
  }
  async retryTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (!timer || timer.tenantId !== tenantId || timer.state !== 'PROCESSING' || timer.claimToken !== claimToken) return false;
    timer.state = 'PENDING'; timer.claimToken = undefined; return true;
  }

  // ── Interactions ──
  async createInteraction(request: CreateInteractionRequest, actor: string): Promise<KernelInteraction> {
    const step = this.steps.get(request.stepId);
    if (!step || step.tenantId !== request.tenantId || step.runId !== request.runId) {
      throw new KernelInvariantError(
        'STEP_NOT_FOUND',
        `Step ${request.stepId} not found for run ${request.runId} in tenant ${request.tenantId}`,
      );
    }
    const interaction: KernelInteraction = {
      id: `itr_${randomUUID()}`, runId: request.runId, stepId: request.stepId, tenantId: request.tenantId,
      status: 'pending', prompt: request.prompt, createdAt: now(),
      expiresAt: request.expiresAt?.toISOString(),
    };
    this.interactions.set(interaction.id, interaction);
    this.event('interaction', interaction.id, 0, 'interaction.created', request.tenantId, request.runId, request.stepId, actor, {
      interactionId: interaction.id,
      prompt: interaction.prompt,
      expiresAt: interaction.expiresAt ?? null,
    });
    return clone(interaction);
  }
  async answerInteraction(request: AnswerInteractionRequest): Promise<KernelInteraction> {
    const interaction = this.interactions.get(request.interactionId);
    if (!interaction || interaction.runId !== request.runId || interaction.tenantId !== request.tenantId || interaction.status !== 'pending') {
      throw new KernelInvariantError('INTERACTION_NOT_FOUND', `Interaction ${request.interactionId} not found or already answered`);
    }
    const step = this.steps.get(interaction.stepId);
    if (!step || step.runId !== request.runId || step.tenantId !== request.tenantId || step.state !== 'WAITING_FOR_HUMAN') {
      throw new KernelInvariantError('INTERACTION_NOT_FOUND', `Interaction ${request.interactionId} has no matching waiting step`);
    }
    const answeredAt = now();
    interaction.status = 'answered';
    interaction.response = request.response;
    interaction.answeredAt = answeredAt;
    if (request.releaseStep !== false) {
      assertStepTransition(step.state, 'RETRY_WAIT');
      step.state = 'RETRY_WAIT';
      step.scheduledAt = answeredAt;
      step.version++;
      step.lease = undefined;
      step.updatedAt = answeredAt;
    }
    this.event('interaction', interaction.id, 1, 'interaction.answered', request.tenantId, request.runId, interaction.stepId, request.actor, { response: request.response });
    if (request.releaseStep !== false) {
      this.event('step', step.id, step.version, 'step.interaction_answered', step.tenantId, step.runId, step.id, request.actor, { interactionId: interaction.id });
    }
    return clone(interaction);
  }
  async getInteraction(interactionId: string, tenantId: string): Promise<KernelInteraction | null> {
    const interaction = this.interactions.get(interactionId);
    return interaction?.tenantId === tenantId ? clone(interaction) : null;
  }
  async listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]> {
    return [...this.interactions.values()].filter((i) => i.runId === runId && i.tenantId === tenantId).map(clone);
  }
  async expireStaleInteractions(at = new Date(), limit = 100): Promise<KernelInteraction[]> {
    const expired = [...this.interactions.values()]
      .filter((i) => i.status === 'pending' && i.expiresAt && Date.parse(i.expiresAt) <= at.getTime())
      .slice(0, limit);
    for (const i of expired) { i.status = 'expired'; }
    return expired.map(clone);
  }

  // ── Outbox DLQ ──
  async sweepOutboxDlq(at = new Date(), _limit = 50): Promise<{ movedToDlq: number; backoffApplied: number }> {
    let movedToDlq = 0; let backoffApplied = 0;
    for (const [id, msg] of [...this.outbox.entries()]) {
      if (msg.publishedAt) continue;
      // Mirrors Postgres FOR UPDATE SKIP LOCKED: don't touch messages with an active claim.
      const claim = this.outboxClaims.get(id);
      if (claim && claim.expiresAt > at.getTime()) continue;
      if (msg.attempts >= this.outboxMaxAttempts) {
        const dlqEntry: KernelDlqEntry = {
          id: `dlq_${randomUUID()}`, originalId: id, eventId: msg.eventId, tenantId: msg.tenantId, topic: msg.topic,
          key: msg.key, payload: msg.payload, attempts: msg.attempts,
          dlqReason: 'max_attempts_exceeded', originalCreatedAt: msg.createdAt,
          movedToDlqAt: now(),
        };
        this.dlq.set(dlqEntry.id, dlqEntry);
        msg.publishedAt = now();
        msg.claimToken = undefined;
        this.outboxClaims.delete(id);
        movedToDlq++;
      } else if (msg.attempts > 0 && Date.parse(msg.availableAt) <= at.getTime()) {
        msg.availableAt = new Date(at.getTime() + Math.pow(2, msg.attempts) * 1000).toISOString();
        msg.claimToken = undefined;
        this.outboxClaims.delete(id);
        backoffApplied++;
      }
    }
    return { movedToDlq, backoffApplied };
  }
  async listDlqEntries(limit = 100, topic?: string): Promise<KernelDlqEntry[]> {
    let entries = [...this.dlq.values()];
    if (topic) entries = entries.filter((e) => e.topic === topic);
    return entries.slice(0, limit).map(clone);
  }
  async replayDlqEntry(dlqId: string): Promise<boolean> {
    const entry = this.dlq.get(dlqId);
    if (!entry) return false;
    const newMsg: KernelOutboxMessage = {
      id: randomUUID(), eventId: entry.eventId, tenantId: entry.tenantId, topic: entry.topic, key: entry.key,
      payload: entry.payload, attempts: 0, availableAt: now(), createdAt: now(),
    };
    this.outbox.set(newMsg.id, newMsg);
    this.dlq.delete(dlqId);
    return true;
  }
  private event(aggregateType: KernelEvent['aggregateType'], aggregateId: string, sequence: number, type: string, tenantId: string, runId: string, stepId: string | undefined, actor: string, payload: Record<string, unknown>, outboxKey = runId): void {
    const event: KernelEvent = { eventId: randomUUID(), aggregateType, aggregateId, sequence, type, tenantId, runId, stepId, actor, schemaVersion: 'v2', payload, occurredAt: now() }; this.events.push(event);
    const message: KernelOutboxMessage = { id: randomUUID(), eventId: event.eventId, tenantId, topic: `commander.${type}`, key: outboxKey, payload: { ...payload, eventId: event.eventId, type, runId, stepId: stepId ?? null, tenantId }, attempts: 0, availableAt: event.occurredAt, createdAt: event.occurredAt }; this.outbox.set(message.id, message);
  }
  private finish(runId: string, actor: string): void {
    const run = this.runs.get(runId)!; const steps = [...this.steps.values()].filter((step) => step.runId === runId);
    if (steps.some((step) => step.state === 'FAILED')) { assertRunTransition(run.state, 'FAILED'); run.state = 'FAILED'; run.version++; run.updatedAt = now(); run.terminalAt = run.updatedAt; this.event('run', run.id, run.version, 'run.failed', run.tenantId, run.id, undefined, actor, {}); }
    else if (steps.length > 0 && steps.every((step) => ['SUCCEEDED', 'SKIPPED'].includes(step.state))) { assertRunTransition(run.state, 'SUCCEEDED'); run.state = 'SUCCEEDED'; run.version++; run.updatedAt = now(); run.terminalAt = run.updatedAt; this.event('run', run.id, run.version, 'run.succeeded', run.tenantId, run.id, undefined, actor, {}); }
  }
}
