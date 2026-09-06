import { createHash } from 'node:crypto';
import {
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  FIXED_ACTION_ADAPTER_MANIFESTS,
  type ActionAdapterDescriptorV1,
  type ActionGatewayEffect,
} from './actionAdapters.js';

export const ACTION_GATEWAY_POLICY_ID = 'action-gateway-mvp-v1';

export interface ActionGatewayPolicyInput {
  effectType: string;
  tool: string;
  destination: string;
}

export interface ActionGatewayPolicyDecision {
  effect: ActionGatewayEffect;
  decisionId: string;
  reasonCode: string;
  reason: string;
  policySnapshotId: typeof ACTION_GATEWAY_POLICY_ID;
}

type ActionGatewayPolicyDescriptor = Pick<
  ActionAdapterDescriptorV1,
  | 'schema'
  | 'adapterId'
  | 'adapterVersion'
  | 'effectType'
  | 'toolName'
  | 'compensationEffectType'
  | 'destinationPattern'
  | 'defaultGatewayEffect'
  | 'reversible'
> & {
  evidenceResponseSummaryKeys: string[];
  compensationPatchKeys: string[];
};

function manifestProjection(descriptor: ActionAdapterDescriptorV1): ActionGatewayPolicyDescriptor {
  return {
    schema: descriptor.schema,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    effectType: descriptor.effectType,
    toolName: descriptor.toolName,
    compensationEffectType: descriptor.compensationEffectType,
    destinationPattern: descriptor.destinationPattern,
    defaultGatewayEffect: descriptor.defaultGatewayEffect,
    reversible: descriptor.reversible,
    evidenceResponseSummaryKeys: [...descriptor.evidenceResponseSummaryKeys],
    compensationPatchKeys: [...(descriptor.compensationPatchKeys ?? [])],
  };
}

export function actionGatewayPolicySnapshot(): {
  policyId: typeof ACTION_GATEWAY_POLICY_ID;
  version: 1;
  descriptorDigest: string;
  descriptors: ActionGatewayPolicyDescriptor[];
} {
  const descriptors = FIXED_ACTION_ADAPTER_MANIFESTS.map(manifestProjection);
  const descriptorDigest = createHash('sha256')
    .update(JSON.stringify(descriptors), 'utf8')
    .digest('hex');
  return {
    policyId: ACTION_GATEWAY_POLICY_ID,
    version: 1,
    descriptorDigest,
    descriptors,
  };
}

export function evaluateActionGatewayPolicy(
  input: ActionGatewayPolicyInput,
): ActionGatewayPolicyDecision {
  const manifest = findAdapterManifest({
    effectType: input.effectType,
    toolName: input.tool,
    destination: input.destination,
  });
  if (manifest) {
    const effect = evaluateManifestGatewayEffect(manifest, input.destination);
    return {
      effect,
      decisionId: `action-gateway-manifest-${effect}`,
      reasonCode: 'REGISTERED_ADAPTER_POLICY',
      reason: `Registered adapter policy requires '${effect}' for this exact action.`,
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }

  const isDemoCreate = input.effectType === 'demo.ticket.create' && input.tool === 'ticket.create';
  const isDemoCompensation =
    input.effectType === 'compensate.demo.ticket.create' && input.tool === 'ticket.compensate';
  if (!isDemoCreate && !isDemoCompensation) {
    return {
      effect: 'deny',
      decisionId: 'action-gateway-deny',
      reasonCode: 'UNREGISTERED_EFFECT_TYPE',
      reason: `Effect type '${input.effectType}' is not registered by the Action Gateway.`,
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  if (input.destination === 'demo://tickets') {
    return {
      effect: 'allow',
      decisionId: 'action-gateway-allow',
      reasonCode: 'REGISTERED_DEMO_DESTINATION',
      reason: 'The registered demo ticket destination is allowed.',
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  if (input.destination === 'demo://tickets/approval') {
    return {
      effect: 'require_approval',
      decisionId: 'action-gateway-require_approval',
      reasonCode: 'DEMO_DESTINATION_REQUIRES_APPROVAL',
      reason: 'The approval demo destination requires a human decision.',
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  return {
    effect: 'deny',
    decisionId: 'action-gateway-deny',
    reasonCode: 'UNREGISTERED_DESTINATION',
    reason: `Destination '${input.destination}' is not registered by the Action Gateway.`,
    policySnapshotId: ACTION_GATEWAY_POLICY_ID,
  };
}
