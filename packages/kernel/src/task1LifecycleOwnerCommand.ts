import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type {
  Task1LifecycleOperation,
  Task1LifecycleRequest,
  Task1LifecycleResult,
  Task1PlatformBinding,
} from './task1LifecycleLedger.js';
import type { TenantCutoverCommand } from './tenantCutoverStateMachine.js';
import type { Task1RolloutProofReceipt } from './task1RolloutProof.js';
import type { Task1RecoveryPredecessorChallenge } from './task1RolloutProof.js';

type JsonRecord = Record<string, unknown>;

export type Task1OwnerCommandMode =
  | 'tenant-cutover-plan'
  | 'tenant-cutover-append'
  | 'tenant-cutover-recover'
  | 'tenant-cutover-prove'
  | 'tenant-cutover-restore';

export interface Task1OwnerCommandDependencies {
  execute(request: Task1LifecycleRequest): Promise<Task1LifecycleResult>;
  current(): Promise<{
    operation: Task1LifecycleOperation | undefined;
    predecessor?: Task1LifecycleOperation;
    proven: boolean;
    restoreEvidence?: Task1HelmRestoreEvidence;
  }>;
  proveCurrent?(operation: Task1LifecycleOperation): Promise<Task1RolloutProofReceipt>;
  verifyRecoveryPredecessor?(
    operation: Task1LifecycleOperation,
  ): Promise<Task1RecoveryPredecessorChallenge | { status: 'absent' }>;
}

export interface Task1HelmRestoreEvidence {
  revision: string;
  releaseProjection: JsonRecord;
  releaseProjectionSha256: string;
}

export interface Task1OwnerPreparedRequest {
  command: TenantCutoverCommand;
  platformBinding: Task1PlatformBinding;
  businessConfiguration: JsonRecord;
  configuration: JsonRecord & { operationAuditNonce: string };
  configurationSha256: string;
}

interface Task1ComposePlanIntent {
  kind: 'compose';
  projectName: string;
  composeVariant: 'prod';
  composeCredentialInventory: 'runtime-v1' | 'fresh-bootstrap-v1';
  composeSourceSha256: string;
  composeCliVersion: '5.3.1';
  phase: 'expand' | 'enforce';
  apiImageDigest: string;
  apiProofUrl: string;
}

interface Task1HelmPlanIntent {
  kind: 'helm';
  namespace: string;
  releaseName: string;
  chartContentSha256: string;
  phase: 'expand' | 'enforce';
  apiImageDigest: string;
}

interface Task1OwnerPlanRequest {
  command: TenantCutoverCommand;
  platformIntent: Task1ComposePlanIntent | Task1HelmPlanIntent;
  businessConfiguration: JsonRecord;
}

function invalid(): never {
  throw new Error('TENANT_CUTOVER_OWNER_REQUEST_INVALID');
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalid();
  }
}

function parseCanonical(raw: string): JsonRecord {
  const source = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!source || source.includes('\n') || source.includes('\r')) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid();
  }
  if (canonicalBootstrapJson(parsed) !== source) invalid();
  return record(parsed);
}

function command(value: unknown): TenantCutoverCommand {
  switch (value) {
    case 'expand':
    case 'install_enforce':
    case 'enforce':
    case 'recover_runtime_after_enforce_failure':
    case 'rollback_to_recorded_expand':
      return value;
    case 'install':
      return 'install_enforce';
    case 'rollback-recorded-expand':
      return 'rollback_to_recorded_expand';
    default:
      return invalid();
  }
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

function kubernetesName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 63 ||
    !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)
  ) {
    invalid();
  }
  return value;
}

