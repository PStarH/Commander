#!/usr/bin/env tsx
/**
 * Task 1 — Kind Lifecycle Harness
 *
 * Creates a pinned Kubernetes 1.33.2 Kind cluster, installs Calico for
 * NetworkPolicy enforcement, and runs real Helm lifecycle scenarios against
 * the Commander chart. Produces sanitized evidence JSON.
 */

import { execFile, execFileSync, ExecFileOptions, spawn } from 'node:child_process';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CLUSTER_NAME = 'commander-helm-lifecycle';
const KIND_NODE_DIGESTS: Readonly<Record<string, string>> = {
  x64: '18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121',
  arm64: '2206121406df04dd321ea04919c7a1a3c3b12220770b4a62dc5e57e2cfab4dad',
};
const CALICO_IMAGE_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  x64: [
    '10643eba882c49d2558ee1f047ab4b42283c4b3e9e0864e4007e46c9faf5d50e',
    'ec9fc719f8b51397fff195d60c7d12d4149fa08c3167a6485e7691119560451f',
    '10a8342ee971aeb53cfe94599f1ba7048ff815e43689014cd436cc46d4d7d1e0',
  ],
  arm64: [
    '173ea2834c655eeee3aa9c3491c7ef6d75a2de1e622e127f524f02a4e1918f17',
    'f74ff658399ab2c7deb7cb28f2eccccd303d22bfd674b32547a8e6d83a44ac7c',
    '38d28083aad4783556c4172df0cfcca30e31b1a323017bb74988ea95ca391c14',
  ],
};
const POSTGRES_IMAGE_DIGESTS: Readonly<Record<string, string>> = {
  x64: '7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382',
  arm64: '7ae1143a9f249af815f056751a122a86d7e44ddce0926f2b227e3d5c434444f4',
};

export function kindNodeImageForArchitecture(architecture: string): string {
  const digest = KIND_NODE_DIGESTS[architecture];
  if (!digest) throw new Error('KIND_ARCHITECTURE_UNSUPPORTED');
  return `kindest/node:v1.33.2@sha256:${digest}`;
}

export function calicoImagesForArchitecture(architecture: string): string[] {
  const digests = CALICO_IMAGE_DIGESTS[architecture];
  if (!digests) throw new Error('KIND_ARCHITECTURE_UNSUPPORTED');
  return ['cni', 'node', 'kube-controllers'].map(
    (name, index) => `docker.io/calico/${name}:v3.29.0@sha256:${digests[index]}`,
  );
}

export function postgresImageForArchitecture(architecture: string): string {
  const digest = POSTGRES_IMAGE_DIGESTS[architecture];
  if (!digest) throw new Error('KIND_ARCHITECTURE_UNSUPPORTED');
  return `docker.io/library/postgres:16-alpine@sha256:${digest}`;
}

export const KIND_NODE_IMAGE = kindNodeImageForArchitecture(arch());
export const CALICO_URL =
  'https://raw.githubusercontent.com/projectcalico/calico/v3.29.0/manifests/calico.yaml';
export const PRODUCTION_IMAGE = 'commander-lifecycle-api:kind';
export const NAMESPACE = 'commander-lifecycle';
const EXTERNAL_DATABASE_NAMESPACE = 'commander-external-database';
const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
const CALICO_IMAGES = calicoImagesForArchitecture(arch());
const POSTGRES_IMAGE = postgresImageForArchitecture(arch());

function scenarioRelease(prefix: string): string {
  return `${prefix}-${RUN_ID}`;
}

export type LifecycleScenarioName =
  'real-bundled' | 'real-external-tls' | 'failed-rollout-recovery';

const LIFECYCLE_SCENARIOS: readonly LifecycleScenarioName[] = [
  'real-bundled',
  'real-external-tls',
  'failed-rollout-recovery',
];

export function selectLifecycleScenarios(filter?: string): LifecycleScenarioName[] {
  if (filter === undefined) return [...LIFECYCLE_SCENARIOS];
  if (!LIFECYCLE_SCENARIOS.includes(filter as LifecycleScenarioName)) {
    throw new Error('KIND_SCENARIO_INVALID');
  }
  return [filter as LifecycleScenarioName];
}

export function aggregateScenarioPass(scenarios: readonly { passed: boolean }[]): boolean {
  return scenarios.length > 0 && scenarios.every(({ passed }) => passed);
}

export function aggregateScenarioChecks(input: {
  assertions: readonly { passed: boolean }[];
  rbac: readonly { passed: boolean }[];
  networkPolicy: readonly { passed: boolean }[];
}): boolean {
  return (
    input.assertions.length > 0 &&
    input.rbac.length > 0 &&
    input.networkPolicy.length > 0 &&
    [...input.assertions, ...input.rbac, ...input.networkPolicy].every(({ passed }) => passed)
  );
}

export function namespaceCleanupArgs(namespace: string): string[] {
  return [
    'delete',
    'namespace',
    namespace,
    '--ignore-not-found=true',
    '--wait=true',
    '--timeout=120s',
  ];
}

export function controlPlaneReadinessSelectors(): string[] {
  return [
    'component=etcd',
    'component=kube-apiserver',
    'component=kube-controller-manager',
    'component=kube-scheduler',
  ];
}

export function assertHelmVersion(version: string): void {
  if (!/^v3\.17\.3(?:\+[^\s]+)?$/.test(version.trim())) throw new Error('HELM_VERSION_INVALID');
}

export function proofReaderName(namespace: string, release: string): string {
  const suffix = createHash('sha256').update(`${namespace}/${release}`).digest('hex').slice(0, 16);
  return `commander-proof-reader-${suffix}`;
}

export function productionImageReferences(digest: string): { source: string; target: string } {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('PRODUCTION_IMAGE_DIGEST_INVALID');
  }
  return {
    source: `docker.io/library/${PRODUCTION_IMAGE}`,
    target: `docker.io/library/${PRODUCTION_IMAGE.slice(0, PRODUCTION_IMAGE.lastIndexOf(':'))}@${digest}`,
  };
}

export function reusableProductionImageDigest(input: {
  imageId: unknown;
  repoDigests: unknown;
}): string {
  if (typeof input.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)) {
    throw new Error('PRODUCTION_IMAGE_REUSE_INVALID');
  }
  const matchingReferences = Array.isArray(input.repoDigests)
    ? input.repoDigests.filter(
        (reference): reference is string =>
          typeof reference === 'string' && reference.startsWith('commander-lifecycle-api@sha256:'),
      )
    : [];
  if (
    matchingReferences.length !== 1 ||
    matchingReferences[0] !== `commander-lifecycle-api@${input.imageId}`
  ) {
    throw new Error('PRODUCTION_IMAGE_REUSE_INVALID');
  }
  return input.imageId;
}

export function buildLifecycleValues(input: {
  namespace: string;
  release: string;
  imageDigest: string;
  databaseSpkiSha256: string;
  logLevel: 'info' | 'warn';
  database?:
    | { kind: 'bundled' }
    | {
        kind: 'external';
        secretName: string;
        caSecret: string;
        bootstrapAuthoritySecret: string;
        serviceNamespace: string;
        serviceName: string;
        serviceClusterIp: string;
      };
}): string {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) ||
    !/^[a-f0-9]{64}$/.test(input.databaseSpkiSha256)
  ) {
    throw new Error('LIFECYCLE_VALUES_INVALID');
  }
  const database = input.database ?? { kind: 'bundled' as const };
  const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  if (
    database.kind === 'external' &&
    (![database.secretName, database.caSecret, database.bootstrapAuthoritySecret].every(
      (value) => dnsLabel.test(value) && value.length <= 63,
    ) ||
      ![database.serviceNamespace, database.serviceName].every(
        (value) => dnsLabel.test(value) && value.length <= 63,
      ) ||
      !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(database.serviceClusterIp))
  ) {
    throw new Error('LIFECYCLE_VALUES_INVALID');
  }
  const postgresValues =
    database.kind === 'bundled'
      ? `    bundled: true
    user: postgres
    persistence:
      enabled: false`
      : `    bundled: false
    existingSecret: ${database.secretName}`;
  const databaseTlsValues =
    database.kind === 'bundled'
      ? `  existingSecret: ${input.release}-database-tls`
      : `  caSecret: ${database.caSecret}`;
  const bootstrapAuthority =
    database.kind === 'external'
      ? `  bootstrapAuthoritySecret: ${database.bootstrapAuthoritySecret}\n`
      : '';
  const endpointNamespace =
    database.kind === 'external' ? database.serviceNamespace : input.namespace;
  const endpointName =
    database.kind === 'external' ? database.serviceName : `${input.release}-postgres`;
  const endpointSelector =
    database.kind === 'external'
      ? `          app.kubernetes.io/name: ${database.serviceName}`
      : `          app.kubernetes.io/name: ${input.release}
          app.kubernetes.io/instance: ${input.release}
          app.kubernetes.io/component: postgres`;
  const databaseCidrs =
    database.kind === 'external'
      ? `  egress:\n    databaseCidrs:\n      - ${database.serviceClusterIp}/32\n`
      : '';
  return `tier: demo
web:
  enabled: false
worker:
  enabled: false
kernelOps:
  enabled: false
adapterOps:
  enabled: false
persistence:
  enabled: false
redis:
  enabled: false
api:
  replicas: 2
  secrets:
    create: true
capability:
  create: true
image:
  repository: commander-lifecycle-api
  digest: ${input.imageDigest}
  pullPolicy: IfNotPresent
config:
  logLevel: ${input.logLevel}
database:
  enabled: true
  backend: postgres
  postgres:
${postgresValues}
databaseTls:
${databaseTlsValues}
  expectedServerSpkiSha256: ${input.databaseSpkiSha256}
tenantAuthority:
${bootstrapAuthority}  apiProof:
    publicSecret: ${input.release}-api-proof-public
    privateSecret: ${input.release}-api-proof-private
networkPolicy:
  enabled: true
${databaseCidrs}  databaseEndpoints:
    - roles:
        - owner
        - app
        - tenant-authority
        - scheduler
        - worker
        - adapter-ops
      service:
        namespace: ${endpointNamespace}
        name: ${endpointName}
        servicePort: 5432
        targetPort: 5432
        podSelector:
${endpointSelector}
`;
}

