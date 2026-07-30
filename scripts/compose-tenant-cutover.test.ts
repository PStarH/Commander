import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load as loadYaml } from 'js-yaml';
import {
  CONFIGURATION_DIGEST_SENTINEL,
  assertLaunchModelMatchesCandidate,
  createDockerComposeProcessPort,
  createDockerOwnerPort,
  parseComposeTenantCutoverArgs,
  preflightTlsHostFiles,
  prepareComposeConfiguration,
  runComposeTenantCutover,
  type ComposeCutoverInput,
  type ComposeCutoverPorts,
  type OwnerAppendRequest,
  type OwnerOperationEvidence,
  type ExternalCommandPort,
  type CutoverFileSystemPort,
} from './compose-tenant-cutover.js';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import { createComposeProofObserver } from './task1-compose-proof-observer.js';
import type { DockerTopologyAuthority } from './task1-compose-topology-relay.js';

const digest = (character: string): string => character.repeat(64);
const composeSource = 'services:\n  api:\n    image: ${COMMANDER_API_IMAGE:?}\n';
const installComposeSource =
  'services:\n  kernel-migrate:\n    environment:\n      COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL: ${COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:?}\n';

function taggedSha256(tag: string, value: string): string {
  return createHash('sha256').update(`${tag}\0`, 'utf8').update(value, 'utf8').digest('hex');
}

describe('Compose tenant-cutover content binding', () => {
  it('binds the sentinel-normalized resolved model without adding a circular digest field', () => {
    const candidateModel = {
      name: 'commander-prod',
      services: {
        api: {
          image: `registry.example/commander@sha256:${digest('a')}`,
          environment: {
            COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
            COMMANDER_OWNER_DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_OWNER_DATABASE_URL',
          },
        },
      },
    };

    const prepared = prepareComposeConfiguration({
      projectName: 'commander-prod',
      composeSource,
      composeCredentialInventory: 'runtime-v1',
      phase: 'enforce',
      apiImage: `registry.example/commander@sha256:${digest('a')}`,
      apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
      candidateModel,
      businessConfiguration: {
        allowedTenants: ['tenant-a'],
        secretFileMappings: { ownerDatabaseUrl: 'COMMANDER_OWNER_DATABASE_URL' },
      },
      operationAuditNonce: 'nonce-1',
    });

    assert.equal(prepared.platformBinding.kind, 'compose');
    assert.deepEqual(Object.keys(prepared.platformBinding), [
      'kind',
      'projectName',
      'composeVariant',
      'composeCredentialInventory',
      'composeSourceSha256',
      'composeCliVersion',
      'composeContentSha256',
      'phase',
      'apiImageDigest',
      'apiProofUrl',
    ]);
    assert.equal(prepared.platformBinding.composeVariant, 'prod');
    assert.equal(prepared.platformBinding.composeCredentialInventory, 'runtime-v1');
    assert.equal(prepared.platformBinding.composeCliVersion, '5.3.1');
    assert.equal(
      prepared.platformBinding.composeSourceSha256,
      createHash('sha256')
        .update(
          canonicalBootstrapJson({
            format: 'commander.compose-source-set/v1',
            files: [
              {
                path: 'docker-compose.prod.yml',
                bytesSha256: createHash('sha256').update(composeSource).digest('hex'),
              },
            ],
          }),
        )
        .digest('hex'),
    );
    assert.equal(
      prepared.platformBinding.composeContentSha256,
      taggedSha256('commander.compose-content/v1', canonicalBootstrapJson(candidateModel)),
    );
    assert.equal(
      Object.hasOwn(prepared.configuration, 'configurationSha256'),
      false,
      'the configuration must not hash a copy of its own digest',
    );
    assert.equal(prepared.configuration.operationAuditNonce, 'nonce-1');
    assert.match(prepared.configurationSha256, /^[0-9a-f]{64}$/);

    const launchModel: {
      services: Record<string, { environment: Record<string, string> }>;
    } = structuredClone(candidateModel);
    launchModel.services.api.environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256 =
      prepared.configurationSha256;
    launchModel.services.api.environment.COMMANDER_OWNER_DATABASE_URL =
      'postgres://owner:secret@db/x';

    assert.doesNotThrow(() =>
      assertLaunchModelMatchesCandidate({
        candidateModel,
        launchModel,
        configurationSha256: prepared.configurationSha256,
        credentialValues: {
          COMMANDER_OWNER_DATABASE_URL: 'postgres://owner:secret@db/x',
        },
      }),
    );
  });

  it('rejects caller-owned evidence and ambiguous digest substitution', () => {
    const candidateModel = {
      services: {
        api: {
          environment: {
            COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
          },
        },
      },
    };
    assert.throws(
      () =>
        prepareComposeConfiguration({
          projectName: 'commander-prod',
          composeSource,
          composeCredentialInventory: 'runtime-v1',
          phase: 'enforce',
          apiImage: `registry.example/commander@sha256:${digest('a')}`,
          apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
          candidateModel,
          businessConfiguration: {
            allowedTenants: ['tenant-a'],
            operationAuditNonce: 'caller-nonce',
          },
          operationAuditNonce: 'trusted-nonce',
        }),
      /TENANT_CUTOVER_CALLER_EVIDENCE_FORBIDDEN/,
    );

    const launchModel: {
      services: Record<string, { environment: Record<string, string> }>;
    } = structuredClone(candidateModel);
    launchModel.services.api.environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256 =
      digest('b');
    launchModel.services.worker = {
      environment: { LEAKED_CONFIGURATION_DIGEST: digest('b') },
    };
    assert.throws(
      () =>
        assertLaunchModelMatchesCandidate({
          candidateModel,
          launchModel,
          configurationSha256: digest('b'),
          credentialValues: {},
        }),
      /TENANT_CUTOVER_CONFIGURATION_DIGEST_OCCURRENCE_INVALID/,
    );
  });

  it('maps launch credentials from typed source sentinels instead of target environment keys', () => {
    const credentials = {
      COMMANDER_POSTGRES_SUPERUSER_PASSWORD: 'postgres-secret',
      COMMANDER_OWNER_DATABASE_URL: 'owner-secret',
      COMMANDER_API_DATABASE_URL: 'api-secret',
      COMMANDER_TENANT_AUTHORITY_DATABASE_URL: 'authority-secret',
      COMMANDER_SCHEDULER_DATABASE_URL: 'scheduler-secret',
      COMMANDER_WORKER_DATABASE_URL: 'worker-secret',
      COMMANDER_ADAPTER_OPS_DATABASE_URL: 'adapter-secret',
    };
    const candidateModel = {
      services: {
        postgres: {
          environment: {
            POSTGRES_PASSWORD: 'commander-secret-ref/v1:COMMANDER_POSTGRES_SUPERUSER_PASSWORD',
          },
        },
        api: {
          environment: {
            DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_API_DATABASE_URL',
            COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
              'commander-secret-ref/v1:COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
            COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
          },
        },
        'kernel-migrate': {
          environment: {
            COMMANDER_OWNER_DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_OWNER_DATABASE_URL',
          },
        },
        'kernel-ops': {
          environment: {
            DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_SCHEDULER_DATABASE_URL',
          },
        },
        worker: {
          environment: {
            DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_WORKER_DATABASE_URL',
          },
        },
        'adapter-ops': {
          environment: {
            DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_ADAPTER_OPS_DATABASE_URL',
          },
        },
      },
    };
    const launchModel = structuredClone(candidateModel);
    launchModel.services.postgres.environment.POSTGRES_PASSWORD =
      credentials.COMMANDER_POSTGRES_SUPERUSER_PASSWORD;
    launchModel.services.api.environment.DATABASE_URL = credentials.COMMANDER_API_DATABASE_URL;
    launchModel.services.api.environment.COMMANDER_TENANT_AUTHORITY_DATABASE_URL =
      credentials.COMMANDER_TENANT_AUTHORITY_DATABASE_URL;
    launchModel.services.api.environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256 =
      digest('c');
    launchModel.services['kernel-migrate'].environment.COMMANDER_OWNER_DATABASE_URL =
      credentials.COMMANDER_OWNER_DATABASE_URL;
    launchModel.services['kernel-ops'].environment.DATABASE_URL =
      credentials.COMMANDER_SCHEDULER_DATABASE_URL;
    launchModel.services.worker.environment.DATABASE_URL =
      credentials.COMMANDER_WORKER_DATABASE_URL;
    launchModel.services['adapter-ops'].environment.DATABASE_URL =
      credentials.COMMANDER_ADAPTER_OPS_DATABASE_URL;

    assert.doesNotThrow(() =>
      assertLaunchModelMatchesCandidate({
        candidateModel,
        launchModel,
        configurationSha256: digest('c'),
        credentialValues: credentials,
      }),
    );

    const duplicatedCandidate = structuredClone(candidateModel);
    duplicatedCandidate.services.worker.environment.DUPLICATED_OWNER =
      'commander-secret-ref/v1:COMMANDER_OWNER_DATABASE_URL';
    const duplicatedLaunch = structuredClone(launchModel);
    duplicatedLaunch.services.worker.environment.DUPLICATED_OWNER =
      credentials.COMMANDER_OWNER_DATABASE_URL;
    assert.throws(
      () =>
        assertLaunchModelMatchesCandidate({
          candidateModel: duplicatedCandidate,
          launchModel: duplicatedLaunch,
          configurationSha256: digest('c'),
          credentialValues: credentials,
        }),
      /TENANT_CUTOVER_CREDENTIAL_SENTINEL_INVALID/,
    );
  });
});

