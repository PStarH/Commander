import { randomBytes } from 'node:crypto';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  verifyDatabasePeerBinding,
  verifyPersistedOriginBinding,
  type BootstrapIdentityV1,
  type DatabasePeerBindingInputV1,
  type DatabasePeerBindingRoleV1,
  type Task1DatabaseRole,
} from './canonicalBootstrap.js';
import type { SqlClient, SqlPool } from './postgres.js';
import type {
  TenantCutoverCommand,
  TenantCutoverOperationKind,
  TenantCutoverPlatformKind,
  TenantCutoverRuntimePhase,
} from './tenantCutoverStateMachine.js';

type DatabaseState =
  'fresh' | 'fresh_pending' | 'legacy' | 'legacy_pending' | 'expanded' | 'enforced';

export type Task1PlatformBinding =
  | {
      kind: 'compose';
      projectName: string;
      composeVariant: 'prod';
      composeCredentialInventory: 'runtime-v1' | 'fresh-bootstrap-v1';
      composeSourceSha256: string;
      composeCliVersion: '5.3.1';
      composeContentSha256: string;
      phase: TenantCutoverRuntimePhase;
      apiImageDigest: string;
      apiProofUrl: string;
    }
  | {
      kind: 'helm';
      namespace: string;
      releaseName: string;
      chartContentSha256: string;
      phase: TenantCutoverRuntimePhase;
      apiImageDigest: string;
    };

export interface Task1LifecycleOperation {
  installationUuid: string;
  operationVersion: string;
  predecessorStateVersion: string;
  resultingStateVersion: string;
  predecessorState: DatabaseState;
  resultingState: DatabaseState;
  operationKind: TenantCutoverOperationKind;
  runtimePhase: TenantCutoverRuntimePhase;
  platformKind: TenantCutoverPlatformKind;
  previousBindingJcs: string | null;
  previousBindingSha256: string | null;
  requestedBindingJcs: string;
  requestedBindingSha256: string;
  previousConfigurationJcs: string | null;
  previousConfigurationSha256: string | null;
  requestedConfigurationJcs: string;
  requestedConfigurationSha256: string;
  previousBusinessConfigurationSha256: string | null;
  requestedBusinessConfigurationSha256: string;
  originBindingSha256: string;
  databasePeerBindingSha256: string;
  proofKeySha256: string;
  descriptorSet: readonly string[];
  predecessorEvidenceJcs: string;
  predecessorEvidenceSha256: string;
  /** Compatibility projection of predecessorEvidenceJcs for existing callers. */
  predecessorProof: string;
  result: 'committed';
}

export interface Task1LifecycleLockedState {
  installationUuid: string;
  databaseState: DatabaseState;
  stateVersion: string;
  platformKind?: TenantCutoverPlatformKind;
  platformBindingSha256: string | null;
  prebootstrapSnapshotsJcs?: string;
  prebootstrapSnapshotsSha256?: string;
  originBindingJcs?: string;
  originBindingSha256: string;
  databasePeerBindingJcs?: string;
  databasePeerBindingSha256: string;
  proofKeySha256: string;
  pendingConfigurationSha256: string | null;
  currentConfigurationSha256: string | null;
  currentRuntimeOperationVersion: string | null;
  recordedExpandOperation?: Task1LifecycleOperation;
  currentOperation?: Task1LifecycleOperation;
}

export interface Task1LifecycleOwnerTransaction {
  lockState(): Promise<Task1LifecycleLockedState>;
  applyTransition?(input: {
    state: Task1LifecycleLockedState;
    operation: Task1LifecycleOperation;
  }): Promise<void>;
  appendOperation(operation: Task1LifecycleOperation): Promise<void>;
  compareAndSwapState(
    expected: Task1LifecycleLockedState,
    next: Task1LifecycleLockedState,
  ): Promise<boolean>;
}

