import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecoveryHelmArgs,
  cleanupFailedTargetOnlyObjects,
  verifyRestoredReleaseProjection,
  validateRecoveryRequest,
  type HelmRecoveryKubernetesPort,
  type HelmReleaseObjectIdentity,
  type HelmReleaseProjection,
} from './helm-recover-tenant-authority.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

function identity(kind: string, name: string): HelmReleaseObjectIdentity {
  return { apiVersion: kind === 'Secret' ? 'v1' : 'apps/v1', kind, namespace: 'commander', name };
}

function projection(
  revision: string,
  objects: Array<{
    identity: HelmReleaseObjectIdentity;
    secretReferences?: readonly HelmReleaseObjectIdentity[];
  }>,
  hooks: HelmReleaseObjectIdentity[] = [],
): HelmReleaseProjection {
  return {
    format: 'helm-release-projection/v1',
    namespace: 'commander',
    releaseName: 'prod',
    revision,
    chartContentSha256: digest(revision),
    objects: objects.map((object) => ({
      identity: object.identity,
      comparator:
        object.identity.kind === 'Secret'
          ? {
              format: 'kubernetes-field-comparator/v1',
              metadata: { name: object.identity.name, namespace: object.identity.namespace },
              type: 'Opaque',
              immutable: true,
              dataKeys: ['url'],
            }
          : {
              format: 'kubernetes-field-comparator/v1',
              desired: { metadata: { name: object.identity.name } },
            },
      secretReferences: object.secretReferences ?? [],
    })),
    hooks: hooks.map((hook) => ({ identity: hook, deletePolicies: ['hook-succeeded'] })),
    rendererInput: {
      format: 'helm-renderer-input-projection/v1',
      secretReferences: [],
    },
  };
}

function kubernetesPort(
  existing: ReadonlyMap<
    string,
    { uid: string; resourceVersion: string; ownerNamespace: string; ownerRelease: string }
  >,
) {
  const deleted: Array<{
    identity: HelmReleaseObjectIdentity;
    uid: string;
    resourceVersion: string;
  }> = [];
  const verified: string[] = [];
  const absent = new Set<string>();
  const key = (value: HelmReleaseObjectIdentity) => JSON.stringify(value);
  const port: HelmRecoveryKubernetesPort = {
    verifyCurrentObject: async (object) => {
      verified.push(key(object.identity));
    },
    readObject: async (objectIdentity) => {
      if (absent.has(key(objectIdentity))) return undefined;
      return existing.get(key(objectIdentity));
    },
    deleteObject: async (objectIdentity, preconditions) => {
      deleted.push({ identity: objectIdentity, ...preconditions });
      absent.add(key(objectIdentity));
    },
  };
  return { port, deleted, verified, absent, key };
}

