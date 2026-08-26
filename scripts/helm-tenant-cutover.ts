#!/usr/bin/env tsx
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as launchProcess } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { dump, load, loadAll } from 'js-yaml';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
} from '../packages/kernel/src/canonicalBootstrap.js';
import {
  KERNEL_TASK1_BASELINE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATIONS,
} from '../packages/kernel/src/migrations.js';
import { verifyChartContentDigest } from './chart-content-digest.js';
import {
  materializeRetainedRendererValues,
  projectHelmReleaseRevision,
} from './helm-release-projection.js';
import {
  cleanupFailedTargetOnlyObjects,
  verifyRestoredReleaseProjection,
  type HelmRecoveryKubernetesPort,
  type HelmReleaseObjectIdentity,
  type HelmReleaseObjectProjection,
  type HelmReleaseProjection,
} from './helm-recover-tenant-authority.js';
import { createTask1DatabasePeerBindingInput } from './task1-database-peer-input.js';
import { isAllowedHelmDiagnosticCode } from './helm-diagnostic-policy.js';

export const HELM_VERSION = '3.17.3';
export type HelmCutoverCommand = 'install' | 'expand' | 'enforce' | 'rollback-recorded-expand';
export type HelmPhase = 'expand' | 'enforce';
export type HelmOperationKind =
  | 'legacy_expand'
  | 'fresh_enforce'
  | 'enforce'
  | 'recover_runtime_after_enforce_failure'
  | 'rollback_to_recorded_expand';

export interface HelmPlatformBinding {
  kind: 'helm';
  namespace: string;
  releaseName: string;
  chartContentSha256: string;
  phase: HelmPhase;
  apiImageDigest: string;
}

export interface HelmOperation {
  operationVersion: string;
  operationKind: HelmOperationKind;
  phase: HelmPhase;
  platformBinding: HelmPlatformBinding;
  businessConfiguration: Record<string, unknown>;
  configuration: Record<string, unknown> & { operationAuditNonce: string };
  configurationSha256: string;
  proven: boolean;
  restore?: {
    revision: string;
    releaseProjection: HelmReleaseProjection;
    releaseProjectionSha256: string;
  };
}

export type HelmTenantCutoverRequest =
  | {
      command: HelmCutoverCommand;
      namespace: string;
      release: string;
      values: string;
      chart: string;
      stateDirectory: string;
    }
  | {
      command: 'restore-recorded-current';
      namespace: string;
      release: string;
      chart: string;
      stateDirectory: string;
    };

export interface HelmFileSystemPort {
  mkdir(path: string): Promise<void>;
  writeFileAtomic(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  retainedChartPackage(
    stateDirectory: string,
    namespace: string,
    release: string,
    chartContentSha256: string,
  ): Promise<string>;
  retainChartPackage(
    source: string,
    stateDirectory: string,
    namespace: string,
    release: string,
    chartContentSha256: string,
  ): Promise<string>;
}

export interface HelmOwnerPort {
  plan(
    request: Record<string, unknown>,
    context: HelmOwnerExecutionContext,
  ): Promise<
    { action: 'append' } | { action: 'return_current' | 'retry_rollout'; operation: HelmOperation }
  >;
  append(
    request: Record<string, unknown>,
    context: HelmOwnerExecutionContext,
  ): Promise<HelmOperation>;
  restore(request: Record<string, unknown>): Promise<HelmOperation>;
}

export interface HelmOwnerExecutionContext {
  namespace: string;
  release: string;
  image: string;
  databaseSecretName: string;
  databaseSecretKeys: {
    owner: string;
    app: string;
    tenantAuthority: string;
    scheduler: string;
    worker: string;
    adapterOps: string;
  };
  databaseTls: {
    secretName: string;
    caKey: string;
    expectedServerSpkiSha256: string;
  };
  proofCertificate: { secretName: string; certKey: string };
  bootstrap:
    | { kind: 'none' }
    | { kind: 'bundled'; user: string; passwordSecretKey: string }
    | { kind: 'external'; secretName: string; secretKey: string };
}

export interface HelmProcessPort {
  version(): Promise<string>;
  run(args: readonly string[], stdin?: string): Promise<string>;
  nextRevision(namespace: string, release: string): Promise<string>;
  runProjectedRevision(request: {
    namespace: string;
    release: string;
    revision: string;
    projectionConfigMapName: string;
    args: readonly string[];
    rendererValues: string;
  }): Promise<HelmReleaseProjection>;
  releaseExists(namespace: string, release: string): Promise<boolean>;
  currentRevision(namespace: string, release: string): Promise<string>;
  projectRevision(
    namespace: string,
    release: string,
    revision: string,
    chart: string,
  ): Promise<HelmReleaseProjection>;
  proofJobManifest(namespace: string, release: string, revision: string): Promise<string>;
  restoreRevision(request: {
    namespace: string;
    release: string;
    revision: string;
    chart: string;
    args: readonly string[];
    retainedProjection: HelmReleaseProjection;
    targetRevision: string;
    projectionConfigMapName: string;
    rendererValues: string;
  }): Promise<void>;
}

export interface HelmCutoverPorts {
  chartDigest(chart: string): string;
  readValues(path: string): Promise<string>;
  createNonce(): string;
  fs: HelmFileSystemPort;
  owner: HelmOwnerPort;
  helm: HelmProcessPort;
  kubectl: HelmRecoveryKubernetesPort & {
    readSecretValue(namespace: string, name: string, key: string): Promise<Buffer>;
    prepareFreshBundledDatabaseSecret(request: {
      namespace: string;
      name: string;
      hostname: string;
      port: number;
      database: string;
    }): Promise<void>;
    prepareProofOwnerSecret(request: {
      namespace: string;
      sourceName: string;
      sourceKey: string;
      targetName: string;
    }): Promise<void>;
    captureProofHookFailureDiagnostic(namespace: string, release: string): Promise<string>;
    cleanupProofResources(namespace: string, release: string): Promise<void>;
    prepareReleaseProjectionConfigMap(request: {
      namespace: string;
      release: string;
      revision: string;
      name: string;
      projection: HelmReleaseProjection;
    }): Promise<void>;
    runProofJob(request: {
      namespace: string;
      name: string;
      revision: string;
      manifest: string;
    }): Promise<unknown>;
    deleteAndVerifyConfigMap(namespace: string, name: string): Promise<void>;
    deleteAndVerifySecret(namespace: string, name: string): Promise<void>;
  };
}

export type HelmCutoverResult = {
  action: 'returned_current' | 'deployed' | 'retried' | 'restored';
  operation: HelmOperation;
};

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SECRET_KEY = /^[A-Za-z0-9._-]+$/;

function fail(code: string): never {
  throw new Error(code);
}

const OWNER_MIGRATION_FAILURE_STAGE =
  '(input|proof_runtime|bootstrap_kernel|bootstrap_closure|owner_pool_configuration|owner_pool_connect|bootstrap_context|bootstrap_context_authority_url|bootstrap_context_pool_configuration|bootstrap_context_pool_connect|bootstrap_context_catalog_query|bootstrap_context_pool_close|lifecycle_initialize|lifecycle_pinned_manifest_validation|lifecycle_prepared_request_validation|lifecycle_table_discovery|lifecycle_candidate_peer_observation|lifecycle_candidate_peer_validation|lifecycle_prebootstrap_snapshot|lifecycle_prebootstrap_snapshot_comparison|lifecycle_initialization_planning|lifecycle_descriptor_transaction|lifecycle_peer_reobservation|lifecycle_peer_reobservation_input_consistency|lifecycle_peer_reobservation_candidate_binding_validation|lifecycle_peer_reobservation_observed_binding_validation|lifecycle_peer_reobservation_binding_consistency|lifecycle_transaction|current_read|rollout_proof)';
const OWNER_MIGRATION_CATALOG_STEP =
  '(search_path|identity|ledger|namespaces|relations|functions|types|extensions|policies|triggers|roles|memberships|role_settings|database_acl|schema_acls|default_acls|product_has_rows)';
const OWNER_MIGRATION_SNAPSHOT_TRANSACTION = '(begin|commit)';
const OWNER_MIGRATION_SNAPSHOT_VALIDATION =
  '(bootstrap_validation|identity_validation|product_source_validation|catalog_version_validation|origin_classification)';
const OWNER_MIGRATION_ORIGIN_CLASSIFICATION_STEP =
  '(fresh_catalog_shape|role_envelope|role_attributes|memberships|public_acl)';
const OWNER_MIGRATION_PROOF_RECORD =
  /\bCOMMANDER_MIGRATION_FAILED;owner_stage=rollout_proof;proof_code=(TENANT_CUTOVER_KUBERNETES_PROOF_INVALID);proof_invariant=(task1KubernetesProofObserver\.(?:ts|js):[1-9][0-9]*:[1-9][0-9]*)\b/g;

/** Keep failed owner Job evidence useful without reflecting credentials or raw logs. */
export function ownerJobFailureDiagnostic(
  logs: string,
  transport: 'kubectl_logs' | 'kubectl_logs_unavailable' = 'kubectl_logs',
): string {
  const tail = logs.slice(-4_096);
  const proofDiagnostic = [...tail.matchAll(OWNER_MIGRATION_PROOF_RECORD)].at(-1);
  const migrationDiagnostic = [
    ...tail.matchAll(
      new RegExp(
        '\\bCOMMANDER_MIGRATION_FAILED;owner_stage=' +
          OWNER_MIGRATION_FAILURE_STAGE +
          '(?:;snapshot=(s0|s1)(?:;catalog_step=' +
          OWNER_MIGRATION_CATALOG_STEP +
          '|;snapshot_transaction=' +
          OWNER_MIGRATION_SNAPSHOT_TRANSACTION +
          '|;snapshot_validation=' +
          OWNER_MIGRATION_SNAPSHOT_VALIDATION +
          '(?:;origin_classification_step=' +
          OWNER_MIGRATION_ORIGIN_CLASSIFICATION_STEP +
          ')?' +
          ')' +
          ')?' +
          '(?:;migration=([0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]+\\.[a-z0-9_]+);phase=(baseline|lifecycle|expand|enforce);sqlstate=([0-9A-Z]{5}))?\\b',
        'g',
      ),
    ),
  ].at(-1);
  const codes = (
    tail.match(/\b(?:COMMANDER|TASK1|TENANT_CUTOVER)_[A-Z0-9_]{1,80}\b/g) ?? []
  ).filter(isAllowedHelmDiagnosticCode);
  const code = codes.at(-1) ?? 'TENANT_CUTOVER_OWNER_JOB_LOG_UNCLASSIFIED';
  const digest = createHash('sha256').update(tail).digest('hex');
  if (proofDiagnostic) {
    return (
      'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=' +
      transport +
      ';owner_stage=rollout_proof;proof_code=' +
      proofDiagnostic[1] +
      ';proof_invariant=' +
      proofDiagnostic[2] +
      ';log_sha256=' +
      digest
    );
  }
  if (migrationDiagnostic) {
    const diagnostic =
      'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=' +
      transport +
      ';owner_stage=' +
      migrationDiagnostic[1];
    const snapshotDiagnostic = migrationDiagnostic[2]
      ? migrationDiagnostic[3]
        ? diagnostic +
          ';snapshot=' +
          migrationDiagnostic[2] +
          ';catalog_step=' +
          migrationDiagnostic[3]
        : migrationDiagnostic[4]
          ? diagnostic +
            ';snapshot=' +
            migrationDiagnostic[2] +
            ';snapshot_transaction=' +
            migrationDiagnostic[4]
          : migrationDiagnostic[5]
            ? diagnostic +
              ';snapshot=' +
              migrationDiagnostic[2] +
              ';snapshot_validation=' +
              migrationDiagnostic[5] +
              (migrationDiagnostic[5] === 'origin_classification' && migrationDiagnostic[6]
                ? ';origin_classification_step=' + migrationDiagnostic[6]
                : '')
            : diagnostic
      : diagnostic;
    return migrationDiagnostic[7]
      ? snapshotDiagnostic +
          ';migration=' +
          migrationDiagnostic[7] +
          ';phase=' +
          migrationDiagnostic[8] +
          ';sqlstate=' +
          migrationDiagnostic[9] +
          ';log_sha256=' +
          digest
      : snapshotDiagnostic + ';log_sha256=' + digest;
  }
  return (
    'code=' + code + ';producer=owner_entrypoint;transport=' + transport + ';log_sha256=' + digest
  );
}

function proofResourceSelector(release: string): string {
  return [
    'commander.io/tenant-authority-proof-reader=true',
    'commander.io/tenant-authority-proof-release=' + release,
  ].join(',');
}

function phase(command: HelmCutoverCommand): HelmPhase {
  return command === 'expand' || command === 'rollback-recorded-expand' ? 'expand' : 'enforce';
}

function expectedKinds(command: HelmCutoverCommand): ReadonlySet<HelmOperationKind> {
  if (command === 'install') return new Set(['fresh_enforce']);
  if (command === 'expand') return new Set(['legacy_expand']);
  if (command === 'rollback-recorded-expand') return new Set(['rollback_to_recorded_expand']);
  return new Set(['fresh_enforce', 'enforce']);
}

function requireName(value: string): string {
  if (!NAME.test(value) || value.length > 63) fail('TENANT_CUTOVER_CLI_ARGUMENT_INVALID');
  return value;
}

export function parseHelmTenantCutoverArgs(
  args: readonly string[],
  cwd: string,
): HelmTenantCutoverRequest {
  const command = args[0];
  const base = {
    chart: 'deploy/helm/commander',
    stateDirectory: resolve(cwd, '.commander/tenant-cutover'),
  };
  if (command === 'restore-recorded-current') {
    if (args.length !== 5 || args[1] !== '--namespace' || args[3] !== '--release')
      fail('TENANT_CUTOVER_CLI_ARGUMENT_INVALID');
    return {
      command,
      namespace: requireName(args[2] ?? ''),
      release: requireName(args[4] ?? ''),
      ...base,
    };
  }
  if (!['install', 'expand', 'enforce', 'rollback-recorded-expand'].includes(command ?? ''))
    fail('TENANT_CUTOVER_CLI_ARGUMENT_INVALID');
  if (
    args.length !== 7 ||
    args[1] !== '--namespace' ||
    args[3] !== '--release' ||
    args[5] !== '--values' ||
    !args[6]
  ) {
    fail('TENANT_CUTOVER_CLI_ARGUMENT_INVALID');
  }
  return {
    command: command as HelmCutoverCommand,
    namespace: requireName(args[2] ?? ''),
    release: requireName(args[4] ?? ''),
    values: isAbsolute(args[6]!) ? args[6]! : resolve(cwd, args[6]!),
    ...base,
  };
}

function assertHelmVersion(version: string): void {
  if (!new RegExp(`^v${HELM_VERSION}(?:[+.-]|$)`).test(version.trim()))
    fail('TENANT_CUTOVER_HELM_VERSION_INVALID');
}

function apiImageDigest(values: string): string {
  let parsed: unknown;
  try {
    parsed = load(values);
  } catch {
    return fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const root = yamlRecord(parsed);
  const image = yamlRecord(root.image);
  if (typeof image.digest !== 'string' || !IMAGE.test(image.digest)) {
    fail('TENANT_CUTOVER_IMAGE_NOT_DIGEST_PINNED');
  }
  return image.digest;
}

function valuesSha256(values: string): string {
  return createHash('sha256').update(values, 'utf8').digest('hex');
}

function requestArtifact(operation: HelmOperation, command: HelmCutoverCommand): string {
  return `${canonicalBootstrapJson({
    schema: 'tenant-cutover-request/v1',
    command,
    prepared: {
      platformBinding: operation.platformBinding,
      businessConfiguration: operation.businessConfiguration,
      configuration: operation.configuration,
      configurationSha256: operation.configurationSha256,
    },
  })}\n`;
}

function artifactPath(request: HelmTenantCutoverRequest, operation: HelmOperation): string {
  return `${request.stateDirectory}/${request.namespace}/${request.release}/requests/${operation.operationVersion}.json`;
}

async function persistArtifact(
  request: HelmTenantCutoverRequest,
  operation: HelmOperation,
  command: HelmCutoverCommand,
  fs: HelmFileSystemPort,
): Promise<void> {
  const directory = dirname(artifactPath(request, operation));
  await fs.mkdir(directory);
  await fs.writeFileAtomic(artifactPath(request, operation), requestArtifact(operation, command));
}

async function loadArtifact(
  request: HelmTenantCutoverRequest,
  operation: HelmOperation,
  command: HelmCutoverCommand,
  fs: HelmFileSystemPort,
): Promise<void> {
  let bytes: string;
  try {
    bytes = await fs.readFile(artifactPath(request, operation));
  } catch {
    fail('TENANT_CUTOVER_OPERATION_ARTIFACT_MISSING');
  }
  if (bytes !== requestArtifact(operation, command))
    fail('TENANT_CUTOVER_OPERATION_ARTIFACT_DRIFT');
}

function assertOperation(
  operation: HelmOperation,
  command: HelmCutoverCommand,
  chartDigest: string,
  target: { namespace: string; release: string },
): void {
  if (
    !/^[1-9][0-9]*$/.test(operation.operationVersion) ||
    !expectedKinds(command).has(operation.operationKind) ||
    operation.phase !== phase(command)
  )
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  const binding = operation.platformBinding;
  if (
    binding.kind !== 'helm' ||
    binding.namespace !== target.namespace ||
    binding.releaseName !== target.release ||
    binding.chartContentSha256 !== chartDigest ||
    binding.phase !== operation.phase ||
    !IMAGE.test(binding.apiImageDigest) ||
    !SHA256.test(operation.configurationSha256) ||
    !/^[A-Za-z0-9_-]{43}$/.test(operation.configuration.operationAuditNonce)
  )
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  if (canonicalBootstrapSha256(operation.configuration) !== operation.configurationSha256)
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
}

function runtimeMigrationDescriptors(phase: HelmOperation['phase']): string {
  const task1ClosureDescriptors = KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(
    0,
    phase === 'expand' ? 2 : KERNEL_TASK1_CLOSURE_MIGRATIONS.length,
  );
  return JSON.stringify(
    Object.fromEntries(
      [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...task1ClosureDescriptors].map(({ id, checksum }) => [
        id,
        checksum,
      ]),
    ),
  );
}

function escapeHelmString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll(',', '\\,');
}

export function buildHelmRolloutArgs(
  operation: HelmOperation,
  request: {
    namespace: string;
    release: string;
    values: string;
    chart?: string;
    setValues?: readonly string[];
    releaseProjectionConfigMap?: string;
  },
  helmVersion: string,
  allowInstall = true,
): string[] {
  assertHelmVersion(helmVersion);
  return [
    'upgrade',
    ...(allowInstall && operation.operationKind === 'fresh_enforce' ? ['--install'] : []),
    request.release,
    request.chart ?? 'deploy/helm/commander',
    '--namespace',
    request.namespace,
    '--values',
    request.values,
    '--set',
    `tenantAuthority.cutoverPhase=${operation.phase}`,
    '--set',
    `tenantAuthority.configurationSha256=${operation.configurationSha256}`,
    '--set',
    `tenantAuthority.proofOwnerSecret=${proofOwnerSecretName(request.release, operation.operationVersion)}`,
    ...(request.releaseProjectionConfigMap
      ? [
          '--set',
          `tenantAuthority.releaseProjectionConfigMap=${request.releaseProjectionConfigMap}`,
        ]
      : []),
    '--set-string',
    `tenantAuthority.chartContentSha256=${operation.platformBinding.chartContentSha256}`,
    '--set-string',
    `tenantAuthority.expectedMigrationDescriptors=${escapeHelmString(runtimeMigrationDescriptors(operation.phase))}`,
    ...(request.setValues ?? []).flatMap((value) => ['--set', value]),
    '--atomic',
    '--wait',
    '--wait-for-jobs',
    '--timeout',
    '10m',
  ];
}

export function buildHelmTransportBootstrapArgs(
  request: {
    namespace: string;
    release: string;
    values: string;
    chart: string;
    chartContentSha256: string;
    databaseSecretName: string;
  },
  helmVersion: string,
): string[] {
  assertHelmVersion(helmVersion);
  if (!SHA256.test(request.chartContentSha256)) {
    fail('TENANT_CUTOVER_CHART_DIGEST_INVALID');
  }
  return [
    'upgrade',
    '--install',
    request.release,
    request.chart,
    '--namespace',
    request.namespace,
    '--values',
    request.values,
    '--set',
    `database.postgres.existingSecret=${request.databaseSecretName}`,
    '--set',
    'tenantAuthority.transportBootstrap=true',
    '--set-string',
    `tenantAuthority.chartContentSha256=${request.chartContentSha256}`,
    '--atomic',
    '--wait',
    '--timeout',
    '10m',
  ];
}

function proofOwnerSecretName(release: string, operationVersion: string): string {
  const suffix = `-proof-owner-v${operationVersion}`;
  return `${release.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
}

function releaseProjectionConfigMapName(
  release: string,
  operationVersion: string,
  revision: string,
): string {
  const suffix = `-proof-projection-v${operationVersion}-r${revision}`;
  if (!/^[1-9][0-9]*$/.test(operationVersion) || !/^[1-9][0-9]*$/.test(revision)) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  const name = `${release.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
  if (!NAME.test(name) || name.length > 63) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  return name;
}

function rendererValues(
  values: string,
  operation: HelmOperation,
  setValues: readonly string[],
  projectionConfigMapName: string,
): string {
  let parsed: unknown;
  try {
    parsed = load(values);
  } catch {
    return fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const root = yamlRecord(parsed);
  const apply = (path: string, value: string | boolean): void => {
    const keys = path.split('.');
    let cursor = root;
    for (const key of keys.slice(0, -1)) {
      const child = cursor[key];
      if (child === undefined) cursor[key] = {};
      cursor = yamlRecord(cursor[key]);
    }
    cursor[keys.at(-1)!] = value;
  };
  apply('tenantAuthority.cutoverPhase', operation.phase);
  apply('tenantAuthority.configurationSha256', operation.configurationSha256);
  apply(
    'tenantAuthority.proofOwnerSecret',
    proofOwnerSecretName(operation.platformBinding.releaseName, operation.operationVersion),
  );
  apply('tenantAuthority.chartContentSha256', operation.platformBinding.chartContentSha256);
  apply(
    'tenantAuthority.expectedMigrationDescriptors',
    runtimeMigrationDescriptors(operation.phase),
  );
  apply('tenantAuthority.releaseProjectionConfigMap', projectionConfigMapName);
  for (const entry of setValues) {
    const separator = entry.indexOf('=');
    if (separator < 1) fail('TENANT_CUTOVER_VALUES_INVALID');
    const path = entry.slice(0, separator);
    const raw = entry.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(path)) {
      fail('TENANT_CUTOVER_VALUES_INVALID');
    }
    apply(path, raw === 'true' ? true : raw === 'false' ? false : raw);
  }
  return dump(root, { noRefs: true, sortKeys: true });
}

function yamlRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  return value as Record<string, unknown>;
}

function cloneHelmValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneHelmValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneHelmValue(child),
    ]),
  );
}