function externalDatabaseInitScript(): string {
  return `#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE commander_owner WITH LOGIN PASSWORD '$COMMANDER_OWNER_PASSWORD' NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS;
CREATE ROLE commander_app WITH LOGIN PASSWORD '$COMMANDER_APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_tenant_authority WITH LOGIN PASSWORD '$COMMANDER_TENANT_AUTHORITY_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_scheduler WITH LOGIN PASSWORD '$COMMANDER_SCHEDULER_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
CREATE ROLE commander_worker WITH LOGIN PASSWORD '$COMMANDER_WORKER_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_adapter_ops WITH LOGIN PASSWORD '$COMMANDER_ADAPTER_OPS_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE commander_app SET statement_timeout = '55s';
ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s';
ALTER DATABASE commander OWNER TO commander_owner;
ALTER SCHEMA public OWNER TO commander_owner;
REVOKE ALL ON DATABASE commander FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT commander_app TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_tenant_authority TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_scheduler TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_worker TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_adapter_ops TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT CONNECT ON DATABASE commander TO commander_app;
GRANT USAGE ON SCHEMA public TO commander_app;
GRANT CONNECT ON DATABASE commander TO commander_tenant_authority;
GRANT USAGE ON SCHEMA public TO commander_tenant_authority;
GRANT CONNECT ON DATABASE commander TO commander_scheduler;
GRANT USAGE ON SCHEMA public TO commander_scheduler;
GRANT CONNECT ON DATABASE commander TO commander_worker;
GRANT USAGE ON SCHEMA public TO commander_worker;
GRANT CONNECT ON DATABASE commander TO commander_adapter_ops;
GRANT USAGE ON SCHEMA public TO commander_adapter_ops;
EOSQL
`;
}

