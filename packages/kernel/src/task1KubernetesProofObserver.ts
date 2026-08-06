import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import { createHash } from 'node:crypto';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';
import type { Task1AuthoritativePlatformFacts } from './task1RolloutProof.js';

type JsonRecord = Record<string, unknown>;

const AUDIENCE = 'commander-tenant-cutover-proof/v1';
const PROOF_PATH = '/ready/tenant-authority/v1';
const PROOF_PORT_NAME = 'tenant-proof';
const PROOF_TOKEN_VOLUME = 'proof-api-token';
const PROOF_TOKEN_MOUNT = '/var/run/secrets/commander.io/proof-api';
const PROOF_TOKEN_PATH = 'token';
const KUBERNETES_CA_PATH = 'ca.crt';
const PROOF_WINDOW_SECONDS = 5 * 60;
const SHA256 = /^[0-9a-f]{64}$/;
const KUBERNETES_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_KEY = /^[A-Za-z0-9._-]+$/;

interface ProofPodContract {
  apiProof: { secretName: string; caKey: string; certKey: string };
  databaseCa: { secretName: string; caKey: string };
  expectedServerSpkiSha256: string;
  imagePullPolicy: string;
  ownerSecret: { name: string; key: string };
  podSecurityContext: JsonRecord;
  terminationGracePeriodSeconds: number;
}

export interface Task1ProjectedTokenIdentity {
  audience: string;
  expiresAt: string;
  namespace: string;
  serviceAccountName: string;
  podName: string;
  podUid: string;
}

export interface Task1KubernetesProofReadRequest {
  resource: 'service' | 'deployment' | 'replicaSets' | 'pods';
  namespace: string;
  name?: string;
  selector?: Readonly<Record<string, string>>;
  audience: typeof AUDIENCE;
}

export interface Task1KubernetesProofApi {
  read(request: Task1KubernetesProofReadRequest): Promise<unknown>;
}

export interface Task1KubernetesProofObserverOptions {
  api: Task1KubernetesProofApi;
  readProjectedTokenIdentity(): Promise<Task1ProjectedTokenIdentity>;
  readReleaseProjection(): Promise<unknown>;
  now?: () => Date;
}

function invalid(): never {
  throw new Error('TENANT_CUTOVER_KUBERNETES_PROOF_INVALID');
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}

function integer(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0))
    invalid();
  return Number(value);
}

function field(value: unknown, name: string): unknown {
  return record(value)[name];
}

function labels(metadata: unknown): JsonRecord {
  return record(field(metadata, 'labels'));
}

function annotation(metadata: unknown, name: string): string {
  return string(record(field(metadata, 'annotations'))[name]);
}

function oneNamed(value: unknown, name: string): JsonRecord {
  const matches = array(value)
    .map(record)
    .filter((candidate) => candidate.name === name);
  if (matches.length !== 1) invalid();
  return matches[0]!;
}

function exactNamedObjects(
  value: unknown,
  expectedNames: readonly string[],
): Map<string, JsonRecord> {
  const objects = array(value).map(record);
  const result = new Map<string, JsonRecord>();
  for (const object of objects) {
    const name = string(object.name);
    if (result.has(name)) invalid();
    result.set(name, object);
  }
  if (result.size !== expectedNames.length || expectedNames.some((name) => !result.has(name))) {
    invalid();
  }
  return result;
}

function exactSelector(value: unknown, expected: Readonly<Record<string, string>>): void {
  if (canonicalBootstrapJson(record(value)) !== canonicalBootstrapJson(expected)) invalid();
}

function exactJson(value: unknown, expected: unknown): void {
  if (canonicalBootstrapJson(value) !== canonicalBootstrapJson(expected)) invalid();
}

function kubernetesName(value: unknown): string {
  const result = string(value);
  if (!KUBERNETES_NAME.test(result)) invalid();
  return result;
}

function secretKey(value: unknown): string {
  const result = string(value);
  if (!SECRET_KEY.test(result)) invalid();
  return result;
}

function requiredLabels(metadata: unknown, expected: Readonly<Record<string, string>>): void {
  const actual = labels(metadata);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) invalid();
  }
}

function controllerOwner(
  metadata: JsonRecord,
  expected: {
    kind: string;
    name?: string;
    uid?: string;
  },
): { kind: string; name: string; uid: string } {
  const controllers = array(metadata.ownerReferences)
    .map(record)
    .filter((owner) => owner.controller === true);
  if (controllers.length !== 1) invalid();
  const owner = controllers[0]!;
  const result = { kind: string(owner.kind), name: string(owner.name), uid: string(owner.uid) };
  if (
    result.kind !== expected.kind ||
    (expected.name !== undefined && result.name !== expected.name) ||
    (expected.uid !== undefined && result.uid !== expected.uid)
  )
    invalid();
  return result;
}

