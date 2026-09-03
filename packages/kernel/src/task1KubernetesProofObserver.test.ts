import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import {
  createTask1KubernetesProofObserver,
  type Task1KubernetesProofApi,
  type Task1KubernetesProofReadRequest,
  type Task1ProjectedTokenIdentity,
} from './task1KubernetesProofObserver.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const now = new Date('2026-07-28T10:00:00.000Z');
const audience = 'commander-tenant-cutover-proof/v1';

function operation(): Task1LifecycleOperation {
  const binding = {
    kind: 'helm',
    namespace: 'commander',
    releaseName: 'release-a',
    chartContentSha256: digest('a'),
    phase: 'enforce',
    apiImageDigest: `sha256:${digest('b')}`,
  };
  return {
    installationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operationVersion: '9',
    predecessorStateVersion: '8',
    resultingStateVersion: '9',
    predecessorState: 'expanded',
    resultingState: 'enforced',
    operationKind: 'enforce',
    runtimePhase: 'enforce',
    platformKind: 'helm',
    previousBindingJcs: null,
    previousBindingSha256: null,
    requestedBindingJcs: canonicalBootstrapJson(binding),
    requestedBindingSha256: canonicalBootstrapSha256(binding),
    previousConfigurationJcs: null,
    previousConfigurationSha256: null,
    requestedConfigurationJcs: canonicalBootstrapJson({ operationAuditNonce: 'n'.repeat(43) }),
    requestedConfigurationSha256: digest('c'),
    previousBusinessConfigurationSha256: null,
    requestedBusinessConfigurationSha256: digest('d'),
    originBindingSha256: digest('e'),
    databasePeerBindingSha256: digest('f'),
    proofKeySha256: digest('1'),
    descriptorSet: [],
    predecessorEvidenceJcs: '{}',
    predecessorEvidenceSha256: digest('2'),
    predecessorProof: digest('2'),
    result: 'committed',
  };
}

const selector = {
  'app.kubernetes.io/name': 'release-a',
  'app.kubernetes.io/instance': 'release-a',
  'app.kubernetes.io/component': 'api',
};
const proofSelector = {
  'commander.io/tenant-authority-proof-reader': 'true',
  'commander.io/tenant-authority-proof-release': 'release-a',
};
const annotations = {
  'commander.io/tenant-context-aware': 'true',
  'commander.io/tenant-authority-phase': 'enforce',
  'commander.io/tenant-authority-image-digest': `sha256:${digest('b')}`,
  'commander.io/tenant-authority-configuration-sha256': digest('c'),
};

