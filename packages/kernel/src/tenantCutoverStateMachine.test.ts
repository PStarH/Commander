import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideTenantCutoverOperation,
  type TenantCutoverState,
} from './tenantCutoverStateMachine.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

function enforcedState(
  overrides: Partial<NonNullable<TenantCutoverState['currentOperation']>> = {},
): TenantCutoverState {
  return {
    databaseState: 'enforced',
    platformKind: 'compose',
    currentOperation: {
      operationVersion: '7',
      predecessorOperationVersion: '6',
      kind: 'enforce',
      runtimePhase: 'enforce',
      bindingSha256: digest('a'),
      businessConfigurationSha256: digest('b'),
      fullConfigurationSha256: digest('c'),
      provenLive: true,
      ...overrides,
    },
    recoveryPredecessor: {
      operationVersion: '6',
      platformKind: 'compose',
      runtimePhase: 'expand',
      bindingSha256: digest('6'),
      businessConfigurationSha256: digest('7'),
      fullConfigurationSha256: digest('8'),
      bindingJcs: '{"kind":"compose"}',
      fullConfigurationJcs: '{"operationAuditNonce":"previous"}',
      provenLive: true,
    },
    recordedExpand: {
      bindingSha256: digest('d'),
      businessConfigurationSha256: digest('e'),
      fullConfigurationSha256: digest('f'),
    },
  };
}

describe('tenant cutover operation decision', () => {
  it('returns current only for a command-compatible proven-live operation kind', () => {
    const request = {
      command: 'enforce' as const,
      platformKind: 'compose' as const,
      bindingSha256: digest('a'),
      businessConfigurationSha256: digest('b'),
    };

    assert.deepEqual(decideTenantCutoverOperation(enforcedState(), request), {
      action: 'return_current',
      operationVersion: '7',
    });

    const recovered = enforcedState({
      kind: 'recover_runtime_after_enforce_failure',
    });
    assert.deepEqual(decideTenantCutoverOperation(recovered, request), {
      action: 'append',
      operationKind: 'enforce',
      nonce: 'fresh',
    });
  });

  it('requires explicit recovery for an unproven enforce operation', () => {
    const state = enforcedState({ provenLive: false });
    const request = {
      command: 'enforce' as const,
      platformKind: 'compose' as const,
      bindingSha256: digest('a'),
      businessConfigurationSha256: digest('b'),
      fullConfigurationSha256: digest('c'),
    };

    assert.throws(
      () => decideTenantCutoverOperation(state, request),
      /TENANT_CUTOVER_ENFORCE_RECOVERY_REQUIRED/,
    );
    assert.deepEqual(
      decideTenantCutoverOperation(state, {
        ...request,
        command: 'recover_runtime_after_enforce_failure',
      }),
      {
        action: 'append',
        operationKind: 'recover_runtime_after_enforce_failure',
        nonce: 'fresh',
      },
    );
  });

  it('requires complete same-platform evidence for the immediate proven predecessor', () => {
    const request = {
      command: 'recover_runtime_after_enforce_failure' as const,
      platformKind: 'compose' as const,
      bindingSha256: digest('a'),
      businessConfigurationSha256: digest('b'),
      fullConfigurationSha256: digest('c'),
    };
    const currentOperation = enforcedState({ provenLive: false }).currentOperation;

    assert.throws(
      () =>
        decideTenantCutoverOperation(
          {
            databaseState: 'enforced',
            platformKind: 'compose',
            currentOperation,
          },
          request,
        ),
      /TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED/,
    );
    assert.throws(
      () =>
        decideTenantCutoverOperation(
          {
            ...enforcedState({ provenLive: false }),
            recoveryPredecessor: {
              ...enforcedState().recoveryPredecessor!,
              fullConfigurationJcs: '',
            },
          },
          request,
        ),
      /TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE/,
    );
    assert.throws(
      () =>
        decideTenantCutoverOperation(
          {
            ...enforcedState({ provenLive: false }),
            recoveryPredecessor: {
              ...enforcedState().recoveryPredecessor!,
              operationVersion: '5',
            },
          },
          request,
        ),
      /TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE/,
    );
    assert.throws(
      () =>
        decideTenantCutoverOperation(
          {
            ...enforcedState({ provenLive: false }),
            recoveryPredecessor: {
              ...enforcedState().recoveryPredecessor!,
              platformKind: 'helm',
            },
          },
          request,
        ),
      /TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED/,
    );
  });

  it('retries only an exact unproven recovery or rollback full configuration', () => {
    const state = enforcedState({
      kind: 'recover_runtime_after_enforce_failure',
      provenLive: false,
    });
    const exact = {
      command: 'recover_runtime_after_enforce_failure' as const,
      platformKind: 'compose' as const,
      bindingSha256: digest('a'),
      businessConfigurationSha256: digest('b'),
      fullConfigurationSha256: digest('c'),
    };

    assert.deepEqual(decideTenantCutoverOperation(state, exact), {
      action: 'retry_rollout',
      operationVersion: '7',
      nonce: 'reuse',
    });
    assert.throws(
      () =>
        decideTenantCutoverOperation(state, {
          ...exact,
          fullConfigurationSha256: digest('9'),
        }),
      /TENANT_CUTOVER_EXACT_RETRY_REQUIRED/,
    );
  });

  it('creates rollback from recorded business configuration with a fresh nonce', () => {
    const state = enforcedState();
    const decision = decideTenantCutoverOperation(state, {
      command: 'rollback_to_recorded_expand',
      platformKind: 'compose',
      bindingSha256: digest('d'),
      businessConfigurationSha256: digest('e'),
    });

    assert.deepEqual(decision, {
      action: 'append',
      operationKind: 'rollback_to_recorded_expand',
      nonce: 'fresh',
    });
    assert.throws(
      () =>
        decideTenantCutoverOperation(state, {
          command: 'rollback_to_recorded_expand',
          platformKind: 'compose',
          bindingSha256: digest('d'),
          businessConfigurationSha256: digest('0'),
        }),
      /TENANT_CUTOVER_RECORDED_EXPAND_MISMATCH/,
    );
  });

  it('rejects cross-platform resume before choosing an operation', () => {
    assert.throws(
      () =>
        decideTenantCutoverOperation(enforcedState(), {
          command: 'enforce',
          platformKind: 'helm',
          bindingSha256: digest('a'),
          businessConfigurationSha256: digest('b'),
        }),
      /TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED/,
    );
  });

  it('rejects commands outside the closed database-state transition table', () => {
    assert.throws(
      () =>
        decideTenantCutoverOperation(
          { databaseState: 'legacy', platformKind: 'compose' },
          {
            command: 'enforce',
            platformKind: 'compose',
            bindingSha256: digest('a'),
            businessConfigurationSha256: digest('b'),
          },
        ),
      /TENANT_CUTOVER_STATE_INVALID/,
    );

    assert.throws(
      () =>
        decideTenantCutoverOperation(enforcedState({ runtimePhase: 'expand' }), {
          command: 'expand',
          platformKind: 'compose',
          bindingSha256: digest('9'),
          businessConfigurationSha256: digest('8'),
        }),
      /TENANT_CUTOVER_STATE_INVALID/,
    );

    assert.throws(
      () =>
        decideTenantCutoverOperation(
          { databaseState: 'fresh', platformKind: 'compose' },
          {
            command: 'expand',
            platformKind: 'compose',
            bindingSha256: digest('a'),
            businessConfigurationSha256: digest('b'),
          },
        ),
      /TENANT_CUTOVER_STATE_INVALID/,
    );
  });
});
