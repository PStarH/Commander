import { load, loadAll } from 'js-yaml';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import type {
  HelmReleaseObjectIdentity,
  HelmReleaseObjectProjection,
  HelmReleaseProjection,
} from './helm-recover-tenant-authority.js';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[1-9][0-9]*$/;
const SECRET_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLUSTER_SCOPED_KINDS = new Set([
  'APIService',
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'MutatingWebhookConfiguration',
  'Namespace',
  'Node',
  'PersistentVolume',
  'PriorityClass',
  'StorageClass',
  'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding',
  'ValidatingWebhookConfiguration',
]);

type JsonRecord = Record<string, unknown>;

const SECRET_REFERENCE_VALUE_PATHS = [
  /^\/adapterOps\/secrets\/existingSecret$/,
  /^\/api\/secrets\/(?:apiKeySecret|capabilityTokenKeySecret|existingSecret|integrityKeySecret|jwtSecretSecret|masterKeySecret)$/,
  /^\/capability\/existingSecret$/,
  /^\/database\/postgres\/existingSecret$/,
  /^\/databaseTls\/(?:caSecret|existingSecret)$/,
  /^\/ingress\/tls\/[0-9]+\/secretName$/,
  /^\/llm\/(?:anthropicApiKeySecret|googleApiKeySecret|openaiApiKeySecret)$/,
  /^\/tenantAuthority\/(?:bootstrapAuthoritySecret|proofOwnerSecret)$/,
  /^\/tenantAuthority\/apiProof\/(?:privateSecret|publicSecret)$/,
  /^\/worker\/authTokenSecret$/,
];
const SECRET_REFERENCE_KEY_PATHS = [
  /^\/capability\/(?:jwksJsonKey|keyIdKey|privateKeyPemKey)$/,
  /^\/database\/postgres\/(?:adapterOpsSecretKey|appSecretKey|existingSecretKey|ownerSecretKey|schedulerSecretKey|tenantAuthoritySecretKey|workerSecretKey)$/,
  /^\/databaseTls\/(?:caKey|certKey|keyKey)$/,
  /^\/tenantAuthority\/apiProof\/(?:caKey|certKey|keyKey)$/,
  /^\/worker\/authTokenSecretKey$/,
];
const CLOSED_CREDENTIAL_VALUE_PATHS = new Map([
  ['/database/postgres/password', 'postgres-password'],
]);

function fail(): never {
  throw new Error('TENANT_CUTOVER_RESTORE_PROJECTION_INVALID');
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as JsonRecord;
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail();
  return value;
}

function normalizedJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(normalizedJson);
  const source = record(value);
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, normalizedJson(child)]),
  );
}

function metadataProjection(value: unknown): JsonRecord {
  const metadata = { ...record(value) };
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
  return normalizedJson(metadata) as JsonRecord;
}

function identity(document: JsonRecord, releaseNamespace: string): HelmReleaseObjectIdentity {
  const metadata = record(document.metadata);
  const kind = nonEmpty(document.kind);
  const namespace = CLUSTER_SCOPED_KINDS.has(kind)
    ? ''
    : typeof metadata.namespace === 'string' && metadata.namespace
      ? metadata.namespace
      : releaseNamespace;
  return {
    apiVersion: nonEmpty(document.apiVersion),
    kind,
    namespace,
    name: nonEmpty(metadata.name),
  };
}

function identityKey(value: HelmReleaseObjectIdentity): string {
  return canonicalBootstrapJson(value);
}

/** Sort by the code-unit order of the canonical JSON encoding. The task1
 *  restore-evidence validator re-serializes each reference canonically and
 *  requires ascending default string order; localeCompare is ICU-dependent —
 *  it reorders '-ca' suffixes and varies across runner images. */
function byJsonKey(left: HelmReleaseObjectIdentity, right: HelmReleaseObjectIdentity): number {
  const leftKey = identityKey(left);
  const rightKey = identityKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function secretIdentity(namespace: string, name: unknown): HelmReleaseObjectIdentity {
  return { apiVersion: 'v1', kind: 'Secret', namespace, name: nonEmpty(name) };
}

function secretPayload(document: JsonRecord, key: string): string | undefined {
  const stringData = document.stringData === undefined ? {} : record(document.stringData);
  if (stringData[key] !== undefined) return nonEmpty(stringData[key]);
  const data = document.data === undefined ? {} : record(document.data);
  if (data[key] === undefined) return undefined;
  const encoded = nonEmpty(data[key]);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail();
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) fail();
  return decoded;
}