describe('Compose tenant-cutover TLS input preflight', () => {
  it('requires canonical root-owned regular files with exact public/key modes', async () => {
    const files = new Map([
      ['/tls/postgres-ca.crt', { mode: 0o444, uid: 0, gid: 0 }],
      ['/tls/postgres.crt', { mode: 0o444, uid: 0, gid: 0 }],
      ['/tls/postgres.key', { mode: 0o400, uid: 0, gid: 0 }],
      ['/tls/api-ca.crt', { mode: 0o444, uid: 0, gid: 0 }],
      ['/tls/api.crt', { mode: 0o444, uid: 0, gid: 0 }],
      ['/tls/api.key', { mode: 0o400, uid: 0, gid: 0 }],
    ]);
    const fs: CutoverFileSystemPort = {
      async lstat(path) {
        const file = files.get(path);
        assert.ok(file, `unexpected path ${path}`);
        return { ...file, isFile: true, isSymbolicLink: false };
      },
      async realpath(path) {
        return path;
      },
      async mkdir() {},
      async readFile() {
        throw new Error('unused');
      },
      async writeFileAtomic() {},
    };

    await assert.doesNotReject(() =>
      preflightTlsHostFiles(
        [
          { path: '/tls/postgres-ca.crt', kind: 'public' },
          { path: '/tls/postgres.crt', kind: 'public' },
          { path: '/tls/postgres.key', kind: 'private-key' },
          { path: '/tls/api-ca.crt', kind: 'public' },
          { path: '/tls/api.crt', kind: 'public' },
          { path: '/tls/api.key', kind: 'private-key' },
        ],
        fs,
      ),
    );

    files.set('/tls/api.key', { mode: 0o440, uid: 0, gid: 1001 });
    await assert.rejects(
      () => preflightTlsHostFiles([{ path: '/tls/api.key', kind: 'private-key' }], fs),
      /TENANT_CUTOVER_TLS_FILE_PERMISSION_INVALID/,
    );
  });
});

describe('Compose tenant-cutover CLI', () => {
  const cliEnvironment = {
    COMPOSE_PROJECT_NAME: 'commander-prod',
    COMMANDER_EXPAND_API_IMAGE: `registry.example/commander@sha256:${digest('a')}`,
    COMMANDER_ENFORCE_API_IMAGE: `registry.example/commander@sha256:${digest('b')}`,
    COMMANDER_PRECLOSURE_API_IMAGE: `registry.example/commander@sha256:${digest('c')}`,
    COMMANDER_POSTGRES_IMAGE: `postgres@sha256:${digest('f')}`,
    COMMANDER_MIGRATOR_IMAGE: `registry.example/kernel-migrate@sha256:${digest('1')}`,
    COMMANDER_KERNEL_OPS_IMAGE: `registry.example/kernel-ops@sha256:${digest('2')}`,
    COMMANDER_WORKER_IMAGE: `registry.example/worker@sha256:${digest('3')}`,
    COMMANDER_ADAPTER_OPS_IMAGE: `registry.example/adapter-ops@sha256:${digest('4')}`,
    COMMANDER_POSTGRES_SUPERUSER_PASSWORD: 'postgres-bootstrap-secret',
    COMMANDER_ALLOWED_TENANTS: 'tenant-a,tenant-b',
    COMMANDER_OWNER_DATABASE_URL: 'postgres://owner:secret@db/commander',
    COMMANDER_API_DATABASE_URL: 'postgres://app:secret@db/commander',
    COMMANDER_TENANT_AUTHORITY_DATABASE_URL: 'postgres://authority:secret@db/commander',
    COMMANDER_SCHEDULER_DATABASE_URL: 'postgres://scheduler:secret@db/commander',
    COMMANDER_WORKER_DATABASE_URL: 'postgres://worker:secret@db/commander',
    COMMANDER_ADAPTER_OPS_DATABASE_URL: 'postgres://adapter:secret@db/commander',
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: digest('d'),
    COMMANDER_POSTGRES_TLS_CA_HOST_FILE: '/tls/postgres-ca.crt',
    COMMANDER_POSTGRES_TLS_CERT_HOST_FILE: '/tls/postgres.crt',
    COMMANDER_POSTGRES_TLS_KEY_HOST_FILE: '/tls/postgres.key',
    COMMANDER_API_PROOF_CA_HOST_FILE: '/tls/api-ca.crt',
    COMMANDER_API_PROOF_CERT_HOST_FILE: '/tls/api.crt',
    COMMANDER_API_PROOF_KEY_HOST_FILE: '/tls/api.key',
  };

  it('accepts the four fixed modes and selects the fresh-only bootstrap credential', () => {
    const parsed = parseComposeTenantCutoverArgs(['expand'], cliEnvironment, '/repo');
    assert.equal(parsed.command, 'expand');
    assert.equal(parsed.apiImage, cliEnvironment.COMMANDER_EXPAND_API_IMAGE);
    assert.equal(parsed.projectName, 'commander-prod');
    assert.equal(parsed.composeFile, '/repo/docker-compose.prod.yml');
    assert.deepEqual(parsed.businessConfiguration.allowedTenants, ['tenant-a', 'tenant-b']);
    assert.deepEqual(parsed.businessConfiguration.secretFileMappings, {
      databaseCaFile: '/run/commander/database-tls/ca.crt',
      proofCaFile: '/run/commander/api-proof/ca.crt',
      proofCertFile: '/run/commander/api-proof/tls.crt',
      proofKeyFile: '/run/commander/api-proof/tls.key',
    });
    assert.equal(
      parsed.credentialValues.COMMANDER_OWNER_DATABASE_URL,
      cliEnvironment.COMMANDER_OWNER_DATABASE_URL,
    );
    assert.equal(JSON.stringify(parsed.businessConfiguration).includes('postgres://'), false);

    const install = parseComposeTenantCutoverArgs(
      ['install'],
      {
        ...cliEnvironment,
        COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:
          'postgres://bootstrap:secret@db/commander?sslmode=verify-full',
      },
      '/repo',
    );
    assert.equal(install.command, 'install');
    assert.equal(install.apiImage, cliEnvironment.COMMANDER_ENFORCE_API_IMAGE);
    assert.equal(install.composeCredentialInventory, 'fresh-bootstrap-v1');
    assert.equal(install.composeFiles.length, 2);
    assert.equal(install.composeFiles[1], '/repo/docker-compose.prod.install.yml');
    assert.equal(
      install.credentialValues.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL,
      'postgres://bootstrap:secret@db/commander?sslmode=verify-full',
    );

    assert.throws(
      () =>
        parseComposeTenantCutoverArgs(
          ['enforce'],
          {
            ...cliEnvironment,
            COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:
              'postgres://bootstrap:secret@db/commander?sslmode=verify-full',
          },
          '/repo',
        ),
      /TENANT_CUTOVER_BOOTSTRAP_AUTHORITY_FORBIDDEN/,
    );

    const rollback = parseComposeTenantCutoverArgs(
      ['rollback-recorded-expand'],
      cliEnvironment,
      '/repo',
    );
    assert.equal(rollback.command, 'rollback-recorded-expand');
    assert.equal(rollback.apiImage, cliEnvironment.COMMANDER_EXPAND_API_IMAGE);

    for (const args of [[], ['enforce', '--force'], ['expand', '--operation-version', '7']]) {
      assert.throws(
        () => parseComposeTenantCutoverArgs(args, cliEnvironment, '/repo'),
        /TENANT_CUTOVER_CLI_ARGUMENT_INVALID/,
      );
    }
  });

  it('rejects caller evidence overrides and missing required sealed inputs', () => {
    assert.throws(
      () =>
        parseComposeTenantCutoverArgs(
          ['enforce'],
          {
            ...cliEnvironment,
            COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: digest('e'),
          },
          '/repo',
        ),
      /TENANT_CUTOVER_CALLER_EVIDENCE_FORBIDDEN/,
    );
    const { COMPOSE_PROJECT_NAME: _project, ...missingProject } = cliEnvironment;
    assert.throws(
      () => parseComposeTenantCutoverArgs(['expand'], missingProject, '/repo'),
      /TENANT_CUTOVER_REQUIRED_ENV_MISSING/,
    );
    const { COMMANDER_POSTGRES_IMAGE: _postgresImage, ...missingPostgresImage } = cliEnvironment;
    assert.throws(
      () => parseComposeTenantCutoverArgs(['expand'], missingPostgresImage, '/repo'),
      /TENANT_CUTOVER_REQUIRED_ENV_MISSING/,
    );
  });
});

