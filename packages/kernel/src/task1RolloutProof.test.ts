import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import {
  isTask1RolloutProofForOperation,
  Task1RolloutProofRuntime,
  type Task1AuthoritativePlatformFacts,
  type Task1RolloutProofTransaction,
} from './task1RolloutProof.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const proofAttemptIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

function operation(): Task1LifecycleOperation {
  const binding = {
    kind: 'compose', projectName: 'commander', composeVariant: 'prod',
    composeCredentialInventory: 'runtime-v1', composeSourceSha256: digest('a'),
    composeCliVersion: '5.3.1', composeContentSha256: digest('b'), phase: 'enforce',
    apiImageDigest: `registry.example/commander@sha256:${digest('c')}`,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
  };
  return {
    installationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationVersion: '7',
    predecessorStateVersion: '6', resultingStateVersion: '7', predecessorState: 'expanded',
    resultingState: 'enforced', operationKind: 'enforce', runtimePhase: 'enforce',
    platformKind: 'compose', previousBindingJcs: null, previousBindingSha256: null,
    requestedBindingJcs: canonicalBootstrapJson(binding),
    requestedBindingSha256: canonicalBootstrapSha256(binding),
    previousConfigurationJcs: null, previousConfigurationSha256: null,
    requestedConfigurationJcs: canonicalBootstrapJson({ operationAuditNonce: 'n'.repeat(43) }),
    requestedConfigurationSha256: digest('d'), previousBusinessConfigurationSha256: null,
    requestedBusinessConfigurationSha256: digest('e'), originBindingSha256: digest('f'),
    databasePeerBindingSha256: digest('1'), proofKeySha256: digest('2'), descriptorSet: [],
    predecessorEvidenceJcs: canonicalBootstrapJson({ kind: 'fresh-no-predecessor/v1' }),
    predecessorEvidenceSha256: digest('3'), predecessorProof: 'fresh-no-predecessor', result: 'committed',
  };
}

function platformFacts(): Task1AuthoritativePlatformFacts {
  const artifact = {
    format: 'compose-runtime-projection/v1', projectName: 'commander',
    imageDigest: `sha256:${digest('c')}`, containerId: 'a'.repeat(64),
  };
  return {
    topology: 'compose',
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
    platformArtifact: artifact,
    platformArtifactSha256: canonicalBootstrapSha256(artifact),
    workload: {
      uid: 'a'.repeat(64), generation: '1', observedGeneration: '1',
      templateSha256: digest('4'), ready: ['api'],
    },
    pinned: { node: process.version, compose: '5.3.1', sourceSha256: digest('a') },
    metadata: {
      specRevision: 27, evidenceLevel: 'live', writeOwner: 'commander_owner',
      publicationPoint: 'commander_tenant_cutover_rollout_proofs',
    },
  };
}

class RecordingTransaction implements Task1RolloutProofTransaction {
  readonly proofs: Array<Record<string, unknown>> = [];
  sequence = 0;
  constructor(readonly current = operation()) {}
  async lockCurrent() {
    return { operation: this.current, nextProofSequence: String(this.sequence + 1) };
  }
  async appendProof(proof: Record<string, unknown>) {
    this.sequence += 1;
    this.proofs.push(proof);
  }
}

function runtime(transaction: RecordingTransaction, overrides: Record<string, unknown> = {}) {
  const challenges: string[] = [];
  let attemptIndex = 0;
  const instance = new Task1RolloutProofRuntime({
    transactions: {
      withLockedOwnerTransaction: async (work) => work(transaction),
    },
    observePlatform: async () => platformFacts(),
    challengeApi: async ({ challenge }) => {
      challenges.push(challenge);
      return {
        challenge, operationVersion: '7', phase: 'enforce',
        installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        databasePeerBindingSha256: digest('1'), imageDigest: `sha256:${digest('c')}`,
        configurationSha256: digest('d'),
      };
    },
    createChallenge: () => Buffer.alloc(32, attemptIndex + 1),
    createProofAttemptId: () => proofAttemptIds[attemptIndex++]!,
    now: (() => {
      let tick = 0;
      return () => new Date(1_784_908_800_000 + tick++ * 1_000);
    })(),
    ...overrides,
  });
  return { instance, challenges };
}