export function buildExternalPostgresResources(input: {
  namespace: string;
  image: string;
  credentialsSecret: string;
  tlsSecret: string;
}): Record<string, unknown> {
  if (
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(input.namespace) ||
    !/^docker\.io\/library\/postgres:16-alpine@sha256:[a-f0-9]{64}$/.test(input.image)
  ) {
    throw new Error('EXTERNAL_POSTGRES_FIXTURE_INVALID');
  }
  const passwordEnv = (name: string, key: string) => ({
    name,
    valueFrom: { secretKeyRef: { name: input.credentialsSecret, key } },
  });
  const labels = { 'app.kubernetes.io/name': 'external-postgres' };
  return {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'external-postgres-init', namespace: input.namespace },
        data: { '01-commander-roles.sh': externalDatabaseInitScript() },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'external-postgres', namespace: input.namespace },
        spec: { selector: labels, ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }] },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: { name: 'external-postgres', namespace: input.namespace },
        spec: {
          serviceName: 'external-postgres',
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70 },
              containers: [
                {
                  name: 'postgres',
                  image: input.image,
                  imagePullPolicy: 'IfNotPresent',
                  args: [
                    '-c',
                    'ssl=on',
                    '-c',
                    'ssl_ca_file=/run/commander/database-tls/ca.crt',
                    '-c',
                    'ssl_cert_file=/run/commander/database-tls/tls.crt',
                    '-c',
                    'ssl_key_file=/run/commander/database-tls/tls.key',
                  ],
                  env: [
                    { name: 'POSTGRES_USER', value: 'postgres' },
                    { name: 'POSTGRES_DB', value: 'commander' },
                    { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                    passwordEnv('POSTGRES_PASSWORD', 'postgres-password'),
                    passwordEnv('COMMANDER_OWNER_PASSWORD', 'owner-password'),
                    passwordEnv('COMMANDER_APP_PASSWORD', 'app-password'),
                    passwordEnv('COMMANDER_TENANT_AUTHORITY_PASSWORD', 'tenant-authority-password'),
                    passwordEnv('COMMANDER_SCHEDULER_PASSWORD', 'scheduler-password'),
                    passwordEnv('COMMANDER_WORKER_PASSWORD', 'worker-password'),
                    passwordEnv('COMMANDER_ADAPTER_OPS_PASSWORD', 'adapter-ops-password'),
                  ],
                  readinessProbe: {
                    exec: { command: ['pg_isready', '-U', 'postgres', '-d', 'commander'] },
                    periodSeconds: 2,
                  },
                  volumeMounts: [
                    { name: 'data', mountPath: '/var/lib/postgresql/data' },
                    {
                      name: 'database-init',
                      mountPath: '/docker-entrypoint-initdb.d',
                      readOnly: true,
                    },
                    {
                      name: 'database-tls',
                      mountPath: '/run/commander/database-tls',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                { name: 'data', emptyDir: {} },
                {
                  name: 'database-init',
                  configMap: { name: 'external-postgres-init', defaultMode: 0o755 },
                },
                {
                  name: 'database-tls',
                  secret: { secretName: input.tlsSecret, defaultMode: 0o440 },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

export function assertProofPodContract(pod: unknown, expectedServiceAccount: string): void {
  const spec = (pod as { spec?: Record<string, unknown> })?.spec;
  const volumes = Array.isArray(spec?.volumes) ? spec.volumes : [];
  const tokenVolume = volumes.find(
    (volume) =>
      volume &&
      typeof volume === 'object' &&
      (volume as Record<string, unknown>).name === 'proof-api-token',
  ) as { projected?: { sources?: unknown[] } } | undefined;
  const sources = Array.isArray(tokenVolume?.projected?.sources)
    ? tokenVolume.projected.sources
    : [];
  const token = sources
    .map((source) =>
      source && typeof source === 'object'
        ? (source as { serviceAccountToken?: Record<string, unknown> }).serviceAccountToken
        : undefined,
    )
    .find(Boolean);
  if (
    spec?.serviceAccountName !== expectedServiceAccount ||
    spec.automountServiceAccountToken !== false ||
    token?.audience !== 'commander-tenant-cutover-proof/v1' ||
    token.expirationSeconds !== 300 ||
    token.path !== 'token'
  ) {
    throw new Error('PROOF_POD_CONTRACT_INVALID');
  }
}

export function assertNegativeCanaryResult(input: { exitCode: number; reason: string }): void {
  if (input.exitCode !== 42 || input.reason !== 'Error') {
    throw new Error('NETWORK_POLICY_NEGATIVE_CANARY_INVALID');
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScenarioEvidence {
  name: string;
  passed: boolean;
  durationMs: number;
  events: Record<string, unknown>[];
  assertions: AssertionResult[];
  rbac?: AssertionResult[];
  networkPolicy?: AssertionResult[];
  error?: string;
}

export interface AssertionResult {
  description: string;
  passed: boolean;
  detail?: string;
}

export interface HarnessEvidence {
  generatedAt: string;
  cluster: string;
  kindNodeImage: string;
  chartPath: string;
  calicoUrl: string;
  scenarios: ScenarioEvidence[];
  rbac?: AssertionResult[];
  networkPolicy?: AssertionResult[];
  rolloutRecovery?: ScenarioEvidence;
  passed: boolean;
  sanitized: boolean;
}

interface HarnessOptions {
  chart: string;
  keepCluster: boolean;
  reuseProductionImage: boolean;
  scenarioFilter?: string;
}

function rootDir(): string {
  return resolve(__dirname, '..');
}

function fixturePath(name: string): string {
  return resolve(__dirname, 'fixtures', 'helm-lifecycle', name);
}

export function sanitizeEvidence(evidence: HarnessEvidence): HarnessEvidence {
  const secretPatterns = [
    // Postgres DSNs and URLs
    [/postgres(?:ql)?:\/\/[^\s"']+/, 'postgres://***@***'],
    // Generic password/token/key values
    [/"password"\s*:\s*"[^"]*"/, '"password": "***"'],
    [/"token"\s*:\s*"[^"]*"/, '"token": "***"'],
    // PEM blocks
    [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/, '[PEM_REDACTED]'],
  ];
  const text = JSON.stringify(evidence);
  const sanitized = secretPatterns.reduce((acc, [pattern, replacement]) => {
    return acc.replace(new RegExp(pattern, 'g'), String(replacement));
  }, text);
  const out = JSON.parse(sanitized) as HarnessEvidence;
  out.sanitized = true;
  return out;
}

const LIFECYCLE_FAILURE_DIAGNOSTIC =
  /(?:COMMANDER_MIGRATION_FAILED|COMMANDER_PROOF_FAILED) stage=[a-z0-9-]+ code=[A-Z0-9_]{2,80}/g;
const API_STARTUP_FAILURE_CODE = /^\[startup\] Failed to start API server: ([A-Z0-9_]{2,80})$/gm;

export function extractLifecycleFailureDiagnostics(logs: string): string[] {
  const diagnostics = logs.match(LIFECYCLE_FAILURE_DIAGNOSTIC) ?? [];
  for (const match of logs.matchAll(API_STARTUP_FAILURE_CODE)) {
    diagnostics.push(`COMMANDER_API_FAILED stage=startup code=${match[1]}`);
  }
  return [...new Set(diagnostics)];
}

function runCmd(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, encoding: 'utf8' as const }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      });
    });
  });
}

function runCmdSync(file: string, args: string[], options: ExecFileOptions = {}): CommandResult {
  try {
    const result = execFileSync(file, args, { ...options, encoding: 'utf8' });
    return { stdout: result ?? '', stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: Number(error.status ?? 1),
    };
  }
}

export function kindClusterExists(cluster: string): boolean {
  const result = runCmdSync('kind', ['get', 'clusters']);
  return result.stdout.split(/\n/).some((line) => line.trim() === cluster);
}

export async function createKindCluster(cluster: string): Promise<void> {
  if (kindClusterExists(cluster)) {
    await runCmd('kind', ['delete', 'cluster', '--name', cluster]);
  }
  const selectedImage = process.env.COMMANDER_KIND_NODE_IMAGE ?? KIND_NODE_IMAGE;
  const expectedDigest = KIND_NODE_IMAGE.slice(KIND_NODE_IMAGE.indexOf('@sha256:'));
  if (!selectedImage.endsWith(expectedDigest)) {
    throw new Error('KIND_NODE_IMAGE_DIGEST_INVALID');
  }
  const result = await runCmd('kind', [
    'create',
    'cluster',
    '--name',
    cluster,
    '--config',
    fixturePath('kind-config.yaml'),
    '--image',
    selectedImage,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`kind create cluster failed: ${result.stderr}`);
  }
}

export async function deleteKindCluster(cluster: string): Promise<void> {
  await runCmd('kind', ['delete', 'cluster', '--name', cluster]);
}

export async function installCalico(): Promise<void> {
  const result = await runCmd('kubectl', ['apply', '-f', CALICO_URL]);
  if (result.exitCode !== 0) {
    throw new Error(`Calico apply failed: ${result.stderr}`);
  }
  // Wait for Calico pods.
  const wait = await runCmd('kubectl', [
    'wait',
    '--for=condition=ready',
    'pod',
    '-l',
    'k8s-app=calico-node',
    '-n',
    'kube-system',
    '--timeout=180s',
  ]);
  if (wait.exitCode !== 0) {
    throw new Error(`Calico did not become ready: ${wait.stderr}`);
  }
  const controllersWait = await runCmd('kubectl', [
    'wait',
    '--for=condition=available',
    'deployment/calico-kube-controllers',
    '-n',
    'kube-system',
    '--timeout=180s',
  ]);
  if (controllersWait.exitCode !== 0) {
    throw new Error(`Calico controllers did not become ready: ${controllersWait.stderr}`);
  }
}

async function pullTagAndLoadImage(immutableImage: string, manifestImage: string): Promise<void> {
  if (await kindNodesContainExactReference(immutableImage)) return;
  const inspected = await runCmd('docker', [
    'image',
    'inspect',
    immutableImage,
    '--format',
    '{{json .RepoDigests}}',
  ]);
  let present = false;
  if (inspected.exitCode === 0) {
    try {
      const repoDigests = JSON.parse(inspected.stdout) as unknown;
      present = Array.isArray(repoDigests) && repoDigests.includes(immutableImage);
    } catch {
      throw new Error('PINNED_IMAGE_INSPECTION_FAILED');
    }
  }
  if (!present) {
    requireCommand(
      await runCmd('docker', [
        'pull',
        '--platform',
        `linux/${arch() === 'x64' ? 'amd64' : 'arm64'}`,
        immutableImage,
      ]),
      'PINNED_IMAGE_PULL_FAILED',
    );
  }
  requireCommand(
    await runCmd('docker', ['tag', immutableImage, manifestImage]),
    'IMAGE_TAG_FAILED',
  );
  requireCommand(
    await runCmd('kind', ['load', 'docker-image', manifestImage, '--name', CLUSTER_NAME]),
    'KIND_IMAGE_LOAD_FAILED',
  );
  await tagKindNodeReference(manifestImage, immutableImage);
  if (!(await kindNodesContainExactReference(immutableImage))) {
    throw new Error('KIND_EXACT_IMAGE_REFERENCE_MISSING');
  }
}

export async function loadPinnedRuntimeImages(): Promise<void> {
  for (const immutableImage of CALICO_IMAGES) {
    const manifestImage = immutableImage.slice(0, immutableImage.indexOf('@sha256:'));
    await pullTagAndLoadImage(immutableImage, manifestImage);
  }
  await pullTagAndLoadImage(POSTGRES_IMAGE, 'docker.io/library/postgres:16-alpine');
}

export async function buildProductionImage(): Promise<string> {
  const metadataDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-image-'));
  const metadataFile = resolve(metadataDirectory, 'metadata.json');
  const build = await runCmd('docker', [
    'buildx',
    'build',
    '--load',
    '--tag',
    PRODUCTION_IMAGE,
    '--metadata-file',
    metadataFile,
    '--file',
    resolve(rootDir(), 'apps/api/Dockerfile'),
    rootDir(),
  ]);
  if (build.exitCode !== 0) {
    rmSync(metadataDirectory, { recursive: true, force: true });
    throw new Error(`production image build failed: ${build.stderr}`);
  }
  let digest: unknown;
  try {
    digest = (JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>)[
      'containerimage.digest'
    ];
  } finally {
    rmSync(metadataDirectory, { recursive: true, force: true });
  }
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('PRODUCTION_IMAGE_DIGEST_INVALID');
  }
  process.env.COMMANDER_LIFECYCLE_IMAGE_DIGEST = digest;
  return digest;
}

async function inspectReusableProductionImage(): Promise<string> {
  const inspected = requireCommand(
    await runCmd('docker', ['image', 'inspect', PRODUCTION_IMAGE, '--format', '{{json .}}']),
    'PRODUCTION_IMAGE_REUSE_INSPECTION_FAILED',
  );
  let image: { Id?: unknown; RepoDigests?: unknown };
  try {
    image = JSON.parse(inspected) as { Id?: unknown; RepoDigests?: unknown };
  } catch {
    throw new Error('PRODUCTION_IMAGE_REUSE_INVALID');
  }
  const digest = reusableProductionImageDigest({
    imageId: image.Id,
    repoDigests: image.RepoDigests,
  });
  process.env.COMMANDER_LIFECYCLE_IMAGE_DIGEST = digest;
  return digest;
}

function kindNodes(): Promise<string[]> {
  return runCmd('kind', ['get', 'nodes', '--name', CLUSTER_NAME]).then((result) =>
    requireCommand(result, 'KIND_NODE_DISCOVERY_FAILED').trim().split(/\r?\n/).filter(Boolean),
  );
}

export function nodeInventoriesContainExactReference(
  inventories: readonly { node: string; references: readonly string[] }[],
  exactReference: string,
): boolean {
  return (
    inventories.length > 0 &&
    inventories.every(
      ({ node, references }) => node.length > 0 && references.includes(exactReference),
    )
  );
}

async function kindNodesContainExactReference(exactReference: string): Promise<boolean> {
  const nodes = await kindNodes();
  const inventories = await Promise.all(
    nodes.map(async (node) => {
      const result = await runCmd('docker', [
        'exec',
        node,
        'ctr',
        '-n',
        'k8s.io',
        'images',
        'list',
        '-q',
      ]);
      return {
        node,
        references:
          result.exitCode === 0
            ? result.stdout
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
      };
    }),
  );
  return nodeInventoriesContainExactReference(inventories, exactReference);
}

async function tagKindNodeReference(source: string, target: string): Promise<void> {
  const nodes = await kindNodes();
  if (nodes.length === 0) throw new Error('KIND_NODE_DISCOVERY_FAILED');
  for (const node of nodes) {
    requireCommand(
      await runCmd('docker', [
        'exec',
        node,
        'ctr',
        '-n',
        'k8s.io',
        'images',
        'tag',
        '--force',
        source,
        target,
      ]),
      'KIND_DIGEST_REFERENCE_FAILED',
    );
  }
}

export async function loadProductionImage(digest: string): Promise<void> {
  const references = productionImageReferences(digest);
  if (await kindNodesContainExactReference(references.target)) return;
  const load = await runCmd('kind', [
    'load',
    'docker-image',
    PRODUCTION_IMAGE,
    '--name',
    CLUSTER_NAME,
  ]);
  if (load.exitCode !== 0) {
    throw new Error(`kind load docker-image failed: ${load.stderr}`);
  }
  await tagKindNodeReference(references.source, references.target);
  if (!(await kindNodesContainExactReference(references.target))) {
    throw new Error('KIND_EXACT_IMAGE_REFERENCE_MISSING');
  }
}

export async function buildAndLoadProductionImage(): Promise<void> {
  await loadProductionImage(await buildProductionImage());
}

function kubectl(args: string[]): Promise<CommandResult> {
  return runCmd('kubectl', args);
}

function helm(args: string[]): Promise<CommandResult> {
  return runCmd('helm', args);
}

async function createNamespace(namespace = NAMESPACE): Promise<void> {
  const result = await kubectl(['create', 'namespace', namespace]);
  if (result.exitCode !== 0 && !result.stderr.includes('AlreadyExists')) {
    throw new Error(`failed to create namespace: ${result.stderr}`);
  }
}

async function waitForDeployment(name: string, timeout = '300s'): Promise<CommandResult> {
  return runCmd('kubectl', [
    'wait',
    '--for=condition=available',
    'deployment',
    name,
    '-n',
    NAMESPACE,
    '--timeout',
    timeout,
  ]);
}

async function getEvents(namespace: string): Promise<Record<string, unknown>[]> {
  const result = await runCmd('kubectl', ['get', 'events', '-n', namespace, '-o', 'json']);
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { items: Record<string, unknown>[] };
    return parsed.items ?? [];
  } catch {
    return [];
  }
}

export function proofTemplatesPresent(chart: string): boolean {
  return existsSync(resolve(chart, 'templates', 'tenant-cutover-prove-job.yaml'));
}
function requireCommand(result: CommandResult, code: string): string {
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-4_000);
    throw new Error(`${code}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

async function kubectlJson(args: string[]): Promise<Record<string, unknown>> {
  const output = requireCommand(await kubectl([...args, '-o', 'json']), 'KUBECTL_JSON_FAILED');
  const parsed = JSON.parse(output) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('KUBECTL_JSON_INVALID');
  }
  return parsed as Record<string, unknown>;
}

async function ensureControlPlaneReady(): Promise<void> {
  for (const selector of controlPlaneReadinessSelectors()) {
    requireCommand(
      await kubectl([
        'wait',
        '--for=condition=Ready',
        'pod',
        '-n',
        'kube-system',
        '-l',
        selector,
        '--timeout=120s',
      ]),
      'KIND_CONTROL_PLANE_NOT_READY',
    );
  }
  requireCommand(await kubectl(['get', '--raw=/readyz']), 'KIND_API_NOT_READY');
}

function certificateSpkiSha256(path: string): string {
  const certificate = new X509Certificate(readFileSync(path));
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('hex');
}

export function leafCertificateExtensions(dnsNames: readonly string[]): string {
  return `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${dnsNames
    .map((dnsName) => `DNS:${dnsName}`)
    .join(',')}\n`;
}

function generateCertificateMaterial(
  directory: string,
  namespace: string,
  release: string,
  databaseDnsNames?: string[],
): { databaseSpkiSha256: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const openssl = (args: string[]) => {
    const result = runCmdSync('openssl', args, { cwd: directory });
    requireCommand(result, 'OPENSSL_FAILED');
  };
  openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'ca.key']);
  openssl([
    'req',
    '-x509',
    '-new',
    '-sha256',
    '-days',
    '2',
    '-key',
    'ca.key',
    '-subj',
    '/CN=commander-kind-lifecycle-ca',
    '-out',
    'ca.crt',
  ]);

  const leaf = (name: string, dnsNames: string[]) => {
    openssl([
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-out',
      `${name}.key`,
    ]);
    openssl([
      'req',
      '-new',
      '-sha256',
      '-key',
      `${name}.key`,
      '-subj',
      `/CN=${dnsNames[0]}`,
      '-out',
      `${name}.csr`,
    ]);
    writeFileSync(resolve(directory, `${name}.ext`), leafCertificateExtensions(dnsNames), {
      mode: 0o600,
    });
    openssl([
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-extfile',
      `${name}.ext`,
      '-out',
      `${name}.crt`,
    ]);
  };

  leaf(
    'postgres',
    databaseDnsNames ?? [
      `${release}-postgres`,
      `${release}-postgres.${namespace}.svc`,
      `${release}-postgres.${namespace}.svc.cluster.local`,
    ],
  );
  leaf('api-proof', [
    `${release}-api-proof`,
    `${release}-api-proof.${namespace}.svc`,
    `${release}-api-proof.${namespace}.svc.cluster.local`,
  ]);
  return { databaseSpkiSha256: certificateSpkiSha256(resolve(directory, 'postgres.crt')) };
}

async function createLifecycleTlsSecrets(
  directory: string,
  namespace: string,
  release: string,
  apiPrivateKeySource = 'api-proof.key',
): Promise<void> {
  const createSecret = async (name: string, files: Array<[key: string, source: string]>) => {
    requireCommand(
      await kubectl([
        'create',
        'secret',
        'generic',
        name,
        '-n',
        namespace,
        ...files.flatMap(([key, source]) => [`--from-file=${key}=${resolve(directory, source)}`]),
      ]),
      'TLS_SECRET_CREATE_FAILED',
    );
  };
  await createSecret(`${release}-database-tls`, [
    ['ca.crt', 'ca.crt'],
    ['tls.crt', 'postgres.crt'],
    ['tls.key', 'postgres.key'],
  ]);
  await createApiProofSecrets(directory, namespace, release, apiPrivateKeySource);
}

async function createApiProofSecrets(
  directory: string,
  namespace: string,
  release: string,
  apiPrivateKeySource = 'api-proof.key',
): Promise<void> {
  const createSecret = async (name: string, files: Array<[key: string, source: string]>) => {
    requireCommand(
      await kubectl([
        'create',
        'secret',
        'generic',
        name,
        '-n',
        namespace,
        ...files.flatMap(([key, source]) => [`--from-file=${key}=${resolve(directory, source)}`]),
      ]),
      'TLS_SECRET_CREATE_FAILED',
    );
  };
  await createSecret(`${release}-api-proof-public`, [
    ['ca.crt', 'ca.crt'],
    ['tls.crt', 'api-proof.crt'],
  ]);
  await createSecret(`${release}-api-proof-private`, [
    ['tls.crt', 'api-proof.crt'],
    ['tls.key', apiPrivateKeySource],
  ]);
}

async function replaceApiProofPrivateSecret(
  directory: string,
  namespace: string,
  release: string,
): Promise<void> {
  requireCommand(
    await kubectl(['delete', 'secret', `${release}-api-proof-private`, '-n', namespace]),
    'API_PROOF_PRIVATE_SECRET_DELETE_FAILED',
  );
  requireCommand(
    await kubectl([
      'create',
      'secret',
      'generic',
      `${release}-api-proof-private`,
      '-n',
      namespace,
      `--from-file=tls.crt=${resolve(directory, 'api-proof.crt')}`,
      `--from-file=tls.key=${resolve(directory, 'api-proof.key')}`,
    ]),
    'API_PROOF_PRIVATE_SECRET_CREATE_FAILED',
  );
}

async function applyPrivateJson(
  directory: string,
  name: string,
  value: Record<string, unknown>,
): Promise<void> {
  const path = resolve(directory, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    requireCommand(await kubectl(['apply', '-f', path]), 'KUBERNETES_FIXTURE_APPLY_FAILED');
  } finally {
    rmSync(path, { force: true });
  }
}

type ExternalDatabaseFixture = {
  serviceClusterIp: string;
  hostname: string;
};

async function createExternalDatabaseFixture(input: {
  directory: string;
  release: string;
}): Promise<ExternalDatabaseFixture> {
  const credentialsSecret = 'external-postgres-credentials';
  const tlsSecret = 'external-postgres-tls';
  const hostname = `external-postgres.${EXTERNAL_DATABASE_NAMESPACE}.svc.cluster.local`;
  const rolePasswords = Object.fromEntries(
    ['postgres', 'owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops'].map(
      (role) => [role, randomBytes(24).toString('base64url')],
    ),
  ) as Record<string, string>;
  await applyPrivateJson(input.directory, 'external-credentials.json', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: credentialsSecret, namespace: EXTERNAL_DATABASE_NAMESPACE },
    type: 'Opaque',
    stringData: Object.fromEntries(
      Object.entries(rolePasswords).map(([role, password]) => [`${role}-password`, password]),
    ),
  });
  requireCommand(
    await kubectl([
      'create',
      'secret',
      'generic',
      tlsSecret,
      '-n',
      EXTERNAL_DATABASE_NAMESPACE,
      `--from-file=ca.crt=${resolve(input.directory, 'ca.crt')}`,
      `--from-file=tls.crt=${resolve(input.directory, 'postgres.crt')}`,
      `--from-file=tls.key=${resolve(input.directory, 'postgres.key')}`,
    ]),
    'EXTERNAL_DATABASE_TLS_SECRET_CREATE_FAILED',
  );
  await applyPrivateJson(
    input.directory,
    'external-postgres.json',
    buildExternalPostgresResources({
      namespace: EXTERNAL_DATABASE_NAMESPACE,
      image: POSTGRES_IMAGE,
      credentialsSecret,
      tlsSecret,
    }),
  );
  requireCommand(
    await kubectl([
      'rollout',
      'status',
      'statefulset/external-postgres',
      '-n',
      EXTERNAL_DATABASE_NAMESPACE,
      '--timeout=5m',
    ]),
    'EXTERNAL_DATABASE_NOT_READY',
  );
  const service = await kubectlJson([
    'get',
    'service',
    'external-postgres',
    '-n',
    EXTERNAL_DATABASE_NAMESPACE,
  ]);
  const serviceClusterIp = (service.spec as { clusterIP?: unknown } | undefined)?.clusterIP;
  if (typeof serviceClusterIp !== 'string' || !serviceClusterIp) {
    throw new Error('EXTERNAL_DATABASE_SERVICE_INVALID');
  }
  const roleLogins: Record<string, string> = {
    owner: 'commander_owner',
    app: 'commander_app',
    'tenant-authority': 'commander_tenant_authority',
    scheduler: 'commander_scheduler',
    worker: 'commander_worker',
    'adapter-ops': 'commander_adapter_ops',
  };
  const databaseUrls = Object.fromEntries(
    Object.entries(roleLogins).map(([role, login]) => [
      `${role}-url`,
      `postgres://${login}:${encodeURIComponent(rolePasswords[role]!)}@${hostname}:5432/commander?sslmode=verify-full`,
    ]),
  );
  await applyPrivateJson(input.directory, 'external-database-urls.json', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `${input.release}-database`, namespace: NAMESPACE },
    type: 'Opaque',
    stringData: databaseUrls,
  });
  await applyPrivateJson(input.directory, 'external-bootstrap.json', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `${input.release}-bootstrap`, namespace: NAMESPACE },
    type: 'Opaque',
    stringData: {
      'bootstrap-authority-url': `postgres://postgres:${encodeURIComponent(
        rolePasswords.postgres!,
      )}@${hostname}:5432/commander?sslmode=verify-full`,
    },
  });
  requireCommand(
    await kubectl([
      'create',
      'secret',
      'generic',
      `${input.release}-database-ca`,
      '-n',
      NAMESPACE,
      `--from-file=ca.crt=${resolve(input.directory, 'ca.crt')}`,
    ]),
    'EXTERNAL_DATABASE_CA_SECRET_CREATE_FAILED',
  );
  return { serviceClusterIp, hostname };
}