function platformBinding(value: unknown): Task1PlatformBinding {
  const binding = record(value);
  if (binding.kind === 'compose') {
    exactKeys(binding, [
      'kind',
      'projectName',
      'composeVariant',
      'composeCredentialInventory',
      'composeSourceSha256',
      'composeCliVersion',
      'composeContentSha256',
      'phase',
      'apiImageDigest',
      'apiProofUrl',
    ]);
    if (
      typeof binding.projectName !== 'string' ||
      binding.composeVariant !== 'prod' ||
      (binding.composeCredentialInventory !== 'runtime-v1' &&
        binding.composeCredentialInventory !== 'fresh-bootstrap-v1') ||
      typeof binding.composeSourceSha256 !== 'string' ||
      binding.composeCliVersion !== '5.3.1' ||
      typeof binding.composeContentSha256 !== 'string' ||
      (binding.phase !== 'expand' && binding.phase !== 'enforce') ||
      typeof binding.apiImageDigest !== 'string' ||
      typeof binding.apiProofUrl !== 'string'
    )
      invalid();
    sha256(binding.composeSourceSha256);
    sha256(binding.composeContentSha256);
    if (!/^[^\s]+@sha256:[0-9a-f]{64}$/.test(binding.apiImageDigest)) invalid();
    return binding as unknown as Extract<Task1PlatformBinding, { kind: 'compose' }>;
  }
  if (binding.kind === 'helm') {
    exactKeys(binding, [
      'kind',
      'namespace',
      'releaseName',
      'chartContentSha256',
      'phase',
      'apiImageDigest',
    ]);
    if (
      typeof binding.namespace !== 'string' ||
      typeof binding.releaseName !== 'string' ||
      typeof binding.chartContentSha256 !== 'string' ||
      (binding.phase !== 'expand' && binding.phase !== 'enforce') ||
      typeof binding.apiImageDigest !== 'string'
    )
      invalid();
    sha256(binding.chartContentSha256);
    if (!/^sha256:[0-9a-f]{64}$/.test(binding.apiImageDigest)) invalid();
    return binding as unknown as Extract<Task1PlatformBinding, { kind: 'helm' }>;
  }
  return invalid();
}

function prepared(value: unknown, inputCommand: TenantCutoverCommand): Task1OwnerPreparedRequest {
  const request = record(value);
  exactKeys(request, [
    'platformBinding',
    'businessConfiguration',
    'configuration',
    'configurationSha256',
  ]);
  const binding = platformBinding(request.platformBinding);
  const businessConfiguration = record(request.businessConfiguration);
  const configuration = record(request.configuration);
  if (
    typeof configuration.operationAuditNonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(configuration.operationAuditNonce)
  )
    invalid();
  const expectedConfiguration = {
    ...businessConfiguration,
    operationAuditNonce: configuration.operationAuditNonce,
  };
  if (canonicalBootstrapJson(configuration) !== canonicalBootstrapJson(expectedConfiguration))
    invalid();
  const configurationSha256 = sha256(request.configurationSha256);
  if (canonicalBootstrapSha256(configuration) !== configurationSha256) invalid();
  if (
    (inputCommand === 'expand' && binding.phase !== 'expand') ||
    (inputCommand !== 'expand' &&
      inputCommand !== 'rollback_to_recorded_expand' &&
      binding.phase !== 'enforce')
  )
    invalid();
  return {
    command: inputCommand,
    platformBinding: binding,
    businessConfiguration,
    configuration: configuration as JsonRecord & { operationAuditNonce: string },
    configurationSha256,
  };
}

export function parseTask1OwnerCommandInput(raw: string): Task1OwnerPreparedRequest {
  const input = parseCanonical(raw);
  exactKeys(input, ['schema', 'command', 'prepared']);
  if (input.schema !== 'tenant-cutover-request/v1') invalid();
  return prepared(input.prepared, command(input.command));
}

function composePlanIntent(value: unknown): Task1ComposePlanIntent {
  const intent = record(value);
  exactKeys(intent, [
    'kind',
    'projectName',
    'composeVariant',
    'composeCredentialInventory',
    'composeSourceSha256',
    'composeCliVersion',
    'phase',
    'apiImageDigest',
    'apiProofUrl',
  ]);
  if (
    intent.kind !== 'compose' ||
    typeof intent.projectName !== 'string' ||
    intent.composeVariant !== 'prod' ||
    (intent.composeCredentialInventory !== 'runtime-v1' &&
      intent.composeCredentialInventory !== 'fresh-bootstrap-v1') ||
    intent.composeCliVersion !== '5.3.1' ||
    (intent.phase !== 'expand' && intent.phase !== 'enforce') ||
    typeof intent.apiImageDigest !== 'string' ||
    !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(intent.apiImageDigest) ||
    typeof intent.apiProofUrl !== 'string'
  ) {
    invalid();
  }
  sha256(intent.composeSourceSha256);
  return intent as unknown as Task1ComposePlanIntent;
}