function parseBinding(operation: Task1LifecycleOperation): {
  namespace: string;
  releaseName: string;
  chartContentSha256: string;
  apiImageDigest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.requestedBindingJcs);
  } catch {
    return invalid();
  }
  const binding = record(parsed);
  if (
    operation.platformKind !== 'helm' ||
    binding.kind !== 'helm' ||
    binding.phase !== operation.runtimePhase ||
    typeof binding.namespace !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(binding.namespace) ||
    typeof binding.releaseName !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(binding.releaseName) ||
    typeof binding.chartContentSha256 !== 'string' ||
    !SHA256.test(binding.chartContentSha256) ||
    typeof binding.apiImageDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.apiImageDigest) ||
    canonicalBootstrapJson(binding) !== operation.requestedBindingJcs ||
    canonicalBootstrapSha256(binding) !== operation.requestedBindingSha256
  )
    invalid();
  return binding as unknown as {
    namespace: string;
    releaseName: string;
    chartContentSha256: string;
    apiImageDigest: string;
  };
}

function validateRuntimeAnnotations(
  metadata: JsonRecord,
  operation: Task1LifecycleOperation,
  imageDigest: string,
): void {
  if (
    annotation(metadata, 'commander.io/tenant-context-aware') !== 'true' ||
    annotation(metadata, 'commander.io/tenant-authority-phase') !== operation.runtimePhase ||
    annotation(metadata, 'commander.io/tenant-authority-image-digest') !== imageDigest ||
    annotation(metadata, 'commander.io/tenant-authority-configuration-sha256') !==
      operation.requestedConfigurationSha256
  )
    invalid();
}

function validateApiContainer(
  templateSpec: JsonRecord,
  operation: Task1LifecycleOperation,
  imageDigest: string,
  proofPort: number,
): void {
  const container = oneNamed(templateSpec.containers, 'api');
  if (!string(container.image).endsWith(`@${imageDigest}`)) invalid();
  const env = array(container.env).map(record);
  const exactEnv = (name: string, expected: string): void => {
    const matches = env.filter((entry) => entry.name === name);
    if (
      matches.length !== 1 ||
      matches[0]!.value !== expected ||
      Object.hasOwn(matches[0]!, 'valueFrom')
    ) {
      invalid();
    }
  };
  exactEnv('COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST', imageDigest);
  exactEnv(
    'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256',
    operation.requestedConfigurationSha256,
  );
  exactEnv('COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE', operation.runtimePhase);
  const port = oneNamed(container.ports, PROOF_PORT_NAME);
  if (port.protocol !== 'TCP' || port.containerPort !== proofPort) invalid();
  const httpGet = record(field(field(container, 'readinessProbe'), 'httpGet'));
  if (httpGet.scheme !== 'HTTPS' || httpGet.path !== PROOF_PATH || httpGet.port !== PROOF_PORT_NAME)
    invalid();
}

function conditionTrue(conditions: unknown, type: string): boolean {
  return array(conditions)
    .map(record)
    .some((condition) => condition.type === type && condition.status === 'True');
}

function projectedTokenVolume(podSpec: JsonRecord, proofContainer: JsonRecord): void {
  if (podSpec.automountServiceAccountToken !== false) invalid();
  const candidates: Array<{ volumeName: string; expirationSeconds: number }> = [];
  for (const volume of array(podSpec.volumes).map(record)) {
    if (!volume.projected) continue;
    const projected = record(volume.projected);
    const sources = array(field(projected, 'sources')).map(record);
    for (const source of sources) {
      if (!source.serviceAccountToken) continue;
      const token = record(source.serviceAccountToken);
      if (token.audience !== AUDIENCE || token.path !== PROOF_TOKEN_PATH) invalid();
      const expirationSeconds = integer(token.expirationSeconds);
      if (expirationSeconds > PROOF_WINDOW_SECONDS) invalid();
      candidates.push({ volumeName: string(volume.name), expirationSeconds });
    }
    if (volume.name === PROOF_TOKEN_VOLUME) {
      const caSources = sources.filter((source) => source.configMap !== undefined);
      if (projected.defaultMode !== 0o400 || sources.length !== 2 || caSources.length !== 1)
        invalid();
      const configMap = record(caSources[0]!.configMap);
      const items = array(configMap.items).map(record);
      if (
        configMap.name !== 'kube-root-ca.crt' ||
        items.length !== 1 ||
        items[0]!.key !== 'ca.crt' ||
        items[0]!.path !== KUBERNETES_CA_PATH
      )
        invalid();
    }
  }
  if (candidates.length !== 1 || candidates[0]!.volumeName !== PROOF_TOKEN_VOLUME) invalid();
  const mounts = array(proofContainer.volumeMounts)
    .map(record)
    .filter((mount) => mount.name === candidates[0]!.volumeName);
  if (
    mounts.length !== 1 ||
    mounts[0]!.readOnly !== true ||
    mounts[0]!.mountPath !== PROOF_TOKEN_MOUNT ||
    Object.hasOwn(mounts[0]!, 'subPath') ||
    Object.hasOwn(mounts[0]!, 'subPathExpr')
  )
    invalid();
}

