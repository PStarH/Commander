import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import {
  parseTask1OwnerCommandInput,
  runTask1OwnerCommand,
  type Task1OwnerCommandDependencies,
} from './task1LifecycleOwnerCommand.js';
import type {
  Task1LifecycleOperation,
  Task1LifecycleRequest,
  Task1LifecycleResult,
} from './task1LifecycleLedger.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const nonce = 'n'.repeat(43);

const prepared = {
  platformBinding: {
    kind: 'compose',
    projectName: 'commander',
    composeVariant: 'prod',
    composeCredentialInventory: 'runtime-v1',
    composeSourceSha256: digest('a'),
    composeCliVersion: '5.3.1',
    composeContentSha256: digest('b'),
    phase: 'expand',
    apiImageDigest: `registry.example/commander@sha256:${digest('c')}`,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
  },
  businessConfiguration: { allowedTenants: ['tenant-a'], secretFileMappings: {} },
  configuration: {
    allowedTenants: ['tenant-a'],
    secretFileMappings: {},
    operationAuditNonce: nonce,
  },
};

function appendInput(): string {
  const value = {
    schema: 'tenant-cutover-request/v1',
    command: 'expand',
    prepared: {
      ...prepared,
      configurationSha256: canonicalBootstrapSha256(prepared.configuration),
    },
  };
  return canonicalBootstrapJson(value);
}

function planInput(
  overrides: Record<string, unknown> = {},
  input: { command?: 'expand' | 'enforce'; phase?: 'expand' | 'enforce' } = {},
): string {
  return canonicalBootstrapJson({
    schema: 'tenant-cutover-plan/v1',
    command: input.command ?? 'expand',
    platformIntent: {
      kind: 'compose',
      projectName: 'commander',
      composeVariant: 'prod',
      composeCredentialInventory: 'runtime-v1',
      composeSourceSha256: digest('a'),
      composeCliVersion: '5.3.1',
      phase: input.phase ?? 'expand',
      apiImageDigest: `registry.example/commander@sha256:${digest('c')}`,
      apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
    },
    businessConfiguration: prepared.businessConfiguration,
    ...overrides,
  });
}

function helmEnforcePlanInput(): string {
  return canonicalBootstrapJson({
    schema: 'tenant-cutover-plan/v1',
    command: 'enforce',
    platformIntent: {
      kind: 'helm',
      namespace: 'commander',
      releaseName: 'commander',
      chartContentSha256: digest('8'),
      phase: 'enforce',
      apiImageDigest: `sha256:${digest('c')}`,
    },
    businessConfiguration: { valuesSha256: digest('9') },
  });
}

function helmInstallPlanInput(): string {
  return canonicalBootstrapJson({
    schema: 'tenant-cutover-plan/v1',
    command: 'install',
    platformIntent: {
      kind: 'helm',
      namespace: 'commander',
      releaseName: 'release-a',
      chartContentSha256: digest('7'),
      phase: 'enforce',
      apiImageDigest: `sha256:${digest('8')}`,
    },
    businessConfiguration: { valuesSha256: digest('9') },
  });
}

function operation(overrides: Partial<Task1LifecycleOperation> = {}): Task1LifecycleOperation {
  return {
    installationUuid: 'installation',
    operationVersion: '2',
    predecessorStateVersion: '1',
    resultingStateVersion: '2',
    predecessorState: 'expanded',
    resultingState: 'enforced',
    operationKind: 'enforce',
    runtimePhase: 'enforce',
    platformKind: 'compose',
    previousBindingJcs: null,
    previousBindingSha256: null,
    requestedBindingJcs: canonicalBootstrapJson(prepared.platformBinding),
    requestedBindingSha256: canonicalBootstrapSha256(prepared.platformBinding),
    previousConfigurationJcs: null,
    previousConfigurationSha256: null,
    requestedConfigurationJcs: canonicalBootstrapJson(prepared.configuration),
    requestedConfigurationSha256: canonicalBootstrapSha256(prepared.configuration),
    previousBusinessConfigurationSha256: null,
    requestedBusinessConfigurationSha256: canonicalBootstrapSha256(prepared.businessConfiguration),
    originBindingSha256: digest('d'),
    databasePeerBindingSha256: digest('e'),
    proofKeySha256: digest('f'),
    descriptorSet: [],
    predecessorEvidenceJcs: '{"kind":"fresh-no-predecessor/v1"}',
    predecessorEvidenceSha256: digest('g'),
    predecessorProof: 'fresh-no-predecessor',
    result: 'committed',
    ...overrides,
  };
}