async function inspectLiveProofPod(release: string, imageDigest: string): Promise<boolean> {
  const result = await kubectl([
    'get',
    'pods',
    '-n',
    NAMESPACE,
    '-l',
    `commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=${release}`,
    '-o',
    'json',
  ]);
  if (result.exitCode !== 0) return false;
  const parsed = JSON.parse(result.stdout) as { items?: unknown[] };
  if (parsed.items?.length !== 1) return false;
  const pod = parsed.items[0];
  if (!pod) return false;
  assertProofPodContract(pod, proofReaderName(NAMESPACE, release));
  const spec = (pod as { spec?: { containers?: unknown[] } }).spec;
  const containers = Array.isArray(spec?.containers) ? spec.containers : [];
  const container = containers[0] as
    | {
        image?: unknown;
        command?: unknown;
        env?: Array<{
          name?: unknown;
          valueFrom?: { secretKeyRef?: { name?: unknown; key?: unknown } };
        }>;
      }
    | undefined;
  const owner = container?.env?.find(({ name }) => name === 'COMMANDER_OWNER_DATABASE_URL');
  if (
    containers.length !== 1 ||
    container?.image !== `commander-lifecycle-api@${imageDigest}` ||
    JSON.stringify(container.command) !==
      JSON.stringify(['node', 'packages/kernel/dist/migrate.js', 'tenant-cutover-prove']) ||
    typeof owner?.valueFrom?.secretKeyRef?.name !== 'string' ||
    !owner.valueFrom.secretKeyRef.name.startsWith(`${release}-proof-owner-v`) ||
    owner.valueFrom.secretKeyRef.key !== 'owner-url'
  ) {
    throw new Error('PROOF_POD_RUNTIME_CONTRACT_INVALID');
  }
  const exposed = await kubectl([
    'get',
    'service',
    '-n',
    NAMESPACE,
    '-l',
    `commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=${release}`,
    '-o',
    'name',
  ]);
  if (exposed.exitCode !== 0 || exposed.stdout.trim()) {
    throw new Error('PROOF_POD_SERVICE_EXPOSURE_INVALID');
  }
  return true;
}

