import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDockerCliTopologyAuthority,
  withComposeTopologyRelay,
  type DockerTopologyAuthority,
} from './task1-compose-topology-relay.js';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
} from '../packages/kernel/src/canonicalBootstrap.js';
import { createTask1DatabasePeerBindingInput } from './task1-database-peer-input.js';

export const CONFIGURATION_DIGEST_SENTINEL = 'commander-configuration-sha256/v1:self';
export const CREDENTIAL_SENTINEL_PREFIX = 'commander-secret-ref/v1:';
export const COMPOSE_CLI_VERSION = '5.3.1';

export type ComposePhase = 'expand' | 'enforce';
export type ComposeCutoverCommand = 'install' | 'expand' | 'enforce' | 'rollback-recorded-expand';
export type ComposeCredentialInventory = 'runtime-v1' | 'fresh-bootstrap-v1';
export type ComposeOperationKind =
  | 'legacy_expand'
  | 'fresh_enforce'
  | 'enforce'
  | 'recover_runtime_after_enforce_failure'
  | 'rollback_to_recorded_expand';

export interface ComposePlatformBinding {
  kind: 'compose';
  projectName: string;
  composeVariant: 'prod';
  composeCredentialInventory: ComposeCredentialInventory;
  composeSourceSha256: string;
  composeCliVersion: typeof COMPOSE_CLI_VERSION;
  composeContentSha256: string;
  phase: ComposePhase;
  apiImageDigest: string;
  apiProofUrl: string;
}

export type ComposePlatformIntent = Omit<ComposePlatformBinding, 'composeContentSha256'>;

export interface PreparedComposeConfiguration {
  platformBinding: ComposePlatformBinding;
  businessConfiguration: Record<string, unknown>;
  configuration: Record<string, unknown> & { operationAuditNonce: string };
  configurationSha256: string;
}

export interface CutoverFileStat {
  mode: number;
  uid: number;
  gid: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface AtomicWriteOptions {
  mode: number;
  uid: number;
  gid: number;
}

export interface CutoverFileSystemPort {
  lstat(path: string): Promise<CutoverFileStat>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: AtomicWriteOptions): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string, options: AtomicWriteOptions): Promise<void>;
}

export interface TlsHostFile {
  path: string;
  kind: 'public' | 'private-key';
}

interface ResolvedComposeModel {
  services?: Record<string, { environment?: Record<string, unknown> | string[] }>;
  [key: string]: unknown;
}

export interface ComposeCutoverInput {
  command: ComposeCutoverCommand;
  projectName: string;
  composeFile: string;
  composeFiles: readonly string[];
  composeCredentialInventory: ComposeCredentialInventory;
  stateDirectory: string;
  apiImage: string;
  apiProofUrl: string;
  businessConfiguration: Record<string, unknown>;
  credentialValues: Readonly<Record<string, string>>;
  nonCredentialEnvironment: Readonly<Record<string, string>>;
  tlsHostFiles: readonly TlsHostFile[];
}

export interface OwnerOperationEvidence {
  operationVersion: string;
  operationKind: ComposeOperationKind;
  phase: ComposePhase;
  apiImage: string;
  platformBinding: ComposePlatformBinding;
  businessConfiguration: Record<string, unknown>;
  configuration: Record<string, unknown> & { operationAuditNonce: string };
  configurationSha256: string;
  predecessor: OwnerOperationEvidence | null;
}

export interface OwnerPlanRequest {
  command: ComposeCutoverCommand;
  platformIntent: ComposePlatformIntent;
  businessConfiguration: Record<string, unknown>;
}

export type OwnerPlan =
  | { action: 'append' }
  | { action: 'return_current' | 'retry_rollout'; operation: OwnerOperationEvidence };

export interface OwnerAppendRequest {
  command: ComposeCutoverCommand;
  prepared: PreparedComposeConfiguration;
}

export interface ComposeOwnerPort {
  plan(request: OwnerPlanRequest): Promise<OwnerPlan>;
  append(request: OwnerAppendRequest): Promise<OwnerOperationEvidence>;
  recover(failed: OwnerOperationEvidence): Promise<OwnerOperationEvidence>;
}

export interface ComposeProcessPort {
  render(environment: Readonly<Record<string, string>>): Promise<ResolvedComposeModel>;
  startFreshBootstrap(
    environment: Readonly<Record<string, string>>,
    environmentKeys: readonly string[],
  ): Promise<void>;
  rollout(
    operation: OwnerOperationEvidence,
    envFile: string,
    environmentKeys: readonly string[],
  ): Promise<void>;
  prove(operation: OwnerOperationEvidence): Promise<boolean>;
}

export interface ComposeCutoverPorts {
  fs: CutoverFileSystemPort;
  owner: ComposeOwnerPort;
  compose: ComposeProcessPort;
  createNonce(): string;
}

export interface ExternalCommandRequest {
  program: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  stdin?: string;
}

export interface ExternalCommandPort {
  run(request: ExternalCommandRequest): Promise<{ stdout: string }>;
}

export interface DockerComposeProcessPortOptions {
  authority?: DockerTopologyAuthority;
  relayDirectory?: string;
}

const EXTERNAL_OUTPUT_LIMIT = 4 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 5 * 60 * 1000;

export function createNodeFileSystemPort(): CutoverFileSystemPort {
  return {
    async lstat(path) {
      const stat = await lstat(path);
      return {
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    },
    realpath,
    async mkdir(path, options) {
      await mkdir(path, { recursive: true, mode: options.mode });
      await chown(path, options.uid, options.gid);
      await chmod(path, options.mode);
    },
    async readFile(path) {
      return readFile(path, 'utf8');
    },
    async writeFileAtomic(path, contents, options) {
      const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporaryPath, 'wx', options.mode);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.chown(options.uid, options.gid);
        await handle.chmod(options.mode);
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, path);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function createNodeExternalCommandPort(): ExternalCommandPort {
  return {
    run(request) {
      return new Promise((resolveCommand, rejectCommand) => {
        const child = spawn(request.program, [...request.args], {
          env: request.environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        const finishWithError = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.kill('SIGKILL');
          rejectCommand(new Error('TENANT_CUTOVER_COMMAND_FAILED'));
        };
        const timeout = setTimeout(finishWithError, EXTERNAL_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > EXTERNAL_OUTPUT_LIMIT) {
            finishWithError();
          } else {
            stdout.push(chunk);
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > EXTERNAL_OUTPUT_LIMIT) finishWithError();
        });
        child.once('error', finishWithError);
        child.once('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (code !== 0) {
            rejectCommand(new Error('TENANT_CUTOVER_COMMAND_FAILED'));
            return;
          }
          resolveCommand({ stdout: Buffer.concat(stdout).toString('utf8') });
        });
        child.stdin.end(request.stdin ?? '');
      });
    },
  };
}

export type ComposeCutoverResult = {
  action: 'deployed' | 'returned_current' | 'retried' | 'recovered';
  operation: OwnerOperationEvidence;
};

const API_IMAGE_PATTERN = /^[^\s]+@sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROVISIONAL_CONFIGURATION_SHA256 = '0'.repeat(64);
const CALLER_EVIDENCE_KEYS = new Set([
  'configurationSha256',
  'operationAuditNonce',
  'operationVersion',
  'operationKind',
  'platformBinding',
  'composeCredentialInventory',
  'requestedBindingSha256',
  'requestedConfigurationSha256',
]);
const CALLER_EVIDENCE_ENV = [
  'COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE',
  'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256',
  'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST',
  'COMMANDER_OPERATION_AUDIT_NONCE',
  'COMMANDER_TENANT_CUTOVER_OPERATION_VERSION',
  'COMMANDER_TENANT_CUTOVER_TARGET_ROW',
  'COMMANDER_TENANT_CUTOVER_FORCE',
  'COMMANDER_TENANT_CUTOVER_READINESS',
] as const;
const RUNTIME_CREDENTIAL_SOURCES = [
  'COMMANDER_POSTGRES_SUPERUSER_PASSWORD',
  'COMMANDER_OWNER_DATABASE_URL',
  'COMMANDER_API_DATABASE_URL',
  'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
  'COMMANDER_SCHEDULER_DATABASE_URL',
  'COMMANDER_WORKER_DATABASE_URL',
  'COMMANDER_ADAPTER_OPS_DATABASE_URL',
] as const;
const BOOTSTRAP_AUTHORITY_SOURCE = 'COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL';

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '') {
    fail('TENANT_CUTOVER_REQUIRED_ENV_MISSING');
  }
  return value;
}

