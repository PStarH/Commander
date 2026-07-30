#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import { collectTask1PrebootstrapInventory } from '../packages/kernel/src/task1Catalog.js';
import { createVerifiedPostgresPool } from '../packages/postgres-runtime/src/index.js';
import { Pool } from 'pg';
import type { KubernetesSecretSnapshot } from './helm-adopt-database-secret.js';

const NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const APPROVED_V8_CHART_ARCHIVE_SHA256 =
  'b82d783dc53970b3c8194e82b8ab7134118aa0560119c33da34b5f755a028027';
const APPROVED_V8_POSTGRES_IMAGE = 'postgres:16-alpine';
export const BUNDLED_DATABASE_TLS_SENTINEL = Object.freeze({
  metadataKey: 'commanderLifecycleSentinel',
  metadataValue: 'bundled-database-tls/v1',
});
const LEGACY_LOGINS = {
  'owner-url': 'commander_owner',
  'app-url': 'commander_app',
  'scheduler-url': 'commander_scheduler',
  'worker-url': 'commander_worker',
  'adapter-ops-url': 'commander_adapter_ops',
} as const;
const PASSWORD_KEYS = [
  'owner-password',
  'app-password',
  'scheduler-password',
  'worker-password',
  'adapter-ops-password',
  'postgres-password',
] as const;
const LEGACY_KEYS = [...Object.keys(LEGACY_LOGINS), ...PASSWORD_KEYS].sort();
const STABLE_KEYS = [...LEGACY_KEYS, 'tenant-authority-password', 'tenant-authority-url'].sort();
const TLS_KEYS = ['ca.crt', 'tls.crt', 'tls.key'];
const TLS_ARGS = [
  '-c',
  'ssl=on',
  '-c',
  'ssl_ca_file=/run/commander/database-tls/ca.crt',
  '-c',
  'ssl_cert_file=/run/commander/database-tls/tls.crt',
  '-c',
  'ssl_key_file=/run/commander/database-tls/tls.key',
] as const;

export interface BundledDatabaseTransportDigestInput {
  secretName: string;
  caKey: string;
  certKey: string;
  keyKey: string;
  dataVolumeKind: 'pvc' | 'emptyDir';
}

type JsonObject = Record<string, any>;

export interface BundledDatabaseTlsRequest {
  namespace: string;
  release: string;
  legacyDatabaseSecret: string;
  stableDatabaseSecret: string;
  databaseTlsSecret: string;
  expectedPreclosureChartSha256: string;
}

export interface BundledDatabasePreservationSnapshot {
  format: 'bundled-database-preservation/v1';
  sentinelIds: readonly string[];
  sentinelRowsSha256: string;
  schemaSha256: string;
  rolesSha256: string;
  ledgerSha256: string;
  catalogSha256: string;
}

export interface BundledDatabasePreservationInput {
  url: string;
  baseline?: BundledDatabasePreservationSnapshot;
  caPem?: string;
  expectedServerSpkiSha256?: string;
}

export interface BundledDatabaseTlsPorts {
  readStatefulSet(namespace: string, name: string): Promise<JsonObject | null>;
  readPersistentVolumeClaim(namespace: string, name: string): Promise<JsonObject | null>;
  readSecret(namespace: string, name: string): Promise<KubernetesSecretSnapshot | null>;
  authenticate(
    url: string,
    expectedLogin: string,
    caPem?: string,
    expectedServerSpkiSha256?: string,
  ): Promise<void>;
  validateTlsIdentity(
    request: BundledDatabaseTlsRequest,
    secret: KubernetesSecretSnapshot,
  ): { caPem: string; expectedServerSpkiSha256: string };
  preservationSnapshot(
    input: BundledDatabasePreservationInput,
  ): Promise<BundledDatabasePreservationSnapshot>;
  patchTemplate(
    namespace: string,
    name: string,
    resourceVersion: string,
    template: JsonObject,
  ): Promise<void>;
  waitRollout(namespace: string, name: string): Promise<void>;
}