describe('docker-compose.prod.yml authority topology', () => {
  it('keeps private keys isolated and every PostgreSQL client on the public CA contract', () => {
    const source = readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8');
    const installSource = readFileSync(
      new URL('../docker-compose.prod.install.yml', import.meta.url),
      'utf8',
    );
    const model = loadYaml(source) as {
      services: Record<
        string,
        {
          build?: unknown;
          image?: string;
          environment?: Record<string, string>;
          volumes?: string[];
          ports?: string[];
          expose?: string[];
          network_mode?: string;
          read_only?: boolean;
          command?: string[];
          entrypoint?: string[];
        }
      >;
    };
    const services = model.services;
    assert.equal(source.includes('COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL'), false);
    const installModel = loadYaml(installSource) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(installModel), ['services']);
    assert.deepEqual(Object.keys(installModel.services), ['kernel-migrate']);
    assert.deepEqual(Object.keys(installModel.services['kernel-migrate']!.environment ?? {}), [
      'COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL',
    ]);
    assert.equal(
      installModel.services['kernel-migrate']!.environment
        ?.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL,
      '${COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:?}',
    );
    for (const name of [
      'postgres-init-materialize',
      'tls-materialize',
      'postgres',
      'kernel-migrate',
      'api',
      'kernel-ops',
      'worker',
      'adapter-ops',
    ]) {
      assert.ok(services[name], `missing production service ${name}`);
    }
    assert.equal(services.api.build, undefined);
    assert.match(services.api.image ?? '', /^\$\{COMMANDER_API_IMAGE:/);
    assert.equal(services['tls-materialize'].network_mode, 'none');
    assert.equal(services['tls-materialize'].read_only, true);
    assert.equal(
      services['tls-materialize'].command?.length,
      1,
      'tls-materialize shell program must be passed to sh -euc as one argv value',
    );
    assert.deepEqual(services['postgres-init-materialize'].entrypoint, ['/bin/sh', '-euc']);
    assert.equal(services['postgres-init-materialize'].command?.length, 1);
    assert.match(services['postgres-init-materialize'].command![0]!, /chown 70:70 \/runtime/);
    assert.ok(
      services['tls-materialize'].volumes?.includes(
        '${COMMANDER_POSTGRES_TLS_KEY_HOST_FILE:?}:/source/postgres/tls.key:ro',
      ),
    );
    assert.ok(
      services['tls-materialize'].volumes?.includes(
        '${COMMANDER_API_PROOF_KEY_HOST_FILE:?}:/source/api-proof/tls.key:ro',
      ),
    );
    assert.ok(
      services.postgres.volumes?.includes('postgres-tls-runtime:/run/commander/postgres-tls:ro'),
    );

    for (const name of ['kernel-migrate', 'api', 'kernel-ops', 'worker', 'adapter-ops']) {
      const service = services[name];
      assert.equal(
        service.environment?.COMMANDER_DATABASE_TLS_CA_FILE,
        '/run/commander/database-tls/ca.crt',
        `${name} missing public CA path`,
      );
      assert.equal(
        service.environment?.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256,
        '${COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256:?}',
        `${name} missing expected SPKI`,
      );
      assert.ok(
        service.volumes?.includes('database-ca-runtime:/run/commander/database-tls:ro'),
        `${name} missing public-only CA mount`,
      );
      assert.equal(
        service.volumes?.some((volume) => volume.includes('postgres-tls-runtime')),
        false,
        `${name} can see the PostgreSQL server key volume`,
      );
    }
    assert.equal(
      services.api.environment?.COMMANDER_OWNER_DATABASE_URL,
      undefined,
      'owner DSN leaked into API',
    );
    assert.equal(
      services.api.environment?.COMMANDER_TENANT_CONTEXT_PHASE,
      '${COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE:?}',
      'API kernel repository must enable the database-issued tenant context phase',
    );
    assert.equal(
      services.api.environment?.COMMANDER_TENANT_AUTHORITY_PROOF_DNS_NAME,
      'api',
      'proof certificate must bind the exact Compose service DNS name',
    );
    assert.equal(
      services['kernel-migrate'].environment?.COMMANDER_OWNER_DATABASE_URL,
      '${COMMANDER_OWNER_DATABASE_URL:?}',
    );
    assert.ok(services.api.volumes?.includes('api-proof-tls-runtime:/run/commander/api-proof:ro'));
    assert.deepEqual(services.api.expose, ['9443/tcp']);
    assert.equal(services.api.ports, undefined);
  });
});

