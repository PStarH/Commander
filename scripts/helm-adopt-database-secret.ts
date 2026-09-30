#!/usr/bin/env tsx

import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface KubernetesSecretSnapshot {
  metadata: { namespace: string; name: string; resourceVersion?: string };
  type: string;
  data: Record<string, string>;
}

const LEGACY_URL_LOGINS = {
  'owner-url': 'commander_owner',
  'app-url': 'commander_app',
  'scheduler-url': 'commander_scheduler',
  'worker-url': 'commander_worker',
  'adapter-ops-url': 'commander_adapter_ops',
} as const;

const LEGACY_PASSWORD_KEYS = [
  'owner-password',
  'app-password',
  'scheduler-password',
  'worker-password',
  'adapter-ops-password',
  'postgres-password',
] as const;

const LEGACY_KEYS = [...Object.keys(LEGACY_URL_LOGINS), ...LEGACY_PASSWORD_KEYS].sort();
const APPROVED_V8_KEYS = LEGACY_KEYS.filter(
  (key) => key !== 'adapter-ops-url' && key !== 'adapter-ops-password',
);
const SECRET_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const SECRET_DATA_KEY = /^[A-Za-z0-9._-]+$/;

function invalid(): never {
  throw new Error('TENANT_DATABASE_SECRET_ADOPTION_INVALID');
}

function exactKeys(value: Record<string, string>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalid();
  }
}

