import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { load, loadAll } from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kubernetesEnvNames = [
  'COMMANDER_KUBERNETES_CLUSTER',
  'COMMANDER_KUBERNETES_SERVER',
  'COMMANDER_KUBERNETES_TOKEN_ENV',
  'COMMANDER_KUBERNETES_BEARER_TOKEN',
] as const;
const kubernetesAuthorityEnvNames = [
  ...kubernetesEnvNames,
  'COMMANDER_KUBERNETES_NAMESPACES',
] as const;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function envNames(container: Record<string, unknown>): Set<string> {
  const env = Array.isArray(container.env) ? container.env : [];
  return new Set(env.map((entry) => String(record(entry).name ?? '')));
}

function containers(resource: Record<string, unknown>): Record<string, unknown>[] {
  const spec = record(resource.spec);
  const template = record(spec.template);
  const podSpec = record(template.spec);
  return [
    ...(Array.isArray(podSpec.initContainers) ? podSpec.initContainers : []),
    ...(Array.isArray(podSpec.containers) ? podSpec.containers : []),
  ].map(record);
}

function composeEnvNames(environment: unknown): Set<string> {
  if (Array.isArray(environment)) {
    return new Set(environment.map((entry) => String(entry).split('=', 1)[0]!));
  }
  return new Set(Object.keys(record(environment)));
}