describe('Compose tenant-cutover live fixture contract', () => {
  it('runs the production CLI and verifies a challenged proof row in PostgreSQL', () => {
    const source = readFileSync(
      new URL('./compose-tenant-cutover-live.ts', import.meta.url),
      'utf8',
    );
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    assert.match(source, /runComposeTenantCutoverCli\([\s\S]*\['install'\]/);
    assert.match(source, /commander_tenant_cutover_rollout_proofs/);
    assert.match(source, /challengedResponse/);
    assert.match(source, /down[\s\S]*--volumes[\s\S]*--remove-orphans/);
    assert.match(source, /ec_paramgen_curve:P-256/);
    assert.doesNotMatch(source, /rsa:2048/);
    assert.match(source, /resolve\(stateDirectory, 'proof-relay'\)/);
    assert.equal(
      packageJson.scripts?.['test:compose:tenant-cutover:live'],
      'pnpm exec tsx scripts/compose-tenant-cutover-live.ts',
    );
  });
});

describe('real Docker Compose adapters', () => {
  it('contains proof observation in an inherited relay and removes it after child exit', async () => {
    const input = baseInput();
    const operation = evidenceFromAppend({
      command: 'expand' as const,
      prepared: prepareComposeConfiguration({
        projectName: input.projectName,
        composeSource,
        composeCredentialInventory: 'runtime-v1',
        phase: 'expand',
        apiImage: input.apiImage,
        apiProofUrl: input.apiProofUrl,
        candidateModel: {
          services: {
            api: {
              environment: {
                COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
              },
            },
          },
        },
        businessConfiguration: input.businessConfiguration,
        operationAuditNonce: 'contained-proof-nonce',
      }),
    });
    const apiContainerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const authority: DockerTopologyAuthority = {
      async version() {
        return { ApiVersion: '1.44' };
      },
      async listContainers() {
        return [
          {
            Id: apiContainerId,
            Labels: {
              'com.docker.compose.project': input.projectName,
              'com.docker.compose.service': 'api',
            },
          },
        ];
      },
      async inspectContainer() {
        return {
          Id: apiContainerId,
          Created: '2026-07-28T00:00:00.000Z',
          Name: '/commander-prod-api-1',
          Image: `sha256:${digest('b')}`,
          Config: {
            Image: input.apiImage,
            Labels: {
              'com.docker.compose.project': input.projectName,
              'com.docker.compose.service': 'api',
            },
          },
          State: { Status: 'running', Health: { Status: 'healthy' }, RestartCount: 0 },
          NetworkSettings: {
            Networks: { [`${input.projectName}_default`]: { NetworkID: 'network-1' } },
          },
        };
      },
    };
    const directory = await mkdtemp(join(tmpdir(), 'commander-compose-proof-'));
    let relaySocket = '';
    let proofRequest:
      | {
          args: readonly string[];
          stdin?: string;
          environment: Readonly<Record<string, string>>;
        }
      | undefined;
    const compose = createDockerComposeProcessPort(
      input,
      {
        async run(request) {
          proofRequest = request;
          relaySocket = request.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET!;
          const observer = createComposeProofObserver({
            socketPath: relaySocket,
            attemptId: request.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT!,
            token: request.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN!,
          });
          assert.equal((await observer.containers())[0]?.containerId, apiContainerId);
          return { stdout: JSON.stringify({ proven: true }) };
        },
      },
      {},
      { authority, relayDirectory: directory },
    );

    assert.equal(await compose.prove(operation), true);
    assert.equal(proofRequest?.stdin, '');
    assert.ok(proofRequest?.args.includes('-v'));
    assert.ok(proofRequest?.args.includes(`${directory}:${directory}:ro`));
    assert.ok(proofRequest?.args.includes('-u'));
    assert.ok(proofRequest?.args.includes('0:0'));
    for (const key of [
      'COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET',
      'COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT',
      'COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN',
    ]) {
      const index = proofRequest?.args.indexOf(key) ?? -1;
      assert.ok(index > 0);
      assert.equal(proofRequest?.args[index - 1], '-e');
    }
    assert.deepEqual(proofRequest?.args.slice(-5), [
      '--entrypoint',
      'node',
      'kernel-migrate',
      'packages/kernel/dist/migrate.js',
      'tenant-cutover-prove',
    ]);
    assert.ok(proofRequest?.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT);
    assert.ok(proofRequest?.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN);
    assert.doesNotMatch(proofRequest?.stdin ?? '', /operation|topology/);
    await assert.rejects(() => access(relaySocket));

    const failedDirectory = await mkdtemp(join(tmpdir(), 'commander-compose-proof-'));
    let failedSocket = '';
    const failing = createDockerComposeProcessPort(
      input,
      {
        async run(request) {
          failedSocket = request.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET!;
          throw new Error('proof child failed');
        },
      },
      {},
      { authority, relayDirectory: failedDirectory },
    );
    await assert.rejects(() => failing.prove(operation));
    await assert.rejects(() => access(failedSocket));
  });

  it('preserves exactly one strict owner predecessor', async () => {
    const input = baseInput();
    const prepared = prepareComposeConfiguration({
      projectName: input.projectName,
      composeSource,
      composeCredentialInventory: 'runtime-v1',
      phase: 'expand',
      apiImage: input.apiImage,
      apiProofUrl: input.apiProofUrl,
      candidateModel: {
        services: {
          api: {
            environment: {
              COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
            },
          },
        },
      },
      businessConfiguration: input.businessConfiguration,
      operationAuditNonce: 'owner-response-nonce',
    });
    const predecessor = evidenceFromAppend({ command: 'expand', prepared });
    const current = { ...predecessor, operationVersion: '2', predecessor };
    let stdout = JSON.stringify({ action: 'append', operation: current });
    const owner = createDockerOwnerPort(
      input,
      {
        async run() {
          return { stdout };
        },
      },
      {},
    );
    const append: OwnerAppendRequest = {
      command: 'expand',
      prepared: {
        platformBinding: prepared.platformBinding,
        businessConfiguration: prepared.businessConfiguration,
        configuration: prepared.configuration,
        configurationSha256: prepared.configurationSha256,
      },
    };

    assert.equal((await owner.append(append)).predecessor?.operationVersion, '1');

    stdout = JSON.stringify({
      action: 'append',
      operation: { ...current, predecessor: { ...predecessor, predecessor } },
    });
    await assert.rejects(() => owner.append(append), /TENANT_CUTOVER_OWNER_RESPONSE_INVALID/);

    stdout = JSON.stringify({
      action: 'append',
      operation: {
        ...current,
        predecessor: { ...predecessor, configurationSha256: digest('f') },
      },
    });
    await assert.rejects(() => owner.append(append), /TENANT_CUTOVER_OWNER_RESPONSE_INVALID/);
  });

  it('uses fixed credential-free argv and stdin JSON for render, rollout, and owner evidence', async () => {
    const calls: Array<{
      program: string;
      args: readonly string[];
      environment: Readonly<Record<string, string>>;
      stdin?: string;
    }> = [];
    let stdout = '{}';
    const command: ExternalCommandPort = {
      async run(request) {
        calls.push(request);
        return { stdout };
      },
    };
    const input = baseInput();
    const relayDirectory = await mkdtemp(join(tmpdir(), 'commander-compose-proof-'));
    const compose = createDockerComposeProcessPort(
      input,
      command,
      {
        COMMANDER_API_IMAGE: 'parent-wrong-image',
        COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'enforce',
        COMMANDER_API_PROOF_KEY_HOST_FILE: '/tls/parent-wrong.key',
        COMMANDER_OWNER_DATABASE_URL: input.credentialValues.COMMANDER_OWNER_DATABASE_URL!,
      },
      {
        authority: {
          async version() {
            return { ApiVersion: '1.44' };
          },
          async listContainers() {
            return [];
          },
          async inspectContainer() {
            throw new Error('unexpected inspect');
          },
        },
        relayDirectory,
      },
    );
    await compose.render({
      COMMANDER_API_IMAGE: input.apiImage,
      COMMANDER_OWNER_DATABASE_URL: input.credentialValues.COMMANDER_OWNER_DATABASE_URL!,
    });
    const operation = evidenceFromAppend({
      command: 'expand',
      prepared: prepareComposeConfiguration({
        projectName: input.projectName,
        composeSource,
        composeCredentialInventory: 'runtime-v1',
        phase: 'expand',
        apiImage: input.apiImage,
        apiProofUrl: input.apiProofUrl,
        candidateModel: {
          services: {
            api: {
              environment: {
                COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
              },
            },
          },
        },
        businessConfiguration: input.businessConfiguration,
        operationAuditNonce: 'nonce',
      }),
    });
    await compose.rollout(
      operation,
      '/repo/.commander/tenant-cutover/commander-prod/operations/1.env',
      [
        'COMMANDER_API_IMAGE',
        'COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE',
        'COMMANDER_API_PROOF_KEY_HOST_FILE',
      ],
    );

    assert.deepEqual(calls[0]!.args, [
      'compose',
      '--project-name',
      'commander-prod',
      '-f',
      '/repo/docker-compose.prod.yml',
      'config',
      '--format',
      'json',
      '--no-path-resolution',
    ]);
    assert.equal(calls[0]!.args.join(' ').includes('do-not-persist'), false);
    assert.deepEqual(calls[1]!.args, [
      'compose',
      '--project-name',
      'commander-prod',
      '--env-file',
      '/repo/.commander/tenant-cutover/commander-prod/operations/1.env',
      '-f',
      '/repo/docker-compose.prod.yml',
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      'COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE=expand',
      '--entrypoint',
      'node',
      'kernel-migrate',
      'packages/kernel/dist/migrate.js',
      'tenant-cutover-migrate',
    ]);
    assert.deepEqual(calls[2]!.args, [
      'compose',
      '--project-name',
      'commander-prod',
      '--env-file',
      '/repo/.commander/tenant-cutover/commander-prod/operations/1.env',
      '-f',
      '/repo/docker-compose.prod.yml',
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      'api',
    ]);
    assert.equal(calls[2]!.environment.COMMANDER_API_IMAGE, undefined);
    assert.equal(calls[2]!.environment.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE, undefined);
    assert.equal(calls[2]!.environment.COMMANDER_API_PROOF_KEY_HOST_FILE, undefined);
    assert.equal(
      calls[2]!.environment.COMMANDER_OWNER_DATABASE_URL,
      input.credentialValues.COMMANDER_OWNER_DATABASE_URL,
      'credential source variables remain in the parent environment',
    );

    stdout = JSON.stringify({ proven: true });
    assert.equal(await compose.prove(operation), true);
    assert.ok(calls[3]!.args.includes('kernel-migrate'));
    assert.ok(calls[3]!.args.includes('tenant-cutover-prove'));
    assert.equal(calls[3]!.stdin, '');
    assert.ok(calls[3]!.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET);
    assert.ok(calls[3]!.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT);
    assert.ok(calls[3]!.environment.COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN);

    const owner = createDockerOwnerPort(input, command, {});
    stdout = JSON.stringify({ action: 'append' });
    const planRequest = {
      command: 'expand' as const,
      platformIntent: {
        kind: 'compose' as const,
        projectName: input.projectName,
        composeVariant: 'prod' as const,
        composeCredentialInventory: 'runtime-v1' as const,
        composeSourceSha256: operation.platformBinding.composeSourceSha256,
        composeCliVersion: '5.3.1' as const,
        phase: 'expand' as const,
        apiImageDigest: input.apiImage,
        apiProofUrl: input.apiProofUrl,
      },
      businessConfiguration: input.businessConfiguration,
    };
    await owner.plan(planRequest);
    assert.ok(calls[4]!.args.includes('kernel-migrate'));
    assert.ok(calls[4]!.args.includes('tenant-cutover-plan'));
    assert.ok(calls[4]!.stdin?.endsWith('\n'));
    assert.doesNotMatch(calls[4]!.stdin ?? '', /do-not-persist/);
    assert.equal(calls[4]!.args.join(' ').includes('do-not-persist'), false);
    assert.equal(calls[4]!.environment.COMMANDER_API_IMAGE, input.apiImage);
    assert.equal(calls[4]!.environment.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE, 'expand');
    assert.equal(
      calls[4]!.environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256,
      CONFIGURATION_DIGEST_SENTINEL,
    );
    const planPayload = JSON.parse(calls[4]!.stdin ?? '');
    assert.deepEqual(Object.keys(planPayload), [
      'businessConfiguration',
      'command',
      'platformIntent',
      'schema',
    ]);
    assert.equal(planPayload.schema, 'tenant-cutover-plan/v1');
    assert.deepEqual(planPayload, { ...planRequest, schema: 'tenant-cutover-plan/v1' });

    stdout = JSON.stringify({ action: 'append', operation });
    const appendRequest: OwnerAppendRequest = {
      command: 'expand',
      prepared: {
        platformBinding: operation.platformBinding,
        businessConfiguration: {
          ...operation.businessConfiguration,
          platformBinding: operation.platformBinding,
        },
        configuration: operation.configuration,
        configurationSha256: operation.configurationSha256,
      },
    };
    assert.deepEqual(await owner.append(appendRequest), operation);

    const installInput = baseInput({
      command: 'install',
      composeFiles: ['/repo/docker-compose.prod.yml', '/repo/docker-compose.prod.install.yml'],
      composeCredentialInventory: 'fresh-bootstrap-v1',
    });
    const installCompose = createDockerComposeProcessPort(installInput, command, {});
    await installCompose.render({});
    const installOperation = evidenceFromAppend(
      {
        command: 'install',
        prepared: prepareComposeConfiguration({
          projectName: installInput.projectName,
          composeSource,
          installComposeSource,
          composeCredentialInventory: 'fresh-bootstrap-v1',
          phase: 'enforce',
          apiImage: installInput.apiImage,
          apiProofUrl: installInput.apiProofUrl,
          candidateModel: {
            services: {
              api: {
                environment: {
                  COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
                },
              },
            },
          },
          businessConfiguration: installInput.businessConfiguration,
          operationAuditNonce: 'install-nonce',
        }),
      },
      { operationKind: 'fresh_enforce' },
    );
    await installCompose.rollout(installOperation, '/repo/install.env', []);
    assert.deepEqual(calls[6]!.args.slice(0, 8), [
      'compose',
      '--project-name',
      'commander-prod',
      '-f',
      '/repo/docker-compose.prod.yml',
      '-f',
      '/repo/docker-compose.prod.install.yml',
      'config',
    ]);
    assert.ok(calls[7]!.args.includes('tenant-cutover-migrate'));
    assert.ok(calls[7]!.args.includes('COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE=enforce'));
    assert.deepEqual(calls[8]!.args.slice(-4), ['api', 'kernel-ops', 'worker', 'adapter-ops']);
    await installCompose.startFreshBootstrap({}, []);
    assert.deepEqual(calls[9]!.args.slice(-10), [
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
    ]);
  });
});

function baseInput(overrides: Partial<ComposeCutoverInput> = {}): ComposeCutoverInput {
  return {
    command: 'expand',
    projectName: 'commander-prod',
    composeFile: '/repo/docker-compose.prod.yml',
    composeFiles: ['/repo/docker-compose.prod.yml'],
    composeCredentialInventory: 'runtime-v1',
    stateDirectory: '/repo/.commander/tenant-cutover',
    apiImage: `registry.example/commander@sha256:${digest('a')}`,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
    businessConfiguration: {
      allowedTenants: ['tenant-a'],
      secretFileMappings: {
        ownerDatabaseUrl: 'COMMANDER_OWNER_DATABASE_URL',
        proofKeyPath: '/run/commander/api-proof/tls.key',
      },
    },
    credentialValues: {
      COMMANDER_POSTGRES_SUPERUSER_PASSWORD: 'postgres-do-not-persist',
      COMMANDER_OWNER_DATABASE_URL:
        'postgres://commander_owner:do-not-persist@db/commander?sslmode=verify-full',
      COMMANDER_API_DATABASE_URL:
        'postgres://commander_app:do-not-persist@db/commander?sslmode=verify-full',
      COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
        'postgres://commander_tenant_authority:do-not-persist@db/commander?sslmode=verify-full',
      COMMANDER_SCHEDULER_DATABASE_URL:
        'postgres://commander_scheduler:do-not-persist@db/commander?sslmode=verify-full',
      COMMANDER_WORKER_DATABASE_URL:
        'postgres://commander_worker:do-not-persist@db/commander?sslmode=verify-full',
      COMMANDER_ADAPTER_OPS_DATABASE_URL:
        'postgres://commander_adapter_ops:do-not-persist@db/commander?sslmode=verify-full',
    },
    nonCredentialEnvironment: {
      COMMANDER_POSTGRES_TLS_CA_HOST_FILE: '/tls/postgres-ca.crt',
      COMMANDER_DATABASE_TLS_CA_FILE: '/run/commander/database-tls/ca.crt',
      COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'compose-volume/database-ca-runtime:ca.crt',
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: digest('d'),
      COMMANDER_API_PROOF_KEY_HOST_FILE: '/tls/original-api.key',
    },
    tlsHostFiles: [],
    ...overrides,
  };
}

function composeModelForEnvironment(environment: Readonly<Record<string, string>>) {
  return {
    name: 'commander-prod',
    services: {
      postgres: {
        environment: {
          POSTGRES_PASSWORD: environment.COMMANDER_POSTGRES_SUPERUSER_PASSWORD,
        },
      },
      'kernel-migrate': {
        environment: {
          COMMANDER_OWNER_DATABASE_URL: environment.COMMANDER_OWNER_DATABASE_URL,
          ...(environment.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL === undefined
            ? {}
            : {
                COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:
                  environment.COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL,
              }),
        },
      },
      api: {
        image: environment.COMMANDER_API_IMAGE,
        environment: {
          COMMANDER_API_DATABASE_URL: environment.COMMANDER_API_DATABASE_URL,
          COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
            environment.COMMANDER_TENANT_AUTHORITY_DATABASE_URL,
          COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256:
            environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256,
        },
      },
      'kernel-ops': {
        environment: {
          COMMANDER_SCHEDULER_DATABASE_URL: environment.COMMANDER_SCHEDULER_DATABASE_URL,
        },
      },
      worker: {
        environment: {
          COMMANDER_WORKER_DATABASE_URL: environment.COMMANDER_WORKER_DATABASE_URL,
        },
      },
      'adapter-ops': {
        environment: {
          COMMANDER_ADAPTER_OPS_DATABASE_URL: environment.COMMANDER_ADAPTER_OPS_DATABASE_URL,
        },
      },
    },
  };
}

function evidenceFromAppend(
  request: OwnerAppendRequest,
  overrides: Partial<OwnerOperationEvidence> = {},
): OwnerOperationEvidence {
  const { platformBinding: _binding, ...businessConfiguration } =
    request.prepared.businessConfiguration;
  return {
    operationVersion: '1',
    operationKind:
      request.command === 'install'
        ? 'fresh_enforce'
        : request.command === 'expand'
          ? 'legacy_expand'
          : request.command === 'rollback-recorded-expand'
            ? 'rollback_to_recorded_expand'
            : 'enforce',
    phase: request.prepared.platformBinding.phase,
    apiImage: request.prepared.platformBinding.apiImageDigest,
    platformBinding: request.prepared.platformBinding,
    businessConfiguration,
    configuration: request.prepared.configuration,
    configurationSha256: request.prepared.configurationSha256,
    predecessor: null,
    ...overrides,
  };
}

function memoryPorts(events: string[]): {
  ports: ComposeCutoverPorts;
  files: Map<string, string>;
  writes: Array<{ path: string; contents: string; mode: number; uid: number; gid: number }>;
} {
  const files = new Map<string, string>();
  const writes: Array<{
    path: string;
    contents: string;
    mode: number;
    uid: number;
    gid: number;
  }> = [];
  const fs: CutoverFileSystemPort = {
    async lstat() {
      throw new Error('unexpected lstat');
    },
    async realpath(path) {
      return path;
    },
    async mkdir(path, options) {
      events.push(`mkdir:${path}`);
      assert.deepEqual(options, { mode: 0o700, uid: 0, gid: 0 });
    },
    async readFile(path) {
      if (path === '/repo/docker-compose.prod.yml') return composeSource;
      if (path === '/repo/docker-compose.prod.install.yml') return installComposeSource;
      if (path === '/tls/postgres-ca.crt') return 'compose-ca-bytes';
      const value = files.get(path);
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
    async writeFileAtomic(path, contents, options) {
      events.push(`write:${path}`);
      writes.push({ path, contents, ...options });
      files.set(path, contents);
    },
  };
  const ports: ComposeCutoverPorts = {
    fs,
    owner: {
      async plan() {
        events.push('owner:plan');
        return { action: 'append' };
      },
      async append(request) {
        events.push('owner:append');
        assert.ok(
          events.some((event) => event.startsWith('write:') && event.includes('/requests/')),
          'request artifact must exist before owner mutation',
        );
        return evidenceFromAppend(request);
      },
      async recover() {
        throw new Error('unexpected recovery');
      },
    },
    compose: {
      async render(environment) {
        events.push(
          `compose:render:${environment.COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256}`,
        );
        return composeModelForEnvironment(environment);
      },
      async rollout(operation, envFile, environmentKeys) {
        assert.ok(environmentKeys?.includes('COMMANDER_API_IMAGE'));
        assert.ok(environmentKeys?.includes('COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE'));
        events.push(`compose:rollout:${operation.operationVersion}:${envFile}`);
      },
      async startFreshBootstrap() {
        events.push('compose:fresh-bootstrap');
      },
      async prove(operation) {
        events.push(`compose:prove:${operation.operationVersion}`);
        return true;
      },
    },
    createNonce() {
      events.push('nonce:create');
      return 'trusted-nonce';
    },
  };
  return { ports, files, writes };
}

describe('Compose tenant-cutover orchestrator', () => {
  it('rejects a command, credential inventory, or source-set mismatch before render or owner mutation', async () => {
    const cases: Array<{
      input: ComposeCutoverInput;
      error: RegExp;
    }> = [
      {
        input: baseInput({
          command: 'enforce',
          composeCredentialInventory: 'fresh-bootstrap-v1',
          composeFiles: ['/repo/docker-compose.prod.yml', '/repo/docker-compose.prod.install.yml'],
        }),
        error: /TENANT_CUTOVER_CREDENTIAL_INVENTORY_INVALID/,
      },
      {
        input: baseInput({
          command: 'install',
          composeCredentialInventory: 'fresh-bootstrap-v1',
          composeFiles: ['/repo/docker-compose.prod.yml'],
        }),
        error: /TENANT_CUTOVER_COMPOSE_SOURCE_SET_INVALID/,
      },
      {
        input: baseInput({
          command: 'expand',
          credentialValues: {
            ...baseInput().credentialValues,
            COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:
              'postgres://bootstrap:do-not-persist@db/commander',
          },
        }),
        error: /TENANT_CUTOVER_CREDENTIAL_INVENTORY_INVALID/,
      },
      {
        input: baseInput({
          credentialValues: {
            ...baseInput().credentialValues,
            COMMANDER_OWNER_DATABASE_URL:
              'postgres://commander_app:do-not-persist@db/commander?sslmode=verify-full',
          },
        }),
        error: /TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID/,
      },
    ];

    for (const { input, error } of cases) {
      const fixture = memoryPorts([]);
      fixture.ports.compose.render = async () => {
        throw new Error('invalid input must not render');
      };
      fixture.ports.owner.plan = async () => {
        throw new Error('invalid input must not reach the owner');
      };
      await assert.rejects(() => runComposeTenantCutover(input, fixture.ports), error);
    }
  });

  it('fails closed before owner planning when the public database CA is unavailable', async () => {
    const fixture = memoryPorts([]);
    fixture.ports.fs.readFile = async (path) => {
      if (path === '/repo/docker-compose.prod.yml') return composeSource;
      throw new Error('missing CA');
    };
    fixture.ports.owner.plan = async () => {
      throw new Error('missing CA must not reach owner planning');
    };

    await assert.rejects(
      () => runComposeTenantCutover(baseInput(), fixture.ports),
      /TENANT_CUTOVER_DATABASE_CA_UNAVAILABLE/,
    );
  });

  it('persists noncredential request metadata before mutation, then deploys only proven evidence', async () => {
    const events: string[] = [];
    const fixture = memoryPorts(events);

    const result = await runComposeTenantCutover(baseInput(), fixture.ports);

    assert.equal(result.action, 'deployed');
    assert.equal(result.operation.operationVersion, '1');
    assert.ok(events.indexOf('owner:plan') < events.indexOf('nonce:create'));
    assert.ok(events.indexOf('nonce:create') < events.indexOf('owner:append'));
    assert.ok(
      events.indexOf('owner:append') <
        events.findIndex((event) => event.startsWith('compose:rollout')),
    );
    assert.ok(
      events.findIndex((event) => event.startsWith('compose:rollout')) <
        events.indexOf('compose:prove:1'),
    );

    const persisted = fixture.writes.filter(
      ({ path }) => path.includes('/requests/') || path.includes('/operations/'),
    );
    assert.ok(persisted.length >= 3);
    for (const write of persisted) {
      assert.deepEqual(
        { mode: write.mode, uid: write.uid, gid: write.gid },
        { mode: 0o600, uid: 0, gid: 0 },
      );
      assert.doesNotMatch(write.contents, /do-not-persist/);
    }
    const operationJson = fixture.writes.find(({ path }) => path.endsWith('/operations/1.json'));
    assert.ok(operationJson);
    assert.deepEqual(Object.keys(JSON.parse(operationJson.contents)), [
      'businessConfiguration',
      'configuration',
      'configurationSha256',
      'operationKind',
      'operationVersion',
      'platformBinding',
      'predecessorOperationVersion',
      'schema',
    ]);
    const operationArtifact = JSON.parse(operationJson.contents);
    assert.equal(operationArtifact.schema, 'tenant-cutover-operation/v1');
    assert.equal(operationArtifact.predecessorOperationVersion, null);
    assert.deepEqual(operationArtifact.platformBinding, result.operation.platformBinding);
    assert.deepEqual(
      operationArtifact.businessConfiguration,
      result.operation.businessConfiguration,
    );
    assert.deepEqual(operationArtifact.configuration, result.operation.configuration);

    const requestJson = fixture.writes.find(({ path }) => path.includes('/requests/'));
    assert.ok(requestJson);
    const requestArtifact = JSON.parse(requestJson.contents);
    assert.deepEqual(Object.keys(requestArtifact), ['command', 'prepared', 'schema']);
    assert.equal(requestArtifact.schema, 'tenant-cutover-request/v1');
    assert.equal(requestArtifact.command, 'expand');
    assert.equal(
      requestArtifact.prepared.configurationSha256,
      result.operation.configurationSha256,
    );
    assert.deepEqual(requestArtifact.prepared.platformBinding, result.operation.platformBinding);
    assert.deepEqual(requestArtifact.prepared.businessConfiguration.databasePeerBindingInput, {
      format: 'database_peer_binding_input/v1',
      roles: [
        { role: 'adapter-ops', host: 'db', port: 5432 },
        { role: 'app', host: 'db', port: 5432 },
        { role: 'owner', host: 'db', port: 5432 },
        { role: 'scheduler', host: 'db', port: 5432 },
        { role: 'tenant-authority', host: 'db', port: 5432 },
        { role: 'worker', host: 'db', port: 5432 },
      ],
      expectedServerSpkiSha256: digest('d'),
      ca: {
        mountIdentity: 'compose-volume/database-ca-runtime:ca.crt',
        path: '/run/commander/database-tls/ca.crt',
        publicBytesSha256: createHash('sha256').update('compose-ca-bytes').digest('hex'),
      },
    });
    assert.ok(fixture.writes.some(({ path }) => path.endsWith('/active.env')));
  });

  it('starts only the fresh bootstrap substrate after model validation and before owner mutation', async () => {
    const events: string[] = [];
    const fixture = memoryPorts(events);
    const input = baseInput({
      command: 'install',
      composeFiles: ['/repo/docker-compose.prod.yml', '/repo/docker-compose.prod.install.yml'],
      composeCredentialInventory: 'fresh-bootstrap-v1',
      credentialValues: {
        ...baseInput().credentialValues,
        COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL:
          'postgres://bootstrap:do-not-persist@db/commander',
      },
    });

    const result = await runComposeTenantCutover(input, fixture.ports);

    assert.equal(result.operation.operationKind, 'fresh_enforce');
    const renderIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith('compose:render'))
      .map(({ index }) => index);
    assert.equal(renderIndexes.length, 3);
    assert.ok(renderIndexes[1]! < events.indexOf('compose:fresh-bootstrap'));
    assert.ok(events.indexOf('compose:fresh-bootstrap') < events.indexOf('owner:plan'));
    assert.ok(events.indexOf('owner:plan') < events.indexOf('nonce:create'));
    assert.ok(events.indexOf('compose:fresh-bootstrap') < events.indexOf('owner:append'));
  });

  it('creates a fresh rollback nonce but reuses the exact operation on retry', async () => {
    const events: string[] = [];
    const fixture = memoryPorts(events);
    const input = baseInput({
      command: 'rollback-recorded-expand',
      apiImage: `registry.example/commander@sha256:${digest('e')}`,
    });

    const first = await runComposeTenantCutover(input, fixture.ports);
    assert.equal(first.operation.operationKind, 'rollback_to_recorded_expand');
    assert.equal(first.operation.configuration.operationAuditNonce, 'trusted-nonce');

    events.length = 0;
    fixture.ports.owner.plan = async () => {
      events.push('owner:plan');
      return { action: 'retry_rollout', operation: first.operation };
    };
    fixture.ports.owner.append = async () => {
      throw new Error('retry must not append');
    };
    fixture.ports.createNonce = () => {
      throw new Error('retry must not generate a nonce');
    };

    const retry = await runComposeTenantCutover(input, fixture.ports);

    assert.equal(retry.action, 'retried');
    assert.equal(retry.operation.configuration.operationAuditNonce, 'trusted-nonce');
    assert.ok(events.some((event) => event.startsWith('compose:rollout:1:')));
    assert.ok(events.includes('compose:prove:1'));
  });

  it('restores the full predecessor artifact and appends explicit hybrid recovery after enforce failure', async () => {
    const events: string[] = [];
    const fixture = memoryPorts(events);
    const predecessor = (await runComposeTenantCutover(baseInput(), fixture.ports)).operation;

    const enforceInput = baseInput({
      command: 'enforce',
      apiImage: `registry.example/commander@sha256:${digest('b')}`,
      businessConfiguration: {
        allowedTenants: ['tenant-b'],
        secretFileMappings: {
          ownerDatabaseUrl: 'COMMANDER_OWNER_DATABASE_URL',
          proofKeyPath: '/run/commander/api-proof/new-tls.key',
        },
      },
      nonCredentialEnvironment: {
        COMMANDER_POSTGRES_TLS_CA_HOST_FILE: '/tls/postgres-ca.crt',
        COMMANDER_DATABASE_TLS_CA_FILE: '/run/commander/database-tls/ca.crt',
        COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'compose-volume/database-ca-runtime:ca.crt',
        COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: digest('d'),
        COMMANDER_API_PROOF_KEY_HOST_FILE: '/tls/failed-new-api.key',
      },
    });
    let failedOperation: OwnerOperationEvidence | undefined;
    fixture.ports.owner.append = async (request) => {
      events.push('owner:append');
      failedOperation = evidenceFromAppend(request, {
        operationVersion: '2',
        predecessor,
      });
      return failedOperation;
    };
    fixture.ports.owner.recover = async (failed) => {
      events.push('owner:recover');
      assert.equal(failed, failedOperation);
      const candidateModel = composeModelForEnvironment({
        COMMANDER_API_IMAGE: predecessor.apiImage,
        COMMANDER_POSTGRES_SUPERUSER_PASSWORD:
          'commander-secret-ref/v1:COMMANDER_POSTGRES_SUPERUSER_PASSWORD',
        COMMANDER_OWNER_DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_OWNER_DATABASE_URL',
        COMMANDER_API_DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_API_DATABASE_URL',
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
          'commander-secret-ref/v1:COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
        COMMANDER_SCHEDULER_DATABASE_URL:
          'commander-secret-ref/v1:COMMANDER_SCHEDULER_DATABASE_URL',
        COMMANDER_WORKER_DATABASE_URL: 'commander-secret-ref/v1:COMMANDER_WORKER_DATABASE_URL',
        COMMANDER_ADAPTER_OPS_DATABASE_URL:
          'commander-secret-ref/v1:COMMANDER_ADAPTER_OPS_DATABASE_URL',
        COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: CONFIGURATION_DIGEST_SENTINEL,
      });
      const hybrid = prepareComposeConfiguration({
        projectName: 'commander-prod',
        composeSource,
        composeCredentialInventory: 'runtime-v1',
        phase: predecessor.phase,
        apiImage: predecessor.apiImage,
        apiProofUrl: predecessor.platformBinding.apiProofUrl,
        candidateModel,
        businessConfiguration: {
          allowedTenants: ['tenant-b'],
          secretFileMappings: predecessor.businessConfiguration.secretFileMappings,
          databasePeerBindingInput: failed.businessConfiguration.databasePeerBindingInput,
        },
        operationAuditNonce: 'recovery-nonce',
      });
      return {
        operationVersion: '3',
        operationKind: 'recover_runtime_after_enforce_failure',
        phase: predecessor.phase,
        apiImage: predecessor.apiImage,
        platformBinding: hybrid.platformBinding,
        businessConfiguration: hybrid.businessConfiguration,
        configuration: hybrid.configuration,
        configurationSha256: hybrid.configurationSha256,
        predecessor: failed,
      };
    };
    fixture.ports.compose.rollout = async (operation, envFile) => {
      events.push(`compose:rollout:${operation.operationVersion}:${envFile}`);
      if (operation.operationVersion === '2') {
        throw new Error('docker failed with postgres://owner:do-not-persist@db/commander');
      }
      if (operation.operationVersion === '1') {
        assert.deepEqual(
          operation.businessConfiguration.allowedTenants,
          ['tenant-a'],
          'restore must carry predecessor business configuration, not only its image',
        );
        assert.ok(envFile.endsWith('/operations/1.env'));
      }
    };
    fixture.ports.compose.prove = async (operation) => {
      events.push(`compose:prove:${operation.operationVersion}`);
      return operation.operationVersion !== '1';
    };
    events.length = 0;

    const result = await runComposeTenantCutover(enforceInput, fixture.ports);

    assert.equal(result.action, 'recovered');
    assert.equal(result.operation.operationKind, 'recover_runtime_after_enforce_failure');
    assert.deepEqual(result.operation.businessConfiguration.allowedTenants, ['tenant-b']);
    assert.deepEqual(
      result.operation.businessConfiguration.secretFileMappings,
      predecessor.businessConfiguration.secretFileMappings,
    );
    assert.ok(
      events.findIndex((event) => event.startsWith('compose:rollout:1:')) <
        events.indexOf('owner:recover'),
    );
    assert.ok(events.indexOf('compose:prove:1') < events.indexOf('owner:recover'));
    assert.ok(events.some((event) => event.startsWith('compose:rollout:3:')));
    assert.ok(events.includes('compose:prove:3'));
    assert.match(
      fixture.files.get('/repo/.commander/tenant-cutover/commander-prod/operations/3.env') ?? '',
      /COMMANDER_API_PROOF_KEY_HOST_FILE=\/tls\/original-api\.key/,
    );
  });

  it('returns a command-compatible live current row without render, nonce, or writes', async () => {
    const events: string[] = [];
    const fixture = memoryPorts(events);
    const current = (await runComposeTenantCutover(baseInput(), fixture.ports)).operation;
    events.length = 0;
    fixture.ports.owner.plan = async () => ({ action: 'return_current', operation: current });
    fixture.ports.compose.render = async () => {
      throw new Error('no-op must not render');
    };
    fixture.ports.createNonce = () => {
      throw new Error('no-op must not generate a nonce');
    };
    const writesBefore = fixture.writes.length;

    const result = await runComposeTenantCutover(baseInput(), fixture.ports);

    assert.equal(result.action, 'returned_current');
    assert.equal(result.operation, current);
    assert.equal(fixture.writes.length, writesBefore);
  });

  it('sanitizes external port errors while preserving closed lifecycle codes', async () => {
    const secret = 'postgres://owner:top-secret@db/commander';
    const fixture = memoryPorts([]);
    fixture.ports.compose.render = async () => {
      throw new Error(`docker render leaked ${secret}`);
    };
    await assert.rejects(
      () => runComposeTenantCutover(baseInput(), fixture.ports),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'TENANT_CUTOVER_EXTERNAL_PORT_FAILED');
        assert.doesNotMatch(error.message, /top-secret/);
        return true;
      },
    );

    const closedFixture = memoryPorts([]);
    closedFixture.ports.owner.plan = async () => {
      throw new Error('TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED');
    };
    await assert.rejects(
      () => runComposeTenantCutover(baseInput(), closedFixture.ports),
      /TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED/,
    );
  });
});