export function validateBundledDatabaseTlsIdentity(
  request: BundledDatabaseTlsRequest,
  secret: KubernetesSecretSnapshot,
  now = new Date(),
): { caPem: string; expectedServerSpkiSha256: string } {
  if (!Number.isFinite(now.getTime())) invalid();
  let ca: X509Certificate;
  let certificate: X509Certificate;
  let privateKeyPem: string;
  try {
    ca = new X509Certificate(decode(secret.data['ca.crt']));
    certificate = new X509Certificate(decode(secret.data['tls.crt']));
    privateKeyPem = decode(secret.data['tls.key']);
    createPrivateKey(privateKeyPem);
  } catch {
    return invalid();
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const caValidTo = Date.parse(ca.validTo);
  const minimumExpiry = now.getTime() + 24 * 60 * 60 * 1_000;
  const expectedHost = `${request.release}-postgres.${request.namespace}.svc`;
  const certificateSpki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  const privateSpki = createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' });
  const algorithm = certificate.publicKey.asymmetricKeyType;
  const curve = certificate.publicKey.asymmetricKeyDetails?.namedCurve;
  if (
    ca.ca !== true ||
    certificate.ca !== false ||
    !certificate.verify(ca.publicKey) ||
    certificate.checkHost(expectedHost, { subject: 'never' }) !== expectedHost ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    validFrom > now.getTime() ||
    validTo < minimumExpiry ||
    !Number.isFinite(caValidTo) ||
    caValidTo < minimumExpiry ||
    (algorithm !== 'ed25519' && !(algorithm === 'ec' && curve === 'prime256v1')) ||
    certificateSpki.length !== privateSpki.length ||
    !timingSafeEqual(certificateSpki, privateSpki) ||
    !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
  ) {
    invalid();
  }
  return {
    caPem: decode(secret.data['ca.crt']),
    expectedServerSpkiSha256: createHash('sha256').update(certificateSpki).digest('hex'),
  };
}

export function statefulSetTemplateJsonPatch(
  resourceVersion: string,
  template: JsonObject,
): JsonObject[] {
  if (!resourceVersion) invalid();
  return [
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
    { op: 'replace', path: '/spec/template', value: template },
  ];
}

function invalid(code = 'TENANT_DATABASE_TLS_PREPARATION_INVALID'): never {
  throw new Error(code);
}

export function bundledDatabaseTransportDigestBytes(
  input: BundledDatabaseTransportDigestInput,
): Buffer {
  if (
    !NAME.test(input.secretName) ||
    input.caKey !== 'ca.crt' ||
    input.certKey !== 'tls.crt' ||
    input.keyKey !== 'tls.key' ||
    (input.dataVolumeKind !== 'pvc' && input.dataVolumeKind !== 'emptyDir')
  ) {
    invalid();
  }
  return Buffer.from(
    [
      input.secretName,
      input.caKey,
      input.certKey,
      input.keyKey,
      input.dataVolumeKind,
      '0440',
      'ssl=on',
      'ssl_ca_file=/run/commander/database-tls/ca.crt',
      'ssl_cert_file=/run/commander/database-tls/tls.crt',
      'ssl_key_file=/run/commander/database-tls/tls.key',
      'postgres-data:/var/lib/postgresql/data',
    ].join('\0'),
    'utf8',
  );
}

export function computeBundledDatabaseTransportDigest(
  input: BundledDatabaseTransportDigestInput,
): string {
  return createHash('sha256').update(bundledDatabaseTransportDigestBytes(input)).digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    invalid();
  }
}

function decode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalid();
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) invalid();
  return bytes.toString('utf8');
}

function postgresUrl(value: string, expectedLogin: string, requireTls: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username) !== expectedLogin ||
    !url.password ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    invalid();
  }
  const ssl = [...url.searchParams.entries()].filter(([key]) =>
    key.toLowerCase().startsWith('ssl'),
  );
  if (
    (requireTls &&
      (ssl.length !== 1 ||
        ssl[0]![0].toLowerCase() !== 'sslmode' ||
        ssl[0]![1] !== 'verify-full')) ||
    (!requireTls && ssl.length !== 0)
  ) {
    invalid();
  }
  return url;
}

export function parseBundledDatabaseTlsArgs(args: readonly string[]): BundledDatabaseTlsRequest {
  const flags = [
    '--namespace',
    '--release',
    '--legacy-database-secret',
    '--stable-database-secret',
    '--database-tls-secret',
    '--expected-preclosure-chart-sha256',
  ];
  if (
    args.length !== flags.length * 2 ||
    flags.some((flag, index) => args[index * 2] !== flag || !args[index * 2 + 1])
  ) {
    return invalid('TENANT_DATABASE_TLS_PREPARATION_ARGUMENT_INVALID');
  }
  const values = flags.map((_flag, index) => args[index * 2 + 1]!);
  if (values.slice(0, 5).some((value) => !NAME.test(value)) || !SHA256.test(values[5]!)) {
    return invalid('TENANT_DATABASE_TLS_PREPARATION_ARGUMENT_INVALID');
  }
  return {
    namespace: values[0]!,
    release: values[1]!,
    legacyDatabaseSecret: values[2]!,
    stableDatabaseSecret: values[3]!,
    databaseTlsSecret: values[4]!,
    expectedPreclosureChartSha256: values[5]!,
  };
}

function array(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object'))
    invalid();
  return value as JsonObject[];
}

function oneNamed(values: unknown, name: string): JsonObject {
  const matches = array(values).filter((entry) => entry.name === name);
  if (matches.length !== 1) invalid();
  return matches[0]!;
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalBootstrapJson(left) === canonicalBootstrapJson(right);
}

function removeKnownDefault(object: JsonObject, key: string, value: unknown): void {
  if (object[key] === undefined) return;
  if (!equalJson(object[key], value)) invalid();
  delete object[key];
}