function parseAllowedTenants(value: string): string[] {
  const tenants = value
    .split(',')
    .map((tenant) => tenant.trim())
    .filter(Boolean);
  if (tenants.length === 0 || tenants.some((tenant) => tenant === '*')) {
    fail('TENANT_CUTOVER_ALLOWLIST_INVALID');
  }
  if (new Set(tenants).size !== tenants.length) fail('TENANT_CUTOVER_ALLOWLIST_INVALID');
  return tenants;
}

export function parseComposeTenantCutoverArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ComposeCutoverInput {
  if (
    args.length !== 1 ||
    (args[0] !== 'install' &&
      args[0] !== 'expand' &&
      args[0] !== 'enforce' &&
      args[0] !== 'rollback-recorded-expand')
  ) {
    fail('TENANT_CUTOVER_CLI_ARGUMENT_INVALID');
  }
  for (const name of CALLER_EVIDENCE_ENV) {
    if (environment[name] !== undefined) fail('TENANT_CUTOVER_CALLER_EVIDENCE_FORBIDDEN');
  }

  const command = args[0];
  const composeCredentialInventory: ComposeCredentialInventory =
    command === 'install' ? 'fresh-bootstrap-v1' : 'runtime-v1';
  if (
    command !== 'install' &&
    environment.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL !== undefined
  ) {
    fail('TENANT_CUTOVER_BOOTSTRAP_AUTHORITY_FORBIDDEN');
  }
  const projectName = requiredEnvironment(environment, 'COMPOSE_PROJECT_NAME');
  const preclosureImage = requiredEnvironment(environment, 'COMMANDER_PRECLOSURE_API_IMAGE');
  const expandImage = requiredEnvironment(environment, 'COMMANDER_EXPAND_API_IMAGE');
  const enforceImage = requiredEnvironment(environment, 'COMMANDER_ENFORCE_API_IMAGE');
  const postgresImage = requiredEnvironment(environment, 'COMMANDER_POSTGRES_IMAGE');
  const migratorImage = requiredEnvironment(environment, 'COMMANDER_MIGRATOR_IMAGE');
  const kernelOpsImage = requiredEnvironment(environment, 'COMMANDER_KERNEL_OPS_IMAGE');
  const workerImage = requiredEnvironment(environment, 'COMMANDER_WORKER_IMAGE');
  const adapterOpsImage = requiredEnvironment(environment, 'COMMANDER_ADAPTER_OPS_IMAGE');
  for (const image of [
    preclosureImage,
    expandImage,
    enforceImage,
    postgresImage,
    migratorImage,
    kernelOpsImage,
    workerImage,
    adapterOpsImage,
  ]) {
    if (!API_IMAGE_PATTERN.test(image)) fail('TENANT_CUTOVER_IMAGE_NOT_DIGEST_PINNED');
  }
  const expectedSpki = requiredEnvironment(
    environment,
    'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
  );
  if (!SHA256_PATTERN.test(expectedSpki)) fail('TENANT_CUTOVER_DATABASE_SPKI_INVALID');

  const hostPaths = {
    COMMANDER_POSTGRES_TLS_CA_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_POSTGRES_TLS_CA_HOST_FILE',
    ),
    COMMANDER_POSTGRES_TLS_CERT_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_POSTGRES_TLS_CERT_HOST_FILE',
    ),
    COMMANDER_POSTGRES_TLS_KEY_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_POSTGRES_TLS_KEY_HOST_FILE',
    ),
    COMMANDER_API_PROOF_CA_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_API_PROOF_CA_HOST_FILE',
    ),
    COMMANDER_API_PROOF_CERT_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_API_PROOF_CERT_HOST_FILE',
    ),
    COMMANDER_API_PROOF_KEY_HOST_FILE: requiredEnvironment(
      environment,
      'COMMANDER_API_PROOF_KEY_HOST_FILE',
    ),
  };
  const credentialValues = {
    COMMANDER_POSTGRES_SUPERUSER_PASSWORD: requiredEnvironment(
      environment,
      'COMMANDER_POSTGRES_SUPERUSER_PASSWORD',
    ),
    COMMANDER_OWNER_DATABASE_URL: requiredEnvironment(environment, 'COMMANDER_OWNER_DATABASE_URL'),
    COMMANDER_API_DATABASE_URL: requiredEnvironment(environment, 'COMMANDER_API_DATABASE_URL'),
    COMMANDER_TENANT_AUTHORITY_DATABASE_URL: requiredEnvironment(
      environment,
      'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
    ),
    COMMANDER_SCHEDULER_DATABASE_URL: requiredEnvironment(
      environment,
      'COMMANDER_SCHEDULER_DATABASE_URL',
    ),
    COMMANDER_WORKER_DATABASE_URL: requiredEnvironment(
      environment,
      'COMMANDER_WORKER_DATABASE_URL',
    ),
    COMMANDER_ADAPTER_OPS_DATABASE_URL: requiredEnvironment(
      environment,
      'COMMANDER_ADAPTER_OPS_DATABASE_URL',
    ),
    ...(command === 'install'
      ? {
          COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL: requiredEnvironment(
            environment,
            'COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL',
          ),
        }
      : {}),
  };
  const allowedTenants = parseAllowedTenants(
    requiredEnvironment(environment, 'COMMANDER_ALLOWED_TENANTS'),
  );
  const nonCredentialEnvironment = {
    ...hostPaths,
    COMMANDER_PRECLOSURE_API_IMAGE: preclosureImage,
    COMMANDER_EXPAND_API_IMAGE: expandImage,
    COMMANDER_ENFORCE_API_IMAGE: enforceImage,
    COMMANDER_POSTGRES_IMAGE: postgresImage,
    COMMANDER_MIGRATOR_IMAGE: migratorImage,
    COMMANDER_KERNEL_OPS_IMAGE: kernelOpsImage,
    COMMANDER_WORKER_IMAGE: workerImage,
    COMMANDER_ADAPTER_OPS_IMAGE: adapterOpsImage,
    COMMANDER_DATABASE_TLS_CA_FILE: '/run/commander/database-tls/ca.crt',
    COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'compose-volume/database-ca-runtime:ca.crt',
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: expectedSpki,
  };

  return {
    command,
    projectName,
    composeFile: resolve(cwd, 'docker-compose.prod.yml'),
    composeFiles:
      command === 'install'
        ? [resolve(cwd, 'docker-compose.prod.yml'), resolve(cwd, 'docker-compose.prod.install.yml')]
        : [resolve(cwd, 'docker-compose.prod.yml')],
    composeCredentialInventory,
    stateDirectory: resolve(cwd, '.commander/tenant-cutover'),
    apiImage:
      command === 'expand' || command === 'rollback-recorded-expand' ? expandImage : enforceImage,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
    businessConfiguration: {
      allowedTenants,
      secretFileMappings: {
        databaseCaFile: '/run/commander/database-tls/ca.crt',
        proofCaFile: '/run/commander/api-proof/ca.crt',
        proofCertFile: '/run/commander/api-proof/tls.crt',
        proofKeyFile: '/run/commander/api-proof/tls.key',
      },
      sealedImages: {
        preclosureImage,
        expandImage,
        enforceImage,
        postgresImage,
        migratorImage,
        kernelOpsImage,
        workerImage,
        adapterOpsImage,
      },
      expectedDatabaseServerSpkiSha256: expectedSpki,
    },
    credentialValues,
    nonCredentialEnvironment,
    tlsHostFiles: [
      { path: hostPaths.COMMANDER_POSTGRES_TLS_CA_HOST_FILE, kind: 'public' },
      { path: hostPaths.COMMANDER_POSTGRES_TLS_CERT_HOST_FILE, kind: 'public' },
      { path: hostPaths.COMMANDER_POSTGRES_TLS_KEY_HOST_FILE, kind: 'private-key' },
      { path: hostPaths.COMMANDER_API_PROOF_CA_HOST_FILE, kind: 'public' },
      { path: hostPaths.COMMANDER_API_PROOF_CERT_HOST_FILE, kind: 'public' },
      { path: hostPaths.COMMANDER_API_PROOF_KEY_HOST_FILE, kind: 'private-key' },
    ],
  };
}