function hasExactKeys(value: Record<string, string>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
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

function postgresUrl(value: string, expectedLogin: string): URL {
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
  return url;
}

function tlsParameters(url: URL): Array<[string, string]> {
  return [...url.searchParams.entries()].filter(([key]) => key.toLowerCase().startsWith('ssl'));
}

function authorityUrl(value: string, password: string): URL {
  const url = postgresUrl(value, 'commander_tenant_authority');
  const tls = tlsParameters(url);
  if (
    decodeURIComponent(url.password) !== password ||
    tls.length !== 1 ||
    tls[0]![0].toLowerCase() !== 'sslmode' ||
    tls[0]![1] !== 'verify-full'
  ) {
    invalid();
  }
  return url;
}

export function transformBundledPersistentSecret(input: {
  source: KubernetesSecretSnapshot;
  targetName: string;
  adapterOpsUrl?: string;
  adapterOpsPassword?: string;
  tenantAuthorityUrl: string;
  tenantAuthorityPassword: string;
}): KubernetesSecretSnapshot {
  if (
    input.source.type !== 'Opaque' ||
    !SECRET_NAME.test(input.source.metadata.namespace) ||
    !SECRET_NAME.test(input.source.metadata.name) ||
    !SECRET_NAME.test(input.targetName) ||
    input.source.metadata.name === input.targetName ||
    !input.tenantAuthorityPassword
  ) {
    invalid();
  }
  const sourceData = { ...input.source.data };
  const approvedV8 = hasExactKeys(sourceData, APPROVED_V8_KEYS);
  if (!approvedV8) exactKeys(sourceData, LEGACY_KEYS);
  if (
    (input.adapterOpsUrl === undefined) !== (input.adapterOpsPassword === undefined) ||
    (approvedV8 && (!input.adapterOpsUrl || !input.adapterOpsPassword))
  ) {
    invalid();
  }
  if (input.adapterOpsUrl && input.adapterOpsPassword) {
    const adapterUrl = postgresUrl(input.adapterOpsUrl, 'commander_adapter_ops');
    const ownerUrl = postgresUrl(decode(sourceData['owner-url']), 'commander_owner');
    if (
      tlsParameters(adapterUrl).length !== 0 ||
      decodeURIComponent(adapterUrl.password) !== input.adapterOpsPassword ||
      adapterUrl.protocol !== ownerUrl.protocol ||
      adapterUrl.hostname !== ownerUrl.hostname ||
      (adapterUrl.port || '5432') !== (ownerUrl.port || '5432') ||
      adapterUrl.pathname !== ownerUrl.pathname ||
      adapterUrl.hash !== ownerUrl.hash
    ) {
      invalid();
    }
    const encodedUrl = Buffer.from(adapterUrl.toString(), 'utf8').toString('base64');
    const encodedPassword = Buffer.from(input.adapterOpsPassword, 'utf8').toString('base64');
    if (
      !approvedV8 &&
      (sourceData['adapter-ops-url'] !== encodedUrl ||
        sourceData['adapter-ops-password'] !== encodedPassword)
    ) {
      invalid();
    }
    sourceData['adapter-ops-url'] = encodedUrl;
    sourceData['adapter-ops-password'] = encodedPassword;
  }
  exactKeys(sourceData, LEGACY_KEYS);
  const nextData = { ...sourceData };
  for (const [key, expectedLogin] of Object.entries(LEGACY_URL_LOGINS)) {
    const url = postgresUrl(decode(sourceData[key]), expectedLogin);
    if (tlsParameters(url).length !== 0) invalid();
    url.searchParams.append('sslmode', 'verify-full');
    nextData[key] = Buffer.from(url.toString(), 'utf8').toString('base64');
  }
  for (const key of LEGACY_PASSWORD_KEYS) decode(sourceData[key]);
  const tenantAuthorityUrl = authorityUrl(
    input.tenantAuthorityUrl,
    input.tenantAuthorityPassword,
  ).toString();
  nextData['tenant-authority-url'] = Buffer.from(tenantAuthorityUrl, 'utf8').toString('base64');
  nextData['tenant-authority-password'] = Buffer.from(
    input.tenantAuthorityPassword,
    'utf8',
  ).toString('base64');
  exactKeys(nextData, [...LEGACY_KEYS, 'tenant-authority-url', 'tenant-authority-password']);
  return {
    metadata: { namespace: input.source.metadata.namespace, name: input.targetName },
    type: 'Opaque',
    data: nextData,
  };
}

export function planExternalDatabaseSecretAdd(input: {
  source: KubernetesSecretSnapshot;
  tenantAuthorityUrl: string;
  tenantAuthorityKey?: string;
}): { action: 'unchanged' | 'patch'; patch: unknown[] } {
  const key = input.tenantAuthorityKey ?? 'tenant-authority-url';
  const resourceVersion = input.source.metadata.resourceVersion;
  if (
    input.source.type !== 'Opaque' ||
    !SECRET_NAME.test(input.source.metadata.namespace) ||
    !SECRET_NAME.test(input.source.metadata.name) ||
    !resourceVersion ||
    !SECRET_DATA_KEY.test(key)
  ) {
    invalid();
  }
  const url = authorityUrl(
    input.tenantAuthorityUrl,
    decodeURIComponent(new URL(input.tenantAuthorityUrl).password),
  ).toString();
  const encoded = Buffer.from(url, 'utf8').toString('base64');
  const existing = input.source.data[key];
  if (existing !== undefined) {
    if (existing !== encoded) throw new Error('TENANT_DATABASE_SECRET_ADOPTION_CONFLICT');
    return { action: 'unchanged', patch: [] };
  }
  return {
    action: 'patch',
    patch: [
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      { op: 'add', path: `/data/${key}`, value: encoded },
    ],
  };
}

export type DatabaseSecretAdoptionRequest =
  | {
      mode: 'bundled-persistent';
      namespace: string;
      source: string;
      target: string;
      adapterOpsUrlFile: string;
      adapterOpsPasswordFile: string;
      tenantAuthorityUrlFile: string;
      tenantAuthorityPasswordFile: string;
    }
  | {
      mode: 'external-add';
      namespace: string;
      secret: string;
      tenantAuthorityUrlFile: string;
      tenantAuthorityKey?: string;
    };

export interface DatabaseSecretAdoptionPorts {
  readOwnerOnlyFile(path: string): Promise<string>;
  readSecret(namespace: string, name: string): Promise<KubernetesSecretSnapshot | null>;
  authenticateOwner(url: string): Promise<void>;
  createSecret(secret: KubernetesSecretSnapshot): Promise<void>;
  patchSecret(namespace: string, name: string, patch: unknown[]): Promise<void>;
}

export async function runDatabaseSecretAdoption(
  request: DatabaseSecretAdoptionRequest,
  ports: DatabaseSecretAdoptionPorts,
): Promise<Record<string, unknown>> {
  if (!SECRET_NAME.test(request.namespace)) invalid();
  const fileValue = async (path: string): Promise<string> => {
    const raw = await ports.readOwnerOnlyFile(path);
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!value || value.includes('\n') || value.includes('\r') || value.includes('\0')) invalid();
    return value;
  };

  if (request.mode === 'bundled-persistent') {
    if (!SECRET_NAME.test(request.source) || !SECRET_NAME.test(request.target)) invalid();
    const [
      source,
      target,
      adapterOpsUrl,
      adapterOpsPassword,
      tenantAuthorityUrl,
      tenantAuthorityPassword,
    ] = await Promise.all([
      ports.readSecret(request.namespace, request.source),
      ports.readSecret(request.namespace, request.target),
      fileValue(request.adapterOpsUrlFile),
      fileValue(request.adapterOpsPasswordFile),
      fileValue(request.tenantAuthorityUrlFile),
      fileValue(request.tenantAuthorityPasswordFile),
    ]);
    if (!source || target) throw new Error('TENANT_DATABASE_SECRET_ADOPTION_COLLISION');
    const ownerUrl = decode(source.data['owner-url']);
    postgresUrl(ownerUrl, 'commander_owner');
    await ports.authenticateOwner(ownerUrl);
    const desired = transformBundledPersistentSecret({
      source,
      targetName: request.target,
      adapterOpsUrl,
      adapterOpsPassword,
      tenantAuthorityUrl,
      tenantAuthorityPassword,
    });
    const sourceBeforeCreate = await ports.readSecret(request.namespace, request.source);
    if (canonicalBootstrapJson(sourceBeforeCreate) !== canonicalBootstrapJson(source)) {
      throw new Error('TENANT_DATABASE_SECRET_ADOPTION_CONFLICT');
    }
    try {
      await ports.createSecret(desired);
    } catch {
      // A lost success response or create race is resolved only by the exact re-read below.
    }
    const observed = await ports.readSecret(request.namespace, request.target);
    const expected = structuredClone(desired);
    expected.metadata.resourceVersion = observed?.metadata.resourceVersion;
    if (canonicalBootstrapJson(observed) !== canonicalBootstrapJson(expected)) {
      throw new Error('TENANT_DATABASE_SECRET_ADOPTION_CONFLICT');
    }
    return {
      mode: request.mode,
      status: 'created',
      namespace: request.namespace,
      secret: request.target,
      keyNames: Object.keys(desired.data).sort(),
    };
  }

  if (!SECRET_NAME.test(request.secret)) invalid();
  const [source, tenantAuthorityUrl] = await Promise.all([
    ports.readSecret(request.namespace, request.secret),
    fileValue(request.tenantAuthorityUrlFile),
  ]);
  if (!source) throw new Error('TENANT_DATABASE_SECRET_ADOPTION_SOURCE_MISSING');
  const ownerUrl = decode(source.data['owner-url']);
  postgresUrl(ownerUrl, 'commander_owner');
  await ports.authenticateOwner(ownerUrl);
  const plan = planExternalDatabaseSecretAdd({
    source,
    tenantAuthorityUrl,
    tenantAuthorityKey: request.tenantAuthorityKey,
  });
  if (plan.action === 'patch') {
    try {
      await ports.patchSecret(request.namespace, request.secret, plan.patch);
    } catch {
      // The resourceVersion test and exact re-read distinguish lost success from a conflict.
    }
  }
  const observed = await ports.readSecret(request.namespace, request.secret);
  const key = request.tenantAuthorityKey ?? 'tenant-authority-url';
  if (!observed) throw new Error('TENANT_DATABASE_SECRET_ADOPTION_CONFLICT');
  const expected = structuredClone(source);
  expected.data[key] = Buffer.from(new URL(tenantAuthorityUrl).toString(), 'utf8').toString(
    'base64',
  );
  expected.metadata.resourceVersion = observed.metadata.resourceVersion;
  if (canonicalBootstrapJson(observed) !== canonicalBootstrapJson(expected)) {
    throw new Error('TENANT_DATABASE_SECRET_ADOPTION_CONFLICT');
  }
  return {
    mode: request.mode,
    status: plan.action === 'patch' ? 'added' : 'unchanged',
    namespace: request.namespace,
    secret: request.secret,
    keyNames: Object.keys(observed.data).sort(),
  };
}

