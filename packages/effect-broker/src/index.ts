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
  nonce?: string;
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
  revoke(jti: string, expiresAt: string): void {
    this.revoked.set(jti, Date.parse(expiresAt));
  }
  isRevoked(jti: string): boolean {
    const expiry = this.revoked.get(jti);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
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
  }): Promise<{
    admitted: boolean;
    replayed?: boolean;
    reason?: string;
    effect?: { id: string; response?: Record<string, unknown>; state: string };
  }>;
  completeEffect(
    effectId: string,
    tenantId: string,
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number },
    response: Record<string, unknown>,
    actor: string,
  ): Promise<unknown | null>;
  markEffectCompletionUnknown?(input: {
    effectId: string;
    tenantId: string;
    reason: string;
    actor: string;
  }): Promise<unknown | null>;
}

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

interface CapabilityTokenHeader {
  alg: 'EdDSA';
  typ: 'CAP';
  kid: string;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = <T>(value: string): T =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
const nowIso = (clock: () => Date): string => clock().toISOString();

/** Stable hash used by both the issuer and verifier for exact request binding. */
export function canonicalRequestHash(value: Record<string, unknown>): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    return `{${Object.keys(input as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizePrivateKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPrivateKey(key);
}

function normalizePublicKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPublicKey(key);
}

function publicKeyFromPrivateKey(key: KeyObject): KeyObject {
  return createPublicKey(key.export({ format: 'pem', type: 'pkcs8' }).toString());
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
    return publicKeyFromPrivateKey(this.privateKey);
  }

  issue(
    grant: Omit<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'> &
      Partial<Pick<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'>>,
  ): string {
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

  static generate(
    options: Omit<CapabilityTokenIssuerOptions, 'privateKey' | 'keyId'> & { keyId?: string },
  ): CapabilityTokenIssuer {
    const { privateKey } = generateKeyPairSync('ed25519');
    return new CapabilityTokenIssuer({
      ...options,
      keyId: options.keyId ?? 'generated',
      privateKey,
    });
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
    if (!encodedHeader || !encodedPayload || !encodedSignature || extra)
      throw new Error('Malformed capability token');
    const header = decode<CapabilityTokenHeader>(encodedHeader);
    if (header.alg !== 'EdDSA' || header.typ !== 'CAP' || !header.kid)
      throw new Error('Unsupported capability token');
    const key = this.getPublicKey(header.kid);
    if (
      !verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key,
        Buffer.from(encodedSignature, 'base64url'),
      )
    )
      throw new Error('Invalid capability token signature');
    const grant = decode<CapabilityGrant>(encodedPayload);
    if (
      !grant.jti ||
      !grant.tenantId ||
      !grant.runId ||
      !grant.stepId ||
      !Array.isArray(grant.effectTypes)
    )
      throw new Error('Malformed capability grant');
    if (
      grant.issuer !== this.options.issuer ||
      grant.audience !== this.options.audience ||
      grant.keyId !== header.kid
    )
      throw new Error('Capability token issuer/audience mismatch');
    const time = at.getTime();
    const issuedAt = Date.parse(grant.issuedAt ?? '');
    const notBefore = Date.parse(grant.notBefore ?? grant.issuedAt ?? '');
    const expiresAt = Date.parse(grant.expiresAt);
    if (
      ![issuedAt, notBefore, expiresAt].every(Number.isFinite) ||
      issuedAt - this.clockSkewMs > time ||
      notBefore - this.clockSkewMs > time ||
      expiresAt + this.clockSkewMs <= time
    )
      throw new Error('Expired or not-yet-valid capability grant');
    if (await this.options.revocations?.isRevoked(grant.jti))
      throw new Error('Capability grant revoked');
    if (
      grant.nonce &&
      (await this.options.replay?.consume(`${grant.jti}:${grant.nonce}`, grant.expiresAt))
    )
      throw new Error('Capability grant replayed');
    return grant;
  }

  private getPublicKey(kid: string): KeyObject {
    const keys = this.options.publicKeys;
    const key = keys instanceof Map ? keys.get(kid) : (keys as Record<string, KeyLike>)[kid];
    if (!key) throw new Error(`Unknown capability token key id: ${kid}`);
    return normalizePublicKey(key);
  }
}

function privateKeyFromSeed(seed: string): KeyObject {
  // RFC 8410 PKCS#8 wrapper around a deterministic 32-byte seed. This is
  // only a compatibility adapter; production callers should inject a KMS key.
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({
    key: Buffer.concat([prefix, createHash('sha256').update(seed).digest()]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Compatibility facade. New production code must use separate issuer and
 * verifier instances with Ed25519 public-key distribution.
 */
export class CapabilityTokenService {
  private readonly issuer: CapabilityTokenIssuer;
  private readonly verifier: CapabilityTokenVerifier;
  private readonly revocations?: CapabilityRevocationStore;

  constructor(seed: string, revocations?: CapabilityRevocationStore) {
    const privateKey = privateKeyFromSeed(seed);
    const publicKey = publicKeyFromPrivateKey(privateKey);
    this.revocations = revocations;
    this.issuer = new CapabilityTokenIssuer({
      issuer: 'commander.compatibility',
      audience: 'commander.effect-broker',
      keyId: 'compatibility',
      privateKey,
    });
    this.verifier = new CapabilityTokenVerifier({
      issuer: 'commander.compatibility',
      audience: 'commander.effect-broker',
      publicKeys: { compatibility: publicKey },
      revocations,
    });
  }

  issue(grant: CapabilityGrant): string {
    return this.issuer.issue({
      ...grant,
      policySnapshotId: grant.policySnapshotId ?? 'compatibility',
      requestHash: grant.requestHash ?? canonicalRequestHash({}),
    });
  }

  verify(token: string, now = new Date()): Promise<CapabilityGrant> {
    return this.verifier.verify(token, now);
  }

  revoke(grant: CapabilityGrant): void | Promise<void> {
    return this.revocations?.revoke(grant.jti, grant.expiresAt);
  }
}

export interface EffectBrokerOptions {
  audience?: string;
  approval?: ApprovalInteractionPort;
  requireRequestBinding?: boolean;
}

/** The only supported path for an external write in Architecture V2. */
export class EffectBroker {
  private readonly options: Required<
    Pick<EffectBrokerOptions, 'audience' | 'requireRequestBinding'>
  > &
    Pick<EffectBrokerOptions, 'approval'>;

  constructor(
    private readonly tokens:
      Pick<CapabilityTokenService, 'verify' | 'revoke'> | CapabilityTokenVerifier,
    private readonly policy: PolicyEvaluator,
    private readonly kernel: EffectKernelPort,
    private readonly executor: EffectExecutor,
    private readonly audit: AuditSink,
    options: EffectBrokerOptions = {},
  ) {
    this.options = {
      audience: options.audience ?? 'commander.effect-broker',
      requireRequestBinding: options.requireRequestBinding ?? true,
      approval: options.approval,
    };
  }

  async execute(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    timeoutMs?: number;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }> {
    const grant = await this.tokens.verify(input.token);
    if (grant.audience !== this.options.audience)
      return this.reject(grant, 'AUDIENCE_MISMATCH', {});
    if (!grant.effectTypes.includes(input.type))
      return this.reject(grant, 'CAPABILITY_DENIED', { type: input.type });
    if (
      this.options.requireRequestBinding &&
      grant.requestHash !== canonicalRequestHash(input.request)
    )
      return this.reject(grant, 'REQUEST_HASH_MISMATCH', {});
    const decision = await this.policy.evaluate({
      tenantId: grant.tenantId,
      runId: grant.runId,
      stepId: grant.stepId,
      type: input.type,
      request: input.request,
      token: grant,
    });
    if (grant.policySnapshotId && grant.policySnapshotId !== decision.policySnapshotId)
      return this.reject(grant, 'POLICY_SNAPSHOT_MISMATCH', {
        expected: grant.policySnapshotId,
        actual: decision.policySnapshotId,
      });
    if (decision.effect === 'require_approval') {
      if (!this.options.approval)
        return this.reject(grant, 'APPROVAL_REQUIRED', { decisionId: decision.decisionId });
      const interaction = await this.options.approval.createApprovalInteraction({
        tenantId: grant.tenantId,
        runId: grant.runId,
        stepId: grant.stepId,
        effectType: input.type,
        request: input.request,
        policyDecisionId: decision.decisionId,
        actor: input.actor,
      });
      return this.reject(grant, 'APPROVAL_REQUIRED', {
        decisionId: decision.decisionId,
        interactionId: interaction.interactionId,
      });
    }
    if (decision.effect !== 'allow')
      return this.reject(grant, 'POLICY_DENIED', {
        decisionId: decision.decisionId,
        reason: decision.reason,
      });
    const admitted = await this.kernel.admitEffect({
      id: input.effectId,
      runId: grant.runId,
      stepId: grant.stepId,
      tenantId: grant.tenantId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      policyDecisionId: decision.decisionId,
      request: input.request,
      lease: input.lease,
      actor: input.actor,
    });
    if (!admitted.admitted || !admitted.effect)
      return this.reject(grant, 'EFFECT_ADMISSION_REJECTED', {
        reason: admitted.reason ?? 'unknown',
      });
    if (admitted.replayed)
      return { effectId: admitted.effect.id, replayed: true, response: admitted.effect.response };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Effect timeout')),
      input.timeoutMs ?? 30_000,
    );
    try {
      const response = await this.executor.execute({
        type: input.type,
        request: input.request,
        signal: controller.signal,
      });
      const committed = await this.kernel.completeEffect(
        admitted.effect.id,
        grant.tenantId,
        input.lease,
        response,
        input.actor,
      );
      if (!committed) {
        await this.kernel.markEffectCompletionUnknown?.({
          effectId: admitted.effect.id,
          tenantId: grant.tenantId,
          reason: 'Kernel rejected completion after external executor returned',
          actor: input.actor,
        });
        throw new EffectBrokerError('COMPLETION_UNCONFIRMED');
      }
      await this.audit.append({
        type: 'effect.completed',
        severity: 'low',
        tenantId: grant.tenantId,
        runId: grant.runId,
        stepId: grant.stepId,
        at: new Date().toISOString(),
        details: {
          effectId: admitted.effect.id,
          type: input.type,
          policyDecisionId: decision.decisionId,
        },
      });
      return { effectId: admitted.effect.id, replayed: false, response };
    } finally {
      clearTimeout(timer);
    }
  }

  private async reject(
    grant: CapabilityGrant,
    code: string,
    details: Record<string, unknown>,
  ): Promise<never> {
    await this.audit.append({
      type: 'effect.rejected',
      severity: 'high',
      tenantId: grant.tenantId,
      runId: grant.runId,
      stepId: grant.stepId,
      at: new Date().toISOString(),
      details: { code, ...details },
    });
    throw new EffectBrokerError(code, details);
  }
}

export class EffectBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'EffectBrokerError';
  }
}