function fail(code: string): never {
  throw new Error(code);
}

function taggedSha256(tag: string, value: string): string {
  return createHash('sha256').update(`${tag}\0`, 'utf8').update(value, 'utf8').digest('hex');
}

function composeSourceSha256(sources: readonly { path: string; source: string }[]): string {
  return createHash('sha256')
    .update(
      canonicalBootstrapJson({
        format: 'commander.compose-source-set/v1',
        files: sources.map(({ path, source }) => ({
          path,
          bytesSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
        })),
      }),
      'utf8',
    )
    .digest('hex');
}

function composeContentSha256(model: ResolvedComposeModel): string {
  return taggedSha256('commander.compose-content/v1', canonicalBootstrapJson(model));
}

function commandPhase(command: ComposeCutoverCommand): ComposePhase {
  return command === 'expand' || command === 'rollback-recorded-expand' ? 'expand' : 'enforce';
}

function expectedOperationKind(command: ComposeCutoverCommand): ReadonlySet<ComposeOperationKind> {
  switch (command) {
    case 'install':
      return new Set(['fresh_enforce']);
    case 'expand':
      return new Set(['legacy_expand']);
    case 'enforce':
      return new Set(['fresh_enforce', 'enforce']);
    case 'rollback-recorded-expand':
      return new Set(['rollback_to_recorded_expand']);
  }
}

function assertFixedComposeInputContract(input: ComposeCutoverInput): void {
  const expectedInventory: ComposeCredentialInventory =
    input.command === 'install' ? 'fresh-bootstrap-v1' : 'runtime-v1';
  if (input.composeCredentialInventory !== expectedInventory) {
    fail('TENANT_CUTOVER_CREDENTIAL_INVENTORY_INVALID');
  }

  const expectedFiles =
    input.command === 'install'
      ? [input.composeFile, resolve(dirname(input.composeFile), 'docker-compose.prod.install.yml')]
      : [input.composeFile];
  if (
    !input.composeFile.endsWith('/docker-compose.prod.yml') ||
    input.composeFiles.length !== expectedFiles.length ||
    input.composeFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    fail('TENANT_CUTOVER_COMPOSE_SOURCE_SET_INVALID');
  }

  const expectedCredentialSources = [
    ...RUNTIME_CREDENTIAL_SOURCES,
    ...(input.command === 'install' ? [BOOTSTRAP_AUTHORITY_SOURCE] : []),
  ].sort();
  if (
    canonicalBootstrapJson(Object.keys(input.credentialValues).sort()) !==
    canonicalBootstrapJson(expectedCredentialSources)
  ) {
    fail('TENANT_CUTOVER_CREDENTIAL_INVENTORY_INVALID');
  }
  if (
    input.command !== 'install' &&
    (Object.hasOwn(input.nonCredentialEnvironment, BOOTSTRAP_AUTHORITY_SOURCE) ||
      Object.hasOwn(input.businessConfiguration, BOOTSTRAP_AUTHORITY_SOURCE))
  ) {
    fail('TENANT_CUTOVER_BOOTSTRAP_AUTHORITY_FORBIDDEN');
  }
}

function normalizedProjectDirectory(input: ComposeCutoverInput): string {
  return `${input.stateDirectory}/${input.projectName}`;
}

function assertOperationEvidence(
  operation: OwnerOperationEvidence,
  request: OwnerAppendRequest,
): void {
  if (!/^[1-9][0-9]*$/.test(operation.operationVersion)) {
    fail('TENANT_CUTOVER_OWNER_EVIDENCE_INVALID');
  }
  if (
    !expectedOperationKind(request.command).has(operation.operationKind) ||
    operation.phase !== request.prepared.platformBinding.phase ||
    operation.apiImage !== request.prepared.platformBinding.apiImageDigest ||
    operation.configurationSha256 !== request.prepared.configurationSha256 ||
    operation.platformBinding.kind !== 'compose' ||
    canonicalBootstrapJson(operation.platformBinding) !==
      canonicalBootstrapJson(request.prepared.platformBinding) ||
    canonicalBootstrapJson(businessWithoutPlatformBinding(operation.businessConfiguration)) !==
      canonicalBootstrapJson(
        businessWithoutPlatformBinding(request.prepared.businessConfiguration),
      ) ||
    canonicalBootstrapJson(operation.configuration) !==
      canonicalBootstrapJson(request.prepared.configuration) ||
    canonicalBootstrapSha256(operation.configuration) !== operation.configurationSha256
  ) {
    fail('TENANT_CUTOVER_OWNER_EVIDENCE_MISMATCH');
  }
}

function businessWithoutPlatformBinding(
  businessConfiguration: Record<string, unknown>,
): Record<string, unknown> {
  const { platformBinding: _platformBinding, ...business } = businessConfiguration;
  return business;
}

function assertExistingOperation(
  input: ComposeCutoverInput,
  operation: OwnerOperationEvidence,
  expectedComposeSourceSha256: string,
): void {
  if (
    !/^[1-9][0-9]*$/.test(operation.operationVersion) ||
    !expectedOperationKind(input.command).has(operation.operationKind) ||
    operation.platformBinding.kind !== 'compose' ||
    operation.platformBinding.projectName !== input.projectName ||
    operation.platformBinding.composeVariant !== 'prod' ||
    operation.platformBinding.composeCredentialInventory !== input.composeCredentialInventory ||
    operation.platformBinding.composeSourceSha256 !== expectedComposeSourceSha256 ||
    operation.platformBinding.composeCliVersion !== COMPOSE_CLI_VERSION ||
    operation.platformBinding.phase !== commandPhase(input.command) ||
    operation.platformBinding.apiImageDigest !== input.apiImage ||
    operation.platformBinding.apiProofUrl !== input.apiProofUrl ||
    operation.phase !== commandPhase(input.command) ||
    operation.apiImage !== input.apiImage ||
    canonicalBootstrapJson(businessWithoutPlatformBinding(operation.businessConfiguration)) !==
      canonicalBootstrapJson(input.businessConfiguration) ||
    canonicalBootstrapJson(operation.configuration) !==
      canonicalBootstrapJson({
        ...businessWithoutPlatformBinding(operation.businessConfiguration),
        platformBinding: operation.platformBinding,
        operationAuditNonce: operation.configuration.operationAuditNonce,
      }) ||
    typeof operation.configuration.operationAuditNonce !== 'string' ||
    operation.configuration.operationAuditNonce.length === 0 ||
    canonicalBootstrapSha256(operation.configuration) !== operation.configurationSha256
  ) {
    fail('TENANT_CUTOVER_OWNER_EVIDENCE_MISMATCH');
  }
}

function renderEnvironment(
  input: ComposeCutoverInput,
  operation: Pick<OwnerOperationEvidence, 'phase' | 'apiImage' | 'configurationSha256'> &
    Partial<Pick<OwnerOperationEvidence, 'businessConfiguration'>>,
  sentinel: boolean,
  nonCredentialEnvironment: Readonly<Record<string, string>> = input.nonCredentialEnvironment,
): Record<string, string> {
  const allowedTenants = (operation.businessConfiguration?.allowedTenants ??
    input.businessConfiguration.allowedTenants) as string[];
  const environment: Record<string, string> = {
    ...nonCredentialEnvironment,
    COMMANDER_API_IMAGE: operation.apiImage,
    COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: operation.phase,
    COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST: operation.apiImage.slice(
      operation.apiImage.lastIndexOf('@') + 1,
    ),
    COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: sentinel
      ? CONFIGURATION_DIGEST_SENTINEL
      : operation.configurationSha256,
    COMMANDER_ALLOWED_TENANTS: allowedTenants.join(','),
  };
  for (const [key, value] of Object.entries(input.credentialValues)) {
    environment[key] = sentinel ? `${CREDENTIAL_SENTINEL_PREFIX}${key}` : value;
  }
  return environment;
}

