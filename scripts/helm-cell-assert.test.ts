import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEnterpriseAdapterOpsTiming,
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

const TENANT_AUTHORITY_DSN_ENV = `
            - name: COMMANDER_TENANT_AUTHORITY_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: tenant-authority-url`;

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
          env:${KERNEL_BACKEND_ENV}${NON_AUTHORITATIVE_STORE_ENV}${dsnEnv('app-url')}${TENANT_AUTHORITY_DSN_ENV}
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
          env:${KERNEL_BACKEND_ENV}${dsnEnv('adapter-ops-url')}${capabilityEnv()}
            - name: COMMANDER_ADAPTER_OPS_INSTANCE_ID
              value: cell-adapter-ops
            - name: COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR
              value: /var/run/commander/adapter-ops
            - name: COMMANDER_WORKER_TENANTS
              value: local
            - name: COMMANDER_CELL_TENANT_ID
              value: local
          volumeMounts:
            - name: claim-secrets
              mountPath: /var/run/commander/adapter-ops
      volumes:
        - name: claim-secrets
          emptyDir: {}
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
            - name: COMMANDER_TENANT_AUTHORITY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: tenant-authority-password
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
            - name: COMMANDER_ADAPTER_OPS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: cell-database
                  key: adapter-ops-password
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
    CREATE ROLE commander_tenant_authority WITH LOGIN PASSWORD '\${COMMANDER_TENANT_AUTHORITY_PASSWORD}' NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE commander_scheduler WITH LOGIN PASSWORD '\${COMMANDER_SCHEDULER_PASSWORD}' BYPASSRLS NOCREATEROLE;
    CREATE ROLE commander_worker WITH LOGIN PASSWORD '\${COMMANDER_WORKER_PASSWORD}' NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE commander_adapter_ops WITH LOGIN PASSWORD '\${COMMANDER_ADAPTER_OPS_PASSWORD}' NOBYPASSRLS NOCREATEROLE;
---
apiVersion: v1
kind: Secret
metadata:
  name: cell-database
data:
  owner-url: YQ==
  app-url: YQ==
  tenant-authority-url: YQ==
  scheduler-url: YQ==
  worker-url: YQ==
  adapter-ops-url: YQ==
  owner-password: YQ==
  app-password: YQ==
  tenant-authority-password: YQ==
  scheduler-password: YQ==
  worker-password: YQ==
  adapter-ops-password: YQ==
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
  it('requires both exact enterprise ten-second intervals on the adapter-ops Deployment', () => {
    const deployment = DEMO_SNIPPET.match(
      /apiVersion: apps\/v1\nkind: Deployment\nmetadata:\n  name: cell-adapter-ops[\s\S]*?(?=\n---)/,
    )?.[0] ?? '';
    assert.throws(
      () => assertEnterpriseAdapterOpsTiming(loadYamlDocuments(deployment)),
      /COMMANDER_RECONCILE_INTERVAL_MS/,
    );
    const rendered = deployment.replace(
      '          env:',
      `          env:
            - name: COMMANDER_RECONCILE_INTERVAL_MS
              value: "10000"
            - name: COMMANDER_COMPENSATION_INTERVAL_MS
              value: "10000"`,
    );
    assert.doesNotThrow(() => assertEnterpriseAdapterOpsTiming(loadYamlDocuments(rendered)));
  });

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
    assert.equal(extractKernelDatabaseSecretKey(dsnEnv('adapter-ops-url')), 'adapter-ops-url');
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
    const bad = DEMO_SNIPPET.replace(
      /name: cell-adapter-ops[\s\S]*?value: local/,
      (block) => block.replace(/\n\s*- name: COMMANDER_WORKER_TENANTS\n\s*value: local/, ''),
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /adapter-ops.*COMMANDER_WORKER_TENANTS|H14/);
  });

  it('rejects adapter-ops replicas != 1', () => {
    const bad = DEMO_SNIPPET.replace(
      /name: cell-adapter-ops\nspec:\n  replicas: 1/,
      'name: cell-adapter-ops\nspec:\n  replicas: 2',
    );
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /adapter-ops replicas|H10/);
  });

  it('rejects adapter-ops sharing the worker DSN', () => {
    const bad = DEMO_SNIPPET.replace(dsnEnv('adapter-ops-url'), dsnEnv('worker-url'));
    assert.throws(
      () => assertHelmCellTopology(loadYamlDocuments(bad), 'demo'),
      /adapter-ops-url|H12/,
    );
  });

  it('rejects adapter-ops without its persisted claim-secret mount', () => {
    const bad = DEMO_SNIPPET.replace(/\n\s*volumeMounts:\n\s*- name: claim-secrets\n\s*mountPath: \/var\/run\/commander\/adapter-ops\n\s*volumes:\n\s*- name: claim-secrets\n\s*emptyDir: \{\}/, '');
    assert.throws(
      () => assertHelmCellTopology(loadYamlDocuments(bad), 'demo'),
      /claim.secret|mount|H20/i,
    );
  });

  it('rejects missing CREATE ROLE LOGIN', () => {
    const bad = DEMO_SNIPPET.replace(/CREATE ROLE commander_worker WITH LOGIN[^\n]*/, 'CREATE ROLE commander_worker NOLOGIN');
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /CREATE ROLE|LOGIN|H15/);
  });

  it('rejects worker missing capability secretKeyRef', () => {
    const bad = DEMO_SNIPPET.replace(capabilityEnv(), '');
    const docs = loadYamlDocuments(bad);
    assert.throws(() => assertHelmCellTopology(docs, 'demo'), /COMMANDER_CAPABILITY_PRIVATE_KEY_PEM|H16/);
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