describe('Task 1 rollout proof runtime', () => {
  it('challenges a recovery predecessor without treating it as current or appending a proof row', async () => {
    let transactionOpened = false;
    const { instance, challenges } = runtime(new RecordingTransaction(), {
      transactions: {
        async withLockedOwnerTransaction() {
          transactionOpened = true;
          throw new Error('historical challenge must not open a proof transaction');
        },
      },
      createChallenge: () => Buffer.alloc(32, 9),
    });

    const result = await instance.challengeRecoveryPredecessor(operation());

    assert.equal(result.status, 'proven');
    assert.equal(challenges.length, 1);
    assert.equal(transactionOpened, false);
    assert.equal(result.proof.challenge, Buffer.alloc(32, 9).toString('base64url'));
    assert.equal(result.proof.operationVersion, '7');
  });

  it('generates a fresh 32-byte challenge and appends exact current facts atomically', async () => {
    const transaction = new RecordingTransaction();
    const { instance, challenges } = runtime(transaction);
    const receipt = await instance.proveCurrent(operation());

    assert.equal(challenges.length, 1);
    assert.equal(Buffer.from(challenges[0]!, 'base64url').length, 32);
    assert.equal(receipt.operationVersion, '7');
    assert.equal(transaction.proofs.length, 1);
    const proof = transaction.proofs[0]!;
    assert.equal(proof.format, 'rollout-proof/v1');
    assert.equal(proof.operationVersion, '7');
    assert.equal(proof.configurationSha256, digest('d'));
    assert.equal(proof.platformBindingSha256, operation().requestedBindingSha256);
    assert.equal(proof.requestedImageDigest, `sha256:${digest('c')}`);
    assert.equal(proof.proofKeySha256, digest('2'));
    assert.equal(proof.challengedResponseSha256, canonicalBootstrapSha256(proof.challengedResponse));
  });

  it('stabilizes the proof attempt ID before opening the owner transaction', async () => {
    const transaction = new RecordingTransaction();
    let transactionOpened = false;
    const proofAttemptId = proofAttemptIds[0]!;
    const { instance } = runtime(transaction, {
      transactions: {
        async withLockedOwnerTransaction(work: (value: Task1RolloutProofTransaction) => Promise<unknown>) {
          transactionOpened = true;
          return work(transaction);
        },
      },
      createProofAttemptId: () => {
        assert.equal(transactionOpened, false);
        return proofAttemptId;
      },
    });

    const receipt = await instance.proveCurrent(operation());

    assert.equal(receipt.proofAttemptId, proofAttemptId);
  });

  it('fails closed without appending when any challenged fact differs from the locked operation', async () => {
    const transaction = new RecordingTransaction();
    const { instance } = runtime(transaction, {
      challengeApi: async ({ challenge }: { challenge: string }) => ({
        challenge, operationVersion: '6', phase: 'enforce',
        installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        databasePeerBindingSha256: digest('1'), imageDigest: `sha256:${digest('c')}`,
        configurationSha256: digest('d'),
      }),
    });
    await assert.rejects(() => instance.proveCurrent(operation()), /TENANT_CUTOVER_PROOF_RESPONSE_MISMATCH/);
    assert.equal(transaction.proofs.length, 0);
  });

  it('rejects a stale expected operation before observing workload or issuing a challenge', async () => {
    const transaction = new RecordingTransaction();
    let observed = false;
    let challenged = false;
    const { instance } = runtime(transaction, {
      observePlatform: async () => { observed = true; return platformFacts(); },
      challengeApi: async () => { challenged = true; return {}; },
    });
    await assert.rejects(
      () => instance.proveCurrent({ ...operation(), operationVersion: '6' }),
      /TENANT_CUTOVER_PROOF_CURRENT_CHANGED/,
    );
    assert.equal(observed, false);
    assert.equal(challenged, false);
  });

  it('converges after a lost success response with a new attempt and immutable sequence', async () => {
    const transaction = new RecordingTransaction();
    let attempt = 0;
    const createProofAttemptId = () => proofAttemptIds[attempt++]!;
    let challenge = 0;
    const createChallenge = () => Buffer.alloc(32, ++challenge);
    const first = runtime(transaction, { createProofAttemptId, createChallenge });
    const firstReceipt = await first.instance.proveCurrent(operation());
    const second = runtime(transaction, { createProofAttemptId, createChallenge });
    const secondReceipt = await second.instance.proveCurrent(operation());

    assert.equal(firstReceipt.proofSequence, '1');
    assert.equal(secondReceipt.proofSequence, '2');
    assert.notEqual(firstReceipt.proofAttemptId, secondReceipt.proofAttemptId);
    assert.notEqual(first.challenges[0], second.challenges[0]);
    assert.equal(transaction.proofs.length, 2);
    assert.equal(transaction.current.operationVersion, '7');
  });

  it('accepts only a canonical retained proof fully bound to the current operation', async () => {
    const transaction = new RecordingTransaction();
    const { instance } = runtime(transaction);
    await instance.proveCurrent(operation());
    const proof = transaction.proofs[0]!;
    const proofJcs = canonicalBootstrapJson(proof);
    const proofSha256 = canonicalBootstrapSha256(proof);

    assert.equal(
      isTask1RolloutProofForOperation(operation(), proofJcs, proofSha256),
      true,
    );
    assert.equal(
      isTask1RolloutProofForOperation(
        operation(),
        canonicalBootstrapJson({ ...proof, proofKeySha256: digest('9') }),
        canonicalBootstrapSha256({ ...proof, proofKeySha256: digest('9') }),
      ),
      false,
    );
    assert.equal(
      isTask1RolloutProofForOperation(operation(), `${proofJcs} `, proofSha256),
      false,
    );
  });
});