export interface Task1LifecycleOwnerTransactions {
  withLockedOwnerTransaction<T>(
    work: (transaction: Task1LifecycleOwnerTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface Task1LifecycleRequest {
  command: TenantCutoverCommand;
  platformBinding: Task1PlatformBinding;
  businessConfiguration: Record<string, unknown>;
  /** Owner-prepared nonce for a durable request artifact; recovery never accepts one from a caller. */
  operationAuditNonce?: string;
  descriptorSet: readonly string[];
  legacyPredecessorArtifact?:
    | {
        kind: 'helm';
        namespace: string;
        releaseName: string;
        chartContentSha256: string;
        imageDigest: string;
      }
    | {
        kind: 'compose';
        projectName: string;
        composeSourceSha256: string;
        composeCliVersion: string;
        resolvedModelSha256: string;
        imageDigest: string;
      };
  verifyCurrent?: (
    operation: Task1LifecycleOperation,
  ) => Promise<{ status: 'proven'; proof: unknown } | { status: 'absent' }>;
  verifyRecoveryPredecessor?: (candidate: {
    platformBinding: Task1PlatformBinding;
    configuration: Record<string, unknown>;
  }) => Promise<{ status: 'proven'; proof: unknown } | { status: 'absent' }>;
  applyTransition?: (input: {
    state: Task1LifecycleLockedState;
    operation: Task1LifecycleOperation;
  }) => Promise<void>;
}

export type Task1LifecycleResult =
  | { action: 'return_current' | 'retry_rollout'; operation: Task1LifecycleOperation }
  | { action: 'append'; operation: Task1LifecycleOperation };

/**
 * Exact fresh-pending retry inputs. The request deliberately cannot carry origin or observed-peer
 * values: both are derived and persisted under the original owner locks.
 */
export interface Task1FreshPendingRetry {
  state: {
    databaseState: 'fresh_pending';
    pendingConfigurationSha256: string;
    prebootstrapSnapshotsJcs: string;
    prebootstrapSnapshotsSha256: string;
    originBindingJcs: string;
    originBindingSha256: string;
    databasePeerBindingInput: DatabasePeerBindingInputV1;
    databasePeerBindingJcs: string;
    databasePeerBindingSha256: string;
  };
  request: { configurationSha256: string };
  reauthenticateBootstrapAuthority: (identity: BootstrapIdentityV1) => Promise<void>;
  observeOwner: () => Promise<DatabasePeerBindingRoleV1>;
  observeRole: (role: Task1DatabaseRole) => Promise<DatabasePeerBindingRoleV1>;
}

function parseCanonicalObject(value: string, errorCode: string): Record<string, unknown> {
  const parsed = parseObjectJcs(value, errorCode);
  if (canonicalBootstrapJson(parsed) !== value) throw new Error(errorCode);
  return parsed;
}

/**
 * Validates persisted fresh-origin evidence, then reauthenticates and observes the owner plus every
 * final role. It intentionally has no inventory collector callback, preventing S0/S1 recollection.
 */
export async function verifyTask1FreshPendingRetry(input: Task1FreshPendingRetry): Promise<void> {
  const state = input.state;
  if (state.pendingConfigurationSha256 !== input.request.configurationSha256) {
    throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
  }
  const snapshots = parseCanonicalObject(
    state.prebootstrapSnapshotsJcs,
    'TENANT_CUTOVER_ORIGIN_TAMPERED',
  );
  const origin = parseCanonicalObject(state.originBindingJcs, 'TENANT_CUTOVER_ORIGIN_TAMPERED');
  if (
    canonicalBootstrapSha256(snapshots) !== state.prebootstrapSnapshotsSha256 ||
    canonicalBootstrapSha256(origin) !== state.originBindingSha256
  ) {
    throw new Error('TENANT_CUTOVER_ORIGIN_TAMPERED');
  }
  const persisted = verifyPersistedOriginBinding(snapshots, origin);
  if (persisted.origin.bootstrapIdentities === null) {
    throw new Error('TENANT_CUTOVER_ORIGIN_TAMPERED');
  }
  await input.reauthenticateBootstrapAuthority(persisted.origin.bootstrapIdentities.authority);

  const owner = await input.observeOwner();
  const observed = createDatabasePeerBinding({
    roles: await Promise.all(
      (['adapter-ops', 'app', 'owner', 'scheduler', 'tenant-authority', 'worker'] as const).map(
        (role) => input.observeRole(role),
      ),
    ),
  });
  const persistedPeer = createDatabasePeerBinding(
    parseCanonicalObject(
      state.databasePeerBindingJcs,
      'TENANT_CUTOVER_DATABASE_PEER_TAMPERED',
    ) as unknown as {
      format: 'database_peer_binding_v1';
      roles: DatabasePeerBindingRoleV1[];
    },
  );
  const ownerEntry = observed.roles.find(({ role }) => role === 'owner');
  if (
    !ownerEntry ||
    canonicalBootstrapJson(
      createDatabasePeerBinding({
        roles: [owner, ...observed.roles.filter(({ role }) => role !== 'owner')],
      }),
    ) !== canonicalBootstrapJson(observed)
  ) {
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
  }
  verifyDatabasePeerBinding(input.state.databasePeerBindingInput, observed);
  if (
    canonicalBootstrapJson(observed) !== canonicalBootstrapJson(persistedPeer) ||
    canonicalBootstrapSha256(observed) !== state.databasePeerBindingSha256
  ) {
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_TAMPERED');
  }
}

export function createTask1OperationAuditNonce(): string {
  return randomBytes(32).toString('base64url');
}

const RETRYABLE_UNPROVEN = new Set<TenantCutoverOperationKind>([
  'legacy_expand',
  'fresh_enforce',
  'recover_runtime_after_enforce_failure',
  'rollback_to_recorded_expand',
]);

const LIVE_NOOP: Readonly<Record<TenantCutoverCommand, ReadonlySet<TenantCutoverOperationKind>>> = {
  expand: new Set(['legacy_expand']),
  install_enforce: new Set(['fresh_enforce']),
  enforce: new Set(['fresh_enforce', 'enforce']),
  recover_runtime_after_enforce_failure: new Set(['recover_runtime_after_enforce_failure']),
  rollback_to_recorded_expand: new Set(['rollback_to_recorded_expand']),
};

function operationKind(command: TenantCutoverCommand): TenantCutoverOperationKind {
  switch (command) {
    case 'expand':
      return 'legacy_expand';
    case 'install_enforce':
      return 'fresh_enforce';
    case 'enforce':
      return 'enforce';
    case 'recover_runtime_after_enforce_failure':
      return command;
    case 'rollback_to_recorded_expand':
      return command;
  }
}

function runtimePhase(command: TenantCutoverCommand): TenantCutoverRuntimePhase {
  return command === 'expand' || command === 'rollback_to_recorded_expand' ? 'expand' : 'enforce';
}

function businessFromOperation(operation: Task1LifecycleOperation): Record<string, unknown> {
  const parsed = JSON.parse(operation.requestedConfigurationJcs) as Record<string, unknown>;
  const { operationAuditNonce: _nonce, ...business } = parsed;
  return business;
}

function parseObjectJcs(value: string, errorCode: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(errorCode);
  }
  return parsed as Record<string, unknown>;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function recoveryBinding(value: string | null): Task1PlatformBinding {
  if (value === null) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
  }
  const binding = parseObjectJcs(value, 'TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE');
  if (
    binding.kind === 'compose' &&
    nonemptyString(binding.projectName) &&
    binding.composeVariant === 'prod' &&
    (binding.composeCredentialInventory === 'runtime-v1' ||
      binding.composeCredentialInventory === 'fresh-bootstrap-v1') &&
    nonemptyString(binding.composeSourceSha256) &&
    binding.composeCliVersion === '5.3.1' &&
    nonemptyString(binding.composeContentSha256) &&
    (binding.phase === 'expand' || binding.phase === 'enforce') &&
    nonemptyString(binding.apiImageDigest) &&
    nonemptyString(binding.apiProofUrl)
  ) {
    return binding as unknown as Extract<Task1PlatformBinding, { kind: 'compose' }>;
  }
  if (
    binding.kind === 'helm' &&
    nonemptyString(binding.namespace) &&
    nonemptyString(binding.releaseName) &&
    nonemptyString(binding.chartContentSha256) &&
    (binding.phase === 'expand' || binding.phase === 'enforce') &&
    nonemptyString(binding.apiImageDigest)
  ) {
    return binding as unknown as Extract<Task1PlatformBinding, { kind: 'helm' }>;
  }
  throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE');
}

function deriveRecoveryEvidence(
  state: Task1LifecycleLockedState,
  failed: Task1LifecycleOperation,
): {
  platformBinding: Task1PlatformBinding;
  predecessorConfiguration: Record<string, unknown>;
  businessConfiguration: Record<string, unknown>;
} {
  if (failed.previousConfigurationJcs === null) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
  }
  const platformBinding = recoveryBinding(failed.previousBindingJcs);
  if (
    platformBinding.kind !== failed.platformKind ||
    (state.platformKind && platformBinding.kind !== state.platformKind)
  ) {
    throw new Error('TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED');
  }

  const predecessorConfiguration = parseObjectJcs(
    failed.previousConfigurationJcs,
    'TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE',
  );
  const mappings = predecessorConfiguration.secretFileMappings;
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE');
  }
  if (
    failed.previousBindingSha256 === null ||
    failed.previousConfigurationSha256 === null ||
    canonicalBootstrapSha256(platformBinding) !== failed.previousBindingSha256 ||
    canonicalBootstrapSha256(predecessorConfiguration) !== failed.previousConfigurationSha256
  ) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_MISMATCH');
  }
  const failedBusiness = businessFromOperation(failed);
  if (!Object.hasOwn(failedBusiness, 'secretFileMappings')) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE');
  }
  return {
    platformBinding,
    predecessorConfiguration,
    businessConfiguration: {
      ...failedBusiness,
      secretFileMappings: mappings,
    },
  };
}