export function parseDatabaseSecretAdoptionArgs(
  args: readonly string[],
): DatabaseSecretAdoptionRequest {
  const argumentInvalid = (): never => {
    throw new Error('TENANT_DATABASE_SECRET_ADOPTION_ARGUMENT_INVALID');
  };
  const mode = args[0];
  if ((mode !== 'bundled-persistent' && mode !== 'external-add') || args.length % 2 === 0) {
    return argumentInvalid();
  }
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || flags.has(flag)) argumentInvalid();
    flags.set(flag, value);
  }
  const exact = (allowed: readonly string[]): void => {
    if (
      flags.size !== allowed.length ||
      [...flags.keys()].some((flag) => !allowed.includes(flag))
    ) {
      argumentInvalid();
    }
  };
  const required = (flag: string): string => flags.get(flag) ?? argumentInvalid();
  const path = (flag: string): string => {
    const value = required(flag);
    if (!value.startsWith('/') || value.includes('\0')) argumentInvalid();
    return value;
  };
  if (mode === 'bundled-persistent') {
    exact([
      '--namespace',
      '--source',
      '--target',
      '--adapter-ops-url-file',
      '--adapter-ops-password-file',
      '--tenant-authority-url-file',
      '--tenant-authority-password-file',
    ]);
    return {
      mode,
      namespace: required('--namespace'),
      source: required('--source'),
      target: required('--target'),
      adapterOpsUrlFile: path('--adapter-ops-url-file'),
      adapterOpsPasswordFile: path('--adapter-ops-password-file'),
      tenantAuthorityUrlFile: path('--tenant-authority-url-file'),
      tenantAuthorityPasswordFile: path('--tenant-authority-password-file'),
    };
  }
  const hasCustomKey = flags.has('--tenant-authority-key');
  exact([
    '--namespace',
    '--secret',
    '--tenant-authority-url-file',
    ...(hasCustomKey ? ['--tenant-authority-key'] : []),
  ]);
  return {
    mode,
    namespace: required('--namespace'),
    secret: required('--secret'),
    tenantAuthorityUrlFile: path('--tenant-authority-url-file'),
    ...(hasCustomKey ? { tenantAuthorityKey: required('--tenant-authority-key') } : {}),
  };
}

export async function readOwnerOnlyAdoptionFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      metadata.size < 1 ||
      metadata.size > 64 * 1024
    ) {
      throw new Error('TENANT_DATABASE_SECRET_ADOPTION_FILE_INVALID');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'TENANT_DATABASE_SECRET_ADOPTION_FILE_INVALID'
    ) {
      throw error;
    }
    throw new Error('TENANT_DATABASE_SECRET_ADOPTION_FILE_INVALID');
  } finally {
    await handle?.close();
  }
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
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: options.env ?? process.env,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('TENANT_DATABASE_SECRET_ADOPTION_COMMAND_FAILED'));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(options.stdin);
  });
}

function snapshot(value: string): KubernetesSecretSnapshot | null {
  if (!value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const object = parsed as Record<string, unknown>;
  const metadata = object.metadata;
  const data = object.data;
  if (
    object.apiVersion !== 'v1' ||
    object.kind !== 'Secret' ||
    object.type !== 'Opaque' ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.values(data).some((item) => typeof item !== 'string')
  ) {
    invalid();
  }
  const meta = metadata as Record<string, unknown>;
  if (
    typeof meta.namespace !== 'string' ||
    typeof meta.name !== 'string' ||
    typeof meta.resourceVersion !== 'string'
  ) {
    invalid();
  }
  return {
    metadata: {
      namespace: meta.namespace,
      name: meta.name,
      resourceVersion: meta.resourceVersion,
    },
    type: 'Opaque',
    data: data as Record<string, string>,
  };
}

export function createDatabaseSecretAdoptionPorts(): DatabaseSecretAdoptionPorts {
  return {
    readOwnerOnlyFile: readOwnerOnlyAdoptionFile,
    readSecret: async (namespace, name) =>
      snapshot(
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
    authenticateOwner: async (value) => {
      const url = postgresUrl(value, 'commander_owner');
      const sslmode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer';
      const output = (
        await command(
          'psql',
          [
            '--no-psqlrc',
            '--tuples-only',
            '--no-align',
            '--set=ON_ERROR_STOP=1',
            '--command=SELECT current_user::text || chr(9) || session_user::text',
          ],
          {
            env: {
              ...process.env,
              PGHOST: url.hostname,
              PGPORT: url.port || '5432',
              PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
              PGUSER: decodeURIComponent(url.username),
              PGPASSWORD: decodeURIComponent(url.password),
              PGSSLMODE: sslmode,
            },
          },
        )
      ).trim();
      if (output !== 'commander_owner\tcommander_owner') {
        throw new Error('TENANT_DATABASE_SECRET_ADOPTION_OWNER_INVALID');
      }
    },
    createSecret: async (secret) => {
      const manifest = canonicalBootstrapJson({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secret.metadata.name, namespace: secret.metadata.namespace },
        type: secret.type,
        data: secret.data,
      });
      await command('kubectl', ['create', '--filename=-'], { stdin: manifest });
    },
    patchSecret: async (namespace, name, patch) => {
      await command(
        'kubectl',
        ['patch', 'secret', name, '--namespace', namespace, '--type=json', '--patch-file=-'],
        { stdin: canonicalBootstrapJson(patch) },
      );
    },
  };
}

async function main(): Promise<void> {
  const request = parseDatabaseSecretAdoptionArgs(process.argv.slice(2));
  const result = await runDatabaseSecretAdoption(request, createDatabaseSecretAdoptionPorts());
  process.stdout.write(`${canonicalBootstrapJson(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch(() => {
    process.stderr.write('TENANT_DATABASE_SECRET_ADOPTION_FAILED\n');
    process.exitCode = 1;
  });
}