function approvedV8Template(request: BundledDatabaseTlsRequest): JsonObject {
  const labels = {
    'app.kubernetes.io/name': request.release,
    'app.kubernetes.io/instance': request.release,
    'app.kubernetes.io/component': 'postgres',
  };
  return {
    metadata: { labels },
    spec: {
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'postgres',
          image: APPROVED_V8_POSTGRES_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          ports: [{ name: 'postgres', containerPort: 5432, protocol: 'TCP' }],
          env: [
            { name: 'POSTGRES_USER', value: 'commander' },
            {
              name: 'POSTGRES_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: request.legacyDatabaseSecret, key: 'postgres-password' },
              },
            },
            { name: 'POSTGRES_DB', value: 'commander' },
            { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
            {
              name: 'COMMANDER_OWNER_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: request.legacyDatabaseSecret, key: 'owner-password' },
              },
            },
            {
              name: 'COMMANDER_APP_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: request.legacyDatabaseSecret, key: 'app-password' },
              },
            },
            {
              name: 'COMMANDER_SCHEDULER_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: request.legacyDatabaseSecret, key: 'scheduler-password' },
              },
            },
            {
              name: 'COMMANDER_WORKER_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: request.legacyDatabaseSecret, key: 'worker-password' },
              },
            },
          ],
          resources: {
            requests: { cpu: '100m', memory: '256Mi' },
            limits: { cpu: '500m', memory: '1Gi' },
          },
          livenessProbe: {
            exec: { command: ['pg_isready', '-U', 'commander', '-d', 'commander'] },
            initialDelaySeconds: 30,
            periodSeconds: 10,
          },
          readinessProbe: {
            exec: { command: ['pg_isready', '-U', 'commander', '-d', 'commander'] },
            initialDelaySeconds: 5,
            periodSeconds: 5,
          },
          volumeMounts: [
            { name: 'postgres-data', mountPath: '/var/lib/postgresql/data' },
            {
              name: 'database-init',
              mountPath: '/docker-entrypoint-initdb.d',
              readOnly: true,
            },
          ],
        },
      ],
      volumes: [
        {
          name: 'database-init',
          configMap: { name: `${request.release}-database-init`, defaultMode: 0o755 },
        },
      ],
    },
  };
}

function normalizedApprovedV8Template(value: unknown): JsonObject {
  if (!value || typeof value !== 'object') invalid();
  const template = structuredClone(value) as JsonObject;
  template.metadata ??= {};
  removeKnownDefault(template.metadata, 'creationTimestamp', null);
  const spec = template.spec;
  if (!spec || typeof spec !== 'object') invalid();
  removeKnownDefault(spec, 'dnsPolicy', 'ClusterFirst');
  removeKnownDefault(spec, 'restartPolicy', 'Always');
  removeKnownDefault(spec, 'schedulerName', 'default-scheduler');
  removeKnownDefault(spec, 'terminationGracePeriodSeconds', 30);
  const containers = array(spec.containers);
  if (containers.length !== 1) invalid();
  const container = containers[0]!;
  removeKnownDefault(container, 'terminationMessagePath', '/dev/termination-log');
  removeKnownDefault(container, 'terminationMessagePolicy', 'File');
  for (const probeName of ['livenessProbe', 'readinessProbe']) {
    const probe = container[probeName];
    if (!probe || typeof probe !== 'object') invalid();
    removeKnownDefault(probe, 'failureThreshold', 3);
    removeKnownDefault(probe, 'successThreshold', 1);
    removeKnownDefault(probe, 'timeoutSeconds', 1);
  }
  return template;
}

function validateClaimTemplate(value: unknown): JsonObject {
  if (!value || typeof value !== 'object') invalid();
  const claim = structuredClone(value) as JsonObject;
  removeKnownDefault(claim, 'apiVersion', 'v1');
  removeKnownDefault(claim, 'kind', 'PersistentVolumeClaim');
  if (!claim.metadata || typeof claim.metadata !== 'object') invalid();
  removeKnownDefault(claim.metadata, 'creationTimestamp', null);
  if (!claim.status || equalJson(claim.status, { phase: 'Pending' })) delete claim.status;
  const spec = claim.spec;
  if (
    claim.metadata.name !== 'postgres-data' ||
    Object.keys(claim.metadata).length !== 1 ||
    !spec ||
    typeof spec !== 'object' ||
    !equalJson(spec.accessModes, ['ReadWriteOnce']) ||
    typeof spec.resources?.requests?.storage !== 'string' ||
    !spec.resources.requests.storage ||
    Object.keys(spec).some(
      (key) => !['accessModes', 'resources', 'storageClassName', 'volumeMode'].includes(key),
    ) ||
    Object.keys(spec.resources).length !== 1 ||
    Object.keys(spec.resources.requests).length !== 1 ||
    (spec.storageClassName !== undefined && typeof spec.storageClassName !== 'string') ||
    (spec.volumeMode !== undefined && spec.volumeMode !== 'Filesystem')
  ) {
    invalid();
  }
  if (!equalJson(Object.keys(claim).sort(), ['metadata', 'spec'])) invalid();
  return claim;
}

function pvcIdentity(
  request: BundledDatabaseTlsRequest,
  claim: JsonObject,
  pvc: JsonObject | null,
): JsonObject {
  const expectedName = `postgres-data-${request.release}-postgres-0`;
  if (
    !pvc ||
    pvc.apiVersion !== 'v1' ||
    pvc.kind !== 'PersistentVolumeClaim' ||
    pvc.metadata?.namespace !== request.namespace ||
    pvc.metadata?.name !== expectedName ||
    typeof pvc.metadata?.uid !== 'string' ||
    !pvc.metadata.uid ||
    typeof pvc.spec?.volumeName !== 'string' ||
    !pvc.spec.volumeName ||
    pvc.status?.phase !== 'Bound'
  ) {
    invalid();
  }
  const claimSpec = structuredClone(claim.spec) as JsonObject;
  const liveSpec = structuredClone(pvc.spec) as JsonObject;
  delete liveSpec.volumeName;
  if (
    claimSpec.storageClassName === undefined &&
    typeof liveSpec.storageClassName === 'string' &&
    liveSpec.storageClassName
  ) {
    claimSpec.storageClassName = liveSpec.storageClassName;
  }
  if (claimSpec.volumeMode === undefined && liveSpec.volumeMode === 'Filesystem') {
    claimSpec.volumeMode = 'Filesystem';
  }
  if (!equalJson(liveSpec, claimSpec)) invalid();
  return {
    namespace: request.namespace,
    name: expectedName,
    uid: pvc.metadata.uid,
    volumeName: pvc.spec.volumeName,
    spec: liveSpec,
  };
}