async function verifyResolvedModelForOperation(
  input: ComposeCutoverInput,
  operation: OwnerOperationEvidence,
  compose: ComposeProcessPort,
  nonCredentialEnvironment: Readonly<Record<string, string>> = input.nonCredentialEnvironment,
): Promise<void> {
  const candidateModel = await compose.render(
    renderEnvironment(input, operation, true, nonCredentialEnvironment),
  );
  if (composeContentSha256(candidateModel) !== operation.platformBinding.composeContentSha256) {
    fail('TENANT_CUTOVER_RESOLVED_MODEL_DRIFT');
  }
  const launchModel = await compose.render(
    renderEnvironment(input, operation, false, nonCredentialEnvironment),
  );
  assertLaunchModelMatchesCandidate({
    candidateModel,
    launchModel,
    configurationSha256: operation.configurationSha256,
    credentialValues: input.credentialValues,
  });
}

function assertArtifactBusinessConfiguration(operation: OwnerOperationEvidence): void {
  const allowedTenants = operation.businessConfiguration.allowedTenants;
  const secretFileMappings = operation.businessConfiguration.secretFileMappings;
  if (
    !Array.isArray(allowedTenants) ||
    !allowedTenants.every((tenant) => typeof tenant === 'string')
  ) {
    fail('TENANT_CUTOVER_ALLOWLIST_INVALID');
  }
  if (
    !secretFileMappings ||
    typeof secretFileMappings !== 'object' ||
    Array.isArray(secretFileMappings)
  ) {
    fail('TENANT_CUTOVER_SECRET_MAPPING_INVALID');
  }
}

function operationArtifactFor(operation: OwnerOperationEvidence): Record<string, unknown> {
  assertArtifactBusinessConfiguration(operation);
  return {
    schema: 'tenant-cutover-operation/v1',
    operationVersion: operation.operationVersion,
    operationKind: operation.operationKind,
    predecessorOperationVersion: operation.predecessor?.operationVersion ?? null,
    platformBinding: operation.platformBinding,
    businessConfiguration: operation.businessConfiguration,
    configuration: operation.configuration,
    configurationSha256: operation.configurationSha256,
  };
}

function assertEnvironmentValue(value: string): void {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    fail('TENANT_CUTOVER_DOTENV_VALUE_INVALID');
  }
}

function dotenvEnvironmentFor(
  operation: OwnerOperationEvidence,
  nonCredentialEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowedTenants = operation.businessConfiguration.allowedTenants as string[];
  const imageDigest = operation.apiImage.slice(operation.apiImage.lastIndexOf('@') + 1);
  return {
    ...nonCredentialEnvironment,
    COMMANDER_API_IMAGE: operation.apiImage,
    COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: operation.phase,
    COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST: imageDigest,
    COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: operation.configurationSha256,
    COMMANDER_ALLOWED_TENANTS: allowedTenants.join(','),
  };
}

function dotenvFor(
  operation: OwnerOperationEvidence,
  nonCredentialEnvironment: Readonly<Record<string, string>>,
): string {
  const environment = dotenvEnvironmentFor(operation, nonCredentialEnvironment);
  return `${Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail('TENANT_CUTOVER_DOTENV_KEY_INVALID');
      assertEnvironmentValue(value);
      return `${key}=${value}`;
    })
    .join('\n')}\n`;
}

async function ensureArtifactDirectories(
  input: ComposeCutoverInput,
  fs: CutoverFileSystemPort,
): Promise<void> {
  const projectDirectory = normalizedProjectDirectory(input);
  for (const path of [
    input.stateDirectory,
    projectDirectory,
    `${projectDirectory}/requests`,
    `${projectDirectory}/operations`,
  ]) {
    await fs.mkdir(path, { mode: 0o700, uid: 0, gid: 0 });
  }
}

async function persistOperation(
  input: ComposeCutoverInput,
  operation: OwnerOperationEvidence,
  fs: CutoverFileSystemPort,
  nonCredentialEnvironment: Readonly<Record<string, string>> = input.nonCredentialEnvironment,
): Promise<string> {
  const projectDirectory = normalizedProjectDirectory(input);
  const operationDirectory = `${projectDirectory}/operations`;
  const metadata = `${canonicalBootstrapJson(operationArtifactFor(operation))}\n`;
  const dotenv = dotenvFor(operation, nonCredentialEnvironment);
  const options = { mode: 0o600, uid: 0, gid: 0 } as const;
  await fs.writeFileAtomic(
    `${operationDirectory}/${operation.operationVersion}.json`,
    metadata,
    options,
  );
  const envFile = `${operationDirectory}/${operation.operationVersion}.env`;
  await fs.writeFileAtomic(envFile, dotenv, options);
  await fs.writeFileAtomic(`${projectDirectory}/active.env`, dotenv, options);
  return envFile;
}

interface LoadedOperationArtifact {
  envFile: string;
  dotenv: string;
  environment: Record<string, string>;
}

function parsePersistedDotenv(
  value: string,
  credentialNames: ReadonlySet<string>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  if (!value.endsWith('\n')) fail('TENANT_CUTOVER_OPERATION_ARTIFACT_DRIFT');
  for (const line of value.slice(0, -1).split('\n')) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    const entryValue = line.slice(separator + 1);
    if (
      separator <= 0 ||
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      Object.hasOwn(environment, key) ||
      credentialNames.has(key)
    ) {
      fail('TENANT_CUTOVER_OPERATION_ARTIFACT_DRIFT');
    }
    assertEnvironmentValue(entryValue);
    environment[key] = entryValue;
  }
  return environment;
}

async function loadPersistedOperation(
  input: ComposeCutoverInput,
  operation: OwnerOperationEvidence,
  fs: CutoverFileSystemPort,
): Promise<LoadedOperationArtifact> {
  const operationDirectory = `${normalizedProjectDirectory(input)}/operations`;
  const metadata = `${canonicalBootstrapJson(operationArtifactFor(operation))}\n`;
  let persistedMetadata: string;
  let persistedDotenv: string;
  try {
    persistedMetadata = await fs.readFile(
      `${operationDirectory}/${operation.operationVersion}.json`,
    );
    persistedDotenv = await fs.readFile(`${operationDirectory}/${operation.operationVersion}.env`);
  } catch {
    fail('TENANT_CUTOVER_OPERATION_ARTIFACT_MISSING');
  }
  if (persistedMetadata !== metadata) {
    fail('TENANT_CUTOVER_OPERATION_ARTIFACT_DRIFT');
  }
  const environment = parsePersistedDotenv(
    persistedDotenv,
    new Set(Object.keys(input.credentialValues)),
  );
  const allowedTenants = operation.businessConfiguration.allowedTenants as string[];
  if (
    environment.COMMANDER_API_IMAGE !== operation.apiImage ||
    environment.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE !== operation.phase ||
    environment.COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST !==
      operation.apiImage.slice(operation.apiImage.lastIndexOf('@') + 1) ||
    environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256 !== operation.configurationSha256 ||
    environment.COMMANDER_ALLOWED_TENANTS !== allowedTenants.join(',')
  ) {
    fail('TENANT_CUTOVER_OPERATION_ARTIFACT_DRIFT');
  }
  return {
    envFile: `${operationDirectory}/${operation.operationVersion}.env`,
    dotenv: persistedDotenv,
    environment,
  };
}

async function activatePersistedOperation(
  input: ComposeCutoverInput,
  artifact: LoadedOperationArtifact,
  fs: CutoverFileSystemPort,
): Promise<void> {
  await fs.writeFileAtomic(`${normalizedProjectDirectory(input)}/active.env`, artifact.dotenv, {
    mode: 0o600,
    uid: 0,
    gid: 0,
  });
}

