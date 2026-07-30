import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compensationGrantExpiresAt,
  sealGovernedCompensationAuthorization,
  validateGovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from './compensationAuthority.js';

const NOW = new Date('2026-07-29T10:00:00.000Z');

function authorityInput(
  overrides: Partial<GovernedCompensationAuthorizationInput> = {},
): GovernedCompensationAuthorizationInput {
  return {
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-1',
    requestId: 'request-1',
    tenantId: 'tenant-a',
    originalRunId: 'run-original',
    originalEffectId: 'effect-original',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-compensation',
    compensationStepId: 'step-compensation',
    compensationEffectId: 'effect-compensation',
    compensationEffectType: 'compensate.kubernetes.deployment.rollback',
    compensationRequest: {
      originalEffectId: 'effect-original',
      destination: 'k8s://cluster-a/default/deployments/api',
      forwardResponse: { originalRevision: '7' },
      compensationPatch: { targetRevision: '7', reason: 'rollback' },
    },
    idempotencyKey: 'cmp:effect-original:1.0.0',
    forwardReceipt: { originalRevision: '7' },
    adapterVersion: '1.0.0',
    policyDecisionId: 'decision-1',
    policySnapshotId: 'policy-42',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2026-07-29T11:00:00.000Z',
    approvalBinding: null,
    ...overrides,
  };
}

describe('governed compensation authority', () => {
  it('seals and validates every immutable hash and link', () => {
    const authority = sealGovernedCompensationAuthorization(authorityInput());
    const result = validateGovernedCompensationAuthorization(authority, NOW);

    assert.deepEqual(result, { valid: true, authorization: authority });
    assert.match(authority.forwardReceiptHash, /^[a-f0-9]{64}$/);
    assert.match(authority.requestHash, /^[a-f0-9]{64}$/);
    assert.match(authority.actionDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(authority.actionDigest, authority.requestHash);
  });

  it('rejects payload mutation, unknown fields, and cross-effect request replay', () => {
    const authority = sealGovernedCompensationAuthorization(authorityInput());
    const cases: Array<[string, unknown, string]> = [
      [
        'patch mutation',
        {
          ...authority,
          compensationRequest: {
            ...authority.compensationRequest,
            compensationPatch: { targetRevision: '8', reason: 'mutated' },
          },
        },
        'COMPENSATION_REQUEST_HASH_MISMATCH',
      ],
      [
        'receipt mutation',
        { ...authority, forwardReceipt: { originalRevision: '8' } },
        'COMPENSATION_FORWARD_RECEIPT_HASH_MISMATCH',
      ],
      [
        'cross effect',
        {
          ...authority,
          compensationRequest: {
            ...authority.compensationRequest,
            originalEffectId: 'effect-other',
          },
        },
        'COMPENSATION_ORIGINAL_EFFECT_MISMATCH',
      ],
      [
        'unknown field',
        { ...authority, callerPolicyOverride: 'permit-all' },
        'COMPENSATION_AUTHORIZATION_UNKNOWN_FIELD',
      ],
    ];

    for (const [label, candidate, code] of cases) {
      assert.deepEqual(
        validateGovernedCompensationAuthorization(candidate, NOW),
        {
          valid: false,
          code,
        },
        label,
      );
    }
  });

  it('enforces allow/approval bindings and authorization expiry', () => {
    const allowWithApproval = sealGovernedCompensationAuthorization(
      authorityInput({
        approvalBinding: {
          approvalId: 'approval-1',
          approverPrincipalId: 'user-1',
          actionDigest: 'will-be-sealed',
          policySnapshotId: 'policy-42',
          expiresAt: '2026-07-29T11:00:00.000Z',
        },
      }),
    );
    assert.deepEqual(validateGovernedCompensationAuthorization(allowWithApproval, NOW), {
      valid: false,
      code: 'COMPENSATION_APPROVAL_UNEXPECTED',
    });

    const required = sealGovernedCompensationAuthorization(
      authorityInput({
        decisionEffect: 'require_approval',
        approvalBinding: {
          approvalId: 'approval-1',
          approverPrincipalId: 'user-1',
          actionDigest: 'will-be-sealed',
          policySnapshotId: 'policy-42',
          expiresAt: '2026-07-29T11:00:00.000Z',
        },
      }),
    );
    assert.deepEqual(validateGovernedCompensationAuthorization(required, NOW), {
      valid: true,
      authorization: required,
    });

    const expired = sealGovernedCompensationAuthorization(
      authorityInput({ authorizationExpiresAt: NOW.toISOString() }),
    );
    assert.deepEqual(validateGovernedCompensationAuthorization(expired, NOW), {
      valid: false,
      code: 'COMPENSATION_AUTHORIZATION_EXPIRED',
    });
  });

  it('caps capability expiry at the persisted authorization deadline', () => {
    const authority = sealGovernedCompensationAuthorization(authorityInput());
    assert.equal(
      compensationGrantExpiresAt(authority, NOW, 30 * 60_000),
      '2026-07-29T10:30:00.000Z',
    );
    assert.equal(
      compensationGrantExpiresAt(authority, NOW, 2 * 60 * 60_000),
      authority.authorizationExpiresAt,
    );
    assert.throws(
      () => compensationGrantExpiresAt(authority, NOW, 0),
      /capabilityTtlMs must be a positive integer/,
    );
  });
});