function assertPvcIdentity(expected: JsonObject, pvc: JsonObject | null): void {
  if (
    !pvc ||
    pvc.apiVersion !== 'v1' ||
    pvc.kind !== 'PersistentVolumeClaim' ||
    pvc.metadata?.namespace !== expected.namespace ||
    pvc.metadata?.name !== expected.name ||
    pvc.metadata?.uid !== expected.uid ||
    pvc.spec?.volumeName !== expected.volumeName ||
    pvc.status?.phase !== 'Bound'
  ) {
    invalid();
  }
  const spec = structuredClone(pvc.spec) as JsonObject;
  delete spec.volumeName;
  if (!equalJson(spec, expected.spec)) invalid();
}

function validateStatefulSet(
  request: BundledDatabaseTlsRequest,
  statefulSet: JsonObject,
  persistentVolumeClaim: JsonObject | null,
): {
  resourceVersion: string;
  oldTemplate: JsonObject;
  desiredTemplate: JsonObject;
  persistentVolumeClaimIdentity: JsonObject;
} {
  const metadata = statefulSet.metadata;
  const spec = statefulSet.spec;
  const labels = {
    'app.kubernetes.io/name': request.release,
    'app.kubernetes.io/instance': request.release,
    'app.kubernetes.io/version': '0.4.0',
    'app.kubernetes.io/managed-by': 'Helm',
    'helm.sh/chart': 'commander-0.4.0',
    'app.kubernetes.io/component': 'postgres',
  };
  const selector = {
    matchLabels: {
      'app.kubernetes.io/name': request.release,
      'app.kubernetes.io/instance': request.release,
      'app.kubernetes.io/component': 'postgres',
    },
  };
  if (
    statefulSet.apiVersion !== 'apps/v1' ||
    statefulSet.kind !== 'StatefulSet' ||
    !metadata ||
    metadata.namespace !== request.namespace ||
    metadata.name !== `${request.release}-postgres` ||
    !equalJson(metadata.labels, labels) ||
    !equalJson(metadata.annotations, {
      'meta.helm.sh/release-name': request.release,
      'meta.helm.sh/release-namespace': request.namespace,
    }) ||
    metadata.annotations?.['meta.helm.sh/release-name'] !== request.release ||
    metadata.annotations?.['meta.helm.sh/release-namespace'] !== request.namespace ||
    request.expectedPreclosureChartSha256 !== APPROVED_V8_CHART_ARCHIVE_SHA256 ||
    typeof metadata.resourceVersion !== 'string' ||
    !metadata.resourceVersion ||
    !spec ||
    spec.serviceName !== `${request.release}-postgres` ||
    spec.replicas !== 1 ||
    !equalJson(spec.selector, selector)
  ) {
    invalid();
  }
  const allowedSpecKeys = [
    'serviceName',
    'replicas',
    'selector',
    'template',
    'volumeClaimTemplates',
    'persistentVolumeClaimRetentionPolicy',
    'podManagementPolicy',
    'revisionHistoryLimit',
    'updateStrategy',
  ];
  if (Object.keys(spec).some((key) => !allowedSpecKeys.includes(key))) invalid();
  const defaults: Array<[string, unknown]> = [
    ['persistentVolumeClaimRetentionPolicy', { whenDeleted: 'Retain', whenScaled: 'Retain' }],
    ['podManagementPolicy', 'OrderedReady'],
    ['revisionHistoryLimit', 10],
    ['updateStrategy', { rollingUpdate: { partition: 0 }, type: 'RollingUpdate' }],
  ];
  for (const [key, value] of defaults) {
    if (spec[key] !== undefined && !equalJson(spec[key], value)) invalid();
  }
  const claims = array(spec.volumeClaimTemplates);
  if (claims.length !== 1) invalid();
  const claim = validateClaimTemplate(claims[0]);
  const persistentVolumeClaimIdentity = pvcIdentity(request, claim, persistentVolumeClaim);
  const oldTemplate = structuredClone(spec.template) as JsonObject;
  const desiredTemplate = structuredClone(oldTemplate) as JsonObject;
  const container = oneNamed(desiredTemplate.spec?.containers, 'postgres');
  if (container.image !== APPROVED_V8_POSTGRES_IMAGE) invalid();
  const mounts = array(container.volumeMounts);
  if (oneNamed(mounts, 'postgres-data').mountPath !== '/var/lib/postgresql/data') invalid();
  const transportDigest = computeBundledDatabaseTransportDigest({
    secretName: request.databaseTlsSecret,
    caKey: 'ca.crt',
    certKey: 'tls.crt',
    keyKey: 'tls.key',
    dataVolumeKind: 'pvc',
  });
  const existingDigest =
    desiredTemplate.metadata?.annotations?.['commander.io/database-transport-content-sha256'];
  const baselineTemplate = structuredClone(oldTemplate) as JsonObject;
  if (existingDigest !== undefined) {
    delete baselineTemplate.metadata.annotations['commander.io/database-transport-content-sha256'];
    if (Object.keys(baselineTemplate.metadata.annotations).length === 0) {
      delete baselineTemplate.metadata.annotations;
    }
    const baselineContainer = oneNamed(baselineTemplate.spec?.containers, 'postgres');
    if (!Array.isArray(baselineContainer.args)) invalid();
    baselineContainer.args = baselineContainer.args.slice(0, -TLS_ARGS.length);
    if (baselineContainer.args.length === 0) delete baselineContainer.args;
    baselineContainer.volumeMounts = array(baselineContainer.volumeMounts).filter(
      (mount) => mount.name !== 'database-tls',
    );
    baselineTemplate.spec.volumes = array(baselineTemplate.spec.volumes).filter(
      (volume) => volume.name !== 'database-tls',
    );
  }
  if (!equalJson(normalizedApprovedV8Template(baselineTemplate), approvedV8Template(request))) {
    invalid();
  }
  if (existingDigest !== undefined) {
    const tlsMount = oneNamed(mounts, 'database-tls');
    const tlsVolume = oneNamed(desiredTemplate.spec?.volumes, 'database-tls');
    if (
      existingDigest !== transportDigest ||
      tlsMount.mountPath !== '/run/commander/database-tls' ||
      tlsMount.readOnly !== true ||
      tlsVolume.secret?.secretName !== request.databaseTlsSecret ||
      tlsVolume.secret?.defaultMode !== 0o440 ||
      canonicalBootstrapJson(tlsVolume.secret?.items) !==
        canonicalBootstrapJson(TLS_KEYS.map((key) => ({ key, path: key }))) ||
      !Array.isArray(container.args) ||
      canonicalBootstrapJson(container.args.slice(-TLS_ARGS.length)) !==
        canonicalBootstrapJson(TLS_ARGS)
    ) {
      invalid('TENANT_DATABASE_TLS_PREPARATION_DRIFT');
    }
    return {
      resourceVersion: metadata.resourceVersion,
      oldTemplate,
      desiredTemplate,
      persistentVolumeClaimIdentity,
    };
  }
  if (
    mounts.some((mount) => mount.name === 'database-tls') ||
    array(desiredTemplate.spec?.volumes).some((volume) => volume.name === 'database-tls') ||
    (Array.isArray(container.args) &&
      container.args.some((argument: unknown) =>
        typeof argument === 'string' ? argument.startsWith('ssl') : false,
      ))
  ) {
    invalid('TENANT_DATABASE_TLS_PREPARATION_DRIFT');
  }
  container.args = [...(Array.isArray(container.args) ? container.args : []), ...TLS_ARGS];
  container.volumeMounts = [
    ...mounts,
    { name: 'database-tls', mountPath: '/run/commander/database-tls', readOnly: true },
  ];
  desiredTemplate.spec.volumes = [
    ...array(desiredTemplate.spec.volumes),
    {
      name: 'database-tls',
      secret: {
        secretName: request.databaseTlsSecret,
        defaultMode: 0o440,
        items: TLS_KEYS.map((key) => ({ key, path: key })),
      },
    },
  ];
  desiredTemplate.metadata ??= {};
  desiredTemplate.metadata.annotations ??= {};
  desiredTemplate.metadata.annotations['commander.io/database-transport-content-sha256'] =
    transportDigest;
  return {
    resourceVersion: metadata.resourceVersion,
    oldTemplate,
    desiredTemplate,
    persistentVolumeClaimIdentity,
  };
}