function typedSecretReference(
  pointer: string,
  value: string,
  secretKey: string,
  documents: readonly JsonRecord[],
  releaseNamespace: string,
): { sentinel: string; reference: HelmReleaseObjectIdentity } {
  const matches = documents.flatMap((document) => {
    if (document.kind !== 'Secret') return [];
    const objectIdentity = identity(document, releaseNamespace);
    if (
      objectIdentity.namespace !== releaseNamespace ||
      Object.hasOwn(record(document.metadata), 'deletionTimestamp') ||
      secretPayload(document, secretKey) !== value
    )
      return [];
    return [objectIdentity];
  });
  if (matches.length !== 1) fail();
  const reference = matches[0]!;
  return {
    sentinel: `commander-secret-ref/v1:${pointer}:${reference.name}:${secretKey}`,
    reference,
  };
}

function retainedSecretPayload(
  pointer: string,
  sentinel: string,
  secretKey: string,
  documents: readonly JsonRecord[],
  releaseNamespace: string,
): { sentinel: string; reference: HelmReleaseObjectIdentity; value: string } {
  const prefix = `commander-secret-ref/v1:${pointer}:`;
  if (!sentinel.startsWith(prefix)) fail();
  const parts = sentinel.slice(prefix.length).split(':');
  if (parts.length !== 2 || !SECRET_NAME.test(parts[0]) || parts[1] !== secretKey) fail();
  const matches = documents.flatMap((document) => {
    if (document.kind !== 'Secret') return [];
    const objectIdentity = identity(document, releaseNamespace);
    const metadata = record(document.metadata);
    if (
      objectIdentity.namespace !== releaseNamespace ||
      objectIdentity.name !== parts[0] ||
      Object.hasOwn(metadata, 'deletionTimestamp')
    )
      return [];
    const value = secretPayload(document, secretKey);
    return value === undefined ? [] : [{ reference: objectIdentity, value }];
  });
  if (matches.length !== 1) fail();
  return { sentinel, ...matches[0]! };
}

function retainedSecretReference(
  pointer: string,
  sentinel: string,
  secretKey: string,
  documents: readonly JsonRecord[],
  releaseNamespace: string,
): { sentinel: string; reference: HelmReleaseObjectIdentity } {
  const retained = retainedSecretPayload(pointer, sentinel, secretKey, documents, releaseNamespace);
  return { sentinel: retained.sentinel, reference: retained.reference };
}

function collectSecretReferences(
  value: unknown,
  namespace: string,
  references = new Map<string, HelmReleaseObjectIdentity>(),
): Map<string, HelmReleaseObjectIdentity> {
  if (Array.isArray(value)) {
    for (const child of value) collectSecretReferences(child, namespace, references);
    return references;
  }
  if (!value || typeof value !== 'object') return references;
  const object = value as JsonRecord;
  for (const field of ['secretKeyRef', 'secretRef']) {
    if (object[field] !== undefined) {
      const reference = secretIdentity(namespace, record(object[field]).name);
      references.set(identityKey(reference), reference);
    }
  }
  if (object.secret !== undefined) {
    const secret = record(object.secret);
    if (secret.secretName !== undefined) {
      const reference = secretIdentity(namespace, secret.secretName);
      references.set(identityKey(reference), reference);
    }
  }
  if (Array.isArray(object.imagePullSecrets)) {
    for (const item of object.imagePullSecrets) {
      const reference = secretIdentity(namespace, record(item).name);
      references.set(identityKey(reference), reference);
    }
  }
  for (const child of Object.values(object)) collectSecretReferences(child, namespace, references);
  return references;
}

function desiredComparator(document: JsonRecord): HelmReleaseObjectProjection['comparator'] {
  const desired = normalizedJson(document) as JsonRecord;
  delete desired.status;
  desired.metadata = metadataProjection(desired.metadata);
  return { format: 'kubernetes-field-comparator/v1', desired };
}

function secretComparator(document: JsonRecord): HelmReleaseObjectProjection['comparator'] {
  const data = document.data === undefined ? {} : record(document.data);
  const stringData = document.stringData === undefined ? {} : record(document.stringData);
  const dataKeys = [...new Set([...Object.keys(data), ...Object.keys(stringData)])].sort();
  if (dataKeys.length === 0) fail();
  return {
    format: 'kubernetes-field-comparator/v1',
    metadata: metadataProjection(document.metadata),
    type: typeof document.type === 'string' ? document.type : 'Opaque',
    immutable: document.immutable === true,
    dataKeys,
  };
}