function sameRequest(
  operation: Task1LifecycleOperation,
  binding: Task1PlatformBinding,
  business: Record<string, unknown>,
): boolean {
  const parsedBinding = JSON.parse(operation.requestedBindingJcs) as Record<string, unknown>;
  const bindingMatches =
    Object.keys(parsedBinding).length > 1
      ? canonicalBootstrapJson(parsedBinding) === canonicalBootstrapJson(binding)
      : operation.requestedBindingSha256 ===
        (binding.kind === 'compose' ? binding.composeContentSha256 : binding.chartContentSha256);
  return (
    bindingMatches &&
    canonicalBootstrapJson(businessFromOperation(operation)) === canonicalBootstrapJson(business)
  );
}

function nextDatabaseState(command: TenantCutoverCommand, state: DatabaseState): DatabaseState {
  if (command === 'expand' && (state === 'legacy' || state === 'legacy_pending')) return 'expanded';
  if (command === 'install_enforce' && (state === 'fresh' || state === 'fresh_pending'))
    return 'enforced';
  if (command === 'enforce' && (state === 'expanded' || state === 'enforced')) return 'enforced';
  if (command === 'recover_runtime_after_enforce_failure' && state === 'enforced')
    return 'enforced';
  if (command === 'rollback_to_recorded_expand' && state === 'enforced') return 'enforced';
  throw new Error('TENANT_CUTOVER_STATE_INVALID');
}

function addOne(value: string): string {
  return (BigInt(value) + 1n).toString();
}

export class Task1LifecycleLedger {
  constructor(
    private readonly transactions: Task1LifecycleOwnerTransactions,
    private readonly options: { createNonce?: () => string } = {},
  ) {}

