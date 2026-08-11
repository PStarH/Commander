import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load, loadAll } from 'js-yaml';
import { normalizeEnvironment, type ComposeConfig } from './compose-role-assert.js';
import {
  assertHelmCellTopology,
  extractKernelDatabaseSecretKey,
  loadYamlDocuments,
} from './helm-cell-assert.js';

const KERNEL_BACKEND_ENV = `
            - name: COMMANDER_KERNEL_BACKEND
              value: postgres`;

const NON_AUTHORITATIVE_STORE_ENV = `
            - name: API_STORE_BACKEND
              value: memory
            - name: COMMANDER_MEMORY_STORE
              value: in-memory`;

const EVIDENCE_SIGNING_PRIVATE_KEY_ENV = 'COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM';
const EVIDENCE_SIGNING_KEY_ID_ENV = 'COMMANDER_EVIDENCE_SIGNING_KEY_ID';

interface HelmEnvEntry {
  name?: string;
  value?: unknown;
  valueFrom?: {
    secretKeyRef?: {
      name?: string;
      key?: string;
      optional?: boolean;
    };
  };
}

interface HelmManifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: Array<{ env?: HelmEnvEntry[] }> };
    };
  };
}

function loadComposeSource(path: string): ComposeConfig {
  return load(readFileSync(join(process.cwd(), path), 'utf8')) as ComposeConfig;
}

function findDeploymentEnv(docs: HelmManifest[], component: string): HelmEnvEntry[] {
  const deployment = docs.find(
    (doc) =>
      doc.kind === 'Deployment' &&
      doc.spec?.template?.metadata?.labels?.['app.kubernetes.io/component'] === component,
  );
  assert.ok(deployment, `missing ${component} Deployment`);
  return deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
}

