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
import { dump, load } from 'js-yaml';
import { isAllowedHelmDiagnosticCode } from './helm-diagnostic-policy.js';
import { defaultCommand } from './helm-tenant-cutover.js';
import {
  createTask1KubectlPorts,
  loadTask1PrerequisiteCommandContext,
  renderTask1AdmissionPair,
  runTask1AdmissionAdministrator,
  runTask1PrerequisiteOperator,
} from './task1-helm-prerequisite-command.js';

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

export function productionImageBuildArguments(sourceRevision: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error('PRODUCTION_IMAGE_SOURCE_REVISION_INVALID');
  }
  return [
    'buildx',
    'build',
    '--load',
    '--tag',
    PRODUCTION_IMAGE,
    '--build-arg',
    'COMMANDER_SOURCE_REVISION=' + sourceRevision,
  ];
}

export function productionImageSourceRevision(
  env: Pick<NodeJS.ProcessEnv, 'GITHUB_SHA'>,
  readHead: () => string,
): string {
  const sourceRevision = env.GITHUB_SHA?.trim() || readHead().trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error('PRODUCTION_IMAGE_SOURCE_REVISION_INVALID');
  }
  return sourceRevision;
}

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

export function serviceAccountTokenArgs(token: string, commandArgs: readonly string[]): string[] {
  if (!token || /\s/.test(token)) throw new Error('TENANT_POLICY_OPERATOR_TOKEN_INVALID');
  return ['--token', token, ...commandArgs];
}

export function tokenOnlyKubeconfig(server: string, certificateAuthorityData: string): string {
  try {
    const endpoint = new URL(server);
    if (
      endpoint.protocol !== 'https:' ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !['', '/'].includes(endpoint.pathname)
    ) {
      throw new Error('TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID');
    }
  } catch {
    throw new Error('TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID');
  }
  const decodedCertificateAuthority = Buffer.from(certificateAuthorityData, 'base64');
  if (
    decodedCertificateAuthority.length === 0 ||
    decodedCertificateAuthority.toString('base64') !== certificateAuthorityData
  ) {
    throw new Error('TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID');
  }
  return dump(
    {
      apiVersion: 'v1',
      clusters: [
        {
          cluster: {
            'certificate-authority-data': certificateAuthorityData,
            server,
          },
          name: 'operator-cluster',
        },
      ],
      contexts: [
        {
          context: { cluster: 'operator-cluster', user: 'operator-token' },
          name: 'operator-token',
        },
      ],
      'current-context': 'operator-token',
      kind: 'Config',
      users: [{ name: 'operator-token', user: {} }],
    },
    { noRefs: true, sortKeys: true },
  );
}

export function operatorKubectlArgs(
  token: string,
  kubeconfigPath: string,
  commandArgs: readonly string[],
): string[] {
  if (!kubeconfigPath.startsWith('/') || /\0/.test(kubeconfigPath)) {
    throw new Error('TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID');
  }
  return ['--kubeconfig', kubeconfigPath, ...serviceAccountTokenArgs(token, commandArgs)];
}

export function prerequisiteAdmissionCleanupCommands(name: string): string[][] {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/.test(name)) {
    throw new Error('TENANT_POLICY_ADMISSION_NAME_INVALID');
  }
  return [
    'validatingadmissionpolicybindings.admissionregistration.k8s.io',
    'validatingadmissionpolicies.admissionregistration.k8s.io',
  ].map((resource) => ['delete', resource, name, '--ignore-not-found=true', '--wait=true']);
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

export function proofReaderCanIArgs(input: {
  verb: string;
  resource: string;
  resourceName: string;
  identity: string;
  namespace: string;
}): string[] {
  return [
    'auth',
    'can-i',
    input.verb,
    input.resourceName ? input.resource + '/' + input.resourceName : input.resource,
    '--as',
    input.identity,
    '-n',
    input.namespace,
  ];
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
  kubernetesApiServiceIp: string;
  kubernetesApiEndpointIp: string;
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
    !/^[a-f0-9]{64}$/.test(input.databaseSpkiSha256) ||
    !isIpv4Address(input.kubernetesApiServiceIp) ||
    !isIpv4Address(input.kubernetesApiEndpointIp)
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
      ? `    databaseCidrs:\n      - ${database.serviceClusterIp}/32\n`
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
  enabled: true
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
  migrationOperator:
    subject: system:serviceaccount:${input.namespace}:tenant-migration-operator
  egress:
${databaseCidrs}    kubernetesApiCidrs:
      - ${input.kubernetesApiServiceIp}/32
      - ${input.kubernetesApiEndpointIp}/32
  databaseEndpoints:
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
  const tokens = sources
    .map((source) =>
      source && typeof source === 'object'
        ? (source as { serviceAccountToken?: Record<string, unknown> }).serviceAccountToken
        : undefined,
    )
    .filter((token): token is Record<string, unknown> => token !== undefined);
  const identityToken = tokens.find(
    (token) => token.audience === 'commander-tenant-cutover-proof/v1',
  );
  const apiToken = tokens.find((token) => !Object.hasOwn(token, 'audience'));
  if (
    spec?.serviceAccountName !== expectedServiceAccount ||
    spec.automountServiceAccountToken !== false ||
    tokens.length !== 2 ||
    identityToken?.expirationSeconds !== 600 ||
    identityToken.path !== 'identity-token' ||
    apiToken?.expirationSeconds !== 600 ||
    apiToken.path !== 'api-token'
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
  errorCode?: string;
}

export interface ScenarioEvidence {
  name: string;
  passed: boolean;
  durationMs: number;
  events: Record<string, unknown>[];
  assertions: AssertionResult[];
  failedStage?: LifecycleFailureStage;
  rbac?: AssertionResult[];
  networkPolicy?: AssertionResult[];
  error?: string;
}

export type LifecycleFailureStage =
  | 'namespace-reset'
  | 'namespace-create'
  | 'certificate-material'
  | 'tls-secrets'
  | 'external-database-fixture'
  | 'lifecycle-values'
  | 'cutover-install'
  | 'api-ready'
  | 'network-prerequisites'
  | 'cutover-enforce'
  | 'current-proof'
  | 'post-cutover-validation'
  | 'helm-uninstall'
  | 'release-cleanup'
  | 'recovery-failed-install'
  | 'recovery-retry';

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
  image?: {
    digest: string;
    sourceRevision?: string;
  };
  ownerFailureEvidence?: OwnerFailureEvidence[];
  passed: boolean;
  sanitized: boolean;
}

export interface SanitizedScenarioEvidence {
  name: string;
  passed: boolean;
  durationMs: number;
  failedStage?: LifecycleFailureStage;
  failureCodes?: string[];
  admissionRbacFailure?: AdmissionRbacFailureEvidence;
  failedChecks?: SanitizedCheckFailure[];
  rolloutFailure?: RolloutFailureEvidence;
  rolloutObservation?: RolloutNonterminalEvidence | RolloutQueryEvidence;
  apiStartupFailure?: ApiPodStartupFailureEvidence;
}

interface AdmissionRbacFailureEvidence {
  verb: 'create' | 'update' | 'patch' | 'delete' | 'list' | 'watch';
  resource:
    | 'validatingadmissionpolicies.admissionregistration.k8s.io'
    | 'validatingadmissionpolicybindings.admissionregistration.k8s.io';
}