  async execute(request: Task1LifecycleRequest): Promise<Task1LifecycleResult> {
    return this.transactions.withLockedOwnerTransaction(async (transaction) => {
      const state = await transaction.lockState();
      if (state.platformKind && state.platformKind !== request.platformBinding.kind) {
        throw new Error('TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED');
      }

      const current = state.currentRuntimeOperationVersion ? state.currentOperation : undefined;
      const proof = current
        ? ((await request.verifyCurrent?.(current)) ?? { status: 'absent' as const })
        : undefined;
      const currentIsLive = proof?.status === 'proven';
      const requestedKind = operationKind(request.command);

      if (current && !currentIsLive) {
        if (current.operationKind === 'enforce') {
          if (request.command !== 'recover_runtime_after_enforce_failure') {
            throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED');
          }
        } else if (
          RETRYABLE_UNPROVEN.has(current.operationKind) &&
          current.operationKind === requestedKind &&
          sameRequest(current, request.platformBinding, request.businessConfiguration)
        ) {
          return { action: 'retry_rollout', operation: current };
        } else {
          throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
        }
      }

      if (
        current &&
        currentIsLive &&
        LIVE_NOOP[request.command].has(current.operationKind) &&
        sameRequest(current, request.platformBinding, request.businessConfiguration)
      ) {
        return { action: 'return_current', operation: current };
      }
      if (request.command === 'recover_runtime_after_enforce_failure' && currentIsLive) {
        throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_NOT_REQUIRED');
      }

      let platformBinding = request.platformBinding;
      let businessConfiguration = request.businessConfiguration;
      let predecessorProof: unknown = proof;
      let descriptorSet = request.descriptorSet;
      if (request.command === 'recover_runtime_after_enforce_failure') {
        if (!current || current.operationKind !== 'enforce') {
          throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED');
        }
        const recovery = deriveRecoveryEvidence(state, current);
        platformBinding = recovery.platformBinding;
        businessConfiguration = recovery.businessConfiguration;
        descriptorSet = [];
        const recoveryProof = await request.verifyRecoveryPredecessor?.({
          platformBinding,
          configuration: recovery.predecessorConfiguration,
        });
        if (!recoveryProof) {
          throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
        }
        if (recoveryProof.status !== 'proven') {
          throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_NOT_PROVEN');
        }
        predecessorProof = recoveryProof;
      }
      if (request.command === 'rollback_to_recorded_expand') {
        const recorded = state.recordedExpandOperation;
        if (
          !recorded ||
          !sameRequest(recorded, request.platformBinding, request.businessConfiguration)
        ) {
          throw new Error('TENANT_CUTOVER_RECORDED_EXPAND_MISMATCH');
        }
        businessConfiguration = businessFromOperation(recorded);
      }

      const resultingState = nextDatabaseState(request.command, state.databaseState);
      const nonce =
        request.operationAuditNonce ??
        (this.options.createNonce ?? createTask1OperationAuditNonce)();
      if (request.operationAuditNonce !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
        throw new Error('TENANT_CUTOVER_OPERATION_NONCE_INVALID');
      }
      const requestedConfiguration = { ...businessConfiguration, operationAuditNonce: nonce };
      const requestedBindingJcs = canonicalBootstrapJson(platformBinding);
      const requestedConfigurationJcs = canonicalBootstrapJson(requestedConfiguration);
      const nextVersion = addOne(state.stateVersion);
      let predecessorEvidence: unknown;
      if (current) {
        predecessorEvidence = {
          kind: 'challenged-predecessor/v1',
          response: predecessorProof,
          responseSha256: canonicalBootstrapSha256(predecessorProof),
        };
      } else if (request.command === 'expand') {
        if (!request.legacyPredecessorArtifact || !state.prebootstrapSnapshotsSha256) {
          throw new Error('TENANT_CUTOVER_LEGACY_PREDECESSOR_REQUIRED');
        }
        predecessorEvidence = {
          kind: 'legacy-predecessor-not-proof-capable/v1',
          artifact: request.legacyPredecessorArtifact,
          prebootstrapSnapshotsSha256: state.prebootstrapSnapshotsSha256,
        };
      } else {
        predecessorEvidence = { kind: 'fresh-no-predecessor/v1' };
      }
      const predecessorEvidenceJcs = canonicalBootstrapJson(predecessorEvidence);
      const next: Task1LifecycleOperation = {
        installationUuid: state.installationUuid,
        operationVersion: nextVersion,
        predecessorStateVersion: state.stateVersion,
        resultingStateVersion: nextVersion,
        predecessorState: state.databaseState,
        resultingState,
        operationKind: requestedKind,
        runtimePhase:
          request.command === 'recover_runtime_after_enforce_failure'
            ? platformBinding.phase
            : runtimePhase(request.command),
        platformKind: platformBinding.kind,
        previousBindingJcs: current?.requestedBindingJcs ?? null,
        previousBindingSha256: state.platformBindingSha256,
        requestedBindingJcs,
        requestedBindingSha256: canonicalBootstrapSha256(platformBinding),
        previousConfigurationJcs: current?.requestedConfigurationJcs ?? null,
        previousConfigurationSha256: state.currentConfigurationSha256,
        requestedConfigurationJcs,
        requestedConfigurationSha256: canonicalBootstrapSha256(requestedConfiguration),
        previousBusinessConfigurationSha256: current?.requestedBusinessConfigurationSha256 ?? null,
        requestedBusinessConfigurationSha256:
          request.command === 'rollback_to_recorded_expand'
            ? state.recordedExpandOperation!.requestedBusinessConfigurationSha256
            : canonicalBootstrapSha256(businessConfiguration),
        originBindingSha256: state.originBindingSha256,
        databasePeerBindingSha256: state.databasePeerBindingSha256,
        proofKeySha256: state.proofKeySha256,
        descriptorSet: [...descriptorSet],
        predecessorEvidenceJcs,
        predecessorEvidenceSha256: canonicalBootstrapSha256(predecessorEvidence),
        predecessorProof: current
          ? canonicalBootstrapSha256(predecessorProof)
          : 'fresh-no-predecessor',
        result: 'committed',
      };

      const applyTransition = transaction.applyTransition ?? request.applyTransition;
      if (!applyTransition) throw new Error('TENANT_CUTOVER_TRANSITION_EXECUTOR_REQUIRED');
      await applyTransition({ state, operation: next });
      await transaction.appendOperation(next);
      const updated: Task1LifecycleLockedState = {
        ...state,
        databaseState: resultingState,
        stateVersion: nextVersion,
        platformKind: platformBinding.kind,
        platformBindingSha256: next.requestedBindingSha256,
        pendingConfigurationSha256: null,
        currentConfigurationSha256: next.requestedConfigurationSha256,
        currentRuntimeOperationVersion: nextVersion,
        recordedExpandOperation:
          request.command === 'expand' ? next : state.recordedExpandOperation,
        currentOperation: next,
      };
      if (!(await transaction.compareAndSwapState(state, updated))) {
        throw new Error('TENANT_CUTOVER_STATE_CAS_CONFLICT');
      }
      return { action: 'append', operation: next };
    });
  }
}