async function inspectLifecycleFailureDiagnostics(release: string): Promise<string[]> {
  const selectors = [
    `commander.io/migration-client-v2=true,commander.io/migration-release=${release}`,
    `commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=${release}`,
    `app.kubernetes.io/instance=${release}`,
  ];
  const results = await Promise.all(
    selectors.map((selector) =>
      kubectl(['logs', '-n', NAMESPACE, '-l', selector, '--all-containers=true', '--tail=100']),
    ),
  );
  return extractLifecycleFailureDiagnostics(results.map(({ stdout }) => stdout).join('\n'));
}

async function collectApiFailureLogs(release: string): Promise<string> {
  const selector = `app.kubernetes.io/instance=${release},app.kubernetes.io/component=api`;
  const results = await Promise.all([
    kubectl(['logs', '-n', NAMESPACE, '-l', selector, '--all-containers=true', '--tail=120']),
    kubectl([
      'logs',
      '-n',
      NAMESPACE,
      '-l',
      selector,
      '--all-containers=true',
      '--previous',
      '--tail=120',
    ]),
  ]);
  const text = results
    .filter(({ exitCode }) => exitCode === 0)
    .map(({ stdout }) => stdout)
    .join('\n')
    .trim();
  if (!text) return '';
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://***@***')
    .replace(/((?:password|token|secret|key)[=:])[^\s]+/gi, '$1[REDACTED]')
    .slice(-8_000);
}

