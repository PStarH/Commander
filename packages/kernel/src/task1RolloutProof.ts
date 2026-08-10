import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';

type JsonRecord = Record<string, unknown>;

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMPOSE_IMAGE = /^[^\s]+@(sha256:[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const READINESS_PATH = '/ready/tenant-authority/v1';
const PROOF_KEYS = [
  'format',
  'installationId',
  'operationVersion',
  'proofSequence',
  'proofAttemptId',
  'lifecycleCommand',
  'topology',
  'configurationSha256',
  'platformBindingSha256',
  'requestedImageDigest',
  'proofKeySha256',
  'challengedResponse',
  'challengedResponseSha256',
  'platformArtifact',
  'platformArtifactSha256',
  'workload',
  'startedAt',
  'provenAt',
  'pinned',
  'metadata',
] as const;

export interface Task1AuthoritativePlatformFacts {
  topology: 'helm' | 'compose';
  apiProofUrl: string;
  platformArtifact: JsonRecord;
  platformArtifactSha256: string;
  workload: {
    uid: string;
    generation: string;
    observedGeneration: string;
    templateSha256: string;
    ready: readonly string[];
  };
  pinned: JsonRecord;
  metadata: {
    specRevision: 27;
    evidenceLevel: string;
    writeOwner: 'commander_owner';
    publicationPoint: 'commander_tenant_cutover_rollout_proofs';
  };
}

export interface Task1ReadinessChallengeInput {
  url: string;
  challenge: string;
  expectedServerSpkiSha256: string;
}

export interface Task1RolloutProofTransaction {
  lockCurrent(): Promise<{
    operation: Task1LifecycleOperation;
    nextProofSequence: string;
  }>;
  appendProof(proof: JsonRecord): Promise<void>;
}

export interface Task1RolloutProofTransactions {
  withLockedOwnerTransaction<T>(
    work: (transaction: Task1RolloutProofTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface Task1RolloutProofReceipt {
  operationVersion: string;
  proofSequence: string;
  proofAttemptId: string;
  rolloutProofSha256: string;
}

export interface Task1RecoveryPredecessorChallenge {
  status: 'proven';
  proof: JsonRecord;
}

export interface Task1RolloutProofRuntimeOptions {
  transactions: Task1RolloutProofTransactions;
  observePlatform(operation: Task1LifecycleOperation): Promise<Task1AuthoritativePlatformFacts>;
  challengeApi(input: Task1ReadinessChallengeInput): Promise<unknown>;
  createChallenge?: () => Buffer;
  createProofAttemptId?: () => string;
  now?: () => Date;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function binding(operation: Task1LifecycleOperation): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.requestedBindingJcs);
  } catch {
    return fail('TENANT_CUTOVER_PROOF_CURRENT_INVALID');
  }
  const value = record(parsed, 'TENANT_CUTOVER_PROOF_CURRENT_INVALID');
  if (
    canonicalBootstrapJson(value) !== operation.requestedBindingJcs ||
    canonicalBootstrapSha256(value) !== operation.requestedBindingSha256
  ) {
    fail('TENANT_CUTOVER_PROOF_CURRENT_INVALID');
  }
  return value;
}

function requestedImageDigest(operation: Task1LifecycleOperation, value: JsonRecord): string {
  const composeMatch =
    typeof value.apiImageDigest === 'string' ? COMPOSE_IMAGE.exec(value.apiImageDigest) : null;
  const imageDigest =
    operation.platformKind === 'compose' ? composeMatch?.[1] : value.apiImageDigest;
  if (
    typeof imageDigest !== 'string' ||
    !IMAGE_DIGEST.test(imageDigest) ||
    value.kind !== operation.platformKind ||
    value.phase !== operation.runtimePhase
  ) {
    fail('TENANT_CUTOVER_PROOF_CURRENT_INVALID');
  }
  return imageDigest;
}

function sameCurrent(expected: Task1LifecycleOperation, current: Task1LifecycleOperation): boolean {
  return (
    expected.installationUuid === current.installationUuid &&
    expected.operationVersion === current.operationVersion &&
    expected.requestedBindingJcs === current.requestedBindingJcs &&
    expected.requestedBindingSha256 === current.requestedBindingSha256 &&
    expected.requestedConfigurationJcs === current.requestedConfigurationJcs &&
    expected.requestedConfigurationSha256 === current.requestedConfigurationSha256 &&
    expected.databasePeerBindingSha256 === current.databasePeerBindingSha256 &&
    expected.proofKeySha256 === current.proofKeySha256 &&
    expected.operationKind === current.operationKind &&
    expected.runtimePhase === current.runtimePhase &&
    expected.platformKind === current.platformKind
  );
}

function validateCurrent(operation: Task1LifecycleOperation): void {
  if (
    !UUID.test(operation.installationUuid) ||
    !POSITIVE_DECIMAL.test(operation.operationVersion) ||
    !SHA256.test(operation.requestedBindingSha256) ||
    !SHA256.test(operation.requestedConfigurationSha256) ||
    !SHA256.test(operation.databasePeerBindingSha256) ||
    !SHA256.test(operation.proofKeySha256)
  ) {
    fail('TENANT_CUTOVER_PROOF_CURRENT_INVALID');
  }
}

function validatePlatformFacts(
  operation: Task1LifecycleOperation,
  currentBinding: JsonRecord,
  facts: Task1AuthoritativePlatformFacts,
): void {
  let url: URL;
  try {
    url = new URL(facts.apiProofUrl);
  } catch {
    return fail('TENANT_CUTOVER_PROOF_PLATFORM_MISMATCH');
  }
  if (
    facts.topology !== operation.platformKind ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== READINESS_PATH ||
    (operation.platformKind === 'compose' && facts.apiProofUrl !== currentBinding.apiProofUrl) ||
    !SHA256.test(facts.platformArtifactSha256) ||
    canonicalBootstrapSha256(facts.platformArtifact) !== facts.platformArtifactSha256 ||
    typeof facts.workload.uid !== 'string' ||
    facts.workload.uid.length === 0 ||
    !POSITIVE_DECIMAL.test(facts.workload.generation) ||
    facts.workload.observedGeneration !== facts.workload.generation ||
    !SHA256.test(facts.workload.templateSha256) ||
    facts.workload.ready.length === 0 ||
    new Set(facts.workload.ready).size !== facts.workload.ready.length ||
    facts.metadata.specRevision !== 27 ||
    facts.metadata.evidenceLevel !== 'live' ||
    facts.metadata.writeOwner !== 'commander_owner' ||
    facts.metadata.publicationPoint !== 'commander_tenant_cutover_rollout_proofs'
  ) {
    fail('TENANT_CUTOVER_PROOF_PLATFORM_MISMATCH');
  }
}

function challengedResponse(
  value: unknown,
  operation: Task1LifecycleOperation,
  challenge: string,
  imageDigest: string,
): JsonRecord {
  const response = record(value, 'TENANT_CUTOVER_PROOF_RESPONSE_MISMATCH');
  exactKeys(
    response,
    [
      'challenge',
      'operationVersion',
      'phase',
      'installationId',
      'databasePeerBindingSha256',
      'imageDigest',
      'configurationSha256',
    ],
    'TENANT_CUTOVER_PROOF_RESPONSE_MISMATCH',
  );
  if (
    response.challenge !== challenge ||
    response.operationVersion !== operation.operationVersion ||
    response.phase !== operation.runtimePhase ||
    response.installationId !== operation.installationUuid ||
    response.databasePeerBindingSha256 !== operation.databasePeerBindingSha256 ||
    response.imageDigest !== imageDigest ||
    response.configurationSha256 !== operation.requestedConfigurationSha256
  ) {
    fail('TENANT_CUTOVER_PROOF_RESPONSE_MISMATCH');
  }
  return response;
}

function lifecycleCommand(operation: Task1LifecycleOperation): string {
  switch (operation.operationKind) {
    case 'legacy_expand':
      return 'expand';
    case 'fresh_enforce':
      return 'install_enforce';
    case 'enforce':
      return 'enforce';
    case 'recover_runtime_after_enforce_failure':
      return operation.operationKind;
    case 'rollback_to_recorded_expand':
      return operation.operationKind;
  }
}

export function isTask1RolloutProofForOperation(
  operation: Task1LifecycleOperation,
  proofJcs: string,
  proofSha256: string,
): boolean {
  try {
    validateCurrent(operation);
    if (!SHA256.test(proofSha256)) return false;
    const parsed = JSON.parse(proofJcs) as unknown;
    const proof = record(parsed, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    if (
      canonicalBootstrapJson(proof) !== proofJcs ||
      canonicalBootstrapSha256(proof) !== proofSha256
    )
      return false;
    exactKeys(proof, PROOF_KEYS, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    const currentBinding = binding(operation);
    const imageDigest = requestedImageDigest(operation, currentBinding);
    if (
      proof.format !== 'rollout-proof/v1' ||
      proof.installationId !== operation.installationUuid ||
      proof.operationVersion !== operation.operationVersion ||
      typeof proof.proofSequence !== 'string' ||
      !POSITIVE_DECIMAL.test(proof.proofSequence) ||
      typeof proof.proofAttemptId !== 'string' ||
      !UUID.test(proof.proofAttemptId) ||
      proof.lifecycleCommand !== lifecycleCommand(operation) ||
      proof.topology !== operation.platformKind ||
      proof.configurationSha256 !== operation.requestedConfigurationSha256 ||
      proof.platformBindingSha256 !== operation.requestedBindingSha256 ||
      proof.requestedImageDigest !== imageDigest ||
      proof.proofKeySha256 !== operation.proofKeySha256
    )
      return false;

    const response = record(proof.challengedResponse, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    if (
      typeof response.challenge !== 'string' ||
      !CHALLENGE.test(response.challenge) ||
      challengedResponse(response, operation, response.challenge, imageDigest) !== response ||
      proof.challengedResponseSha256 !== canonicalBootstrapSha256(response)
    )
      return false;

    const artifact = record(proof.platformArtifact, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    if (
      typeof proof.platformArtifactSha256 !== 'string' ||
      canonicalBootstrapSha256(artifact) !== proof.platformArtifactSha256
    )
      return false;
    const workload = record(proof.workload, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    exactKeys(
      workload,
      ['uid', 'generation', 'observedGeneration', 'templateSha256', 'ready'],
      'TENANT_CUTOVER_PROOF_RETAINED_INVALID',
    );
    if (
      typeof workload.uid !== 'string' ||
      workload.uid.length === 0 ||
      typeof workload.generation !== 'string' ||
      !POSITIVE_DECIMAL.test(workload.generation) ||
      workload.observedGeneration !== workload.generation ||
      typeof workload.templateSha256 !== 'string' ||
      !SHA256.test(workload.templateSha256) ||
      !Array.isArray(workload.ready) ||
      workload.ready.length === 0 ||
      !workload.ready.every((value) => typeof value === 'string' && value.length > 0) ||
      new Set(workload.ready).size !== workload.ready.length
    )
      return false;

    record(proof.pinned, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    const metadata = record(proof.metadata, 'TENANT_CUTOVER_PROOF_RETAINED_INVALID');
    exactKeys(
      metadata,
      ['specRevision', 'evidenceLevel', 'writeOwner', 'publicationPoint'],
      'TENANT_CUTOVER_PROOF_RETAINED_INVALID',
    );
    if (
      metadata.specRevision !== 27 ||
      metadata.evidenceLevel !== 'live' ||
      metadata.writeOwner !== 'commander_owner' ||
      metadata.publicationPoint !== 'commander_tenant_cutover_rollout_proofs' ||
      typeof proof.startedAt !== 'string' ||
      typeof proof.provenAt !== 'string'
    )
      return false;
    const startedAt = new Date(proof.startedAt);
    const provenAt = new Date(proof.provenAt);
    return (
      Number.isFinite(startedAt.getTime()) &&
      Number.isFinite(provenAt.getTime()) &&
      startedAt.toISOString() === proof.startedAt &&
      provenAt.toISOString() === proof.provenAt &&
      provenAt.getTime() >= startedAt.getTime()
    );
  } catch {
    return false;
  }
}

export class Task1RolloutProofRuntime {
  constructor(private readonly options: Task1RolloutProofRuntimeOptions) {}

  private async challengeOperation(operation: Task1LifecycleOperation): Promise<{
    facts: Task1AuthoritativePlatformFacts;
    imageDigest: string;
    response: JsonRecord;
  }> {
    validateCurrent(operation);
    const currentBinding = binding(operation);
    const imageDigest = requestedImageDigest(operation, currentBinding);
    const facts = await this.options.observePlatform(operation);
    validatePlatformFacts(operation, currentBinding, facts);

    const challengeBytes = (this.options.createChallenge ?? (() => randomBytes(32)))();
    if (!Buffer.isBuffer(challengeBytes) || challengeBytes.length !== 32) {
      fail('TENANT_CUTOVER_PROOF_CHALLENGE_INVALID');
    }
    const challenge = challengeBytes.toString('base64url');
    const response = challengedResponse(
      await this.options.challengeApi({
        url: facts.apiProofUrl,
        challenge,
        expectedServerSpkiSha256: operation.proofKeySha256,
      }),
      operation,
      challenge,
      imageDigest,
    );
    return { facts, imageDigest, response };
  }

  async challengeRecoveryPredecessor(
    expected: Task1LifecycleOperation,
  ): Promise<Task1RecoveryPredecessorChallenge> {
    const { response } = await this.challengeOperation(expected);
    return { status: 'proven', proof: response };
  }

  async proveCurrent(expected: Task1LifecycleOperation): Promise<Task1RolloutProofReceipt> {
    const proofAttemptId = (this.options.createProofAttemptId ?? randomUUID)();
    if (!UUID.test(proofAttemptId)) fail('TENANT_CUTOVER_PROOF_ATTEMPT_INVALID');
    return this.options.transactions.withLockedOwnerTransaction(async (transaction) => {
      const locked = await transaction.lockCurrent();
      validateCurrent(locked.operation);
      if (!sameCurrent(expected, locked.operation)) {
        fail('TENANT_CUTOVER_PROOF_CURRENT_CHANGED');
      }
      if (!POSITIVE_DECIMAL.test(locked.nextProofSequence)) {
        fail('TENANT_CUTOVER_PROOF_SEQUENCE_INVALID');
      }

      const startedAt = (this.options.now ?? (() => new Date()))();
      if (!Number.isFinite(startedAt.getTime())) fail('TENANT_CUTOVER_PROOF_TIME_INVALID');

      const { facts, imageDigest, response } = await this.challengeOperation(locked.operation);
      const provenAt = (this.options.now ?? (() => new Date()))();
      if (!Number.isFinite(provenAt.getTime()) || provenAt.getTime() < startedAt.getTime()) {
        fail('TENANT_CUTOVER_PROOF_TIME_INVALID');
      }

      const proof: JsonRecord = {
        format: 'rollout-proof/v1',
        installationId: locked.operation.installationUuid,
        operationVersion: locked.operation.operationVersion,
        proofSequence: locked.nextProofSequence,
        proofAttemptId,
        lifecycleCommand: lifecycleCommand(locked.operation),
        topology: facts.topology,
        configurationSha256: locked.operation.requestedConfigurationSha256,
        platformBindingSha256: locked.operation.requestedBindingSha256,
        requestedImageDigest: imageDigest,
        proofKeySha256: locked.operation.proofKeySha256,
        challengedResponse: response,
        challengedResponseSha256: canonicalBootstrapSha256(response),
        platformArtifact: facts.platformArtifact,
        platformArtifactSha256: facts.platformArtifactSha256,
        workload: facts.workload,
        startedAt: startedAt.toISOString(),
        provenAt: provenAt.toISOString(),
        pinned: facts.pinned,
        metadata: facts.metadata,
      };
      await transaction.appendProof(proof);
      return {
        operationVersion: locked.operation.operationVersion,
        proofSequence: locked.nextProofSequence,
        proofAttemptId,
        rolloutProofSha256: canonicalBootstrapSha256(proof),
      };
    });
  }
}