export const TASK1_LIFECYCLE_DESCRIPTOR_SQL = `
CREATE TABLE public.commander_tenant_cutover_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_uuid uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('fresh_pending', 'legacy_pending', 'expanded', 'enforced')),
  state_version bigint NOT NULL CHECK (state_version >= 0),
  platform_kind text CHECK (platform_kind IN ('helm', 'compose')),
  platform_binding_sha256 text CHECK (platform_binding_sha256 ~ '^[0-9a-f]{64}$'),
  prebootstrap_snapshots_jcs text NOT NULL,
  prebootstrap_snapshots_sha256 text NOT NULL CHECK (prebootstrap_snapshots_sha256 ~ '^[0-9a-f]{64}$'),
  bootstrap_identities_jcs text,
  origin_binding_jcs text NOT NULL,
  origin_binding_sha256 text NOT NULL CHECK (origin_binding_sha256 ~ '^[0-9a-f]{64}$'),
  database_peer_binding_jcs text NOT NULL,
  database_peer_binding_sha256 text NOT NULL CHECK (database_peer_binding_sha256 ~ '^[0-9a-f]{64}$'),
  proof_key_sha256 text NOT NULL CHECK (proof_key_sha256 ~ '^[0-9a-f]{64}$'),
  historical_baseline_manifest_source_sha256 text NOT NULL CHECK (historical_baseline_manifest_source_sha256 ~ '^[0-9a-f]{64}$'),
  historical_baseline_manifest_sha256 text NOT NULL CHECK (historical_baseline_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  hardened_baseline_manifest_source_sha256 text NOT NULL CHECK (hardened_baseline_manifest_source_sha256 ~ '^[0-9a-f]{64}$'),
  hardened_baseline_manifest_sha256 text NOT NULL CHECK (hardened_baseline_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  lifecycle_postcondition_manifest_sha256 text NOT NULL CHECK (lifecycle_postcondition_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  pending_configuration_sha256 text CHECK (pending_configuration_sha256 ~ '^[0-9a-f]{64}$'),
  current_configuration_sha256 text CHECK (current_configuration_sha256 ~ '^[0-9a-f]{64}$'),
  current_runtime_operation_version bigint,
  recorded_expand_operation_version bigint,
  CHECK ((state IN ('fresh_pending', 'legacy_pending')) = (pending_configuration_sha256 IS NOT NULL)),
  CHECK (current_runtime_operation_version IS NULL OR current_runtime_operation_version > 0),
  CHECK (recorded_expand_operation_version IS NULL OR recorded_expand_operation_version > 0)
);

CREATE TABLE public.commander_tenant_cutover_operations (
  installation_uuid uuid NOT NULL,
  operation_version bigint NOT NULL CHECK (operation_version > 0),
  predecessor_state_version bigint NOT NULL CHECK (predecessor_state_version >= 0),
  resulting_state_version bigint NOT NULL CHECK (resulting_state_version > predecessor_state_version),
  predecessor_state text NOT NULL,
  resulting_state text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN (
    'legacy_expand', 'fresh_enforce', 'enforce',
    'recover_runtime_after_enforce_failure', 'rollback_to_recorded_expand'
  )),
  runtime_phase text NOT NULL CHECK (runtime_phase IN ('expand', 'enforce')),
  platform_kind text NOT NULL CHECK (platform_kind IN ('helm', 'compose')),
  previous_binding_jcs text,
  previous_binding_sha256 text,
  requested_binding_jcs text NOT NULL,
  requested_binding_sha256 text NOT NULL CHECK (requested_binding_sha256 ~ '^[0-9a-f]{64}$'),
  previous_configuration_jcs text,
  previous_configuration_sha256 text,
  requested_configuration_jcs text NOT NULL,
  requested_configuration_sha256 text NOT NULL CHECK (requested_configuration_sha256 ~ '^[0-9a-f]{64}$'),
  previous_business_configuration_sha256 text,
  requested_business_configuration_sha256 text NOT NULL
    CHECK (requested_business_configuration_sha256 ~ '^[0-9a-f]{64}$'),
  origin_binding_sha256 text NOT NULL CHECK (origin_binding_sha256 ~ '^[0-9a-f]{64}$'),
  database_peer_binding_sha256 text NOT NULL CHECK (database_peer_binding_sha256 ~ '^[0-9a-f]{64}$'),
  proof_key_sha256 text NOT NULL CHECK (proof_key_sha256 ~ '^[0-9a-f]{64}$'),
  descriptor_set jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(descriptor_set) = 'array'),
  predecessor_evidence_jcs text NOT NULL,
  predecessor_evidence_sha256 text NOT NULL CHECK (predecessor_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result = 'committed'),
  committed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (
    (operation_kind = 'fresh_enforce'
      AND predecessor_evidence_jcs::jsonb ->> 'kind' = 'fresh-no-predecessor/v1')
    OR (operation_kind = 'legacy_expand'
      AND predecessor_evidence_jcs::jsonb ->> 'kind' = 'legacy-predecessor-not-proof-capable/v1')
    OR (operation_kind IN ('enforce', 'recover_runtime_after_enforce_failure',
        'rollback_to_recorded_expand')
      AND predecessor_evidence_jcs::jsonb ->> 'kind' = 'challenged-predecessor/v1')
  ),
  PRIMARY KEY (installation_uuid, operation_version),
  FOREIGN KEY (installation_uuid)
    REFERENCES public.commander_tenant_cutover_state (installation_uuid),
  UNIQUE (installation_uuid, predecessor_state_version, requested_binding_sha256,
    requested_configuration_sha256, origin_binding_sha256, database_peer_binding_sha256)
);

CREATE TABLE public.commander_tenant_cutover_rollout_proofs (
  installation_uuid uuid NOT NULL,
  operation_version bigint NOT NULL CHECK (operation_version > 0),
  proof_sequence bigint NOT NULL CHECK (proof_sequence > 0),
  proof_attempt_id uuid NOT NULL,
  rollout_proof_jcs text NOT NULL,
  rollout_proof_sha256 text NOT NULL CHECK (rollout_proof_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (rollout_proof_jcs::jsonb ->> 'format' = 'rollout-proof/v1'),
  committed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (installation_uuid, operation_version, proof_sequence),
  UNIQUE (proof_attempt_id),
  FOREIGN KEY (installation_uuid, operation_version)
    REFERENCES public.commander_tenant_cutover_operations (installation_uuid, operation_version)
);

ALTER TABLE public.commander_tenant_cutover_state
  ADD CONSTRAINT commander_tenant_cutover_state_current_operation_fk
  FOREIGN KEY (installation_uuid, current_runtime_operation_version)
  REFERENCES public.commander_tenant_cutover_operations (installation_uuid, operation_version)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.commander_tenant_cutover_state
  ADD CONSTRAINT commander_tenant_cutover_state_recorded_expand_fk
  FOREIGN KEY (installation_uuid, recorded_expand_operation_version)
  REFERENCES public.commander_tenant_cutover_operations (installation_uuid, operation_version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION public.reject_tenant_cutover_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'TENANT_CUTOVER_OPERATION_IMMUTABLE' USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER commander_tenant_cutover_operations_immutable
BEFORE UPDATE OR DELETE ON public.commander_tenant_cutover_operations
FOR EACH ROW EXECUTE FUNCTION public.reject_tenant_cutover_operation_mutation();

CREATE OR REPLACE FUNCTION public.reject_tenant_cutover_rollout_proof_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'TENANT_CUTOVER_ROLLOUT_PROOF_IMMUTABLE' USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER commander_tenant_cutover_rollout_proofs_immutable
BEFORE UPDATE OR DELETE ON public.commander_tenant_cutover_rollout_proofs
FOR EACH ROW EXECUTE FUNCTION public.reject_tenant_cutover_rollout_proof_mutation();

CREATE OR REPLACE FUNCTION public.commander_database_identity()
RETURNS TABLE(
  installation_id uuid,
  database_oid oid,
  database_name text,
  database_peer_binding_sha256 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT state.installation_uuid,
         database.oid,
         pg_catalog.current_database()::text,
         state.database_peer_binding_sha256
    FROM public.commander_tenant_cutover_state AS state
    JOIN pg_catalog.pg_database AS database
      ON database.datname = pg_catalog.current_database()
   WHERE state.singleton = true
$function$;

CREATE OR REPLACE FUNCTION public.commander_runtime_configuration_identity()
RETURNS TABLE(
  operation_version_text text,
  runtime_phase text,
  api_image_digest text,
  configuration_sha256 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT operation.operation_version::text,
         operation.runtime_phase,
         operation.requested_binding_jcs::jsonb ->> 'apiImageDigest',
         operation.requested_configuration_sha256
    FROM public.commander_tenant_cutover_state AS state
    JOIN public.commander_tenant_cutover_operations AS operation
      ON operation.installation_uuid = state.installation_uuid
     AND operation.operation_version = state.current_runtime_operation_version
   WHERE state.singleton = true
$function$;

ALTER TABLE public.commander_tenant_cutover_state OWNER TO commander_owner;
ALTER TABLE public.commander_tenant_cutover_operations OWNER TO commander_owner;
ALTER TABLE public.commander_tenant_cutover_rollout_proofs OWNER TO commander_owner;
ALTER FUNCTION public.reject_tenant_cutover_operation_mutation() OWNER TO commander_owner;
ALTER FUNCTION public.reject_tenant_cutover_rollout_proof_mutation() OWNER TO commander_owner;
ALTER FUNCTION public.commander_database_identity() OWNER TO commander_owner;
ALTER FUNCTION public.commander_runtime_configuration_identity() OWNER TO commander_owner;

REVOKE ALL ON TABLE public.commander_tenant_cutover_state,
  public.commander_tenant_cutover_operations, public.commander_tenant_cutover_rollout_proofs
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops,
       commander_scheduler;
REVOKE ALL ON FUNCTION public.reject_tenant_cutover_operation_mutation(),
  public.reject_tenant_cutover_rollout_proof_mutation(),
  public.commander_database_identity(), public.commander_runtime_configuration_identity()
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops,
       commander_scheduler;
GRANT EXECUTE ON FUNCTION public.commander_database_identity()
  TO commander_app, commander_worker, commander_adapter_ops,
     commander_scheduler;
`;