const ADMISSION_RBAC_FAILURES = {
  TENANT_POLICY_ADMISSION_RBAC_POLICY_CREATE_ALLOWED: {
    verb: 'create',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_POLICY_UPDATE_ALLOWED: {
    verb: 'update',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_POLICY_PATCH_ALLOWED: {
    verb: 'patch',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_POLICY_DELETE_ALLOWED: {
    verb: 'delete',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_POLICY_LIST_ALLOWED: {
    verb: 'list',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_POLICY_WATCH_ALLOWED: {
    verb: 'watch',
    resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_CREATE_ALLOWED: {
    verb: 'create',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_UPDATE_ALLOWED: {
    verb: 'update',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_PATCH_ALLOWED: {
    verb: 'patch',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_DELETE_ALLOWED: {
    verb: 'delete',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_LIST_ALLOWED: {
    verb: 'list',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
  TENANT_POLICY_ADMISSION_RBAC_BINDING_WATCH_ALLOWED: {
    verb: 'watch',
    resource: 'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  },
} as const satisfies Record<string, AdmissionRbacFailureEvidence>;

type SanitizedCheckGroup = 'scenario' | 'rbac' | 'networkPolicy';

interface SanitizedCheckFailure {
  group: SanitizedCheckGroup;
  index: number;
}

export interface SanitizedHarnessEvidence {
  generatedAt: string;
  cluster: string;
  kindNodeImage: string;
  calicoUrl: string;
  scenarios: SanitizedScenarioEvidence[];
  image?: {
    digest: string;
    sourceRevision?: string;
  };
  ownerFailureEvidence?: OwnerFailureEvidence[];
  passed: boolean;
  sanitized: true;
}

export interface OwnerFailureEvidence {
  code: string;
  producer: 'owner_entrypoint';
  transport: 'kubectl_logs' | 'kubectl_logs_unavailable';
  ownerStage?: OwnerMigrationFailureStage;
  proofCode?: 'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID';
  proofInvariant?: string;
  snapshot?: 's0' | 's1';
  catalogStep?: OwnerMigrationCatalogStep;
  snapshotTransaction?: 'begin' | 'commit';
  snapshotValidation?: OwnerMigrationSnapshotValidation;
  originClassificationStep?: OwnerMigrationOriginClassificationStep;
  migration?: string;
  phase?: 'baseline' | 'lifecycle' | 'expand' | 'enforce';
  sqlstate?: string;
  logSha256: string;
}

const API_POD_STARTUP_CODES = [
  'COMMANDER_TENANT_AUTHORITY_PROOF_PORT_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE_INVALID',
  'COMMANDER_TENANT_AUTHORITY_PROOF_PORT_INVALID',
  'COMMANDER_TENANT_AUTHORITY_PROOF_CERT_FILE_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_PROOF_KEY_FILE_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_PROOF_DNS_NAME_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256_REQUIRED',
  'DATABASE_URL_REQUIRED',
  'COMMANDER_TENANT_AUTHORITY_DATABASE_URL_REQUIRED',
  'TASK1_READINESS_TLS_PATH_INVALID',
  'TASK1_READINESS_PROOF_DNS_NAME_INVALID',
  'TASK1_READINESS_RUNTIME_IDENTITY_INVALID',
  'TASK1_READINESS_DATABASE_URLS_MUST_BE_DISTINCT',
  'TASK1_READINESS_APP_DATABASE_URL_INVALID',
  'TASK1_READINESS_APP_DATABASE_ROLE_INVALID',
  'TASK1_READINESS_AUTHORITY_DATABASE_URL_INVALID',
  'TASK1_READINESS_AUTHORITY_DATABASE_ROLE_INVALID',
  'TASK1_READINESS_FILE_OWNERSHIP_UNSUPPORTED',
  'TASK1_READINESS_CERT_FILE_INVALID',
  'TASK1_READINESS_KEY_FILE_INVALID',
  'TASK1_READINESS_CERT_FILE_MODE_INVALID',
  'TASK1_READINESS_KEY_FILE_MODE_INVALID',
  'TASK1_READINESS_CERT_FILE_OWNER_INVALID',
  'TASK1_READINESS_KEY_FILE_OWNER_INVALID',
  'TASK1_READINESS_TLS_MATERIAL_INVALID',
  'TASK1_DATABASE_IDENTITY_INVALID',
  'COMMANDER_API_STARTUP_FAILED',
  'COMMANDER_API_RUNTIME_MODULE_NOT_FOUND',
  'TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED',
] as const;

type ApiPodStartupCode = (typeof API_POD_STARTUP_CODES)[number];
const API_POD_TERMINATION_REASONS = [
  'ContainerCannotRun',
  'Error',
  'OOMKilled',
  'StartError',
] as const;
type ApiPodTerminationReason = (typeof API_POD_TERMINATION_REASONS)[number];

interface ApiPodTerminationFacts {
  terminationReason: ApiPodTerminationReason;
  exitCode: number;
}

export interface ApiPodStartupFailureEvidence {
  code: ApiPodStartupCode;
  producer: 'api_entrypoint';
  transport: 'kubectl_logs' | 'kubectl_logs_unavailable';
  terminationReason?: ApiPodTerminationReason;
  exitCode?: number;
  logSha256: string;
}

export type RolloutResourceKind = 'Deployment' | 'Job' | 'Pod';
export type RolloutComponent =
  | 'api'
  | 'worker'
  | 'kernel-ops'
  | 'adapter-ops'
  | 'postgres'
  | 'redis'
  | 'migration'
  | 'tenant-cutover-proof';
export type RolloutReasonCode =
  | 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED'
  | 'JOB_DEADLINE_EXCEEDED'
  | 'JOB_BACKOFF_LIMIT_EXCEEDED'
  | 'POD_UNSCHEDULABLE'
  | 'POD_IMAGE_PULL_FAILED'
  | 'POD_CONTAINER_CONFIG_ERROR'
  | 'POD_CONTAINER_START_FAILED'
  | 'POD_OOM_KILLED'
  | 'POD_CRASH_LOOP_BACKOFF';
export type RolloutNonterminalReasonCode =
  'DEPLOYMENT_UNAVAILABLE' | 'JOB_ACTIVE' | 'POD_NOT_READY';

export interface RolloutFailureEvidence {
  code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED';
  resourceKind: RolloutResourceKind;
  component: RolloutComponent;
  reasonCode: RolloutReasonCode;
}

export interface RolloutEmptyEvidence {
  code: 'TENANT_CUTOVER_ROLLOUT_EMPTY';
}

export interface RolloutNonterminalResourceEvidence {
  code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL';
  resourceKind: RolloutResourceKind;
  component: RolloutComponent;
  reasonCode: RolloutNonterminalReasonCode;
}

export type RolloutNonterminalEvidence = RolloutEmptyEvidence | RolloutNonterminalResourceEvidence;

export interface RolloutQueryEvidence {
  code: 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' | 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT';
}

export type RolloutObservation =
  | { kind: 'terminal'; evidence: RolloutFailureEvidence }
  | { kind: 'success'; evidence?: RolloutNonterminalEvidence }
  | { kind: 'query-failure'; code: RolloutQueryEvidence['code'] };

export interface RolloutObservationState {
  terminal?: RolloutFailureEvidence;
  nonterminal?: RolloutNonterminalEvidence;
  queryFailure?: RolloutQueryEvidence;
}

// A rendered release's status response legitimately exceeds 64 KiB. The observer
// retains it only in-process and emits a finite classification, never the response.
const ROLLOUT_OBSERVATION_MAX_BYTES = 1024 * 1024;
const ROLLOUT_OBSERVATION_MAX_ITEMS = 64;
const ROLLOUT_COMPONENTS: readonly RolloutComponent[] = [
  'api',
  'worker',
  'kernel-ops',
  'adapter-ops',
  'postgres',
  'redis',
  'migration',
  'tenant-cutover-proof',
];
const ROLLOUT_RESOURCE_KINDS: readonly RolloutResourceKind[] = ['Deployment', 'Job', 'Pod'];
const ROLLOUT_REASON_CODES: readonly RolloutReasonCode[] = [
  'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED',
  'JOB_DEADLINE_EXCEEDED',
  'JOB_BACKOFF_LIMIT_EXCEEDED',
  'POD_UNSCHEDULABLE',
  'POD_IMAGE_PULL_FAILED',
  'POD_CONTAINER_CONFIG_ERROR',
  'POD_CONTAINER_START_FAILED',
  'POD_OOM_KILLED',
  'POD_CRASH_LOOP_BACKOFF',
];
const ROLLOUT_NONTERMINAL_REASON_CODES: readonly RolloutNonterminalReasonCode[] = [
  'DEPLOYMENT_UNAVAILABLE',
  'JOB_ACTIVE',
  'POD_NOT_READY',
];
const ROLLOUT_FAILURE_RECORD = new RegExp(
  '(?:^|:)TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=(Deployment|Job|Pod);component=(api|worker|kernel-ops|adapter-ops|postgres|redis|migration|tenant-cutover-proof);reason_code=(DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED|JOB_DEADLINE_EXCEEDED|JOB_BACKOFF_LIMIT_EXCEEDED|POD_UNSCHEDULABLE|POD_IMAGE_PULL_FAILED|POD_CONTAINER_CONFIG_ERROR|POD_CONTAINER_START_FAILED|POD_OOM_KILLED|POD_CRASH_LOOP_BACKOFF)(?=\\n|$)',
);
const ROLLOUT_NONTERMINAL_RECORD = new RegExp(
  '(?:^|:)TENANT_CUTOVER_ROLLOUT_NONTERMINAL:resource_kind=(Deployment|Job|Pod);component=(api|worker|kernel-ops|adapter-ops|postgres|redis|migration|tenant-cutover-proof);reason_code=(DEPLOYMENT_UNAVAILABLE|JOB_ACTIVE|POD_NOT_READY)(?=\\n|$)',
);
const ROLLOUT_OBSERVATION_CODE_RECORD = new RegExp(
  '(?:^|:)(TENANT_CUTOVER_ROLLOUT_QUERY_FAILED|TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT|TENANT_CUTOVER_ROLLOUT_EMPTY)(?=\\n|$)',
);

type OwnerMigrationFailureStage =
  | 'input'
  | 'proof_runtime'
  | 'bootstrap_kernel'
  | 'bootstrap_closure'
  | 'owner_pool_configuration'
  | 'owner_pool_connect'
  | 'bootstrap_context'
  | 'bootstrap_context_authority_url'
  | 'bootstrap_context_pool_configuration'
  | 'bootstrap_context_pool_connect'
  | 'bootstrap_context_catalog_query'
  | 'bootstrap_context_pool_close'
  | 'lifecycle_initialize'
  | 'lifecycle_pinned_manifest_validation'
  | 'lifecycle_prepared_request_validation'
  | 'lifecycle_table_discovery'
  | 'lifecycle_candidate_peer_observation'
  | 'lifecycle_candidate_peer_validation'
  | 'lifecycle_prebootstrap_snapshot'
  | 'lifecycle_prebootstrap_snapshot_comparison'
  | 'lifecycle_initialization_planning'
  | 'lifecycle_descriptor_transaction'
  | 'lifecycle_peer_reobservation'
  | 'lifecycle_peer_reobservation_input_consistency'
  | 'lifecycle_peer_reobservation_candidate_binding_validation'
  | 'lifecycle_peer_reobservation_observed_binding_validation'
  | 'lifecycle_peer_reobservation_binding_consistency'
  | 'lifecycle_transaction'
  | 'current_read'
  | 'rollout_proof';

type OwnerMigrationCatalogStep =
  | 'search_path'
  | 'identity'
  | 'ledger'
  | 'namespaces'
  | 'relations'
  | 'functions'
  | 'types'
  | 'extensions'
  | 'policies'
  | 'triggers'
  | 'roles'
  | 'memberships'
  | 'role_settings'
  | 'database_acl'
  | 'schema_acls'
  | 'default_acls'
  | 'product_has_rows';

type OwnerMigrationSnapshotValidation =
  | 'bootstrap_validation'
  | 'identity_validation'
  | 'product_source_validation'
  | 'catalog_version_validation'
  | 'origin_classification';

type OwnerMigrationOriginClassificationStep =
  'fresh_catalog_shape' | 'role_envelope' | 'role_attributes' | 'memberships' | 'public_acl';

const OWNER_FAILURE_STAGE =
  '(input|proof_runtime|bootstrap_kernel|bootstrap_closure|owner_pool_configuration|owner_pool_connect|bootstrap_context|bootstrap_context_authority_url|bootstrap_context_pool_configuration|bootstrap_context_pool_connect|bootstrap_context_catalog_query|bootstrap_context_pool_close|lifecycle_initialize|lifecycle_pinned_manifest_validation|lifecycle_prepared_request_validation|lifecycle_table_discovery|lifecycle_candidate_peer_observation|lifecycle_candidate_peer_validation|lifecycle_prebootstrap_snapshot|lifecycle_prebootstrap_snapshot_comparison|lifecycle_initialization_planning|lifecycle_descriptor_transaction|lifecycle_peer_reobservation|lifecycle_peer_reobservation_input_consistency|lifecycle_peer_reobservation_candidate_binding_validation|lifecycle_peer_reobservation_observed_binding_validation|lifecycle_peer_reobservation_binding_consistency|lifecycle_transaction|current_read|rollout_proof)';
const OWNER_FAILURE_CATALOG_STEP =
  '(search_path|identity|ledger|namespaces|relations|functions|types|extensions|policies|triggers|roles|memberships|role_settings|database_acl|schema_acls|default_acls|product_has_rows)';
const OWNER_FAILURE_SNAPSHOT_TRANSACTION = '(begin|commit)';
const OWNER_FAILURE_SNAPSHOT_VALIDATION =
  '(bootstrap_validation|identity_validation|product_source_validation|catalog_version_validation|origin_classification)';
const OWNER_FAILURE_ORIGIN_CLASSIFICATION_STEP =
  '(fresh_catalog_shape|role_envelope|role_attributes|memberships|public_acl)';
const PROOF_OWNER_FAILURE_RECORD =
  /(?:^|:)code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=(kubectl_logs|kubectl_logs_unavailable);owner_stage=rollout_proof;proof_code=(TENANT_CUTOVER_KUBERNETES_PROOF_INVALID);proof_invariant=(task1KubernetesProofObserver\.(?:ts|js):[1-9][0-9]*:[1-9][0-9]*);log_sha256=([a-f0-9]{64})(?=\n|$)/;
const OWNER_FAILURE_RECORD = new RegExp(
  '(?:^|:)code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=(kubectl_logs|kubectl_logs_unavailable)' +
    '(?:;owner_stage=' +
    OWNER_FAILURE_STAGE +
    ')?(?:;snapshot=(s0|s1)(?:;catalog_step=' +
    OWNER_FAILURE_CATALOG_STEP +
    '|;snapshot_transaction=' +
    OWNER_FAILURE_SNAPSHOT_TRANSACTION +
    '|;snapshot_validation=' +
    OWNER_FAILURE_SNAPSHOT_VALIDATION +
    '(?:;origin_classification_step=' +
    OWNER_FAILURE_ORIGIN_CLASSIFICATION_STEP +
    ')?' +
    ')' +
    ')?(?:;migration=([0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]+\\.[a-z0-9_]+);phase=(baseline|lifecycle|expand|enforce);sqlstate=([0-9A-Z]{5}))?;log_sha256=([a-f0-9]{64})(?=\\n|$)',
);
const GENERIC_OWNER_FAILURE_RECORD = new RegExp(
  '(?:^|:)code=((?:COMMANDER|TASK1|TENANT_CUTOVER)_[A-Z0-9_]{1,80});producer=owner_entrypoint;transport=(kubectl_logs|kubectl_logs_unavailable);log_sha256=([a-f0-9]{64})(?=\\n|$)',
);
const API_POD_STARTUP_FAILURE_RECORD = new RegExp(
  '(?:^|:)TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=(' +
    API_POD_STARTUP_CODES.join('|') +
    ');producer=api_entrypoint;transport=(kubectl_logs|kubectl_logs_unavailable)(?:;termination_reason=(' +
    API_POD_TERMINATION_REASONS.join('|') +
    ');exit_code=([0-9]{1,3}))?;log_sha256=([a-f0-9]{64})(?=;|\\n|$)',
);
const SCENARIO_FAILURE_CODE =
  /\b(?:COMMANDER|TASK1|TENANT_POLICY|TENANT_CUTOVER|HELM)_[A-Z0-9_]{1,80}\b/g;
const LIFECYCLE_FAILURE_CODES = new Set([
  'API_DEPLOYMENT_NOT_AVAILABLE',
  'API_PROOF_SERVICE_INVALID',
  'EPHEMERAL_LIFECYCLE_RESOURCE_CLEANUP_FAILED',
  'EXTERNAL_DATABASE_CLEANUP_FAILED',
  'EXTERNAL_DATABASE_SERVICE_INVALID',
  'EXTERNAL_DATABASE_SIX_ROLE_AUTHENTICATION_FAILED',
  'HELM_HISTORY_FAILED',
  'HELM_HISTORY_INVALID',
  'HELM_UNINSTALL_CLEANUP_FAILED',
  'HELM_UNINSTALL_FAILED',
  'KUBECTL_JSON_FAILED',
  'KUBECTL_JSON_INVALID',
  'LIFECYCLE_ROW_COUNT_INVALID',
  'NAMESPACE_RESET_FAILED',
  'NETWORK_POLICY_CANARY_CLEANUP_FAILED',
  'NETWORK_POLICY_CANARY_CREATE_FAILED',
  'NETWORK_POLICY_CANARY_TIMEOUT',
  'NETWORK_POLICY_POSITIVE_CANARY_INVALID',
  'PROOF_READER_RBAC_INVALID',
  'PROOF_ROW_QUERY_FAILED',
  'RECOVERED_API_DEPLOYMENT_NOT_AVAILABLE',
  'ROLLOUT_FAILURE_NOT_OBSERVED',
]);

function scenarioFailureCodes(error: string | undefined): string[] | undefined {
  if (!error) return undefined;
  const firstLine = error.split('\n', 1)[0] ?? '';
  const fixedCode = firstLine.match(/^([A-Z][A-Z0-9_]{1,95})(?::|$)/)?.[1];
  const codes = [
    ...new Set([
      ...(firstLine.match(SCENARIO_FAILURE_CODE) ?? []).filter(isAllowedHelmDiagnosticCode),
      ...(fixedCode && LIFECYCLE_FAILURE_CODES.has(fixedCode) ? [fixedCode] : []),
    ]),
  ].slice(0, 8);
  return codes.length > 0 ? codes : undefined;
}

function parseAdmissionRbacFailure(error: string): AdmissionRbacFailureEvidence | undefined {
  const code = error.split(':', 1)[0];
  if (!code) return undefined;
  return Object.entries(ADMISSION_RBAC_FAILURES).find(([candidate]) => candidate === code)?.[1];
}

function failedCheckEvidence(
  group: SanitizedCheckGroup,
  checks: readonly AssertionResult[] | undefined,
): SanitizedCheckFailure[] {
  if (!checks) return [];
  return checks.reduce<SanitizedCheckFailure[]>((failed, check, index) => {
    if (!check.passed) failed.push({ group, index: index + 1 });
    return failed;
  }, []);
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function hasExactValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function rolloutComponent(
  metadata: Record<string, unknown> | undefined,
): RolloutComponent | undefined {
  const labels = jsonRecord(metadata?.labels);
  if (!labels) return undefined;
  if (labels['commander.io/migration-client-v2'] === 'true') return 'migration';
  if (labels['commander.io/tenant-authority-proof-reader'] === 'true') {
    return 'tenant-cutover-proof';
  }
  return hasExactValue(labels['app.kubernetes.io/component'], ROLLOUT_COMPONENTS)
    ? labels['app.kubernetes.io/component']
    : undefined;
}

function conditionReason(
  status: Record<string, unknown> | undefined,
  type: string,
  state: string,
): string | undefined {
  const conditions = jsonArray(status?.conditions);
  if (!conditions) return undefined;
  for (const candidate of conditions) {
    const condition = jsonRecord(candidate);
    if (
      condition?.type === type &&
      condition.status === state &&
      typeof condition.reason === 'string'
    ) {
      return condition.reason;
    }
  }
  return undefined;
}

function hasCondition(
  status: Record<string, unknown> | undefined,
  type: string,
  state: string,
): boolean {
  const conditions = jsonArray(status?.conditions);
  return (
    conditions?.some((candidate) => {
      const condition = jsonRecord(candidate);
      return condition?.type === type && condition.status === state;
    }) ?? false
  );
}

function podWaitingReason(status: Record<string, unknown> | undefined): string | undefined {
  for (const field of ['initContainerStatuses', 'containerStatuses']) {
    const containers = jsonArray(status?.[field]);
    if (!containers) continue;
    for (const candidate of containers) {
      const container = jsonRecord(candidate);
      const state = jsonRecord(container?.state);
      const waiting = jsonRecord(state?.waiting);
      if (typeof waiting?.reason === 'string') return waiting.reason;
    }
  }
  return undefined;
}

function podLastTerminationReason(status: Record<string, unknown> | undefined): string | undefined {
  for (const field of ['initContainerStatuses', 'containerStatuses'] as const) {
    const containers = status?.[field];
    if (!Array.isArray(containers)) continue;
    for (const candidate of containers) {
      const container = jsonRecord(candidate);
      const lastState = jsonRecord(container?.lastState);
      const terminated = jsonRecord(lastState?.terminated);
      if (typeof terminated?.reason === 'string') return terminated.reason;
    }
  }
  return undefined;
}

/** Extracts the fixed, non-sensitive termination facts for the API container only. */
export function apiPodTerminationFacts(status: unknown): ApiPodTerminationFacts | undefined {
  const containerStatuses = jsonArray(jsonRecord(status)?.containerStatuses);
  const apiContainer = containerStatuses
    ?.map((candidate) => jsonRecord(candidate))
    .find((candidate) => candidate?.name === 'api');
  const lastState = jsonRecord(apiContainer?.lastState);
  const currentState = jsonRecord(apiContainer?.state);
  const terminated = jsonRecord(lastState?.terminated) ?? jsonRecord(currentState?.terminated);
  const reason = terminated?.reason;
  const exitCode = terminated?.exitCode;
  if (
    !hasExactValue(reason, API_POD_TERMINATION_REASONS) ||
    typeof exitCode !== 'number' ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  ) {
    return undefined;
  }
  return { terminationReason: reason, exitCode };
}

function rolloutReasonForItem(
  resourceKind: RolloutResourceKind,
  status: Record<string, unknown> | undefined,
): RolloutReasonCode | undefined {
  if (resourceKind === 'Deployment') {
    return conditionReason(status, 'Progressing', 'False') === 'ProgressDeadlineExceeded'
      ? 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED'
      : undefined;
  }
  if (resourceKind === 'Job') {
    const reason = conditionReason(status, 'Failed', 'True');
    if (reason === 'DeadlineExceeded') return 'JOB_DEADLINE_EXCEEDED';
    if (reason === 'BackoffLimitExceeded') return 'JOB_BACKOFF_LIMIT_EXCEEDED';
    return undefined;
  }
  if (conditionReason(status, 'PodScheduled', 'False') === 'Unschedulable') {
    return 'POD_UNSCHEDULABLE';
  }
  switch (podWaitingReason(status)) {
    case 'ErrImagePull':
    case 'ImagePullBackOff':
      return 'POD_IMAGE_PULL_FAILED';
    case 'CreateContainerConfigError':
    case 'CreateContainerError':
      return 'POD_CONTAINER_CONFIG_ERROR';
    case 'RunContainerError':
      return 'POD_CONTAINER_START_FAILED';
    case 'CrashLoopBackOff':
      return podLastTerminationReason(status) === 'OOMKilled'
        ? 'POD_OOM_KILLED'
        : 'POD_CRASH_LOOP_BACKOFF';
    default:
      return undefined;
  }
}

function rolloutNonterminalReasonForItem(
  resourceKind: RolloutResourceKind,
  status: Record<string, unknown> | undefined,
): RolloutNonterminalReasonCode | undefined {
  if (resourceKind === 'Deployment') {
    return hasCondition(status, 'Available', 'False') ? 'DEPLOYMENT_UNAVAILABLE' : undefined;
  }
  if (resourceKind === 'Job') {
    return typeof status?.active === 'number' && status.active > 0 ? 'JOB_ACTIVE' : undefined;
  }
  return hasCondition(status, 'Ready', 'False') ? 'POD_NOT_READY' : undefined;
}

/** Selects a failed API pod deterministically so diagnostics never use a healthy replica. */
export function selectFailingApiPodName(items: readonly unknown[]): string | undefined {
  return items
    .map((item) => jsonRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .filter((item) => rolloutReasonForItem('Pod', jsonRecord(item.status)) !== undefined)
    .map((item) => jsonRecord(item.metadata)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort()[0];
}

function classifyRolloutFailureItem(value: unknown): RolloutFailureEvidence | undefined {
  const item = jsonRecord(value);
  if (!item || !hasExactValue(item.kind, ROLLOUT_RESOURCE_KINDS)) return undefined;
  const component = rolloutComponent(jsonRecord(item.metadata));
  const reasonCode = rolloutReasonForItem(item.kind, jsonRecord(item.status));
  if (!component || !reasonCode) return undefined;
  return {
    code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
    resourceKind: item.kind,
    component,
    reasonCode,
  };
}

function classifyRolloutNonterminalItem(
  value: unknown,
): RolloutNonterminalResourceEvidence | undefined {
  const item = jsonRecord(value);
  if (!item || !hasExactValue(item.kind, ROLLOUT_RESOURCE_KINDS)) return undefined;
  const component = rolloutComponent(jsonRecord(item.metadata));
  const reasonCode = rolloutNonterminalReasonForItem(item.kind, jsonRecord(item.status));
  if (!component || !reasonCode) return undefined;
  return {
    code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
    resourceKind: item.kind,
    component,
    reasonCode,
  };
}

function rolloutFailurePriority(value: RolloutFailureEvidence): number {
  switch (value.reasonCode) {
    case 'POD_UNSCHEDULABLE':
      return 0;
    case 'POD_IMAGE_PULL_FAILED':
      return 1;
    case 'POD_CONTAINER_CONFIG_ERROR':
      return 2;
    case 'POD_CONTAINER_START_FAILED':
      return 3;
    case 'POD_CRASH_LOOP_BACKOFF':
      return 4;
    case 'JOB_DEADLINE_EXCEEDED':
      return 5;
    case 'JOB_BACKOFF_LIMIT_EXCEEDED':
      return 6;
    case 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED':
      return 7;
  }
}

function rolloutFailureKey(value: RolloutFailureEvidence): string {
  return value.resourceKind + '/' + value.component + '/' + value.reasonCode;
}

function rolloutResourcePriority(value: { resourceKind: RolloutResourceKind }): number {
  switch (value.resourceKind) {
    case 'Pod':
      return 0;
    case 'Job':
      return 1;
    case 'Deployment':
      return 2;
  }
}

function compareRolloutEvidence(
  left: { resourceKind: RolloutResourceKind; component: RolloutComponent; reasonCode: string },
  right: { resourceKind: RolloutResourceKind; component: RolloutComponent; reasonCode: string },
): number {
  return (
    rolloutResourcePriority(left) - rolloutResourcePriority(right) ||
    left.component.localeCompare(right.component) ||
    left.reasonCode.localeCompare(right.reasonCode)
  );
}

function selectRolloutEvidence<
  T extends {
    resourceKind: RolloutResourceKind;
    component: RolloutComponent;
    reasonCode: string;
  },
>(values: readonly T[]): T | undefined {
  return values.reduce<T | undefined>(
    (selected, candidate) =>
      selected === undefined || compareRolloutEvidence(candidate, selected) < 0
        ? candidate
        : selected,
    undefined,
  );
}

/** Retains a single canonical observation across Helm's atomic rollback window. */
export function retainRolloutFailureEvidence(
  previous: RolloutFailureEvidence | undefined,
  candidate: RolloutFailureEvidence | undefined,
): RolloutFailureEvidence | undefined {
  if (!candidate) return previous;
  if (!previous) return candidate;
  const candidatePriority = rolloutFailurePriority(candidate);
  const previousPriority = rolloutFailurePriority(previous);
  if (candidatePriority < previousPriority) return candidate;
  if (candidatePriority > previousPriority) return previous;
  return rolloutFailureKey(candidate) < rolloutFailureKey(previous) ? candidate : previous;
}

/** Parses Kubernetes status JSON and returns only a fixed rollout-failure vocabulary. */
export function classifyRolloutFailureJson(value: string): RolloutFailureEvidence | undefined {
  const observation = classifyRolloutObservation({ exitCode: 0, stdout: value, stderr: '' });
  return observation.kind === 'terminal' ? observation.evidence : undefined;
}

/** Classifies one bounded kubectl observation into a finite safe vocabulary. */
export function classifyRolloutObservation(result: CommandResult): RolloutObservation {
  if (result.exitCode !== 0) {
    return {
      kind: 'query-failure',
      code:
        result.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT'
          : 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED',
    };
  }
  if (Buffer.byteLength(result.stdout) > ROLLOUT_OBSERVATION_MAX_BYTES) {
    return { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' };
  }
  const root = jsonRecord(parsed);
  const items = jsonArray(root?.items);
  if (!items || items.length > ROLLOUT_OBSERVATION_MAX_ITEMS) {
    return { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' };
  }
  if (items.length === 0) {
    return { kind: 'success', evidence: { code: 'TENANT_CUTOVER_ROLLOUT_EMPTY' } };
  }
  const terminal = selectRolloutEvidence(
    items.flatMap((item) => {
      const evidence = classifyRolloutFailureItem(item);
      return evidence === undefined ? [] : [evidence];
    }),
  );
  if (terminal) return { kind: 'terminal', evidence: terminal };
  const nonterminal = selectRolloutEvidence(
    items.flatMap((item) => {
      const evidence = classifyRolloutNonterminalItem(item);
      return evidence === undefined ? [] : [evidence];
    }),
  );
  return { kind: 'success', ...(nonterminal ? { evidence: nonterminal } : {}) };
}

/** Retains terminal evidence; successful polls replace all nonterminal state. */
export function retainRolloutObservation(
  previous: RolloutObservationState | undefined,
  candidate: RolloutObservation,
): RolloutObservationState {
  if (previous?.terminal) return previous;
  if (candidate.kind === 'terminal') return { terminal: candidate.evidence };
  if (candidate.kind === 'success') {
    return candidate.evidence ? { nonterminal: candidate.evidence } : {};
  }
  return { queryFailure: { code: candidate.code } };
}

/** Extracts the strict rollout record and never returns raw Kubernetes fields. */
export function parseRolloutFailureEvidence(error: string): RolloutFailureEvidence | undefined {
  const match = error.match(ROLLOUT_FAILURE_RECORD);
  if (!match) return undefined;
  const [, resourceKind, component, reasonCode] = match;
  if (
    !hasExactValue(resourceKind, ROLLOUT_RESOURCE_KINDS) ||
    !hasExactValue(component, ROLLOUT_COMPONENTS) ||
    !hasExactValue(reasonCode, ROLLOUT_REASON_CODES)
  ) {
    return undefined;
  }
  return {
    code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
    resourceKind,
    component,
    reasonCode,
  };
}

function parseRolloutObservationEvidence(
  error: string,
): RolloutNonterminalEvidence | RolloutQueryEvidence | undefined {
  const nonterminal = error.match(ROLLOUT_NONTERMINAL_RECORD);
  if (nonterminal) {
    const [, resourceKind, component, reasonCode] = nonterminal;
    if (
      hasExactValue(resourceKind, ROLLOUT_RESOURCE_KINDS) &&
      hasExactValue(component, ROLLOUT_COMPONENTS) &&
      hasExactValue(reasonCode, ROLLOUT_NONTERMINAL_REASON_CODES)
    ) {
      return {
        code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
        resourceKind,
        component,
        reasonCode,
      };
    }
  }
  const code = error.match(ROLLOUT_OBSERVATION_CODE_RECORD)?.[1];
  return code === 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' ||
    code === 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' ||
    code === 'TENANT_CUTOVER_ROLLOUT_EMPTY'
    ? { code }
    : undefined;
}

function rolloutFailureRecord(value: RolloutFailureEvidence): string {
  return (
    'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=' +
    value.resourceKind +
    ';component=' +
    value.component +
    ';reason_code=' +
    value.reasonCode
  );
}

function rolloutObservationRecord(
  value: RolloutNonterminalEvidence | RolloutQueryEvidence,
): string {
  return value.code === 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL'
    ? value.code +
        ':resource_kind=' +
        value.resourceKind +
        ';component=' +
        value.component +
        ';reason_code=' +
        value.reasonCode
    : value.code;
}

/** Extract only the canonical owner diagnostic record, never the original error text. */
export function parseOwnerFailureEvidence(error: string): OwnerFailureEvidence | undefined {
  const proof = error.match(PROOF_OWNER_FAILURE_RECORD);
  if (proof) {
    return {
      code: 'COMMANDER_MIGRATION_FAILED',
      producer: 'owner_entrypoint',
      transport: proof[1] as OwnerFailureEvidence['transport'],
      ownerStage: 'rollout_proof',
      proofCode: proof[2] as OwnerFailureEvidence['proofCode'],
      proofInvariant: proof[3]!,
      logSha256: proof[4]!,
    };
  }
  const match = OWNER_FAILURE_RECORD.exec(error);
  if (!match) {
    const generic = error.match(GENERIC_OWNER_FAILURE_RECORD);
    if (!generic) return undefined;
    if (!isAllowedHelmDiagnosticCode(generic[1]!)) return undefined;
    return {
      code: generic[1] as OwnerFailureEvidence['code'],
      producer: 'owner_entrypoint',
      transport: generic[2] as OwnerFailureEvidence['transport'],
      logSha256: generic[3]!,
    };
  }
  const [
    ,
    transport,
    ownerStage,
    snapshot,
    catalogStep,
    snapshotTransaction,
    snapshotValidation,
    originClassificationStep,
    migration,
    phase,
    sqlstate,
    logSha256,
  ] = match;
  const evidence: OwnerFailureEvidence = {
    code: 'COMMANDER_MIGRATION_FAILED',
    producer: 'owner_entrypoint',
    transport: transport as OwnerFailureEvidence['transport'],
    logSha256,
  };
  if (ownerStage) evidence.ownerStage = ownerStage as OwnerMigrationFailureStage;
  if (snapshot && catalogStep) {
    evidence.snapshot = snapshot as OwnerFailureEvidence['snapshot'];
    evidence.catalogStep = catalogStep as OwnerMigrationCatalogStep;
  } else if (snapshot && snapshotTransaction) {
    evidence.snapshot = snapshot as OwnerFailureEvidence['snapshot'];
    evidence.snapshotTransaction =
      snapshotTransaction as OwnerFailureEvidence['snapshotTransaction'];
  } else if (snapshot && snapshotValidation) {
    evidence.snapshot = snapshot as OwnerFailureEvidence['snapshot'];
    evidence.snapshotValidation = snapshotValidation as OwnerMigrationSnapshotValidation;
    if (snapshotValidation === 'origin_classification' && originClassificationStep) {
      evidence.originClassificationStep =
        originClassificationStep as OwnerMigrationOriginClassificationStep;
    }
  }
  if (migration && phase && sqlstate) {
    evidence.migration = migration;
    evidence.phase = phase as OwnerFailureEvidence['phase'];
    evidence.sqlstate = sqlstate;
  }
  return evidence;
}

/** Re-emits only the parsed owner fields after the harness discards child-process output. */
export function ownerFailureEvidenceRecord(value: OwnerFailureEvidence): string {
  return [
    'code=' + value.code,
    'producer=' + value.producer,
    'transport=' + value.transport,
    ...(value.ownerStage ? ['owner_stage=' + value.ownerStage] : []),
    ...(value.proofCode ? ['proof_code=' + value.proofCode] : []),
    ...(value.proofInvariant ? ['proof_invariant=' + value.proofInvariant] : []),
    ...(value.snapshot ? ['snapshot=' + value.snapshot] : []),
    ...(value.catalogStep ? ['catalog_step=' + value.catalogStep] : []),
    ...(value.snapshotTransaction ? ['snapshot_transaction=' + value.snapshotTransaction] : []),
    ...(value.snapshotValidation ? ['snapshot_validation=' + value.snapshotValidation] : []),
    ...(value.originClassificationStep
      ? ['origin_classification_step=' + value.originClassificationStep]
      : []),
    ...(value.migration ? ['migration=' + value.migration] : []),
    ...(value.phase ? ['phase=' + value.phase] : []),
    ...(value.sqlstate ? ['sqlstate=' + value.sqlstate] : []),
    'log_sha256=' + value.logSha256,
  ].join(';');
}

/** Converts the prior API container output to a fixed code and digest without retaining the output. */
export function apiPodStartupFailureDiagnostic(
  logs: string,
  transport: ApiPodStartupFailureEvidence['transport'] = 'kubectl_logs',
  termination?: ApiPodTerminationFacts,
): string {
  const tail = logs.slice(-4_096);
  const startupCode = [
    ...(tail.match(/\b(?:(?:COMMANDER|TASK1)_[A-Z0-9_]{1,80}|DATABASE_URL_REQUIRED)\b/g) ?? []),
  ]
    .reverse()
    .find((candidate): candidate is ApiPodStartupCode =>
      API_POD_STARTUP_CODES.includes(candidate as ApiPodStartupCode),
    );
  const code =
    startupCode ??
    (tail.includes('ERR_MODULE_NOT_FOUND') ? 'COMMANDER_API_RUNTIME_MODULE_NOT_FOUND' : undefined);
  return (
    'code=' +
    (code ?? 'TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED') +
    ';producer=api_entrypoint;transport=' +
    transport +
    (termination
      ? ';termination_reason=' +
        termination.terminationReason +
        ';exit_code=' +
        termination.exitCode
      : '') +
    ';log_sha256=' +
    createHash('sha256').update(tail).digest('hex')
  );
}

function apiPodLogsAreUnclassified(logs: string): boolean {
  return apiPodStartupFailureDiagnostic(logs).startsWith(
    'code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;',
  );
}

/** Prefers the current container output only when the terminated container has no safe startup code. */
export function selectApiPodStartupLogs(previousLogs: string, currentLogs: string): string {
  return apiPodLogsAreUnclassified(previousLogs) ? currentLogs : previousLogs;
}

function parseApiPodStartupFailureEvidence(
  error: string,
): ApiPodStartupFailureEvidence | undefined {
  const match = error.match(API_POD_STARTUP_FAILURE_RECORD);
  if (!match) return undefined;
  const [, code, transport, terminationReason, exitCode, logSha256] = match;
  if (!hasExactValue(code, API_POD_STARTUP_CODES)) return undefined;
  const parsedExitCode = exitCode === undefined ? undefined : Number(exitCode);
  if (
    (terminationReason === undefined) !== (parsedExitCode === undefined) ||
    (terminationReason !== undefined &&
      (!hasExactValue(terminationReason, API_POD_TERMINATION_REASONS) ||
        !Number.isInteger(parsedExitCode) ||
        parsedExitCode < 0 ||
        parsedExitCode > 255))
  ) {
    return undefined;
  }
  return {
    code,
    producer: 'api_entrypoint',
    transport: transport as ApiPodStartupFailureEvidence['transport'],
    ...(terminationReason !== undefined && exitCode !== undefined
      ? { terminationReason, exitCode: parsedExitCode! }
      : {}),
    logSha256,
  };
}

function apiPodStartupFailureRecord(value: ApiPodStartupFailureEvidence): string {
  return (
    'TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=' +
    value.code +
    ';producer=' +
    value.producer +
    ';transport=' +
    value.transport +
    (value.terminationReason !== undefined && value.exitCode !== undefined
      ? ';termination_reason=' + value.terminationReason + ';exit_code=' + value.exitCode
      : '') +
    ';log_sha256=' +
    value.logSha256
  );
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

export function sanitizeEvidence(evidence: HarnessEvidence): SanitizedHarnessEvidence {
  return {
    generatedAt: evidence.generatedAt,
    cluster: evidence.cluster,
    kindNodeImage: evidence.kindNodeImage,
    calicoUrl: evidence.calicoUrl,
    ...(evidence.image
      ? {
          image: {
            digest: evidence.image.digest,
            ...(evidence.image.sourceRevision
              ? { sourceRevision: evidence.image.sourceRevision }
              : {}),
          },
        }
      : {}),
    scenarios: evidence.scenarios.map(
      ({ name, passed, durationMs, failedStage, assertions, rbac, networkPolicy, error }) => {
        const safeFailureCodes = [
          ...new Set([
            ...(rbac?.some(({ passed }) => !passed) ? ['PROOF_READER_RBAC_INVALID'] : []),
            ...(scenarioFailureCodes(error) ?? []),
          ]),
        ];
        const failedChecks = [
          ...failedCheckEvidence('scenario', assertions),
          ...failedCheckEvidence('rbac', rbac),
          ...failedCheckEvidence('networkPolicy', networkPolicy),
        ];
        const rolloutFailure = error ? parseRolloutFailureEvidence(error) : undefined;
        const rolloutObservation = error ? parseRolloutObservationEvidence(error) : undefined;
        const apiStartupFailure = error ? parseApiPodStartupFailureEvidence(error) : undefined;
        const admissionRbacFailure = error ? parseAdmissionRbacFailure(error) : undefined;
        return {
          name,
          passed,
          durationMs,
          ...(failedStage ? { failedStage } : {}),
          ...(safeFailureCodes.length > 0 ? { failureCodes: safeFailureCodes } : {}),
          ...(admissionRbacFailure ? { admissionRbacFailure } : {}),
          ...(failedChecks.length > 0 ? { failedChecks } : {}),
          ...(rolloutFailure
            ? {
                rolloutFailure: {
                  code: rolloutFailure.code,
                  resourceKind: rolloutFailure.resourceKind,
                  component: rolloutFailure.component,
                  reasonCode: rolloutFailure.reasonCode,
                },
              }
            : {}),
          ...(rolloutObservation
            ? {
                rolloutObservation:
                  rolloutObservation.code === 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL'
                    ? {
                        code: rolloutObservation.code,
                        resourceKind: rolloutObservation.resourceKind,
                        component: rolloutObservation.component,
                        reasonCode: rolloutObservation.reasonCode,
                      }
                    : { code: rolloutObservation.code },
              }
            : {}),
          ...(apiStartupFailure ? { apiStartupFailure } : {}),
        };
      },
    ),
    ...(evidence.ownerFailureEvidence
      ? {
          ownerFailureEvidence: evidence.ownerFailureEvidence.map((failure) => ({
            code: failure.code,
            producer: failure.producer,
            transport: failure.transport,
            ...(failure.ownerStage ? { ownerStage: failure.ownerStage } : {}),
            ...(failure.proofCode ? { proofCode: failure.proofCode } : {}),
            ...(failure.proofInvariant ? { proofInvariant: failure.proofInvariant } : {}),
            ...(failure.snapshot ? { snapshot: failure.snapshot } : {}),
            ...(failure.catalogStep ? { catalogStep: failure.catalogStep } : {}),
            ...(failure.snapshotTransaction
              ? { snapshotTransaction: failure.snapshotTransaction }
              : {}),
            ...(failure.snapshotValidation
              ? { snapshotValidation: failure.snapshotValidation }
              : {}),
            ...(failure.originClassificationStep
              ? { originClassificationStep: failure.originClassificationStep }
              : {}),
            ...(failure.migration ? { migration: failure.migration } : {}),
            ...(failure.phase ? { phase: failure.phase } : {}),
            ...(failure.sqlstate ? { sqlstate: failure.sqlstate } : {}),
            logSha256: failure.logSha256,
          })),
        }
      : {}),
    passed: evidence.passed,
    sanitized: true,
  };
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
        ...(error && typeof error.code === 'string' ? { errorCode: error.code } : {}),
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
  const revision = productionImageSourceRevision(process.env, () =>
    requireCommand(
      runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir() }),
      'PRODUCTION_IMAGE_SOURCE_REVISION_INVALID',
    ),
  );
  const build = await runCmd('docker', [
    ...productionImageBuildArguments(revision),
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
  process.env.COMMANDER_LIFECYCLE_IMAGE_SOURCE_REVISION = revision;
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

function kubectl(args: string[], options: ExecFileOptions = {}): Promise<CommandResult> {
  return runCmd('kubectl', args, options);
}

function helm(args: string[]): Promise<CommandResult> {
  return runCmd('helm', args);
}

async function currentClusterTokenOnlyKubeconfig(): Promise<string> {
  try {
    const server = requireCommand(
      await kubectl([
        'config',
        'view',
        '--minify',
        '--raw',
        '--output=jsonpath={.clusters[0].cluster.server}',
      ]),
      'TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID',
    ).trim();
    const certificateAuthorityData = requireCommand(
      await kubectl([
        'config',
        'view',
        '--minify',
        '--raw',
        '--output=jsonpath={.clusters[0].cluster.certificate-authority-data}',
      ]),
      'TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID',
    ).trim();
    return tokenOnlyKubeconfig(server, certificateAuthorityData);
  } catch {
    throw new Error('TENANT_POLICY_OPERATOR_KUBECONFIG_INVALID');
  }
}

async function prepareNetworkPrerequisites(
  release: string,
  valuesPath: string,
  apiProofSpkiSha256: string,
): Promise<() => Promise<void>> {
  const subject = 'system:serviceaccount:' + NAMESPACE + ':tenant-migration-operator';
  const resolvedValuesPath = valuesPath + '.network-prerequisites';
  const operatorKubeconfigPath = resolvedValuesPath + '.operator-kubeconfig';
  try {
    const resolvedValues = requireCommand(
      await helm(['get', 'values', release, '-n', NAMESPACE, '--all', '-o', 'yaml']),
      'TENANT_POLICY_RELEASE_VALUES_FAILED',
    );
    const parsedValues = load(resolvedValues) as Record<string, unknown>;
    const tenantAuthority = parsedValues.tenantAuthority as Record<string, unknown>;
    const apiProof = tenantAuthority.apiProof as Record<string, unknown>;
    const networkPolicy = parsedValues.networkPolicy as Record<string, unknown>;
    const chartContentSha256 = tenantAuthority.chartContentSha256;
    const proofPort = apiProof.port;
    if (
      typeof chartContentSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(chartContentSha256) ||
      typeof proofPort !== 'number' ||
      !Number.isSafeInteger(proofPort) ||
      proofPort < 1 ||
      proofPort > 65535 ||
      !/^[a-f0-9]{64}$/.test(apiProofSpkiSha256)
    ) {
      throw new Error('TENANT_POLICY_RELEASE_VALUES_INVALID');
    }
    tenantAuthority.platformBinding = { chartContentSha256 };
    tenantAuthority.apiProof = {
      ...apiProof,
      publicCertificateSpkiSha256: apiProofSpkiSha256,
      serviceName: release + '-api-proof',
      servicePort: proofPort,
      targetPort: proofPort,
      podSelector: {
        'app.kubernetes.io/name': release,
        'app.kubernetes.io/instance': release,
        'app.kubernetes.io/component': 'api',
      },
      dnsSan: release + '-api-proof.' + NAMESPACE + '.svc.cluster.local',
    };
    networkPolicy.clusterDomain = 'cluster.local';
    writeFileSync(resolvedValuesPath, dump(parsedValues, { noRefs: true, sortKeys: true }), {
      mode: 0o600,
    });
    const args = [
      '--namespace',
      NAMESPACE,
      '--release',
      release,
      '--values',
      resolvedValuesPath,
      '--stage',
      'network',
      '--migration-operator-subject',
      subject,
    ];
    const context = await loadTask1PrerequisiteCommandContext(args, rootDir());
    const admissionName = renderTask1AdmissionPair(context, 'network').policy.metadata.name;
    const cleanupAdmission = async (): Promise<void> => {
      for (const commandArgs of prerequisiteAdmissionCleanupCommands(admissionName)) {
        await defaultCommand('kubectl', commandArgs);
      }
    };
    const adminPorts = createTask1KubectlPorts((commandArgs, stdin) =>
      defaultCommand('kubectl', commandArgs, stdin),
    );
    try {
      await runTask1AdmissionAdministrator(context, adminPorts);

      const token = requireCommand(
        await kubectl([
          'create',
          'token',
          'tenant-migration-operator',
          '-n',
          NAMESPACE,
          '--duration=10m',
        ]),
        'TENANT_POLICY_OPERATOR_TOKEN_FAILED',
      ).trim();
      if (!token) throw new Error('TENANT_POLICY_OPERATOR_TOKEN_FAILED');
      writeFileSync(operatorKubeconfigPath, await currentClusterTokenOnlyKubeconfig(), {
        mode: 0o600,
      });
      const operatorPorts = createTask1KubectlPorts(
        (commandArgs, stdin) =>
          defaultCommand(
            'kubectl',
            operatorKubectlArgs(token, operatorKubeconfigPath, commandArgs),
            stdin,
          ),
        async () => token,
      );
      const deadline = Date.now() + 120_000;
      while (true) {
        try {
          await runTask1PrerequisiteOperator(context, operatorPorts);
          return cleanupAdmission;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'TENANT_POLICY_ADMISSION_NOT_READY' ||
            Date.now() >= deadline
          ) {
            throw error;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        }
      }
    } catch (error) {
      await cleanupAdmission();
      throw error;
    }
  } finally {
    rmSync(resolvedValuesPath, { force: true });
    rmSync(operatorKubeconfigPath, { force: true });
  }
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

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

async function kubernetesApiServiceIp(): Promise<string> {
  const service = await kubectlJson(['get', 'service', 'kubernetes', '-n', 'default']);
  const clusterIp = (service.spec as { clusterIP?: unknown } | undefined)?.clusterIP;
  if (typeof clusterIp !== 'string' || !isIpv4Address(clusterIp)) {
    throw new Error('KUBERNETES_API_SERVICE_INVALID');
  }
  return clusterIp;
}

async function kubernetesApiEndpointIp(): Promise<string> {
  const nodes = await kubectlJson(['get', 'nodes', '-l', 'node-role.kubernetes.io/control-plane']);
  const items = Array.isArray(nodes.items) ? nodes.items : [];
  const addresses = (items[0] as { status?: { addresses?: unknown[] } } | undefined)?.status
    ?.addresses;
  const internalIps = Array.isArray(addresses)
    ? addresses
        .filter(
          (address): address is { type: string; address: string } =>
            !!address &&
            typeof address === 'object' &&
            (address as { type?: unknown }).type === 'InternalIP' &&
            typeof (address as { address?: unknown }).address === 'string',
        )
        .map((address) => address.address)
        .filter(isIpv4Address)
    : [];
  if (items.length !== 1 || internalIps.length !== 1) {
    throw new Error('KUBERNETES_API_ENDPOINT_INVALID');
  }
  return internalIps[0]!;
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
): { databaseSpkiSha256: string; apiProofSpkiSha256: string } {
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
  return {
    databaseSpkiSha256: certificateSpkiSha256(resolve(directory, 'postgres.crt')),
    apiProofSpkiSha256: certificateSpkiSha256(resolve(directory, 'api-proof.crt')),
  };
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

async function observeLiveRolloutFailure(release: string): Promise<RolloutObservation> {
  const result = await kubectl(
    [
      'get',
      'deployments,jobs,pods',
      '-n',
      NAMESPACE,
      '-l',
      'app.kubernetes.io/instance=' + release,
      '-o',
      'json',
    ],
    { maxBuffer: ROLLOUT_OBSERVATION_MAX_BYTES },
  );
  return classifyRolloutObservation(result);
}

async function captureApiPodStartupFailure(
  release: string,
  observation: RolloutObservation,
): Promise<ApiPodStartupFailureEvidence | undefined> {
  if (
    observation.kind !== 'terminal' ||
    observation.evidence.resourceKind !== 'Pod' ||
    observation.evidence.component !== 'api' ||
    observation.evidence.reasonCode !== 'POD_CRASH_LOOP_BACKOFF'
  ) {
    return undefined;
  }
  const pods = await kubectl(
    [
      'get',
      'pods',
      '-n',
      NAMESPACE,
      '-l',
      'app.kubernetes.io/instance=' + release + ',app.kubernetes.io/component=api',
      '-o',
      'json',
    ],
    { maxBuffer: ROLLOUT_OBSERVATION_MAX_BYTES },
  );
  if (pods.exitCode !== 0) return undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = jsonRecord(JSON.parse(pods.stdout));
  } catch {
    return undefined;
  }
  const podItems = jsonArray(parsed?.items) ?? [];
  const podName = selectFailingApiPodName(podItems);
  if (!podName) return undefined;
  const pod = podItems
    .map((item) => jsonRecord(item))
    .find((item) => jsonRecord(item?.metadata)?.name === podName);
  const termination = apiPodTerminationFacts(pod?.status);
  let logs = await kubectl(
    ['logs', podName, '-c', 'api', '--previous', '-n', NAMESPACE, '--tail=80'],
    { maxBuffer: 16 * 1024 },
  );
  if (logs.exitCode !== 0 || apiPodLogsAreUnclassified(logs.stdout)) {
    const currentLogs = await kubectl(
      ['logs', podName, '-c', 'api', '-n', NAMESPACE, '--tail=80'],
      { maxBuffer: 16 * 1024 },
    );
    if (currentLogs.exitCode === 0) {
      logs = {
        ...currentLogs,
        stdout: selectApiPodStartupLogs(logs.exitCode === 0 ? logs.stdout : '', currentLogs.stdout),
      };
    }
  }
  const transport: ApiPodStartupFailureEvidence['transport'] =
    logs.exitCode === 0 ? 'kubectl_logs' : 'kubectl_logs_unavailable';
  const diagnostic = apiPodStartupFailureDiagnostic(
    logs.exitCode === 0 ? logs.stdout : '',
    transport,
    termination,
  );
  return parseApiPodStartupFailureEvidence('TENANT_CUTOVER_API_POD_STARTUP_FAILED:' + diagnostic);
}

async function runCutoverCommand(
  command: 'install' | 'enforce',
  release: string,
  values: string,
): Promise<void> {
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
  const stderr: Buffer[] = [];
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
  let rolloutObservation: RolloutObservationState | undefined;
  let apiStartupFailure: ApiPodStartupFailureEvidence | undefined;
  while (!finished) {
    const observedFailure = await observeLiveRolloutFailure(release);
    rolloutObservation = retainRolloutObservation(rolloutObservation, observedFailure);
    apiStartupFailure ??= await captureApiPodStartupFailure(release, observedFailure);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await completion;
  if (exitCode !== 0) {
    const childFailure = Buffer.concat(stderr).toString('utf8');
    const childCodes = scenarioFailureCodes(childFailure) ?? [];
    const ownerFailure = parseOwnerFailureEvidence(childFailure);
    const failureCodes = [...new Set(['HELM_TENANT_CUTOVER_FAILED', ...childCodes])];
    const diagnostic = rolloutObservation?.terminal
      ? rolloutFailureRecord(rolloutObservation.terminal)
      : rolloutObservation?.nonterminal
        ? rolloutObservationRecord(rolloutObservation.nonterminal)
        : rolloutObservation?.queryFailure
          ? rolloutObservationRecord(rolloutObservation.queryFailure)
          : 'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED';
    throw new Error(
      failureCodes.join(':') +
        ':' +
        diagnostic +
        (ownerFailure ? ':' + ownerFailureEvidenceRecord(ownerFailure) : '') +
        (apiStartupFailure ? ':' + apiPodStartupFailureRecord(apiStartupFailure) : ''),
    );
  }
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
    const check = await kubectl(
      proofReaderCanIArgs({ verb, resource, resourceName, identity, namespace: NAMESPACE }),
    );
    results.push({
      description: `proof-reader RBAC ${verb} ${resource}${
        resourceName ? `/${resourceName}` : ''
      } is ${expected}`,
      passed: check.exitCode === 0 && check.stdout.trim() === expected,
      detail: check.stderr.trim() || undefined,
    });
  }
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

export async function waitForCleanupCheck(
  check: () => Promise<void>,
  failureCode: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await check();
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== failureCode) throw error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(failureCode);
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(pollIntervalMs, remainingMs)),
    );
  }
}

async function assertReleaseCleanup(release: string, allowRetry = true): Promise<void> {
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
      if (!allowRetry) throw new Error('HELM_UNINSTALL_CLEANUP_FAILED');
      await waitForCleanupCheck(
        () => assertReleaseCleanup(release, false),
        'HELM_UNINSTALL_CLEANUP_FAILED',
      );
      return;
    }
  }
}

async function runRealBundledLifecycle(
  imageDigest: string,
  kubernetesApiIp: string,
  kubernetesApiEndpoint: string,
): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-live');
  const assertions: AssertionResult[] = [];
  const databaseTarget = { namespace: NAMESPACE, statefulSet: `${release}-postgres` };
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-lifecycle-'));
  let cleanupNetworkPrerequisites: (() => Promise<void>) | undefined;
  let stage: LifecycleFailureStage = 'namespace-reset';
  try {
    requireCommand(await kubectl(namespaceCleanupArgs(NAMESPACE)), 'NAMESPACE_RESET_FAILED');
    stage = 'namespace-create';
    await createNamespace();
    stage = 'certificate-material';
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release);
    stage = 'tls-secrets';
    await createLifecycleTlsSecrets(stateDirectory, NAMESPACE, release);
    stage = 'lifecycle-values';
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
        kubernetesApiServiceIp: kubernetesApiIp,
        kubernetesApiEndpointIp: kubernetesApiEndpoint,
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
        kubernetesApiServiceIp: kubernetesApiIp,
        kubernetesApiEndpointIp: kubernetesApiEndpoint,
      }),
      { mode: 0o600 },
    );

    stage = 'cutover-install';
    await runCutoverCommand('install', release, installValues);
    stage = 'api-ready';
    requireCommand(
      await waitForDeployment(`${release}-api`, '10m'),
      'API_DEPLOYMENT_NOT_AVAILABLE',
    );
    stage = 'network-prerequisites';
    cleanupNetworkPrerequisites = await prepareNetworkPrerequisites(
      release,
      installValues,
      material.apiProofSpkiSha256,
    );
    const firstProofCount = await proofRowCount(databaseTarget);
    assertions.push({
      description: 'post-install challenged API proof appended a durable proof row',
      passed: firstProofCount >= 1,
      detail: `proofRows=${firstProofCount}`,
    });
    const firstRevision = await helmRevision(release);

    stage = 'cutover-enforce';
    await runCutoverCommand('enforce', release, upgradeValues);
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
        passed: secondProofCount > firstProofCount,
        detail: `proofRows=${firstProofCount}->${secondProofCount}`,
      },
    );

    stage = 'current-proof';
    await runCutoverCommand('enforce', release, upgradeValues);
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

    stage = 'post-cutover-validation';
    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    await cleanupNetworkPrerequisites();
    cleanupNetworkPrerequisites = undefined;
    assertions.push({
      description: 'owner Jobs, proof Jobs, Pods, ConfigMaps, and owner Secrets were cleaned',
      passed: true,
    });
    stage = 'helm-uninstall';
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    stage = 'release-cleanup';
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
  } catch (caught) {
    let error = caught;
    if (cleanupNetworkPrerequisites) {
      try {
        await cleanupNetworkPrerequisites();
      } catch (cleanupError) {
        error = cleanupError;
      }
    }
    const diagnostics = await kubectl(['get', 'pods,jobs', '-n', NAMESPACE, '-o', 'wide']);
    return {
      name: 'real-bundled-install-upgrade-current-uninstall',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      failedStage: stage,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }`,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function runRealExternalTlsLifecycle(
  imageDigest: string,
  kubernetesApiIp: string,
  kubernetesApiEndpoint: string,
): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-external');
  const assertions: AssertionResult[] = [];
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-external-'));
  let cleanupNetworkPrerequisites: (() => Promise<void>) | undefined;
  let stage: LifecycleFailureStage = 'namespace-reset';
  const databaseTarget = {
    namespace: EXTERNAL_DATABASE_NAMESPACE,
    statefulSet: 'external-postgres',
  };
  try {
    for (const namespace of [NAMESPACE, EXTERNAL_DATABASE_NAMESPACE]) {
      requireCommand(await kubectl(namespaceCleanupArgs(namespace)), 'NAMESPACE_RESET_FAILED');
      stage = 'namespace-create';
      await createNamespace(namespace);
    }
    stage = 'certificate-material';
    const hostname = `external-postgres.${EXTERNAL_DATABASE_NAMESPACE}.svc.cluster.local`;
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release, [
      'external-postgres',
      `external-postgres.${EXTERNAL_DATABASE_NAMESPACE}.svc`,
      hostname,
    ]);
    stage = 'tls-secrets';
    await createApiProofSecrets(stateDirectory, NAMESPACE, release);
    stage = 'external-database-fixture';
    const external = await createExternalDatabaseFixture({ directory: stateDirectory, release });
    stage = 'lifecycle-values';
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
        kubernetesApiServiceIp: kubernetesApiIp,
        kubernetesApiEndpointIp: kubernetesApiEndpoint,
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
        kubernetesApiServiceIp: kubernetesApiIp,
        kubernetesApiEndpointIp: kubernetesApiEndpoint,
        database,
      }),
      { mode: 0o600 },
    );

    stage = 'cutover-install';
    await runCutoverCommand('install', release, installValues);
    stage = 'api-ready';
    requireCommand(
      await waitForDeployment(`${release}-api`, '10m'),
      'API_DEPLOYMENT_NOT_AVAILABLE',
    );
    stage = 'network-prerequisites';
    cleanupNetworkPrerequisites = await prepareNetworkPrerequisites(
      release,
      installValues,
      material.apiProofSpkiSha256,
    );
    const firstProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'external TLS post-install challenge appended a proof row',
        passed: firstProofCount >= 1,
        detail: `proofRows=${firstProofCount}`,
      },
      ...(await assertExternalRoleConnections(external.hostname)),
    );
    const firstRevision = await helmRevision(release);
    stage = 'cutover-enforce';
    await runCutoverCommand('enforce', release, upgradeValues);
    const secondRevision = await helmRevision(release);
    const secondProofCount = await proofRowCount(databaseTarget);
    assertions.push(
      {
        description: 'external TLS enforce changed the Helm revision',
        passed: BigInt(secondRevision) > BigInt(firstRevision),
      },
      {
        description: 'external TLS post-upgrade challenge appended another proof row',
        passed: secondProofCount > firstProofCount,
        detail: `proofRows=${firstProofCount}->${secondProofCount}`,
      },
    );
    stage = 'current-proof';
    await runCutoverCommand('enforce', release, upgradeValues);
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
    stage = 'post-cutover-validation';
    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    await cleanupNetworkPrerequisites();
    cleanupNetworkPrerequisites = undefined;
    stage = 'helm-uninstall';
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    stage = 'release-cleanup';
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
  } catch (caught) {
    let error = caught;
    if (cleanupNetworkPrerequisites) {
      try {
        await cleanupNetworkPrerequisites();
      } catch (cleanupError) {
        error = cleanupError;
      }
    }
    const diagnostics = await kubectl(['get', 'pods,jobs', '-A', '-o', 'wide']);
    return {
      name: 'real-external-tls-install-upgrade-current-uninstall',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      failedStage: stage,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }`,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function runFailedRolloutRecovery(
  imageDigest: string,
  kubernetesApiIp: string,
  kubernetesApiEndpoint: string,
): Promise<ScenarioEvidence> {
  const startedAt = Date.now();
  const release = scenarioRelease('cmdr-recovery');
  const assertions: AssertionResult[] = [];
  const stateDirectory = mkdtempSync(resolve(tmpdir(), 'commander-kind-recovery-'));
  const databaseTarget = { namespace: NAMESPACE, statefulSet: `${release}-postgres` };
  let stage: LifecycleFailureStage = 'namespace-reset';
  try {
    requireCommand(await kubectl(namespaceCleanupArgs(NAMESPACE)), 'NAMESPACE_RESET_FAILED');
    stage = 'namespace-create';
    await createNamespace();
    stage = 'certificate-material';
    const material = generateCertificateMaterial(stateDirectory, NAMESPACE, release);
    stage = 'tls-secrets';
    await createLifecycleTlsSecrets(stateDirectory, NAMESPACE, release, 'postgres.key');
    stage = 'lifecycle-values';
    const values = resolve(stateDirectory, 'values.yaml');
    writeFileSync(
      values,
      buildLifecycleValues({
        namespace: NAMESPACE,
        release,
        imageDigest,
        databaseSpkiSha256: material.databaseSpkiSha256,
        logLevel: 'info',
        kubernetesApiServiceIp: kubernetesApiIp,
        kubernetesApiEndpointIp: kubernetesApiEndpoint,
      }),
      { mode: 0o600 },
    );
    let firstFailure: unknown;
    stage = 'recovery-failed-install';
    try {
      await runCutoverCommand('install', release, values);
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

    stage = 'recovery-retry';
    await replaceApiProofPrivateSecret(stateDirectory, NAMESPACE, release);
    await runCutoverCommand('install', release, values);
    stage = 'api-ready';
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
        passed: proofCountAfterRetry > proofCountAfterFailure,
        detail: `proofRows=${proofCountAfterFailure}->${proofCountAfterRetry}`,
      },
    );
    stage = 'post-cutover-validation';
    const rbac = await assertProofReaderRbac(release);
    const networkPolicy = await runNetworkPolicyCanaries(release, imageDigest);
    await assertEphemeralResourcesCleaned(release);
    stage = 'helm-uninstall';
    requireCommand(
      await helm(['uninstall', release, '-n', NAMESPACE, '--wait']),
      'HELM_UNINSTALL_FAILED',
    );
    stage = 'release-cleanup';
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
    return {
      name: 'failed-rollout-exact-retry-recovery',
      passed: false,
      durationMs: Date.now() - startedAt,
      events: await getEvents(NAMESPACE),
      assertions,
      failedStage: stage,
      error: `${error instanceof Error ? error.message : String(error)}${
        diagnostics.stdout.trim() ? `\n${diagnostics.stdout.trim()}` : ''
      }`,
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
  const imageSourceRevision = opts.reuseProductionImage
    ? undefined
    : productionImageSourceRevision(process.env, () =>
        requireCommand(
          runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir() }),
          'PRODUCTION_IMAGE_SOURCE_REVISION_INVALID',
        ),
      );

  if (!kindClusterExists(CLUSTER_NAME)) {
    await createKindCluster(CLUSTER_NAME);
  }
  await loadPinnedRuntimeImages();
  await installCalico();
  await loadProductionImage(imageDigest);
  await ensureControlPlaneReady();
  const kubernetesApiIp = await kubernetesApiServiceIp();
  const kubernetesApiEndpoint = await kubernetesApiEndpointIp();
  const runners: Record<
    LifecycleScenarioName,
    (
      selectedDigest: string,
      selectedKubernetesApiIp: string,
      selectedKubernetesApiEndpoint: string,
    ) => Promise<ScenarioEvidence>
  > = {
    'real-bundled': runRealBundledLifecycle,
    'real-external-tls': runRealExternalTlsLifecycle,
    'failed-rollout-recovery': runFailedRolloutRecovery,
  };
  const scenarios: ScenarioEvidence[] = [];
  for (const scenario of selectedScenarios) {
    scenarios.push(await runners[scenario](imageDigest, kubernetesApiIp, kubernetesApiEndpoint));
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
    image: {
      digest: imageDigest,
      ...(imageSourceRevision ? { sourceRevision: imageSourceRevision } : {}),
    },
    ownerFailureEvidence: scenarios.flatMap(({ error }) =>
      typeof error === 'string' ? [parseOwnerFailureEvidence(error)].filter(Boolean) : [],
    ),
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
