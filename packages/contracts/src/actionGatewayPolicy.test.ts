import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_GATEWAY_POLICY_ID,
  actionGatewayPolicySnapshot,
  evaluateActionGatewayPolicy,
} from './actionGatewayPolicy.js';

describe('action gateway policy contracts', () => {
  it('returns the registered Kubernetes rollback decision for forward and compensation effects', () => {
    for (const effectType of [
      'connector.kubernetes.deployment.rollback',
      'compensate.kubernetes.deployment.rollback',
    ]) {
      assert.deepEqual(
        evaluateActionGatewayPolicy({
          effectType,
          tool: 'kubernetes.deployment.rollback',
          destination: 'k8s://kind/commander/deployments/api',
        }),
        {
          effect: 'require_approval',
          decisionId: 'action-gateway-manifest-require_approval',
          reasonCode: 'REGISTERED_ADAPTER_POLICY',
          reason: "Registered adapter policy requires 'require_approval' for this exact action.",
          policySnapshotId: ACTION_GATEWAY_POLICY_ID,
        },
      );
    }
  });

  it('preserves every demo decision with stable identifiers and reason codes', () => {
    const cases = [
      {
        destination: 'demo://tickets',
        effect: 'allow',
        decisionId: 'action-gateway-allow',
        reasonCode: 'REGISTERED_DEMO_DESTINATION',
        reason: 'The registered demo ticket destination is allowed.',
      },
      {
        destination: 'demo://tickets/approval',
        effect: 'require_approval',
        decisionId: 'action-gateway-require_approval',
        reasonCode: 'DEMO_DESTINATION_REQUIRES_APPROVAL',
        reason: 'The approval demo destination requires a human decision.',
      },
      {
        destination: 'demo://tickets/unregistered',
        effect: 'deny',
        decisionId: 'action-gateway-deny',
        reasonCode: 'UNREGISTERED_DESTINATION',
        reason:
          "Destination 'demo://tickets/unregistered' is not registered by the Action Gateway.",
      },
    ] as const;

    for (const expected of cases) {
      const { destination, ...decision } = expected;
      assert.deepEqual(
        evaluateActionGatewayPolicy({
          effectType: 'demo.ticket.create',
          tool: 'ticket.create',
          destination,
        }),
        { ...decision, policySnapshotId: ACTION_GATEWAY_POLICY_ID },
      );
    }
  });

  it('fails closed for malformed registered and unregistered actions', () => {
    assert.deepEqual(
      evaluateActionGatewayPolicy({
        effectType: 'connector.kubernetes.deployment.rollback',
        tool: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/other%2Ftenant/deployments/api',
      }),
      {
        effect: 'deny',
        decisionId: 'action-gateway-deny',
        reasonCode: 'UNREGISTERED_EFFECT_TYPE',
        reason:
          "Effect type 'connector.kubernetes.deployment.rollback' is not registered by the Action Gateway.",
        policySnapshotId: ACTION_GATEWAY_POLICY_ID,
      },
    );
    assert.deepEqual(
      evaluateActionGatewayPolicy({
        effectType: 'connector.unknown.write',
        tool: 'unknown.write',
        destination: 'unknown://target',
      }),
      {
        effect: 'deny',
        decisionId: 'action-gateway-deny',
        reasonCode: 'UNREGISTERED_EFFECT_TYPE',
        reason: "Effect type 'connector.unknown.write' is not registered by the Action Gateway.",
        policySnapshotId: ACTION_GATEWAY_POLICY_ID,
      },
    );
  });

  it('pins the fixed manifest projection and descriptor digest', () => {
    const snapshot = actionGatewayPolicySnapshot();
    const descriptors = [
      {
        schema: 'commander.action-adapter/v1',
        adapterId: 'github.pull-request.create',
        adapterVersion: '1.0.0',
        effectType: 'connector.github.pull-request.create',
        toolName: 'github.pull-request.create',
        compensationEffectType: 'compensate.github.pull-request.create',
        destinationPattern: 'github://{owner}/{repo}/pulls',
        defaultGatewayEffect: 'require_approval',
        reversible: true,
        evidenceResponseSummaryKeys: ['prNumber', 'url', 'state', 'httpStatus', 'errorCode'],
        compensationPatchKeys: [],
      },
      {
        schema: 'commander.action-adapter/v1',
        adapterId: 'servicenow.incident.create',
        adapterVersion: '1.0.0',
        effectType: 'connector.servicenow.incident.create',
        toolName: 'servicenow.incident.create',
        compensationEffectType: 'compensate.servicenow.incident.create',
        destinationPattern: 'servicenow://{instance}/incident',
        defaultGatewayEffect: 'require_approval',
        reversible: true,
        evidenceResponseSummaryKeys: ['sysId', 'number', 'state', 'httpStatus', 'errorCode'],
        compensationPatchKeys: ['state', 'close_code', 'close_notes'],
      },
      {
        schema: 'commander.action-adapter/v1',
        adapterId: 'kubernetes.deployment.rollback',
        adapterVersion: '1.0.0',
        effectType: 'connector.kubernetes.deployment.rollback',
        toolName: 'kubernetes.deployment.rollback',
        compensationEffectType: 'compensate.kubernetes.deployment.rollback',
        destinationPattern: 'k8s://{cluster}/{namespace}/deployments/{name}',
        defaultGatewayEffect: 'require_approval',
        reversible: true,
        evidenceResponseSummaryKeys: [
          'deployment',
          'namespace',
          'revision',
          'status',
          'httpStatus',
          'errorCode',
        ],
        compensationPatchKeys: ['targetRevision', 'reason'],
      },
    ];
    assert.deepEqual(snapshot, {
      policyId: ACTION_GATEWAY_POLICY_ID,
      version: 1,
      descriptorDigest: 'd2d34ea6f3bf537b42343c328e8a26b1e522208875dd812b28b585d3ffe24761',
      descriptors,
    });
  });
});
