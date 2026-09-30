export type TenantCutoverPlatformKind = 'helm' | 'compose';
export type TenantCutoverRuntimePhase = 'expand' | 'enforce';
export type TenantCutoverOperationKind =
  | 'legacy_expand'
  | 'fresh_enforce'
  | 'enforce'
  | 'recover_runtime_after_enforce_failure'
  | 'rollback_to_recorded_expand';

export type TenantCutoverCommand =
  | 'expand'
  | 'install_enforce'
  | 'enforce'
  | 'recover_runtime_after_enforce_failure'
  | 'rollback_to_recorded_expand';

export interface TenantCutoverOperationIdentity {
  operationVersion: string;
  predecessorOperationVersion?: string;
  kind: TenantCutoverOperationKind;
  runtimePhase: TenantCutoverRuntimePhase;
  bindingSha256: string;
  businessConfigurationSha256: string;
  fullConfigurationSha256: string;
  provenLive: boolean;
}

export interface TenantCutoverRecoveryPredecessor {
  operationVersion: string;
  platformKind: TenantCutoverPlatformKind;
  runtimePhase: TenantCutoverRuntimePhase;
  bindingSha256: string;
  businessConfigurationSha256: string;
  fullConfigurationSha256: string;
  bindingJcs: string;
  fullConfigurationJcs: string;
  provenLive: true;
}

export interface TenantCutoverRecordedExpand {
  bindingSha256: string;
  businessConfigurationSha256: string;
  fullConfigurationSha256: string;
}

export interface TenantCutoverState {
  databaseState: 'fresh' | 'fresh_pending' | 'legacy' | 'legacy_pending' | 'expanded' | 'enforced';
  platformKind?: TenantCutoverPlatformKind;
  currentOperation?: TenantCutoverOperationIdentity;
  recordedExpand?: TenantCutoverRecordedExpand;
  recoveryPredecessor?: TenantCutoverRecoveryPredecessor;
}

export interface TenantCutoverRequest {
  command: TenantCutoverCommand;
  platformKind: TenantCutoverPlatformKind;
  bindingSha256: string;
  businessConfigurationSha256: string;
  fullConfigurationSha256?: string;
}

export type TenantCutoverDecision =
  | { action: 'return_current'; operationVersion: string }
  | { action: 'retry_rollout'; operationVersion: string; nonce: 'reuse' }
  | {
      action: 'append';
      operationKind: TenantCutoverOperationKind;
      nonce: 'fresh';
    };

const LIVE_NOOP_KINDS: Readonly<
  Record<TenantCutoverCommand, ReadonlySet<TenantCutoverOperationKind>>
> = {
  expand: new Set(['legacy_expand']),
  install_enforce: new Set(['fresh_enforce']),
  enforce: new Set(['fresh_enforce', 'enforce']),
  recover_runtime_after_enforce_failure: new Set(['recover_runtime_after_enforce_failure']),
  rollback_to_recorded_expand: new Set(['rollback_to_recorded_expand']),
};

const RETRYABLE_UNPROVEN_KINDS = new Set<TenantCutoverOperationKind>([
  'legacy_expand',
  'fresh_enforce',
  'recover_runtime_after_enforce_failure',
  'rollback_to_recorded_expand',
]);

function operationKindForCommand(command: TenantCutoverCommand): TenantCutoverOperationKind {
  switch (command) {
    case 'expand':
      return 'legacy_expand';
    case 'install_enforce':
      return 'fresh_enforce';
    case 'enforce':
      return 'enforce';
    case 'recover_runtime_after_enforce_failure':
      return 'recover_runtime_after_enforce_failure';
    case 'rollback_to_recorded_expand':
      return 'rollback_to_recorded_expand';
  }
}

function sameBusinessRequest(
  current: TenantCutoverOperationIdentity,
  request: TenantCutoverRequest,
): boolean {
  return (
    current.bindingSha256 === request.bindingSha256 &&
    current.businessConfigurationSha256 === request.businessConfigurationSha256
  );
}

function isExactRetry(
  current: TenantCutoverOperationIdentity,
  request: TenantCutoverRequest,
): boolean {
  return (
    sameBusinessRequest(current, request) &&
    request.fullConfigurationSha256 === current.fullConfigurationSha256
  );
}

function append(operationKind: TenantCutoverOperationKind): TenantCutoverDecision {
  return { action: 'append', operationKind, nonce: 'fresh' };
}

function assertRecoveryPredecessor(
  state: TenantCutoverState,
  request: TenantCutoverRequest,
  current: TenantCutoverOperationIdentity,
): void {
  const predecessor = state.recoveryPredecessor;
  if (!predecessor) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
  }
  if (
    predecessor.platformKind !== request.platformKind ||
    (state.platformKind && predecessor.platformKind !== state.platformKind)
  ) {
    throw new Error('TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED');
  }
  if (
    !current.predecessorOperationVersion ||
    predecessor.operationVersion !== current.predecessorOperationVersion ||
    !predecessor.bindingJcs ||
    !predecessor.fullConfigurationJcs ||
    !predecessor.bindingSha256 ||
    !predecessor.businessConfigurationSha256 ||
    !predecessor.fullConfigurationSha256 ||
    !predecessor.provenLive
  ) {
    throw new Error('TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE');
  }
}

export function decideTenantCutoverOperation(
  state: TenantCutoverState,
  request: TenantCutoverRequest,
): TenantCutoverDecision {
  if (state.platformKind && state.platformKind !== request.platformKind) {
    throw new Error('TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED');
  }

  const current = state.currentOperation;
  if (current && !current.provenLive) {
    if (current.kind === 'enforce') {
      if (request.command !== 'recover_runtime_after_enforce_failure') {
        throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED');
      }
      assertRecoveryPredecessor(state, request, current);
      return append('recover_runtime_after_enforce_failure');
    }

    const requestedKind = operationKindForCommand(request.command);
    if (
      RETRYABLE_UNPROVEN_KINDS.has(current.kind) &&
      requestedKind === current.kind &&
      isExactRetry(current, request)
    ) {
      return {
        action: 'retry_rollout',
        operationVersion: current.operationVersion,
        nonce: 'reuse',
      };
    }
    throw new Error('TENANT_CUTOVER_EXACT_RETRY_REQUIRED');
  }

  if (
    current?.provenLive &&
    LIVE_NOOP_KINDS[request.command].has(current.kind) &&
    sameBusinessRequest(current, request)
  ) {
    return { action: 'return_current', operationVersion: current.operationVersion };
  }

  if (request.command === 'recover_runtime_after_enforce_failure') {
    throw new Error('TENANT_CUTOVER_ENFORCE_RECOVERY_NOT_REQUIRED');
  }

  if (request.command === 'rollback_to_recorded_expand') {
    const recorded = state.recordedExpand;
    if (
      state.databaseState !== 'enforced' ||
      !recorded ||
      recorded.bindingSha256 !== request.bindingSha256 ||
      recorded.businessConfigurationSha256 !== request.businessConfigurationSha256
    ) {
      throw new Error('TENANT_CUTOVER_RECORDED_EXPAND_MISMATCH');
    }
    return append('rollback_to_recorded_expand');
  }

  const appendAllowed =
    (request.command === 'expand' && state.databaseState === 'legacy') ||
    (request.command === 'install_enforce' && state.databaseState === 'fresh') ||
    (request.command === 'enforce' &&
      (state.databaseState === 'expanded' || state.databaseState === 'enforced'));
  if (!appendAllowed) {
    throw new Error('TENANT_CUTOVER_STATE_INVALID');
  }

  return append(operationKindForCommand(request.command));
}