function assertRecoveryEvidence(
  failed: OwnerOperationEvidence,
  recovery: OwnerOperationEvidence,
): void {
  const predecessor = failed.predecessor;
  if (!predecessor) fail('TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED');
  const failedBusiness = businessWithoutPlatformBinding(failed.businessConfiguration);
  const expectedBusiness = {
    ...failedBusiness,
    secretFileMappings: predecessor.businessConfiguration.secretFileMappings,
  };
  if (
    recovery.operationKind !== 'recover_runtime_after_enforce_failure' ||
    !/^[1-9][0-9]*$/.test(recovery.operationVersion) ||
    BigInt(recovery.operationVersion) <= BigInt(failed.operationVersion) ||
    recovery.platformBinding.kind !== 'compose' ||
    recovery.platformBinding.projectName !== predecessor.platformBinding.projectName ||
    recovery.platformBinding.composeVariant !== 'prod' ||
    recovery.platformBinding.composeSourceSha256 !==
      predecessor.platformBinding.composeSourceSha256 ||
    recovery.platformBinding.composeCliVersion !== COMPOSE_CLI_VERSION ||
    recovery.platformBinding.phase !== predecessor.phase ||
    recovery.platformBinding.apiImageDigest !== predecessor.apiImage ||
    recovery.platformBinding.apiProofUrl !== predecessor.platformBinding.apiProofUrl ||
    recovery.phase !== predecessor.phase ||
    recovery.apiImage !== predecessor.apiImage ||
    canonicalBootstrapJson(businessWithoutPlatformBinding(recovery.businessConfiguration)) !==
      canonicalBootstrapJson(expectedBusiness) ||
    canonicalBootstrapJson(recovery.configuration) !==
      canonicalBootstrapJson({
        ...businessWithoutPlatformBinding(recovery.businessConfiguration),
        platformBinding: recovery.platformBinding,
        operationAuditNonce: recovery.configuration.operationAuditNonce,
      }) ||
    typeof recovery.configuration.operationAuditNonce !== 'string' ||
    recovery.configuration.operationAuditNonce.length === 0 ||
    recovery.configuration.operationAuditNonce === failed.configuration.operationAuditNonce ||
    recovery.configuration.operationAuditNonce === predecessor.configuration.operationAuditNonce ||
    canonicalBootstrapSha256(recovery.configuration) !== recovery.configurationSha256
  ) {
    fail('TENANT_CUTOVER_RECOVERY_EVIDENCE_MISMATCH');
  }
}

async function recoverFailedRollout(
  input: ComposeCutoverInput,
  failed: OwnerOperationEvidence,
  ports: ComposeCutoverPorts,
): Promise<ComposeCutoverResult> {
  const predecessor = failed.predecessor;
  if (!predecessor) {
    fail(
      input.command === 'expand'
        ? 'TENANT_CUTOVER_EXPAND_PREDECESSOR_REQUIRED'
        : 'TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED',
    );
  }
  try {
    const predecessorArtifact = await loadPersistedOperation(input, predecessor, ports.fs);
    await verifyResolvedModelForOperation(
      input,
      predecessor,
      ports.compose,
      predecessorArtifact.environment,
    );
    await activatePersistedOperation(input, predecessorArtifact, ports.fs);
    await ports.compose.rollout(
      predecessor,
      predecessorArtifact.envFile,
      Object.keys(predecessorArtifact.environment),
    );
  } catch {
    fail('TENANT_CUTOVER_PREDECESSOR_RESTORE_FAILED');
  }

  if (input.command === 'expand') fail('TENANT_CUTOVER_EXPAND_ROLLOUT_FAILED');
  if (input.command !== 'enforce') fail('TENANT_CUTOVER_ROLLOUT_FAILED');

  let historicalProof: boolean;
  try {
    historicalProof = await ports.compose.prove(predecessor);
  } catch {
    fail('TENANT_CUTOVER_HISTORICAL_PROOF_CHECK_FAILED');
  }
  if (historicalProof) fail('TENANT_CUTOVER_HISTORICAL_PROOF_ACCEPTED');

  let recovery: OwnerOperationEvidence;
  try {
    recovery = await ports.owner.recover(failed);
  } catch {
    fail('TENANT_CUTOVER_RECOVERY_APPEND_FAILED');
  }
  assertRecoveryEvidence(failed, recovery);
  const predecessorArtifact = await loadPersistedOperation(input, predecessor, ports.fs);
  await verifyResolvedModelForOperation(
    input,
    recovery,
    ports.compose,
    predecessorArtifact.environment,
  );
  const recoveryEnv = await persistOperation(
    input,
    recovery,
    ports.fs,
    predecessorArtifact.environment,
  );
  try {
    await ports.compose.rollout(
      recovery,
      recoveryEnv,
      Object.keys(dotenvEnvironmentFor(recovery, predecessorArtifact.environment)),
    );
    if (!(await ports.compose.prove(recovery))) fail('TENANT_CUTOVER_RECOVERY_PROOF_FAILED');
  } catch (error) {
    if (error instanceof Error && error.message === 'TENANT_CUTOVER_RECOVERY_PROOF_FAILED') {
      throw error;
    }
    fail('TENANT_CUTOVER_RECOVERY_ROLLOUT_FAILED');
  }
  return { action: 'recovered', operation: recovery };
}

function assertBusinessConfiguration(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (CALLER_EVIDENCE_KEYS.has(key)) fail('TENANT_CUTOVER_CALLER_EVIDENCE_FORBIDDEN');
  }
}

function environmentEntries(
  model: ResolvedComposeModel,
): Array<{ environment: Record<string, unknown>; key: string }> {
  const entries: Array<{ environment: Record<string, unknown>; key: string }> = [];
  for (const service of Object.values(model.services ?? {})) {
    if (!service?.environment || Array.isArray(service.environment)) continue;
    for (const key of Object.keys(service.environment)) {
      entries.push({ environment: service.environment, key });
    }
  }
  return entries;
}

function countEnvironmentValue(model: ResolvedComposeModel, value: string): number {
  return environmentEntries(model).filter(({ environment, key }) => environment[key] === value)
    .length;
}

function cloneModel(model: ResolvedComposeModel): ResolvedComposeModel {
  return structuredClone(model);
}

function parseJsonObject(value: string, errorCode: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(errorCode);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(errorCode);
  return parsed as Record<string, unknown>;
}

type OwnerOperationEvidenceFields = Omit<OwnerOperationEvidence, 'predecessor'> & {
  predecessor: unknown;
};

function ownerOperationEvidenceFields(value: unknown): OwnerOperationEvidenceFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  }
  const operation = value as Record<string, unknown>;
  const expectedKeys = [
    'operationVersion',
    'operationKind',
    'phase',
    'apiImage',
    'platformBinding',
    'businessConfiguration',
    'configuration',
    'configurationSha256',
    'predecessor',
  ];
  if (
    Object.keys(operation).length !== expectedKeys.length ||
    Object.keys(operation).some((key) => !expectedKeys.includes(key))
  ) {
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  }
  if (
    typeof operation.operationVersion !== 'string' ||
    !/^[1-9][0-9]*$/.test(operation.operationVersion) ||
    typeof operation.operationKind !== 'string' ||
    ![
      'legacy_expand',
      'fresh_enforce',
      'enforce',
      'recover_runtime_after_enforce_failure',
      'rollback_to_recorded_expand',
    ].includes(operation.operationKind) ||
    (operation.phase !== 'expand' && operation.phase !== 'enforce') ||
    typeof operation.apiImage !== 'string' ||
    !operation.platformBinding ||
    typeof operation.platformBinding !== 'object' ||
    Array.isArray(operation.platformBinding) ||
    !operation.businessConfiguration ||
    typeof operation.businessConfiguration !== 'object' ||
    Array.isArray(operation.businessConfiguration) ||
    !operation.configuration ||
    typeof operation.configuration !== 'object' ||
    Array.isArray(operation.configuration) ||
    typeof operation.configurationSha256 !== 'string'
  ) {
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  }
  const platformBinding = operation.platformBinding as unknown as ComposePlatformBinding;
  const businessConfiguration = operation.businessConfiguration as Record<string, unknown>;
  const configuration = operation.configuration as Record<string, unknown>;
  if (
    canonicalBootstrapSha256(configuration) !== operation.configurationSha256 ||
    platformBinding.kind !== 'compose' ||
    platformBinding.apiImageDigest !== operation.apiImage ||
    platformBinding.phase !== operation.phase ||
    typeof configuration.operationAuditNonce !== 'string' ||
    canonicalBootstrapJson(configuration) !==
      canonicalBootstrapJson({
        ...businessConfiguration,
        platformBinding,
        operationAuditNonce: configuration.operationAuditNonce,
      })
  ) {
    fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  }
  return {
    operationVersion: operation.operationVersion,
    operationKind: operation.operationKind as ComposeOperationKind,
    phase: operation.phase,
    apiImage: operation.apiImage,
    platformBinding,
    businessConfiguration,
    configuration: configuration as Record<string, unknown> & { operationAuditNonce: string },
    configurationSha256: operation.configurationSha256,
    predecessor: operation.predecessor,
  };
}