function mergeProjectionRendererValues(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = cloneHelmValue(defaults) as Record<string, unknown>;
  for (const [key, override] of Object.entries(overrides)) {
    if (override === null) {
      result[key] = null;
      continue;
    }
    const inherited = result[key];
    result[key] =
      override &&
      typeof override === 'object' &&
      !Array.isArray(override) &&
      inherited &&
      typeof inherited === 'object' &&
      !Array.isArray(inherited)
        ? mergeProjectionRendererValues(
            inherited as Record<string, unknown>,
            override as Record<string, unknown>,
          )
        : cloneHelmValue(override);
  }
  return result;
}

const PROJECTION_RENDERER_DEFAULT_KEYS = [
  'image',
  'database',
  'databaseTls',
  'migration',
  'tenantAuthority',
  'podSecurityContext',
] as const;

async function projectionRendererValues(
  chart: string,
  overrides: string,
  context: 'rollout' | 'restore',
): Promise<string> {
  try {
    const chartDefaults = yamlRecord(load(await readFile(join(chart, 'values.yaml'), 'utf8')));
    const supplied = yamlRecord(load(overrides));
    const projectionDefaults: Record<string, unknown> = {};
    for (const key of PROJECTION_RENDERER_DEFAULT_KEYS) {
      if (!Object.hasOwn(chartDefaults, key)) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      projectionDefaults[key] = chartDefaults[key];
    }
    return dump(mergeProjectionRendererValues(projectionDefaults, supplied), {
      noRefs: true,
      sortKeys: true,
    });
  } catch {
    return fail(
      context === 'rollout'
        ? 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'
        : 'TENANT_CUTOVER_RESTORE_PROJECTION_INVALID',
    );
  }
}

function databaseOwnerSecretReference(
  values: string,
  release: string,
): {
  sourceName: string;
  sourceKey: string;
} {
  let parsed: unknown;
  try {
    parsed = load(values);
  } catch {
    return fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const root = yamlRecord(parsed);
  const database =
    root.database && typeof root.database === 'object' && !Array.isArray(root.database)
      ? (root.database as Record<string, unknown>)
      : {};
  const postgres =
    database.postgres && typeof database.postgres === 'object' && !Array.isArray(database.postgres)
      ? (database.postgres as Record<string, unknown>)
      : {};
  const sourceName =
    typeof postgres.existingSecret === 'string' && postgres.existingSecret
      ? postgres.existingSecret
      : `${release}-database`;
  const sourceKey =
    typeof postgres.ownerSecretKey === 'string' && postgres.ownerSecretKey
      ? postgres.ownerSecretKey
      : 'owner-url';
  if (!NAME.test(sourceName) || sourceName.length > 63 || !SECRET_KEY.test(sourceKey)) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  return { sourceName, sourceKey };
}

const DATABASE_SECRET_ROLES = {
  owner: 'commander_owner',
  app: 'commander_app',
  'tenant-authority': 'commander_tenant_authority',
  scheduler: 'commander_scheduler',
  worker: 'commander_worker',
  'adapter-ops': 'commander_adapter_ops',
} as const;

type FreshBundledDatabaseSecretIdentity = {
  namespace: string;
  name: string;
  hostname: string;
  port: number;
  database: string;
};

function decodeCanonicalBase64(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }
  return decoded.toString('utf8');
}

export function validateFreshBundledDatabaseSecret(
  secret: unknown,
  identity: FreshBundledDatabaseSecretIdentity,
): void {
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }
  const object = secret as Record<string, unknown>;
  const metadata = object.metadata;
  const data = object.data;
  if (
    object.apiVersion !== 'v1' ||
    object.kind !== 'Secret' ||
    object.immutable !== true ||
    object.type !== 'Opaque' ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).name !== identity.name ||
    (metadata as Record<string, unknown>).namespace !== identity.namespace ||
    canonicalBootstrapJson((metadata as Record<string, unknown>).labels) !==
      canonicalBootstrapJson({ 'app.kubernetes.io/managed-by': 'Commander' }) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }

  const requiredKeys = [
    ...Object.keys(DATABASE_SECRET_ROLES).flatMap((role) => [`${role}-url`, `${role}-password`]),
    'postgres-password',
  ].sort();
  if (canonicalBootstrapJson(Object.keys(data).sort()) !== canonicalBootstrapJson(requiredKeys)) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }
  const decoded = Object.fromEntries(
    Object.entries(data as Record<string, unknown>).map(([key, value]) => [
      key,
      decodeCanonicalBase64(value),
    ]),
  );
  const rolePasswords = Object.keys(DATABASE_SECRET_ROLES).map(
    (role) => decoded[`${role}-password`]!,
  );
  if (new Set(rolePasswords).size !== rolePasswords.length) {
    fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
  }

  for (const [role, login] of Object.entries(DATABASE_SECRET_ROLES)) {
    let url: URL;
    try {
      url = new URL(decoded[`${role}-url`]!);
    } catch {
      return fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
    }
    let password: string;
    try {
      password = decodeURIComponent(url.password);
    } catch {
      return fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
    }
    if (
      url.protocol !== 'postgres:' ||
      decodeURIComponent(url.username) !== login ||
      password !== decoded[`${role}-password`] ||
      url.hostname !== identity.hostname ||
      url.port !== String(identity.port) ||
      url.pathname !== `/${identity.database}` ||
      canonicalBootstrapJson([...url.searchParams.entries()]) !==
        canonicalBootstrapJson([['sslmode', 'verify-full']]) ||
      url.hash !== ''
    ) {
      fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
    }
  }
}

function databaseRolloutPlan(
  values: string,
  release: string,
  command: HelmCutoverCommand,
): {
  reference: { sourceName: string; sourceKey: string };
  setValues: readonly string[];
  freshBundled?: { name: string; hostname: string; port: number; database: string };
} {
  let parsed: unknown;
  try {
    parsed = load(values);
  } catch {
    return fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const root = yamlRecord(parsed);
  const tenantAuthority =
    root.tenantAuthority &&
    typeof root.tenantAuthority === 'object' &&
    !Array.isArray(root.tenantAuthority)
      ? (root.tenantAuthority as Record<string, unknown>)
      : {};
  if (tenantAuthority.transportBootstrap === true) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const database =
    root.database && typeof root.database === 'object' && !Array.isArray(root.database)
      ? (root.database as Record<string, unknown>)
      : {};
  const postgres =
    database.postgres && typeof database.postgres === 'object' && !Array.isArray(database.postgres)
      ? (database.postgres as Record<string, unknown>)
      : {};
  const reference = databaseOwnerSecretReference(values, release);
  if (
    command !== 'install' ||
    database.enabled !== true ||
    database.backend !== 'postgres' ||
    postgres.bundled !== true ||
    (typeof postgres.existingSecret === 'string' && postgres.existingSecret.length > 0)
  ) {
    return { reference, setValues: [] };
  }
  const port = postgres.port ?? 5432;
  const databaseName = postgres.database ?? 'commander';
  if (
    !Number.isSafeInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    typeof databaseName !== 'string' ||
    !NAME.test(databaseName)
  ) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const name = `${release}-database-bootstrap`;
  if (reference.sourceKey !== 'owner-url') {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  return {
    reference: { sourceName: name, sourceKey: reference.sourceKey },
    setValues: [`database.postgres.existingSecret=${name}`],
    freshBundled: {
      name,
      hostname: `${release}-postgres`,
      port: Number(port),
      database: databaseName,
    },
  };
}

function configuredName(value: unknown, fallback?: string): string {
  const selected = typeof value === 'string' && value ? value : fallback;
  if (!selected || !NAME.test(selected) || selected.length > 63) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  return selected;
}

function configuredSecretKey(value: unknown, fallback: string): string {
  const selected = typeof value === 'string' && value ? value : fallback;
  if (!SECRET_KEY.test(selected)) fail('TENANT_CUTOVER_VALUES_INVALID');
  return selected;
}

export function createHelmOwnerExecutionContext(input: {
  values: string;
  namespace: string;
  release: string;
  command: HelmCutoverCommand;
  databaseSecretName: string;
}): HelmOwnerExecutionContext {
  let parsed: unknown;
  try {
    parsed = load(input.values);
  } catch {
    return fail('TENANT_CUTOVER_VALUES_INVALID');
  }
  const root = yamlRecord(parsed);
  const image = yamlRecord(root.image);
  const database = yamlRecord(root.database);
  const postgres = yamlRecord(database.postgres);
  const databaseTls = yamlRecord(root.databaseTls);
  const tenantAuthority = yamlRecord(root.tenantAuthority);
  const apiProof = yamlRecord(tenantAuthority.apiProof);
  const repository = image.repository;
  const digest = apiImageDigest(input.values);
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/.test(repository) ||
    repository.includes('@')
  ) {
    fail('TENANT_CUTOVER_IMAGE_NOT_DIGEST_PINNED');
  }
  const bundled = postgres.bundled === true;
  const tlsSecretName = configuredName(bundled ? databaseTls.existingSecret : databaseTls.caSecret);
  const expectedServerSpkiSha256 = databaseTls.expectedServerSpkiSha256;
  if (typeof expectedServerSpkiSha256 !== 'string' || !SHA256.test(expectedServerSpkiSha256)) {
    fail('TENANT_CUTOVER_VALUES_INVALID');
  }

  let bootstrap: HelmOwnerExecutionContext['bootstrap'] = { kind: 'none' };
  if (input.command === 'install') {
    if (bundled) {
      const user = postgres.user;
      if (
        typeof user !== 'string' ||
        !/^[a-z_][a-z0-9_]*$/.test(user) ||
        user === 'commander' ||
        user.startsWith('commander_')
      ) {
        fail('TENANT_CUTOVER_VALUES_INVALID');
      }
      bootstrap = { kind: 'bundled', user, passwordSecretKey: 'postgres-password' };
    } else {
      bootstrap = {
        kind: 'external',
        secretName: configuredName(tenantAuthority.bootstrapAuthoritySecret),
        secretKey: 'bootstrap-authority-url',
      };
    }
  }

  return {
    namespace: input.namespace,
    release: input.release,
    image: `${repository}@${digest}`,
    databaseSecretName: configuredName(input.databaseSecretName),
    databaseSecretKeys: {
      owner: configuredSecretKey(postgres.ownerSecretKey, 'owner-url'),
      app: configuredSecretKey(postgres.appSecretKey, 'app-url'),
      tenantAuthority: configuredSecretKey(
        postgres.tenantAuthoritySecretKey,
        'tenant-authority-url',
      ),
      scheduler: configuredSecretKey(postgres.schedulerSecretKey, 'scheduler-url'),
      worker: configuredSecretKey(postgres.workerSecretKey, 'worker-url'),
      adapterOps: configuredSecretKey(postgres.adapterOpsSecretKey, 'adapter-ops-url'),
    },
    databaseTls: {
      secretName: tlsSecretName,
      caKey: configuredSecretKey(databaseTls.caKey, 'ca.crt'),
      expectedServerSpkiSha256,
    },
    proofCertificate: {
      secretName: configuredName(apiProof.publicSecret),
      certKey: configuredSecretKey(apiProof.certKey, 'tls.crt'),
    },
    bootstrap,
  };
}

async function runHelmRolloutWithProofCredential(input: {
  operation: HelmOperation;
  namespace: string;
  release: string;
  reference: { sourceName: string; sourceKey: string };
  prepareDatabase?: () => Promise<void>;
  rollout(): Promise<void>;
  ports: HelmCutoverPorts;
}): Promise<void> {
  const targetName = proofOwnerSecretName(input.release, input.operation.operationVersion);
  await input.ports.kubectl.cleanupProofResources(input.namespace, input.release);
  let rolloutStarted = false;
  try {
    await input.prepareDatabase?.();
    await input.ports.kubectl.prepareProofOwnerSecret({
      namespace: input.namespace,
      sourceName: input.reference.sourceName,
      sourceKey: input.reference.sourceKey,
      targetName,
    });
    rolloutStarted = true;
    await input.rollout();
  } catch (error) {
    if (rolloutStarted) {
      const diagnostic = await input.ports.kubectl.captureProofHookFailureDiagnostic(
        input.namespace,
        input.release,
      );
      fail('TENANT_CUTOVER_PROOF_HOOK_FAILED:' + diagnostic);
    }
    throw error;
  } finally {
    try {
      await input.ports.kubectl.cleanupProofResources(input.namespace, input.release);
    } finally {
      await input.ports.kubectl.deleteAndVerifySecret(input.namespace, targetName);
    }
  }
}

function restoreEvidence(operation: HelmOperation): NonNullable<HelmOperation['restore']> {
  const evidence = operation.restore;
  if (
    !evidence ||
    !/^[1-9][0-9]*$/.test(evidence.revision) ||
    !SHA256.test(evidence.releaseProjectionSha256) ||
    canonicalBootstrapSha256(evidence.releaseProjection) !== evidence.releaseProjectionSha256 ||
    evidence.releaseProjection.format !== 'helm-release-projection/v1' ||
    evidence.releaseProjection.namespace !== operation.platformBinding.namespace ||
    evidence.releaseProjection.releaseName !== operation.platformBinding.releaseName ||
    evidence.releaseProjection.revision !== evidence.revision ||
    evidence.releaseProjection.chartContentSha256 !== operation.platformBinding.chartContentSha256
  ) {
    fail('TENANT_CUTOVER_RESTORE_EVIDENCE_INVALID');
  }
  return evidence;
}

function restoredDatabaseOwnerSecretReference(operation: HelmOperation): {
  sourceName: string;
  sourceKey: string;
} {
  const mappings = operation.businessConfiguration.secretFileMappings;
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_MAPPING_INVALID');
  }
  const databaseOwner = (mappings as Record<string, unknown>).databaseOwner;
  if (!databaseOwner || typeof databaseOwner !== 'object' || Array.isArray(databaseOwner)) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_MAPPING_INVALID');
  }
  const sourceName = (databaseOwner as Record<string, unknown>).secretName;
  const sourceKey = (databaseOwner as Record<string, unknown>).secretKey;
  if (
    typeof sourceName !== 'string' ||
    !NAME.test(sourceName) ||
    sourceName.length > 63 ||
    typeof sourceKey !== 'string' ||
    !SECRET_KEY.test(sourceKey)
  ) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_MAPPING_INVALID');
  }
  return { sourceName, sourceKey };
}

function operationWithoutProofEvidence(operation: HelmOperation): Record<string, unknown> {
  const { proven: _proven, restore: _restore, ...current } = operation;
  return current;
}

function assertSameCurrentOperation(expected: HelmOperation, restored: HelmOperation): void {
  if (
    canonicalBootstrapJson(operationWithoutProofEvidence(expected)) !==
    canonicalBootstrapJson(operationWithoutProofEvidence(restored))
  ) {
    fail('TENANT_CUTOVER_PROOF_CURRENT_CHANGED');
  }
}