async function runCutoverCommand(
  command: 'install' | 'enforce',
  release: string,
  values: string,
  requireLiveProofPod: boolean,
): Promise<{ proofPodObserved: boolean; stdout: string }> {
  const valuesText = readFileSync(values, 'utf8');
  const digest = valuesText.match(/^\s*digest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!digest) throw new Error('PRODUCTION_IMAGE_DIGEST_INVALID');
  const args = [
    'exec',
    'tsx',
    'scripts/helm-tenant-cutover.ts',
    command,
    '--namespace',
    NAMESPACE,
    '--release',
    release,
    '--values',
    values,
  ];
  const child = spawn('pnpm', args, {
    cwd: rootDir(),
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  let finished = false;
  let exitCode = -1;
  const completion = new Promise<void>((resolveCompletion, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      exitCode = code ?? 1;
      finished = true;
      resolveCompletion();
    });
  });
  let proofPodObserved = false;
  const failureDiagnostics = new Set<string>();
  let nextDiagnosticPollAt = 0;
  while (!finished) {
    const now = Date.now();
    const shouldPollDiagnostics = now >= nextDiagnosticPollAt;
    const [liveProofObserved, diagnostics] = await Promise.all([
      inspectLiveProofPod(release, digest),
      shouldPollDiagnostics ? inspectLifecycleFailureDiagnostics(release) : Promise.resolve([]),
    ]);
    proofPodObserved = liveProofObserved || proofPodObserved;
    diagnostics.forEach((diagnostic) => failureDiagnostics.add(diagnostic));
    if (shouldPollDiagnostics) nextDiagnosticPollAt = now + 100;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await completion;
  if (exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-4_000);
    const diagnosticDetail = [...failureDiagnostics].join(' ');
    throw new Error(
      `HELM_TENANT_CUTOVER_FAILED${detail ? `: ${detail}` : ''}${
        diagnosticDetail ? ` ${diagnosticDetail}` : ''
      }`,
    );
  }
  if (requireLiveProofPod && !proofPodObserved) {
    throw new Error('LIVE_PROOF_POD_NOT_OBSERVED');
  }
  return { proofPodObserved, stdout: Buffer.concat(stdout).toString('utf8') };
}

async function assertProofReaderRbac(release: string): Promise<AssertionResult[]> {
  const serviceAccount = proofReaderName(NAMESPACE, release);
  const identity = `system:serviceaccount:${NAMESPACE}:${serviceAccount}`;
  const serviceAccountObject = await kubectlJson([
    'get',
    'serviceaccount',
    serviceAccount,
    '-n',
    NAMESPACE,
  ]);
  const results: AssertionResult[] = [
    {
      description: 'proof-reader ServiceAccount disables ambient token mounting',
      passed: serviceAccountObject.automountServiceAccountToken === false,
    },
  ];
  for (const [verb, resource, resourceName, expected] of [
    ['get', 'deployments.apps', '', 'yes'],
    ['list', 'deployments.apps', '', 'yes'],
    ['get', 'replicasets.apps', '', 'yes'],
    ['list', 'replicasets.apps', '', 'yes'],
    ['get', 'pods', '', 'yes'],
    ['list', 'pods', '', 'yes'],
    ['get', 'services', `${release}-api-proof`, 'yes'],
    ['list', 'services', '', 'no'],
    ['get', 'secrets', '', 'no'],
    ['list', 'secrets', '', 'no'],
    ['create', 'pods', '', 'no'],
    ['update', 'deployments.apps', '', 'no'],
    ['create', 'networkpolicies.networking.k8s.io', '', 'no'],
    ['create', 'validatingadmissionpolicies.admissionregistration.k8s.io', '', 'no'],
    ['create', 'pods/exec', '', 'no'],
    ['create', 'pods/attach', '', 'no'],
    ['get', 'pods/log', '', 'no'],
    ['impersonate', 'users', '', 'no'],
    ['watch', 'pods', '', 'no'],
  ] as const) {
    const check = await kubectl([
      'auth',
      'can-i',
      verb,
      resource,
      ...(resourceName ? [resourceName] : []),
      '--as',
      identity,
      '-n',
      NAMESPACE,
    ]);
    results.push({
      description: `proof-reader RBAC ${verb} ${resource}${
        resourceName ? `/${resourceName}` : ''
      } is ${expected}`,
      passed: check.exitCode === 0 && check.stdout.trim() === expected,
      detail: check.stderr.trim() || undefined,
    });
  }
  if (results.some(({ passed }) => !passed)) throw new Error('PROOF_READER_RBAC_INVALID');
  return results;
}

async function waitForCanary(name: string): Promise<{ exitCode: number; reason: string }> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const pod = await kubectlJson(['get', 'pod', name, '-n', NAMESPACE]);
    const status = pod.status as
      | {
          containerStatuses?: Array<{
            state?: { terminated?: { exitCode?: number; reason?: string } };
          }>;
        }
      | undefined;
    const terminated = status?.containerStatuses?.[0]?.state?.terminated;
    if (typeof terminated?.exitCode === 'number' && typeof terminated.reason === 'string') {
      return { exitCode: terminated.exitCode, reason: terminated.reason };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('NETWORK_POLICY_CANARY_TIMEOUT');
}

async function runNetworkPolicyCanaries(
  release: string,
  imageDigest: string,
): Promise<AssertionResult[]> {
  const service = await kubectlJson(['get', 'service', `${release}-api-proof`, '-n', NAMESPACE]);
  const clusterIp = (service.spec as { clusterIP?: unknown } | undefined)?.clusterIP;
  if (typeof clusterIp !== 'string' || !clusterIp) throw new Error('API_PROOF_SERVICE_INVALID');
  const script = `const net=require('node:net');let done=false;const finish=(code)=>{if(done)return;done=true;process.exit(code)};const socket=net.connect({host:${JSON.stringify(
    clusterIp,
  )},port:9443},()=>finish(0));socket.setTimeout(5000,()=>finish(42));socket.on('error',()=>finish(43));`;
  const applyCanary = async (name: string, labelled: boolean) => {
    const labels = labelled
      ? `app.kubernetes.io/name=${release},app.kubernetes.io/instance=${release},commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=${release}`
      : 'commander.io/network-policy-negative-canary=true';
    requireCommand(
      await kubectl([
        'run',
        name,
        '-n',
        NAMESPACE,
        '--restart=Never',
        `--image=commander-lifecycle-api@${imageDigest}`,
        '--image-pull-policy=IfNotPresent',
        `--labels=${labels}`,
        '--overrides',
        JSON.stringify({ spec: { automountServiceAccountToken: false } }),
        '--command',
        '--',
        'node',
        '-e',
        script,
      ]),
      'NETWORK_POLICY_CANARY_CREATE_FAILED',
    );
  };
  await applyCanary('np-positive', true);
  await applyCanary('np-negative', false);
  const positive = await waitForCanary('np-positive');
  const negative = await waitForCanary('np-negative');
  if (positive.exitCode !== 0 || positive.reason !== 'Completed') {
    throw new Error('NETWORK_POLICY_POSITIVE_CANARY_INVALID');
  }
  assertNegativeCanaryResult(negative);
  requireCommand(
    await kubectl([
      'delete',
      'pod',
      'np-positive',
      'np-negative',
      '-n',
      NAMESPACE,
      '--wait=true',
      '--timeout=120s',
    ]),
    'NETWORK_POLICY_CANARY_CLEANUP_FAILED',
  );
  return [
    { description: 'labelled proof-reader canary reached only the proof listener', passed: true },
    { description: 'unlabelled canary was dropped until the timeout sentinel', passed: true },
  ];
}

type PostgresQueryTarget = { namespace: string; statefulSet: string };

async function lifecycleRowCount(
  target: PostgresQueryTarget,
  table: 'commander_tenant_cutover_operations' | 'commander_tenant_cutover_rollout_proofs',
): Promise<number> {
  const result = await kubectl([
    'exec',
    `statefulset/${target.statefulSet}`,
    '-n',
    target.namespace,
    '--',
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'commander',
    '--tuples-only',
    '--no-align',
    '--command',
    table === 'commander_tenant_cutover_rollout_proofs'
      ? "SELECT count(*) FROM public.commander_tenant_cutover_rollout_proofs WHERE rollout_proof_jcs::jsonb ->> 'format' = 'rollout-proof/v1'"
      : 'SELECT count(*) FROM public.commander_tenant_cutover_operations',
  ]);
  const value = requireCommand(result, 'PROOF_ROW_QUERY_FAILED').trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('LIFECYCLE_ROW_COUNT_INVALID');
  return Number(value);
}

async function proofRowCount(target: PostgresQueryTarget): Promise<number> {
  return lifecycleRowCount(target, 'commander_tenant_cutover_rollout_proofs');
}

async function operationRowCount(target: PostgresQueryTarget): Promise<number> {
  return lifecycleRowCount(target, 'commander_tenant_cutover_operations');
}

