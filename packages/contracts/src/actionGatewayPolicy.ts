import { createHash } from 'node:crypto';
import {
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  FIXED_ACTION_ADAPTER_MANIFESTS,
  ACTION_ADAPTER_DESTINATION_MATCHING,
  type ActionAdapterDescriptorV1,
  type ActionGatewayEffect,
} from './actionAdapters.js';

export const ACTION_GATEWAY_POLICY_ID = 'action-gateway-mvp-v1';

const authorizationSemantics = {
  algorithm: 'first-matching-adapter-then-demo-v1',
  adapterEffectMatching: 'exact-forward-or-compensation',
  adapterToolMatching: 'case-sensitive-exact',
  adapterDecision: 'descriptor-defaultGatewayEffect',
  destinationMatching: ACTION_ADAPTER_DESTINATION_MATCHING,
  demoActions: [
    { effectType: 'demo.ticket.create', tool: 'ticket.create' },
    { effectType: 'compensate.demo.ticket.create', tool: 'ticket.compensate' },
  ],
  demoDestinations: [
    {
      destination: 'demo://tickets',
      effect: 'allow',
      reasonCode: 'REGISTERED_DEMO_DESTINATION',
      reason: 'The registered demo ticket destination is allowed.',
    },
    {
      destination: 'demo://tickets/approval',
      effect: 'require_approval',
      reasonCode: 'DEMO_DESTINATION_REQUIRES_APPROVAL',
      reason: 'The approval demo destination requires a human decision.',
    },
  ],
  demoDestinationMatching: 'case-sensitive-exact',
  unregisteredEffect: 'deny',
  unregisteredDestination: 'deny',
} as const;

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
  authorizationSemantics: typeof authorizationSemantics;
} {
  const descriptors = FIXED_ACTION_ADAPTER_MANIFESTS.map(manifestProjection);
  const body = {
    policyId: ACTION_GATEWAY_POLICY_ID as typeof ACTION_GATEWAY_POLICY_ID,
    version: 1 as const,
    descriptors,
    authorizationSemantics: structuredClone(authorizationSemantics),
  };
  const descriptorDigest = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
  return {
    ...body,
    descriptorDigest,
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

  const isDemo = authorizationSemantics.demoActions.some(
    (action) => action.effectType === input.effectType && action.tool === input.tool,
  );
  if (!isDemo) {
    return {
      effect: authorizationSemantics.unregisteredEffect,
      decisionId: 'action-gateway-deny',
      reasonCode: 'UNREGISTERED_EFFECT_TYPE',
      reason: `Effect type '${input.effectType}' is not registered by the Action Gateway.`,
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  const demoDestination = authorizationSemantics.demoDestinations.find(
    (rule) => rule.destination === input.destination,
  );
  if (demoDestination) {
    return {
      effect: demoDestination.effect,
      decisionId: `action-gateway-${demoDestination.effect}`,
      reasonCode: demoDestination.reasonCode,
      reason: demoDestination.reason,
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  return {
    effect: authorizationSemantics.unregisteredDestination,
    decisionId: 'action-gateway-deny',
    reasonCode: 'UNREGISTERED_DESTINATION',
    reason: `Destination '${input.destination}' is not registered by the Action Gateway.`,
    policySnapshotId: ACTION_GATEWAY_POLICY_ID,
  };
}