function releaseProjectionVolume(
  podSpec: JsonRecord,
  proofContainer: JsonRecord,
  releaseName: string,
  operationVersion: string,
  revision: string,
): void {
  const expectedName = projectionConfigMapName(releaseName, operationVersion, revision);
  const volumes = array(podSpec.volumes)
    .map(record)
    .filter((volume) => volume.name === 'release-projection');
  const mounts = array(proofContainer.volumeMounts)
    .map(record)
    .filter((mount) => mount.name === 'release-projection');
  if (volumes.length !== 1 || mounts.length !== 1) invalid();
  const configMap = record(volumes[0]!.configMap);
  const items = array(configMap.items).map(record);
  if (
    configMap.name !== expectedName ||
    configMap.defaultMode !== 0o444 ||
    configMap.optional === true ||
    items.length !== 1 ||
    items[0]!.key !== 'projection.json' ||
    items[0]!.path !== 'projection.json' ||
    mounts[0]!.mountPath !== '/run/commander/release-projection' ||
    mounts[0]!.readOnly !== true ||
    Object.hasOwn(mounts[0]!, 'subPath') ||
    Object.hasOwn(mounts[0]!, 'subPathExpr')
  )
    invalid();
}

function proofReaderServiceAccount(namespace: string, releaseName: string): string {
  const suffix = createHash('sha256')
    .update(`${namespace}/${releaseName}`)
    .digest('hex')
    .slice(0, 16);
  return `commander-proof-reader-${suffix}`;
}