async function assertExternalRoleConnections(hostname: string): Promise<AssertionResult[]> {
  const roles = [
    ['owner', 'commander_owner', 'COMMANDER_OWNER_PASSWORD'],
    ['app', 'commander_app', 'COMMANDER_APP_PASSWORD'],
    ['tenant-authority', 'commander_tenant_authority', 'COMMANDER_TENANT_AUTHORITY_PASSWORD'],
    ['scheduler', 'commander_scheduler', 'COMMANDER_SCHEDULER_PASSWORD'],
    ['worker', 'commander_worker', 'COMMANDER_WORKER_PASSWORD'],
    ['adapter-ops', 'commander_adapter_ops', 'COMMANDER_ADAPTER_OPS_PASSWORD'],
  ] as const;
  const assertions: AssertionResult[] = [];
  for (const [role, login, passwordVariable] of roles) {
    const script = `export PGPASSWORD="$${passwordVariable}"; exec psql "host=${hostname} port=5432 dbname=commander user=${login} sslmode=verify-full sslrootcert=/run/commander/database-tls/ca.crt" --tuples-only --no-align --command 'SELECT session_user'`;
    const result = await kubectl([
      'exec',
      'statefulset/external-postgres',
      '-n',
      EXTERNAL_DATABASE_NAMESPACE,
      '--',
      'sh',
      '-ceu',
      script,
    ]);
    const passed = result.exitCode === 0 && result.stdout.trim() === login;
    assertions.push({
      description: `external TLS ${role} DSN authenticates as ${login}`,
      passed,
      detail: passed ? undefined : result.stderr.trim().slice(-2_000),
    });
  }
  if (assertions.some(({ passed }) => !passed)) {
    throw new Error('EXTERNAL_DATABASE_SIX_ROLE_AUTHENTICATION_FAILED');
  }
  return assertions;
}

async function assertEphemeralResourcesCleaned(release: string): Promise<void> {
  for (const [resources, selector] of [
    ['jobs,pods,configmaps', 'commander.io/tenant-cutover-owner-execution'],
    [
      'jobs,pods',
      `commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=${release}`,
    ],
    ['secrets', 'commander.io/tenant-authority-proof-owner=true'],
  ] as const) {
    const result = await kubectl(['get', resources, '-n', NAMESPACE, '-l', selector, '-o', 'name']);
    if (result.exitCode !== 0 || result.stdout.trim()) {
      throw new Error('EPHEMERAL_LIFECYCLE_RESOURCE_CLEANUP_FAILED');
    }
  }
}

async function helmRevision(release: string): Promise<string> {
  const output = requireCommand(
    await helm(['history', release, '-n', NAMESPACE, '-o', 'json']),
    'HELM_HISTORY_FAILED',
  );
  const history = JSON.parse(output) as Array<{ revision?: number }>;
  const revision = history.at(-1)?.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1)
    throw new Error('HELM_HISTORY_INVALID');
  return String(revision);
}

async function assertReleaseCleanup(release: string): Promise<void> {
  for (const resources of [
    'all',
    'configmaps,secrets,serviceaccounts',
    'roles,rolebindings',
    'networkpolicies',
    'persistentvolumeclaims',
  ]) {
    const result = await kubectl([
      'get',
      resources,
      '--all-namespaces',
      '-l',
      `app.kubernetes.io/instance=${release}`,
      '-o',
      'name',
    ]);
    if (result.exitCode !== 0 || result.stdout.trim()) {
      throw new Error('HELM_UNINSTALL_CLEANUP_FAILED');
    }
  }
}