function proofReaderServiceAccount(namespace: string, release: string): string {
  return `commander-proof-reader-${createHash('sha256')
    .update(`${namespace}/${release}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function exactObjectKeys(value: JsonRecord, expected: readonly string[]): boolean {
  return exactKeys(Object.keys(value), expected);
}

function namedObjects(value: unknown, code: string): Map<string, JsonRecord> {
  if (!Array.isArray(value)) fail(code);
  const result = new Map<string, JsonRecord>();
  for (const item of value) {
    const object = jsonRecord(item, code);
    if (typeof object.name !== 'string' || !object.name || result.has(object.name)) fail(code);
    result.set(object.name, object);
  }
  return result;
}

function retainedProofJobContract(
  projection: HelmReleaseProjection,
  operation: HelmOperation,
): {
  activeDeadlineSeconds: number;
  apiProof: { secretName: string; caKey: string; certKey: string };
  databaseCa: { secretName: string; caKey: string };
  expectedServerSpkiSha256: string;
  image: string;
  imagePullPolicy: string;
  ownerSecretKey: string;
  podSecurityContext: JsonRecord;
  terminationGracePeriodSeconds: number;
  ttlSecondsAfterFinished: number;
} {
  const values = yamlRecord(projection.rendererInput.values);
  const image = yamlRecord(values.image);
  const database = yamlRecord(values.database);
  const postgres = yamlRecord(database.postgres);
  const databaseTls = yamlRecord(values.databaseTls);
  const migration = yamlRecord(values.migration);
  const tenantAuthority = yamlRecord(values.tenantAuthority);
  const apiProof = yamlRecord(tenantAuthority.apiProof);
  const podSecurityContext = yamlRecord(values.podSecurityContext);
  const seccompProfile = yamlRecord(podSecurityContext.seccompProfile);
  const bundled = postgres.bundled;
  const repository = image.repository;
  const digest = image.digest;
  const pullPolicy = image.pullPolicy;
  const spki = databaseTls.expectedServerSpkiSha256;
  const activeDeadlineSeconds = migration.activeDeadlineSeconds;
  const ttlSecondsAfterFinished = migration.ttlSecondsAfterFinished;
  const terminationGracePeriodSeconds = migration.terminationGracePeriodSeconds;
  if (
    database.enabled !== true ||
    database.backend !== 'postgres' ||
    typeof bundled !== 'boolean' ||
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/.test(repository) ||
    repository.includes('@') ||
    digest !== operation.platformBinding.apiImageDigest ||
    !['Always', 'IfNotPresent', 'Never'].includes(String(pullPolicy)) ||
    typeof spki !== 'string' ||
    !SHA256.test(spki) ||
    !Number.isSafeInteger(activeDeadlineSeconds) ||
    Number(activeDeadlineSeconds) <= 0 ||
    !Number.isSafeInteger(ttlSecondsAfterFinished) ||
    Number(ttlSecondsAfterFinished) < 0 ||
    !Number.isSafeInteger(terminationGracePeriodSeconds) ||
    Number(terminationGracePeriodSeconds) <= 0 ||
    podSecurityContext.runAsNonRoot !== true ||
    !Number.isSafeInteger(podSecurityContext.runAsUser) ||
    Number(podSecurityContext.runAsUser) <= 0 ||
    !Number.isSafeInteger(podSecurityContext.runAsGroup) ||
    Number(podSecurityContext.runAsGroup) <= 0 ||
    !Number.isSafeInteger(podSecurityContext.fsGroup) ||
    Number(podSecurityContext.fsGroup) <= 0 ||
    canonicalBootstrapJson(seccompProfile) !== canonicalBootstrapJson({ type: 'RuntimeDefault' }) ||
    !exactObjectKeys(podSecurityContext, [
      'runAsNonRoot',
      'runAsUser',
      'runAsGroup',
      'fsGroup',
      'seccompProfile',
    ]) ||
    (bundled ? databaseTls.caSecret !== '' : databaseTls.existingSecret !== '')
  ) {
    fail('TENANT_CUTOVER_PROOF_JOB_INVALID');
  }
  return {
    activeDeadlineSeconds: Number(activeDeadlineSeconds),
    apiProof: {
      secretName: configuredName(apiProof.publicSecret),
      caKey: configuredSecretKey(apiProof.caKey, 'ca.crt'),
      certKey: configuredSecretKey(apiProof.certKey, 'tls.crt'),
    },
    databaseCa: {
      secretName: configuredName(bundled ? databaseTls.existingSecret : databaseTls.caSecret),
      caKey: configuredSecretKey(databaseTls.caKey, 'ca.crt'),
    },
    expectedServerSpkiSha256: spki,
    image: `${repository}@${digest}`,
    imagePullPolicy: String(pullPolicy),
    ownerSecretKey: configuredSecretKey(postgres.ownerSecretKey, 'owner-url'),
    podSecurityContext,
    terminationGracePeriodSeconds: Number(terminationGracePeriodSeconds),
    ttlSecondsAfterFinished: Number(ttlSecondsAfterFinished),
  };
}

function proofJobForRevision(input: {
  manifest: string;
  operation: HelmOperation;
  projection: HelmReleaseProjection;
  projectionConfigMapName: string;
  ownerSecretKey: string;
}): { name: string; manifest: string } {
  const contract = retainedProofJobContract(input.projection, input.operation);
  const revision = input.projection.revision;
  const suffix = `-tenant-cutover-prove-r${revision}`;
  const name = `${input.projection.releaseName
    .slice(0, 63 - suffix.length)
    .replace(/-$/, '')}${suffix}`;
  const expectedIdentity = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    namespace: input.projection.namespace,
    name,
  };
  const retainedHooks = input.projection.hooks.filter(
    (hook) => canonicalBootstrapJson(hook.identity) === canonicalBootstrapJson(expectedIdentity),
  );
  if (
    retainedHooks.length !== 1 ||
    canonicalBootstrapJson([...retainedHooks[0]!.deletePolicies].sort()) !==
      canonicalBootstrapJson(['before-hook-creation', 'hook-succeeded'])
  ) {
    fail('TENANT_CUTOVER_PROOF_JOB_INVALID');
  }

  const matching: JsonRecord[] = [];
  try {
    loadAll(input.manifest, (document) => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) return;
      const object = document as JsonRecord;
      const metadata = jsonRecord(object.metadata, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
      if (
        object.apiVersion === expectedIdentity.apiVersion &&
        object.kind === expectedIdentity.kind &&
        metadata.name === name &&
        (metadata.namespace === undefined || metadata.namespace === expectedIdentity.namespace)
      ) {
        matching.push(object);
      }
    });
  } catch {
    fail('TENANT_CUTOVER_PROOF_JOB_INVALID');
  }
  if (matching.length !== 1) fail('TENANT_CUTOVER_PROOF_JOB_INVALID');

  const job = matching[0]!;
  const metadata = jsonRecord(job.metadata, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const labels = jsonRecord(metadata.labels, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const annotations = jsonRecord(metadata.annotations, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const hookEvents =
    typeof annotations['helm.sh/hook'] === 'string'
      ? annotations['helm.sh/hook'].split(',').map((value) => value.trim())
      : [];
  const deletePolicies =
    typeof annotations['helm.sh/hook-delete-policy'] === 'string'
      ? annotations['helm.sh/hook-delete-policy']
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .sort()
      : [];
  const spec = jsonRecord(job.spec, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const template = jsonRecord(spec.template, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const podSpec = jsonRecord(template.spec, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const containers = namedObjects(podSpec.containers, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const proofContainer = containers.get('tenant-cutover-prove');
  const env = proofContainer
    ? namedObjects(proofContainer.env, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : new Map<string, JsonRecord>();
  const ownerEnvironment = env.get('COMMANDER_OWNER_DATABASE_URL');
  const ownerValueFrom = ownerEnvironment
    ? jsonRecord(ownerEnvironment.valueFrom, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const ownerSecretReference = ownerEnvironment
    ? jsonRecord(ownerValueFrom.secretKeyRef, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const volumes = namedObjects(podSpec.volumes, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const projectionVolume = volumes.get('release-projection');
  const projectionConfigMap = projectionVolume
    ? jsonRecord(projectionVolume.configMap, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const mounts = proofContainer
    ? namedObjects(proofContainer.volumeMounts, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : new Map<string, JsonRecord>();
  const proofToken = volumes.get('proof-api-token');
  const tokenProjection = proofToken
    ? jsonRecord(proofToken.projected, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const tokenSources = Array.isArray(tokenProjection.sources)
    ? tokenProjection.sources.map((value) => jsonRecord(value, 'TENANT_CUTOVER_PROOF_JOB_INVALID'))
    : [];
  const identityToken = tokenSources[0]
    ? jsonRecord(tokenSources[0].serviceAccountToken, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const apiToken = tokenSources[1]
    ? jsonRecord(tokenSources[1].serviceAccountToken, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const rootCa = tokenSources[2]
    ? jsonRecord(tokenSources[2].configMap, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const rootCaItems = Array.isArray(rootCa.items)
    ? rootCa.items.map((value) => jsonRecord(value, 'TENANT_CUTOVER_PROOF_JOB_INVALID'))
    : [];
  const databaseCa = volumes.get('database-public-ca');
  const databaseCaSecret = databaseCa
    ? jsonRecord(databaseCa.secret, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const databaseCaItems = Array.isArray(databaseCaSecret.items)
    ? databaseCaSecret.items.map((value) => jsonRecord(value, 'TENANT_CUTOVER_PROOF_JOB_INVALID'))
    : [];
  const apiProof = volumes.get('api-proof-public');
  const apiProofSecret = apiProof
    ? jsonRecord(apiProof.secret, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const apiProofItems = Array.isArray(apiProofSecret.items)
    ? apiProofSecret.items.map((value) => jsonRecord(value, 'TENANT_CUTOVER_PROOF_JOB_INVALID'))
    : [];
  const podSecurity = jsonRecord(podSpec.securityContext, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const containerSecurity = proofContainer
    ? jsonRecord(proofContainer.securityContext, 'TENANT_CUTOVER_PROOF_JOB_INVALID')
    : {};
  const capabilities = jsonRecord(
    containerSecurity.capabilities,
    'TENANT_CUTOVER_PROOF_JOB_INVALID',
  );
  const templateMetadata = jsonRecord(template.metadata, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const templateLabels = jsonRecord(templateMetadata.labels, 'TENANT_CUTOVER_PROOF_JOB_INVALID');
  const expectedProofLabels = {
    'app.kubernetes.io/name': input.projection.releaseName,
    'app.kubernetes.io/instance': input.projection.releaseName,
    'commander.io/tenant-authority-proof-reader': 'true',
    'commander.io/tenant-authority-proof-release': input.projection.releaseName,
  };
  const expectedMounts = {
    'proof-api-token': { path: '/var/run/secrets/commander.io/proof-api', readOnly: true },
    'database-public-ca': { path: '/run/commander/database-tls', readOnly: true },
    'api-proof-public': { path: '/run/commander/api-proof-public', readOnly: true },
    'release-projection': { path: '/run/commander/release-projection', readOnly: true },
    tmp: { path: '/tmp', readOnly: false },
  } as const;
  const mountContractValid = Object.entries(expectedMounts).every(([mountName, contract]) => {
    const mount = mounts.get(mountName);
    return (
      mount !== undefined &&
      exactObjectKeys(
        mount,
        contract.readOnly ? ['name', 'mountPath', 'readOnly'] : ['name', 'mountPath'],
      ) &&
      mount.mountPath === contract.path &&
      (contract.readOnly ? mount.readOnly === true : mount.readOnly === undefined)
    );
  });
  const exactApiProofItems = [...apiProofItems].sort((left, right) =>
    String(left.path).localeCompare(String(right.path)),
  );
  if (
    !exactObjectKeys(job, ['apiVersion', 'kind', 'metadata', 'spec']) ||
    !exactKeys(
      Object.keys(metadata),
      metadata.namespace === undefined
        ? ['name', 'labels', 'annotations']
        : ['name', 'namespace', 'labels', 'annotations'],
    ) ||
    !exactKeys(Object.keys(labels), [
      'app.kubernetes.io/name',
      'app.kubernetes.io/instance',
      'app.kubernetes.io/version',
      'app.kubernetes.io/managed-by',
      'helm.sh/chart',
      'commander.io/tenant-authority-proof-reader',
      'commander.io/tenant-authority-proof-release',
    ]) ||
    labels['app.kubernetes.io/name'] !== input.projection.releaseName ||
    labels['app.kubernetes.io/instance'] !== input.projection.releaseName ||
    labels['commander.io/tenant-authority-proof-reader'] !== 'true' ||
    labels['commander.io/tenant-authority-proof-release'] !== input.projection.releaseName ||
    !exactKeys(Object.keys(annotations), [
      'helm.sh/hook',
      'helm.sh/hook-weight',
      'helm.sh/hook-delete-policy',
    ]) ||
    canonicalBootstrapJson([...hookEvents].sort()) !==
      canonicalBootstrapJson(['post-install', 'post-upgrade']) ||
    annotations['helm.sh/hook-weight'] !== '10' ||
    canonicalBootstrapJson(deletePolicies) !==
      canonicalBootstrapJson(retainedHooks[0]!.deletePolicies) ||
    !exactObjectKeys(spec, [
      'backoffLimit',
      'activeDeadlineSeconds',
      'ttlSecondsAfterFinished',
      'template',
    ]) ||
    spec.backoffLimit !== 0 ||
    spec.activeDeadlineSeconds !== contract.activeDeadlineSeconds ||
    spec.ttlSecondsAfterFinished !== contract.ttlSecondsAfterFinished ||
    !exactObjectKeys(template, ['metadata', 'spec']) ||
    !exactObjectKeys(templateMetadata, ['labels']) ||
    canonicalBootstrapJson(templateLabels) !== canonicalBootstrapJson(expectedProofLabels) ||
    !exactObjectKeys(podSpec, [
      'serviceAccountName',
      'automountServiceAccountToken',
      'restartPolicy',
      'terminationGracePeriodSeconds',
      'securityContext',
      'containers',
      'volumes',
    ]) ||
    podSpec.serviceAccountName !==
      proofReaderServiceAccount(input.projection.namespace, input.projection.releaseName) ||
    podSpec.automountServiceAccountToken !== false ||
    podSpec.restartPolicy !== 'Never' ||
    podSpec.terminationGracePeriodSeconds !== contract.terminationGracePeriodSeconds ||
    !exactObjectKeys(podSecurity, [
      'runAsNonRoot',
      'runAsUser',
      'runAsGroup',
      'fsGroup',
      'seccompProfile',
    ]) ||
    canonicalBootstrapJson(podSecurity) !== canonicalBootstrapJson(contract.podSecurityContext) ||
    containers.size !== 1 ||
    podSpec.initContainers !== undefined ||
    proofContainer === undefined ||
    !exactObjectKeys(proofContainer, [
      'name',
      'image',
      'imagePullPolicy',
      'command',
      'env',
      'securityContext',
      'volumeMounts',
    ]) ||
    proofContainer.image !== contract.image ||
    proofContainer.imagePullPolicy !== contract.imagePullPolicy ||
    canonicalBootstrapJson(proofContainer!.command) !==
      canonicalBootstrapJson(['node', 'packages/kernel/dist/migrate.js', 'tenant-cutover-prove']) ||
    !exactObjectKeys(containerSecurity, [
      'allowPrivilegeEscalation',
      'readOnlyRootFilesystem',
      'capabilities',
    ]) ||
    containerSecurity.allowPrivilegeEscalation !== false ||
    containerSecurity.readOnlyRootFilesystem !== true ||
    canonicalBootstrapJson(capabilities) !== canonicalBootstrapJson({ drop: ['ALL'] }) ||
    env.size !== 5 ||
    ownerEnvironment === undefined ||
    !exactObjectKeys(ownerEnvironment, ['name', 'valueFrom']) ||
    !exactObjectKeys(ownerValueFrom, ['secretKeyRef']) ||
    !exactObjectKeys(ownerSecretReference, ['name', 'key']) ||
    ownerSecretReference.name !==
      proofOwnerSecretName(input.projection.releaseName, input.operation.operationVersion) ||
    ownerSecretReference.key !== input.ownerSecretKey ||
    input.ownerSecretKey !== contract.ownerSecretKey ||
    canonicalBootstrapJson(env.get('COMMANDER_KUBERNETES_PROOF_RUNTIME')) !==
      canonicalBootstrapJson({ name: 'COMMANDER_KUBERNETES_PROOF_RUNTIME', value: '1' }) ||
    canonicalBootstrapJson(env.get('COMMANDER_DATABASE_TLS_CA_FILE')) !==
      canonicalBootstrapJson({
        name: 'COMMANDER_DATABASE_TLS_CA_FILE',
        value: '/run/commander/database-tls/ca.crt',
      }) ||
    env.get('COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256')?.value !==
      contract.expectedServerSpkiSha256 ||
    canonicalBootstrapJson(env.get('COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE')) !==
      canonicalBootstrapJson({
        name: 'COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE',
        value: '/run/commander/api-proof-public/ca.crt',
      }) ||
    mounts.size !== 5 ||
    !mountContractValid ||
    volumes.size !== 5 ||
    !exactKeys(volumes.keys(), Object.keys(expectedMounts)) ||
    !exactObjectKeys(projectionVolume ?? {}, ['name', 'configMap']) ||
    !exactObjectKeys(projectionConfigMap, ['name', 'defaultMode', 'items']) ||
    projectionConfigMap.name !== input.projectionConfigMapName ||
    projectionConfigMap.defaultMode !== 0o444 ||
    canonicalBootstrapJson(projectionConfigMap.items) !==
      canonicalBootstrapJson([{ key: 'projection.json', path: 'projection.json' }]) ||
    !exactObjectKeys(proofToken ?? {}, ['name', 'projected']) ||
    !exactObjectKeys(tokenProjection, ['defaultMode', 'sources']) ||
    tokenProjection.defaultMode !== 0o400 ||
    tokenSources.length !== 3 ||
    !exactObjectKeys(tokenSources[0] ?? {}, ['serviceAccountToken']) ||
    !exactObjectKeys(identityToken, ['audience', 'expirationSeconds', 'path']) ||
    identityToken.audience !== 'commander-tenant-cutover-proof/v1' ||
    identityToken.expirationSeconds !== 600 ||
    identityToken.path !== 'identity-token' ||
    !exactObjectKeys(tokenSources[1] ?? {}, ['serviceAccountToken']) ||
    !exactObjectKeys(apiToken, ['expirationSeconds', 'path']) ||
    apiToken.expirationSeconds !== 600 ||
    apiToken.path !== 'api-token' ||
    !exactObjectKeys(tokenSources[2] ?? {}, ['configMap']) ||
    !exactObjectKeys(rootCa, ['name', 'items']) ||
    rootCa.name !== 'kube-root-ca.crt' ||
    canonicalBootstrapJson(rootCaItems) !==
      canonicalBootstrapJson([{ key: 'ca.crt', path: 'ca.crt' }]) ||
    !exactObjectKeys(databaseCa ?? {}, ['name', 'secret']) ||
    !exactObjectKeys(databaseCaSecret, ['secretName', 'items']) ||
    databaseCaSecret.secretName !== contract.databaseCa.secretName ||
    databaseCaItems.length !== 1 ||
    databaseCaItems[0]?.key !== contract.databaseCa.caKey ||
    databaseCaItems[0].path !== 'ca.crt' ||
    !exactObjectKeys(apiProof ?? {}, ['name', 'secret']) ||
    !exactObjectKeys(apiProofSecret, ['secretName', 'items']) ||
    apiProofSecret.secretName !== contract.apiProof.secretName ||
    exactApiProofItems.length !== 2 ||
    exactApiProofItems[0]?.path !== 'ca.crt' ||
    exactApiProofItems[1]?.path !== 'tls.crt' ||
    exactApiProofItems[0]?.key !== contract.apiProof.caKey ||
    exactApiProofItems[1]?.key !== contract.apiProof.certKey ||
    !exactObjectKeys(volumes.get('tmp') ?? {}, ['name', 'emptyDir']) ||
    canonicalBootstrapJson(volumes.get('tmp')?.emptyDir) !== canonicalBootstrapJson({})
  ) {
    fail('TENANT_CUTOVER_PROOF_JOB_INVALID');
  }
  metadata.namespace = expectedIdentity.namespace;
  return { name, manifest: canonicalBootstrapJson(job) };
}

function assertFreshProofReceipt(receipt: unknown, operation: HelmOperation): void {
  const value = jsonRecord(receipt, 'TENANT_CUTOVER_PROOF_RECEIPT_INVALID');
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'operationVersion',
    'proofAttemptId',
    'proofSequence',
    'proven',
    'rolloutProofSha256',
  ].sort();
  if (
    canonicalBootstrapJson(keys) !== canonicalBootstrapJson(expectedKeys) ||
    value.proven !== true ||
    value.operationVersion !== operation.operationVersion ||
    typeof value.proofSequence !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.proofSequence) ||
    typeof value.proofAttemptId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.proofAttemptId,
    ) ||
    typeof value.rolloutProofSha256 !== 'string' ||
    !SHA256.test(value.rolloutProofSha256)
  ) {
    fail('TENANT_CUTOVER_PROOF_RECEIPT_INVALID');
  }
}

async function runFreshCurrentProofChallenge(input: {
  request: Extract<HelmTenantCutoverRequest, { command: HelmCutoverCommand }>;
  operation: HelmOperation;
  chartPackage: string;
  ports: HelmCutoverPorts;
}): Promise<void> {
  const proofOwnerName = proofOwnerSecretName(
    input.request.release,
    input.operation.operationVersion,
  );
  let projectionConfigMapName: string | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      await input.ports.kubectl.cleanupProofResources(
        input.request.namespace,
        input.request.release,
      );
    } finally {
      try {
        if (projectionConfigMapName !== undefined) {
          await input.ports.kubectl.deleteAndVerifyConfigMap(
            input.request.namespace,
            projectionConfigMapName,
          );
        }
      } finally {
        await input.ports.kubectl.deleteAndVerifySecret(input.request.namespace, proofOwnerName);
      }
    }
  };
  let revisionBefore: string | undefined;
  try {
    await cleanup();
    const restored = await input.ports.owner.restore({
      schema: 'tenant-cutover-restore/v1',
      namespace: input.request.namespace,
      release: input.request.release,
    });
    assertOperation(
      restored,
      input.request.command,
      input.operation.platformBinding.chartContentSha256,
      input.request,
    );
    if (!restored.proven) fail('TENANT_CUTOVER_RESTORE_PROOF_REQUIRED');
    assertSameCurrentOperation(input.operation, restored);
    const evidence = restoreEvidence(restored);
    projectionConfigMapName = releaseProjectionConfigMapName(
      input.request.release,
      input.operation.operationVersion,
      evidence.revision,
    );
    if (
      input.ports.chartDigest(input.chartPackage) !== evidence.releaseProjection.chartContentSha256
    ) {
      fail('TENANT_CUTOVER_RETAINED_CHART_DRIFT');
    }
    revisionBefore = await input.ports.helm.currentRevision(
      input.request.namespace,
      input.request.release,
    );
    if (revisionBefore !== evidence.revision) fail('TENANT_CUTOVER_PROOF_REVISION_MISMATCH');
    const projected = await input.ports.helm.projectRevision(
      input.request.namespace,
      input.request.release,
      evidence.revision,
      input.chartPackage,
    );
    if (
      canonicalBootstrapSha256(projected) !== evidence.releaseProjectionSha256 ||
      canonicalBootstrapJson(projected) !== canonicalBootstrapJson(evidence.releaseProjection)
    ) {
      fail('TENANT_CUTOVER_RESTORE_PROJECTION_DRIFT');
    }
    const ownerReference = restoredDatabaseOwnerSecretReference(restored);
    const proofJob = proofJobForRevision({
      manifest: await input.ports.helm.proofJobManifest(
        input.request.namespace,
        input.request.release,
        evidence.revision,
      ),
      operation: restored,
      projection: evidence.releaseProjection,
      projectionConfigMapName,
      ownerSecretKey: ownerReference.sourceKey,
    });
    await input.ports.kubectl.prepareProofOwnerSecret({
      namespace: input.request.namespace,
      sourceName: ownerReference.sourceName,
      sourceKey: ownerReference.sourceKey,
      targetName: proofOwnerName,
    });
    await input.ports.kubectl.prepareReleaseProjectionConfigMap({
      namespace: input.request.namespace,
      release: input.request.release,
      revision: evidence.revision,
      name: projectionConfigMapName,
      projection: evidence.releaseProjection,
    });
    const receipt = await input.ports.kubectl.runProofJob({
      namespace: input.request.namespace,
      name: proofJob.name,
      revision: evidence.revision,
      manifest: proofJob.manifest,
    });
    assertFreshProofReceipt(receipt, restored);
  } finally {
    await cleanup();
    if (revisionBefore !== undefined) {
      const revisionAfter = await input.ports.helm.currentRevision(
        input.request.namespace,
        input.request.release,
      );
      if (revisionAfter !== revisionBefore) fail('TENANT_CUTOVER_PROOF_CREATED_HELM_REVISION');
    }
  }
}

function prepared(
  request: Extract<HelmTenantCutoverRequest, { command: HelmCutoverCommand }>,
  values: string,
  digest: string,
  nonce: string,
  businessConfiguration: Record<string, unknown>,
): Record<string, unknown> {
  const platformBinding: HelmPlatformBinding = {
    kind: 'helm',
    namespace: request.namespace,
    releaseName: request.release,
    chartContentSha256: digest,
    phase: phase(request.command),
    apiImageDigest: apiImageDigest(values),
  };
  const boundBusinessConfiguration = { ...businessConfiguration, platformBinding };
  const configuration = { ...boundBusinessConfiguration, operationAuditNonce: nonce };
  return {
    platformBinding,
    businessConfiguration: boundBusinessConfiguration,
    configuration,
    configurationSha256: canonicalBootstrapSha256(configuration),
  };
}

export async function runHelmTenantCutover(
  request: HelmTenantCutoverRequest,
  ports: HelmCutoverPorts,
): Promise<HelmCutoverResult> {
  if (request.command === 'restore-recorded-current') {
    const operation = await ports.owner.restore({
      schema: 'tenant-cutover-restore/v1',
      namespace: request.namespace,
      release: request.release,
    });
    const evidence = restoreEvidence(operation);
    const chartPackage = await ports.fs.retainedChartPackage(
      request.stateDirectory,
      request.namespace,
      request.release,
      operation.platformBinding.chartContentSha256,
    );
    const chartDigest = ports.chartDigest(chartPackage);
    if (!SHA256.test(chartDigest)) fail('TENANT_CUTOVER_CHART_DIGEST_INVALID');
    assertOperation(
      operation,
      operation.operationKind === 'rollback_to_recorded_expand'
        ? 'rollback-recorded-expand'
        : operation.phase === 'expand'
          ? 'expand'
          : 'enforce',
      chartDigest,
      request,
    );
    if (!operation.proven) fail('TENANT_CUTOVER_RESTORE_PROOF_REQUIRED');
    const failedRevision = await ports.helm.currentRevision(request.namespace, request.release);
    if (
      !/^[1-9][0-9]*$/.test(failedRevision) ||
      BigInt(failedRevision) <= BigInt(evidence.revision)
    ) {
      fail('TENANT_CUTOVER_RESTORE_TARGET_REVISION_REQUIRED');
    }
    const projectedCurrent = await ports.helm.projectRevision(
      request.namespace,
      request.release,
      evidence.revision,
      chartPackage,
    );
    if (
      canonicalBootstrapSha256(projectedCurrent) !== evidence.releaseProjectionSha256 ||
      canonicalBootstrapJson(projectedCurrent) !==
        canonicalBootstrapJson(evidence.releaseProjection)
    ) {
      fail('TENANT_CUTOVER_RESTORE_PROJECTION_DRIFT');
    }
    const failedTarget = await ports.helm.projectRevision(
      request.namespace,
      request.release,
      failedRevision,
      chartPackage,
    );
    if (
      failedTarget.namespace !== request.namespace ||
      failedTarget.releaseName !== request.release ||
      failedTarget.revision !== failedRevision
    ) {
      fail('TENANT_CUTOVER_RESTORE_TARGET_PROJECTION_INVALID');
    }
    await cleanupFailedTargetOnlyObjects(
      { current: evidence.releaseProjection, failedTarget },
      ports.kubectl,
    );
    const helmVersion = await ports.helm.version();
    await runHelmRolloutWithProofCredential({
      operation,
      namespace: request.namespace,
      release: request.release,
      reference: restoredDatabaseOwnerSecretReference(operation),
      rollout: async () => {
        const targetRevision = await ports.helm.nextRevision(request.namespace, request.release);
        if (targetRevision !== String(BigInt(failedRevision) + 1n)) {
          fail('TENANT_CUTOVER_RESTORE_TARGET_REVISION_REQUIRED');
        }
        const projectionConfigMapName = releaseProjectionConfigMapName(
          request.release,
          operation.operationVersion,
          targetRevision,
        );
        await ports.helm.restoreRevision({
          namespace: request.namespace,
          release: request.release,
          revision: evidence.revision,
          chart: chartPackage,
          args: buildHelmRolloutArgs(
            operation,
            {
              namespace: request.namespace,
              release: request.release,
              values: '-',
              chart: chartPackage,
              releaseProjectionConfigMap: projectionConfigMapName,
            },
            helmVersion,
            false,
          ),
          retainedProjection: evidence.releaseProjection,
          targetRevision,
          projectionConfigMapName,
          rendererValues: rendererValues(
            dump(evidence.releaseProjection.rendererInput.values, {
              noRefs: true,
              sortKeys: true,
            }),
            operation,
            [],
            projectionConfigMapName,
          ),
        });
      },
      ports,
    });
    await verifyRestoredReleaseProjection(
      { current: evidence.releaseProjection, failedTarget },
      ports.kubectl,
    );
    return { action: 'restored', operation };
  }

  const chartDigest = ports.chartDigest(request.chart);
  if (!SHA256.test(chartDigest)) fail('TENANT_CUTOVER_CHART_DIGEST_INVALID');
  const chartPackage = await ports.fs.retainChartPackage(
    request.chart,
    request.stateDirectory,
    request.namespace,
    request.release,
    chartDigest,
  );
  if (ports.chartDigest(chartPackage) !== chartDigest) {
    fail('TENANT_CUTOVER_RETAINED_CHART_DRIFT');
  }
  const values = await ports.readValues(request.values);
  const imageDigest = apiImageDigest(values);
  const databasePlan = databaseRolloutPlan(values, request.release, request.command);
  const ownerContext = createHelmOwnerExecutionContext({
    values,
    namespace: request.namespace,
    release: request.release,
    command: request.command,
    databaseSecretName: databasePlan.reference.sourceName,
  });
  let selectedHelmVersion: string | undefined;
  const helmVersion = async (): Promise<string> => {
    if (selectedHelmVersion === undefined) {
      selectedHelmVersion = await ports.helm.version();
      assertHelmVersion(selectedHelmVersion);
    }
    return selectedHelmVersion;
  };
  if (databasePlan.freshBundled) {
    await ports.kubectl.prepareFreshBundledDatabaseSecret({
      namespace: request.namespace,
      ...databasePlan.freshBundled,
    });
  }
  const databasePeerBindingInput = createTask1DatabasePeerBindingInput({
    roleUrls: {
      'adapter-ops': (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.adapterOps,
        )
      ).toString('utf8'),
      app: (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.app,
        )
      ).toString('utf8'),
      owner: (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.owner,
        )
      ).toString('utf8'),
      scheduler: (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.scheduler,
        )
      ).toString('utf8'),
      'tenant-authority': (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.tenantAuthority,
        )
      ).toString('utf8'),
      worker: (
        await ports.kubectl.readSecretValue(
          request.namespace,
          ownerContext.databaseSecretName,
          ownerContext.databaseSecretKeys.worker,
        )
      ).toString('utf8'),
    },
    expectedServerSpkiSha256: ownerContext.databaseTls.expectedServerSpkiSha256,
    caMountIdentity: `secret/${ownerContext.databaseTls.secretName}:${ownerContext.databaseTls.caKey}`,
    caPath: '/run/commander/database-tls/ca.crt',
    caPublicBytes: await ports.kubectl.readSecretValue(
      request.namespace,
      ownerContext.databaseTls.secretName,
      ownerContext.databaseTls.caKey,
    ),
  });
  const businessConfiguration = {
    valuesSha256: valuesSha256(values),
    secretFileMappings: {
      databaseOwner: {
        secretName: databasePlan.reference.sourceName,
        secretKey: databasePlan.reference.sourceKey,
      },
    },
    databasePeerBindingInput,
  };
  if (
    databasePlan.freshBundled &&
    !(await ports.helm.releaseExists(request.namespace, request.release))
  ) {
    const version = await helmVersion();
    await ports.helm.run(
      buildHelmTransportBootstrapArgs(
        {
          namespace: request.namespace,
          release: request.release,
          values: request.values,
          chart: chartPackage,
          chartContentSha256: chartDigest,
          databaseSecretName: databasePlan.freshBundled.name,
        },
        version,
      ),
    );
  }
  const plan = await ports.owner.plan(
    {
      schema: 'tenant-cutover-plan/v1',
      command: request.command,
      platformIntent: {
        kind: 'helm',
        namespace: request.namespace,
        releaseName: request.release,
        chartContentSha256: chartDigest,
        phase: phase(request.command),
        apiImageDigest: imageDigest,
      },
      businessConfiguration,
    },
    ownerContext,
  );
  if (plan.action === 'return_current') {
    assertOperation(plan.operation, request.command, chartDigest, request);
    if (!plan.operation.proven) fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
    await runFreshCurrentProofChallenge({
      request,
      operation: plan.operation,
      chartPackage,
      ports,
    });
    return { action: 'returned_current', operation: plan.operation };
  }
  const retry = plan.action === 'retry_rollout';
  const version = await helmVersion();
  const operation = retry
    ? plan.operation
    : await ports.owner.append(
        {
          schema: 'tenant-cutover-request/v1',
          command: request.command,
          prepared: prepared(
            request,
            values,
            chartDigest,
            ports.createNonce(),
            businessConfiguration,
          ),
        },
        ownerContext,
      );
  assertOperation(operation, request.command, chartDigest, request);
  if (retry) {
    try {
      await loadArtifact(request, operation, request.command, ports.fs);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'TENANT_CUTOVER_OPERATION_ARTIFACT_MISSING'
      ) {
        throw error;
      }
      await persistArtifact(request, operation, request.command, ports.fs);
      await loadArtifact(request, operation, request.command, ports.fs);
    }
  } else {
    await persistArtifact(request, operation, request.command, ports.fs);
  }
  await runHelmRolloutWithProofCredential({
    operation,
    namespace: request.namespace,
    release: request.release,
    reference: databasePlan.reference,
    rollout: async () => {
      const targetRevision = await ports.helm.nextRevision(request.namespace, request.release);
      const setValues = [...databasePlan.setValues, 'tenantAuthority.transportBootstrap=false'];
      const projectionConfigMapName = releaseProjectionConfigMapName(
        request.release,
        operation.operationVersion,
        targetRevision,
      );
      const args = buildHelmRolloutArgs(
        operation,
        {
          ...request,
          chart: chartPackage,
          setValues,
          releaseProjectionConfigMap: projectionConfigMapName,
        },
        version,
      );
      await ports.helm.runProjectedRevision({
        namespace: request.namespace,
        release: request.release,
        revision: targetRevision,
        projectionConfigMapName,
        args,
        rendererValues: rendererValues(values, operation, setValues, projectionConfigMapName),
      });
    },
    ports,
  });
  return { action: retry ? 'retried' : 'deployed', operation };
}

type HelmOwnerMode = 'tenant-cutover-plan' | 'tenant-cutover-append' | 'tenant-cutover-restore';

export function buildHelmOwnerJobBundle(input: {
  mode: HelmOwnerMode;
  payload: Record<string, unknown>;
  context: HelmOwnerExecutionContext;
  executionId: string;
}): {
  configMapName: string;
  jobName: string;
  selector: string;
  configMap: Record<string, unknown>;
  job: Record<string, unknown>;
} {
  if (!/^[0-9a-f]{32}$/.test(input.executionId)) fail('TENANT_CUTOVER_OWNER_JOB_INVALID');
  const modeName = input.mode.slice('tenant-cutover-'.length);
  const suffix = `-owner-${modeName}-${input.executionId.slice(0, 12)}`;
  const jobName = `${input.context.release
    .slice(0, 63 - suffix.length)
    .replace(/-$/, '')}${suffix}`;
  const configSuffix = `-request-${input.executionId.slice(0, 12)}`;
  const configMapName = `${input.context.release
    .slice(0, 63 - configSuffix.length)
    .replace(/-$/, '')}${configSuffix}`;
  const executionLabel = input.executionId;
  const labels = {
    'app.kubernetes.io/name': input.context.release,
    'app.kubernetes.io/instance': input.context.release,
    'commander.io/migration-client-v2': 'true',
    'commander.io/migration-release': input.context.release,
    'commander.io/tenant-cutover-owner-execution': executionLabel,
  };
  const secretEnv = (key: string) => ({
    valueFrom: { secretKeyRef: { name: input.context.databaseSecretName, key } },
  });
  const ownerSecret = secretEnv(input.context.databaseSecretKeys.owner);
  const env: Array<Record<string, unknown>> = [
    { name: 'NODE_ENV', value: 'production' },
    {
      name: 'COMMANDER_TENANT_CUTOVER_INPUT_FILE',
      value: '/run/commander/tenant-cutover/request.json',
    },
    { name: 'DATABASE_URL', ...ownerSecret },
    { name: 'COMMANDER_KERNEL_DATABASE_URL', ...ownerSecret },
    { name: 'COMMANDER_OWNER_DATABASE_URL', ...ownerSecret },
    {
      name: 'COMMANDER_APP_DATABASE_URL',
      ...secretEnv(input.context.databaseSecretKeys.app),
    },
    {
      name: 'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
      ...secretEnv(input.context.databaseSecretKeys.tenantAuthority),
    },
    {
      name: 'COMMANDER_SCHEDULER_DATABASE_URL',
      ...secretEnv(input.context.databaseSecretKeys.scheduler),
    },
    {
      name: 'COMMANDER_WORKER_DATABASE_URL',
      ...secretEnv(input.context.databaseSecretKeys.worker),
    },
    {
      name: 'COMMANDER_ADAPTER_OPS_DATABASE_URL',
      ...secretEnv(input.context.databaseSecretKeys.adapterOps),
    },
    { name: 'COMMANDER_DATABASE_TLS_CA_FILE', value: '/run/commander/database-tls/ca.crt' },
    {
      name: 'COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY',
      value: `secret/${input.context.databaseTls.secretName}:${input.context.databaseTls.caKey}`,
    },
    {
      name: 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
      value: input.context.databaseTls.expectedServerSpkiSha256,
    },
    {
      name: 'COMMANDER_TENANT_AUTHORITY_PROOF_PUBLIC_CERT_FILE',
      value: '/run/commander/api-proof-public/tls.crt',
    },
  ];
  if (input.context.bootstrap.kind === 'bundled') {
    env.push(
      { name: 'COMMANDER_BUNDLED_POSTGRES_BOOTSTRAP', value: '1' },
      { name: 'COMMANDER_BUNDLED_POSTGRES_USER', value: input.context.bootstrap.user },
      {
        name: 'COMMANDER_BUNDLED_POSTGRES_PASSWORD',
        valueFrom: {
          secretKeyRef: {
            name: input.context.databaseSecretName,
            key: input.context.bootstrap.passwordSecretKey,
          },
        },
      },
    );
  } else if (input.context.bootstrap.kind === 'external') {
    env.push({
      name: 'COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL',
      valueFrom: {
        secretKeyRef: {
          name: input.context.bootstrap.secretName,
          key: input.context.bootstrap.secretKey,
        },
      },
    });
  }
  const selector = `commander.io/tenant-cutover-owner-execution=${executionLabel}`;
  return {
    configMapName,
    jobName,
    selector,
    configMap: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        namespace: input.context.namespace,
        labels: { 'commander.io/tenant-cutover-owner-execution': executionLabel },
      },
      immutable: true,
      data: { 'request.json': `${canonicalBootstrapJson(input.payload)}\n` },
    },
    job: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: jobName, namespace: input.context.namespace, labels },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 300,
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: 'Never',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'owner-command',
                image: input.context.image,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', 'packages/kernel/dist/migrate.js', input.mode],
                env,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  {
                    name: 'request',
                    mountPath: '/run/commander/tenant-cutover',
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
                ],
              },
            ],
            volumes: [
              { name: 'request', configMap: { name: configMapName, defaultMode: 0o444 } },
              {
                name: 'database-public-ca',
                secret: {
                  secretName: input.context.databaseTls.secretName,
                  items: [{ key: input.context.databaseTls.caKey, path: 'ca.crt' }],
                },
              },
              {
                name: 'api-proof-public',
                secret: {
                  secretName: input.context.proofCertificate.secretName,
                  items: [{ key: input.context.proofCertificate.certKey, path: 'tls.crt' }],
                },
              },
            ],
          },
        },
      },
    },
  };
}