function resources(): Record<string, any> {
  const apiContainer = {
    name: 'api',
    image: `registry.example/commander@sha256:${digest('b')}`,
    env: [
      { name: 'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST', value: `sha256:${digest('b')}` },
      { name: 'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256', value: digest('c') },
      { name: 'COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE', value: 'enforce' },
    ],
    ports: [{ name: 'tenant-proof', containerPort: 9443, protocol: 'TCP' }],
    readinessProbe: {
      exec: {
        command: [
          'node',
          '-e',
          "const https = require('node:https'); const req = https.get({ hostname: '127.0.0.1', port: 9443, path: '/ready/tenant-authority/v1', rejectUnauthorized: false, headers: { 'X-Commander-Readiness-Challenge': 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc' } }, (res) => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.setTimeout(1500, () => { req.destroy(); process.exit(1); });",
        ],
      },
    },
  };
  return {
    service: {
      metadata: {
        name: 'release-a-api-proof',
        namespace: 'commander',
        uid: 'service-uid',
        labels: selector,
      },
      spec: {
        selector,
        ports: [{ name: 'tenant-proof', protocol: 'TCP', port: 9443, targetPort: 9443 }],
      },
    },
    deployment: {
      metadata: {
        name: 'release-a-api',
        namespace: 'commander',
        uid: 'deployment-uid',
        generation: 4,
        labels: selector,
        annotations: { ...annotations, 'deployment.kubernetes.io/revision': '6' },
      },
      spec: {
        replicas: 2,
        selector: { matchLabels: selector },
        template: {
          metadata: { labels: selector, annotations },
          spec: { containers: [apiContainer] },
        },
      },
      status: {
        observedGeneration: 4,
        replicas: 2,
        readyReplicas: 2,
        updatedReplicas: 2,
        availableReplicas: 2,
        unavailableReplicas: 0,
      },
    },
    replicaSets: {
      items: [
        {
          metadata: {
            name: 'release-a-api-rs',
            namespace: 'commander',
            uid: 'rs-uid',
            generation: 3,
            labels: { ...selector, 'pod-template-hash': 'hash-current' },
            annotations: { 'deployment.kubernetes.io/revision': '6' },
            ownerReferences: [
              {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                name: 'release-a-api',
                uid: 'deployment-uid',
                controller: true,
              },
            ],
          },
          spec: {
            replicas: 2,
            selector: { matchLabels: { ...selector, 'pod-template-hash': 'hash-current' } },
            template: {
              metadata: {
                labels: { ...selector, 'pod-template-hash': 'hash-current' },
                annotations,
              },
              spec: { containers: [apiContainer] },
            },
          },
          status: { observedGeneration: 3, replicas: 2, readyReplicas: 2, availableReplicas: 2 },
        },
      ],
    },
    apiPods: {
      items: ['1', '2'].map((suffix) => ({
        metadata: {
          name: `api-${suffix}`,
          namespace: 'commander',
          uid: `pod-${suffix}`,
          labels: { ...selector, 'pod-template-hash': 'hash-current' },
          ownerReferences: [
            {
              apiVersion: 'apps/v1',
              kind: 'ReplicaSet',
              name: 'release-a-api-rs',
              uid: 'rs-uid',
              controller: true,
            },
          ],
        },
        spec: { serviceAccountName: 'release-a', containers: [apiContainer] },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [
            {
              name: 'api',
              ready: true,
              restartCount: 0,
              image: 'docker.io/library/commander:kind',
              imageID: `containerd://sha256:${digest('b')}`,
            },
          ],
        },
      })),
    },
    proofPods: {
      items: [
        {
          metadata: {
            name: 'proof-pod',
            namespace: 'commander',
            uid: 'proof-pod-uid',
            labels: proofSelector,
            ownerReferences: [
              {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: 'release-a-tenant-cutover-prove-r6',
                uid: 'job-uid',
                controller: true,
              },
            ],
          },
          spec: {
            serviceAccountName: 'commander-proof-reader-cd49c9ab10cdd15c',
            automountServiceAccountToken: false,
            restartPolicy: 'Never',
            terminationGracePeriodSeconds: 30,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'tenant-cutover-prove',
                image: `registry.example/commander@sha256:${digest('b')}`,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', 'packages/kernel/dist/migrate.js', 'tenant-cutover-prove'],
                env: [
                  { name: 'COMMANDER_KUBERNETES_PROOF_RUNTIME', value: '1' },
                  {
                    name: 'COMMANDER_OWNER_DATABASE_URL',
                    valueFrom: {
                      secretKeyRef: { name: 'release-a-proof-owner-v9', key: 'owner-url' },
                    },
                  },
                  {
                    name: 'COMMANDER_DATABASE_TLS_CA_FILE',
                    value: '/run/commander/database-tls/ca.crt',
                  },
                  {
                    name: 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
                    value: digest('3'),
                  },
                  {
                    name: 'COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE',
                    value: '/run/commander/api-proof-public/ca.crt',
                  },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  {
                    name: 'proof-api-token',
                    mountPath: '/var/run/secrets/commander.io/proof-api',
                    readOnly: true,
                  },
                  {
                    name: 'release-projection',
                    mountPath: '/run/commander/release-projection',
                    readOnly: true,
                  },
                  {
                    name: 'database-public-ca',
                    mountPath: '/run/commander/database-tls',
                    readOnly: true,
                  },
                  {
                    name: 'api-proof-public',
                    mountPath: '/run/commander/api-proof-public',
                    readOnly: true,
                  },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              {
                name: 'proof-api-token',
                projected: {
                  defaultMode: 256,
                  sources: [
                    {
                      serviceAccountToken: {
                        audience,
                        expirationSeconds: 600,
                        path: 'identity-token',
                      },
                    },
                    { serviceAccountToken: { expirationSeconds: 600, path: 'api-token' } },
                    {
                      configMap: {
                        name: 'kube-root-ca.crt',
                        items: [{ key: 'ca.crt', path: 'ca.crt' }],
                      },
                    },
                  ],
                },
              },
              {
                name: 'release-projection',
                configMap: {
                  name: 'release-a-proof-projection-v9-r6',
                  defaultMode: 292,
                  items: [{ key: 'projection.json', path: 'projection.json' }],
                },
              },
              {
                name: 'database-public-ca',
                secret: {
                  secretName: 'database-ca',
                  items: [{ key: 'database-ca.pem', path: 'ca.crt' }],
                },
              },
              {
                name: 'api-proof-public',
                secret: {
                  secretName: 'api-proof-public',
                  items: [
                    { key: 'proof-ca.pem', path: 'ca.crt' },
                    { key: 'proof-cert.pem', path: 'tls.crt' },
                  ],
                },
              },
              { name: 'tmp', emptyDir: {} },
            ],
          },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: [
              {
                name: 'tenant-cutover-prove',
                ready: true,
                restartCount: 0,
                image: 'docker.io/library/commander:kind',
                imageID: `containerd://sha256:${digest('b')}`,
              },
            ],
          },
        },
      ],
    },
  };
}

