import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    assert.deepEqual(snapshot.descriptors, descriptors);
    assert.equal(snapshot.policyId, ACTION_GATEWAY_POLICY_ID);
    assert.equal(snapshot.version, 1);
    assert.notEqual(
      snapshot.descriptorDigest,
      createHash('sha256').update(JSON.stringify(descriptors)).digest('hex'),
    );
    assert.deepEqual(snapshot.authorizationSemantics.demoActions, [
      { effectType: 'demo.ticket.create', tool: 'ticket.create' },
      { effectType: 'compensate.demo.ticket.create', tool: 'ticket.compensate' },
    ]);
    assert.equal(
      snapshot.authorizationSemantics.destinationMatching.placeholderPattern,
      '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    );
    assert.equal(snapshot.authorizationSemantics.unregisteredEffect, 'deny');
    const { descriptorDigest, ...body } = snapshot;
    assert.equal(descriptorDigest, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.equal(descriptorDigest, '43fdfddd96ab33f531305da197df3659a1372619bb0a2cd1930a5196d3bea25c');
  });

  it('characterizes exact effect/tool and destination matching including demo compensation', () => {
    const base = {
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
    };
    for (const destination of ['k8s://cluster/ns/deployments/api', 'k8s://C_1/n.s/deployments/a-b'])
      assert.equal(
        evaluateActionGatewayPolicy({ ...base, destination }).effect,
        'require_approval',
      );
    for (const destination of [
      'k8s://cluster//deployments/api',
      'k8s://cluster/ns/deployments/api/extra',
      'k8s://cluster/ns/deployments/api?x',
      'K8s://cluster/ns/deployments/api',
      'k8s://cluster/ns/deployments/%61pi',
      'k8s://cluster/ns/deployments/-api',
      'k8s://cluster/ns/deployments/äpi',
    ])
      assert.equal(evaluateActionGatewayPolicy({ ...base, destination }).effect, 'deny');
    assert.equal(
      evaluateActionGatewayPolicy({
        ...base,
        tool: 'Kubernetes.deployment.rollback',
        destination: 'k8s://cluster/ns/deployments/api',
      }).effect,
      'deny',
    );
    for (const [destination, expected] of [
      ['demo://tickets', 'allow'],
      ['demo://tickets/approval', 'require_approval'],
      ['demo://tickets/unknown', 'deny'],
    ])
      assert.equal(
        evaluateActionGatewayPolicy({
          effectType: 'compensate.demo.ticket.create',
          tool: 'ticket.compensate',
          destination: destination!,
        }).effect,
        expected,
      );
  });
});
