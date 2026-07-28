# Task 1 — Kind Lifecycle Harness Design

## Scope
Only the following files may be modified/created:
- `scripts/helm-lifecycle-kind.ts`
- `scripts/helm-lifecycle-kind.test.ts`
- `scripts/fixtures/helm-lifecycle/*`
- `.github/workflows/helm-lifecycle.yml`

Helm templates, kernel, Compose, and spec files are read-only for this task.

## Important context
The proof-reader RBAC and tenant-cutover-prove Job Helm templates exist in the
p2-ops working tree but are **not yet committed**. To let the harness run now
against the real chart that contains those templates, the CLI accepts a
`--chart <path>` option. The default path is `./deploy/helm/commander` (the
committed chart). When the templates are absent, the harness skips proof-reader
live tests and records the skip, rather than faking results.

## Design goals
1. Pin Kubernetes 1.33.2 and the exact `kindest/node` digest.
2. Run three real scenarios against a live Kind cluster:
   - Fresh bundled (ephemeral Postgres inside the chart).
   - Populated expand→enforce (upgrade an existing release from tenant-authority phase `expand` to `enforce`).
   - External PostgreSQL (chart uses an operator-supplied external DB).
3. Observe real Helm hook/workload ordering (pre-install migration Job, post-install proof Job, Deployment rollout).
4. Verify proof Job creation, execution, and deletion when templates are present.
5. Verify proof-reader RBAC and NetworkPolicy positive/negative cases when templates are present.
6. Verify rollout failure/retry/recovery.
7. Output sanitized evidence (no DSNs, passwords, tokens, private keys).
8. Never use static `helm template` output to fake live results.

## Cluster setup
- `kind-config.yaml` disables the default CNI (`disableDefaultCNI: true`) so a policy-capable CNI can be installed.
- Node image is pinned to `kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121`.
- After Kind cluster creation the harness installs Calico `v3.29.0` and waits for the `calico-node` and `calico-kube-controllers` pods to be ready.

## No-op application image
Because building the real Commander image is out of scope for this harness, we ship a tiny fixture image under `scripts/fixtures/helm-lifecycle/noop/`. The Dockerfile produces an image tagged `commander-lifecycle-noop:latest` with the exact entrypoints the chart expects:
- `packages/kernel/dist/migrationGate.js` (preflight) — exits 0.
- `packages/kernel/dist/migrate.js` (tenant-cutover-migrate, tenant-cutover-prove) — exits 0.
- A minimal HTTP server for the API liveness/readiness probes (returns 200 for every path).

The harness builds the image, loads it into Kind with `kind load docker-image`, and sets all chart image values to use it. This keeps the test focused on Helm lifecycle mechanics rather than application logic.

## Scenarios

### 1. Fresh bundled
- Release name: `cmdr-bundled`
- Values: `scripts/fixtures/helm-lifecycle/values-bundled-ephemeral.yaml`
- Assert:
  - Migration Job is created and completes first (pre-install hook).
  - Proof Job is created, completes, and is deleted by Helm after success.
  - All Deployments roll out successfully.

### 2. Populated expand→enforce
- First install with `tenantAuthority.cutoverPhase=expand`.
- After workloads are ready, upgrade with `tenantAuthority.cutoverPhase=enforce`.
- Assert:
  - Both installs create the migration Job first.
  - Both installs create and complete the proof Job.
  - API Deployment receives the phase label/env (`expand` then `enforce`).

### 3. External PostgreSQL
- Deploy an external Postgres instance into the cluster via `scripts/fixtures/helm-lifecycle/external-postgres.yaml`.
- Create a Secret containing six role DSNs plus the TLS CA and API proof public cert.
- Release name: `cmdr-external`
- Values: `scripts/fixtures/helm-lifecycle/values-external.yaml`
- Assert:
  - Migration Job and proof Job still run and complete.
  - Workloads connect to the external DB (verified via env/secret refs, not by querying it).
  - Chart does not render bundled Postgres StatefulSet.

## RBAC verification
- Positive: using `kubectl auth can-i`, verify the proof-reader ServiceAccount can `get/list` deployments, replicasets, and pods, and can `get` the proof Service.
- Negative: verify the same ServiceAccount cannot `list secrets`, `create pods`, or `impersonate`.

## NetworkPolicy verification
- With Calico installed, the default-deny policy blocks ingress/egress by default.
- Positive: a pod labeled as the API component can be reached on the proof port from a pod with the proof-reader label.
- Negative: a pod without the proof-reader label cannot reach the API proof port; a pod not in the allowed set cannot reach Postgres.

## Rollout failure/retry/recovery
- Install a release with an intentionally invalid image tag.
- Expect the Deployment to fail readiness and the rollout to stall (timeout handled gracefully).
- Upgrade the release with the valid no-op image using `helm upgrade --install`.
- Assert the rollout completes and the old ReplicaSet is scaled to zero.

## Evidence
- A JSON file `kind-lifecycle-evidence.json` is written after the run.
- Fields: scenario, event order, resource names, conditions, RBAC can-i results, NetworkPolicy test results, rollout status, errors.
- All values are sanitized with a regex redactor removing Postgres URLs, passwords, tokens, and PEM blocks. Pod logs are **not** captured to avoid accidental secret leakage.

## CLI
- `tsx scripts/helm-lifecycle-kind.ts run [--chart <path>] [--keep-cluster] [--scenario <name>]`
- The script always cleans up the Kind cluster unless `--keep-cluster` is given.
- Exit code is non-zero if any assertion fails.

## CI workflow
- `helm-lifecycle.yml` runs a `static` job and a `kind` job.
- The `kind` job:
  - Sets up Kind with the pinned node image.
  - Installs Calico `v3.29.0`.
  - Builds and loads the no-op image.
  - Runs `tsx scripts/helm-lifecycle-kind.ts run`.
  - Uploads the sanitized evidence as an artifact.