function ownerOperationEvidence(value: unknown): OwnerOperationEvidence {
  const operation = ownerOperationEvidenceFields(value);
  if (operation.predecessor === null) {
    return { ...operation, predecessor: null };
  }
  const predecessor = ownerOperationEvidenceFields(operation.predecessor);
  if (predecessor.predecessor !== null) fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  return {
    ...operation,
    predecessor: { ...predecessor, predecessor: null },
  };
}

function dockerComposeBase(input: ComposeCutoverInput): string[] {
  return [
    'compose',
    '--project-name',
    input.projectName,
    ...input.composeFiles.flatMap((composeFile) => ['-f', composeFile]),
  ];
}

function dockerOwnerArgs(input: ComposeCutoverInput, action: string): string[] {
  return [
    ...dockerComposeBase(input),
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'node',
    'kernel-migrate',
    'packages/kernel/dist/migrate.js',
    action,
  ];
}

function dockerProofArgs(input: ComposeCutoverInput, relayDirectory: string): string[] {
  return [
    ...dockerComposeBase(input),
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '-u',
    '0:0',
    '-v',
    `${relayDirectory}:${relayDirectory}:ro`,
    '-e',
    'COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET',
    '-e',
    'COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT',
    '-e',
    'COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN',
    '--entrypoint',
    'node',
    'kernel-migrate',
    'packages/kernel/dist/migrate.js',
    'tenant-cutover-prove',
  ];
}

export function createDockerComposeProcessPort(
  input: ComposeCutoverInput,
  command: ExternalCommandPort,
  baseEnvironment: Readonly<Record<string, string>>,
  options: DockerComposeProcessPortOptions = {},
): ComposeProcessPort {
  const authority = options.authority ?? createDockerCliTopologyAuthority(command, baseEnvironment);
  const relayDirectory = options.relayDirectory ?? resolve(input.stateDirectory, 'proof-relay');
  return {
    async render(environment) {
      const result = await command.run({
        program: 'docker',
        args: [...dockerComposeBase(input), 'config', '--format', 'json', '--no-path-resolution'],
        environment: { ...baseEnvironment, ...environment },
      });
      return parseJsonObject(result.stdout, 'TENANT_CUTOVER_COMPOSE_RENDER_INVALID');
    },
    async startFreshBootstrap(environment, environmentKeys) {
      const subprocessEnvironment = { ...baseEnvironment };
      for (const key of environmentKeys) delete subprocessEnvironment[key];
      Object.assign(subprocessEnvironment, environment);
      await command.run({
        program: 'docker',
        args: [
          ...dockerComposeBase(input),
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '120',
          '--no-deps',
          '--force-recreate',
          'postgres-init-materialize',
          'tls-materialize',
          'postgres',
        ],
        environment: subprocessEnvironment,
      });
    },
    async rollout(operation, envFile, environmentKeys) {
      const environment = { ...baseEnvironment };
      for (const key of environmentKeys) delete environment[key];
      const composeWithOperation = [
        'compose',
        '--project-name',
        input.projectName,
        '--env-file',
        envFile,
        ...input.composeFiles.flatMap((composeFile) => ['-f', composeFile]),
      ];
      await command.run({
        program: 'docker',
        args: [
          ...composeWithOperation,
          'run',
          '--rm',
          '--no-deps',
          '-T',
          '-e',
          `COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE=${operation.phase}`,
          '--entrypoint',
          'node',
          'kernel-migrate',
          'packages/kernel/dist/migrate.js',
          'tenant-cutover-migrate',
        ],
        environment,
      });
      await command.run({
        program: 'docker',
        args: [
          ...composeWithOperation,
          'up',
          '-d',
          '--no-deps',
          '--force-recreate',
          ...(operation.operationKind === 'legacy_expand'
            ? ['api']
            : ['api', 'kernel-ops', 'worker', 'adapter-ops']),
        ],
        environment,
      });
    },
    async prove(operation) {
      return withComposeTopologyRelay(
        {
          directory: relayDirectory,
          attemptId: randomBytes(32).toString('base64url'),
          projectName: input.projectName,
          serviceImages: { api: operation.apiImage },
          namedNetworks: [`${input.projectName}_default`],
          authority,
        },
        async (relay) => {
          const result = await command.run({
            program: 'docker',
            args: dockerProofArgs(input, relayDirectory),
            environment: {
              ...baseEnvironment,
              COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: relay.socketPath,
              COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: relay.attemptId,
              COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: relay.token,
            },
            stdin: '',
          });
          const parsed = parseJsonObject(result.stdout, 'TENANT_CUTOVER_PROOF_RESPONSE_INVALID');
          if (typeof parsed.proven !== 'boolean') fail('TENANT_CUTOVER_PROOF_RESPONSE_INVALID');
          return parsed.proven;
        },
      );
    },
  };
}

export function createDockerOwnerPort(
  input: ComposeCutoverInput,
  command: ExternalCommandPort,
  baseEnvironment: Readonly<Record<string, string>>,
): ComposeOwnerPort {
  function ownerEnvironment(payload: unknown): Record<string, string> {
    const environment = { ...baseEnvironment };
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const prepared =
      record.prepared && typeof record.prepared === 'object'
        ? (record.prepared as Record<string, unknown>)
        : undefined;
    const binding =
      prepared?.platformBinding && typeof prepared.platformBinding === 'object'
        ? (prepared.platformBinding as Record<string, unknown>)
        : record.platformIntent && typeof record.platformIntent === 'object'
          ? (record.platformIntent as Record<string, unknown>)
          : record;
    const business =
      prepared?.businessConfiguration && typeof prepared.businessConfiguration === 'object'
        ? (prepared.businessConfiguration as Record<string, unknown>)
        : record.businessConfiguration && typeof record.businessConfiguration === 'object'
          ? (record.businessConfiguration as Record<string, unknown>)
          : undefined;
    const phase = typeof binding?.phase === 'string' ? binding.phase : undefined;
    const apiImage =
      typeof binding?.apiImageDigest === 'string'
        ? binding.apiImageDigest
        : typeof record.apiImage === 'string'
          ? record.apiImage
          : undefined;
    const configurationSha256 =
      prepared && typeof prepared.configurationSha256 === 'string'
        ? prepared.configurationSha256
        : record.platformIntent
          ? CONFIGURATION_DIGEST_SENTINEL
          : undefined;
    if (phase) environment.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE = phase;
    if (apiImage) {
      environment.COMMANDER_API_IMAGE = apiImage;
      environment.COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST = apiImage.slice(
        apiImage.lastIndexOf('@') + 1,
      );
    }
    if (configurationSha256) {
      environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256 = configurationSha256;
    }
    const allowedTenants = business?.allowedTenants;
    if (
      Array.isArray(allowedTenants) &&
      allowedTenants.every((tenant) => typeof tenant === 'string')
    ) {
      environment.COMMANDER_ALLOWED_TENANTS = allowedTenants.join(',');
    }
    return environment;
  }
  async function invoke(action: string, payload: unknown): Promise<Record<string, unknown>> {
    const result = await command.run({
      program: 'docker',
      args: dockerOwnerArgs(input, action),
      environment: ownerEnvironment(payload),
      stdin: `${canonicalBootstrapJson(payload)}\n`,
    });
    return parseJsonObject(result.stdout, 'TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
  }
  function ownerAppendPayload(request: OwnerAppendRequest): Record<string, unknown> {
    return {
      schema: 'tenant-cutover-request/v1',
      command: request.command,
      prepared: request.prepared,
    };
  }
  return {
    async plan(request) {
      const parsed = await invoke('tenant-cutover-plan', {
        schema: 'tenant-cutover-plan/v1',
        command: request.command,
        platformIntent: request.platformIntent,
        businessConfiguration: request.businessConfiguration,
      });
      if (parsed.action === 'append') return { action: 'append' };
      if (
        (parsed.action === 'return_current' || parsed.action === 'retry_rollout') &&
        parsed.operation &&
        typeof parsed.operation === 'object' &&
        !Array.isArray(parsed.operation)
      ) {
        return {
          action: parsed.action,
          operation: ownerOperationEvidence(parsed.operation),
        };
      }
      fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
    },
    async append(request) {
      const parsed = await invoke('tenant-cutover-append', ownerAppendPayload(request));
      if (
        !parsed.operation ||
        typeof parsed.operation !== 'object' ||
        Array.isArray(parsed.operation)
      ) {
        fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
      }
      return ownerOperationEvidence(parsed.operation);
    },
    async recover() {
      const parsed = await invoke('tenant-cutover-recover', { failed: {} });
      if (
        !parsed.operation ||
        typeof parsed.operation !== 'object' ||
        Array.isArray(parsed.operation)
      ) {
        fail('TENANT_CUTOVER_OWNER_RESPONSE_INVALID');
      }
      return ownerOperationEvidence(parsed.operation);
    },
  };
}

export async function preflightTlsHostFiles(
  files: readonly TlsHostFile[],
  fs: CutoverFileSystemPort,
): Promise<void> {
  for (const file of files) {
    if (!isAbsolute(file.path)) fail('TENANT_CUTOVER_TLS_FILE_PATH_INVALID');
    let stat: CutoverFileStat;
    let canonicalPath: string;
    try {
      stat = await fs.lstat(file.path);
      canonicalPath = await fs.realpath(file.path);
    } catch {
      fail('TENANT_CUTOVER_TLS_FILE_INVALID');
    }
    if (canonicalPath !== file.path || stat.isSymbolicLink || !stat.isFile) {
      fail('TENANT_CUTOVER_TLS_FILE_TYPE_INVALID');
    }
    const expectedMode = file.kind === 'private-key' ? 0o400 : 0o444;
    if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== expectedMode) {
      fail('TENANT_CUTOVER_TLS_FILE_PERMISSION_INVALID');
    }
  }
}