export const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
export const COMMAND_TIMEOUT_ABSOLUTE_CAP_MS = 11 * 60_000;
const COMMAND_TIMEOUT_MARGIN_MS = 15_000;
const COMMAND_TERMINATION_GRACE_MS = 250;
const COMMAND_TERMINATION_CONFIRMATION_TIMEOUT_MS = 2_000;

export type CommandExecutionPolicy =
  'standard' | 'helm_read' | 'helm_rollout' | 'owner_job_wait' | 'proof_job_wait';

export function commandExecutionTimeoutMs(policy: CommandExecutionPolicy | string): number {
  const timeout =
    policy === 'standard' || policy === 'helm_read'
      ? 60_000
      : policy === 'owner_job_wait'
        ? 5 * 60_000 + COMMAND_TIMEOUT_MARGIN_MS
        : policy === 'helm_rollout' || policy === 'proof_job_wait'
          ? 10 * 60_000 + COMMAND_TIMEOUT_MARGIN_MS
          : fail('TENANT_CUTOVER_COMMAND_TIMEOUT_POLICY_INVALID');
  return Math.min(timeout, COMMAND_TIMEOUT_ABSOLUTE_CAP_MS);
}

function kubectlSubcommand(args: readonly string[]): { name: string; index: number } {
  let index = 0;
  while (index < args.length) {
    const value = args[index]!;
    if (value === '--kubeconfig' || value === '--token') {
      index += 2;
      continue;
    }
    if (value.startsWith('--kubeconfig=') || value.startsWith('--token=')) {
      index += 1;
      continue;
    }
    return { name: value, index };
  }
  return { name: '', index };
}