function releaseScopedName(releaseName: string, suffix: string): string {
  if (suffix.length >= 63) invalid();
  const result = `${releaseName.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
  return kubernetesName(result);
}

function proofOwnerSecretName(releaseName: string, operationVersion: string): string {
  if (!/^[1-9][0-9]*$/.test(operationVersion)) invalid();
  return releaseScopedName(releaseName, `-proof-owner-v${operationVersion}`);
}

function projectionConfigMapName(
  releaseName: string,
  operationVersion: string,
  revision: string,
): string {
  if (!/^[1-9][0-9]*$/.test(operationVersion) || !/^[1-9][0-9]*$/.test(revision)) invalid();
  return releaseScopedName(releaseName, `-proof-projection-v${operationVersion}-r${revision}`);
}

function proofPodContract(
  projection: JsonRecord,
  operation: Task1LifecycleOperation,
  releaseName: string,
  revision: string,
): ProofPodContract {
  const values = record(field(field(projection, 'rendererInput'), 'values'));
  const image = record(values.image);
  const database = record(values.database);
  const postgres = record(database.postgres);
  const databaseTls = record(values.databaseTls);
  const migration = record(values.migration);
  const tenantAuthority = record(values.tenantAuthority);
  const apiProof = record(tenantAuthority.apiProof);
  const podSecurityContext = record(values.podSecurityContext);
  const seccompProfile = record(podSecurityContext.seccompProfile);
  if (
    database.enabled !== true ||
    database.backend !== 'postgres' ||
    typeof postgres.bundled !== 'boolean' ||
    !['Always', 'IfNotPresent', 'Never'].includes(String(image.pullPolicy)) ||
    !SHA256.test(String(databaseTls.expectedServerSpkiSha256)) ||
    integer(migration.activeDeadlineSeconds) <= 0 ||
    integer(migration.ttlSecondsAfterFinished, true) < 0 ||
    podSecurityContext.runAsNonRoot !== true ||
    seccompProfile.type !== 'RuntimeDefault'
  ) {
    invalid();
  }
  if (postgres.bundled ? databaseTls.caSecret !== '' : databaseTls.existingSecret !== '') {
    invalid();
  }
  integer(podSecurityContext.runAsUser);
  integer(podSecurityContext.runAsGroup);
  integer(podSecurityContext.fsGroup);
  exactJson(Object.keys(podSecurityContext).sort(), [
    'fsGroup',
    'runAsGroup',
    'runAsNonRoot',
    'runAsUser',
    'seccompProfile',
  ]);
  exactJson(seccompProfile, { type: 'RuntimeDefault' });

  const ownerSecretName = proofOwnerSecretName(releaseName, operation.operationVersion);
  if (
    tenantAuthority.proofOwnerSecret !== ownerSecretName ||
    tenantAuthority.releaseProjectionConfigMap !==
      projectionConfigMapName(releaseName, operation.operationVersion, revision)
  ) {
    invalid();
  }
  return {
    apiProof: {
      secretName: kubernetesName(apiProof.publicSecret),
      caKey: secretKey(apiProof.caKey),
      certKey: secretKey(apiProof.certKey),
    },
    databaseCa: {
      secretName: kubernetesName(
        postgres.bundled ? databaseTls.existingSecret : databaseTls.caSecret,
      ),
      caKey: secretKey(databaseTls.caKey),
    },
    expectedServerSpkiSha256: string(databaseTls.expectedServerSpkiSha256),
    imagePullPolicy: string(image.pullPolicy),
    ownerSecret: { name: ownerSecretName, key: secretKey(postgres.ownerSecretKey) },
    podSecurityContext,
    terminationGracePeriodSeconds: integer(migration.terminationGracePeriodSeconds),
  };
}

function exactEnvironment(container: JsonRecord, contract: ProofPodContract): void {
  const environment = exactNamedObjects(container.env, [
    'COMMANDER_KUBERNETES_PROOF_RUNTIME',
    'COMMANDER_OWNER_DATABASE_URL',
    'COMMANDER_DATABASE_TLS_CA_FILE',
    'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
    'COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE',
  ]);
  exactJson(environment.get('COMMANDER_KUBERNETES_PROOF_RUNTIME'), {
    name: 'COMMANDER_KUBERNETES_PROOF_RUNTIME',
    value: '1',
  });
  exactJson(environment.get('COMMANDER_OWNER_DATABASE_URL'), {
    name: 'COMMANDER_OWNER_DATABASE_URL',
    valueFrom: {
      secretKeyRef: contract.ownerSecret,
    },
  });
  exactJson(environment.get('COMMANDER_DATABASE_TLS_CA_FILE'), {
    name: 'COMMANDER_DATABASE_TLS_CA_FILE',
    value: '/run/commander/database-tls/ca.crt',
  });
  exactJson(environment.get('COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256'), {
    name: 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
    value: contract.expectedServerSpkiSha256,
  });
  exactJson(environment.get('COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE'), {
    name: 'COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE',
    value: '/run/commander/api-proof-public/ca.crt',
  });
}

function exactSecretVolume(
  volume: JsonRecord,
  expected: { secretName: string; items: readonly { key: string; path: string }[] },
): void {
  const secret = record(volume.secret);
  if (
    canonicalBootstrapJson(Object.keys(volume).sort()) !==
      canonicalBootstrapJson(['name', 'secret']) ||
    ![
      canonicalBootstrapJson(['items', 'secretName']),
      canonicalBootstrapJson(['defaultMode', 'items', 'secretName']),
      canonicalBootstrapJson(['items', 'optional', 'secretName']),
      canonicalBootstrapJson(['defaultMode', 'items', 'optional', 'secretName']),
    ].includes(canonicalBootstrapJson(Object.keys(secret).sort())) ||
    secret.secretName !== expected.secretName ||
    (secret.defaultMode !== undefined && secret.defaultMode !== 0o644) ||
    (secret.optional !== undefined && secret.optional !== false)
  ) {
    invalid();
  }
  const actualItems = array(secret.items)
    .map(record)
    .sort((left, right) => string(left.path).localeCompare(string(right.path)));
  const expectedItems = [...expected.items].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  exactJson(actualItems, expectedItems);
}

function exactMount(
  mounts: ReadonlyMap<string, JsonRecord>,
  name: string,
  mountPath: string,
  readOnly: boolean,
): void {
  const mount = mounts.get(name)!;
  if (
    ![
      canonicalBootstrapJson(['mountPath', 'name']),
      canonicalBootstrapJson(['mountPath', 'name', 'readOnly']),
    ].includes(canonicalBootstrapJson(Object.keys(mount).sort())) ||
    mount.mountPath !== mountPath ||
    (readOnly
      ? mount.readOnly !== true
      : mount.readOnly !== undefined && mount.readOnly !== false) ||
    Object.hasOwn(mount, 'subPath') ||
    Object.hasOwn(mount, 'subPathExpr')
  ) {
    invalid();
  }
}

function validateProofPodContract(
  podSpec: JsonRecord,
  container: JsonRecord,
  volumes: ReadonlyMap<string, JsonRecord>,
  mounts: ReadonlyMap<string, JsonRecord>,
  contract: ProofPodContract,
): void {
  if (
    podSpec.restartPolicy !== 'Never' ||
    podSpec.activeDeadlineSeconds !== undefined ||
    podSpec.terminationGracePeriodSeconds !== contract.terminationGracePeriodSeconds ||
    container.imagePullPolicy !== contract.imagePullPolicy ||
    (podSpec.ephemeralContainers !== undefined &&
      array(podSpec.ephemeralContainers).length !== 0) ||
    podSpec.hostNetwork === true ||
    podSpec.hostPID === true ||
    podSpec.hostIPC === true ||
    podSpec.shareProcessNamespace === true ||
    container.args !== undefined ||
    (container.envFrom !== undefined && array(container.envFrom).length !== 0) ||
    container.stdin === true ||
    container.tty === true
  ) {
    invalid();
  }
  exactJson(podSpec.securityContext, contract.podSecurityContext);
  exactJson(container.command, ['node', 'packages/kernel/dist/migrate.js', 'tenant-cutover-prove']);
  exactJson(container.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  });
  exactEnvironment(container, contract);
  exactSecretVolume(volumes.get('database-public-ca')!, {
    secretName: contract.databaseCa.secretName,
    items: [{ key: contract.databaseCa.caKey, path: 'ca.crt' }],
  });
  exactSecretVolume(volumes.get('api-proof-public')!, {
    secretName: contract.apiProof.secretName,
    items: [
      { key: contract.apiProof.caKey, path: 'ca.crt' },
      { key: contract.apiProof.certKey, path: 'tls.crt' },
    ],
  });
  exactJson(record(volumes.get('tmp')!.emptyDir), {});
  exactMount(mounts, 'database-public-ca', '/run/commander/database-tls', true);
  exactMount(mounts, 'api-proof-public', '/run/commander/api-proof-public', true);
  exactMount(mounts, 'tmp', '/tmp', false);
}

function validateProofJobName(releaseName: string, jobName: string): string {
  const match = /-tenant-cutover-prove-r([1-9][0-9]*)$/.exec(jobName);
  if (!match) invalid();
  const suffix = match[0];
  const expected = `${releaseName.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
  if (jobName !== expected) invalid();
  return match[1]!;
}

function validateReleaseProjection(
  value: unknown,
  binding: {
    namespace: string;
    releaseName: string;
    chartContentSha256: string;
  },
): JsonRecord {
  const projection = record(value);
  const keys = Object.keys(projection).sort();
  const expectedKeys = [
    'chartContentSha256',
    'format',
    'hooks',
    'namespace',
    'objects',
    'releaseName',
    'rendererInput',
    'revision',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    projection.format !== 'helm-release-projection/v1' ||
    projection.namespace !== binding.namespace ||
    projection.releaseName !== binding.releaseName ||
    projection.chartContentSha256 !== binding.chartContentSha256 ||
    typeof projection.revision !== 'string' ||
    !/^[1-9][0-9]*$/.test(projection.revision) ||
    !Array.isArray(projection.objects) ||
    !Array.isArray(projection.hooks)
  ) {
    invalid();
  }
  const renderer = record(projection.rendererInput);
  if (
    canonicalBootstrapJson(Object.keys(renderer).sort()) !==
      canonicalBootstrapJson(['format', 'secretReferences', 'values']) ||
    renderer.format !== 'helm-renderer-input-projection/v1' ||
    !renderer.values ||
    typeof renderer.values !== 'object' ||
    Array.isArray(renderer.values) ||
    !Array.isArray(renderer.secretReferences)
  ) {
    invalid();
  }
  const objectIdentities = new Set<string>();
  for (const item of projection.objects) {
    const object = record(item);
    const identity = record(object.identity);
    const comparator = record(object.comparator);
    if (
      comparator.format !== 'kubernetes-field-comparator/v1' ||
      !Array.isArray(object.secretReferences) ||
      typeof identity.apiVersion !== 'string' ||
      typeof identity.kind !== 'string' ||
      typeof identity.namespace !== 'string' ||
      typeof identity.name !== 'string'
    ) {
      invalid();
    }
    const key = canonicalBootstrapJson(identity);
    if (objectIdentities.has(key)) invalid();
    objectIdentities.add(key);
  }
  const hookIdentities = new Set<string>();
  let proofHookCount = 0;
  for (const item of projection.hooks) {
    const hook = record(item);
    if (
      canonicalBootstrapJson(Object.keys(hook).sort()) !==
        canonicalBootstrapJson(['deletePolicies', 'identity']) ||
      !Array.isArray(hook.deletePolicies)
    ) {
      invalid();
    }
    const identity = record(hook.identity);
    if (
      canonicalBootstrapJson(Object.keys(identity).sort()) !==
        canonicalBootstrapJson(['apiVersion', 'kind', 'name', 'namespace']) ||
      typeof identity.apiVersion !== 'string' ||
      typeof identity.kind !== 'string' ||
      typeof identity.namespace !== 'string' ||
      typeof identity.name !== 'string' ||
      !hook.deletePolicies.every((policy) =>
        ['before-hook-creation', 'hook-succeeded'].includes(String(policy)),
      ) ||
      new Set(hook.deletePolicies).size !== hook.deletePolicies.length
    ) {
      invalid();
    }
    const key = canonicalBootstrapJson(identity);
    if (hookIdentities.has(key)) invalid();
    hookIdentities.add(key);
    if (
      identity.apiVersion === 'batch/v1' &&
      identity.kind === 'Job' &&
      identity.namespace === binding.namespace &&
      identity.name ===
        `${binding.releaseName
          .slice(0, 63 - `-tenant-cutover-prove-r${projection.revision}`.length)
          .replace(/-$/, '')}-tenant-cutover-prove-r${projection.revision}`
    ) {
      if (
        canonicalBootstrapJson([...hook.deletePolicies].sort()) !==
        canonicalBootstrapJson(['before-hook-creation', 'hook-succeeded'])
      ) {
        invalid();
      }
      proofHookCount += 1;
    }
  }
  if (proofHookCount !== 1) invalid();
  return projection;
}

export function createTask1KubernetesProofObserver(
  options: Task1KubernetesProofObserverOptions,
): (operation: Task1LifecycleOperation) => Promise<Task1AuthoritativePlatformFacts> {
  return async (operation) => {
    const binding = parseBinding(operation);
    const now = (options.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) invalid();
    const identity = await options.readProjectedTokenIdentity();
    const expiresAt = Date.parse(identity.expiresAt);
    if (
      identity.audience !== AUDIENCE ||
      identity.namespace !== binding.namespace ||
      identity.serviceAccountName !==
        proofReaderServiceAccount(binding.namespace, binding.releaseName) ||
      !identity.podName ||
      !identity.podUid ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now.getTime() ||
      expiresAt > now.getTime() + PROOF_WINDOW_SECONDS * 1_000
    )
      invalid();

    const apiSelector = {
      'app.kubernetes.io/name': binding.releaseName,
      'app.kubernetes.io/instance': binding.releaseName,
      'app.kubernetes.io/component': 'api',
    } as const;
    const proofSelector = {
      'commander.io/tenant-authority-proof-reader': 'true',
      'commander.io/tenant-authority-proof-release': binding.releaseName,
    } as const;
    const request = (
      resource: Task1KubernetesProofReadRequest['resource'],
      extra: Pick<Task1KubernetesProofReadRequest, 'name' | 'selector'> = {},
    ) =>
      options.api.read({
        resource,
        namespace: binding.namespace,
        audience: AUDIENCE,
        ...extra,
      });
    const serviceName = `${binding.releaseName}-api-proof`;
    const deploymentName = `${binding.releaseName}-api`;
    const [
      serviceValue,
      deploymentValue,
      setsValue,
      apiPodsValue,
      proofPodsValue,
      releaseProjectionValue,
    ] = await Promise.all([
      request('service', { name: serviceName }),
      request('deployment', { name: deploymentName }),
      request('replicaSets', { selector: apiSelector }),
      request('pods', { selector: apiSelector }),
      request('pods', { selector: proofSelector }),
      options.readReleaseProjection(),
    ]);

    const service = record(serviceValue);
    const serviceMetadata = record(service.metadata);
    if (
      serviceMetadata.name !== serviceName ||
      serviceMetadata.namespace !== binding.namespace ||
      Object.hasOwn(serviceMetadata, 'deletionTimestamp')
    )
      invalid();
    requiredLabels(serviceMetadata, apiSelector);
    const serviceSpec = record(service.spec);
    exactSelector(serviceSpec.selector, apiSelector);
    const servicePorts = array(serviceSpec.ports).map(record);
    if (servicePorts.length !== 1) invalid();
    const servicePort = servicePorts[0]!;
    const proofPort = integer(servicePort.port);
    if (
      servicePort.name !== PROOF_PORT_NAME ||
      servicePort.protocol !== 'TCP' ||
      servicePort.targetPort !== proofPort
    )
      invalid();

    const deployment = record(deploymentValue);
    const deploymentMetadata = record(deployment.metadata);
    const deploymentUid = string(deploymentMetadata.uid);
    const generation = integer(deploymentMetadata.generation);
    if (
      deploymentMetadata.name !== deploymentName ||
      deploymentMetadata.namespace !== binding.namespace ||
      Object.hasOwn(deploymentMetadata, 'deletionTimestamp')
    )
      invalid();
    requiredLabels(deploymentMetadata, apiSelector);
    validateRuntimeAnnotations(deploymentMetadata, operation, binding.apiImageDigest);
    const deploymentSpec = record(deployment.spec);
    exactSelector(field(deploymentSpec.selector, 'matchLabels'), apiSelector);
    const desired = integer(deploymentSpec.replicas);
    const deploymentTemplate = record(deploymentSpec.template);
    requiredLabels(record(deploymentTemplate.metadata), apiSelector);
    validateRuntimeAnnotations(
      record(deploymentTemplate.metadata),
      operation,
      binding.apiImageDigest,
    );
    validateApiContainer(
      record(deploymentTemplate.spec),
      operation,
      binding.apiImageDigest,
      proofPort,
    );
    const deploymentStatus = record(deployment.status);
    if (
      integer(deploymentStatus.observedGeneration) !== generation ||
      integer(deploymentStatus.replicas) !== desired ||
      integer(deploymentStatus.readyReplicas) !== desired ||
      integer(deploymentStatus.updatedReplicas) !== desired ||
      integer(deploymentStatus.availableReplicas) !== desired ||
      integer(deploymentStatus.unavailableReplicas ?? 0, true) !== 0
    )
      invalid();

    const replicaSets = array(field(setsValue, 'items')).map(record);
    const activeSets = replicaSets.filter(
      (set) =>
        Number(record(set.spec).replicas ?? 0) > 0 || Number(record(set.status).replicas ?? 0) > 0,
    );
    if (activeSets.length !== 1) invalid();
    const activeSet = activeSets[0]!;
    const setMetadata = record(activeSet.metadata);
    const setUid = string(setMetadata.uid);
    controllerOwner(setMetadata, { kind: 'Deployment', name: deploymentName, uid: deploymentUid });
    if (
      setMetadata.namespace !== binding.namespace ||
      Object.hasOwn(setMetadata, 'deletionTimestamp')
    )
      invalid();
    const revision = annotation(setMetadata, 'deployment.kubernetes.io/revision');
    if (
      !/^[1-9][0-9]*$/.test(revision) ||
      annotation(deploymentMetadata, 'deployment.kubernetes.io/revision') !== revision
    )
      invalid();
    const setGeneration = integer(setMetadata.generation);
    const setStatus = record(activeSet.status);
    if (
      integer(setStatus.observedGeneration) !== setGeneration ||
      integer(setStatus.replicas) !== desired ||
      integer(setStatus.readyReplicas) !== desired ||
      integer(setStatus.availableReplicas) !== desired
    )
      invalid();
    const templateHash = string(labels(setMetadata)['pod-template-hash']);
    const podSelector = { ...apiSelector, 'pod-template-hash': templateHash };
    const setSpec = record(activeSet.spec);
    exactSelector(field(setSpec.selector, 'matchLabels'), podSelector);
    const setTemplate = record(setSpec.template);
    requiredLabels(record(setTemplate.metadata), podSelector);
    validateRuntimeAnnotations(record(setTemplate.metadata), operation, binding.apiImageDigest);
    validateApiContainer(record(setTemplate.spec), operation, binding.apiImageDigest, proofPort);

    const apiPods = array(field(apiPodsValue, 'items')).map(record);
    if (apiPods.length !== desired) invalid();
    const podNames = new Set<string>();
    const podUids = new Set<string>();
    const apiPodProjection = apiPods
      .map((pod) => {
        const metadata = record(pod.metadata);
        const name = string(metadata.name);
        const uid = string(metadata.uid);
        if (podNames.has(name) || podUids.has(uid) || Object.hasOwn(metadata, 'deletionTimestamp'))
          invalid();
        podNames.add(name);
        podUids.add(uid);
        if (metadata.namespace !== binding.namespace) invalid();
        requiredLabels(metadata, podSelector);
        controllerOwner(metadata, {
          kind: 'ReplicaSet',
          name: string(setMetadata.name),
          uid: setUid,
        });
        const status = record(pod.status);
        if (status.phase !== 'Running' || !conditionTrue(status.conditions, 'Ready')) invalid();
        const containerStatus = oneNamed(status.containerStatuses, 'api');
        if (
          containerStatus.ready !== true ||
          integer(containerStatus.restartCount, true) !== 0 ||
          !string(containerStatus.image).endsWith(`@${binding.apiImageDigest}`) ||
          !string(containerStatus.imageID).includes(binding.apiImageDigest)
        )
          invalid();
        return { name, uid, imageId: string(containerStatus.imageID) };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const proofPods = array(field(proofPodsValue, 'items')).map(record);
    if (proofPods.length !== 1) invalid();
    const proofPod = proofPods[0]!;
    const proofMetadata = record(proofPod.metadata);
    if (
      proofMetadata.name !== identity.podName ||
      proofMetadata.uid !== identity.podUid ||
      proofMetadata.namespace !== binding.namespace ||
      Object.hasOwn(proofMetadata, 'deletionTimestamp')
    )
      invalid();
    requiredLabels(proofMetadata, proofSelector);
    const proofController = controllerOwner(proofMetadata, { kind: 'Job' });
    const proofJobRevision = validateProofJobName(binding.releaseName, proofController.name);
    const proofSpec = record(proofPod.spec);
    if (
      proofSpec.serviceAccountName !==
      proofReaderServiceAccount(binding.namespace, binding.releaseName)
    )
      invalid();
    const proofContainers = exactNamedObjects(proofSpec.containers, ['tenant-cutover-prove']);
    if (proofSpec.initContainers !== undefined && array(proofSpec.initContainers).length !== 0) {
      invalid();
    }
    const proofContainer = proofContainers.get('tenant-cutover-prove')!;
    if (!string(proofContainer.image).endsWith(`@${binding.apiImageDigest}`)) invalid();
    const proofVolumes = exactNamedObjects(proofSpec.volumes, [
      'proof-api-token',
      'database-public-ca',
      'api-proof-public',
      'release-projection',
      'tmp',
    ]);
    const proofMounts = exactNamedObjects(proofContainer.volumeMounts, [
      'proof-api-token',
      'database-public-ca',
      'api-proof-public',
      'release-projection',
      'tmp',
    ]);
    projectedTokenVolume(proofSpec, proofContainer);
    const platformArtifact = validateReleaseProjection(releaseProjectionValue, binding);
    if (platformArtifact.revision !== proofJobRevision) invalid();
    const contract = proofPodContract(
      platformArtifact,
      operation,
      binding.releaseName,
      proofJobRevision,
    );
    validateProofPodContract(proofSpec, proofContainer, proofVolumes, proofMounts, contract);
    const proofStatus = record(proofPod.status);
    const proofContainerStatus = oneNamed(proofStatus.containerStatuses, 'tenant-cutover-prove');
    if (
      proofStatus.phase !== 'Running' ||
      !conditionTrue(proofStatus.conditions, 'Ready') ||
      proofContainerStatus.ready !== true ||
      integer(proofContainerStatus.restartCount, true) !== 0 ||
      !string(proofContainerStatus.image).endsWith(`@${binding.apiImageDigest}`) ||
      !string(proofContainerStatus.imageID).includes(binding.apiImageDigest)
    )
      invalid();

    releaseProjectionVolume(
      proofSpec,
      proofContainer,
      binding.releaseName,
      operation.operationVersion,
      proofJobRevision,
    );
    const templateSha256 = canonicalBootstrapSha256({
      deploymentTemplate,
      replicaSetTemplate: setTemplate,
    });
    return {
      topology: 'helm',
      apiProofUrl: `https://${serviceName}.${binding.namespace}.svc.cluster.local:${proofPort}${PROOF_PATH}`,
      platformArtifact,
      platformArtifactSha256: canonicalBootstrapSha256(platformArtifact),
      workload: {
        uid: deploymentUid,
        generation: String(generation),
        observedGeneration: String(generation),
        templateSha256,
        ready: apiPodProjection.map(({ name }) => name),
      },
      pinned: {
        chartContentSha256: binding.chartContentSha256,
        apiImageDigest: binding.apiImageDigest,
      },
      metadata: {
        specRevision: 27,
        evidenceLevel: 'live',
        writeOwner: 'commander_owner',
        publicationPoint: 'commander_tenant_cutover_rollout_proofs',
      },
    };
  };
}
