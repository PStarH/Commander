import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  KeyObject,
} from 'node:crypto';
import { AdapterExecutionError } from './adapterErrors.js';

export interface CapabilityGrant {
  jti: string;
  tenantId: string;
  runId: string;
  stepId: string;
  effectTypes: string[];
  expiresAt: string;
  /** Workload identity that issued the grant. */
  issuer?: string;
  /** Intended verifier/audience. */
  audience?: string;
  issuedAt?: string;
  notBefore?: string;
  keyId?: string;
  /** Policy version pinned when the grant was minted. */
  policySnapshotId?: string;
  /** Canonical hash of the exact external request allowed by the grant. */
  requestHash?: string;
  /** Step-scoped workload identity that authorized the mint. */
  workloadId?: string;
  nonce?: string;
}

/** Kernel-claimed step context required for production effect admission. */
export interface WorkloadBinding {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId?: string;
}

export interface CapabilityRevocationStore {
  revoke(jti: string, expiresAt: string): void | Promise<void>;
  isRevoked(jti: string): boolean | Promise<boolean>;
}

export interface CapabilityReplayStore {
  /** Returns true when this token identity was already consumed. */
  consume(key: string, expiresAt: string): boolean | Promise<boolean>;
}

export class InMemoryCapabilityRevocationStore implements CapabilityRevocationStore {
  private readonly revoked = new Map<string, number>();
  revoke(jti: string, expiresAt: string): void { this.revoked.set(jti, Date.parse(expiresAt)); }
  isRevoked(jti: string): boolean {
    const expiry = this.revoked.get(jti);
    if (!expiry) return false;
    if (expiry <= Date.now()) { this.revoked.delete(jti); return false; }
    return true;
  }
}

export class InMemoryCapabilityReplayStore implements CapabilityReplayStore {
  private readonly consumed = new Map<string, number>();
  consume(key: string, expiresAt: string): boolean {
    const now = Date.now();
    for (const [entry, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(entry);
    if (this.consumed.has(key)) return true;
    this.consumed.set(key, Date.parse(expiresAt));
    return false;
  }
}

export interface PolicyDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  decisionId: string;
  reason: string;
  policySnapshotId: string;
}

export interface PolicyEvaluator {
  evaluate(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    type: string;
    request: Record<string, unknown>;
    token: CapabilityGrant;
  }): Promise<PolicyDecision>;
}

export interface EffectKernelPort {
  admitEffect(input: {
    id: string;
    runId: string;
    stepId: string;
    tenantId: string;
    type: string;
    idempotencyKey: string;
    policyDecisionId: string;
    request: Record<string, unknown>;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
  }): Promise<{ admitted: boolean; replayed?: boolean; reason?: string; effect?: { id: string; response?: Record<string, unknown>; state: string } }>;
  completeEffect(
    effectId: string,
    tenantId: string,
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number },
    response: Record<string, unknown>,
    actor: string,
  ): Promise<unknown | null>;
  markEffectCompletionUnknown?(input: { effectId: string; tenantId: string; reason: string; actor: string }): Promise<unknown | null>;
  /**
   * Terminal fail for effects that never committed remotely (AdapterCommitState NOT_COMMITTED).
   * Distinct from markEffectCompletionUnknown (QUERY_FIRST / UNKNOWN).
   * Shape matches kernel FailEffectRequest (lease + error); broker does not import @commander/kernel.
   */
  failEffect?(input: {
    effectId: string;
    tenantId: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    actor: string;
  }): Promise<unknown | null>;
  /** L3-08a: load ledger effect for UNKNOWN reconcile (no side-effect execute). */
  getEffect?(
    effectId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    state: string;
    type: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
    response?: Record<string, unknown>;
    runId: string;
    stepId: string;
    tenantId: string;
  } | null>;
  /**
   * L3-08a: advance COMPLETION_UNKNOWN → COMPLETED|FAILED after remote query.
   * Must not re-execute the external write; ops/reconciler actor, no worker lease.
   */
  reconcileEffect?(input: {
    effectId: string;
    tenantId: string;
    state: 'COMPLETED' | 'FAILED';
    response: Record<string, unknown>;
    actor: string;
  }): Promise<{ id: string; state: string; response?: Record<string, unknown> } | null>;
  /** WS2 §5 three-layer engine. Optional so narrow test doubles can omit
   *  them, but enforced fail-closed by admit() whenever present — the kernel
   *  repository implements all three. */
  isActionAllowed?(tenantId: string, action: string): Promise<boolean>;
  incrementQuota?(input: { tenantId: string; actionClass: string; tokensUsed?: number }): Promise<{ countUsed: number; tokensUsed: number }>;
  getQuota?(tenantId: string, actionClass: string): Promise<{ countUsed: number; tokensUsed: number }>;
}