function helmPlanIntent(value: unknown): Task1HelmPlanIntent {
  const intent = record(value);
  exactKeys(intent, [
    'kind',
    'namespace',
    'releaseName',
    'chartContentSha256',
    'phase',
    'apiImageDigest',
  ]);
  if (
    intent.kind !== 'helm' ||
    (intent.phase !== 'expand' && intent.phase !== 'enforce') ||
    typeof intent.apiImageDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(intent.apiImageDigest)
  ) {
    invalid();
  }
  kubernetesName(intent.namespace);
  kubernetesName(intent.releaseName);
  sha256(intent.chartContentSha256);
  return intent as unknown as Task1HelmPlanIntent;
}

function planIntent(value: unknown): Task1ComposePlanIntent | Task1HelmPlanIntent {
  const intent = record(value);
  if (intent.kind === 'compose') return composePlanIntent(intent);
  if (intent.kind === 'helm') return helmPlanIntent(intent);
  return invalid();
}

function parseTask1OwnerPlanInput(raw: string): Task1OwnerPlanRequest {
  const input = parseCanonical(raw);
  exactKeys(input, ['schema', 'command', 'platformIntent', 'businessConfiguration']);
  if (input.schema !== 'tenant-cutover-plan/v1') invalid();
  return {
    command: command(input.command),
    platformIntent: planIntent(input.platformIntent),
    businessConfiguration: record(input.businessConfiguration),
  };
}

function descriptorSet(commandValue: TenantCutoverCommand): readonly string[] {
  if (commandValue === 'expand') return ['lifecycle', 'expand'];
  if (
    commandValue === 'recover_runtime_after_enforce_failure' ||
    commandValue === 'rollback_to_recorded_expand'
  )
    return [];
  return ['lifecycle', 'expand', 'enforce'];
}

function currentBusinessConfiguration(operation: Task1LifecycleOperation): JsonRecord {
  const configuration = parseCanonical(operation.requestedConfigurationJcs);
  const { operationAuditNonce: _nonce, platformBinding: _binding, ...business } = configuration;
  return business;
}

function currentBinding(operation: Task1LifecycleOperation): Task1PlatformBinding {
  return platformBinding(parseCanonical(operation.requestedBindingJcs));
}

function assertHelmRestoreEvidence(
  evidence: Task1HelmRestoreEvidence | undefined,
  binding: Extract<Task1PlatformBinding, { kind: 'helm' }>,
): Task1HelmRestoreEvidence {
  if (!evidence) throw new Error('TENANT_CUTOVER_RESTORE_EVIDENCE_REQUIRED');
  const projection = record(evidence.releaseProjection);
  if (
    !/^[1-9][0-9]*$/.test(evidence.revision) ||
    !/^[0-9a-f]{64}$/.test(evidence.releaseProjectionSha256) ||
    canonicalBootstrapSha256(projection) !== evidence.releaseProjectionSha256 ||
    projection.format !== 'helm-release-projection/v1' ||
    projection.namespace !== binding.namespace ||
    projection.releaseName !== binding.releaseName ||
    projection.revision !== evidence.revision ||
    projection.chartContentSha256 !== binding.chartContentSha256 ||
    !Array.isArray(projection.objects) ||
    !Array.isArray(projection.hooks) ||
    !projection.rendererInput ||
    typeof projection.rendererInput !== 'object' ||
    Array.isArray(projection.rendererInput)
  ) {
    throw new Error('TENANT_CUTOVER_RESTORE_EVIDENCE_INVALID');
  }
  return evidence;
}

function planMatchesCurrent(
  operation: Task1LifecycleOperation,
  request: Task1OwnerPlanRequest,
): boolean {
  const binding = currentBinding(operation);
  const intent = request.platformIntent;
  let platformMatches = false;
  if (binding.kind === 'compose' && intent.kind === 'compose') {
    platformMatches =
      binding.projectName === intent.projectName &&
      binding.composeVariant === intent.composeVariant &&
      binding.composeCredentialInventory === intent.composeCredentialInventory &&
      binding.composeSourceSha256 === intent.composeSourceSha256 &&
      binding.composeCliVersion === intent.composeCliVersion &&
      binding.phase === intent.phase &&
      binding.apiImageDigest === intent.apiImageDigest &&
      binding.apiProofUrl === intent.apiProofUrl;
  } else if (binding.kind === 'helm' && intent.kind === 'helm') {
    platformMatches =
      binding.namespace === intent.namespace &&
      binding.releaseName === intent.releaseName &&
      binding.chartContentSha256 === intent.chartContentSha256 &&
      binding.phase === intent.phase &&
      binding.apiImageDigest === intent.apiImageDigest;
  }
  return (
    platformMatches &&
    canonicalBootstrapJson(currentBusinessConfiguration(operation)) ===
      canonicalBootstrapJson(request.businessConfiguration)
  );
}