function exactSecret(
  secret: KubernetesSecretSnapshot | null,
  namespace: string,
  name: string,
  keys: readonly string[],
  allowedTypes: readonly string[] = ['Opaque'],
): KubernetesSecretSnapshot {
  if (
    !secret ||
    secret.metadata.namespace !== namespace ||
    secret.metadata.name !== name ||
    !allowedTypes.includes(secret.type)
  ) {
    invalid();
  }
  exactKeys(secret.data, keys);
  for (const value of Object.values(secret.data)) decode(value);
  return secret;
}

function exactPreservationSnapshot(
  value: BundledDatabasePreservationSnapshot,
): BundledDatabasePreservationSnapshot {
  const keys = [
    'format',
    'sentinelIds',
    'sentinelRowsSha256',
    'schemaSha256',
    'rolesSha256',
    'ledgerSha256',
    'catalogSha256',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    !equalJson(Object.keys(value).sort(), [...keys].sort()) ||
    value.format !== 'bundled-database-preservation/v1' ||
    !Array.isArray(value.sentinelIds) ||
    value.sentinelIds.length === 0 ||
    value.sentinelIds.some((id) => typeof id !== 'string' || !id) ||
    !equalJson(value.sentinelIds, [...new Set(value.sentinelIds)].sort()) ||
    [
      value.sentinelRowsSha256,
      value.schemaSha256,
      value.rolesSha256,
      value.ledgerSha256,
      value.catalogSha256,
    ].some((digest) => !SHA256.test(digest))
  ) {
    invalid();
  }
  return structuredClone(value);
}

const ROLLBACK_ATTEMPTS = 5;

