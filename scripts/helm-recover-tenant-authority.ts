#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';

export interface RecoveryRequest {
  namespace: string;
  release: string;
  values: string;
}

export interface LockedRecoveryArtifacts {
  chartPackage: string;
  valuesFile: string;
}

export interface HelmReleaseObjectIdentity {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
}

export interface HelmReleaseObjectProjection {
  identity: HelmReleaseObjectIdentity;
  comparator: Record<string, unknown> & { format: 'kubernetes-field-comparator/v1' };
  secretReferences: readonly HelmReleaseObjectIdentity[];
}

export interface HelmReleaseProjection {
  format: 'helm-release-projection/v1';
  namespace: string;
  releaseName: string;
  revision: string;
  chartContentSha256: string;
  objects: readonly HelmReleaseObjectProjection[];
  hooks: readonly {
    identity: HelmReleaseObjectIdentity;
    deletePolicies: readonly string[];
  }[];
  rendererInput: Record<string, unknown>;
}

export interface HelmRecoveryKubernetesPort {
  verifyCurrentObject(object: HelmReleaseObjectProjection): Promise<void>;
  readObject(identity: HelmReleaseObjectIdentity): Promise<
    | {
        uid: string;
        resourceVersion: string;
        ownerNamespace: string;
        ownerRelease: string;
      }
    | undefined
  >;
  deleteObject(
    identity: HelmReleaseObjectIdentity,
    preconditions: { uid: string; resourceVersion: string },
  ): Promise<void>;
}

function fail(code: string): never {
  throw new Error(code);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function identityKey(identity: HelmReleaseObjectIdentity): string {
  return JSON.stringify([identity.apiVersion, identity.kind, identity.namespace, identity.name]);
}

function canonicalKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertIdentity(identity: HelmReleaseObjectIdentity): void {
  if (
    !identity ||
    typeof identity !== 'object' ||
    !canonicalKeys(Object.keys(identity).sort(), ['apiVersion', 'kind', 'namespace', 'name']) ||
    !nonEmpty(identity.apiVersion) ||
    !nonEmpty(identity.kind) ||
    typeof identity.namespace !== 'string' ||
    !nonEmpty(identity.name)
  ) {
    fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
  }
}

function assertProjectionPair(input: {
  current: HelmReleaseProjection;
  failedTarget: HelmReleaseProjection;
}): void {
  const projections = [input.current, input.failedTarget];
  if (
    projections.some(
      (projection) =>
        !nonEmpty(projection.namespace) ||
        !nonEmpty(projection.releaseName) ||
        !/^[0-9a-f]{64}$/.test(projection.chartContentSha256) ||
        !Array.isArray(projection.objects) ||
        !Array.isArray(projection.hooks) ||
        !projection.rendererInput ||
        typeof projection.rendererInput !== 'object' ||
        Array.isArray(projection.rendererInput),
    ) ||
    input.current.format !== 'helm-release-projection/v1' ||
    input.failedTarget.format !== 'helm-release-projection/v1' ||
    input.current.namespace !== input.failedTarget.namespace ||
    input.current.releaseName !== input.failedTarget.releaseName ||
    !/^[1-9][0-9]*$/.test(input.current.revision) ||
    !/^[1-9][0-9]*$/.test(input.failedTarget.revision) ||
    BigInt(input.failedTarget.revision) <= BigInt(input.current.revision)
  ) {
    fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
  }
  for (const projection of projections) {
    const hooks = new Set<string>();
    for (const hook of projection.hooks) {
      if (
        !hook ||
        typeof hook !== 'object' ||
        !canonicalKeys(Object.keys(hook).sort(), ['identity', 'deletePolicies']) ||
        !Array.isArray(hook.deletePolicies) ||
        !hook.deletePolicies.every(nonEmpty)
      ) {
        fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
      }
      assertIdentity(hook.identity);
      const key = identityKey(hook.identity);
      if (hooks.has(key)) fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
      hooks.add(key);
    }
  }
}

function indexObjects(
  objects: readonly HelmReleaseObjectProjection[],
): Map<string, HelmReleaseObjectProjection> {
  const indexed = new Map<string, HelmReleaseObjectProjection>();
  for (const object of objects) {
    if (
      !object ||
      typeof object !== 'object' ||
      !canonicalKeys(Object.keys(object).sort(), ['identity', 'comparator', 'secretReferences']) ||
      !object.comparator ||
      object.comparator.format !== 'kubernetes-field-comparator/v1' ||
      !Array.isArray(object.secretReferences)
    ) {
      fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
    }
    assertIdentity(object.identity);
    const key = identityKey(object.identity);
    if (indexed.has(key)) fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
    indexed.set(key, object);
  }
  return indexed;
}

function targetOnlyObjects(input: {
  current: HelmReleaseProjection;
  failedTarget: HelmReleaseProjection;
}): HelmReleaseObjectProjection[] {
  assertProjectionPair(input);
  const current = indexObjects(input.current.objects);
  const target = indexObjects(input.failedTarget.objects);
  return [...target]
    .filter(([key]) => !current.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, object]) => object);
}