/** Immutable lifecycle descriptor used by the Helm/Compose owner migration gate. */
export const KERNEL_TASK1_HELM_LIFECYCLE_GATE_SQL = TASK1_LIFECYCLE_DESCRIPTOR_SQL;

export const TASK1_LIFECYCLE_LOCK_STATE_SQL = `
SELECT
  lifecycle_state.*,
  pg_catalog.to_jsonb(current_operation) AS current_operation,
  pg_catalog.to_jsonb(recorded_expand_operation) AS recorded_expand_operation
FROM public.commander_tenant_cutover_state AS lifecycle_state
LEFT JOIN public.commander_tenant_cutover_operations AS current_operation
  ON current_operation.installation_uuid = lifecycle_state.installation_uuid
 AND current_operation.operation_version = lifecycle_state.current_runtime_operation_version
LEFT JOIN public.commander_tenant_cutover_operations AS recorded_expand_operation
  ON recorded_expand_operation.installation_uuid = lifecycle_state.installation_uuid
 AND recorded_expand_operation.operation_version = lifecycle_state.recorded_expand_operation_version
FOR UPDATE OF lifecycle_state
`.trim();

const LEGACY_SESSION_LOCK_SQL =
  "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('commander.kernel.migrations'))";
const LEGACY_SESSION_UNLOCK_SQL =
  "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('commander.kernel.migrations'))";
