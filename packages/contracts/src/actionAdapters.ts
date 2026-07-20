import { createHash } from 'node:crypto';

export type ActionGatewayEffect = 'allow' | 'deny' | 'require_approval';

export interface ActionAdapterDescriptorV1 {
  schema: 'commander.action-adapter/v1';
  adapterId: string;
  adapterVersion: string;
  effectType: string;
  toolName: string;
  compensationEffectType: string;
  destinationPattern: string;
  defaultGatewayEffect: ActionGatewayEffect;
  reversible: boolean;
  evidenceResponseSummaryKeys: readonly string[];
  compensationPatchKeys?: readonly string[];
}

export const GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR: ActionAdapterDescriptorV1 = {
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
};

export const SERVICENOW_INCIDENT_CREATE_DESCRIPTOR: ActionAdapterDescriptorV1 = {
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
};

export const FIXED_ACTION_ADAPTER_MANIFESTS: readonly ActionAdapterDescriptorV1[] = [
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
];

function destinationMatchesPattern(pattern: string, destination: string): boolean {
  const patternParts = pattern.split('/');
  const destinationParts = destination.split('/');
  if (patternParts.length !== destinationParts.length) return false;
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i]!;
    const d = destinationParts[i]!;
    if (p.startsWith('{') && p.endsWith('}')) {
      if (!d || d.includes('/') || d.includes(':') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d)) {
        return false;
      }
      continue;
    }
    if (p !== d) return false;
  }
  return true;
}

export function findAdapterManifest(input: {
  effectType: string;
  toolName: string;
  destination: string;
}): ActionAdapterDescriptorV1 | null {
  for (const manifest of FIXED_ACTION_ADAPTER_MANIFESTS) {
    if (manifest.effectType !== input.effectType) continue;
    if (manifest.toolName !== input.toolName) continue;
    if (!destinationMatchesPattern(manifest.destinationPattern, input.destination)) continue;
    return manifest;
  }
  return null;
}

export function evaluateManifestGatewayEffect(
  manifest: ActionAdapterDescriptorV1,
  destination: string,
): ActionGatewayEffect {
  if (!destinationMatchesPattern(manifest.destinationPattern, destination)) {
    return 'deny';
  }
  return manifest.defaultGatewayEffect;
}

export function commanderActionMarker(tenantId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${tenantId}\0${idempotencyKey}`).digest('hex');
}

export function githubPrBodyMarker(tenantId: string, idempotencyKey: string): string {
  return `<!-- commander-action:${commanderActionMarker(tenantId, idempotencyKey)} -->`;
}

export function servicenowCorrelationId(tenantId: string, idempotencyKey: string): string {
  return `commander:${commanderActionMarker(tenantId, idempotencyKey)}`;
}

export function compensationIdempotencyKey(originalEffectId: string, adapterVersion: string): string {
  return `cmp:${originalEffectId}:${adapterVersion}`;
}