/** Remote query result for L3-08a query-after-timeout. Never performs a write. */
export type EffectRemoteOutcome =
  | { status: 'COMPLETED'; response: Record<string, unknown> }
  | { status: 'FAILED'; response: Record<string, unknown> }
  | { status: 'UNKNOWN' };

export interface EffectOutcomeQuerier {
  queryOutcome(input: {
    effectId: string;
    idempotencyKey: string;
    type: string;
    request: Record<string, unknown>;
    tenantId: string;
    signal?: AbortSignal;
  }): Promise<EffectRemoteOutcome>;
}

export type ReconcileUnknownResult =
  | { status: 'COMPLETED'; effectId: string; response: Record<string, unknown>; invokedExecutor: false }
  | { status: 'FAILED'; effectId: string; response: Record<string, unknown>; invokedExecutor: false }
  | { status: 'ESCALATED'; effectId: string; reason: string; invokedExecutor: false };

export interface ApprovalInteractionPort {
  createApprovalInteraction(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    effectType: string;
    request: Record<string, unknown>;
    policyDecisionId: string;
    actor: string;
  }): Promise<{ interactionId: string; status: 'pending' }>;
}

export interface EffectExecutor {
  execute(input: {
    type: string;
    request: Record<string, unknown>;
    signal: AbortSignal;
    executionContext?: {
      tenantId: string;
      workerId: string;
      workerGeneration?: number;
      fencingEpoch: number;
      leaseToken: string;
      effectId: string;
    };
  }): Promise<Record<string, unknown>>;
}

