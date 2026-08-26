import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadAll } from 'js-yaml';

type Manifest = {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  rules?: Array<{
    apiGroups?: string[];
    resources?: string[];
    resourceNames?: string[];
    verbs?: string[];
  }>;
  subjects?: Array<{ kind?: string; name?: string; namespace?: string }>;
};

function render(): Manifest[] {
  const yaml = execFileSync(
    'helm',
    [
      'template',
      'release-a',
      'deploy/helm/commander',
      '--namespace',
      'commander',
      '-f',
      'deploy/helm/commander/values-enterprise.yaml',
      '--set',
      'networkPolicy.migrationOperator.subject=system:serviceaccount:commander-ops:migration-operator',
      '--set',
      'tenantAuthority.proofOwnerSecret=release-a-proof-owner-r1',
      '--set',
      'tenantAuthority.releaseProjectionConfigMap=release-a-release-projection-r1',
      '--set',
      'tenantAuthority.bootstrapAuthoritySecret=release-a-bootstrap-authority',
    ],
    { encoding: 'utf8' },
  );
  return yaml
    .split(/^---\s*$/m)
    .filter((document) => document.includes('tenant-authority-prerequisite-operator-rbac.yaml'))
    .flatMap((document) => loadAll(document))
    .filter((value): value is Manifest => Boolean(value && typeof value === 'object'));
}

function resource(manifests: Manifest[], kind: string, name: string, namespace?: string): Manifest {
  const match = manifests.find(
    (item) =>
      item.kind === kind &&
      item.metadata?.name === name &&
      (namespace === undefined || item.metadata.namespace === namespace),
  );
  assert.ok(match, `${kind}/${namespace ?? ''}/${name} missing`);
  return match;
}

describe('Task 1 prerequisite operator RBAC', () => {
  it('renders the exact least-privilege operator identity and permission tuples', () => {
    const manifests = render();
    resource(manifests, 'ServiceAccount', 'migration-operator', 'commander-ops');
    const suffix = createHash('sha256').update('commander/release-a').digest('hex').slice(0, 16);
    const policyNames = [
      `commander-tenant-authority-policy-guard-${suffix}`,
      `commander-tenant-authority-guard-${suffix}`,
    ];
    const clusterRole = resource(
      manifests,
      'ClusterRole',
      'release-a-tenant-prerequisite-operator',
    );
    assert.deepEqual(clusterRole.rules, [
      {
        apiGroups: ['authorization.k8s.io'],
        resources: ['selfsubjectaccessreviews'],
        verbs: ['create'],
      },
      {
        apiGroups: ['admissionregistration.k8s.io'],
        resources: ['validatingadmissionpolicies', 'validatingadmissionpolicybindings'],
        resourceNames: policyNames,
        verbs: ['get'],
      },
    ]);

    const role = resource(manifests, 'Role', 'release-a-tenant-prerequisite-operator', 'commander');
    assert.deepEqual(role.rules, [
      {
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: ['commander-api-proof-public'],
        verbs: ['get'],
      },
      {
        apiGroups: [''],
        resources: ['services'],
        resourceNames: ['release-a-api-proof'],
        verbs: ['get'],
      },
      {
        apiGroups: ['networking.k8s.io'],
        resources: ['networkpolicies'],
        verbs: ['create', 'get', 'list'],
      },
      { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: ['get', 'list'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
    ]);

    for (const candidate of manifests.filter(
      (item) =>
        ['Role', 'ClusterRole'].includes(item.kind ?? '') &&
        item.metadata?.name?.includes('tenant-prerequisite-operator'),
    )) {
      for (const rule of candidate.rules ?? []) {
        assert.ok(!(rule.apiGroups ?? []).includes('*'));
        assert.ok(!(rule.resources ?? []).includes('*'));
        assert.ok(!(rule.verbs ?? []).includes('*'));
        assert.ok(
          (rule.verbs ?? []).every(
            (verb) =>
              !['watch', 'update', 'patch', 'delete', 'deletecollection', 'impersonate'].includes(
                verb,
              ),
          ),
        );
        assert.ok(
          (rule.resources ?? []).every(
            (value) => !['pods/exec', 'pods/attach', 'pods/log'].includes(value),
          ),
        );
      }
    }

    for (const bindingKind of ['ClusterRoleBinding', 'RoleBinding']) {
      const binding = resource(manifests, bindingKind, 'release-a-tenant-prerequisite-operator');
      assert.deepEqual(binding.subjects, [
        { kind: 'ServiceAccount', name: 'migration-operator', namespace: 'commander-ops' },
      ]);
    }
  });
});