const LIFECYCLE_SESSION_LOCK_SQL = `
SELECT pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commander.kernel.lifecycle/' || database.oid::text, 0)
)
FROM pg_catalog.pg_database AS database
WHERE database.datname = pg_catalog.current_database()
`.trim();
const LIFECYCLE_SESSION_UNLOCK_SQL = LIFECYCLE_SESSION_LOCK_SQL.replace(
  'pg_catalog.pg_advisory_lock(',
  'pg_catalog.pg_advisory_unlock(',
);

interface StateRow {
  installation_uuid: string;
  state: DatabaseState;
  state_version: string;
  platform_kind: TenantCutoverPlatformKind | null;
  platform_binding_sha256: string | null;
  prebootstrap_snapshots_jcs: string;
  prebootstrap_snapshots_sha256: string;
  origin_binding_jcs: string;
  origin_binding_sha256: string;
  database_peer_binding_jcs: string;
  database_peer_binding_sha256: string;
  proof_key_sha256: string;
  pending_configuration_sha256: string | null;
  current_configuration_sha256: string | null;
  current_runtime_operation_version: string | null;
  current_operation: Record<string, unknown> | null;
  recorded_expand_operation: Record<string, unknown> | null;
}

function operationFromRow(
  row: Record<string, unknown> | null,
): Task1LifecycleOperation | undefined {
  if (!row) return undefined;
  return {
    installationUuid: String(row.installation_uuid),
    operationVersion: String(row.operation_version),
    predecessorStateVersion: String(row.predecessor_state_version),
    resultingStateVersion: String(row.resulting_state_version),
    predecessorState: row.predecessor_state as DatabaseState,
    resultingState: row.resulting_state as DatabaseState,
    operationKind: row.operation_kind as TenantCutoverOperationKind,
    runtimePhase: row.runtime_phase as TenantCutoverRuntimePhase,
    platformKind: row.platform_kind as TenantCutoverPlatformKind,
    previousBindingJcs: row.previous_binding_jcs == null ? null : String(row.previous_binding_jcs),
    previousBindingSha256:
      row.previous_binding_sha256 == null ? null : String(row.previous_binding_sha256),
    requestedBindingJcs: String(row.requested_binding_jcs),
    requestedBindingSha256: String(row.requested_binding_sha256),
    previousConfigurationJcs:
      row.previous_configuration_jcs == null ? null : String(row.previous_configuration_jcs),
    previousConfigurationSha256:
      row.previous_configuration_sha256 == null ? null : String(row.previous_configuration_sha256),
    requestedConfigurationJcs: String(row.requested_configuration_jcs),
    requestedConfigurationSha256: String(row.requested_configuration_sha256),
    previousBusinessConfigurationSha256:
      row.previous_business_configuration_sha256 == null
        ? null
        : String(row.previous_business_configuration_sha256),
    requestedBusinessConfigurationSha256: String(row.requested_business_configuration_sha256),
    originBindingSha256: String(row.origin_binding_sha256),
    databasePeerBindingSha256: String(row.database_peer_binding_sha256),
    proofKeySha256: String(row.proof_key_sha256),
    descriptorSet: Array.isArray(row.descriptor_set) ? row.descriptor_set.map(String) : [],
    predecessorEvidenceJcs: String(row.predecessor_evidence_jcs),
    predecessorEvidenceSha256: String(row.predecessor_evidence_sha256),
    predecessorProof: String(row.predecessor_evidence_sha256),
    result: 'committed',
  };
}

class PostgresOwnerTransaction implements Task1LifecycleOwnerTransaction {
  readonly applyTransition?: Task1LifecycleOwnerTransaction['applyTransition'];

  constructor(
    private readonly client: SqlClient,
    transition?: (input: {
      client: SqlClient;
      state: Task1LifecycleLockedState;
      operation: Task1LifecycleOperation;
    }) => Promise<void>,
  ) {
    if (transition) {
      this.applyTransition = (input) => transition({ client: this.client, ...input });
    }
  }

  async lockState(): Promise<Task1LifecycleLockedState> {
    const result = await this.client.query<StateRow>(TASK1_LIFECYCLE_LOCK_STATE_SQL);
    const row = result.rows[0];
    if (!row || result.rowCount !== 1) throw new Error('TENANT_CUTOVER_STATE_INVALID');
    return {
      installationUuid: row.installation_uuid,
      databaseState: row.state,
      stateVersion: String(row.state_version),
      platformKind: row.platform_kind ?? undefined,
      platformBindingSha256: row.platform_binding_sha256,
      prebootstrapSnapshotsJcs: row.prebootstrap_snapshots_jcs,
      prebootstrapSnapshotsSha256: row.prebootstrap_snapshots_sha256,
      originBindingJcs: row.origin_binding_jcs,
      originBindingSha256: row.origin_binding_sha256,
      databasePeerBindingJcs: row.database_peer_binding_jcs,
      databasePeerBindingSha256: row.database_peer_binding_sha256,
      proofKeySha256: row.proof_key_sha256,
      pendingConfigurationSha256: row.pending_configuration_sha256,
      currentConfigurationSha256: row.current_configuration_sha256,
      currentRuntimeOperationVersion: row.current_runtime_operation_version,
      currentOperation: operationFromRow(row.current_operation),
      recordedExpandOperation: operationFromRow(row.recorded_expand_operation),
    };
  }

