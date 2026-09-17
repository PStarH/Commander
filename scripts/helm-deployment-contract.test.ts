/**
 * Helm deployment integrity contracts for deploy/helm/commander.
 *
 * Each contract is asserted two ways:
 *   - rendered: `helm template` output when a helm binary is reachable;
 *   - source:   chart template/values source when helm is not available.
 *
 * Offline mode still runs real assertions (it never reports a verified render).
 * It only verifies the chart source invariants, and the mode is printed so the
 * difference is visible instead of being hidden behind a passing "skip".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { load, loadAll } from 'js-yaml';

const root = resolve(import.meta.dirname, '..');
const chart = 'deploy/helm/commander';
const chartDirectory = join(root, chart);
const demoValues = join(chart, 'values-demo.yaml');
const enterpriseValues = join(chart, 'values-enterprise.yaml');

/** API startup secret env the api container must mount for non-demo tiers. */
const API_STARTUP_SECRET_ENV = [
  'COMMANDER_MASTER_KEY',
  'JWT_SECRET',
  'COMMANDER_API_KEY',
  'COMMANDER_CAPABILITY_TOKEN_KEY',
  'COMMANDER_INTEGRITY_KEY',
  'ADMIN_PASSWORD',
];

const DUPLICATE_ENV = 'COMMANDER_ADAPTER_OPS_DATABASE_URL';

type Container = {
  name?: string;
  env?: Array<{ name?: string; valueFrom?: unknown }>;
  readinessProbe?: {
    httpGet?: { path?: string; port?: unknown };
    exec?: { command?: string[] };
  };
};

type Manifest = {
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    template?: {
      spec?: {
        containers?: Container[];
      };
    };
  };
};