function hookProjection(document: JsonRecord, objectIdentity: HelmReleaseObjectIdentity) {
  const annotations = record(record(document.metadata).annotations);
  const hooks = nonEmpty(annotations['helm.sh/hook'])
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (hooks.length === 0) fail();
  const deletePolicies =
    typeof annotations['helm.sh/hook-delete-policy'] === 'string'
      ? annotations['helm.sh/hook-delete-policy']
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .sort()
      : [];
  return { identity: objectIdentity, deletePolicies };
}

function isHook(document: JsonRecord): boolean {
  const metadata = record(document.metadata);
  return (
    metadata.annotations !== undefined &&
    typeof record(metadata.annotations)['helm.sh/hook'] === 'string'
  );
}

function secretReferencePath(path: string): boolean {
  return [...SECRET_REFERENCE_VALUE_PATHS, ...SECRET_REFERENCE_KEY_PATHS].some((pattern) =>
    pattern.test(path),
  );
}

function credentialBearingValue(key: string, value: string): boolean {
  if (/(?:authorization|credential|dsn|password|secret|token)$/i.test(key)) return true;
  if (/(?:api|encryption|integrity|master|private|signing).?key(?:pem)?$/i.test(key)) return true;
  if (/^(?:connection|string|database)[_-]?(?:string|url)$/i.test(key)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@:]+:[^/@]+@/i.test(value);
}

function credentialEnvironmentName(value: string): boolean {
  if (
    /(?:_SECRET_(?:KEY|NAME|REFERENCE)|_(?:CERT|KEY|CA)_FILE|_CREDENTIAL_FILE|_SECRET_DIR)$/.test(
      value,
    )
  )
    return false;
  return /(?:^|_)(?:API_KEY|AUTHORIZATION|DATABASE_URL|DSN|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/.test(
    value,
  );
}

function assertNoNonSecretCredential(value: unknown, parentKey = ''): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoNonSecretCredential(child, parentKey);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as JsonRecord;
  if (
    typeof object.name === 'string' &&
    credentialEnvironmentName(object.name) &&
    typeof object.value === 'string' &&
    object.value.length > 0
  )
    fail();
  for (const [key, child] of Object.entries(object)) {
    if (
      typeof child === 'string' &&
      child.length > 0 &&
      parentKey !== 'secretKeyRef' &&
      parentKey !== 'secretRef' &&
      parentKey !== 'secret' &&
      credentialBearingValue(key, child)
    )
      fail();
    assertNoNonSecretCredential(child, key);
  }
}

function sanitizeRendererValues(
  value: unknown,
  documents: readonly JsonRecord[],
  releaseNamespace: string,
  references: Map<string, HelmReleaseObjectIdentity>,
  path = '',
): unknown {
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      sanitizeRendererValues(child, documents, releaseNamespace, references, `${path}/${index}`),
    );
  }
  if (!value || typeof value !== 'object') return normalizedJson(value);
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const closedSecretKey = CLOSED_CREDENTIAL_VALUE_PATHS.get(childPath);
    if (closedSecretKey && typeof child === 'string' && child.length > 0) {
      const typed = child.startsWith('commander-secret-ref/v1:')
        ? retainedSecretReference(childPath, child, closedSecretKey, documents, releaseNamespace)
        : typedSecretReference(childPath, child, closedSecretKey, documents, releaseNamespace);
      if (!references.has(identityKey(typed.reference))) fail();
      references.set(identityKey(typed.reference), typed.reference);
      result[key] = typed.sentinel;
      continue;
    }
    if (
      typeof child === 'string' &&
      child.length > 0 &&
      credentialBearingValue(key, child) &&
      !secretReferencePath(childPath)
    )
      fail();
    result[key] = sanitizeRendererValues(child, documents, releaseNamespace, references, childPath);
  }
  return result;
}

function sourceReferences(
  value: unknown,
  namespace: string,
): Map<string, HelmReleaseObjectIdentity> {
  if (!Array.isArray(value)) fail();
  const references = new Map<string, HelmReleaseObjectIdentity>();
  for (const source of value) {
    const reference = record(source);
    const name = nonEmpty(reference.name);
    if (
      Object.keys(reference).sort().join('\0') !== 'apiVersion\0kind\0name\0namespace' ||
      reference.apiVersion !== 'v1' ||
      reference.kind !== 'Secret' ||
      reference.namespace !== namespace ||
      !SECRET_NAME.test(name)
    )
      fail();
    const identity: HelmReleaseObjectIdentity = {
      apiVersion: 'v1',
      kind: 'Secret',
      namespace,
      name,
    };
    const key = identityKey(identity);
    if (references.has(key)) fail();
    references.set(key, identity);
  }
  return references;
}