export function prepareComposeConfiguration(input: {
  projectName: string;
  composeSource: string;
  installComposeSource?: string;
  composeCredentialInventory: ComposeCredentialInventory;
  phase: ComposePhase;
  apiImage: string;
  apiProofUrl: string;
  candidateModel: ResolvedComposeModel;
  businessConfiguration: Record<string, unknown>;
  operationAuditNonce: string;
}): PreparedComposeConfiguration {
  if (!PROJECT_PATTERN.test(input.projectName)) fail('TENANT_CUTOVER_PROJECT_INVALID');
  if (!API_IMAGE_PATTERN.test(input.apiImage)) fail('TENANT_CUTOVER_IMAGE_NOT_DIGEST_PINNED');
  if (input.apiProofUrl !== 'https://api:9443/ready/tenant-authority/v1') {
    fail('TENANT_CUTOVER_PROOF_URL_INVALID');
  }
  if (input.operationAuditNonce.length === 0) fail('TENANT_CUTOVER_NONCE_INVALID');
  assertBusinessConfiguration(input.businessConfiguration);
  if (countEnvironmentValue(input.candidateModel, CONFIGURATION_DIGEST_SENTINEL) !== 1) {
    fail('TENANT_CUTOVER_CONFIGURATION_SENTINEL_INVALID');
  }

  const platformBinding: ComposePlatformBinding = {
    kind: 'compose',
    projectName: input.projectName,
    composeVariant: 'prod',
    composeCredentialInventory: input.composeCredentialInventory,
    composeSourceSha256: composeSourceSha256([
      { path: 'docker-compose.prod.yml', source: input.composeSource },
      ...(input.composeCredentialInventory === 'fresh-bootstrap-v1'
        ? [
            {
              path: 'docker-compose.prod.install.yml',
              source:
                input.installComposeSource ??
                fail('TENANT_CUTOVER_COMPOSE_INSTALL_SOURCE_UNAVAILABLE'),
            },
          ]
        : []),
    ]),
    composeCliVersion: COMPOSE_CLI_VERSION,
    composeContentSha256: composeContentSha256(input.candidateModel),
    phase: input.phase,
    apiImageDigest: input.apiImage,
    apiProofUrl: input.apiProofUrl,
  };
  const businessConfiguration = {
    ...input.businessConfiguration,
    platformBinding,
  };
  const configuration = {
    ...businessConfiguration,
    operationAuditNonce: input.operationAuditNonce,
  };
  return {
    platformBinding,
    businessConfiguration,
    configuration,
    configurationSha256: canonicalBootstrapSha256(configuration),
  };
}

export function assertLaunchModelMatchesCandidate(input: {
  candidateModel: ResolvedComposeModel;
  launchModel: ResolvedComposeModel;
  configurationSha256: string;
  credentialValues: Readonly<Record<string, string>>;
}): void {
  if (!SHA256_PATTERN.test(input.configurationSha256)) {
    fail('TENANT_CUTOVER_CONFIGURATION_DIGEST_INVALID');
  }
  const normalized = cloneModel(input.launchModel);
  let digestReplacements = 0;
  for (const { environment, key } of environmentEntries(normalized)) {
    if (environment[key] === input.configurationSha256) {
      environment[key] = CONFIGURATION_DIGEST_SENTINEL;
      digestReplacements += 1;
    }
  }
  if (digestReplacements !== 1) fail('TENANT_CUTOVER_CONFIGURATION_DIGEST_OCCURRENCE_INVALID');

  const observedCredentialSources = new Map<string, number>();
  for (const [serviceName, candidateService] of Object.entries(
    input.candidateModel.services ?? {},
  )) {
    if (!candidateService.environment || Array.isArray(candidateService.environment)) continue;
    const launchService = normalized.services?.[serviceName];
    if (!launchService?.environment || Array.isArray(launchService.environment)) {
      fail('TENANT_CUTOVER_RESOLVED_MODEL_DRIFT');
    }
    for (const [targetKey, candidateValue] of Object.entries(candidateService.environment)) {
      if (
        typeof candidateValue !== 'string' ||
        !candidateValue.startsWith(CREDENTIAL_SENTINEL_PREFIX)
      ) {
        continue;
      }
      const sourceName = candidateValue.slice(CREDENTIAL_SENTINEL_PREFIX.length);
      const credential = input.credentialValues[sourceName];
      if (
        !/^[A-Z][A-Z0-9_]*$/.test(sourceName) ||
        credential === undefined ||
        launchService.environment[targetKey] !== credential
      ) {
        fail('TENANT_CUTOVER_CREDENTIAL_SENTINEL_INVALID');
      }
      launchService.environment[targetKey] = candidateValue;
      observedCredentialSources.set(
        sourceName,
        (observedCredentialSources.get(sourceName) ?? 0) + 1,
      );
    }
  }
  const expectedCredentialSources = Object.keys(input.credentialValues).sort();
  if (
    canonicalBootstrapJson([...observedCredentialSources.keys()].sort()) !==
      canonicalBootstrapJson(expectedCredentialSources) ||
    [...observedCredentialSources.values()].some((count) => count !== 1)
  ) {
    fail('TENANT_CUTOVER_CREDENTIAL_SENTINEL_INVALID');
  }
  if (canonicalBootstrapJson(normalized) !== canonicalBootstrapJson(input.candidateModel)) {
    fail('TENANT_CUTOVER_RESOLVED_MODEL_DRIFT');
  }
}