function assertImmediatePredecessor(
  operation: Task1LifecycleOperation,
  predecessor: Task1LifecycleOperation | undefined,
): void {
  const hasPredecessor =
    operation.previousBindingJcs !== null || operation.previousConfigurationJcs !== null;
  if (!hasPredecessor) {
    if (predecessor !== undefined) throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
    return;
  }
  if (
    !predecessor ||
    predecessor.installationUuid !== operation.installationUuid ||
    predecessor.operationVersion !== operation.predecessorStateVersion ||
    predecessor.resultingStateVersion !== operation.predecessorStateVersion ||
    predecessor.requestedBindingJcs !== operation.previousBindingJcs ||
    predecessor.requestedBindingSha256 !== operation.previousBindingSha256 ||
    predecessor.requestedConfigurationJcs !== operation.previousConfigurationJcs ||
    predecessor.requestedConfigurationSha256 !== operation.previousConfigurationSha256
  ) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
}

function projectedOperation(
  operation: Task1LifecycleOperation,
  predecessor?: Task1LifecycleOperation,
  validatePredecessorLink = true,
): JsonRecord {
  if (validatePredecessorLink) assertImmediatePredecessor(operation, predecessor);
  const binding = currentBinding(operation);
  const configuration = parseCanonical(operation.requestedConfigurationJcs);
  if (
    canonicalBootstrapSha256(binding) !== operation.requestedBindingSha256 ||
    canonicalBootstrapSha256(configuration) !== operation.requestedConfigurationSha256 ||
    typeof configuration.operationAuditNonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(configuration.operationAuditNonce)
  ) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
  return {
    operationVersion: operation.operationVersion,
    operationKind: operation.operationKind,
    phase: operation.runtimePhase,
    apiImage: binding.apiImageDigest,
    platformBinding: binding,
    businessConfiguration: currentBusinessConfiguration(operation),
    configuration,
    configurationSha256: operation.requestedConfigurationSha256,
    predecessor: predecessor ? projectedOperation(predecessor, undefined, false) : null,
  };
}

function commandAcceptsCurrent(
  commandValue: TenantCutoverCommand,
  operation: Task1LifecycleOperation,
): boolean {
  switch (commandValue) {
    case 'install_enforce':
      return operation.operationKind === 'fresh_enforce';
    case 'expand':
      return operation.operationKind === 'legacy_expand';
    case 'enforce':
      return operation.operationKind === 'fresh_enforce' || operation.operationKind === 'enforce';
    case 'rollback_to_recorded_expand':
      return operation.operationKind === 'rollback_to_recorded_expand';
    case 'recover_runtime_after_enforce_failure':
      return operation.operationKind === 'recover_runtime_after_enforce_failure';
  }
}