export function commandFailureCode(
  program: string,
  args: readonly string[],
  stdin?: string,
  stderr = '',
): string {
  const kubectlCommand = program === 'kubectl' ? kubectlSubcommand(args) : undefined;
  const command = kubectlCommand?.name;
  let createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_FAILED';
  if (command === 'create' && stdin) {
    try {
      const object = load(stdin) as {
        kind?: unknown;
        metadata?: { labels?: Record<string, unknown> };
      };
      const labels = object.metadata?.labels;
      if (object.kind === 'ConfigMap') {
        createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_CONFIGMAP_FAILED';
      } else if (
        object.kind === 'Job' &&
        labels?.['commander.io/tenant-cutover-owner-execution'] !== undefined
      ) {
        createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_OWNER_JOB_FAILED';
      } else if (
        object.kind === 'Job' &&
        labels?.['commander.io/tenant-authority-proof-reader'] === 'true'
      ) {
        createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_PROOF_JOB_FAILED';
      }
    } catch {
      // Non-canonical create input retains the generic fixed code.
    }
  }
  if (command === 'create') {
    if (/\bAlreadyExists\b/.test(stderr)) {
      createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_ALREADY_EXISTS';
    } else if (/\bforbidden\b/i.test(stderr)) {
      createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_FORBIDDEN';
    } else if (/\binvalid\b/i.test(stderr)) {
      createCode =
        createCode === 'TENANT_CUTOVER_KUBECTL_CREATE_FAILED'
          ? 'TENANT_CUTOVER_KUBECTL_CREATE_INVALID'
          : createCode.replace(/_FAILED$/, '_INVALID');
    } else if (/\bnot found\b/i.test(stderr)) {
      createCode = 'TENANT_CUTOVER_KUBECTL_CREATE_NOT_FOUND';
    }
  }
  const kubectlCode =
    command === 'auth' && args[(kubectlCommand?.index ?? 0) + 1] === 'can-i'
      ? 'TENANT_CUTOVER_KUBECTL_AUTH_CAN_I_FAILED'
      : command === 'apply'
        ? 'TENANT_CUTOVER_KUBECTL_APPLY_FAILED'
        : command === 'create'
          ? createCode
          : command === 'delete'
            ? 'TENANT_CUTOVER_KUBECTL_DELETE_FAILED'
            : command === 'get'
              ? 'TENANT_CUTOVER_KUBECTL_GET_FAILED'
              : command === 'logs'
                ? 'TENANT_CUTOVER_KUBECTL_LOGS_COMMAND_FAILED'
                : command === 'version'
                  ? 'TENANT_CUTOVER_KUBECTL_VERSION_FAILED'
                  : command === 'wait'
                    ? 'TENANT_CUTOVER_KUBECTL_WAIT_FAILED'
                    : 'TENANT_CUTOVER_KUBECTL_COMMAND_FAILED';
  const code =
    program === 'helm'
      ? 'TENANT_CUTOVER_HELM_COMMAND_FAILED'
      : program === 'kubectl'
        ? kubectlCode
        : 'TENANT_CUTOVER_COMMAND_FAILED';
  if (!isAllowedHelmDiagnosticCode(code)) fail('TENANT_CUTOVER_COMMAND_FAILED');
  return code;
}

export async function defaultCommand(
  program: string,
  args: readonly string[],
  stdin?: string,
  executionPolicy: CommandExecutionPolicy = 'standard',
): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const kubectlCommand = program === 'kubectl' ? kubectlSubcommand(args).name : undefined;
    const canICheck = program === 'kubectl' && args.includes('auth') && args.includes('can-i');
    const captureStderr =
      (program === 'kubectl' && (kubectlCommand === 'logs' || kubectlCommand === 'create')) ||
      canICheck;
    const processGroup = process.platform !== 'win32';
    const child = launchProcess(program, [...args], {
      detached: processGroup,
      shell: false,
      stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'],
    });
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    const maximumBytes =
      executionPolicy === 'helm_read' ? RESTORE_STREAM_LIMIT : COMMAND_OUTPUT_LIMIT;
    const outputLimitCode =
      executionPolicy === 'helm_read'
        ? 'TENANT_CUTOVER_RESTORE_STREAM_LIMIT'
        : 'TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT';
    let bytes = 0;
    let settled = false;
    let childClosed = false;
    let terminatingError: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationPoll: NodeJS.Timeout | undefined;
    let terminationConfirmationDeadline = 0;
    const timeout = setTimeout(
      () => terminate('TENANT_CUTOVER_COMMAND_TIMEOUT'),
      commandExecutionTimeoutMs(executionPolicy),
    );
    timeout.unref();

    const signal = (value: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (processGroup) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') {
          terminatingError = new Error('TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED');
        }
      }
    };
    const processGroupAlive = (): boolean => {
      if (!processGroup || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process group may still exist but is not probeable;
        // only ESRCH is a portable proof that it has exited.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (terminationPoll) clearTimeout(terminationPoll);
      reject(error);
    };
    const finishTerminationWhenGone = (): void => {
      if (!terminatingError || !childClosed || settled) return;
      if (processGroupAlive()) {
        if (Date.now() >= terminationConfirmationDeadline) {
          finishReject(new Error('TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED'));
          return;
        }
        terminationPoll = setTimeout(finishTerminationWhenGone, 10);
        return;
      }
      finishReject(terminatingError);
    };
    function terminate(code: string): void {
      if (settled || terminatingError) return;
      terminatingError = new Error(code);
      terminationConfirmationDeadline = Date.now() + COMMAND_TERMINATION_CONFIRMATION_TIMEOUT_MS;
      clearTimeout(timeout);
      signal('SIGTERM');
      forceKill = setTimeout(() => {
        signal('SIGKILL');
        finishTerminationWhenGone();
      }, COMMAND_TERMINATION_GRACE_MS);
    }
    const capture = (destination: Buffer[]) => (chunk: Buffer) => {
      if (terminatingError) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maximumBytes) {
        terminate(outputLimitCode);
        return;
      }
      destination.push(value);
    };
    child.stdout.on('data', capture(output));
    if (captureStderr) child.stderr?.on('data', capture(errorOutput));
    child.once('error', () => {
      childClosed = true;
      if (terminatingError) {
        finishTerminationWhenGone();
        return;
      }
      finishReject(new Error(commandFailureCode(program, args, stdin)));
    });
    child.once('close', (code) => {
      if (settled) return;
      childClosed = true;
      if (terminatingError) return finishTerminationWhenGone();
      const stdoutText = Buffer.concat(output).toString('utf8');
      const stderrText = Buffer.concat(errorOutput).toString('utf8');
      if (
        canICheck &&
        ((code === 0 && stdoutText.trim() === 'yes') || (code === 1 && stdoutText.trim() === 'no'))
      ) {
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolveCommand(stdoutText);
        return;
      }
      if (canICheck)
        return finishReject(new Error(commandFailureCode(program, args, stdin, stderrText)));
      if (code !== 0)
        return finishReject(new Error(commandFailureCode(program, args, stdin, stderrText)));
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolveCommand(
        canICheck || kubectlCommand === 'create'
          ? stdoutText
          : Buffer.concat([...output, ...errorOutput]).toString('utf8'),
      );
    });
    child.stdin.end(stdin ?? '');
  });
}

type JsonRecord = Record<string, unknown>;
export type RetainedSecretPayloads = Map<string, Map<string, Buffer>>;

const RESTORE_STREAM_LIMIT = 64 * 1024 * 1024;
const KUBERNETES_VERSION = 'v1.33.2';

function jsonRecord(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function releaseObjectKey(identity: HelmReleaseObjectIdentity): string {
  return [identity.apiVersion, identity.kind, identity.namespace, identity.name].join('\0');
}

function manifestDocuments(manifest: string, code: string): JsonRecord[] {
  const documents: JsonRecord[] = [];
  try {
    loadAll(manifest, (document) => {
      if (document !== undefined && document !== null) documents.push(jsonRecord(document, code));
    });
  } catch {
    return fail(code);
  }
  return documents;
}

function manifestIdentity(
  document: JsonRecord,
  defaultNamespace: string,
): HelmReleaseObjectIdentity {
  const metadata = jsonRecord(document.metadata, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  if (
    typeof document.apiVersion !== 'string' ||
    typeof document.kind !== 'string' ||
    typeof metadata.name !== 'string' ||
    (metadata.namespace !== undefined && typeof metadata.namespace !== 'string')
  ) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  }
  return {
    apiVersion: document.apiVersion,
    kind: document.kind,
    namespace: (metadata.namespace as string | undefined) ?? defaultNamespace,
    name: metadata.name,
  };
}

function decodeSecretData(document: JsonRecord): Map<string, Buffer> {
  const data =
    document.data === undefined
      ? {}
      : jsonRecord(document.data, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  const stringData =
    document.stringData === undefined
      ? {}
      : jsonRecord(document.stringData, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  const result = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || !SECRET_KEY.test(key)) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    result.set(key, decoded);
  }
  for (const [key, value] of Object.entries(stringData)) {
    if (typeof value !== 'string' || !SECRET_KEY.test(key) || result.has(key)) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    result.set(key, Buffer.from(value, 'utf8'));
  }
  return result;
}

function exactKeys(actual: Iterable<string>, expected: Iterable<string>): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return isDeepStrictEqual(left, right);
}

export function extractRetainedSecretPayloads(
  manifest: string,
  retainedProjection: HelmReleaseProjection,
): RetainedSecretPayloads {
  const expected = new Map(
    retainedProjection.objects
      .filter((object) => object.identity.kind === 'Secret')
      .map((object) => [releaseObjectKey(object.identity), object] as const),
  );
  const payloads: RetainedSecretPayloads = new Map();
  for (const document of manifestDocuments(
    manifest,
    'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID',
  )) {
    if (document.kind !== 'Secret') continue;
    const identity = manifestIdentity(document, retainedProjection.namespace);
    const key = releaseObjectKey(identity);
    const projection = expected.get(key);
    if (!projection) continue;
    if (payloads.has(key)) fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    if (
      Object.hasOwn(
        jsonRecord(document.metadata, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID'),
        'deletionTimestamp',
      )
    ) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    const dataKeys = projection.comparator.dataKeys;
    const payload = decodeSecretData(document);
    if (!Array.isArray(dataKeys) || !dataKeys.every((value) => typeof value === 'string')) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    if (!exactKeys(payload.keys(), dataKeys)) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    payloads.set(key, payload);
  }
  if (!exactKeys(payloads.keys(), expected.keys())) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  }
  return payloads;
}

export function postRenderRetainedSecrets(
  manifest: string,
  namespace: string,
  payloads: RetainedSecretPayloads,
): string {
  const documents = manifestDocuments(manifest, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  const replaced = new Set<string>();
  for (const document of documents) {
    const identity = manifestIdentity(document, namespace);
    const key = releaseObjectKey(identity);
    const retained = payloads.get(key);
    if (!retained) {
      if (document.kind === 'Secret') fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
      continue;
    }
    if (document.kind !== 'Secret' || replaced.has(key)) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    if (
      Object.hasOwn(
        jsonRecord(document.metadata, 'TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID'),
        'deletionTimestamp',
      )
    ) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    const rendered = decodeSecretData(document);
    if (!exactKeys(rendered.keys(), retained.keys())) {
      fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    }
    document.data = Object.fromEntries(
      [...retained].map(([dataKey, value]) => [dataKey, value.toString('base64')]),
    );
    delete document.stringData;
    replaced.add(key);
  }
  if (!exactKeys(replaced, payloads.keys())) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  }
  return documents.map((document) => dump(document, { noRefs: true, lineWidth: -1 })).join('---\n');
}

function selectorMatches(selector: unknown, value: unknown): boolean {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    return isDeepStrictEqual(selector, value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(selector as JsonRecord).every(([key, child]) =>
    selectorMatches(child, (value as JsonRecord)[key]),
  );
}

function selectedArrayValue(
  selector: (value: unknown, index: number) => boolean,
  value: unknown,
): unknown {
  if (!Array.isArray(value)) fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  const matches = value.filter(selector);
  if (matches.length !== 1) fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  return matches[0];
}

function compareManagedFieldSet(fields: unknown, desired: unknown, live: unknown): void {
  const fieldSet = jsonRecord(fields, 'TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  if (Object.keys(fieldSet).length === 0) {
    if (!isDeepStrictEqual(desired, live)) fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
    return;
  }
  for (const [selector, children] of Object.entries(fieldSet)) {
    if (selector === '.') {
      if (!isDeepStrictEqual(desired, live)) fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
      continue;
    }
    if (selector.startsWith('f:')) {
      if (
        !desired ||
        typeof desired !== 'object' ||
        Array.isArray(desired) ||
        !live ||
        typeof live !== 'object' ||
        Array.isArray(live)
      ) {
        fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
      }
      const field = selector.slice(2);
      if (!(field in desired) || !(field in live)) {
        fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
      }
      compareManagedFieldSet(children, (desired as JsonRecord)[field], (live as JsonRecord)[field]);
      continue;
    }
    if (selector.startsWith('k:') || selector.startsWith('v:')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(selector.slice(2));
      } catch {
        return fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
      }
      const match =
        selector[0] === 'k'
          ? (value: unknown) => selectorMatches(parsed, value)
          : (value: unknown) => isDeepStrictEqual(parsed, value);
      compareManagedFieldSet(
        children,
        selectedArrayValue(match, desired),
        selectedArrayValue(match, live),
      );
      continue;
    }
    if (selector.startsWith('i:') && /^(?:0|[1-9][0-9]*)$/.test(selector.slice(2))) {
      const index = Number(selector.slice(2));
      if (
        !Array.isArray(desired) ||
        !Array.isArray(live) ||
        index >= desired.length ||
        index >= live.length
      ) {
        fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
      }
      compareManagedFieldSet(children, desired[index], live[index]);
      continue;
    }
    fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  }
}

export function assertManagedFieldsMatch(fieldsV1: unknown, desired: unknown, live: unknown): void {
  compareManagedFieldSet(fieldsV1, desired, live);
}

export interface HelmRevisionRestoreRuntime {
  readHelmBounded(args: readonly string[], maximumBytes: number): Promise<string>;
  streamValuesToHelm(input: {
    values: string;
    helmArgs: readonly string[];
    postRender(manifest: string): string;
    afterPostRender?(manifest: string, rendererValues: string): Promise<void>;
  }): Promise<void>;
}

export async function streamHelmRevisionRestore(
  request: Parameters<HelmProcessPort['restoreRevision']>[0],
  runtime: HelmRevisionRestoreRuntime,
  retainSecretPayloads: (payloads: RetainedSecretPayloads) => void = () => undefined,
): Promise<void> {
  const fixedPrefix = [
    'upgrade',
    request.release,
    request.chart,
    '--namespace',
    request.namespace,
    '--values',
    '-',
  ];
  if (
    !/^[1-9][0-9]*$/.test(request.revision) ||
    request.retainedProjection.format !== 'helm-release-projection/v1' ||
    request.retainedProjection.namespace !== request.namespace ||
    request.retainedProjection.releaseName !== request.release ||
    request.retainedProjection.revision !== request.revision ||
    request.args.length < fixedPrefix.length ||
    !fixedPrefix.every((value, index) => request.args[index] === value) ||
    request.args.some((value) => value === '--install' || value.startsWith('--post-renderer'))
  ) {
    fail('TENANT_CUTOVER_RESTORE_REQUEST_INVALID');
  }
  const manifest = await runtime.readHelmBounded(
    [
      'get',
      'manifest',
      request.release,
      '--namespace',
      request.namespace,
      '--revision',
      request.revision,
    ],
    RESTORE_STREAM_LIMIT,
  );
  const payloads = extractRetainedSecretPayloads(manifest, request.retainedProjection);
  const values = dump(
    materializeRetainedRendererValues({
      values: request.retainedProjection.rendererInput.values,
      secretReferences: request.retainedProjection.rendererInput.secretReferences,
      manifest,
      namespace: request.namespace,
    }),
    { noRefs: true, sortKeys: true },
  );
  await runtime.streamValuesToHelm({
    values,
    helmArgs: request.args,
    postRender: (rendered) => postRenderRetainedSecrets(rendered, request.namespace, payloads),
  });
  retainSecretPayloads(payloads);
}

async function readBoundedStream(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  code: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > maximumBytes) fail(code);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readHelmBounded(args: readonly string[], maximumBytes: number): Promise<string> {
  if (maximumBytes !== RESTORE_STREAM_LIMIT) fail('TENANT_CUTOVER_RESTORE_STREAM_LIMIT');
  try {
    return await defaultCommand('helm', args, undefined, 'helm_read');
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'TENANT_CUTOVER_RESTORE_STREAM_LIMIT' ||
      code === 'TENANT_CUTOVER_COMMAND_TIMEOUT' ||
      code === 'TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED'
    ) {
      throw error;
    }
    return fail('TENANT_CUTOVER_HELM_RESTORE_COMMAND_FAILED');
  }
}

async function postRendererRequest(
  socketPath: string,
  token: string,
  manifest: string,
): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: '/',
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(manifest),
          'content-type': 'application/yaml',
          'x-commander-restore-token': token,
        },
      },
      async (response) => {
        try {
          const output = await readBoundedStream(
            response,
            RESTORE_STREAM_LIMIT,
            'TENANT_CUTOVER_RESTORE_STREAM_LIMIT',
          );
          if (response.statusCode !== 200) fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
          resolveRequest(output);
        } catch (error) {
          reject(error);
        }
      },
    );
    request.once('error', () => reject(new Error('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID')));
    request.end(manifest);
  });
}

export function parsePostRendererInvocation(args: readonly string[]): {
  socketPath: string;
  token: string;
} {
  const [mode, socketPath, token] = args;
  if (
    args.length !== 3 ||
    mode !== '--tenant-cutover-post-render' ||
    !socketPath ||
    !isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    !token ||
    !/^[0-9a-f]{64}$/.test(token)
  ) {
    fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
  }
  return { socketPath, token };
}

async function postRendererMain(socketPath: string, token: string): Promise<void> {
  const manifest = await readBoundedStream(
    process.stdin,
    RESTORE_STREAM_LIMIT,
    'TENANT_CUTOVER_RESTORE_STREAM_LIMIT',
  );
  process.stdout.write(await postRendererRequest(socketPath, token, manifest));
}

async function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

type ProjectionContext = 'rollout' | 'restore';