function materializeRendererValues(
  value: unknown,
  documents: readonly JsonRecord[],
  namespace: string,
  sources: ReadonlyMap<string, HelmReleaseObjectIdentity>,
  path = '',
): unknown {
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      materializeRendererValues(child, documents, namespace, sources, `${path}/${index}`),
    );
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.startsWith('commander-secret-ref/v1:')) fail();
    return normalizedJson(value);
  }
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const secretKey = CLOSED_CREDENTIAL_VALUE_PATHS.get(childPath);
    if (secretKey) {
      if (typeof child !== 'string' || child.length === 0) fail();
      const retained = retainedSecretPayload(childPath, child, secretKey, documents, namespace);
      if (!sources.has(identityKey(retained.reference))) fail();
      result[key] = retained.value;
      continue;
    }
    result[key] = materializeRendererValues(child, documents, namespace, sources, childPath);
  }
  return result;
}

export function materializeRetainedRendererValues(input: {
  values: unknown;
  secretReferences: unknown;
  manifest: string;
  namespace: string;
}): unknown {
  if (!nonEmpty(input.namespace)) fail();
  const documents: JsonRecord[] = [];
  try {
    loadAll(input.manifest, (document) => {
      if (document !== undefined && document !== null) documents.push(record(document));
    });
  } catch {
    return fail();
  }
  return materializeRendererValues(
    input.values,
    documents,
    input.namespace,
    sourceReferences(input.secretReferences, input.namespace),
  );
}

export function projectHelmReleaseRevision(input: {
  namespace: string;
  releaseName: string;
  revision: string;
  manifest: string;
  values: string;
}): HelmReleaseProjection {
  if (!input.namespace || !input.releaseName || !REVISION.test(input.revision)) fail();
  let values: JsonRecord;
  const documents: JsonRecord[] = [];
  try {
    values = record(load(input.values));
    loadAll(input.manifest, (document) => {
      if (document !== undefined && document !== null) documents.push(record(document));
    });
  } catch {
    return fail();
  }
  const tenantAuthority = record(values.tenantAuthority);
  const chartContentSha256 = nonEmpty(tenantAuthority.chartContentSha256);
  if (!SHA256.test(chartContentSha256) || documents.length === 0) fail();

  const objects: HelmReleaseObjectProjection[] = [];
  const hooks: HelmReleaseProjection['hooks'][number][] = [];
  const identities = new Set<string>();
  const allSecretReferences = new Map<string, HelmReleaseObjectIdentity>();
  for (const document of documents) {
    const objectIdentity = identity(document, input.namespace);
    const key = identityKey(objectIdentity);
    if (identities.has(key)) fail();
    identities.add(key);
    if (objectIdentity.kind !== 'Secret') assertNoNonSecretCredential(document);
    if (isHook(document)) {
      hooks.push(hookProjection(document, objectIdentity));
      continue;
    }
    const references =
      objectIdentity.kind === 'Secret'
        ? []
        : [...collectSecretReferences(document, objectIdentity.namespace).values()].sort(byJsonKey);
    for (const reference of references) allSecretReferences.set(identityKey(reference), reference);
    objects.push({
      identity: objectIdentity,
      comparator:
        objectIdentity.kind === 'Secret' ? secretComparator(document) : desiredComparator(document),
      secretReferences: references,
    });
  }
  objects.sort((left, right) =>
    identityKey(left.identity).localeCompare(identityKey(right.identity)),
  );
  hooks.sort((left, right) =>
    identityKey(left.identity).localeCompare(identityKey(right.identity)),
  );
  const rendererValues = sanitizeRendererValues(
    values,
    documents,
    input.namespace,
    allSecretReferences,
  );
  return {
    format: 'helm-release-projection/v1',
    namespace: input.namespace,
    releaseName: input.releaseName,
    revision: input.revision,
    chartContentSha256,
    objects,
    hooks,
    rendererInput: {
      format: 'helm-renderer-input-projection/v1',
      values: rendererValues,
      secretReferences: [...allSecretReferences.values()].sort(byJsonKey),
    },
  };
}