async function runRealBundledLifecycle(imageDigest: string): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-live');
  const assertions: AssertionResult[] = [];
  const databaseTarget = { namespace: NAMESPACE, statefulSet: `${release}-postgres` };
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-lifecycle-'));
  try {
    requireCommand(await kubectl(namespaceCleanupArgs(NAMESPACE)), 'NAMESPACE_RESET_FAILED');
    await createNamespace();
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release);
    await createLifecycleTlsSecrets(stateDirectory, NAMESPACE, release);
    const installValues = resolve(stateDirectory, 'values-install.yaml');
    const upgradeValues = resolve(stateDirectory, 'values-upgrade.yaml');
    writeFileSync(
      installValues,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'info',
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      upgradeValues,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'warn',
      }),
      { mode: 0o600 },
    );

    const installed = await runCutoverCommand('install', release, installValues, true);
    assertions.push({
      description: 'fresh bundled install used an observed live proof Pod',
      passed: installed.proofPodObserved,
    });
    requireCommand(
      await waitForDeployment(`${release}-api`, '10m'),
      'API_DEPLOYMENT_NOT_AVAILABLE',
    );
    const firstProofCount = await proofRowCount(databaseTarget);
    assertions.push({
      description: 'post-install challenged API proof appended a durable proof row',
      passed: firstProofCount >= 1,
      detail: `proofRows=${firstProofCount}`,
    });
    const firstRevision = await helmRevision(release);

    const upgraded = await runCutoverCommand('enforce', release, upgradeValues, true);
    const secondProofCount = await proofRowCount(databaseTarget);
    const secondRevision = await helmRevision(release);
    assertions.push(
      {
        description: 'changed enforce configuration executed a real Helm upgrade',
        passed: BigInt(secondRevision) > BigInt(firstRevision),
        detail: `revision=${firstRevision}->${secondRevision}`,
      },
      {
        description: 'post-upgrade challenged API proof appended another proof row',
        passed: upgraded.proofPodObserved && secondProofCount > firstProofCount,
        detail: `proofRows=${firstProofCount}->${secondProofCount}`,
      },
    );

    await runCutoverCommand('enforce', release, upgradeValues, false);
    const noOpRevision = await helmRevision(release);
    const noOpProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'proven current command did not create another Helm revision',
        passed: noOpRevision === secondRevision,
      },
      {
        description: 'proven current command performed another challenged API proof',
        passed: noOpProofCount > secondProofCount,
        detail: `proofRows=${secondProofCount}->${noOpProofCount}`,
      },
    );

    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    assertions.push({
      description: 'owner Jobs, proof Jobs, Pods, ConfigMaps, and owner Secrets were cleaned',
      passed: true,
    });
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    await assertReleaseCleanup(release);
    assertions.push({
      description: 'Helm uninstall removed every release-owned object',
      passed: true,
    });

    return {
      name: 'real-bundled-install-upgrade-current-uninstall',
      passed: aggregateScenarioChecks({ assertions, rbac, networkPolicy }),
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      rbac,
      networkPolicy,
    };
  } catch (error) {
    const diagnostics = await kubectl(['get', 'pods,jobs', '-n', NAMESPACE, '-o', 'wide']);
    const apiLogs = await collectApiFailureLogs(release);
    return {
      name: 'real-bundled-install-upgrade-current-uninstall',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }${apiLogs ? `\nAPI_FAILURE_LOGS\n${apiLogs}` : ''}`,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function runRealExternalTlsLifecycle(imageDigest: string): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-external');
  const assertions: AssertionResult[] = [];
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-external-'));
  const databaseTarget = {
    namespace: EXTERNAL_DATABASE_NAMESPACE,
    statefulSet: 'external-postgres',
  };
  try {
    for (const namespace of [NAMESPACE, EXTERNAL_DATABASE_NAMESPACE]) {
      requireCommand(await kubectl(namespaceCleanupArgs(namespace)), 'NAMESPACE_RESET_FAILED');
      await createNamespace(namespace);
    }
    const hostname = `external-postgres.${EXTERNAL_DATABASE_NAMESPACE}.svc.cluster.local`;
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release, [
      'external-postgres',
      `external-postgres.${EXTERNAL_DATABASE_NAMESPACE}.svc`,
      hostname,
    ]);
    await createApiProofSecrets(stateDirectory, NAMESPACE, release);
    const external = await createExternalDatabaseFixture({ directory: stateDirectory, release });
    const installValues = resolve(stateDirectory, 'values-install.yaml');
    const upgradeValues = resolve(stateDirectory, 'values-upgrade.yaml');
    const database = {
      kind: 'external' as const,
      secretName: `${release}-database`,
      caSecret: `${release}-database-ca`,
      bootstrapAuthoritySecret: `${release}-bootstrap`,
      serviceNamespace: EXTERNAL_DATABASE_NAMESPACE,
      serviceName: 'external-postgres',
      serviceClusterIp: external.serviceClusterIp,
    };
    writeFileSync(
      installValues,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'info',
        database,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      upgradeValues,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'warn',
        database,
      }),
      { mode: 0o600 },
    );

    const installed = await runCutoverCommand('install', release, installValues, true);
    requireCommand(
      await waitForDeployment(`${release}-api`, '10m'),
      'API_DEPLOYMENT_NOT_AVAILABLE',
    );
    const firstProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'external TLS install observed the real in-cluster proof Pod',
        passed: installed.proofPodObserved,
      },
      {
        description: 'external TLS post-install challenge appended a proof row',
        passed: firstProofCount >= 1,
        detail: `proofRows=${firstProofCount}`,
      },
      ...(await assertExternalRoleConnections(external.hostname)),
    );
    const firstRevision = await helmRevision(release);
    const upgraded = await runCutoverCommand('enforce', release, upgradeValues, true);
    const secondRevision = await helmRevision(release);
    const secondProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'external TLS enforce changed the Helm revision',
        passed: BigInt(secondRevision) > BigInt(firstRevision),
      },
      {
        description: 'external TLS post-upgrade challenge appended another proof row',
        passed: upgraded.proofPodObserved && secondProofCount > firstProofCount,
        detail: `proofRows=${firstProofCount}->${secondProofCount}`,
      },
    );
    await runCutoverCommand('enforce', release, upgradeValues, false);
    const currentRevision = await helmRevision(release);
    const currentProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'external proven-current command created no Helm revision',
        passed: currentRevision === secondRevision,
      },
      {
        description: 'external proven-current command appended a fresh challenged proof',
        passed: currentProofCount > secondProofCount,
      },
    );
    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    await assertReleaseCleanup(release);
    requireCommand(
      await kubectl(namespaceCleanupArgs(EXTERNAL_DATABASE_NAMESPACE)),
      'EXTERNAL_DATABASE_CLEANUP_FAILED',
    );
    const externalNamespace = await kubectl([
      'get',
      'namespace',
      EXTERNAL_DATABASE_NAMESPACE,
      '-o',
      'name',
    ]);
    if (externalNamespace.exitCode === 0) throw new Error('EXTERNAL_DATABASE_CLEANUP_FAILED');
    assertions.push({
      description: 'external lifecycle release and fixture namespace were cleaned',
      passed: true,
    });
    return {
      name: 'real-external-tls-install-upgrade-current-uninstall',
      passed: aggregateScenarioChecks({ assertions, rbac, networkPolicy }),
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      rbac,
      networkPolicy,
    };
  } catch (error) {
    const diagnostics = await kubectl(['get', 'pods,jobs', '-A', '-o', 'wide']);
    const apiLogs = await collectApiFailureLogs(release);
    return {
      name: 'real-external-tls-install-upgrade-current-uninstall',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }${apiLogs ? `\nAPI_FAILURE_LOGS\n${apiLogs}` : ''}`,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function runFailedRolloutRecovery(imageDigest: string): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-recovery');
  const assertions: AssertionResult[] = [];
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-recovery-'));
  const databaseTarget = { namespace: NAMESPACE, statefulSet: `${release}-postgres` };
  try {
    requireCommand(await kubectl(namespaceCleanupArgs(NAMESPACE)), 'NAMESPACE_RESET_FAILED');
    await createNamespace();
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release);
    await createLifecycleTlsSecrets(stateDirectory, NAMESPACE, release, 'postgres.key');
    const values = resolve(stateDirectory, 'values.yaml');
    writeFileSync(
      values,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'info',
      }),
      { mode: 0o600 },
    );
    let firstFailure: unknown;
    try {
      await runCutoverCommand('install', release, values, false);
    } catch (error) {
      firstFailure = error;
    }
    if (
      !(firstFailure instanceof Error) ||
      !/HELM_TENANT_CUTOVER_FAILED/.test(firstFailure.message)
    ) {
      throw new Error('ROLLOUT_FAILURE_NOT_OBSERVED');
    }
    const operationCountAfterFailure = await operationRowCount(databaseTarget);
    const proofCountAfterFailure = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'mismatched API proof key caused a real failed Helm rollout',
        passed: true,
      },
      {
        description: 'failed rollout committed one operation and no rollout proof',
        passed: operationCountAfterFailure === 1 && proofCountAfterFailure === 0,
        detail: `operations=${operationCountAfterFailure},proofRows=${proofCountAfterFailure}`,
      },
    );

    await replaceApiProofPrivateSecret(stateDirectory, NAMESPACE, release);
    const recovered = await runCutoverCommand('install', release, values, true);
    requireCommand(
      await waitForDeployment(`${release}-api`, '10m'),
      'RECOVERED_API_DEPLOYMENT_NOT_AVAILABLE',
    );
    const operationCountAfterRetry = await operationRowCount(databaseTarget);
    const proofCountAfterRetry = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'exact failed-rollout retry reused the existing operation row',
        passed: operationCountAfterRetry === operationCountAfterFailure,
        detail: `operations=${operationCountAfterFailure}->${operationCountAfterRetry}`,
      },
      {
        description: 'recovered rollout ran the challenged proof Job and appended a proof row',
        passed: recovered.proofPodObserved && proofCountAfterRetry > proofCountAfterFailure,
        detail: `proofRows=${proofCountAfterFailure}->${proofCountAfterRetry}`,
      },
    );
    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    await assertReleaseCleanup(release);
    assertions.push({
      description: 'recovered release and every ephemeral owner/proof resource were cleaned',
      passed: true,
    });
    return {
      name: 'failed-rollout-exact-retry-recovery',
      passed: aggregateScenarioChecks({ assertions, rbac, networkPolicy }),
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      rbac,
      networkPolicy,
    };
  } catch (error) {
    const diagnostics = await kubectl(['get', 'pods,jobs', '-n', NAMESPACE, '-o', 'wide']);
    const apiLogs = await collectApiFailureLogs(release);
    return {
      name: 'failed-rollout-exact-retry-recovery',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }${apiLogs ? `\nAPI_FAILURE_LOGS\n${apiLogs}` : ''}`,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function runAll(opts: HarnessOptions): Promise<HarnessEvidence> {
  const selectedScenarios = selectLifecycleScenarios(opts.scenarioFilter);
  assertHelmVersion(requireCommand(await helm(['version', '--short']), 'HELM_VERSION_FAILED'));
  const imageDigest = opts.reuseProductionImage
    ? await inspectReusableProductionImage()
    : await buildProductionImage();

  if (!kindClusterExists(CLUSTER_NAME)) {
    await createKindCluster(CLUSTER_NAME);
  }
  await loadPinnedRuntimeImages();
  await installCalico();
  await loadProductionImage(imageDigest);
  await ensureControlPlaneReady();
  const runners: Record<
    LifecycleScenarioName,
    (selectedDigest: string) => Promise<ScenarioEvidence>
  > = {
    'real-bundled': runRealBundledLifecycle,
    'real-external-tls': runRealExternalTlsLifecycle,
    'failed-rollout-recovery': runFailedRolloutRecovery,
  };
  const scenarios: ScenarioEvidence[] = [];
  for (const scenario of selectedScenarios) {
    scenarios.push(await runners[scenario](imageDigest));
  }
  const rbac = scenarios.flatMap((scenario) => scenario.rbac ?? []);
  const networkPolicy = scenarios.flatMap((scenario) => scenario.networkPolicy ?? []);
  const rolloutRecovery = scenarios.find(
    ({ name }) => name === 'failed-rollout-exact-retry-recovery',
  );

  if (!opts.keepCluster) {
    await deleteKindCluster(CLUSTER_NAME);
  }

  const rawEvidence: HarnessEvidence = {
    generatedAt: new Date().toISOString(),
    cluster: CLUSTER_NAME,
    kindNodeImage: process.env.COMMANDER_KIND_NODE_IMAGE ?? KIND_NODE_IMAGE,
    chartPath: opts.chart,
    calicoUrl: CALICO_URL,
    scenarios,
    rbac,
    networkPolicy,
    rolloutRecovery,
    passed: aggregateScenarioPass(scenarios),
    sanitized: false,
  };

  const evidence = sanitizeEvidence(rawEvidence);
  evidence.sanitized = true;

  const evidencePath = resolve(rootDir(), 'kind-lifecycle-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(`Evidence written to ${evidencePath}\n`);

  return evidence;
}

function parseArgs(): HarnessOptions {
  const args = process.argv.slice(2);
  const chartIndex = args.indexOf('--chart');
  const keepIndex = args.indexOf('--keep-cluster');
  const reuseProductionImageIndex = args.indexOf('--reuse-production-image');
  const scenarioIndex = args.indexOf('--scenario');
  return {
    chart:
      chartIndex >= 0 ? args[chartIndex + 1] : resolve(rootDir(), 'deploy', 'helm', 'commander'),
    keepCluster: keepIndex >= 0,
    reuseProductionImage: reuseProductionImageIndex >= 0,
    scenarioFilter: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined,
  };
}

export { runAll };

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const opts = parseArgs();
    const evidence = await runAll(opts);
    process.exitCode = evidence.passed ? 0 : 1;
  })().catch((error) => {
    process.stderr.write(
      `harness failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