interface ProjectionRenderContext {
  namespace: string;
  release: string;
  revision: string;
  chart: string;
  projectionConfigMapName: string;
  hookRenderArgs: string[];
}

function projectionRenderContext(helmArgs: readonly string[]): ProjectionRenderContext {
  if (helmArgs[0] !== 'upgrade') fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  let cursor = 1;
  const install = helmArgs[cursor] === '--install';
  if (install) cursor += 1;
  const release = helmArgs[cursor];
  const chart = helmArgs[cursor + 1];
  if (
    typeof release !== 'string' ||
    !NAME.test(release) ||
    typeof chart !== 'string' ||
    !chart ||
    chart.includes('\0')
  ) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  const remaining = helmArgs.slice(cursor + 2);
  const namespaces = remaining.flatMap((value, index) =>
    value === '--namespace' && remaining[index + 1] ? [remaining[index + 1]!] : [],
  );
  const projectionPrefix = 'tenantAuthority.releaseProjectionConfigMap=';
  const projections = remaining.flatMap((value, index) => {
    const candidate = value === '--set' ? remaining[index + 1] : undefined;
    return candidate?.startsWith(projectionPrefix)
      ? [candidate.slice(projectionPrefix.length)]
      : [];
  });
  if (namespaces.length !== 1 || projections.length !== 1) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  const namespace = namespaces[0]!;
  const projectionConfigMapName = projections[0]!;
  const revisionMatch = projectionConfigMapName.match(/-r([1-9][0-9]*)$/);
  if (
    !NAME.test(namespace) ||
    !NAME.test(projectionConfigMapName) ||
    projectionConfigMapName.length > 63 ||
    !revisionMatch
  ) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  const renderOptions: string[] = [];
  for (let index = 0; index < remaining.length; index += 1) {
    const value = remaining[index]!;
    if (value === '--atomic' || value === '--wait' || value === '--wait-for-jobs') continue;
    if (value === '--timeout') {
      index += 1;
      if (index >= remaining.length) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      continue;
    }
    renderOptions.push(value);
  }
  return {
    namespace,
    release,
    revision: revisionMatch[1]!,
    chart,
    projectionConfigMapName,
    hookRenderArgs: [
      'template',
      release,
      chart,
      ...renderOptions,
      '--show-only',
      'templates/migration-job.yaml',
      '--show-only',
      'templates/tenant-cutover-prove-job.yaml',
      ...(revisionMatch[1] === '1' ? [] : ['--is-upgrade']),
    ],
  };
}

async function renderProjectionHooks(
  context: ProjectionRenderContext,
  values?: string,
): Promise<string> {
  try {
    return await defaultCommand('helm', context.hookRenderArgs, values);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT' ||
      code === 'TENANT_CUTOVER_COMMAND_TIMEOUT' ||
      code === 'TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED'
    ) {
      throw error;
    }
    return fail('TENANT_CUTOVER_HELM_COMMAND_FAILED');
  }
}

function latestHelmRevision(history: string, context: ProjectionContext): string {
  const invalidCode =
    context === 'rollout'
      ? 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'
      : 'TENANT_CUTOVER_RESTORE_HISTORY_INVALID';
  let parsed: unknown;
  try {
    parsed = JSON.parse(history);
  } catch {
    return fail(invalidCode);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail(invalidCode);
  const revisions = parsed.map((entry) => {
    const record = jsonRecord(entry, invalidCode);
    const revision =
      typeof record.revision === 'number' ? String(record.revision) : record.revision;
    if (typeof revision !== 'string' || !/^[1-9][0-9]*$/.test(revision)) {
      return fail(invalidCode);
    }
    return revision;
  });
  if (new Set(revisions).size !== revisions.length) fail(invalidCode);
  return revisions.reduce((latest, revision) =>
    BigInt(revision) > BigInt(latest) ? revision : latest,
  );
}

function failStoredProjectionHelmCommand(error: unknown, context: ProjectionContext): never {
  const code = error instanceof Error ? error.message : '';
  if (
    code === 'TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT' ||
    code === 'TENANT_CUTOVER_RESTORE_STREAM_LIMIT' ||
    code === 'TENANT_CUTOVER_COMMAND_TIMEOUT' ||
    code === 'TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED'
  ) {
    throw error;
  }
  return fail(
    context === 'rollout'
      ? 'TENANT_CUTOVER_HELM_PROJECTION_COMMAND_FAILED'
      : 'TENANT_CUTOVER_HELM_RESTORE_COMMAND_FAILED',
  );
}

async function verifyStoredProjection(
  renderContext: ProjectionRenderContext,
  context: ProjectionContext,
): Promise<void> {
  const invalidCode =
    context === 'rollout'
      ? 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'
      : 'TENANT_CUTOVER_RESTORE_PROJECTION_INVALID';
  const liveText = await defaultCommand('kubectl', [
    'get',
    'configmap',
    renderContext.projectionConfigMapName,
    '--namespace',
    renderContext.namespace,
    '--output',
    'json',
  ]);
  const live = parseJsonObject(liveText, invalidCode);
  const data = jsonRecord(live.data, invalidCode);
  const projectionText = data['projection.json'];
  if (typeof projectionText !== 'string') fail(invalidCode);
  let expected: HelmReleaseProjection;
  try {
    expected = JSON.parse(projectionText) as HelmReleaseProjection;
  } catch {
    return fail(invalidCode);
  }
  let history: string;
  try {
    history = await defaultCommand('helm', [
      'history',
      renderContext.release,
      '--namespace',
      renderContext.namespace,
      '--output',
      'json',
      '--max',
      '256',
    ]);
  } catch (error) {
    return failStoredProjectionHelmCommand(error, context);
  }
  if (latestHelmRevision(history, context) !== renderContext.revision) {
    fail(context === 'rollout' ? invalidCode : 'TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
  }
  let values: string;
  let manifest: string;
  let hooks: string;
  try {
    [values, manifest, hooks] = await Promise.all([
      readHelmBounded(
        [
          'get',
          'values',
          renderContext.release,
          '--namespace',
          renderContext.namespace,
          '--revision',
          renderContext.revision,
          '--output',
          'yaml',
        ],
        RESTORE_STREAM_LIMIT,
      ),
      readHelmBounded(
        [
          'get',
          'manifest',
          renderContext.release,
          '--namespace',
          renderContext.namespace,
          '--revision',
          renderContext.revision,
        ],
        RESTORE_STREAM_LIMIT,
      ),
      readHelmBounded(
        [
          'get',
          'hooks',
          renderContext.release,
          '--namespace',
          renderContext.namespace,
          '--revision',
          renderContext.revision,
        ],
        RESTORE_STREAM_LIMIT,
      ),
    ]);
  } catch (error) {
    return failStoredProjectionHelmCommand(error, context);
  }
  let stored: HelmReleaseProjection;
  try {
    const rendererValues = await projectionRendererValues(renderContext.chart, values, context);
    stored = projectHelmReleaseRevision({
      namespace: renderContext.namespace,
      releaseName: renderContext.release,
      revision: renderContext.revision,
      manifest: hooks.trim() ? manifest + '\n---\n' + hooks : manifest,
      values: rendererValues,
    });
  } catch {
    return fail(invalidCode);
  }
  if (canonicalBootstrapJson(stored) !== canonicalBootstrapJson(expected)) fail(invalidCode);
}

async function runProjectedHelmCommand(
  args: readonly string[],
  stdin: string | undefined,
  context: ProjectionContext,
): Promise<void> {
  try {
    await defaultCommand('helm', args, stdin, 'helm_rollout');
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT' ||
      code === 'TENANT_CUTOVER_COMMAND_TIMEOUT' ||
      code === 'TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED'
    ) {
      throw error;
    }
    return fail('TENANT_CUTOVER_HELM_COMMAND_FAILED');
  }
}

async function streamValuesToHelm(input: {
  values: string;
  helmArgs: readonly string[];
  postRender(manifest: string): string;
  afterPostRender?(manifest: string, rendererValues: string): Promise<void>;
}): Promise<void> {
  const renderContext = projectionRenderContext(input.helmArgs);
  const hookManifest = await renderProjectionHooks(renderContext, input.values);
  const projectionValues = await projectionRendererValues(
    renderContext.chart,
    input.values,
    'restore',
  );
  const socketDirectory = await mkdtemp(join(tmpdir(), 'commander-restore-'));
  await chmod(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, 'post-render.sock');
  const token = randomBytes(32).toString('hex');
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers['x-commander-restore-token'];
      if (
        request.method !== 'POST' ||
        typeof supplied !== 'string' ||
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
        requests !== 0
      ) {
        fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
      }
      requests += 1;
      const manifest = await readBoundedStream(
        request,
        RESTORE_STREAM_LIMIT,
        'TENANT_CUTOVER_RESTORE_STREAM_LIMIT',
      );
      const rendered = input.postRender(manifest);
      const projectionManifest = mergePostRenderedHelmHooks({
        namespace: renderContext.namespace,
        releaseName: renderContext.release,
        revision: renderContext.revision,
        projectionConfigMapName: renderContext.projectionConfigMapName,
        manifest: rendered,
        hookManifest,
      });
      await input.afterPostRender?.(projectionManifest, projectionValues);
      response.writeHead(200, { 'content-type': 'application/yaml' });
      response.end(rendered);
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  await unlink(socketPath).catch(() => undefined);
  await listen(server, socketPath);
  const postRendererArgs = [
    ...process.execArgv,
    resolve(process.argv[1] ?? fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID')),
    '--tenant-cutover-post-render',
    socketPath,
    token,
  ].flatMap((argument) => ['--post-renderer-args=' + argument]);
  if (Buffer.byteLength(input.values) > RESTORE_STREAM_LIMIT) {
    fail('TENANT_CUTOVER_RESTORE_STREAM_LIMIT');
  }
  try {
    await runProjectedHelmCommand(
      [...input.helmArgs, '--post-renderer', process.execPath, ...postRendererArgs],
      input.values,
      'restore',
    );
    if (requests !== 1) fail('TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID');
    await verifyStoredProjection(renderContext, 'restore');
  } finally {
    await closeServer(server);
    await rm(socketDirectory, { recursive: true, force: true });
  }
}

async function runHelmPostRendered(
  helmArgs: readonly string[],
  rendererValues: string,
  postRender: (manifest: string, rendererValues: string) => Promise<string>,
): Promise<void> {
  const renderContext = projectionRenderContext(helmArgs);
  const hookManifest = await renderProjectionHooks(renderContext, rendererValues);
  const projectionValues = await projectionRendererValues(
    renderContext.chart,
    rendererValues,
    'rollout',
  );
  const socketDirectory = await mkdtemp(join(tmpdir(), 'commander-projection-'));
  await chmod(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, 'post-render.sock');
  const token = randomBytes(32).toString('hex');
  let requests = 0;
  let postRenderFailureCode: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers['x-commander-restore-token'];
      if (
        request.method !== 'POST' ||
        typeof supplied !== 'string' ||
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
        requests !== 0
      ) {
        fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      }
      requests += 1;
      const manifest = await readBoundedStream(
        request,
        RESTORE_STREAM_LIMIT,
        'TENANT_CUTOVER_RESTORE_STREAM_LIMIT',
      );
      await postRender(
        mergePostRenderedHelmHooks({
          namespace: renderContext.namespace,
          releaseName: renderContext.release,
          revision: renderContext.revision,
          projectionConfigMapName: renderContext.projectionConfigMapName,
          manifest,
          hookManifest,
        }),
        projectionValues,
      );
      response.writeHead(200, { 'content-type': 'application/yaml' });
      response.end(manifest);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        code === 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID' ||
        code === 'TENANT_CUTOVER_RESTORE_PROJECTION_INVALID' ||
        code === 'TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED'
      ) {
        postRenderFailureCode =
          code === 'TENANT_CUTOVER_RESTORE_PROJECTION_INVALID'
            ? 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'
            : code;
      }
      response.writeHead(400);
      response.end();
    }
  });
  await unlink(socketPath).catch(() => undefined);
  await listen(server, socketPath);
  const postRendererArgs = [
    ...process.execArgv,
    resolve(process.argv[1] ?? fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID')),
    '--tenant-cutover-post-render',
    socketPath,
    token,
  ].flatMap((argument) => ['--post-renderer-args=' + argument]);
  try {
    try {
      await runProjectedHelmCommand(
        [...helmArgs, '--post-renderer', process.execPath, ...postRendererArgs],
        undefined,
        'rollout',
      );
    } catch (error) {
      if (postRenderFailureCode) fail(postRenderFailureCode);
      throw error;
    }
    if (requests !== 1) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
    await verifyStoredProjection(renderContext, 'rollout');
  } finally {
    await closeServer(server);
    await rm(socketDirectory, { recursive: true, force: true });
  }
}