  async appendOperation(operation: Task1LifecycleOperation): Promise<void> {
    await this.client.query(
      `INSERT INTO public.commander_tenant_cutover_operations
       (installation_uuid, operation_version, predecessor_state_version,
        resulting_state_version, predecessor_state, resulting_state, operation_kind,
        runtime_phase, platform_kind, previous_binding_jcs, previous_binding_sha256, requested_binding_jcs,
        requested_binding_sha256, previous_configuration_jcs, previous_configuration_sha256,
        requested_configuration_jcs, requested_configuration_sha256,
        previous_business_configuration_sha256, requested_business_configuration_sha256,
        origin_binding_sha256, database_peer_binding_sha256, proof_key_sha256, descriptor_set,
        predecessor_evidence_jcs, predecessor_evidence_sha256, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26)`,
      [
        operation.installationUuid,
        operation.operationVersion,
        operation.predecessorStateVersion,
        operation.resultingStateVersion,
        operation.predecessorState,
        operation.resultingState,
        operation.operationKind,
        operation.runtimePhase,
        operation.platformKind,
        operation.previousBindingJcs,
        operation.previousBindingSha256,
        operation.requestedBindingJcs,
        operation.requestedBindingSha256,
        operation.previousConfigurationJcs,
        operation.previousConfigurationSha256,
        operation.requestedConfigurationJcs,
        operation.requestedConfigurationSha256,
        operation.previousBusinessConfigurationSha256,
        operation.requestedBusinessConfigurationSha256,
        operation.originBindingSha256,
        operation.databasePeerBindingSha256,
        operation.proofKeySha256,
        JSON.stringify(operation.descriptorSet),
        operation.predecessorEvidenceJcs,
        operation.predecessorEvidenceSha256,
        operation.result,
      ],
    );
  }

  async compareAndSwapState(
    expected: Task1LifecycleLockedState,
    next: Task1LifecycleLockedState,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE public.commander_tenant_cutover_state
          SET state = $3, state_version = $4,
              platform_kind = $5, platform_binding_sha256 = $6,
              pending_configuration_sha256 = $7,
              current_configuration_sha256 = $8,
              current_runtime_operation_version = $9,
              recorded_expand_operation_version = $10
        WHERE installation_uuid = $1
          AND state_version = $2
          AND database_peer_binding_sha256 = $11
          AND origin_binding_sha256 = $12
          AND pending_configuration_sha256 IS NOT DISTINCT FROM $13
          AND platform_binding_sha256 IS NOT DISTINCT FROM $14
      RETURNING state_version`,
      [
        expected.installationUuid,
        expected.stateVersion,
        next.databaseState,
        next.stateVersion,
        next.platformKind,
        next.platformBindingSha256,
        next.pendingConfigurationSha256,
        next.currentConfigurationSha256,
        next.currentRuntimeOperationVersion,
        next.recordedExpandOperation?.operationVersion ?? null,
        expected.databasePeerBindingSha256,
        expected.originBindingSha256,
        expected.pendingConfigurationSha256,
        expected.platformBindingSha256,
      ],
    );
    return result.rowCount === 1;
  }
}

export class PostgresTask1LifecycleOwnerTransactions implements Task1LifecycleOwnerTransactions {
  constructor(
    private readonly pool: SqlPool,
    private readonly options: {
      initialize?: (client: SqlClient) => Promise<void>;
      applyTransition?: (input: {
        client: SqlClient;
        state: Task1LifecycleLockedState;
        operation: Task1LifecycleOperation;
      }) => Promise<void>;
    } = {},
  ) {}

  async withLockedOwnerTransaction<T>(
    work: (transaction: Task1LifecycleOwnerTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let legacyLocked = false;
    let lifecycleLocked = false;
    let transactionOpen = false;
    try {
      const authority = await client.query<{
        current_user: string;
        session_user: string;
        owns_state: boolean;
        owns_operations: boolean;
      }>(`
        SELECT current_user::text AS current_user,
               session_user::text AS session_user,
               pg_catalog.pg_has_role(current_user, 'commander_owner', 'USAGE') AS owns_state,
               pg_catalog.pg_has_role(session_user, 'commander_owner', 'USAGE') AS owns_operations
      `);
      const identity = authority.rows[0];
      if (
        authority.rowCount !== 1 ||
        identity?.current_user !== 'commander_owner' ||
        identity.session_user !== 'commander_owner' ||
        !identity.owns_state ||
        !identity.owns_operations
      ) {
        throw new Error('TENANT_CUTOVER_OWNER_AUTHORITY_REQUIRED');
      }
      await client.query(LEGACY_SESSION_LOCK_SQL);
      legacyLocked = true;
      await client.query(LIFECYCLE_SESSION_LOCK_SQL);
      lifecycleLocked = true;
      await this.options.initialize?.(client);
      await client.query('BEGIN');
      transactionOpen = true;
      const result = await work(new PostgresOwnerTransaction(client, this.options.applyTransition));
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
        transactionOpen = false;
      }
      throw error;
    } finally {
      if (lifecycleLocked) await client.query(LIFECYCLE_SESSION_UNLOCK_SQL);
      if (legacyLocked) await client.query(LEGACY_SESSION_UNLOCK_SQL);
      await client.release();
    }
  }
}
