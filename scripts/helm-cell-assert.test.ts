import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertHelmCellTopology, loadYamlDocuments } from './helm-cell-assert.js';

const KERNEL_BACKEND_ENV = `
            - name: COMMANDER_KERNEL_BACKEND
              value: postgres`;

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
          env:${KERNEL_BACKEND_ENV}
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
          env:${KERNEL_BACKEND_ENV}
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
          env:${KERNEL_BACKEND_ENV}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cell-adapter-ops
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app.kubernetes.io/component: adapter-ops
    spec:
      containers:
        - name: adapter-ops
          env:${KERNEL_BACKEND_ENV}
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
---
apiVersion: batch/v1
kind: Job
metadata:
  name: cell-migration
  annotations:
    helm.sh/hook: post-install,post-upgrade
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
});