function assertProjectionConsumer(
  manifest: string,
  release: string,
  revision: string,
  configMapName: string,
): void {
  const jobs: JsonRecord[] = [];
  try {
    loadAll(manifest, (document) => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) return;
      const object = document as JsonRecord;
      const metadata = jsonRecord(object.metadata, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const annotations =
        metadata.annotations === undefined
          ? {}
          : jsonRecord(metadata.annotations, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      if (
        object.kind === 'Job' &&
        typeof annotations['helm.sh/hook'] === 'string' &&
        annotations['helm.sh/hook']
          .split(',')
          .map((value) => value.trim())
          .includes('post-upgrade')
      ) {
        jobs.push(object);
      }
    });
  } catch {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  if (jobs.length !== 1) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const metadata = jsonRecord(jobs[0]!.metadata, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const suffix = `-tenant-cutover-prove-r${revision}`;
  const expectedName = `${release.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
  if (metadata.name !== expectedName) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const spec = jsonRecord(jobs[0]!.spec, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const template = jsonRecord(spec.template, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const podSpec = jsonRecord(template.spec, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const volumes = Array.isArray(podSpec.volumes)
    ? podSpec.volumes.map((value) => jsonRecord(value, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'))
    : [];
  const volume = volumes.filter((value) => value.name === 'release-projection');
  if (volume.length !== 1) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  const configMap = jsonRecord(volume[0]!.configMap, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  if (configMap.name !== configMapName) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
}

type HelmCommandPort = (
  program: string,
  args: readonly string[],
  stdin?: string,
) => Promise<string>;

function releaseProjectionLabels(release: string): Record<string, string> {
  return {
    'commander.io/tenant-authority-release-projection': 'true',
    'commander.io/tenant-authority-proof-release': release,
  };
}

async function readReleaseProjectionConfigMap(
  command: HelmCommandPort,
  namespace: string,
  name: string,
): Promise<JsonRecord | undefined> {
  const output = await command('kubectl', [
    'get',
    'configmap',
    name,
    '--namespace',
    namespace,
    '--ignore-not-found=true',
    '--output',
    'json',
  ]);
  return output.trim()
    ? parseJsonObject(output, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID')
    : undefined;
}

async function deleteReleaseProjectionConfigMap(
  command: HelmCommandPort,
  namespace: string,
  name: string,
): Promise<void> {
  await command('kubectl', [
    'delete',
    'configmap',
    name,
    '--namespace',
    namespace,
    '--ignore-not-found=true',
    '--wait=true',
  ]);
  if (await readReleaseProjectionConfigMap(command, namespace, name)) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_CLEANUP_FAILED');
  }
}

async function prepareReleaseProjectionConfigMap(
  command: HelmCommandPort,
  input: {
    namespace: string;
    release: string;
    revision: string;
    name: string;
    projection: HelmReleaseProjection;
  },
): Promise<void> {
  const labels = releaseProjectionLabels(input.release);
  const annotations = { 'commander.io/helm-release-revision': input.revision };
  const projectionBytes = `${canonicalBootstrapJson(input.projection)}\n`;
  const desired = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: input.name, namespace: input.namespace, labels, annotations },
    immutable: true,
    data: { 'projection.json': projectionBytes },
  };
  try {
    const created = (
      await command(
        'kubectl',
        ['create', '--filename', '-', '--output', 'name'],
        canonicalBootstrapJson(desired),
      )
    ).trim();
    if (created !== `configmap/${input.name}`) {
      fail('TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED');
    }
  } catch {
    // Lost success responses and create races converge only through an exact live reread.
  }
  const live = await readReleaseProjectionConfigMap(command, input.namespace, input.name);
  if (!live) fail('TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED');
  const metadata = jsonRecord(live.metadata, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  if (
    live.apiVersion !== 'v1' ||
    live.kind !== 'ConfigMap' ||
    live.immutable !== true ||
    metadata.name !== input.name ||
    metadata.namespace !== input.namespace ||
    Object.hasOwn(metadata, 'deletionTimestamp') ||
    canonicalBootstrapJson(metadata.labels) !== canonicalBootstrapJson(labels) ||
    canonicalBootstrapJson(metadata.annotations) !== canonicalBootstrapJson(annotations) ||
    canonicalBootstrapJson(live.data) !==
      canonicalBootstrapJson({ 'projection.json': projectionBytes }) ||
    Object.hasOwn(live, 'binaryData')
  ) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
}

export interface NodePortsRuntime {
  command?(
    program: string,
    args: readonly string[],
    stdin?: string,
    executionPolicy?: CommandExecutionPolicy,
  ): Promise<string>;
  restoreRuntime?: HelmRevisionRestoreRuntime;
}

function parseJsonObject(value: string, code: string): JsonRecord {
  try {
    return jsonRecord(JSON.parse(value), code);
  } catch {
    return fail(code);
  }
}

function objectManifest(identity: HelmReleaseObjectIdentity): string {
  return canonicalBootstrapJson({
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    metadata: {
      name: identity.name,
      ...(identity.namespace ? { namespace: identity.namespace } : {}),
    },
  });
}

function parsedObjectIdentity(value: JsonRecord): HelmReleaseObjectIdentity {
  const metadata = jsonRecord(value.metadata, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
  if (
    typeof value.apiVersion !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof metadata.name !== 'string' ||
    (metadata.namespace !== undefined && typeof metadata.namespace !== 'string')
  ) {
    fail('TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
  }
  return {
    apiVersion: value.apiVersion,
    kind: value.kind,
    namespace: (metadata.namespace as string | undefined) ?? '',
    name: metadata.name,
  };
}

function assertObjectIdentity(value: JsonRecord, expected: HelmReleaseObjectIdentity): void {
  if (releaseObjectKey(parsedObjectIdentity(value)) !== releaseObjectKey(expected)) {
    fail('TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
  }
}

function projectedMetadata(value: unknown): JsonRecord {
  const metadata = { ...jsonRecord(value, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID') };
  for (const key of [
    'creationTimestamp',
    'deletionGracePeriodSeconds',
    'deletionTimestamp',
    'generation',
    'managedFields',
    'resourceVersion',
    'selfLink',
    'uid',
  ]) {
    delete metadata[key];
  }
  return metadata;
}

function matchesProjectedValue(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => matchesProjectedValue(value, actual[index]))
    );
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as JsonRecord).every(([key, value]) =>
      matchesProjectedValue(value, (actual as JsonRecord)[key]),
    );
  }
  return isDeepStrictEqual(expected, actual);
}

function assertSecretMatches(
  object: HelmReleaseObjectProjection,
  live: JsonRecord,
  retainedSecrets: RetainedSecretPayloads,
): void {
  const comparator = object.comparator;
  const retained = retainedSecrets.get(releaseObjectKey(object.identity));
  if (!retained) fail('TENANT_CUTOVER_RESTORE_SECRET_PAYLOAD_REQUIRED');
  if (
    Object.hasOwn(
      jsonRecord(live.metadata, 'TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH'),
      'deletionTimestamp',
    )
  ) {
    fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  }
  const livePayload = decodeSecretData(live);
  if (
    comparator.metadata === undefined ||
    !matchesProjectedValue(comparator.metadata, projectedMetadata(live.metadata)) ||
    live.type !== comparator.type ||
    (live.immutable === true) !== comparator.immutable ||
    !Array.isArray(comparator.dataKeys) ||
    !exactKeys(livePayload.keys(), comparator.dataKeys as string[]) ||
    !exactKeys(livePayload.keys(), retained.keys())
  ) {
    fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
  }
  for (const [key, expected] of retained) {
    const actual = livePayload.get(key);
    if (!actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
    }
  }
}

function desiredObject(object: HelmReleaseObjectProjection): JsonRecord {
  const desired = {
    ...jsonRecord(object.comparator.desired, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID'),
  };
  desired.apiVersion = object.identity.apiVersion;
  desired.kind = object.identity.kind;
  desired.metadata = {
    ...jsonRecord(desired.metadata, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID'),
    name: object.identity.name,
    ...(object.identity.namespace ? { namespace: object.identity.namespace } : {}),
  };
  return desired;
}

function ownedFields(value: JsonRecord, manager: string): unknown {
  const metadata = jsonRecord(value.metadata, 'TENANT_CUTOVER_RESTORE_DRY_RUN_INVALID');
  if (!Array.isArray(metadata.managedFields)) {
    fail('TENANT_CUTOVER_RESTORE_DRY_RUN_INVALID');
  }
  const matches = metadata.managedFields.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as JsonRecord).manager === manager &&
      (entry as JsonRecord).operation === 'Apply' &&
      (entry as JsonRecord).fieldsType === 'FieldsV1',
  ) as JsonRecord[];
  if (matches.length !== 1 || matches[0]!.fieldsV1 === undefined) {
    fail('TENANT_CUTOVER_RESTORE_DRY_RUN_INVALID');
  }
  return matches[0]!.fieldsV1;
}

function apiDiscoveryPath(apiVersion: string): string {
  if (apiVersion === 'v1') return '/api/v1';
  const parts = apiVersion.split('/');
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[a-z0-9.-]+$/.test(parts[0]) ||
    !/^[a-z0-9]+$/.test(parts[1])
  ) {
    fail('TENANT_CUTOVER_RESTORE_API_DISCOVERY_INVALID');
  }
  return `/apis/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function deletionPath(
  identity: HelmReleaseObjectIdentity,
  resource: string,
  namespaced: boolean,
): string {
  const prefix = apiDiscoveryPath(identity.apiVersion);
  const namespace = namespaced ? `/namespaces/${encodeURIComponent(identity.namespace)}` : '';
  return `${prefix}${namespace}/${resource}/${encodeURIComponent(identity.name)}`;
}

export function createNodePorts(overrides: NodePortsRuntime = {}): HelmCutoverPorts {
  const command = overrides.command ?? defaultCommand;
  const boundedHelmRead =
    overrides.restoreRuntime?.readHelmBounded ??
    (overrides.command
      ? async (args: readonly string[], maximumBytes: number): Promise<string> => {
          const output = await command('helm', args);
          if (Buffer.byteLength(output) > maximumBytes) {
            fail('TENANT_CUTOVER_RESTORE_STREAM_LIMIT');
          }
          return output;
        }
      : readHelmBounded);
  let retainedSecrets: RetainedSecretPayloads = new Map();
  let restoredOwner: { namespace: string; release: string } | undefined;
  let kubernetesVersionChecked = false;
  const assertKubernetesVersion = async (): Promise<void> => {
    if (kubernetesVersionChecked) return;
    const version = parseJsonObject(
      await command('kubectl', ['version', '--output=json']),
      'TENANT_CUTOVER_KUBERNETES_VERSION_INVALID',
    );
    const serverVersion = jsonRecord(
      version.serverVersion,
      'TENANT_CUTOVER_KUBERNETES_VERSION_INVALID',
    );
    if (serverVersion.gitVersion !== KUBERNETES_VERSION) {
      fail('TENANT_CUTOVER_KUBERNETES_VERSION_INVALID');
    }
    kubernetesVersionChecked = true;
  };
  const readLiveObject = async (
    identity: HelmReleaseObjectIdentity,
  ): Promise<JsonRecord | undefined> => {
    const output = await command(
      'kubectl',
      ['get', '--filename', '-', '--ignore-not-found=true', '--output', 'json'],
      objectManifest(identity),
    );
    if (!output.trim()) return undefined;
    const object = parseJsonObject(output, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
    assertObjectIdentity(object, identity);
    return object;
  };
  const helmOwnership = (object: JsonRecord): { ownerNamespace: string; ownerRelease: string } => {
    const metadata = jsonRecord(object.metadata, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
    const annotations = jsonRecord(
      metadata.annotations,
      'TENANT_CUTOVER_RESTORE_OBJECT_OWNER_INVALID',
    );
    const ownerNamespace = annotations['meta.helm.sh/release-namespace'];
    const ownerRelease = annotations['meta.helm.sh/release-name'];
    if (
      typeof ownerNamespace !== 'string' ||
      !ownerNamespace ||
      typeof ownerRelease !== 'string' ||
      !ownerRelease ||
      (restoredOwner !== undefined &&
        (ownerNamespace !== restoredOwner.namespace || ownerRelease !== restoredOwner.release))
    ) {
      fail('TENANT_CUTOVER_RESTORE_OBJECT_OWNER_INVALID');
    }
    return { ownerNamespace, ownerRelease };
  };
  const fs: HelmFileSystemPort = {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    },
    writeFileAtomic: async (path, contents) => {
      const temporary = path + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(contents);
        await file.sync();
        await file.chmod(0o600);
        await file.close();
        await rename(temporary, path);
      } catch (error) {
        await file?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    readFile: (path) => readFile(path, 'utf8'),
    retainedChartPackage: async (stateDirectory, namespace, release, digest) =>
      stateDirectory + '/' + namespace + '/' + release + '/charts/' + digest + '/commander',
    retainChartPackage: async (source, stateDirectory, namespace, release, digest) => {
      const target =
        stateDirectory + '/' + namespace + '/' + release + '/charts/' + digest + '/commander';
      try {
        await readFile(target + '/Chart.yaml');
        return target;
      } catch {
        // The retained chart is created below; any existing partial path is not reused.
      }
      await rm(target, { recursive: true, force: true });
      const parent = dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const temporary = target + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
      try {
        await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
        await chmod(temporary, 0o700);
        try {
          await rename(temporary, target);
        } catch (error) {
          try {
            await readFile(target + '/Chart.yaml');
          } catch {
            throw error;
          }
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return target;
    },
  };
  const owner = async (
    mode: HelmOwnerMode,
    payload: Record<string, unknown>,
    context: HelmOwnerExecutionContext,
  ): Promise<Record<string, unknown>> => {
    const bundle = buildHelmOwnerJobBundle({
      mode,
      payload,
      context,
      executionId: randomBytes(16).toString('hex'),
    });
    try {
      const createdConfigMap = (
        await command(
          'kubectl',
          ['create', '--filename', '-', '--output', 'name'],
          canonicalBootstrapJson(bundle.configMap),
        )
      ).trim();
      if (createdConfigMap !== 'configmap/' + bundle.configMapName) {
        fail('TENANT_CUTOVER_OWNER_JOB_CREATE_FAILED');
      }
      const createdJob = (
        await command(
          'kubectl',
          ['create', '--filename', '-', '--output', 'name'],
          canonicalBootstrapJson(bundle.job),
        )
      ).trim();
      if (createdJob !== 'job.batch/' + bundle.jobName) {
        fail('TENANT_CUTOVER_OWNER_JOB_CREATE_FAILED');
      }
      try {
        const ownerJob = 'job/' + bundle.jobName;
        await command(
          'kubectl',
          [
            'wait',
            '--for=condition=complete',
            ownerJob,
            '--namespace',
            context.namespace,
            '--timeout=5m',
          ],
          undefined,
          'owner_job_wait',
        );
      } catch {
        const ownerJob = 'job/' + bundle.jobName;
        let logs = 'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE';
        let logTransport: 'kubectl_logs' | 'kubectl_logs_unavailable' = 'kubectl_logs_unavailable';
        try {
          logs = await command('kubectl', [
            'logs',
            ownerJob,
            '--namespace',
            context.namespace,
            '--tail=40',
          ]);
          logTransport = 'kubectl_logs';
        } catch {
          logs = 'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE';
        }
        fail('TENANT_CUTOVER_OWNER_JOB_FAILED:' + ownerJobFailureDiagnostic(logs, logTransport));
      }
      const output = (
        await command('kubectl', [
          'logs',
          `job/${bundle.jobName}`,
          '--namespace',
          context.namespace,
        ])
      ).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
      }
      return parsed as Record<string, unknown>;
    } finally {
      for (const resource of ['job', 'pod', 'configmap']) {
        await command('kubectl', [
          'delete',
          resource,
          '--selector',
          bundle.selector,
          '--namespace',
          context.namespace,
          '--ignore-not-found=true',
          '--wait=true',
        ]).catch(() => undefined);
      }
      const remaining = (
        await command('kubectl', [
          'get',
          'jobs,pods,configmaps',
          '--selector',
          bundle.selector,
          '--namespace',
          context.namespace,
          '--ignore-not-found=true',
          '--output',
          'name',
        ])
      ).trim();
      if (remaining) fail('TENANT_CUTOVER_OWNER_JOB_CLEANUP_FAILED');
    }
  };
  const operation = (value: unknown): HelmOperation => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
    return value as HelmOperation;
  };
  return {
    chartDigest: verifyChartContentDigest,
    readValues: (path) => readFile(path, 'utf8'),
    createNonce: () => randomBytes(32).toString('base64url'),
    fs,
    owner: {
      plan: async (payload, context) => {
        const value = await owner('tenant-cutover-plan', payload, context);
        if (value.action === 'append') return { action: 'append' };
        if (
          (value.action === 'return_current' || value.action === 'retry_rollout') &&
          value.operation
        )
          return {
            action: value.action,
            operation: {
              ...operation(value.operation),
              proven: value.action === 'return_current',
            },
          };
        fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
      },
      append: async (payload, context) => ({
        ...operation((await owner('tenant-cutover-append', payload, context)).operation),
        proven: false,
      }),
      restore: async (payload) => {
        const namespace = payload.namespace;
        const release = payload.release;
        if (typeof namespace !== 'string' || typeof release !== 'string') {
          fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
        }
        const values = await boundedHelmRead(
          ['get', 'values', release, '--namespace', namespace, '--all', '--output', 'yaml'],
          RESTORE_STREAM_LIMIT,
        );
        const databasePlan = databaseRolloutPlan(values, release, 'enforce');
        const context = createHelmOwnerExecutionContext({
          values,
          namespace,
          release,
          command: 'enforce',
          databaseSecretName: databasePlan.reference.sourceName,
        });
        return operation((await owner('tenant-cutover-restore', payload, context)).operation);
      },
    },
    helm: {
      version: () => command('helm', ['version', '--short']),
      run: (args, stdin) => command('helm', args, stdin, 'helm_rollout'),
      nextRevision: async (namespace, release) => {
        let listed: unknown;
        try {
          listed = JSON.parse(
            await command('helm', [
              'list',
              '--namespace',
              namespace,
              '--all',
              '--filter',
              `^${release}$`,
              '--output',
              'json',
            ]),
          );
        } catch {
          return fail('TENANT_CUTOVER_RELEASE_DISCOVERY_FAILED');
        }
        if (!Array.isArray(listed) || listed.length > 1) {
          fail('TENANT_CUTOVER_RELEASE_DISCOVERY_FAILED');
        }
        if (listed.length === 0) return '1';
        let history: unknown;
        try {
          history = JSON.parse(
            await command('helm', [
              'history',
              release,
              '--namespace',
              namespace,
              '--output',
              'json',
              '--max',
              '256',
            ]),
          );
        } catch {
          return fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
        }
        if (!Array.isArray(history) || history.length === 0) {
          fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
        }
        const revisions = history.map((entry) => {
          const object = jsonRecord(entry, 'TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
          const revision =
            typeof object.revision === 'number' ? String(object.revision) : object.revision;
          if (typeof revision !== 'string' || !/^[1-9][0-9]*$/.test(revision)) {
            return fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
          }
          return revision;
        });
        const latest = revisions.reduce((left, right) =>
          BigInt(left) > BigInt(right) ? left : right,
        );
        return String(BigInt(latest) + 1n);
      },
      runProjectedRevision: async (request) => {
        if (
          !/^[1-9][0-9]*$/.test(request.revision) ||
          !NAME.test(request.projectionConfigMapName) ||
          request.projectionConfigMapName.length > 63 ||
          request.args.some((value) => value.startsWith('--post-renderer'))
        ) {
          fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
        }
        const labels = {
          'commander.io/tenant-authority-release-projection': 'true',
          'commander.io/tenant-authority-proof-release': request.release,
        };
        const annotations = {
          'commander.io/helm-release-revision': request.revision,
        };
        const readProjectionConfigMap = async (): Promise<JsonRecord | undefined> => {
          const output = await command('kubectl', [
            'get',
            'configmap',
            request.projectionConfigMapName,
            '--namespace',
            request.namespace,
            '--ignore-not-found=true',
            '--output',
            'json',
          ]);
          return output.trim()
            ? parseJsonObject(output, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID')
            : undefined;
        };
        const deleteProjectionConfigMap = async (): Promise<void> => {
          await command('kubectl', [
            'delete',
            'configmap',
            request.projectionConfigMapName,
            '--namespace',
            request.namespace,
            '--ignore-not-found=true',
            '--wait=true',
          ]);
          if (await readProjectionConfigMap()) {
            fail('TENANT_CUTOVER_RELEASE_PROJECTION_CLEANUP_FAILED');
          }
        };
        let projection: HelmReleaseProjection | undefined;
        await deleteProjectionConfigMap();
        try {
          await runHelmPostRendered(
            request.args,
            request.rendererValues,
            async (manifest, rendererValues) => {
              assertProjectionConsumer(
                manifest,
                request.release,
                request.revision,
                request.projectionConfigMapName,
              );
              projection = projectHelmReleaseRevision({
                namespace: request.namespace,
                releaseName: request.release,
                revision: request.revision,
                manifest,
                values: rendererValues,
              });
              const projectionBytes = canonicalBootstrapJson(projection) + '\n';
              const desired = {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                  name: request.projectionConfigMapName,
                  namespace: request.namespace,
                  labels,
                  annotations,
                },
                immutable: true,
                data: { 'projection.json': projectionBytes },
              };
              try {
                const created = (
                  await command(
                    'kubectl',
                    ['create', '--filename', '-', '--output', 'name'],
                    canonicalBootstrapJson(desired),
                  )
                ).trim();
                if (created !== 'configmap/' + request.projectionConfigMapName) {
                  fail('TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED');
                }
              } catch {
                // Lost success responses and create races converge only through an exact live reread.
              }
              const live = await readProjectionConfigMap();
              if (!live) fail('TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED');
              const metadata = jsonRecord(
                live.metadata,
                'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID',
              );
              if (
                live.apiVersion !== 'v1' ||
                live.kind !== 'ConfigMap' ||
                live.immutable !== true ||
                metadata.name !== request.projectionConfigMapName ||
                metadata.namespace !== request.namespace ||
                canonicalBootstrapJson(metadata.labels) !== canonicalBootstrapJson(labels) ||
                canonicalBootstrapJson(metadata.annotations) !==
                  canonicalBootstrapJson(annotations) ||
                canonicalBootstrapJson(live.data) !==
                  canonicalBootstrapJson({ 'projection.json': projectionBytes }) ||
                Object.hasOwn(live, 'binaryData')
              ) {
                fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
              }
              return manifest;
            },
          );
          if (!projection) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
          return projection;
        } finally {
          await deleteProjectionConfigMap();
        }
      },
      releaseExists: async (namespace, release) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            await command('helm', [
              'list',
              '--namespace',
              namespace,
              '--all',
              '--filter',
              `^${release}$`,
              '--output',
              'json',
            ]),
          );
        } catch {
          return fail('TENANT_CUTOVER_RELEASE_DISCOVERY_FAILED');
        }
        if (
          !Array.isArray(parsed) ||
          parsed.length > 1 ||
          parsed.some(
            (entry) =>
              !entry ||
              typeof entry !== 'object' ||
              Array.isArray(entry) ||
              (entry as Record<string, unknown>).name !== release,
          )
        ) {
          fail('TENANT_CUTOVER_RELEASE_DISCOVERY_FAILED');
        }
        return parsed.length === 1;
      },
      currentRevision: async (namespace, release) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            await command('helm', [
              'history',
              release,
              '--namespace',
              namespace,
              '--output',
              'json',
              '--max',
              '256',
            ]),
          );
        } catch {
          return fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
        }
        const revisions = parsed.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
          }
          const revision = (entry as Record<string, unknown>).revision;
          const value = typeof revision === 'number' ? String(revision) : revision;
          if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
            return fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
          }
          return value;
        });
        if (new Set(revisions).size !== revisions.length) {
          fail('TENANT_CUTOVER_RESTORE_HISTORY_INVALID');
        }
        return revisions.reduce((latest, revision) =>
          BigInt(revision) > BigInt(latest) ? revision : latest,
        );
      },
      projectRevision: async (namespace, release, revision, chart) => {
        const [values, manifest, hooks] = await Promise.all([
          boundedHelmRead(
            [
              'get',
              'values',
              release,
              '--namespace',
              namespace,
              '--revision',
              revision,
              '--output',
              'yaml',
            ],
            RESTORE_STREAM_LIMIT,
          ),
          boundedHelmRead(
            ['get', 'manifest', release, '--namespace', namespace, '--revision', revision],
            RESTORE_STREAM_LIMIT,
          ),
          boundedHelmRead(
            ['get', 'hooks', release, '--namespace', namespace, '--revision', revision],
            RESTORE_STREAM_LIMIT,
          ),
        ]);
        const rendererValues = await projectionRendererValues(chart, values, 'restore');
        return projectHelmReleaseRevision({
          namespace,
          releaseName: release,
          revision,
          manifest: hooks.trim() ? manifest + '\n---\n' + hooks : manifest,
          values: rendererValues,
        });
      },
      proofJobManifest: (namespace, release, revision) => {
        if (!/^[1-9][0-9]*$/.test(revision)) {
          return Promise.reject(new Error('TENANT_CUTOVER_PROOF_JOB_INVALID'));
        }
        return boundedHelmRead(
          ['get', 'hooks', release, '--namespace', namespace, '--revision', revision],
          RESTORE_STREAM_LIMIT,
        );
      },
      restoreRevision: async (request) => {
        if (overrides.restoreRuntime) {
          await streamHelmRevisionRestore(request, overrides.restoreRuntime, (payloads) => {
            retainedSecrets = payloads;
          });
          restoredOwner = { namespace: request.namespace, release: request.release };
          return;
        }
        let projected = false;
        await deleteReleaseProjectionConfigMap(
          command,
          request.namespace,
          request.projectionConfigMapName,
        );
        try {
          await streamHelmRevisionRestore(
            request,
            {
              readHelmBounded,
              streamValuesToHelm: (input) =>
                streamValuesToHelm({
                  ...input,
                  afterPostRender: async (manifest, rendererValues) => {
                    assertProjectionConsumer(
                      manifest,
                      request.release,
                      request.targetRevision,
                      request.projectionConfigMapName,
                    );
                    const projection = projectHelmReleaseRevision({
                      namespace: request.namespace,
                      releaseName: request.release,
                      revision: request.targetRevision,
                      manifest,
                      values: rendererValues,
                    });
                    await prepareReleaseProjectionConfigMap(command, {
                      namespace: request.namespace,
                      release: request.release,
                      revision: request.targetRevision,
                      name: request.projectionConfigMapName,
                      projection,
                    });
                    projected = true;
                  },
                }),
            },
            (payloads) => {
              retainedSecrets = payloads;
            },
          );
          if (!projected) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
          restoredOwner = { namespace: request.namespace, release: request.release };
        } finally {
          await deleteReleaseProjectionConfigMap(
            command,
            request.namespace,
            request.projectionConfigMapName,
          );
        }
      },
    },
    kubectl: {
      readSecretValue: async (namespace, name, key) => {
        const encoded = (
          await command('kubectl', [
            'get',
            'secret',
            name,
            '--namespace',
            namespace,
            '--output',
            `go-template={{ index .data ${JSON.stringify(key)} }}`,
          ])
        ).trim();
        if (
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
          Buffer.from(encoded, 'base64').length === 0 ||
          Buffer.from(encoded, 'base64').toString('base64') !== encoded
        ) {
          fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
        }
        return Buffer.from(encoded, 'base64');
      },
      prepareFreshBundledDatabaseSecret: async ({ namespace, name, hostname, port, database }) => {
        const identity = { namespace, name, hostname, port, database };
        const readSecret = async (): Promise<string> =>
          command('kubectl', [
            'get',
            'secret',
            name,
            '--namespace',
            namespace,
            '--ignore-not-found=true',
            '--output',
            'json',
          ]);
        const existing = await readSecret();
        if (existing.trim()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(existing);
          } catch {
            return fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
          }
          validateFreshBundledDatabaseSecret(parsed, identity);
          return;
        }
        const password = () => randomBytes(24).toString('base64url');
        const passwords = {
          owner: password(),
          app: password(),
          tenantAuthority: password(),
          scheduler: password(),
          worker: password(),
          adapterOps: password(),
          postgres: password(),
        };
        const dsn = (role: string, secret: string) =>
          'postgres://' +
          role +
          ':' +
          encodeURIComponent(secret) +
          '@' +
          hostname +
          ':' +
          port +
          '/' +
          database +
          '?sslmode=verify-full';
        const values: Record<string, string> = {
          'owner-url': dsn('commander_owner', passwords.owner),
          'app-url': dsn('commander_app', passwords.app),
          'tenant-authority-url': dsn('commander_tenant_authority', passwords.tenantAuthority),
          'scheduler-url': dsn('commander_scheduler', passwords.scheduler),
          'worker-url': dsn('commander_worker', passwords.worker),
          'adapter-ops-url': dsn('commander_adapter_ops', passwords.adapterOps),
          'owner-password': passwords.owner,
          'app-password': passwords.app,
          'tenant-authority-password': passwords.tenantAuthority,
          'scheduler-password': passwords.scheduler,
          'worker-password': passwords.worker,
          'adapter-ops-password': passwords.adapterOps,
          'postgres-password': passwords.postgres,
        };
        const manifest = canonicalBootstrapJson({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name,
            namespace,
            labels: { 'app.kubernetes.io/managed-by': 'Commander' },
          },
          immutable: true,
          type: 'Opaque',
          data: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key,
              Buffer.from(value, 'utf8').toString('base64'),
            ]),
          ),
        });
        try {
          const created = (
            await command('kubectl', ['create', '--filename', '-', '--output', 'name'], manifest)
          ).trim();
          if (created !== 'secret/' + name) fail('TENANT_CUTOVER_DATABASE_SECRET_CREATE_FAILED');
        } catch {
          // A create race or a lost success response is resolved only by an exact live re-read.
        }
        const reread = await readSecret();
        if (!reread.trim()) fail('TENANT_CUTOVER_DATABASE_SECRET_CREATE_FAILED');
        let parsed: unknown;
        try {
          parsed = JSON.parse(reread);
        } catch {
          return fail('TENANT_CUTOVER_DATABASE_SECRET_INVALID');
        }
        validateFreshBundledDatabaseSecret(parsed, identity);
      },
      prepareProofOwnerSecret: async ({ namespace, sourceName, sourceKey, targetName }) => {
        await command('kubectl', [
          'delete',
          'secret',
          targetName,
          '--namespace',
          namespace,
          '--ignore-not-found=true',
          '--wait=true',
        ]);
        const encoded = (
          await command('kubectl', [
            'get',
            'secret',
            sourceName,
            '--namespace',
            namespace,
            '--output',
            `go-template={{ index .data ${JSON.stringify(sourceKey)} }}`,
          ])
        ).trim();
        if (
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
          Buffer.from(encoded, 'base64').length === 0 ||
          Buffer.from(encoded, 'base64').toString('base64') !== encoded
        ) {
          fail('TENANT_CUTOVER_PROOF_OWNER_SECRET_INVALID');
        }
        const manifest = canonicalBootstrapJson({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: targetName,
            namespace,
            labels: {
              'commander.io/tenant-authority-proof-owner': 'true',
            },
          },
          immutable: true,
          type: 'Opaque',
          data: { [sourceKey]: encoded },
        });
        try {
          const created = (
            await command('kubectl', ['create', '--filename', '-', '--output', 'name'], manifest)
          ).trim();
          if (created !== 'secret/' + targetName) {
            fail('TENANT_CUTOVER_PROOF_OWNER_SECRET_CREATE_FAILED');
          }
        } catch {
          // Lost success responses and create races converge only through an exact live reread.
        }
        const observed = parseJsonObject(
          await command('kubectl', [
            'get',
            'secret',
            targetName,
            '--namespace',
            namespace,
            '--output',
            'json',
          ]),
          'TENANT_CUTOVER_PROOF_OWNER_SECRET_CREATE_FAILED',
        );
        const metadata = jsonRecord(
          observed.metadata,
          'TENANT_CUTOVER_PROOF_OWNER_SECRET_CREATE_FAILED',
        );
        if (
          observed.apiVersion !== 'v1' ||
          observed.kind !== 'Secret' ||
          observed.type !== 'Opaque' ||
          observed.immutable !== true ||
          metadata.name !== targetName ||
          metadata.namespace !== namespace ||
          Object.hasOwn(metadata, 'deletionTimestamp') ||
          canonicalBootstrapJson(metadata.labels) !==
            canonicalBootstrapJson({
              'commander.io/tenant-authority-proof-owner': 'true',
            }) ||
          canonicalBootstrapJson(observed.data) !== canonicalBootstrapJson({ [sourceKey]: encoded })
        ) {
          fail('TENANT_CUTOVER_PROOF_OWNER_SECRET_CREATE_FAILED');
        }
      },
      cleanupProofResources: async (namespace, release) => {
        const selector = proofResourceSelector(release);
        for (const resource of ['job', 'pod']) {
          await command('kubectl', [
            'delete',
            resource,
            '--selector',
            selector,
            '--namespace',
            namespace,
            '--ignore-not-found=true',
            '--wait=true',
          ]);
        }
        const remaining = (
          await command('kubectl', [
            'get',
            'jobs,pods',
            '--selector',
            selector,
            '--namespace',
            namespace,
            '--ignore-not-found=true',
            '--output',
            'name',
          ])
        ).trim();
        if (remaining) fail('TENANT_CUTOVER_PROOF_RESOURCE_CLEANUP_FAILED');
      },
      captureProofHookFailureDiagnostic: async (namespace, release) => {
        const selector = proofResourceSelector(release);
        let proofJobName: string | undefined;
        try {
          const names = (
            await command('kubectl', [
              'get',
              'jobs',
              '--selector',
              selector,
              '--namespace',
              namespace,
              '--output',
              'jsonpath={.items[*].metadata.name}',
            ])
          )
            .trim()
            .split(/\s+/)
            .filter((name) => NAME.test(name) && /-tenant-cutover-prove-r[1-9][0-9]*$/.test(name));
          if (names.length === 1) proofJobName = names[0];
        } catch {
          return ownerJobFailureDiagnostic(
            'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE',
            'kubectl_logs_unavailable',
          );
        }
        if (!proofJobName) {
          return ownerJobFailureDiagnostic(
            'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE',
            'kubectl_logs_unavailable',
          );
        }
        try {
          const logs = await command('kubectl', [
            'logs',
            'job/' + proofJobName,
            '--namespace',
            namespace,
            '--tail=40',
          ]);
          return ownerJobFailureDiagnostic(logs);
        } catch {
          return ownerJobFailureDiagnostic(
            'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE',
            'kubectl_logs_unavailable',
          );
        }
      },
      prepareReleaseProjectionConfigMap: (request) =>
        prepareReleaseProjectionConfigMap(command, request),
      runProofJob: async (request) => {
        if (
          !NAME.test(request.name) ||
          request.name.length > 63 ||
          !/^[1-9][0-9]*$/.test(request.revision) ||
          !request.name.endsWith(`-tenant-cutover-prove-r${request.revision}`)
        ) {
          fail('TENANT_CUTOVER_PROOF_JOB_INVALID');
        }
        const created = (
          await command(
            'kubectl',
            ['create', '--filename', '-', '--namespace', request.namespace, '--output', 'name'],
            request.manifest,
          )
        ).trim();
        if (created !== 'job.batch/' + request.name) {
          fail('TENANT_CUTOVER_PROOF_JOB_CREATE_FAILED');
        }
        const proofJob = 'job/' + request.name;
        try {
          await command(
            'kubectl',
            [
              'wait',
              '--for=condition=complete',
              proofJob,
              '--namespace',
              request.namespace,
              '--timeout=10m',
            ],
            undefined,
            'proof_job_wait',
          );
        } catch {
          let logs = 'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE';
          let logTransport: 'kubectl_logs' | 'kubectl_logs_unavailable' =
            'kubectl_logs_unavailable';
          try {
            logs = await command('kubectl', [
              'logs',
              proofJob,
              '--namespace',
              request.namespace,
              '--tail=40',
            ]);
            logTransport = 'kubectl_logs';
          } catch {
            logs = 'TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE';
          }
          fail('TENANT_CUTOVER_PROOF_JOB_FAILED:' + ownerJobFailureDiagnostic(logs, logTransport));
        }
        const output = (
          await command('kubectl', [
            'logs',
            `job/${request.name}`,
            '--namespace',
            request.namespace,
          ])
        ).trim();
        try {
          return JSON.parse(output) as unknown;
        } catch {
          return fail('TENANT_CUTOVER_PROOF_RECEIPT_INVALID');
        }
      },
      deleteAndVerifyConfigMap: (namespace, name) =>
        deleteReleaseProjectionConfigMap(command, namespace, name),
      deleteAndVerifySecret: async (namespace, name) => {
        await command('kubectl', [
          'delete',
          'secret',
          name,
          '--namespace',
          namespace,
          '--ignore-not-found=true',
          '--wait=true',
        ]);
        const remaining = (
          await command('kubectl', [
            'get',
            'secret',
            name,
            '--namespace',
            namespace,
            '--ignore-not-found=true',
            '--output',
            'name',
          ])
        ).trim();
        if (remaining) fail('TENANT_CUTOVER_PROOF_OWNER_SECRET_CLEANUP_FAILED');
      },
      verifyCurrentObject: async (object) => {
        await assertKubernetesVersion();
        const live = await readLiveObject(object.identity);
        if (!live) fail('TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH');
        helmOwnership(live);
        if (object.identity.kind === 'Secret') {
          assertSecretMatches(object, live, retainedSecrets);
          return;
        }
        const desired = desiredObject(object);
        const manager = 'commander-restore-' + process.pid + '-' + randomBytes(12).toString('hex');
        const dryRun = parseJsonObject(
          await command(
            'kubectl',
            [
              'apply',
              '--server-side',
              '--dry-run=server',
              '--validate=strict',
              '--force-conflicts',
              '--field-manager=' + manager,
              '--filename',
              '-',
              '--output',
              'json',
              '--show-managed-fields=true',
            ],
            canonicalBootstrapJson(desired),
          ),
          'TENANT_CUTOVER_RESTORE_DRY_RUN_INVALID',
        );
        assertObjectIdentity(dryRun, object.identity);
        assertManagedFieldsMatch(ownedFields(dryRun, manager), dryRun, live);
      },
      readObject: async (identity) => {
        await assertKubernetesVersion();
        const object = await readLiveObject(identity);
        if (!object) return undefined;
        const metadata = jsonRecord(object.metadata, 'TENANT_CUTOVER_RESTORE_OBJECT_INVALID');
        const ownership = helmOwnership(object);
        if (
          typeof metadata.uid !== 'string' ||
          !metadata.uid ||
          typeof metadata.resourceVersion !== 'string' ||
          !metadata.resourceVersion
        ) {
          fail('TENANT_CUTOVER_RESTORE_OBJECT_OWNER_INVALID');
        }
        return {
          uid: metadata.uid,
          resourceVersion: metadata.resourceVersion,
          ...ownership,
        };
      },
      deleteObject: async (identity, preconditions) => {
        if (!preconditions.uid || !preconditions.resourceVersion) {
          fail('TENANT_CUTOVER_RESTORE_OBJECT_PRECONDITION_INVALID');
        }
        await assertKubernetesVersion();
        const discovery = parseJsonObject(
          await command('kubectl', ['get', '--raw', apiDiscoveryPath(identity.apiVersion)]),
          'TENANT_CUTOVER_RESTORE_API_DISCOVERY_INVALID',
        );
        if (discovery.groupVersion !== identity.apiVersion || !Array.isArray(discovery.resources)) {
          fail('TENANT_CUTOVER_RESTORE_API_DISCOVERY_INVALID');
        }
        const matches = discovery.resources.filter(
          (value) =>
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as JsonRecord).kind === identity.kind &&
            typeof (value as JsonRecord).name === 'string' &&
            !(value as JsonRecord).name!.toString().includes('/') &&
            typeof (value as JsonRecord).namespaced === 'boolean' &&
            Array.isArray((value as JsonRecord).verbs) &&
            ((value as JsonRecord).verbs as unknown[]).includes('delete'),
        ) as JsonRecord[];
        if (
          matches.length !== 1 ||
          (matches[0]!.namespaced === true) !== Boolean(identity.namespace)
        ) {
          fail('TENANT_CUTOVER_RESTORE_API_DISCOVERY_INVALID');
        }
        const path = deletionPath(
          identity,
          matches[0]!.name as string,
          matches[0]!.namespaced as boolean,
        );
        await command(
          'kubectl',
          ['delete', '--raw', path, '--filename', '-'],
          canonicalBootstrapJson({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions,
          }),
        );
      },
    },
  };
}