function currentReferences(projection: HelmReleaseProjection): Set<string> {
  const references = new Set<string>();
  for (const object of projection.objects) {
    for (const reference of object.secretReferences) {
      assertIdentity(reference);
      if (reference.kind !== 'Secret') {
        fail('TENANT_AUTHORITY_RECOVERY_PROJECTION_INVALID');
      }
      references.add(identityKey(reference));
    }
  }
  return references;
}

export async function cleanupFailedTargetOnlyObjects(
  input: { current: HelmReleaseProjection; failedTarget: HelmReleaseProjection },
  kubernetes: HelmRecoveryKubernetesPort,
): Promise<void> {
  const targetOnly = targetOnlyObjects(input);
  const references = currentReferences(input.current);
  for (const object of targetOnly) {
    if (references.has(identityKey(object.identity))) {
      fail('TENANT_AUTHORITY_RECOVERY_OBJECT_STILL_REFERENCED');
    }
    const live = await kubernetes.readObject(object.identity);
    if (!live) continue;
    if (
      live.ownerNamespace !== input.current.namespace ||
      live.ownerRelease !== input.current.releaseName
    ) {
      fail('TENANT_AUTHORITY_RECOVERY_OBJECT_OWNER_MISMATCH');
    }
    if (!nonEmpty(live.uid) || !nonEmpty(live.resourceVersion)) {
      fail('TENANT_AUTHORITY_RECOVERY_OBJECT_PRECONDITION_INVALID');
    }
    await kubernetes.deleteObject(object.identity, {
      uid: live.uid,
      resourceVersion: live.resourceVersion,
    });
    if (await kubernetes.readObject(object.identity)) {
      fail('TENANT_AUTHORITY_RECOVERY_TARGET_OBJECT_REMAINS');
    }
  }
}

export async function verifyRestoredReleaseProjection(
  input: { current: HelmReleaseProjection; failedTarget: HelmReleaseProjection },
  kubernetes: HelmRecoveryKubernetesPort,
): Promise<void> {
  assertProjectionPair(input);
  const currentObjects = [...indexObjects(input.current.objects)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, object]) => object);
  for (const object of currentObjects) await kubernetes.verifyCurrentObject(object);
  for (const object of targetOnlyObjects(input)) {
    if (await kubernetes.readObject(object.identity)) {
      fail('TENANT_AUTHORITY_RECOVERY_TARGET_OBJECT_REMAINS');
    }
  }
  for (const hook of input.failedTarget.hooks) {
    if (await kubernetes.readObject(hook.identity)) {
      fail('TENANT_AUTHORITY_RECOVERY_TARGET_OBJECT_REMAINS');
    }
  }
}

export function validateRecoveryRequest(value: Record<string, unknown>): RecoveryRequest {
  const allowed = new Set(['namespace', 'release', 'values']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('TENANT_AUTHORITY_RECOVERY_CALLER_OVERRIDE');
  }
  if (!nonEmpty(value.namespace) || !nonEmpty(value.release) || !nonEmpty(value.values)) {
    fail('TENANT_AUTHORITY_RECOVERY_ARGUMENT_INVALID');
  }
  return { namespace: value.namespace, release: value.release, values: value.values };
}

export function buildRecoveryHelmArgs(
  request: RecoveryRequest,
  locked: LockedRecoveryArtifacts,
): string[] {
  if (!nonEmpty(locked.chartPackage) || !nonEmpty(locked.valuesFile)) {
    fail('TENANT_AUTHORITY_RECOVERY_LOCKED_ARTIFACT_REQUIRED');
  }
  return [
    'upgrade',
    request.release,
    locked.chartPackage,
    '--namespace',
    request.namespace,
    '--values',
    locked.valuesFile,
    '--atomic',
    '--wait',
    '--wait-for-jobs',
    '--timeout',
    '10m',
  ];
}

function parseCli(args: string[]): RecoveryRequest {
  const value: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (!flag?.startsWith('--') || argument === undefined)
      fail('TENANT_AUTHORITY_RECOVERY_ARGUMENT_INVALID');
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (key in value) fail('TENANT_AUTHORITY_RECOVERY_ARGUMENT_INVALID');
    value[key] = argument;
  }
  return validateRecoveryRequest(value);
}

function main(): void {
  const request = parseCli(process.argv.slice(2));
  const locked = {
    chartPackage: process.env.COMMANDER_TENANT_AUTHORITY_LOCKED_CHART ?? '',
    valuesFile: process.env.COMMANDER_TENANT_AUTHORITY_LOCKED_VALUES ?? '',
  };
  execFileSync('helm', buildRecoveryHelmArgs(request, locked), { stdio: 'inherit' });
}

if (process.argv[1]?.endsWith('helm-recover-tenant-authority.ts')) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'TENANT_AUTHORITY_RECOVERY_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