describe('Helm tenant-authority recovery controller', () => {
  it('accepts only namespace, release, and mounted values input', () => {
    assert.deepEqual(
      validateRecoveryRequest({
        namespace: 'commander',
        release: 'prod',
        values: '/mounted/values.yaml',
      }),
      { namespace: 'commander', release: 'prod', values: '/mounted/values.yaml' },
    );
    assert.throws(
      () =>
        validateRecoveryRequest({
          namespace: 'commander',
          release: 'prod',
          values: '/mounted/values.yaml',
          phase: 'expand',
        }),
      /TENANT_AUTHORITY_RECOVERY_CALLER_OVERRIDE/,
    );
  });

  it('uses only the retained chart and locked recovery values with atomic wait flags', () => {
    assert.deepEqual(
      buildRecoveryHelmArgs(
        {
          namespace: 'commander',
          release: 'prod',
          values: '/mounted/ignored.yaml',
        },
        {
          chartPackage: '/locked/proven-expand.tgz',
          valuesFile: '/locked/recovery-values.yaml',
        },
      ),
      [
        'upgrade',
        'prod',
        '/locked/proven-expand.tgz',
        '--namespace',
        'commander',
        '--values',
        '/locked/recovery-values.yaml',
        '--atomic',
        '--wait',
        '--wait-for-jobs',
        '--timeout',
        '10m',
      ],
    );
  });

  it('deletes only failed-target-only identities with exact Helm ownership and optimistic guards', async () => {
    const deployment = identity('Deployment', 'prod-api');
    const oldSecret = identity('Secret', 'prod-old');
    const oldRole = { ...identity('Role', 'prod-old'), apiVersion: 'rbac.authorization.k8s.io/v1' };
    const oldHook = identity('Job', 'prod-old-hook');
    const current = projection('7', [{ identity: deployment }]);
    const failedTarget = projection(
      '9',
      [{ identity: deployment }, { identity: oldSecret }, { identity: oldRole }],
      [oldHook],
    );
    const fixture = kubernetesPort(
      new Map([
        [
          JSON.stringify(oldSecret),
          {
            uid: 'secret-uid',
            resourceVersion: '41',
            ownerNamespace: 'commander',
            ownerRelease: 'prod',
          },
        ],
        [
          JSON.stringify(oldRole),
          {
            uid: 'role-uid',
            resourceVersion: '42',
            ownerNamespace: 'commander',
            ownerRelease: 'prod',
          },
        ],
      ]),
    );

    await cleanupFailedTargetOnlyObjects({ current, failedTarget }, fixture.port);
    assert.deepEqual(fixture.deleted, [
      { identity: oldRole, uid: 'role-uid', resourceVersion: '42' },
      { identity: oldSecret, uid: 'secret-uid', resourceVersion: '41' },
    ]);
    await verifyRestoredReleaseProjection({ current, failedTarget }, fixture.port);
    assert.deepEqual(fixture.verified, [JSON.stringify(deployment)]);
  });

  it('refuses target-only deletion on owner mismatch or a current Secret reference', async () => {
    const deployment = identity('Deployment', 'prod-api');
    const oldSecret = identity('Secret', 'prod-old');
    const failedTarget = projection('9', [{ identity: deployment }, { identity: oldSecret }]);

    const wrongOwner = kubernetesPort(
      new Map([
        [
          JSON.stringify(oldSecret),
          {
            uid: 'old-uid',
            resourceVersion: '11',
            ownerNamespace: 'other',
            ownerRelease: 'prod',
          },
        ],
      ]),
    );
    await assert.rejects(
      () =>
        cleanupFailedTargetOnlyObjects(
          {
            current: projection('7', [{ identity: deployment }]),
            failedTarget,
          },
          wrongOwner.port,
        ),
      /TENANT_AUTHORITY_RECOVERY_OBJECT_OWNER_MISMATCH/,
    );
    assert.equal(wrongOwner.deleted.length, 0);

    const referenced = kubernetesPort(
      new Map([
        [
          JSON.stringify(oldSecret),
          {
            uid: 'old-uid',
            resourceVersion: '11',
            ownerNamespace: 'commander',
            ownerRelease: 'prod',
          },
        ],
      ]),
    );
    await assert.rejects(
      () =>
        cleanupFailedTargetOnlyObjects(
          {
            current: projection('7', [{ identity: deployment, secretReferences: [oldSecret] }]),
            failedTarget,
          },
          referenced.port,
        ),
      /TENANT_AUTHORITY_RECOVERY_OBJECT_STILL_REFERENCED/,
    );
    assert.equal(referenced.deleted.length, 0);
  });

  it('fails verification when a target-only identity or hook survivor remains', async () => {
    const deployment = identity('Deployment', 'prod-api');
    const oldSecret = identity('Secret', 'prod-old');
    const oldHook = identity('Job', 'prod-old-hook');
    const current = projection('7', [{ identity: deployment }]);
    const failedTarget = projection(
      '9',
      [{ identity: deployment }, { identity: oldSecret }],
      [oldHook],
    );
    const fixture = kubernetesPort(
      new Map([
        [
          JSON.stringify(oldHook),
          {
            uid: 'hook-uid',
            resourceVersion: '19',
            ownerNamespace: 'commander',
            ownerRelease: 'prod',
          },
        ],
      ]),
    );

    await assert.rejects(
      () => verifyRestoredReleaseProjection({ current, failedTarget }, fixture.port),
      /TENANT_AUTHORITY_RECOVERY_TARGET_OBJECT_REMAINS/,
    );
  });
});