async function main(): Promise<void> {
  const request = parseHelmTenantCutoverArgs(process.argv.slice(2), process.cwd());
  const result = await runHelmTenantCutover(request, createNodePorts());
  process.stdout.write(
    canonicalBootstrapJson({
      action: result.action,
      operationVersion: result.operation.operationVersion,
    }) + '\n',
  );
}

if (process.argv[1]?.match(/helm-tenant-cutover\.(?:ts|js)$/)) {
  const invocation = process.argv.slice(2);
  const run =
    invocation[0] === '--tenant-cutover-post-render'
      ? () => {
          const renderer = parsePostRendererInvocation(invocation);
          return postRendererMain(renderer.socketPath, renderer.token);
        }
      : main;
  run().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'TENANT_CUTOVER_FAILED') + '\n');
    process.exitCode = 1;
  });
}
function revisionHookName(release: string, kind: 'migration' | 'proof', revision: string): string {
  const suffix =
    kind === 'migration' ? '-migration-r' + revision : '-tenant-cutover-prove-r' + revision;
  return release.slice(0, 63 - suffix.length).replace(/-$/, '') + suffix;
}

export function projectPostRenderedHelmReleaseRevision(input: {
  namespace: string;
  releaseName: string;
  revision: string;
  projectionConfigMapName: string;
  manifest: string;
  hookManifest: string;
  values: string;
}): HelmReleaseProjection {
  const combined = mergePostRenderedHelmHooks(input);
  return projectHelmReleaseRevision({
    namespace: input.namespace,
    releaseName: input.releaseName,
    revision: input.revision,
    manifest: combined,
    values: input.values,
  });
}

function mergePostRenderedHelmHooks(input: {
  namespace: string;
  releaseName: string;
  revision: string;
  projectionConfigMapName: string;
  manifest: string;
  hookManifest: string;
}): string {
  if (
    !input.namespace ||
    !input.releaseName ||
    !/^[1-9][0-9]*$/.test(input.revision) ||
    !NAME.test(input.projectionConfigMapName) ||
    input.projectionConfigMapName.length > 63
  ) {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  const documents: JsonRecord[] = [];
  try {
    loadAll(input.hookManifest, (document) => {
      if (document === undefined || document === null) return;
      const object = jsonRecord(document, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const metadata = jsonRecord(object.metadata, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      if (
        object.apiVersion !== 'batch/v1' ||
        object.kind !== 'Job' ||
        (metadata.namespace !== undefined && metadata.namespace !== input.namespace)
      ) {
        fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      }
      documents.push(object);
    });
  } catch {
    fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
  }
  if (documents.length !== 2) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');

  const allowed = new Map([
    [revisionHookName(input.releaseName, 'migration', '1'), 'migration'],
    [revisionHookName(input.releaseName, 'proof', '1'), 'proof'],
  ] as const);
  const hooks: JsonRecord[] = [];
  for (const hook of documents) {
    const metadata = jsonRecord(hook.metadata, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
    const sourceName = metadata.name;
    if (typeof sourceName !== 'string') fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
    const kind = allowed.get(sourceName);
    if (!kind) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
    allowed.delete(sourceName);
    const targetName = revisionHookName(input.releaseName, kind, input.revision);
    metadata.name = targetName;
    metadata.namespace = input.namespace;
    const annotations = jsonRecord(
      metadata.annotations,
      'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID',
    );
    const hookEvents = annotations['helm.sh/hook'];
    const expectedEvents =
      kind === 'migration' ? 'pre-install,pre-upgrade,pre-rollback' : 'post-install,post-upgrade';
    const expectedWeight = kind === 'migration' ? '-10' : '10';
    if (hookEvents === undefined && kind === 'migration') {
      let ordinaryMigration = false;
      try {
        loadAll(input.manifest, (document) => {
          if (!document || typeof document !== 'object' || Array.isArray(document)) return;
          const object = document as JsonRecord;
          const objectMetadata = jsonRecord(
            object.metadata,
            'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID',
          );
          if (
            object.apiVersion === 'batch/v1' &&
            object.kind === 'Job' &&
            objectMetadata.name === targetName
          ) {
            ordinaryMigration = true;
          }
        });
      } catch {
        fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      }
      if (
        !ordinaryMigration ||
        annotations['helm.sh/hook-weight'] !== undefined ||
        annotations['helm.sh/hook-delete-policy'] !== 'before-hook-creation,hook-succeeded'
      ) {
        fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      }
      continue;
    }
    if (
      hookEvents !== expectedEvents ||
      annotations['helm.sh/hook-weight'] !== expectedWeight ||
      annotations['helm.sh/hook-delete-policy'] !== 'before-hook-creation,hook-succeeded'
    ) {
      fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
    }
    if (kind === 'proof') {
      const spec = jsonRecord(hook.spec, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const template = jsonRecord(spec.template, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const podSpec = jsonRecord(template.spec, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const volumes = Array.isArray(podSpec.volumes)
        ? podSpec.volumes.map((value) =>
            jsonRecord(value, 'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID'),
          )
        : [];
      const projectionVolumes = volumes.filter((value) => value.name === 'release-projection');
      if (projectionVolumes.length !== 1) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      const configMap = jsonRecord(
        projectionVolumes[0]!.configMap,
        'TENANT_CUTOVER_RELEASE_PROJECTION_INVALID',
      );
      if (configMap.name !== input.projectionConfigMapName) {
        fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');
      }
    }
    hooks.push(hook);
  }
  if (allowed.size !== 0) fail('TENANT_CUTOVER_RELEASE_PROJECTION_INVALID');

  const combined = [
    input.manifest.trimEnd(),
    ...hooks.map((hook) =>
      dump(hook, {
        noRefs: true,
        lineWidth: -1,
      }).trimEnd(),
    ),
  ]
    .filter(Boolean)
    .join('\n---\n');
  assertProjectionConsumer(
    combined,
    input.releaseName,
    input.revision,
    input.projectionConfigMapName,
  );
  return combined;
}