function assertEvidenceSigningSecretRefs(env: HelmEnvEntry[], component: string): void {
  for (const [name, key] of [
    [EVIDENCE_SIGNING_PRIVATE_KEY_ENV, 'private-key-pem'],
    [EVIDENCE_SIGNING_KEY_ID_ENV, 'key-id'],
  ] as const) {
    const entry = env.find((candidate) => candidate.name === name);
    assert.ok(entry, `${component} must inject ${name}`);
    assert.equal(entry.value, undefined, `${component} must not inline ${name}`);
    assert.deepEqual(
      entry.valueFrom?.secretKeyRef,
      { name: 'cmdr-evidence-signing', key },
      `${component} must source ${name} from the protected evidence-signing Secret`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function dsnEnv(key: string): string {
  return `
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: ${key}
            - name: COMMANDER_KERNEL_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: ${key}`;
}

function capabilityEnv(): string {
  return `
            - name: COMMANDER_CAPABILITY_PRIVATE_KEY_PEM
              valueFrom:
                secretKeyRef:
                  name: cell-capability
                  key: private-key-pem
            - name: COMMANDER_CAPABILITY_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: cell-capability
                  key: key-id
            - name: COMMANDER_CAPABILITY_JWKS_JSON
              valueFrom:
                secretKeyRef:
                  name: cell-capability
                  key: jwks-json`;
}

const DEMO_SNIPPET = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cell-api
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app.kubernetes.io/component: api
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
      containers:
        - name: api
          env:${KERNEL_BACKEND_ENV}${NON_AUTHORITATIVE_STORE_ENV}${dsnEnv('app-url')}
          securityContext:
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cell-worker
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app.kubernetes.io/component: worker
    spec:
      containers:
        - name: worker
          env:${KERNEL_BACKEND_ENV}${dsnEnv('worker-url')}${capabilityEnv()}
            - name: COMMANDER_WORKER_TENANTS
              value: local
            - name: COMMANDER_CELL_TENANT_ID
              value: local
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cell-kernel-ops
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/component: kernel-ops
    spec:
      containers:
        - name: kernel-ops
          env:${KERNEL_BACKEND_ENV}${dsnEnv('scheduler-url')}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cell-adapter-ops
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/component: adapter-ops
    spec:
      containers:
        - name: adapter-ops
          env:${KERNEL_BACKEND_ENV}${dsnEnv('worker-url')}${capabilityEnv()}
            - name: COMMANDER_WORKER_TENANTS
              value: local
            - name: COMMANDER_CELL_TENANT_ID
              value: local
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cell-postgres
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/component: postgres
    spec:
      containers:
        - name: postgres
          env:
            - name: COMMANDER_OWNER_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: owner-password
            - name: COMMANDER_APP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: app-password
            - name: COMMANDER_SCHEDULER_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: scheduler-password
            - name: COMMANDER_WORKER_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: worker-password
          volumeMounts:
            - name: database-init
              mountPath: /docker-entrypoint-initdb.d
      volumes:
        - name: database-init
          configMap:
            name: cell-database-init
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cell-database-init
data:
  01-commander-roles.sh: |
    CREATE ROLE commander_owner WITH LOGIN PASSWORD '\${COMMANDER_OWNER_PASSWORD}' BYPASSRLS CREATEROLE;
    CREATE ROLE commander_app WITH LOGIN PASSWORD '\${COMMANDER_APP_PASSWORD}' NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE commander_scheduler WITH LOGIN PASSWORD '\${COMMANDER_SCHEDULER_PASSWORD}' BYPASSRLS NOCREATEROLE;
    CREATE ROLE commander_worker WITH LOGIN PASSWORD '\${COMMANDER_WORKER_PASSWORD}' NOBYPASSRLS NOCREATEROLE;
---
apiVersion: v1
kind: Secret
metadata:
  name: cell-database
data:
  owner-url: YQ==
  app-url: YQ==
  scheduler-url: YQ==
  worker-url: YQ==
  owner-password: YQ==
  app-password: YQ==
  scheduler-password: YQ==
  worker-password: YQ==
---
apiVersion: v1
kind: Secret
metadata:
  name: cell-capability
  annotations:
    commander.io/capability-keys: demo-dev-fixed-pair
    commander.io/not-for-production: "true"
stringData:
  private-key-pem: "-----BEGIN PRIVATE KEY-----\nDEMO\n-----END PRIVATE KEY-----\n"
  key-id: demo-cell-ed25519
  jwks-json: '{"keys":[]}'
---
apiVersion: batch/v1
kind: Job
metadata:
  name: cell-migration
  annotations:
    helm.sh/hook: post-install,post-upgrade
  labels:
    app.kubernetes.io/component: migration
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/component: migration
    spec:
      containers:
        - name: migration
          env:${dsnEnv('owner-url')}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cell-default-deny
`;

describe('helm-cell-assert', () => {
  it('passes demo profile fixture', () => {
    const docs = loadYamlDocuments(DEMO_SNIPPET);
    assert.doesNotThrow(() => assertHelmCellTopology(docs, 'demo'));
  });

  it('rejects 0.0.0.0/0 in network policy', () => {
    const bad = `${DEMO_SNIPPET}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cell-default-deny
spec:
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
`;
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /0\.0\.0\.0\/0/);
  });

  it('extracts kernel database secret keys', () => {
    assert.equal(extractKernelDatabaseSecretKey(dsnEnv('app-url')), 'app-url');
    assert.equal(extractKernelDatabaseSecretKey(dsnEnv('owner-url')), 'owner-url');
  });

  it('rejects runtime owner-url', () => {
    const bad = DEMO_SNIPPET.replace(dsnEnv('app-url'), dsnEnv('owner-url'));
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /owner-url/);
  });

  it('rejects an app-role API without isolated legacy stores', () => {
    const bad = DEMO_SNIPPET.replace(NON_AUTHORITATIVE_STORE_ENV, '');
    const docs = loadYamlDocuments(bad);
    assert.throws(
      () => assertHelmCellTopology(docs, 'demo'),
      /API_STORE_BACKEND|COMMANDER_MEMORY_STORE|H19/,
    );
  });

  it('rejects WORKER_TENANTS=*', () => {
    const bad = DEMO_SNIPPET.replace('value: local', 'value: "*"');
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /WORKER_TENANTS|\*/);
  });

  it('rejects adapter-ops missing COMMANDER_WORKER_TENANTS', () => {
    const bad = DEMO_SNIPPET.replace(/name: cell-adapter-ops[\s\S]*?value: local/, (block) =>
      block.replace(/\n\s*- name: COMMANDER_WORKER_TENANTS\n\s*value: local/, ''),
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(
      () => assertHelmCellTopology(docs, 'demo'),
      /adapter-ops.*COMMANDER_WORKER_TENANTS|H14/,
    );
  });

  it('rejects adapter-ops replicas != 1', () => {
    const bad = DEMO_SNIPPET.replace(
      /name: cell-adapter-ops\nspec:\n  replicas: 1/,
      'name: cell-adapter-ops\nspec:\n  replicas: 2',
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /adapter-ops replicas|H10/);
  });

  it('rejects missing CREATE ROLE LOGIN', () => {
    const bad = DEMO_SNIPPET.replace(
      /CREATE ROLE commander_worker WITH LOGIN[^\n]*/,
      'CREATE ROLE commander_worker NOLOGIN',
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /CREATE ROLE|LOGIN|H15/);
  });

  it('rejects worker missing capability secretKeyRef', () => {
    const bad = DEMO_SNIPPET.replace(capabilityEnv(), '');
    const docs = loadYamlDocuments(bad);
    assert.throws(
      () => assertHelmCellTopology(docs, 'demo'),
      /COMMANDER_CAPABILITY_PRIVATE_KEY_PEM|H16/,
    );
  });

  it('rejects worker HMAC capability-token-key path', () => {
    const bad = DEMO_SNIPPET.replace(
      capabilityEnv(),
      `${capabilityEnv()}
            - name: COMMANDER_CAPABILITY_TOKEN_KEY
              valueFrom:
                secretKeyRef:
                  name: cell-api
                  key: capability-token-key`,
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /CAPABILITY_TOKEN_KEY|H16/);
  });
});

describe('protected evidence-signing deployment contract', () => {
  it('mounts the protected Secret only into Helm producer workloads', () => {
    const rendered = execFileSync(
      'helm',
      [
        'template',
        'cell-enterprise',
        'deploy/helm/commander',
        '-f',
        'deploy/helm/commander/values-enterprise.yaml',
        '--set',
        'image.tag=test',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const docs = (loadAll(rendered) as Array<HelmManifest | null>).filter(
      (doc): doc is HelmManifest => doc !== null,
    );

    assertEvidenceSigningSecretRefs(findDeploymentEnv(docs, 'worker'), 'worker');
    assertEvidenceSigningSecretRefs(findDeploymentEnv(docs, 'adapter-ops'), 'adapter-ops');

    const apiEnv = findDeploymentEnv(docs, 'api');
    assert.ok(
      !apiEnv.some((entry) =>
        [EVIDENCE_SIGNING_PRIVATE_KEY_ENV, EVIDENCE_SIGNING_KEY_ID_ENV].includes(entry.name ?? ''),
      ),
      'api must not receive evidence-signing authority',
    );
    assert.ok(
      !docs.some((doc) => doc.kind === 'Secret' && doc.metadata?.name === 'cmdr-evidence-signing'),
      'the chart must not create the protected evidence-signing Secret',
    );
  });

  it('requires an external evidence-signing Secret contract in the values schema', () => {
    const schema = asRecord(
      JSON.parse(
        readFileSync(join(process.cwd(), 'deploy/helm/commander/values.schema.json'), 'utf8'),
      ),
      'values schema',
    );
    const properties = asRecord(schema.properties, 'values schema properties');
    const evidenceSigning = asRecord(properties.evidenceSigning, 'evidenceSigning schema');

    assert.equal(evidenceSigning.additionalProperties, false);
    assert.deepEqual(evidenceSigning.required, ['existingSecret', 'privateKeyPemKey', 'keyIdKey']);

    const signingProperties = asRecord(evidenceSigning.properties, 'evidenceSigning properties');
    assert.deepEqual(signingProperties.existingSecret, { type: 'string' });
    assert.deepEqual(signingProperties.privateKeyPemKey, { type: 'string', minLength: 1 });
    assert.deepEqual(signingProperties.keyIdKey, { type: 'string', minLength: 1 });

    const enterpriseRule = (schema.allOf as unknown[] | undefined)?.[0];
    const enterpriseThen = asRecord(
      asRecord(enterpriseRule, 'enterprise rule').then,
      'enterprise then',
    );
    const enterpriseProperties = asRecord(
      enterpriseThen.properties,
      'enterprise schema properties',
    );
    const enterpriseSigning = asRecord(
      enterpriseProperties.evidenceSigning,
      'enterprise evidenceSigning schema',
    );
    const enterpriseSigningProperties = asRecord(
      enterpriseSigning.properties,
      'enterprise evidenceSigning properties',
    );
    assert.deepEqual(enterpriseSigningProperties.existingSecret, { minLength: 1 });
    assert.deepEqual(enterpriseSigning.required, ['existingSecret']);
  });

  it('requires external signing inputs for every Compose producer and excludes APIs', () => {
    const privateKeyExpression =
      '${COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM:?set COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM}';
    const keyIdExpression =
      '${COMMANDER_EVIDENCE_SIGNING_KEY_ID:?set COMMANDER_EVIDENCE_SIGNING_KEY_ID}';
    const topologies = [
      { path: 'docker-compose.yml', producers: ['worker'], apis: ['api'] },
      {
        path: 'docker-compose.cell.yml',
        producers: ['worker', 'adapter-ops'],
        apis: ['api'],
      },
      {
        path: 'deploy/docker/v2-compose.yml',
        producers: ['worker'],
        apis: ['api-1', 'api-2'],
      },
    ];

    for (const topology of topologies) {
      const config = loadComposeSource(topology.path);
      for (const serviceName of topology.producers) {
        const service = config.services?.[serviceName];
        assert.ok(service, `${topology.path} missing producer ${serviceName}`);
        const env = normalizeEnvironment(service.environment);
        assert.equal(
          env[EVIDENCE_SIGNING_PRIVATE_KEY_ENV],
          privateKeyExpression,
          `${topology.path} ${serviceName} must require the signing private key`,
        );
        assert.equal(
          env[EVIDENCE_SIGNING_KEY_ID_ENV],
          keyIdExpression,
          `${topology.path} ${serviceName} must require the signing key id`,
        );
      }

      for (const serviceName of topology.apis) {
        const service = config.services?.[serviceName];
        assert.ok(service, `${topology.path} missing API ${serviceName}`);
        const env = normalizeEnvironment(service.environment);
        assert.ok(
          !(EVIDENCE_SIGNING_PRIVATE_KEY_ENV in env),
          `${topology.path} ${serviceName} must not receive the signing private key`,
        );
        assert.ok(
          !(EVIDENCE_SIGNING_KEY_ID_ENV in env),
          `${topology.path} ${serviceName} must not receive the signing key id`,
        );
      }
    }
  });
});