function dependencies(
  result: Task1LifecycleResult = { action: 'append', operation: operation() },
): Task1OwnerCommandDependencies {
  return {
    execute: async (request: Task1LifecycleRequest) => {
      assert.deepEqual(request.descriptorSet, ['lifecycle', 'expand']);
      assert.equal(request.command, 'expand');
      assert.deepEqual(request.businessConfiguration, prepared.businessConfiguration);
      assert.equal(request.operationAuditNonce, nonce);
      return result;
    },
    current: async () => ({ operation: operation(), proven: true }),
    proveCurrent: async (expected) => ({
      operationVersion: expected.operationVersion,
      proofSequence: '1',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      rolloutProofSha256: digest('9'),
    }),
  };
}

describe('Task 1 lifecycle owner commands', () => {
  it('plans an exact proven Helm current request without rendering', async () => {
    const binding = {
      kind: 'helm' as const,
      namespace: 'commander',
      releaseName: 'commander',
      chartContentSha256: digest('8'),
      phase: 'enforce' as const,
      apiImageDigest: `sha256:${digest('c')}`,
    };
    const configuration = { valuesSha256: digest('9'), operationAuditNonce: nonce };
    const current = operation({
      platformKind: 'helm',
      requestedBindingJcs: canonicalBootstrapJson(binding),
      requestedBindingSha256: canonicalBootstrapSha256(binding),
      requestedConfigurationJcs: canonicalBootstrapJson(configuration),
      requestedConfigurationSha256: canonicalBootstrapSha256(configuration),
    });
    const output = await runTask1OwnerCommand('tenant-cutover-plan', helmEnforcePlanInput(), {
      ...dependencies(),
      current: async () => ({ operation: current, proven: true }),
      execute: async () => assert.fail('plan must not execute the ledger'),
    });
    assert.equal(output.action, 'return_current');
    assert.equal((output.operation as Record<string, unknown>).apiImage, binding.apiImageDigest);
  });

  it('accepts the exact Helm plan intent used by the lifecycle controller', async () => {
    const output = await runTask1OwnerCommand('tenant-cutover-plan', helmInstallPlanInput(), {
      ...dependencies(),
      current: async () => ({ operation: undefined, proven: false }),
      execute: async () => assert.fail('plan must not execute the ledger'),
    });
    assert.deepEqual(output, { action: 'append' });
  });

  it('returns only the proven owner-selected Helm operation for restore', async () => {
    const helmBinding = {
      kind: 'helm' as const,
      namespace: 'commander',
      releaseName: 'release-a',
      chartContentSha256: digest('7'),
      phase: 'enforce' as const,
      apiImageDigest: `sha256:${digest('8')}`,
    };
    const helmConfiguration = {
      valuesSha256: digest('9'),
      platformBinding: helmBinding,
      operationAuditNonce: nonce,
    };
    const current = operation({
      platformKind: 'helm',
      requestedBindingJcs: canonicalBootstrapJson(helmBinding),
      requestedBindingSha256: canonicalBootstrapSha256(helmBinding),
      requestedConfigurationJcs: canonicalBootstrapJson(helmConfiguration),
      requestedConfigurationSha256: canonicalBootstrapSha256(helmConfiguration),
    });
    const releaseProjection = {
      format: 'helm-release-projection/v1',
      namespace: 'commander',
      releaseName: 'release-a',
      revision: '11',
      chartContentSha256: digest('7'),
      objects: [],
      hooks: [],
      rendererInput: {
        format: 'helm-renderer-input-projection/v1',
        secretReferences: [],
      },
    };
    const restoreEvidence = {
      revision: '11',
      releaseProjection,
      releaseProjectionSha256: canonicalBootstrapSha256(releaseProjection),
    };
    const output = await runTask1OwnerCommand(
      'tenant-cutover-restore',
      canonicalBootstrapJson({
        schema: 'tenant-cutover-restore/v1',
        namespace: 'commander',
        release: 'release-a',
      }),
      {
        ...dependencies(),
        current: async () => ({ operation: current, proven: true, restoreEvidence }),
        execute: async () => assert.fail('restore must not execute the ledger'),
      },
    );
    assert.equal(output.operation && typeof output.operation, 'object');
    assert.equal((output.operation as Record<string, unknown>).proven, true);
    assert.deepEqual((output.operation as Record<string, unknown>).restore, restoreEvidence);

    await assert.rejects(
      () =>
        runTask1OwnerCommand(
          'tenant-cutover-restore',
          canonicalBootstrapJson({
            schema: 'tenant-cutover-restore/v1',
            namespace: 'commander',
            release: 'release-a',
          }),
          {
            ...dependencies(),
            current: async () => ({ operation: current, proven: false }),
          },
        ),
      /TENANT_CUTOVER_RESTORE_PROOF_REQUIRED/,
    );

    await assert.rejects(
      () =>
        runTask1OwnerCommand(
          'tenant-cutover-restore',
          canonicalBootstrapJson({
            schema: 'tenant-cutover-restore/v1',
            namespace: 'commander',
            release: 'release-a',
          }),
          {
            ...dependencies(),
            current: async () => ({ operation: current, proven: true }),
          },
        ),
      /TENANT_CUTOVER_RESTORE_EVIDENCE_REQUIRED/,
    );
  });

  it('plans an exact proven current request without nonce-bearing caller evidence', async () => {
    const current = operation({
      operationKind: 'legacy_expand',
      runtimePhase: 'expand',
      resultingState: 'expanded',
    });
    const output = await runTask1OwnerCommand('tenant-cutover-plan', planInput(), {
      ...dependencies(),
      current: async () => ({ operation: current, proven: true }),
      execute: async () => assert.fail('plan must not execute the ledger'),
    });

    assert.equal(output.action, 'return_current');
    assert.deepEqual(output.operation, {
      operationVersion: current.operationVersion,
      operationKind: current.operationKind,
      phase: current.runtimePhase,
      apiImage: prepared.platformBinding.apiImageDigest,
      platformBinding: prepared.platformBinding,
      businessConfiguration: prepared.businessConfiguration,
      configuration: prepared.configuration,
      configurationSha256: canonicalBootstrapSha256(prepared.configuration),
      predecessor: null,
    });
  });

  it('projects the immediately preceding append-only operation for recovery', async () => {
    const predecessorBinding = { ...prepared.platformBinding, phase: 'expand' as const };
    const predecessor = operation({
      operationVersion: '1',
      predecessorStateVersion: '0',
      resultingStateVersion: '1',
      predecessorState: 'legacy_pending',
      resultingState: 'expanded',
      operationKind: 'legacy_expand',
      runtimePhase: 'expand',
      requestedBindingJcs: canonicalBootstrapJson(predecessorBinding),
      requestedBindingSha256: canonicalBootstrapSha256(predecessorBinding),
    });
    const currentBinding = { ...prepared.platformBinding, phase: 'enforce' as const };
    const current = operation({
      predecessorStateVersion: '1',
      previousBindingJcs: predecessor.requestedBindingJcs,
      previousBindingSha256: predecessor.requestedBindingSha256,
      previousConfigurationJcs: predecessor.requestedConfigurationJcs,
      previousConfigurationSha256: predecessor.requestedConfigurationSha256,
      requestedBindingJcs: canonicalBootstrapJson(currentBinding),
      requestedBindingSha256: canonicalBootstrapSha256(currentBinding),
    });
    const output = await runTask1OwnerCommand(
      'tenant-cutover-plan',
      planInput({}, { command: 'enforce', phase: 'enforce' }),
      {
        ...dependencies(),
        current: async () => ({ operation: current, predecessor, proven: true }),
        execute: async () => assert.fail('plan must not execute the ledger'),
      },
    );

    assert.equal(output.action, 'return_current');
    const projected = output.operation as Record<string, unknown>;
    assert.notEqual(projected.predecessor, null);
    assert.equal((projected.predecessor as Record<string, unknown>).operationVersion, '1');
    assert.equal((projected.predecessor as Record<string, unknown>).operationKind, 'legacy_expand');
  });

  it('rejects nonce, digest, operation, and proof facts in a plan request', async () => {
    for (const forbidden of [
      { operationAuditNonce: nonce },
      { configurationSha256: digest('0') },
      { operationVersion: '2' },
      { proven: true },
    ]) {
      await assert.rejects(
        () => runTask1OwnerCommand('tenant-cutover-plan', planInput(forbidden), dependencies()),
        /TENANT_CUTOVER_OWNER_REQUEST_INVALID/,
      );
    }
  });

  it('accepts only a canonical nonce-bearing append request and derives descriptors', async () => {
    const output = await runTask1OwnerCommand(
      'tenant-cutover-append',
      appendInput(),
      dependencies(),
    );
    assert.equal(output.action, 'append');
    assert.equal(output.operation.operationVersion, '2');
  });

  it('rejects a caller-selected configuration digest before it reaches the ledger', async () => {
    const parsed = JSON.parse(appendInput()) as { prepared: { configurationSha256: string } };
    parsed.prepared.configurationSha256 = digest('0');
    await assert.rejects(
      () =>
        runTask1OwnerCommand(
          'tenant-cutover-append',
          canonicalBootstrapJson(parsed),
          dependencies(),
        ),
      /TENANT_CUTOVER_OWNER_REQUEST_INVALID/,
    );
  });

  it('rejects non-JCS input instead of normalizing it', () => {
    assert.throws(
      () =>
        parseTask1OwnerCommandInput(
          '{"command":"expand","prepared":{},"schema":"tenant-cutover-request/v1"}',
        ),
      /TENANT_CUTOVER_OWNER_REQUEST_INVALID/,
    );
  });

  it('proves only through the fresh atomic worker and accepts no caller proof facts', async () => {
    let expected: Task1LifecycleOperation | undefined;
    const output = await runTask1OwnerCommand('tenant-cutover-prove', '', {
      ...dependencies(),
      proveCurrent: async (operationValue) => {
        expected = operationValue;
        return {
          operationVersion: operationValue.operationVersion,
          proofSequence: '3',
          proofAttemptId: '11111111-1111-4111-8111-111111111111',
          rolloutProofSha256: digest('9'),
        };
      },
    });
    assert.equal(expected?.operationVersion, '2');
    assert.deepEqual(output, {
      proven: true,
      operationVersion: '2',
      proofSequence: '3',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      rolloutProofSha256: digest('9'),
    });
  });

  it('rejects the circular pre-existing-row-only proof path', async () => {
    const { proveCurrent: _proofWorker, ...rowOnly } = dependencies();
    await assert.rejects(
      () => runTask1OwnerCommand('tenant-cutover-prove', '', rowOnly),
      /TENANT_CUTOVER_PROOF_RUNTIME_REQUIRED/,
    );
    await assert.rejects(
      () =>
        runTask1OwnerCommand(
          'tenant-cutover-prove',
          canonicalBootstrapJson({ operationVersion: '2', proven: true }),
          dependencies(),
        ),
      /TENANT_CUTOVER_PROOF_INPUT_FORBIDDEN/,
    );
  });

  it('derives recovery from the current row and ignores the caller failed operation', async () => {
    let received: Task1LifecycleRequest | undefined;
    const predecessor = operation({
      operationVersion: '1',
      predecessorStateVersion: '0',
      resultingStateVersion: '1',
      operationKind: 'legacy_expand',
      runtimePhase: 'expand',
      resultingState: 'expanded',
    });
    const failed = operation({
      previousBindingJcs: predecessor.requestedBindingJcs,
      previousBindingSha256: predecessor.requestedBindingSha256,
      previousConfigurationJcs: predecessor.requestedConfigurationJcs,
      previousConfigurationSha256: predecessor.requestedConfigurationSha256,
    });
    let challenged: Task1LifecycleOperation | undefined;
    const output = await runTask1OwnerCommand(
      'tenant-cutover-recover',
      canonicalBootstrapJson({ failed: {} }),
      {
        execute: async (request) => {
          received = request;
          assert.ok(request.verifyRecoveryPredecessor);
          const proof = await request.verifyRecoveryPredecessor({
            platformBinding: JSON.parse(predecessor.requestedBindingJcs),
            configuration: JSON.parse(predecessor.requestedConfigurationJcs),
          });
          assert.equal(proof.status, 'proven');
          return { action: 'append', operation: operation() };
        },
        current: async () => ({ operation: failed, predecessor, proven: false }),
        verifyRecoveryPredecessor: async (candidate) => {
          challenged = candidate;
          return { status: 'proven', proof: { challenge: 'owner-selected' } };
        },
      },
    );
    assert.equal(received?.command, 'recover_runtime_after_enforce_failure');
    assert.equal(received?.operationAuditNonce, undefined);
    assert.equal(challenged, predecessor);
    assert.equal(output.action, 'append');
  });

  it('fails recovery closed before execution when the authoritative predecessor is unavailable', async () => {
    let executed = false;
    await assert.rejects(
      () =>
        runTask1OwnerCommand('tenant-cutover-recover', canonicalBootstrapJson({ failed: {} }), {
          execute: async () => {
            executed = true;
            return { action: 'append', operation: operation() };
          },
          current: async () => ({ operation: operation(), proven: false }),
          verifyRecoveryPredecessor: async () => ({
            status: 'proven',
            proof: { challenge: 'must-not-run' },
          }),
        }),
      /TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED/,
    );
    assert.equal(executed, false);
  });

  it('retries an exact unproven recovery row without appending or re-challenging its predecessor', async () => {
    const recovery = operation({
      operationKind: 'recover_runtime_after_enforce_failure',
      runtimePhase: 'expand',
      requestedBindingJcs: canonicalBootstrapJson(prepared.platformBinding),
      requestedBindingSha256: canonicalBootstrapSha256(prepared.platformBinding),
    });
    const output = await runTask1OwnerCommand(
      'tenant-cutover-recover',
      canonicalBootstrapJson({ failed: {} }),
      {
        execute: async () => assert.fail('an exact recovery retry must not append'),
        current: async () => ({ operation: recovery, proven: false }),
        verifyRecoveryPredecessor: async () =>
          assert.fail('retry must not challenge historical proof'),
      },
    );
    assert.equal(output.action, 'retry_rollout');
    assert.equal(
      (output.operation as Record<string, unknown>).operationKind,
      'recover_runtime_after_enforce_failure',
    );
  });

  it('rejects recovery for any unproven current row other than enforce or recovery', async () => {
    let executed = false;
    await assert.rejects(
      () =>
        runTask1OwnerCommand('tenant-cutover-recover', canonicalBootstrapJson({ failed: {} }), {
          execute: async () => {
            executed = true;
            return { action: 'append', operation: operation() };
          },
          current: async () => ({
            operation: operation({ operationKind: 'rollback_to_recorded_expand' }),
            proven: false,
          }),
        }),
      /TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED/,
    );
    assert.equal(executed, false);
  });
});