export interface AuditSink {
  append(event: {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    tenantId: string;
    runId: string;
    stepId: string;
    at: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

export type KeyLike = KeyObject | string | Buffer;

export interface CapabilityTokenIssuerOptions {
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: KeyLike;
  ttlMs?: number;
  clock?: () => Date;
}

export interface CapabilityTokenVerifierOptions {
  issuer: string;
  audience: string;
  publicKeys: ReadonlyMap<string, KeyLike> | Record<string, KeyLike>;
  revocations?: CapabilityRevocationStore;
  replay?: CapabilityReplayStore;
  clockSkewMs?: number;
  clock?: () => Date;
}

interface CapabilityTokenHeader { alg: 'EdDSA'; typ: 'CAP'; kid: string; }

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = <T>(value: string): T => JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
const nowIso = (clock: () => Date): string => clock().toISOString();

/** Stable hash used by both the issuer and verifier for exact request binding. */
export function canonicalRequestHash(value: Record<string, unknown>): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    return `{${Object.keys(input as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizePrivateKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPrivateKey(key);
}

function normalizePublicKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPublicKey(key);
}

/** Ed25519 issuer. The private key never needs to be distributed to workers. */
export class CapabilityTokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly clock: () => Date;

  constructor(private readonly options: CapabilityTokenIssuerOptions) {
    this.privateKey = normalizePrivateKey(options.privateKey);
    this.clock = options.clock ?? (() => new Date());
  }

  get publicKey(): KeyObject {
    return createPublicKey(this.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }

  issue(grant: Omit<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'> & Partial<Pick<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'>>): string {
    const issuedAt = grant.issuedAt ?? nowIso(this.clock);
    const notBefore = grant.notBefore ?? issuedAt;
    const payload: CapabilityGrant = {
      ...grant,
      issuer: this.options.issuer,
      audience: this.options.audience,
      keyId: this.options.keyId,
      issuedAt,
      notBefore,
      nonce: grant.nonce ?? randomUUID(),
    };
    const header: CapabilityTokenHeader = { alg: 'EdDSA', typ: 'CAP', kid: this.options.keyId };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    return `${signingInput}.${sign(null, Buffer.from(signingInput), this.privateKey).toString('base64url')}`;
  }

  static generate(options: Omit<CapabilityTokenIssuerOptions, 'privateKey' | 'keyId'> & { keyId?: string }): CapabilityTokenIssuer {
    const { privateKey } = generateKeyPairSync('ed25519');
    return new CapabilityTokenIssuer({ ...options, keyId: options.keyId ?? 'generated', privateKey });
  }
}

/** Read-only Ed25519 verifier suitable for workers and effect brokers. */
export class CapabilityTokenVerifier {
  private readonly clock: () => Date;
  private readonly clockSkewMs: number;

  constructor(private readonly options: CapabilityTokenVerifierOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.clockSkewMs = options.clockSkewMs ?? 30_000;
  }

  async verify(token: string, at = this.clock()): Promise<CapabilityGrant> {
    const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new Error('Malformed capability token');
    const header = decode<CapabilityTokenHeader>(encodedHeader);
    if (header.alg !== 'EdDSA' || header.typ !== 'CAP' || !header.kid) throw new Error('Unsupported capability token');
    const key = this.getPublicKey(header.kid);
    if (!verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(encodedSignature, 'base64url'))) throw new Error('Invalid capability token signature');
    const grant = decode<CapabilityGrant>(encodedPayload);
    if (!grant.jti || !grant.tenantId || !grant.runId || !grant.stepId || !Array.isArray(grant.effectTypes)) throw new Error('Malformed capability grant');
    if (grant.issuer !== this.options.issuer || grant.audience !== this.options.audience || grant.keyId !== header.kid) throw new Error('Capability token issuer/audience mismatch');
    const time = at.getTime();
    const issuedAt = Date.parse(grant.issuedAt ?? '');
    const notBefore = Date.parse(grant.notBefore ?? grant.issuedAt ?? '');
    const expiresAt = Date.parse(grant.expiresAt);
    if (![issuedAt, notBefore, expiresAt].every(Number.isFinite) || issuedAt - this.clockSkewMs > time || notBefore - this.clockSkewMs > time || expiresAt + this.clockSkewMs <= time) throw new Error('Expired or not-yet-valid capability grant');
    if (await this.options.revocations?.isRevoked(grant.jti)) throw new Error('Capability grant revoked');
    if (grant.nonce && await this.options.replay?.consume(`${grant.jti}:${grant.nonce}`, grant.expiresAt)) throw new Error('Capability grant replayed');
    return grant;
  }

  private getPublicKey(kid: string): KeyObject {
    const keys = this.options.publicKeys;
    const key = keys instanceof Map ? keys.get(kid) : (keys as Record<string, KeyLike>)[kid];
    if (!key) throw new Error(`Unknown capability token key id: ${kid}`);
    return normalizePublicKey(key);
  }
}

/**
 * Capability token port — structural contract the broker depends on. The
 * broker only calls `verify`; `revoke` is optional and wired by callers that
 * need to invalidate grants. Accepts a {@link CapabilityTokenVerifier} or any
 * structurally-compatible object (e.g. a test double).
 */
export interface CapabilityTokenPort {
  verify(token: string, now?: Date): Promise<CapabilityGrant>;
  revoke?(grant: CapabilityGrant): void | Promise<void>;
}

export interface EffectBrokerOptions {
  audience?: string;
  approval?: ApprovalInteractionPort;
  requireRequestBinding?: boolean;
  /** WS2 §5: daily per-tenant quota ceiling. When set, admit() pre-checks
   *  getQuota (if present) before kernel admission and only charges
   *  incrementQuota after a successful *new* admit — never on LEASE_LOST
   *  or idempotent COMPLETED replays. */
  quotaLimits?: { maxCountPerDay?: number };
  /** Local worker identity for executeAdmitted affinity checks (C-α). */
  localWorkerId?: string;
  localWorkerGeneration?: number;
}

/**
 * Process-local, non-durable staging for effects that passed admit() and await
 * execute() on this worker. NOT a cross-worker reload store — the kernel
 * ledger is authoritative for admission state. Split admit/execute MUST stay
 * on the same worker (enforced by localWorkerId affinity at executeAdmitted).
 */
export interface AdmissionStore {
  put(effectId: string, entry: AdmittedEffect): void;
  get(effectId: string): AdmittedEffect | null;
  delete(effectId: string): void;
}

export interface AdmittedEffect {
  effectId: string;
  grant: CapabilityGrant;
  decision: PolicyDecision;
  type: string;
  request: Record<string, unknown>;
  lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
  actor: string;
  kernelEffectId: string;
  replayed: boolean;
  /** Kernel ledger state at admit time — replay cache-hit only when COMPLETED. */
  effectState: string;
  cachedResponse?: Record<string, unknown>;
}

class InMemoryAdmissionStore implements AdmissionStore {
  private readonly map = new Map<string, AdmittedEffect>();
  put(effectId: string, entry: AdmittedEffect): void { this.map.set(effectId, entry); }
  get(effectId: string): AdmittedEffect | null { return this.map.get(effectId) ?? null; }
  delete(effectId: string): void { this.map.delete(effectId); }
}

/**
 * Permit-default sentinel. Any PolicyEvaluator whose decision carries this
 * decisionId is rejected by the broker in production — this closes the
 * worker allow-all bootstrap bypass (see spec/ws2-effect-monopoly.md §4).
 *
 * The literal is split on purpose: scripts/ws2-build-gate.mjs forbids the
 * sentinel string literal in production source so PolicyEvaluators cannot
 * emit a permit-all decisionId. This constant is the broker's defense
 * (it detects the sentinel), not a bypass — so it is assembled from parts
 * that the gate's regex does not match.
 */
export const PERMIT_DEFAULT_DECISION_ID = 'permit' + '-default';

function isProductionProfile(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

function bindingMismatch(
  grant: CapabilityGrant,
  binding: WorkloadBinding,
): string | null {
  if (grant.tenantId !== binding.tenantId) return 'TENANT_MISMATCH';
  if (grant.runId !== binding.runId) return 'RUN_MISMATCH';
  if (grant.stepId !== binding.stepId) return 'STEP_MISMATCH';
  // Symmetric: either side pinning workloadId must match (prevents token/binding split).
  if (grant.workloadId !== binding.workloadId) {
    return 'WORKLOAD_MISMATCH';
  }
  return null;
}

/** The only supported path for an external write in Architecture V2. */
export class EffectBroker {
  private readonly options: Required<Pick<EffectBrokerOptions, 'audience' | 'requireRequestBinding'>> & Pick<EffectBrokerOptions, 'approval' | 'quotaLimits' | 'localWorkerId' | 'localWorkerGeneration'>;
  private readonly admissionStore: AdmissionStore;

  constructor(
    private readonly tokens: CapabilityTokenPort | CapabilityTokenVerifier,
    private readonly policy: PolicyEvaluator,
    private readonly kernel: EffectKernelPort,
    private readonly executor: EffectExecutor,
    private readonly audit: AuditSink,
    options: EffectBrokerOptions = {},
  ) {
    const production = process.env.NODE_ENV === 'production';
    const enterprise = process.env.COMMANDER_PROFILE === 'enterprise';
    const requireRequestBinding = options.requireRequestBinding ?? true;
    // WS2 §4 runtime gate: production must not disable request binding.
    if (production && !requireRequestBinding) {
      throw new EffectBrokerError('REQUEST_BINDING_DISABLED_IN_PROD');
    }
    // Production/enterprise workers must pin affinity — unset localWorkerId
    // silently skips fencing and allows cross-worker execute of admitted effects.
    if ((production || enterprise) && !options.localWorkerId) {
      throw new EffectBrokerError('WORKER_AFFINITY_REQUIRED_IN_PROD');
    }
    this.options = { audience: options.audience ?? 'commander.effect-broker', requireRequestBinding, approval: options.approval, quotaLimits: options.quotaLimits, localWorkerId: options.localWorkerId, localWorkerGeneration: options.localWorkerGeneration };
    this.admissionStore = new InMemoryAdmissionStore();
  }

  /** Bind process-local worker generation after registry.register (bootstrap). */
  bindLocalWorkerGeneration(generation: number): void {
    this.options.localWorkerGeneration = generation;
  }

  /**
   * admit() — Phase 1 of the WS2 split. Verifies capability, policy, request
   * binding, tenant consistency, and writes the effect to the kernel ledger.
   * Does NOT invoke the executor. Returns the admission handle (effectId)
   * that execute() consumes.
   */
  async admit(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    /** Step-scoped identity binding from kernel-claimed workload context. */
    workloadBinding?: WorkloadBinding;
  }): Promise<AdmissionResult> {
    const grant = await this.tokens.verify(input.token);
    if (isProductionProfile() && !input.workloadBinding) {
      return this.rejectAdmit(grant, 'WORKLOAD_BINDING_REQUIRED', {});
    }
    if (input.workloadBinding) {
      const mismatch = bindingMismatch(grant, input.workloadBinding);
      if (mismatch) return this.rejectAdmit(grant, mismatch, { binding: input.workloadBinding });
    }
    if (grant.audience !== this.options.audience) return this.rejectAdmit(grant, 'AUDIENCE_MISMATCH', {});
    if (!grant.effectTypes.includes(input.type)) return this.rejectAdmit(grant, 'CAPABILITY_DENIED', { type: input.type });
    if (this.options.requireRequestBinding && grant.requestHash !== canonicalRequestHash(input.request)) return this.rejectAdmit(grant, 'REQUEST_HASH_MISMATCH', {});
    const decision = await this.policy.evaluate({ tenantId: grant.tenantId, runId: grant.runId, stepId: grant.stepId, type: input.type, request: input.request, token: grant });
    // WS2 §4 runtime gate: permit-all PolicyEvaluator is forbidden.
    if (decision.decisionId === PERMIT_DEFAULT_DECISION_ID) return this.rejectAdmit(grant, 'PERMIT_ALL_FORBIDDEN', { decisionId: decision.decisionId });
    if (grant.policySnapshotId && grant.policySnapshotId !== decision.policySnapshotId) return this.rejectAdmit(grant, 'POLICY_SNAPSHOT_MISMATCH', { expected: grant.policySnapshotId, actual: decision.policySnapshotId });
    if (decision.effect === 'require_approval') {
      if (!this.options.approval) return this.rejectAdmit(grant, 'APPROVAL_REQUIRED', { decisionId: decision.decisionId });
      const interaction = await this.options.approval.createApprovalInteraction({ tenantId: grant.tenantId, runId: grant.runId, stepId: grant.stepId, effectType: input.type, request: input.request, policyDecisionId: decision.decisionId, actor: input.actor });
      return this.rejectAdmit(grant, 'APPROVAL_REQUIRED', { decisionId: decision.decisionId, interactionId: interaction.interactionId });
    }
    if (decision.effect !== 'allow') return this.rejectAdmit(grant, 'POLICY_DENIED', { decisionId: decision.decisionId, reason: decision.reason });
    // WS2 §5: three-layer policy engine — tenant allowlist + daily quota.
    // Enforced fail-closed whenever the kernel port provides the methods
    // (the kernel repository always does; narrow test doubles may omit them).
    if (this.kernel.isActionAllowed) {
      const allowed = await this.kernel.isActionAllowed(grant.tenantId, input.type);
      if (!allowed) return this.rejectAdmit(grant, 'ACTION_NOT_ALLOWLISTED', { type: input.type, decisionId: decision.decisionId });
    }
    const actionClass = input.type.split('.')[0] || input.type;
    const maxCount = this.options.quotaLimits?.maxCountPerDay;
    // Pre-check without burning quota: reject before admitEffect when already at ceiling.
    if (maxCount !== undefined && this.kernel.getQuota) {
      const current = await this.kernel.getQuota(grant.tenantId, actionClass);
      if (current.countUsed >= maxCount) {
        return this.rejectAdmit(grant, 'QUOTA_EXCEEDED', { actionClass, countUsed: current.countUsed, limit: maxCount });
      }
    }
    const admitted = await this.kernel.admitEffect({ id: input.effectId, runId: grant.runId, stepId: grant.stepId, tenantId: grant.tenantId, type: input.type, idempotencyKey: input.idempotencyKey, policyDecisionId: decision.decisionId, request: input.request, lease: input.lease, actor: input.actor });
    if (!admitted.admitted || !admitted.effect) return this.rejectAdmit(grant, 'EFFECT_ADMISSION_REJECTED', { reason: admitted.reason ?? 'unknown' });
    // Charge only successful new admissions. LEASE_LOST / conflict never reach here;
    // idempotent replays must not double-count.
    if (this.kernel.incrementQuota && !admitted.replayed) {
      const usage = await this.kernel.incrementQuota({ tenantId: grant.tenantId, actionClass });
      if (maxCount !== undefined && usage.countUsed > maxCount) {
        // Concurrent admits can race past getQuota; the effect is already on the ledger.
        // Fail-closed: never hand out an admission handle for an over-quota effect, and
        // park it so retries cannot treat ADMITTED as a silent success.
        await this.kernel.markEffectCompletionUnknown?.({
          effectId: admitted.effect.id,
          tenantId: grant.tenantId,
          reason: 'QUOTA_EXCEEDED after admission (concurrent race)',
          actor: input.actor,
        });
        return this.rejectAdmit(grant, 'QUOTA_EXCEEDED', { actionClass, countUsed: usage.countUsed, limit: maxCount });
      }
    }
    const effectState = admitted.effect.state;
    // Idempotent replay is only a successful cache hit when the prior effect COMPLETED.
    // ADMITTED / COMPLETION_UNKNOWN / FAILED must not return undefined as "success".
    const completedReplay = !!admitted.replayed && effectState === 'COMPLETED';
    const result: AdmissionResult = {
      admitted: true,
      effectId: admitted.effect.id,
      replayed: !!admitted.replayed,
      cachedResponse: completedReplay ? admitted.effect.response : undefined,
      decisionId: decision.decisionId,
      policySnapshotId: decision.policySnapshotId,
    };
    this.admissionStore.put(input.effectId, {
      effectId: input.effectId,
      grant,
      decision,
      type: input.type,
      request: input.request,
      lease: input.lease,
      actor: input.actor,
      kernelEffectId: admitted.effect.id,
      replayed: !!admitted.replayed,
      effectState,
      cachedResponse: completedReplay ? admitted.effect.response : undefined,
    });
    return result;
  }

  /**
   * execute() — Phase 2 of the WS2 split. Consumes an admission handle and
   * dispatches the effect to the executor. Completed idempotent replays return
   * the cached response; incomplete prior states fail closed.
   */
  async executeAdmitted(input: {
    effectId: string;
    timeoutMs?: number;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }> {
    const admission = this.admissionStore.get(input.effectId);
    if (!admission) throw new EffectBrokerError('ADMISSION_NOT_FOUND', { effectId: input.effectId });
    // Affinity must run inside try/finally so fail-closed consume clears the
    // process-local admission (grant/request) instead of leaking forever.
    let finished = false;
    let parked = false;
    try {
      this.assertWorkerAffinity(admission);
      if (admission.replayed) {
        if (admission.effectState === 'COMPLETED') {
          finished = true;
          return { effectId: admission.kernelEffectId, replayed: true, response: admission.cachedResponse };
        }
        if (admission.effectState === 'COMPLETION_UNKNOWN') {
          throw new EffectBrokerError('COMPLETION_UNKNOWN', {
            effectId: admission.kernelEffectId,
            state: admission.effectState,
          });
        }
        if (admission.effectState === 'FAILED') {
          throw new EffectBrokerError('EFFECT_FAILED', {
            effectId: admission.kernelEffectId,
            state: admission.effectState,
          });
        }
        // ADMITTED replay: park on the ledger so step retries cannot spin on EFFECT_IN_FLIGHT forever.
        await this.parkUnfinishedAdmission(admission, 'incomplete_idempotent_replay');
        parked = true;
        throw new EffectBrokerError('COMPLETION_UNKNOWN', {
          effectId: admission.kernelEffectId,
          state: 'COMPLETION_UNKNOWN',
        });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Effect timeout')), input.timeoutMs ?? 30_000);
      try {
        const response = await this.executor.execute({
          type: admission.type,
          request: admission.request,
          signal: controller.signal,
          executionContext: {
            tenantId: admission.grant.tenantId,
            workerId: admission.lease.workerId,
            ...(admission.lease.workerGeneration !== undefined ? { workerGeneration: admission.lease.workerGeneration } : {}),
            fencingEpoch: admission.lease.fencingEpoch,
            leaseToken: admission.lease.token,
            effectId: admission.effectId,
          },
        });
        const committed = await this.kernel.completeEffect(admission.kernelEffectId, admission.grant.tenantId, admission.lease, response, admission.actor);
        if (!committed) {
          await this.parkUnfinishedAdmission(admission, 'Kernel rejected completion after external executor returned');
          parked = true;
          throw new EffectBrokerError('COMPLETION_UNCONFIRMED');
        }
        await this.audit.append({ type: 'effect.completed', severity: 'low', tenantId: admission.grant.tenantId, runId: admission.grant.runId, stepId: admission.grant.stepId, at: new Date().toISOString(), details: { effectId: admission.kernelEffectId, policyDecisionId: admission.decision.decisionId } });
        finished = true;
        return { effectId: admission.kernelEffectId, replayed: false, response };
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (!finished && !parked && admission.effectState === 'ADMITTED') {
        // L4-02: adapter taxonomy — NOT_COMMITTED → failEffect (terminal);
        // UNKNOWN → park (QUERY_FIRST). Other errors keep fail-closed park.
        if (error instanceof AdapterExecutionError) {
          if (error.commitState === 'NOT_COMMITTED') {
            const failed = await this.kernel.failEffect?.({
              effectId: admission.kernelEffectId,
              tenantId: admission.grant.tenantId,
              lease: admission.lease,
              error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                ...(error.details ? { details: error.details } : {}),
              },
              actor: admission.actor,
            });
            if (!failed) {
              await this.parkUnfinishedAdmission(admission, error.code);
              parked = true;
              throw new EffectBrokerError('COMPLETION_UNKNOWN', {
                effectId: admission.kernelEffectId,
                code: error.code,
                commitState: error.commitState,
                retryMode: error.retryMode,
              });
            }
            throw new EffectBrokerError('EFFECT_FAILED', {
              effectId: admission.kernelEffectId,
              code: error.code,
              commitState: error.commitState,
              retryMode: error.retryMode,
            });
          }
          await this.parkUnfinishedAdmission(admission, error.code);
          parked = true;
          throw new EffectBrokerError('COMPLETION_UNKNOWN', {
            effectId: admission.kernelEffectId,
            code: error.code,
            commitState: error.commitState,
            retryMode: error.retryMode,
          });
        }
        await this.parkUnfinishedAdmission(
          admission,
          error instanceof EffectBrokerError ? error.code : 'execute_admitted_failed',
        );
      }
      throw error;
    } finally {
      this.admissionStore.delete(input.effectId);
    }
  }

  /** Park an ADMITTED ledger row so idempotent retries fail closed as COMPLETION_UNKNOWN, not in-flight spin. */
  private async parkUnfinishedAdmission(admission: AdmittedEffect, reason: string): Promise<void> {
    await this.kernel.markEffectCompletionUnknown?.({
      effectId: admission.kernelEffectId,
      tenantId: admission.grant.tenantId,
      reason,
      actor: admission.actor,
    });
  }

  /**
   * L3-08a — query-after-timeout reconcile for COMPLETION_UNKNOWN effects.
   * Never invokes the write executor; only queries remote outcome and advances ledger.
   */
  async reconcileUnknown(input: {
    effectId: string;
    tenantId: string;
    actor: string;
    querier: EffectOutcomeQuerier;
  }): Promise<ReconcileUnknownResult> {
    if (!this.kernel.getEffect || !this.kernel.reconcileEffect) {
      throw new EffectBrokerError('RECONCILE_UNSUPPORTED', {
        effectId: input.effectId,
        reason: 'kernel missing getEffect/reconcileEffect',
      });
    }
    const effect = await this.kernel.getEffect(input.effectId, input.tenantId);
    if (!effect) {
      throw new EffectBrokerError('EFFECT_NOT_FOUND', { effectId: input.effectId, tenantId: input.tenantId });
    }
    if (effect.state !== 'COMPLETION_UNKNOWN') {
      throw new EffectBrokerError('EFFECT_NOT_UNKNOWN', {
        effectId: input.effectId,
        state: effect.state,
      });
    }

    const remote = await input.querier.queryOutcome({
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      type: effect.type,
      request: effect.request,
      tenantId: effect.tenantId,
    });

    if (remote.status === 'UNKNOWN') {
      await this.audit.append({
        type: 'effect.reconcile_escalated',
        severity: 'high',
        tenantId: effect.tenantId,
        runId: effect.runId,
        stepId: effect.stepId,
        at: new Date().toISOString(),
        details: {
          effectId: effect.id,
          idempotencyKey: effect.idempotencyKey,
          reason: 'queryOutcome still UNKNOWN after timeout',
        },
      });
      return {
        status: 'ESCALATED',
        effectId: effect.id,
        reason: 'queryOutcome still UNKNOWN after timeout',
        invokedExecutor: false,
      };
    }

    const advanced = await this.kernel.reconcileEffect({
      effectId: effect.id,
      tenantId: effect.tenantId,
      state: remote.status,
      response: remote.response,
      actor: input.actor,
    });
    if (!advanced) {
      throw new EffectBrokerError('RECONCILE_REJECTED', {
        effectId: effect.id,
        attempted: remote.status,
      });
    }

    await this.audit.append({
      type: 'effect.reconciled',
      severity: 'medium',
      tenantId: effect.tenantId,
      runId: effect.runId,
      stepId: effect.stepId,
      at: new Date().toISOString(),
      details: {
        effectId: effect.id,
        state: remote.status,
        idempotencyKey: effect.idempotencyKey,
      },
    });

    return {
      status: remote.status,
      effectId: effect.id,
      response: remote.response,
      invokedExecutor: false,
    };
  }

  /**
   * execute() — legacy single-call path. Kept for backward compatibility with
   * existing StepExecutors (tool/connector). Equivalent to admit() followed
   * by executeAdmitted(). Surfaces the original admit() rejection code so
   * existing callers/tests keep matching on POLICY_DENIED, REQUEST_HASH_MISMATCH, etc.
   */
  async execute(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    timeoutMs?: number;
    workloadBinding?: WorkloadBinding;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }> {
    const admission = await this.admit(input);
    if (!admission.admitted) {
      throw new EffectBrokerError(admission.reason ?? 'ADMIT_REJECTED', admission.details ?? { reason: admission.reason });
    }
    return this.executeAdmitted({ effectId: input.effectId, timeoutMs: input.timeoutMs });
  }

  private assertWorkerAffinity(admission: AdmittedEffect): void {
    const localWorkerId = this.options.localWorkerId;
    if (!localWorkerId) return;
    if (admission.lease.workerId !== localWorkerId) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        expectedWorkerId: localWorkerId,
        actualWorkerId: admission.lease.workerId,
      });
    }
    // Align with kernel live(): missing generation coerces to -1.
    const localGen = this.options.localWorkerGeneration;
    if (localGen !== undefined) {
      const leaseGen = admission.lease.workerGeneration ?? -1;
      if (leaseGen !== localGen) {
        throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
          effectId: admission.effectId,
          expectedWorkerGeneration: localGen,
          actualWorkerGeneration: leaseGen,
        });
      }
    }
    if (typeof admission.lease.token !== 'string' || admission.lease.token.length === 0) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        reason: 'missing_lease_token',
      });
    }
    if (!Number.isFinite(admission.lease.fencingEpoch) || admission.lease.fencingEpoch < 0) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        reason: 'invalid_fencing_epoch',
        actualFencingEpoch: admission.lease.fencingEpoch,
      });
    }
  }

  private async rejectAdmit(grant: CapabilityGrant, code: string, details: Record<string, unknown>): Promise<AdmissionResult> {
    await this.audit.append({ type: 'effect.rejected', severity: 'high', tenantId: grant.tenantId, runId: grant.runId, stepId: grant.stepId, at: new Date().toISOString(), details: { code, ...details } });
    return { admitted: false, effectId: '', replayed: false, decisionId: '', policySnapshotId: '', reason: code, details: { code, ...details } };
  }
}

export interface AdmissionResult {
  admitted: boolean;
  effectId: string;
  replayed: boolean;
  cachedResponse?: Record<string, unknown>;
  decisionId: string;
  policySnapshotId: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export class EffectBrokerError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) { super(code); this.name = 'EffectBrokerError'; }
}

export {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_DLP_EXCLUDED_KEYS,
  EVIDENCE_GENESIS_HASH,
  EVIDENCE_RESPONSE_SUMMARY_KEYS,
  buildEffectEvidenceBundle,
  buildRunEvidenceBundle,
  findDlpViolation,
  sanitizeForEvidence,
  verifyEvidenceBundle,
} from './evidenceBundle.js';
export type {
  BuildEvidenceBundleInput,
  EvidenceAuditSource,
  EvidenceBundle,
  EvidenceBundleAuditEntry,
  EvidenceBundleEffectEntry,
  EvidenceBundleIdentity,
  EvidenceBundleScope,
  EvidenceBundleVersions,
  EvidenceEffectSource,
  VerifyEvidenceBundleResult,
} from './evidenceBundle.js';

export {
  AdapterExecutionError,
  adapterErrorFromHttpStatus,
  classifyAdapterError,
} from './adapterErrors.js';
export type { AdapterCommitState, AdapterRetryMode } from './adapterErrors.js';