function resolveHelm(): string | undefined {
  const candidates = [
    process.env.HELM_BIN,
    'helm',
    '/opt/homebrew/bin/helm',
    '/usr/local/bin/helm',
    process.env.HOME ? join(process.env.HOME, '.local/bin/helm') : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
    }
    const probe = spawnSync(candidate, ['version', '--short'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

/** Set HELM_CONTRACT_MODE=source to force source-only assertions (e.g. offline CI). */
const forcedSourceMode = process.env.HELM_CONTRACT_MODE === 'source';
const helmBin = forcedSourceMode ? undefined : resolveHelm();

if (helmBin) {
  const version = spawnSync(helmBin, ['version', '--short'], { encoding: 'utf8' }).stdout.trim();
  console.log(`[helm-deployment-contract] rendered mode via ${helmBin} (${version})`);
} else {
  console.log(
    `[helm-deployment-contract] offline mode${
      forcedSourceMode ? ' (HELM_CONTRACT_MODE=source)' : ': no helm binary found'
    }; asserting chart source contracts only — rendered contracts were NOT verified`,
  );
}

function runHelm(args: string[]): { status: number; stdout: string; stderr: string } {
  assert.ok(helmBin, 'runHelm called without a helm binary');
  const result = spawnSync(helmBin, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Controller-supplied values the owner lifecycle orchestrator sets at install. */
function demoArgs(): string[] {
  return [
    'template',
    'cell-demo',
    chart,
    '-f',
    demoValues,
    '--set',
    'image.tag=test',
    '--set',
    'tenantAuthority.proofOwnerSecret=cell-demo-proof-owner-r1',
    '--set',
    'tenantAuthority.releaseProjectionConfigMap=cell-demo-release-projection-r1',
  ];
}

function enterpriseArgs(): string[] {
  return [
    'template',
    'cell-enterprise',
    chart,
    '-f',
    enterpriseValues,
    '--set',
    'image.tag=test',
    '--set',
    'tenantAuthority.proofOwnerSecret=cell-enterprise-proof-owner-r1',
    '--set',
    'tenantAuthority.releaseProjectionConfigMap=cell-enterprise-release-projection-r1',
    '--set',
    'tenantAuthority.bootstrapAuthoritySecret=cell-enterprise-bootstrap-authority-r1',
  ];
}

function manifests(rendered: string): Manifest[] {
  return loadAll(rendered, undefined, { json: true }).filter(
    (value): value is Manifest => typeof value === 'object' && value !== null,
  );
}

function componentManifest(rendered: string, kind: string, component: string): Manifest {
  const found = manifests(rendered).find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.metadata?.labels?.['app.kubernetes.io/component'] === component,
  );
  assert.ok(found, `${kind} with component=${component} missing`);
  return found;
}

function envNames(manifest: Manifest, container: string): string[] {
  const containers = manifest.spec?.template?.spec?.containers ?? [];
  const target = containers.find((candidate) => candidate.name === container);
  assert.ok(target, `container ${container} missing`);
  return (target.env ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name));
}

function envEntry(manifest: Manifest, container: string, name: string) {
  const containers = manifest.spec?.template?.spec?.containers ?? [];
  const target = containers.find((candidate) => candidate.name === container);
  assert.ok(target, `container ${container} missing`);
  return (target.env ?? []).find((entry) => entry.name === name);
}

function containerOf(manifest: Manifest, container: string): Container {
  const containers = manifest.spec?.template?.spec?.containers ?? [];
  const target = containers.find((candidate) => candidate.name === container);
  assert.ok(target, `container ${container} missing`);
  return target;
}

function readinessProbe(manifest: Manifest, container: string) {
  return containerOf(manifest, container).readinessProbe;
}

function source(relativePath: string): string {
  return readFileSync(join(chartDirectory, relativePath), 'utf8');
}

describe('Helm deployment contract: web workload', () => {
  it('defaults web to disabled and ships no unbacked web Service', () => {
    const values = load(readFileSync(join(chartDirectory, 'values.yaml'), 'utf8')) as {
      web?: { enabled?: unknown };
    };
    assert.equal(values.web?.enabled, false, 'values.yaml web.enabled must default to false');

    const services = source('templates/services.yaml');
    assert.match(services, /include "commander\.requireWebDisabled"/);
    assert.doesNotMatch(
      services,
      /\{\{ include "commander\.fullname" \. \}\}-web\b/,
      'services.yaml must not render a web Service without a web workload',
    );
    assert.match(source('templates/_helpers.tpl'), /define "commander\.requireWebDisabled"/);

    if (helmBin) {
      const rendered = runHelm(demoArgs());
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.equal(
        manifests(rendered.stdout).some((value) => value.metadata?.name?.endsWith('-web')),
        false,
        'demo render must not contain a web Service',
      );
      assert.equal(
        manifests(rendered.stdout).some(
          (value) => value.metadata?.labels?.['app.kubernetes.io/component'] === 'web',
        ),
        false,
        'demo render must not contain any web component',
      );
    }
  });

  it('rejects web.enabled=true with an actionable message', () => {
    const helper = source('templates/_helpers.tpl');
    assert.match(helper, /web\.enabled=true is unsupported/);
    assert.match(helper, /no web image or web Deployment/);

    if (helmBin) {
      const rendered = runHelm([...demoArgs(), '--set', 'web.enabled=true']);
      assert.notEqual(rendered.status, 0, 'web.enabled=true must fail the render');
      assert.match(rendered.stderr, /web\.enabled=true is unsupported/);
      assert.match(rendered.stderr, /web\.enabled=false/);
    }
  });
});

describe('Helm deployment contract: API startup secrets', () => {
  it('requires every API startup secret ref outside tier=demo', () => {
    const helper = source('templates/_helpers.tpl');
    assert.match(helper, /define "commander\.requireApiStartupSecrets"/);
    for (const ref of [
      'masterKeySecret',
      'jwtSecretSecret',
      'apiKeySecret',
      'capabilityTokenKeySecret',
      'integrityKeySecret',
      'adminPasswordSecret',
    ]) {
      assert.match(helper, new RegExp(`api\\.secrets\\.${ref}`), `${ref} must gate the guard`);
    }
    assert.match(
      source('templates/deployment.yaml'),
      /include "commander\.requireApiStartupSecrets"/,
    );

    if (helmBin) {
      const bare = runHelm(['template', 'contract-default', chart]);
      assert.notEqual(
        bare.status,
        0,
        'bare team defaults must fail instead of rendering secret-less',
      );
      assert.match(
        bare.stderr,
        /requires api\.secrets\.existingSecret or all API startup secret refs/,
      );
      assert.match(bare.stderr, /api\.secrets\.adminPasswordSecret/);

      const complete = runHelm([
        ...demoArgs(),
        '--set',
        'tier=team',
        '--set',
        'worker.enabled=false',
        ...API_STARTUP_SECRET_ENV.map((name, index) => [
          '--set',
          `api.secrets.${
            [
              'masterKeySecret',
              'jwtSecretSecret',
              'apiKeySecret',
              'capabilityTokenKeySecret',
              'integrityKeySecret',
              'adminPasswordSecret',
            ][index]
          }=${name.toLowerCase()}`,
        ]).flat(),
      ]);
      assert.equal(complete.status, 0, complete.stderr);
      const api = componentManifest(complete.stdout, 'Deployment', 'api');
      for (const name of API_STARTUP_SECRET_ENV) {
        assert.ok(envNames(api, 'api').includes(name), `team render must mount ${name}`);
      }

      const enterprise = runHelm(enterpriseArgs());
      assert.equal(enterprise.status, 0, enterprise.stderr);
      const enterpriseApi = componentManifest(enterprise.stdout, 'Deployment', 'api');
      for (const name of API_STARTUP_SECRET_ENV) {
        const entry = envEntry(enterpriseApi, 'api', name);
        assert.ok(entry, `enterprise render must mount ${name}`);
        assert.equal(
          (entry.valueFrom as { secretKeyRef?: { name?: string } })?.secretKeyRef?.name,
          'cmdr-api',
        );
      }
    }
  });
});

describe('Helm deployment contract: worker auth reference', () => {
  it('requires worker.authTokenSecret when worker is enabled outside demo', () => {
    assert.match(source('templates/_helpers.tpl'), /define "commander\.requireWorkerAuthRef"/);
    assert.match(
      source('templates/worker-deployment.yaml'),
      /include "commander\.requireWorkerAuthRef"/,
    );

    if (helmBin) {
      const demo = runHelm(demoArgs());
      assert.equal(demo.status, 0, demo.stderr);
      const worker = componentManifest(demo.stdout, 'Deployment', 'worker');
      const token = envEntry(worker, 'worker', 'COMMANDER_WORKER_AUTH_TOKEN');
      assert.equal(
        (token?.valueFrom as { secretKeyRef?: { name?: string } })?.secretKeyRef?.name,
        'cell-demo-worker-token',
        'demo must resolve the chart-generated worker token Secret',
      );
      assert.ok(
        manifests(demo.stdout).some(
          (value) => value.kind === 'Secret' && value.metadata?.name === 'cell-demo-worker-token',
        ),
        'demo must render the generated worker token Secret',
      );

      const missing = runHelm([
        ...demoArgs(),
        '--set',
        'tier=team',
        '--set',
        'api.secrets.existingSecret=team-api',
        '--set',
        'worker.authTokenSecret=',
      ]);
      assert.notEqual(missing.status, 0, 'team worker without authTokenSecret must fail');
      assert.match(missing.stderr, /requires worker\.authTokenSecret when worker\.enabled=true/);
      assert.match(missing.stderr, /tier=demo/);

      const enterprise = runHelm(enterpriseArgs());
      assert.equal(enterprise.status, 0, enterprise.stderr);
      const enterpriseWorker = componentManifest(enterprise.stdout, 'Deployment', 'worker');
      assert.equal(
        (
          envEntry(enterpriseWorker, 'worker', 'COMMANDER_WORKER_AUTH_TOKEN')?.valueFrom as {
            secretKeyRef?: { name?: string };
          }
        )?.secretKeyRef?.name,
        'cmdr-worker',
      );
    }
  });
});

describe('Helm deployment contract: migration Job environment', () => {
  it('emits each migration env name at most once', () => {
    const migration = source('templates/migration-job.yaml');
    assert.doesNotMatch(
      migration,
      new RegExp(`- name: ${DUPLICATE_ENV}\\b`),
      `${DUPLICATE_ENV} must only be produced by the role range, never written literally`,
    );
    assert.match(
      migration,
      /"ADAPTER_OPS" \(include "commander\.databaseAdapterOpsSecretKey" \.\)/,
      'the role range must still cover ADAPTER_OPS',
    );

    if (helmBin) {
      for (const [profile, args] of [
        ['demo', demoArgs()],
        ['enterprise', enterpriseArgs()],
      ] as const) {
        const rendered = runHelm(args);
        assert.equal(rendered.status, 0, `${profile}: ${rendered.stderr}`);
        const job = componentManifest(rendered.stdout, 'Job', 'migration');
        const names = envNames(job, 'migration');
        assert.equal(
          names.filter((name) => name === DUPLICATE_ENV).length,
          1,
          `${profile} migration Job must set ${DUPLICATE_ENV} exactly once`,
        );
        assert.equal(
          new Set(names).size,
          names.length,
          `${profile} migration Job must not repeat env names: ${names.join(', ')}`,
        );
        assert.equal(
          (
            envEntry(job, 'migration', DUPLICATE_ENV)?.valueFrom as {
              secretKeyRef?: { key?: string };
            }
          )?.secretKeyRef?.key,
          'adapter-ops-url',
        );
      }
    }
  });
});

/**
 * The api container must never be handed a configuration the API rejects at
 * boot. Two independent failure modes are covered here:
 *
 *   1. The tenant-authority runtime identity env is consumed only by the proof
 *      listener, which the API starts only when PROOF_PORT is present. Emitting
 *      the identity without the port makes the API throw
 *      COMMANDER_TENANT_AUTHORITY_PROOF_PORT_REQUIRED from startServer.
 *   2. NODE_ENV=production without a durable kernel DSN makes the API refuse to
 *      start by design, so such a render can only ever CrashLoop.
 */
describe('Helm deployment contract: api probe and tenant-authority env coherence', () => {
  it('keeps the readiness probe and tenant-authority env aligned with the backend', () => {
    const deployment = source('templates/deployment.yaml');
    const helpers = source('templates/_helpers.tpl');

    assert.match(helpers, /define "commander\.requireDurableKernel"/);
    assert.match(deployment, /include "commander\.requireDurableKernel"/);
    assert.match(
      deployment,
      /if include "commander\.postgresBackend" \. \}\}(?:(?!\{\{- end)[\s\S])*?- name: COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST/,
      'the tenant-authority identity env must be gated on the postgres backend, like PROOF_PORT',
    );
    assert.match(
      deployment,
      /path: \{\{ \.Values\.api\.health\.readinessPath \}\}/,
      'the non-postgres readiness probe must use api.health.readinessPath',
    );

    if (!helmBin) return;

    const apiSecrets = ['--set', 'api.secrets.existingSecret=commander-api-secrets'];

    // production + sqlite cannot boot: fail at template time, not in the cluster.
    const unbootable = runHelm(['template', 'contract-default', chart, ...apiSecrets]);
    assert.notEqual(unbootable.status, 0, 'production + sqlite must fail the render');
    assert.match(unbootable.stderr, /requires the durable shared kernel/);

    // A non-production local-first render must be self-consistent.
    const local = runHelm([
      'template',
      'contract-local',
      chart,
      ...apiSecrets,
      '--set',
      'config.nodeEnv=development',
    ]);
    assert.equal(local.status, 0, local.stderr);
    const localApi = componentManifest(local.stdout, 'Deployment', 'api');
    const strayAuthorityEnv = envNames(localApi, 'api').filter((name) =>
      name.startsWith('COMMANDER_TENANT_AUTHORITY_'),
    );
    assert.deepEqual(
      strayAuthorityEnv,
      [],
      'a render without the proof listener must not emit tenant-authority env',
    );
    assert.equal(
      readinessProbe(localApi, 'api')?.httpGet?.path,
      '/ready',
      'local readiness must probe the documented /ready route',
    );

    // The postgres path keeps the identity env and the proof exec probe.
    const demo = runHelm(demoArgs());
    assert.equal(demo.status, 0, demo.stderr);
    const demoApi = componentManifest(demo.stdout, 'Deployment', 'api');
    assert.ok(
      envNames(demoApi, 'api').includes('COMMANDER_TENANT_AUTHORITY_PROOF_PORT'),
      'postgres render must expose the proof port',
    );
    assert.ok(
      readinessProbe(demoApi, 'api')?.exec,
      'postgres readiness must use the tenant-authority proof exec probe',
    );
  });
});