async function restoreStatefulSetTemplate(
  ports: BundledDatabaseTlsPorts,
  namespace: string,
  name: string,
  oldTemplate: JsonObject,
): Promise<void> {
  for (let attempt = 0; attempt < ROLLBACK_ATTEMPTS; attempt += 1) {
    try {
      const current = await ports.readStatefulSet(namespace, name);
      const resourceVersion = current?.metadata?.resourceVersion;
      if (
        !current ||
        typeof resourceVersion !== 'string' ||
        !resourceVersion ||
        !current.spec?.template
      ) {
        throw new Error('rollback read incomplete');
      }
      if (!equalJson(current.spec.template, oldTemplate)) {
        await ports.patchTemplate(namespace, name, resourceVersion, oldTemplate);
      }
      await ports.waitRollout(namespace, name);
      const restored = await ports.readStatefulSet(namespace, name);
      if (restored?.spec?.template && equalJson(restored.spec.template, oldTemplate)) return;
    } catch {
      // A fresh read on the next bounded attempt reacquires resourceVersion after conflicts.
    }
  }
  invalid('TENANT_DATABASE_TLS_PREPARATION_ROLLBACK_FAILED');
}

export async function runBundledDatabaseTlsPreparation(
  request: BundledDatabaseTlsRequest,
  ports: BundledDatabaseTlsPorts,
): Promise<Record<string, unknown>> {
  const statefulSet = await ports.readStatefulSet(request.namespace, `${request.release}-postgres`);
  if (!statefulSet) invalid();
  const persistentVolumeClaim = await ports.readPersistentVolumeClaim(
    request.namespace,
    `postgres-data-${request.release}-postgres-0`,
  );
  const [legacy, stable, tls] = await Promise.all([
    ports.readSecret(request.namespace, request.legacyDatabaseSecret),
    ports.readSecret(request.namespace, request.stableDatabaseSecret),
    ports.readSecret(request.namespace, request.databaseTlsSecret),
  ]);
  const legacySecret = exactSecret(
    legacy,
    request.namespace,
    request.legacyDatabaseSecret,
    LEGACY_KEYS,
  );
  const stableSecret = exactSecret(
    stable,
    request.namespace,
    request.stableDatabaseSecret,
    STABLE_KEYS,
  );
  const tlsSecret = exactSecret(tls, request.namespace, request.databaseTlsSecret, TLS_KEYS, [
    'Opaque',
    'kubernetes.io/tls',
  ]);
  const { caPem, expectedServerSpkiSha256 } = ports.validateTlsIdentity(request, tlsSecret);
  for (const [key, login] of Object.entries(LEGACY_LOGINS)) {
    const url = postgresUrl(decode(legacySecret.data[key]), login, false);
    await ports.authenticate(url.toString(), login);
    const stableUrl = postgresUrl(decode(stableSecret.data[key]), login, true);
    const passwordKey = key.replace(/-url$/, '-password');
    if (
      url.protocol !== stableUrl.protocol ||
      url.username !== stableUrl.username ||
      decodeURIComponent(url.password) !== decodeURIComponent(stableUrl.password) ||
      url.hostname !== stableUrl.hostname ||
      (url.port || '5432') !== (stableUrl.port || '5432') ||
      url.pathname !== stableUrl.pathname ||
      url.hash !== stableUrl.hash ||
      canonicalBootstrapJson([...stableUrl.searchParams.entries()]) !==
        canonicalBootstrapJson([...url.searchParams.entries(), ['sslmode', 'verify-full']]) ||
      legacySecret.data[passwordKey] !== stableSecret.data[passwordKey] ||
      decode(legacySecret.data[passwordKey]) !== decodeURIComponent(url.password)
    ) {
      invalid();
    }
  }
  if (legacySecret.data['postgres-password'] !== stableSecret.data['postgres-password']) invalid();
  const ownerUrl = postgresUrl(decode(stableSecret.data['owner-url']), 'commander_owner', true);
  const authorityUrl = postgresUrl(
    decode(stableSecret.data['tenant-authority-url']),
    'commander_tenant_authority',
    true,
  );
  if (
    authorityUrl.hostname !== ownerUrl.hostname ||
    (authorityUrl.port || '5432') !== (ownerUrl.port || '5432') ||
    authorityUrl.pathname !== ownerUrl.pathname ||
    decodeURIComponent(authorityUrl.password) !==
      decode(stableSecret.data['tenant-authority-password'])
  ) {
    invalid();
  }
  const beforePreservation = exactPreservationSnapshot(
    await ports.preservationSnapshot({ url: decode(legacySecret.data['owner-url']) }),
  );
  const plan = validateStatefulSet(request, statefulSet, persistentVolumeClaim);
  const existingDigest =
    statefulSet.spec?.template?.metadata?.annotations?.[
      'commander.io/database-transport-content-sha256'
    ];
  const desiredDigest =
    plan.desiredTemplate.metadata.annotations['commander.io/database-transport-content-sha256'];
  const alreadyPrepared = existingDigest === desiredDigest;
  if (existingDigest !== undefined && !alreadyPrepared) {
    invalid('TENANT_DATABASE_TLS_PREPARATION_DRIFT');
  }
  try {
    if (!alreadyPrepared) {
      await ports.patchTemplate(
        request.namespace,
        `${request.release}-postgres`,
        plan.resourceVersion,
        plan.desiredTemplate,
      );
    }
    await ports.waitRollout(request.namespace, `${request.release}-postgres`);
    for (const [key, login] of Object.entries(LEGACY_LOGINS)) {
      await ports.authenticate(
        decode(stableSecret.data[key]),
        login,
        caPem,
        expectedServerSpkiSha256,
      );
    }
    const afterPreservation = exactPreservationSnapshot(
      await ports.preservationSnapshot({
        url: decode(stableSecret.data['owner-url']),
        baseline: beforePreservation,
        caPem,
        expectedServerSpkiSha256,
      }),
    );
    if (!equalJson(afterPreservation, beforePreservation)) invalid();
    const legacyAfter = await ports.readSecret(request.namespace, request.legacyDatabaseSecret);
    if (canonicalBootstrapJson(legacyAfter) !== canonicalBootstrapJson(legacySecret)) invalid();
    const [stableAfter, tlsAfter] = await Promise.all([
      ports.readSecret(request.namespace, request.stableDatabaseSecret),
      ports.readSecret(request.namespace, request.databaseTlsSecret),
    ]);
    if (
      canonicalBootstrapJson(stableAfter) !== canonicalBootstrapJson(stableSecret) ||
      canonicalBootstrapJson(tlsAfter) !== canonicalBootstrapJson(tlsSecret)
    ) {
      invalid();
    }
    const completedStatefulSet = await ports.readStatefulSet(
      request.namespace,
      `${request.release}-postgres`,
    );
    if (!equalJson(completedStatefulSet?.spec?.template, plan.desiredTemplate)) invalid();
    assertPvcIdentity(
      plan.persistentVolumeClaimIdentity,
      await ports.readPersistentVolumeClaim(
        request.namespace,
        `postgres-data-${request.release}-postgres-0`,
      ),
    );
  } catch (error) {
    await restoreStatefulSetTemplate(
      ports,
      request.namespace,
      `${request.release}-postgres`,
      plan.oldTemplate,
    );
    throw error;
  }
  return {
    mode: 'bundled-database-tls',
    status: alreadyPrepared ? 'unchanged' : 'prepared',
    namespace: request.namespace,
    statefulSet: `${request.release}-postgres`,
    transportContentSha256: desiredDigest,
  };
}