describe('Kubernetes adapter Helm wiring', () => {
  const rendered = execFileSync(
    'helm',
    [
      'template',
      'kubernetes-adapter',
      'deploy/helm/commander',
      '-f',
      'deploy/helm/commander/values-demo.yaml',
      '--show-only',
      'templates/adapter-ops-deployment.yaml',
      '--show-only',
      'templates/networkpolicy.yaml',
      '--show-only',
      'templates/deployment.yaml',
      '--show-only',
      'templates/worker-deployment.yaml',
      '--show-only',
      'templates/migration-job.yaml',
      '--set',
      'image.tag=test',
      '--set',
      'tenantAuthority.proofOwnerSecret=kubernetes-adapter-proof-owner-r1',
      '--set',
      'tenantAuthority.releaseProjectionConfigMap=kubernetes-adapter-release-r1',
      '--set',
      'adapterOps.kubernetes.cluster=kind',
      '--set',
      'adapterOps.kubernetes.namespaces[0]=commander-proof',
      '--set',
      'adapterOps.kubernetes.server=https://kubernetes.default.svc:443',
      '--set',
      'adapterOps.secrets.create=false',
      '--set',
      'adapterOps.secrets.existingSecret=kind-adapter-secrets',
      '--set',
      'networkPolicy.egress.kubernetesApiCidrs[0]=10.96.0.1/32',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const resources = loadAll(rendered).filter(Boolean).map(record);

  it('rejects chart-generated Kubernetes tokens and broad API CIDRs', () => {
    const baseArgs = [
      'template',
      'kubernetes-adapter-invalid',
      'deploy/helm/commander',
      '-f',
      'deploy/helm/commander/values-demo.yaml',
      '--show-only',
      'templates/adapter-ops-deployment.yaml',
      '--set',
      'adapterOps.kubernetes.cluster=kind',
      '--set',
      'adapterOps.kubernetes.namespaces[0]=commander-proof',
      '--set',
      'adapterOps.kubernetes.server=https://kubernetes.default.svc:443',
    ];
    assert.throws(() => execFileSync('helm', baseArgs, { cwd: root, encoding: 'utf8' }));
    assert.throws(() =>
      execFileSync(
        'helm',
        [
          ...baseArgs,
          '--set',
          'adapterOps.secrets.create=false',
          '--set',
          'adapterOps.secrets.existingSecret=kind-adapter-secrets',
          '--set',
          'networkPolicy.egress.kubernetesApiCidrs[0]=10.0.0.0/8',
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
  });

  it('mounts an explicit bearer token only into worker and adapter-ops', () => {
    const adapterDeployment = resources.find(
      (resource) =>
        resource.kind === 'Deployment' &&
        String(record(resource.metadata).name).endsWith('-adapter-ops'),
    );
    assert.ok(adapterDeployment);
    assert.equal(
      record(record(record(adapterDeployment.spec).template).spec).automountServiceAccountToken,
      false,
    );

    const adapterContainer = containers(adapterDeployment).find(
      (container) => container.name === 'adapter-ops',
    );
    assert.ok(adapterContainer);
    const names = envNames(adapterContainer);
    for (const name of kubernetesAuthorityEnvNames) assert.ok(names.has(name), `missing ${name}`);

    const tokenEnv = (adapterContainer.env as unknown[])
      .map(record)
      .find((entry) => entry.name === 'COMMANDER_KUBERNETES_BEARER_TOKEN');
    assert.equal(
      record(record(record(tokenEnv?.valueFrom).secretKeyRef)).key,
      'kubernetes-bearer-token',
    );
    assert.equal(
      record(record(record(tokenEnv?.valueFrom).secretKeyRef)).name,
      'kind-adapter-secrets',
    );

    const workerDeployment = resources.find(
      (resource) =>
        resource.kind === 'Deployment' &&
        String(record(resource.metadata).name).endsWith('-worker'),
    );
    assert.ok(workerDeployment);
    assert.equal(
      record(record(record(workerDeployment.spec).template).spec).automountServiceAccountToken,
      false,
    );
    const workerContainer = containers(workerDeployment).find(
      (container) => container.name === 'worker',
    );
    assert.ok(workerContainer);
    const workerNames = envNames(workerContainer);
    for (const name of kubernetesAuthorityEnvNames) {
      assert.ok(workerNames.has(name), `missing ${name}`);
    }
    const workerTokenEnv = (workerContainer.env as unknown[])
      .map(record)
      .find((entry) => entry.name === 'COMMANDER_KUBERNETES_BEARER_TOKEN');
    assert.equal(
      record(record(record(workerTokenEnv?.valueFrom).secretKeyRef)).key,
      'kubernetes-bearer-token',
    );
    assert.equal(
      record(record(record(workerTokenEnv?.valueFrom).secretKeyRef)).name,
      'kind-adapter-secrets',
    );

    for (const resource of resources.filter(
      (candidate) => candidate.kind === 'Deployment' || candidate.kind === 'Job',
    )) {
      if (resource === adapterDeployment || resource === workerDeployment) continue;
      for (const container of containers(resource)) {
        const otherNames = envNames(container);
        for (const name of kubernetesAuthorityEnvNames) {
          assert.equal(otherNames.has(name), false, `${String(container.name)} received ${name}`);
        }
      }
    }
  });

  it('requires an external token secret and isolates Kubernetes API network egress', () => {
    const adapterSecret = resources.find(
      (resource) =>
        resource.kind === 'Secret' &&
        String(record(resource.metadata).name).endsWith('-adapter-secrets'),
    );
    assert.equal(adapterSecret, undefined);

    const policies = resources.filter((resource) => resource.kind === 'NetworkPolicy');
    const adapterPolicy = policies.find((resource) =>
      String(record(resource.metadata).name).endsWith('-adapter-ops-egress'),
    );
    const workerPolicy = policies.find((resource) =>
      String(record(resource.metadata).name).endsWith('-worker-egress'),
    );
    assert.ok(adapterPolicy && workerPolicy);
    const adapterYaml = JSON.stringify(adapterPolicy);
    const workerYaml = JSON.stringify(workerPolicy);
    assert.match(adapterYaml, /10\.96\.0\.1\/32/);
    assert.match(workerYaml, /10\.96\.0\.1\/32/);
  });
});

describe('Kubernetes adapter Compose wiring', () => {
  const files = [
    'docker-compose.yml',
    'docker-compose.cell.yml',
    'docker-compose.v2.yml',
    'docker-compose.prod.yml',
    'deploy/docker/v2-compose.yml',
  ];

  for (const path of files) {
    it(`keeps explicit Kubernetes credentials on the controlled worker and adapter-ops in ${path}`, () => {
      const config = record(load(readFileSync(join(root, path), 'utf8')));
      const services = record(config.services);
      const adapterOps = record(services['adapter-ops']);
      const adapterNames = composeEnvNames(adapterOps.environment);
      for (const name of kubernetesEnvNames) {
        assert.ok(adapterNames.has(name), `${path}: adapter-ops missing ${name}`);
      }
      for (const [serviceName, value] of Object.entries(services)) {
        if (
          serviceName === 'adapter-ops' ||
          (path === 'docker-compose.cell.yml' && serviceName === 'worker')
        )
          continue;
        const names = composeEnvNames(record(value).environment ?? {});
        for (const name of kubernetesEnvNames) {
          assert.equal(names.has(name), false, `${path}: ${serviceName} received ${name}`);
        }
      }
    });
  }

  it('binds the namespace authority only in the controlled cell override', () => {
    const config = record(load(readFileSync(join(root, 'docker-compose.cell.yml'), 'utf8')));
    const services = record(config.services);
    const adapterNames = composeEnvNames(record(services['adapter-ops']).environment);
    assert.ok(adapterNames.has('COMMANDER_KUBERNETES_NAMESPACES'));
    const workerNames = composeEnvNames(record(services.worker).environment);
    for (const name of kubernetesAuthorityEnvNames) {
      assert.ok(workerNames.has(name), `worker missing ${name}`);
    }
    for (const [serviceName, value] of Object.entries(services)) {
      if (serviceName === 'adapter-ops' || serviceName === 'worker') continue;
      assert.equal(
        composeEnvNames(record(value).environment ?? {}).has('COMMANDER_KUBERNETES_NAMESPACES'),
        false,
      );
    }
  });
});
