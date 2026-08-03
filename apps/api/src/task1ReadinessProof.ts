export const TASK1_READINESS_PROOF_PATH = '/ready/tenant-authority/v1';
export const TASK1_READINESS_CHALLENGE_HEADER = 'x-commander-readiness-challenge';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION_VERSION = /^[1-9][0-9]*$/;

export interface Task1ReadinessRequest {
  method?: string;
  url?: string;
  rawHeaders: readonly string[];
}

export interface Task1ReadinessResponse {
  status(value: number): this;
  setHeader(name: string, value: string): void;
  end(value?: string): void;
}

export interface Task1RuntimeIdentity {
  operationVersion: string;
  phase: 'expand' | 'enforce';
  imageDigest: string;
  configurationSha256: string;
}

export interface Task1ReadinessProofOptions {
  nowMonotonicMs: () => number;
  installationId: string;
  databasePeerBindingSha256: string;
  expectedPhase: 'expand' | 'enforce';
  expectedImageDigest: string;
  expectedConfigurationSha256: string;
  selfCheckMaximumAgeMs?: number;
  runtimeIdentityMaximumAgeMs?: number;
}

interface Timed<T> {
  value: T;
  observedAtMs: number;
}

function isFresh(now: number, observedAt: number, maximumAge: number): boolean {
  const age = now - observedAt;
  return Number.isFinite(now) && Number.isFinite(observedAt) && age >= 0 && age <= maximumAge;
}

function challengeHeaders(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === TASK1_READINESS_CHALLENGE_HEADER) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function isValidChallenge(value: string): boolean {
  if (!CHALLENGE.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === 32;
  } catch {
    return false;
  }
}

export class Task1ReadinessProof {
  private selfCheck?: Timed<boolean>;
  private runtimeIdentity?: Timed<Task1RuntimeIdentity>;
  private readonly selfCheckMaximumAgeMs: number;
  private readonly runtimeIdentityMaximumAgeMs: number;

  constructor(private readonly options: Task1ReadinessProofOptions) {
    if (
      !options.installationId ||
      !SHA256.test(options.databasePeerBindingSha256) ||
      !IMAGE_DIGEST.test(options.expectedImageDigest) ||
      !SHA256.test(options.expectedConfigurationSha256)
    ) {
      throw new Error('TASK1_READINESS_CONFIGURATION_INVALID');
    }
    this.selfCheckMaximumAgeMs = options.selfCheckMaximumAgeMs ?? 10_000;
    this.runtimeIdentityMaximumAgeMs = options.runtimeIdentityMaximumAgeMs ?? 1_000;
  }

  recordTenantSelfCheck(ready: boolean): void {
    this.selfCheck = { value: ready, observedAtMs: this.options.nowMonotonicMs() };
  }

  invalidateTenantSelfCheck(): void {
    this.selfCheck = undefined;
  }

  recordRuntimeIdentity(identity: Task1RuntimeIdentity): void {
    if (
      !OPERATION_VERSION.test(identity.operationVersion) ||
      !IMAGE_DIGEST.test(identity.imageDigest) ||
      !SHA256.test(identity.configurationSha256) ||
      identity.phase !== this.options.expectedPhase ||
      identity.imageDigest !== this.options.expectedImageDigest ||
      identity.configurationSha256 !== this.options.expectedConfigurationSha256
    ) {
      this.runtimeIdentity = undefined;
      return;
    }
    this.runtimeIdentity = { value: { ...identity }, observedAtMs: this.options.nowMonotonicMs() };
  }

  invalidateRuntimeIdentity(): void {
    this.runtimeIdentity = undefined;
  }

  handle(request: Task1ReadinessRequest, response: Task1ReadinessResponse): boolean {
    if (request.url !== TASK1_READINESS_PROOF_PATH) return false;
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.status(405).end();
      return true;
    }

    const headers = challengeHeaders(request.rawHeaders);
    if (headers.length > 1 || (headers.length === 1 && !isValidChallenge(headers[0]!))) {
      response.status(400).end();
      return true;
    }

    const now = this.options.nowMonotonicMs();
    if (
      !this.selfCheck?.value ||
      !isFresh(now, this.selfCheck.observedAtMs, this.selfCheckMaximumAgeMs)
    ) {
      response.status(503).end();
      return true;
    }

    const challenge = headers[0];
    if (!challenge) {
      response.status(200).end(JSON.stringify({ status: 'ready' }));
      return true;
    }

    const cached = this.runtimeIdentity;
    if (
      !cached ||
      !isFresh(now, cached.observedAtMs, this.runtimeIdentityMaximumAgeMs) ||
      cached.value.phase !== this.options.expectedPhase ||
      cached.value.imageDigest !== this.options.expectedImageDigest ||
      cached.value.configurationSha256 !== this.options.expectedConfigurationSha256
    ) {
      response.status(503).end();
      return true;
    }

    response.status(200).end(
      JSON.stringify({
        challenge,
        operationVersion: cached.value.operationVersion,
        phase: cached.value.phase,
        installationId: this.options.installationId,
        databasePeerBindingSha256: this.options.databasePeerBindingSha256,
        imageDigest: cached.value.imageDigest,
        configurationSha256: cached.value.configurationSha256,
      }),
    );
    return true;
  }
}