function command(
  file: string,
  args: readonly string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { encoding: 'utf8', env: options.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(new Error('TENANT_DATABASE_TLS_PREPARATION_COMMAND_FAILED'))
          : resolve(stdout),
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

function secretSnapshot(value: string): KubernetesSecretSnapshot | null {
  if (!value.trim()) return null;
  const object = JSON.parse(value) as JsonObject;
  if (object.apiVersion !== 'v1' || object.kind !== 'Secret') invalid();
  return {
    metadata: {
      namespace: object.metadata?.namespace,
      name: object.metadata?.name,
      resourceVersion: object.metadata?.resourceVersion,
    },
    type: object.type,
    data: object.data,
  };
}

function pgEnvironment(value: string, caPath?: string): NodeJS.ProcessEnv {
  const url = postgresUrl(value, decodeURIComponent(new URL(value).username), Boolean(caPath));
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: caPath ? 'verify-full' : 'disable',
    ...(caPath ? { PGSSLROOTCERT: caPath } : {}),
  };
}

function preservationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalBootstrapJson(value), 'utf8').digest('hex');
}

export function createBundledDatabaseTlsPorts(): BundledDatabaseTlsPorts {
  const read = async (
    kind: string,
    namespace: string,
    name: string,
  ): Promise<JsonObject | null> => {
    const output = await command('kubectl', [
      'get',
      kind,
      name,
      '--namespace',
      namespace,
      '--ignore-not-found=true',
      '--output=json',
    ]);
    return output.trim() ? (JSON.parse(output) as JsonObject) : null;
  };
  const withPgEnvironment = async <T>(
    url: string,
    caPem: string | undefined,
    run: (environment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> => {
    if (!caPem) return run(pgEnvironment(url));
    const directory = await mkdtemp(join(tmpdir(), 'commander-database-ca-'));
    const caPath = join(directory, 'ca.crt');
    try {
      await chmod(directory, 0o700);
      await writeFile(caPath, caPem, { mode: 0o400, flag: 'wx' });
      return await run(pgEnvironment(url, caPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const query = async (url: string, sql: string, caPem?: string): Promise<string> =>
    withPgEnvironment(url, caPem, async (env) =>
      (
        await command(
          'psql',
          ['--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--command', sql],
          { env },
        )
      ).trim(),
    );
  const preservationSnapshot = async (
    input: BundledDatabasePreservationInput,
  ): Promise<BundledDatabasePreservationSnapshot> =>
    withPgEnvironment(input.url, input.caPem, async (env) => {
      if (Boolean(input.caPem) !== Boolean(input.expectedServerSpkiSha256)) invalid();
      const pool = input.caPem
        ? createVerifiedPostgresPool(
            {
              connectionString: input.url,
              max: 1,
              connectionTimeoutMillis: 10_000,
              query_timeout: 30_000,
            },
            {
              ...env,
              COMMANDER_DATABASE_TLS_CA_FILE: env.PGSSLROOTCERT,
              COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: input.expectedServerSpkiSha256,
            },
          )
        : new Pool({
            connectionString: input.url,
            max: 1,
            connectionTimeoutMillis: 10_000,
            query_timeout: 30_000,
          });
      const client = await pool.connect();
      let open = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        open = true;
        const sentinelIdResult = await client.query<{ id: string }>(`
          SELECT run.id::text AS id
            FROM public.commander_runs AS run
           WHERE run.metadata ->> '${BUNDLED_DATABASE_TLS_SENTINEL.metadataKey}' =
                 '${BUNDLED_DATABASE_TLS_SENTINEL.metadataValue}'
             AND run.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED')
           ORDER BY run.id COLLATE "C"
        `);
        const sentinelIds = sentinelIdResult.rows.map((row) => row.id);
        if (sentinelIds.length === 0) invalid();
        if (
          input.baseline &&
          !equalJson(sentinelIds, exactPreservationSnapshot(input.baseline).sentinelIds)
        ) {
          invalid();
        }
        const sentinelResult = await client.query<{ id: string; row_json: string }>(
          `
            SELECT run.id::text AS id, pg_catalog.row_to_json(run)::text AS row_json
              FROM public.commander_runs AS run
             WHERE run.id = ANY($1::text[])
             ORDER BY run.id COLLATE "C"
          `,
          [sentinelIds],
        );
        if (
          sentinelResult.rows.length !== sentinelIds.length ||
          sentinelResult.rows.some((row, index) => row.id !== sentinelIds[index])
        ) {
          invalid();
        }
        const inventory = await collectTask1PrebootstrapInventory(client, null, {
          transaction: 'caller',
        });
        const schema = {
          namespaces: inventory.namespaces,
          relations: inventory.relations,
          functions: inventory.functions,
          types: inventory.types,
          extensions: inventory.extensions,
          policies: inventory.policies,
          triggers: inventory.triggers,
        };
        const roles = {
          roles: inventory.roles,
          memberships: inventory.memberships,
          roleSettings: inventory.roleSettings,
          databaseAcl: inventory.databaseAcl,
          schemaAcls: inventory.schemaAcls,
          defaultAcls: inventory.defaultAcls,
        };
        const catalog = {
          postgresVersion: inventory.postgresVersion,
          catalogVersion: inventory.catalogVersion,
          databaseIdentity: inventory.databaseIdentity,
          productSources: inventory.productSources,
          schema,
          roles,
          ledger: inventory.ledger,
        };
        const snapshot: BundledDatabasePreservationSnapshot = {
          format: 'bundled-database-preservation/v1',
          sentinelIds,
          sentinelRowsSha256: preservationDigest(
            sentinelResult.rows.map((row) => JSON.parse(row.row_json) as unknown),
          ),
          schemaSha256: preservationDigest(schema),
          rolesSha256: preservationDigest(roles),
          ledgerSha256: preservationDigest(inventory.ledger),
          catalogSha256: preservationDigest(catalog),
        };
        await client.query('COMMIT');
        open = false;
        return exactPreservationSnapshot(snapshot);
      } finally {
        if (open) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // The caller receives the original snapshot failure.
          }
        }
        client.release();
        await pool.end();
      }
    });
  return {
    readStatefulSet: (namespace, name) => read('statefulset', namespace, name),
    readPersistentVolumeClaim: (namespace, name) => read('persistentvolumeclaim', namespace, name),
    readSecret: async (namespace, name) =>
      secretSnapshot(
        await command('kubectl', [
          'get',
          'secret',
          name,
          '--namespace',
          namespace,
          '--ignore-not-found=true',
          '--output=json',
        ]),
      ),
    authenticate: async (url, expectedLogin, caPem, expectedServerSpkiSha256) => {
      if (caPem && expectedServerSpkiSha256) {
        await withPgEnvironment(url, caPem, async (env) => {
          const pool = createVerifiedPostgresPool(
            {
              connectionString: url,
              max: 1,
              connectionTimeoutMillis: 10_000,
              query_timeout: 10_000,
            },
            {
              ...env,
              COMMANDER_DATABASE_TLS_CA_FILE: env.PGSSLROOTCERT,
              COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: expectedServerSpkiSha256,
            },
          );
          try {
            const result = await pool.query<{
              current_user: string;
              session_user: string;
            }>('SELECT current_user::text AS current_user, session_user::text AS session_user');
            if (
              result.rowCount !== 1 ||
              result.rows[0]?.current_user !== expectedLogin ||
              result.rows[0]?.session_user !== expectedLogin
            ) {
              invalid();
            }
          } finally {
            await pool.end();
          }
        });
        return;
      }
      const output = await query(url, 'SELECT current_user::text || chr(9) || session_user::text');
      if (output !== `${expectedLogin}\t${expectedLogin}`) invalid();
    },
    validateTlsIdentity: validateBundledDatabaseTlsIdentity,
    preservationSnapshot,
    patchTemplate: async (namespace, name, resourceVersion, template) => {
      await command(
        'kubectl',
        ['patch', 'statefulset', name, '--namespace', namespace, '--type=json', '--patch-file=-'],
        {
          stdin: canonicalBootstrapJson(statefulSetTemplateJsonPatch(resourceVersion, template)),
        },
      );
    },
    waitRollout: async (namespace, name) => {
      await command('kubectl', [
        'rollout',
        'status',
        `statefulset/${name}`,
        '--namespace',
        namespace,
        '--timeout=10m',
      ]);
    },
  };
}

async function main(): Promise<void> {
  const request = parseBundledDatabaseTlsArgs(process.argv.slice(2));
  const result = await runBundledDatabaseTlsPreparation(request, createBundledDatabaseTlsPorts());
  process.stdout.write(`${canonicalBootstrapJson(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch(() => {
    process.stderr.write('TENANT_DATABASE_TLS_PREPARATION_FAILED\n');
    process.exitCode = 1;
  });
}