function ownerCurrentProofResources(mode: 'plan' | 'append' = 'append'): Record<string, any> {
  const values = resources();
  const proofPod = values.proofPods.items[0];
  proofPod.metadata.labels = {
    ...proofSelector,
    'app.kubernetes.io/name': 'release-a',
    'app.kubernetes.io/instance': 'release-a',
    'commander.io/migration-client-v2': 'true',
    'commander.io/migration-release': 'release-a',
    'commander.io/tenant-cutover-owner-execution': 'abcdef1234567890abcdef1234567890',
  };
  proofPod.metadata.ownerReferences = [
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      name: `release-a-owner-${mode}-abcdef123456`,
      uid: 'job-uid',
      controller: true,
    },
  ];
  proofPod.spec.terminationGracePeriodSeconds = undefined;
  proofPod.spec.containers = [
    {
      name: 'owner-command',
      image: `registry.example/commander@sha256:${digest('b')}`,
      imagePullPolicy: 'IfNotPresent',
      command: ['node', 'packages/kernel/dist/migrate.js', `tenant-cutover-${mode}`],
      env: [
        { name: 'NODE_ENV', value: 'production' },
        {
          name: 'COMMANDER_TENANT_CUTOVER_INPUT_FILE',
          value: '/run/commander/tenant-cutover/request.json',
        },
        {
          name: 'DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'owner-url' } },
        },
        {
          name: 'COMMANDER_KERNEL_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'owner-url' } },
        },
        {
          name: 'COMMANDER_OWNER_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'owner-url' } },
        },
        {
          name: 'COMMANDER_APP_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'app-url' } },
        },
        {
          name: 'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'tenant-authority-url' } },
        },
        {
          name: 'COMMANDER_SCHEDULER_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'scheduler-url' } },
        },
        {
          name: 'COMMANDER_WORKER_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'worker-url' } },
        },
        {
          name: 'COMMANDER_ADAPTER_OPS_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'release-a-database', key: 'adapter-ops-url' } },
        },
        { name: 'COMMANDER_DATABASE_TLS_CA_FILE', value: '/run/commander/database-tls/ca.crt' },
        {
          name: 'COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY',
          value: 'secret/database-ca:database-ca.pem',
        },
        { name: 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256', value: digest('3') },
        {
          name: 'COMMANDER_TENANT_AUTHORITY_PROOF_PUBLIC_CERT_FILE',
          value: '/run/commander/api-proof-public/tls.crt',
        },
        { name: 'COMMANDER_KUBERNETES_PROOF_RUNTIME', value: '1' },
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [
        { name: 'request', mountPath: '/run/commander/tenant-cutover', readOnly: true },
        { name: 'database-public-ca', mountPath: '/run/commander/database-tls', readOnly: true },
        { name: 'api-proof-public', mountPath: '/run/commander/api-proof-public', readOnly: true },
        {
          name: 'proof-api-token',
          mountPath: '/var/run/secrets/commander.io/proof-api',
          readOnly: true,
        },
        {
          name: 'release-projection',
          mountPath: '/run/commander/release-projection',
          readOnly: true,
        },
        { name: 'tmp', mountPath: '/tmp' },
      ],
    },
  ];
  proofPod.spec.volumes = [
    { name: 'request', configMap: { name: 'release-a-request-abcdef123456', defaultMode: 292 } },
    ...proofPod.spec.volumes,
  ];
  proofPod.spec.volumes.find(
    (volume: { name: string }) => volume.name === 'release-projection',
  )!.configMap.name = 'release-a-owner-proof-current-r6';
  proofPod.status.containerStatuses = [
    {
      name: 'owner-command',
      ready: true,
      restartCount: 0,
      image: 'docker.io/library/commander:kind',
      imageID: `containerd://sha256:${digest('b')}`,
    },
  ];
  return values;
}

function token(): Task1ProjectedTokenIdentity {
  return {
    audience,
    issuedAt: '2026-07-28T10:00:00.000Z',
    expiresAt: '2027-07-28T10:00:00.000Z',
    namespace: 'commander',
    serviceAccountName: 'commander-proof-reader-cd49c9ab10cdd15c',
    podName: 'proof-pod',
    podUid: 'proof-pod-uid',
  };
}

function releaseProjection(): Record<string, unknown> {
  return {
    format: 'helm-release-projection/v1',
    namespace: 'commander',
    releaseName: 'release-a',
    revision: '6',
    chartContentSha256: digest('a'),
    objects: [],
    hooks: [
      {
        identity: {
          apiVersion: 'batch/v1',
          kind: 'Job',
          namespace: 'commander',
          name: 'release-a-tenant-cutover-prove-r6',
        },
        deletePolicies: ['before-hook-creation', 'hook-succeeded'],
      },
    ],
    rendererInput: {
      format: 'helm-renderer-input-projection/v1',
      values: {
        image: { pullPolicy: 'IfNotPresent' },
        database: {
          enabled: true,
          backend: 'postgres',
          postgres: { bundled: false, ownerSecretKey: 'owner-url' },
        },
        databaseTls: {
          existingSecret: '',
          caSecret: 'database-ca',
          caKey: 'database-ca.pem',
          expectedServerSpkiSha256: digest('3'),
        },
        migration: {
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 300,
          terminationGracePeriodSeconds: 30,
        },
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        tenantAuthority: {
          proofOwnerSecret: 'release-a-proof-owner-v9',
          releaseProjectionConfigMap: 'release-a-proof-projection-v9-r6',
          apiProof: {
            publicSecret: 'api-proof-public',
            caKey: 'proof-ca.pem',
            certKey: 'proof-cert.pem',
          },
        },
      },
      secretReferences: [],
    },
  };
}

class FixtureApi implements Task1KubernetesProofApi {
  readonly calls: Task1KubernetesProofReadRequest[] = [];
  constructor(readonly values = resources()) {}
  async read(request: Task1KubernetesProofReadRequest): Promise<unknown> {
    this.calls.push(request);
    if (request.resource === 'pods') {
      return request.selector?.['app.kubernetes.io/component'] === 'api'
        ? this.values.apiPods
        : this.values.proofPods;
    }
    return this.values[request.resource];
  }
}

describe('Task 1 Kubernetes proof observer', () => {
  it('waits for kubelet to publish readiness for its own running proof Pod', async () => {
    const values = resources();
    const staleProofPods = structuredClone(values.proofPods);
    staleProofPods.items[0].status.conditions[0].status = 'False';
    staleProofPods.items[0].status.containerStatuses[0].ready = false;
    const api = new FixtureApi(values);
    let proofPodReads = 0;
    const observer = createTask1KubernetesProofObserver({
      api: {
        async read(request) {
          if (
            request.resource === 'pods' &&
            request.selector?.['commander.io/tenant-authority-proof-reader'] === 'true'
          ) {
            proofPodReads += 1;
            return proofPodReads === 1 ? staleProofPods : values.proofPods;
          }
          return api.read(request);
        },
      },
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
      waitForProofStatus: async () => {},
    });

    await assert.doesNotReject(() => observer(operation()));
    assert.equal(proofPodReads, 2);
  });

  it('retains only the machine code and observer location on invariant failures', async () => {
    const values = resources();
    values.service.metadata.name = 'wrong-service';
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await assert.rejects(
      () => observer(operation()),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(
          (error as Error & { code?: unknown }).code,
          'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID',
        );
        assert.match(
          String((error as Error & { diagnostic?: unknown }).diagnostic),
          /^task1KubernetesProofObserver\.(?:ts|js):\d+:\d+$/,
        );
        return true;
      },
    );
  });

  it('reports Kubernetes label failures at the checked resource boundary', async () => {
    const locations = new Set<string>();
    const cases: Array<(values: Record<string, any>) => void> = [
      (values) => delete values.service.metadata.labels['app.kubernetes.io/component'],
      (values) => delete values.deployment.metadata.labels['app.kubernetes.io/component'],
      (values) =>
        delete values.deployment.spec.template.metadata.labels['app.kubernetes.io/component'],
      (values) =>
        delete values.replicaSets.items[0].spec.template.metadata.labels['pod-template-hash'],
      (values) => delete values.apiPods.items[0].metadata.labels['pod-template-hash'],
      (values) =>
        delete values.proofPods.items[0].metadata.labels[
          'commander.io/tenant-authority-proof-reader'
        ],
    ];

    for (const mutate of cases) {
      const values = JSON.parse(JSON.stringify(resources())) as Record<string, any>;
      mutate(values);
      const observer = createTask1KubernetesProofObserver({
        api: new FixtureApi(values),
        readProjectedTokenIdentity: async () => token(),
        readReleaseProjection: async () => releaseProjection(),
        now: () => now,
      });

      await assert.rejects(
        () => observer(operation()),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(
            (error as Error & { code?: unknown }).code,
            'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID',
          );
          const diagnostic = String((error as Error & { diagnostic?: unknown }).diagnostic);
          assert.match(diagnostic, /^task1KubernetesProofObserver\.(?:ts|js):\d+:\d+$/);
          locations.add(diagnostic);
          return true;
        },
      );
    }

    assert.equal(locations.size, cases.length);
  });

  it('uses only the frozen proof-reader permissions and binds its own projected-token Pod', async () => {
    const api = new FixtureApi();
    const observer = createTask1KubernetesProofObserver({
      api,
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });
    const facts = await observer(operation());

    assert.deepEqual(
      new Set(api.calls.map(({ resource }) => resource)),
      new Set(['service', 'deployment', 'replicaSets', 'pods']),
    );
    assert.equal(api.calls.filter(({ resource }) => resource === 'pods').length, 2);
    assert.equal(
      api.calls.every((call) => call.namespace === 'commander' && call.audience === audience),
      true,
    );
    assert.equal(
      api.calls.some((call) => Object.hasOwn(call, 'proofAttemptId')),
      false,
    );
    assert.equal(facts.topology, 'helm');
    assert.equal(
      facts.apiProofUrl,
      'https://release-a-api-proof.commander.svc.cluster.local:9443/ready/tenant-authority/v1',
    );
    assert.deepEqual(facts.workload.ready, ['api-1', 'api-2']);
    assert.equal(facts.platformArtifact.format, 'helm-release-projection/v1');
    assert.equal(JSON.stringify(facts).includes('proofAttempt'), false);
    assert.equal(JSON.stringify(facts).includes('token'), false);
  });

  it('binds the retained release projection to its own Helm proof Job revision', async () => {
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => ({ ...releaseProjection(), revision: '5' }),
      now: () => now,
    });

    await assert.rejects(() => observer(operation()), /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/);
  });

  it('accepts the strictly bound owner append Pod as the current-proof observer', async () => {
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(ownerCurrentProofResources()),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await observer(operation());
  });

  it('accepts the strictly bound owner plan Pod as the current-proof observer', async () => {
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(ownerCurrentProofResources('plan')),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await observer(operation());
  });

  it('rejects an owner current-proof Pod without a writable tmp volume', async () => {
    const values = ownerCurrentProofResources();
    values.proofPods.items[0].spec.containers[0].volumeMounts =
      values.proofPods.items[0].spec.containers[0].volumeMounts.filter(
        (mount: { name: string }) => mount.name !== 'tmp',
      );
    values.proofPods.items[0].spec.volumes = values.proofPods.items[0].spec.volumes.filter(
      (volume: { name: string }) => volume.name !== 'tmp',
    );
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await assert.rejects(() => observer(operation()), /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/);
  });

  it('accepts the Kubernetes-defaulted owner current-proof termination grace period', async () => {
    const values = ownerCurrentProofResources();
    values.proofPods.items[0].spec.terminationGracePeriodSeconds = 30;
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await observer(operation());
  });

  it('rejects an owner current-proof Pod whose image pull policy drifts', async () => {
    const values = ownerCurrentProofResources();
    values.proofPods.items[0].spec.containers[0].imagePullPolicy = 'Always';
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await assert.rejects(() => observer(operation()), /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/);
  });

  it('derives every configurable proof Pod expectation from retained renderer values', async () => {
    const cases: Array<[string, (values: Record<string, any>) => void]> = [
      ['image pull policy', (values) => (values.image.pullPolicy = 'Always')],
      [
        'database transport mode',
        (values) => {
          values.database.postgres.bundled = true;
        },
      ],
      ['database CA Secret', (values) => (values.databaseTls.caSecret = 'other-database-ca')],
      ['database CA key', (values) => (values.databaseTls.caKey = 'other-ca.pem')],
      ['database SPKI', (values) => (values.databaseTls.expectedServerSpkiSha256 = digest('4'))],
      [
        'owner Secret key',
        (values) => (values.database.postgres.ownerSecretKey = 'other-owner-url'),
      ],
      [
        'termination grace period',
        (values) => (values.migration.terminationGracePeriodSeconds = 31),
      ],
      ['Pod security IDs', (values) => (values.podSecurityContext.runAsUser = 1001)],
      ['proof owner Secret', (values) => (values.tenantAuthority.proofOwnerSecret = 'other-owner')],
      [
        'release projection ConfigMap',
        (values) => (values.tenantAuthority.releaseProjectionConfigMap = 'other-projection'),
      ],
      [
        'API proof public Secret',
        (values) => (values.tenantAuthority.apiProof.publicSecret = 'other-api-proof'),
      ],
      [
        'API proof CA key',
        (values) => (values.tenantAuthority.apiProof.caKey = 'other-proof-ca.pem'),
      ],
      [
        'API proof certificate key',
        (values) => (values.tenantAuthority.apiProof.certKey = 'other-proof-cert.pem'),
      ],
    ];
    for (const [name, mutate] of cases) {
      const projection = releaseProjection() as Record<string, any>;
      mutate(projection.rendererInput.values);
      const observer = createTask1KubernetesProofObserver({
        api: new FixtureApi(),
        readProjectedTokenIdentity: async () => token(),
        readReleaseProjection: async () => projection,
        now: () => now,
      });

      await assert.rejects(
        () => observer(operation()),
        /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/,
        name,
      );
    }
  });

  it('accepts exact Kubernetes Secret keys with chart-supported punctuation', async () => {
    const projection = releaseProjection() as Record<string, any>;
    projection.rendererInput.values.database.postgres.ownerSecretKey = '_owner-url';
    projection.rendererInput.values.databaseTls.caKey = '.database-ca.pem';
    projection.rendererInput.values.tenantAuthority.apiProof.caKey = '-proof-ca.pem';
    const values = resources();
    values.proofPods.items[0].spec.containers[0].env[1].valueFrom.secretKeyRef.key = '_owner-url';
    values.proofPods.items[0].spec.volumes[2].secret.items[0].key = '.database-ca.pem';
    values.proofPods.items[0].spec.volumes[3].secret.items[0].key = '-proof-ca.pem';
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => projection,
      now: () => now,
    });

    await assert.doesNotReject(() => observer(operation()));
  });

  it('rejects identity, token, own-Pod, rollout, selector, port, image, and ownership drift', async () => {
    const cases: Array<
      [string, (values: Record<string, any>, identity: Task1ProjectedTokenIdentity) => void]
    > = [
      [
        'caller-selected namespace',
        (_values, identity) => {
          identity.namespace = 'other';
        },
      ],
      [
        'caller-selected service account',
        (_values, identity) => {
          identity.serviceAccountName = 'other';
        },
      ],
      [
        'wrong projected audience',
        (_values, identity) => {
          identity.audience = 'other';
        },
      ],
      [
        'stale projected token',
        (_values, identity) => {
          identity.expiresAt = '2026-07-28T09:59:59.000Z';
        },
      ],
      [
        'stale Deployment generation',
        (values) => {
          values.deployment.status.observedGeneration = 3;
        },
      ],
      [
        'duplicate active ReplicaSet',
        (values) => {
          values.replicaSets.items.push(structuredClone(values.replicaSets.items[0]));
        },
      ],
      [
        'duplicate API pod',
        (values) => {
          values.apiPods.items.push(structuredClone(values.apiPods.items[0]));
        },
      ],
      [
        'non-ready API pod',
        (values) => {
          values.apiPods.items[0].status.conditions[0].status = 'False';
        },
      ],
      [
        'deleting API pod',
        (values) => {
          values.apiPods.items[0].metadata.deletionTimestamp = '2026-07-28T10:00:01Z';
        },
      ],
      [
        'restarted API container',
        (values) => {
          values.apiPods.items[0].status.containerStatuses[0].restartCount = 1;
        },
      ],
      [
        'Service selector drift',
        (values) => {
          values.service.spec.selector = { ...values.service.spec.selector, extra: 'broad' };
        },
      ],
      [
        'wrong Service target port',
        (values) => {
          values.service.spec.ports[0].targetPort = 4000;
        },
      ],
      [
        'readiness probe drift',
        (values) => {
          values.deployment.spec.template.spec.containers[0].readinessProbe.exec.command[2] =
            "require('node:https').get('https://127.0.0.1:9443/ready/tenant-authority/v1')";
        },
      ],
      [
        'Deployment image drift',
        (values) => {
          values.deployment.spec.template.spec.containers[0].image = `registry.example/commander@sha256:${digest('9')}`;
        },
      ],
      [
        'duplicate proof Pod',
        (values) => {
          values.proofPods.items.push(structuredClone(values.proofPods.items[0]));
        },
      ],
      [
        'projected identity Pod mismatch',
        (_values, identity) => {
          identity.podUid = 'other';
        },
      ],
      [
        'proof Pod owner missing',
        (values) => {
          values.proofPods.items[0].metadata.ownerReferences = [];
        },
      ],
      [
        'proof Job name drift',
        (values) => {
          values.proofPods.items[0].metadata.ownerReferences[0].name = 'other-job';
        },
      ],
      [
        'proof Pod token audience drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[0].projected.sources[0].serviceAccountToken.audience =
            'other';
        },
      ],
      [
        'proof token path drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[0].projected.sources[0].serviceAccountToken.path =
            'other';
        },
      ],
      [
        'Kubernetes API token audience drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[0].projected.sources[1].serviceAccountToken.audience =
            audience;
        },
      ],
      [
        'proof token mode drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[0].projected.defaultMode = 420;
        },
      ],
      [
        'proof token mount drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].volumeMounts[0].mountPath = '/other';
        },
      ],
      [
        'extra projected token',
        (values) => {
          values.proofPods.items[0].spec.volumes[0].projected.sources.push({
            serviceAccountToken: { audience, expirationSeconds: 600, path: 'other-token' },
          });
        },
      ],
      [
        'extra proof container',
        (values) => {
          values.proofPods.items[0].spec.containers.push({
            name: 'credential-exfiltrator',
            image: `registry.example/sidecar@sha256:${digest('9')}`,
          });
        },
      ],
      [
        'proof init container',
        (values) => {
          values.proofPods.items[0].spec.initContainers = [
            {
              name: 'credential-exfiltrator',
              image: `registry.example/sidecar@sha256:${digest('9')}`,
            },
          ];
        },
      ],
      [
        'proof restart policy drift',
        (values) => {
          values.proofPods.items[0].spec.restartPolicy = 'OnFailure';
        },
      ],
      [
        'proof termination grace period drift',
        (values) => {
          values.proofPods.items[0].spec.terminationGracePeriodSeconds = 31;
        },
      ],
      [
        'proof Pod active deadline injection',
        (values) => {
          values.proofPods.items[0].spec.activeDeadlineSeconds = 600;
        },
      ],
      [
        'proof Pod security context drift',
        (values) => {
          values.proofPods.items[0].spec.securityContext.runAsUser = 1001;
        },
      ],
      [
        'proof image pull policy drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].imagePullPolicy = 'Always';
        },
      ],
      [
        'proof command drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].command[2] = 'migrate';
        },
      ],
      [
        'proof command argument injection',
        (values) => {
          values.proofPods.items[0].spec.containers[0].args = ['--skip-verification'];
        },
      ],
      [
        'proof envFrom injection',
        (values) => {
          values.proofPods.items[0].spec.containers[0].envFrom = [
            { secretRef: { name: 'credential-exfiltrator' } },
          ];
        },
      ],
      [
        'proof owner Secret drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env[1].valueFrom.secretKeyRef.name =
            'other-owner';
        },
      ],
      [
        'proof owner Secret key drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env[1].valueFrom.secretKeyRef.key =
            'other-url';
        },
      ],
      [
        'proof SPKI drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env[3].value = digest('4');
        },
      ],
      [
        'proof database CA file drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env[2].value = '/tmp/ca.crt';
        },
      ],
      [
        'proof API CA file drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env[4].value = '/tmp/proof-ca.crt';
        },
      ],
      [
        'proof extra environment variable',
        (values) => {
          values.proofPods.items[0].spec.containers[0].env.push({
            name: 'CREDENTIAL_EXFILTRATION',
            value: '1',
          });
        },
      ],
      [
        'proof container security context drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem = false;
        },
      ],
      [
        'database CA Secret drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[2].secret.secretName = 'other-database-ca';
        },
      ],
      [
        'database CA Secret key drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[2].secret.items[0].key = 'other-ca.pem';
        },
      ],
      [
        'database CA Secret mode drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[2].secret.defaultMode = 0o600;
        },
      ],
      [
        'API proof public Secret drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[3].secret.secretName = 'other-api-proof';
        },
      ],
      [
        'API proof CA key drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[3].secret.items[0].key = 'other-proof-ca.pem';
        },
      ],
      [
        'API proof certificate key drift',
        (values) => {
          values.proofPods.items[0].spec.volumes[3].secret.items[1].key = 'other-proof-cert.pem';
        },
      ],
      [
        'database CA mount drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].volumeMounts[2].mountPath = '/tmp/ca';
        },
      ],
      [
        'writable API proof mount',
        (values) => {
          values.proofPods.items[0].spec.containers[0].volumeMounts[3].readOnly = false;
        },
      ],
      [
        'read-only tmp mount drift',
        (values) => {
          values.proofPods.items[0].spec.containers[0].volumeMounts[4].readOnly = true;
        },
      ],
      [
        'database CA subPath injection',
        (values) => {
          values.proofPods.items[0].spec.containers[0].volumeMounts[2].subPath = 'other';
        },
      ],
      [
        'proof ephemeral container',
        (values) => {
          values.proofPods.items[0].spec.ephemeralContainers = [
            { name: 'credential-exfiltrator', image: 'busybox' },
          ];
        },
      ],
      [
        'proof host network',
        (values) => {
          values.proofPods.items[0].spec.hostNetwork = true;
        },
      ],
      [
        'extra proof Secret volume',
        (values) => {
          values.proofPods.items[0].spec.volumes.push({
            name: 'credential-exfiltrator',
            secret: { secretName: 'other-secret' },
          });
        },
      ],
      [
        'non-ready proof Pod',
        (values) => {
          values.proofPods.items[0].status.conditions[0].status = 'False';
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const values = resources();
      const identity = token();
      mutate(values, identity);
      const observer = createTask1KubernetesProofObserver({
        api: new FixtureApi(values),
        readProjectedTokenIdentity: async () => identity,
        readReleaseProjection: async () => releaseProjection(),
        now: () => now,
        waitForProofStatus: async () => {},
      });
      await assert.rejects(
        () => observer(operation()),
        /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/,
        name,
      );
    }
  });

  it('rejects projected tokens whose issuance is stale or in the future', async () => {
    for (const issuedAt of ['2026-07-28T09:49:59.000Z', '2026-07-28T10:00:01.000Z']) {
      const values = resources();
      const identity = token();
      identity.issuedAt = issuedAt;
      const observer = createTask1KubernetesProofObserver({
        api: new FixtureApi(values),
        readProjectedTokenIdentity: async () => identity,
        readReleaseProjection: async () => releaseProjection(),
        now: () => now,
        waitForProofStatus: async () => {},
      });
      await assert.rejects(
        () => observer(operation()),
        /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/,
        issuedAt,
      );
    }
  });

  it('rejects the superseded Service-routed readiness probe contract', async () => {
    const values = resources();
    values.deployment.spec.template.spec.containers[0].readinessProbe = {
      httpGet: {
        scheme: 'HTTPS',
        path: '/ready/tenant-authority/v1',
        port: 'tenant-proof',
      },
    };
    const observer = createTask1KubernetesProofObserver({
      api: new FixtureApi(values),
      readProjectedTokenIdentity: async () => token(),
      readReleaseProjection: async () => releaseProjection(),
      now: () => now,
    });

    await assert.rejects(() => observer(operation()), /TENANT_CUTOVER_KUBERNETES_PROOF_INVALID/);
  });
});