async function runComposeTenantCutoverImpl(
  input: ComposeCutoverInput,
  ports: ComposeCutoverPorts,
): Promise<ComposeCutoverResult> {
  if (!isAbsolute(input.composeFile) || !isAbsolute(input.stateDirectory)) {
    fail('TENANT_CUTOVER_PATH_INVALID');
  }
  if (!PROJECT_PATTERN.test(input.projectName)) fail('TENANT_CUTOVER_PROJECT_INVALID');
  assertFixedComposeInputContract(input);
  assertBusinessConfiguration(input.businessConfiguration);
  await preflightTlsHostFiles(input.tlsHostFiles, ports.fs);
  let caPublicBytes: string;
  try {
    caPublicBytes = await ports.fs.readFile(
      input.nonCredentialEnvironment.COMMANDER_POSTGRES_TLS_CA_HOST_FILE!,
    );
  } catch {
    fail('TENANT_CUTOVER_DATABASE_CA_UNAVAILABLE');
  }
  const databasePeerBindingInput = createTask1DatabasePeerBindingInput({
    roleUrls: {
      'adapter-ops': input.credentialValues.COMMANDER_ADAPTER_OPS_DATABASE_URL!,
      app: input.credentialValues.COMMANDER_API_DATABASE_URL!,
      owner: input.credentialValues.COMMANDER_OWNER_DATABASE_URL!,
      scheduler: input.credentialValues.COMMANDER_SCHEDULER_DATABASE_URL!,
      'tenant-authority': input.credentialValues.COMMANDER_TENANT_AUTHORITY_DATABASE_URL!,
      worker: input.credentialValues.COMMANDER_WORKER_DATABASE_URL!,
    },
    expectedServerSpkiSha256:
      input.nonCredentialEnvironment.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256!,
    caMountIdentity: input.nonCredentialEnvironment.COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY!,
    caPath: input.nonCredentialEnvironment.COMMANDER_DATABASE_TLS_CA_FILE!,
    caPublicBytes,
  });
  input = {
    ...input,
    businessConfiguration: { ...input.businessConfiguration, databasePeerBindingInput },
  };
  let composeSources: Array<{ path: string; source: string }>;
  try {
    composeSources = await Promise.all(
      input.composeFiles.map(async (composeFile) => ({
        path: composeFile.endsWith('/docker-compose.prod.install.yml')
          ? 'docker-compose.prod.install.yml'
          : composeFile.endsWith('/docker-compose.prod.yml')
            ? 'docker-compose.prod.yml'
            : fail('TENANT_CUTOVER_COMPOSE_SOURCE_PATH_INVALID'),
        source: await ports.fs.readFile(composeFile),
      })),
    );
  } catch {
    fail('TENANT_CUTOVER_COMPOSE_SOURCE_UNAVAILABLE');
  }
  const expectedComposeSourceSha256 = composeSourceSha256(composeSources);
  const phase = commandPhase(input.command);
  const planRequest: OwnerPlanRequest = {
    command: input.command,
    platformIntent: {
      kind: 'compose',
      projectName: input.projectName,
      composeVariant: 'prod',
      composeCredentialInventory: input.composeCredentialInventory,
      composeSourceSha256: expectedComposeSourceSha256,
      composeCliVersion: COMPOSE_CLI_VERSION,
      phase,
      apiImageDigest: input.apiImage,
      apiProofUrl: input.apiProofUrl,
    },
    businessConfiguration: input.businessConfiguration,
  };

  let candidateModel: ResolvedComposeModel | undefined;
  if (input.command === 'install') {
    const candidateEnvironment = renderEnvironment(
      input,
      { phase, apiImage: input.apiImage, configurationSha256: CONFIGURATION_DIGEST_SENTINEL },
      true,
    );
    candidateModel = await ports.compose.render(candidateEnvironment);
    const provisionalEnvironment = renderEnvironment(
      input,
      { phase, apiImage: input.apiImage, configurationSha256: PROVISIONAL_CONFIGURATION_SHA256 },
      false,
    );
    const provisionalModel = await ports.compose.render(provisionalEnvironment);
    assertLaunchModelMatchesCandidate({
      candidateModel,
      launchModel: provisionalModel,
      configurationSha256: PROVISIONAL_CONFIGURATION_SHA256,
      credentialValues: input.credentialValues,
    });
    await ports.compose.startFreshBootstrap(
      provisionalEnvironment,
      Object.keys(provisionalEnvironment),
    );
  }

  const plan = await ports.owner.plan(planRequest);
  if (plan.action === 'return_current') {
    assertExistingOperation(input, plan.operation, expectedComposeSourceSha256);
    return { action: 'returned_current', operation: plan.operation };
  }
  if (plan.action === 'retry_rollout') {
    assertExistingOperation(input, plan.operation, expectedComposeSourceSha256);
    await ensureArtifactDirectories(input, ports.fs);
    const artifact = await loadPersistedOperation(input, plan.operation, ports.fs);
    await verifyResolvedModelForOperation(
      input,
      plan.operation,
      ports.compose,
      artifact.environment,
    );
    await activatePersistedOperation(input, artifact, ports.fs);
    await ports.compose.rollout(
      plan.operation,
      artifact.envFile,
      Object.keys(artifact.environment),
    );
    if (!(await ports.compose.prove(plan.operation))) {
      fail('TENANT_CUTOVER_ROLLOUT_PROOF_FAILED');
    }
    return { action: 'retried', operation: plan.operation };
  }

  if (!candidateModel) {
    candidateModel = await ports.compose.render(
      renderEnvironment(
        input,
        { phase, apiImage: input.apiImage, configurationSha256: CONFIGURATION_DIGEST_SENTINEL },
        true,
      ),
    );
  }
  const prepared = prepareComposeConfiguration({
    projectName: input.projectName,
    composeSource: composeSources[0]!.source,
    installComposeSource: composeSources[1]?.source,
    composeCredentialInventory: input.composeCredentialInventory,
    phase,
    apiImage: input.apiImage,
    apiProofUrl: input.apiProofUrl,
    candidateModel,
    businessConfiguration: input.businessConfiguration,
    operationAuditNonce: ports.createNonce(),
  });
  const launchEnvironment = renderEnvironment(
    input,
    { phase, apiImage: input.apiImage, configurationSha256: prepared.configurationSha256 },
    false,
  );
  const launchModel = await ports.compose.render(launchEnvironment);
  assertLaunchModelMatchesCandidate({
    candidateModel,
    launchModel,
    configurationSha256: prepared.configurationSha256,
    credentialValues: input.credentialValues,
  });
  const request = { command: input.command, prepared } satisfies OwnerAppendRequest;

  await ensureArtifactDirectories(input, ports.fs);
  const requestPath = `${normalizedProjectDirectory(input)}/requests/${prepared.configurationSha256}.json`;
  await ports.fs.writeFileAtomic(
    requestPath,
    `${canonicalBootstrapJson({
      schema: 'tenant-cutover-request/v1',
      command: request.command,
      prepared: request.prepared,
    })}\n`,
    { mode: 0o600, uid: 0, gid: 0 },
  );

  const operation = await ports.owner.append(request);
  assertOperationEvidence(operation, request);
  const envFile = await persistOperation(input, operation, ports.fs);
  try {
    await ports.compose.rollout(
      operation,
      envFile,
      Object.keys(dotenvEnvironmentFor(operation, input.nonCredentialEnvironment)),
    );
    if (!(await ports.compose.prove(operation))) {
      return await recoverFailedRollout(input, operation, ports);
    }
  } catch {
    return await recoverFailedRollout(input, operation, ports);
  }
  return { action: 'deployed', operation };
}

export async function runComposeTenantCutover(
  input: ComposeCutoverInput,
  ports: ComposeCutoverPorts,
): Promise<ComposeCutoverResult> {
  try {
    return await runComposeTenantCutoverImpl(input, ports);
  } catch (error) {
    if (error instanceof Error && /^TENANT_CUTOVER_[A-Z0-9_]+$/.test(error.message)) {
      throw error;
    }
    throw new Error('TENANT_CUTOVER_EXTERNAL_PORT_FAILED');
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function runComposeTenantCutoverCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ComposeCutoverResult> {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    fail('TENANT_CUTOVER_ROOT_REQUIRED');
  }
  const input = parseComposeTenantCutoverArgs(args, environment, cwd);
  const baseEnvironment = stringEnvironment(environment);
  const command = createNodeExternalCommandPort();
  return runComposeTenantCutover(input, {
    fs: createNodeFileSystemPort(),
    owner: createDockerOwnerPort(input, command, baseEnvironment),
    compose: createDockerComposeProcessPort(input, command, baseEnvironment),
    createNonce: () => randomBytes(32).toString('base64url'),
  });
}

async function main(): Promise<void> {
  const result = await runComposeTenantCutoverCli(
    process.argv.slice(2),
    process.env,
    process.cwd(),
  );
  process.stdout.write(
    `${canonicalBootstrapJson({
      action: result.action,
      operationVersion: result.operation.operationVersion,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error && /^TENANT_CUTOVER_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'TENANT_CUTOVER_EXTERNAL_PORT_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