export async function runTask1OwnerCommand(
  mode: Task1OwnerCommandMode,
  rawInput: string,
  dependencies: Task1OwnerCommandDependencies,
): Promise<JsonRecord> {
  if (mode === 'tenant-cutover-restore') {
    const input = parseCanonical(rawInput);
    exactKeys(input, ['schema', 'namespace', 'release']);
    if (input.schema !== 'tenant-cutover-restore/v1') invalid();
    const namespace = kubernetesName(input.namespace);
    const release = kubernetesName(input.release);
    const current = await dependencies.current();
    if (!current.operation) throw new Error('TENANT_CUTOVER_RESTORE_CURRENT_REQUIRED');
    if (!current.proven) throw new Error('TENANT_CUTOVER_RESTORE_PROOF_REQUIRED');
    const binding = currentBinding(current.operation);
    if (
      binding.kind !== 'helm' ||
      binding.namespace !== namespace ||
      binding.releaseName !== release
    ) {
      throw new Error('TENANT_CUTOVER_RESTORE_BINDING_MISMATCH');
    }
    return {
      operation: {
        ...projectedOperation(current.operation, current.predecessor),
        proven: true,
        restore: assertHelmRestoreEvidence(current.restoreEvidence, binding),
      },
    };
  }

  if (mode === 'tenant-cutover-prove') {
    if (rawInput.trim() !== '') throw new Error('TENANT_CUTOVER_PROOF_INPUT_FORBIDDEN');
    const current = await dependencies.current();
    if (!current.operation) throw new Error('TENANT_CUTOVER_PROOF_CURRENT_REQUIRED');
    if (!dependencies.proveCurrent) throw new Error('TENANT_CUTOVER_PROOF_RUNTIME_REQUIRED');
    const receipt = await dependencies.proveCurrent(current.operation);
    if (receipt.operationVersion !== current.operation.operationVersion) {
      throw new Error('TENANT_CUTOVER_PROOF_CURRENT_CHANGED');
    }
    return { proven: true, ...receipt };
  }

  if (mode === 'tenant-cutover-plan') {
    const requested = parseTask1OwnerPlanInput(rawInput);
    const current = await dependencies.current();
    if (!current.operation) return { action: 'append' };
    if (
      !commandAcceptsCurrent(requested.command, current.operation) ||
      !planMatchesCurrent(current.operation, requested)
    ) {
      return { action: 'append' };
    }
    if (!current.proven && current.operation.operationKind === 'enforce') {
      throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED');
    }
    return {
      action: current.proven ? 'return_current' : 'retry_rollout',
      operation: projectedOperation(current.operation, current.predecessor),
    };
  }

  let request: Task1OwnerPreparedRequest;
  let recoveryPredecessor: Task1LifecycleOperation | undefined;
  if (mode === 'tenant-cutover-recover') {
    const recoveryInput = parseCanonical(rawInput);
    exactKeys(recoveryInput, ['failed']);
    exactKeys(record(recoveryInput.failed), []);
    const current = await dependencies.current();
    if (!current.operation || current.proven) {
      throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_NOT_REQUIRED');
    }
    if (current.operation.operationKind === 'recover_runtime_after_enforce_failure') {
      return {
        action: 'retry_rollout',
        operation: projectedOperation(current.operation, current.predecessor),
      };
    }
    if (current.operation.operationKind !== 'enforce') {
      throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED');
    }
    if (!current.predecessor || !dependencies.verifyRecoveryPredecessor) {
      throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
    }
    assertImmediatePredecessor(current.operation, current.predecessor);
    recoveryPredecessor = current.predecessor;
    request = {
      command: 'recover_runtime_after_enforce_failure',
      platformBinding: currentBinding(current.operation),
      businessConfiguration: currentBusinessConfiguration(current.operation),
      configuration: JSON.parse(current.operation.requestedConfigurationJcs) as JsonRecord & {
        operationAuditNonce: string;
      },
      configurationSha256: current.operation.requestedConfigurationSha256,
    };
  } else {
    request = parseTask1OwnerCommandInput(rawInput);
  }
  const result = await dependencies.execute({
    command: request.command,
    platformBinding: request.platformBinding,
    businessConfiguration: request.businessConfiguration,
    operationAuditNonce:
      mode === 'tenant-cutover-append' ? request.configuration.operationAuditNonce : undefined,
    descriptorSet: descriptorSet(request.command),
    verifyRecoveryPredecessor: recoveryPredecessor
      ? async (candidate) => {
          if (
            canonicalBootstrapJson(candidate.platformBinding) !==
              recoveryPredecessor.requestedBindingJcs ||
            canonicalBootstrapJson(candidate.configuration) !==
              recoveryPredecessor.requestedConfigurationJcs
          ) {
            throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
          }
          return dependencies.verifyRecoveryPredecessor!(recoveryPredecessor);
        }
      : undefined,
  });
  const stored = await dependencies.current();
  if (
    !stored.operation ||
    stored.operation.installationUuid !== result.operation.installationUuid ||
    stored.operation.operationVersion !== result.operation.operationVersion
  ) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
  return result.action === 'append'
    ? { action: 'append', operation: projectedOperation(stored.operation, stored.predecessor) }
    : {
        action: result.action,
        operation: projectedOperation(stored.operation, stored.predecessor),
      };
}
