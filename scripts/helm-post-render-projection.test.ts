import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';
import { createNodePorts, projectPostRenderedHelmReleaseRevision } from './helm-tenant-cutover.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDigest = 'b'.repeat(64);

type Manifest = {
  kind?: string;
  metadata?: { name?: string };
};

function manifest(lines: readonly string[]): string {
  return lines.join('\n');
}

function renderedHooks(migrationPolicy = 'before-hook-creation,hook-succeeded'): string {
  return manifest([
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: commander-migration-r1',
    '  namespace: commander',
    '  annotations:',
    '    helm.sh/hook: pre-install,pre-upgrade,pre-rollback',
    '    helm.sh/hook-weight: "-10"',
    '    helm.sh/hook-delete-policy: ' + migrationPolicy,
    'spec: {}',
    '---',
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: commander-tenant-cutover-prove-r1',
    '  namespace: commander',
    '  annotations:',
    '    helm.sh/hook: post-install,post-upgrade',
    '    helm.sh/hook-weight: "10"',
    '    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded',
    'spec:',
    '  template:',
    '    spec:',
    '      volumes:',
    '        - name: release-projection',
    '          configMap:',
    '            name: commander-proof-projection-v7-r8',
  ]);
}

function bundledInstallHooks(migrationPolicy: string): string {
  return manifest([
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: commander-migration-r1',
    '  namespace: commander',
    '  annotations:',
    '    helm.sh/hook-delete-policy: ' + migrationPolicy,
    'spec: {}',
    '---',
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: commander-tenant-cutover-prove-r1',
    '  namespace: commander',
    '  annotations:',
    '    helm.sh/hook: post-install,post-upgrade',
    '    helm.sh/hook-weight: "10"',
    '    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded',
    'spec:',
    '  template:',
    '    spec:',
    '      volumes:',
    '        - name: release-projection',
    '          configMap:',
    '            name: commander-proof-projection-v7-r1',
  ]);
}

describe('Helm post-rendered release projection', () => {
  it('merges separately rendered hooks into the Helm post-rendered projection', () => {
    const projection = projectPostRenderedHelmReleaseRevision({
      namespace: 'commander',
      releaseName: 'commander',
      revision: '8',
      projectionConfigMapName: 'commander-proof-projection-v7-r8',
      values: dump({ tenantAuthority: { chartContentSha256: chartDigest } }),
      manifest: manifest([
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: commander-api',
        '  namespace: commander',
        'spec: {}',
      ]),
      hookManifest: renderedHooks(),
    });

    assert.deepEqual(
      projection.hooks.map((hook) => hook.identity.name),
      ['commander-migration-r8', 'commander-tenant-cutover-prove-r8'],
    );
    assert.deepEqual(
      projection.objects.map((object) => object.identity.name),
      ['commander-api'],
    );
  });

  it('rejects a bundled install migration with a drifted delete policy', () => {
    assert.throws(
      () =>
        projectPostRenderedHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '1',
          projectionConfigMapName: 'commander-proof-projection-v7-r1',
          values: dump({ tenantAuthority: { chartContentSha256: chartDigest } }),
          manifest: manifest([
            'apiVersion: batch/v1',
            'kind: Job',
            'metadata:',
            '  name: commander-migration-r1',
            '  namespace: commander',
            'spec: {}',
          ]),
          hookManifest: bundledInstallHooks('before-hook-creation'),
        }),
      /TENANT_CUTOVER_RELEASE_PROJECTION_INVALID/,
    );
  });

  it('verifies the stored revision and cleans the projection after a rollout', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'commander-helm-projection-process-'));
    const helmPath = join(temporary, 'helm');
    const kubectlPath = join(temporary, 'kubectl');
    const dataPath = join(temporary, 'helm-data.json');
    const statePath = join(temporary, 'projection.json');
    const chartPath = join(temporary, 'chart');
    const originalPath = process.env.PATH;
    const originalData = process.env.COMMANDER_FAKE_HELM_DATA;
    const originalState = process.env.COMMANDER_FAKE_KUBECTL_STATE;
    const originalEntry = process.argv[1];
    const ordinary =
      manifest([
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: commander-api',
        '  namespace: commander',
        'spec: {}',
      ]) +
      '\n# ' +
      'x'.repeat(1024 * 1024 + 1);
    const values = dump({
      api: { terminationGracePeriodSeconds: null },
      tenantAuthority: {
        allowedTenants: ['tenant-a'],
        chartContentSha256: chartDigest,
      },
    });
    const chartDefaults = load(
      readFileSync(resolve(root, 'deploy/helm/commander/values.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const storedHooks = renderedHooks()
      .replace('commander-migration-r1', 'commander-migration-r8')
      .replace('commander-tenant-cutover-prove-r1', 'commander-tenant-cutover-prove-r8');
    try {
      mkdirSync(chartPath);
      writeFileSync(
        join(chartPath, 'values.yaml'),
        readFileSync(resolve(root, 'deploy/helm/commander/values.yaml')),
      );
      writeFileSync(
        dataPath,
        JSON.stringify({
          ordinary,
          renderedHooks: renderedHooks(),
          storedHooks,
          values,
        }),
      );
      writeFileSync(
        helmPath,
        [
          '#!/usr/bin/env node',
          "const { execFileSync } = require('node:child_process');",
          "const { readFileSync, rmSync } = require('node:fs');",
          'const args = process.argv.slice(2);',
          'const data = JSON.parse(readFileSync(process.env.COMMANDER_FAKE_HELM_DATA, "utf8"));',
          'if (data.failAt === args[0]) process.exit(3);',
          'if (args[0] === "template") {',
          '  if (!args.includes("--is-upgrade")) process.exit(4);',
          '  if (readFileSync(0, "utf8") !== data.values) process.exit(6);',
          '  process.stdout.write(data.renderedHooks);',
          '}',
          'else if (args[0] === "upgrade") {',
          '  const renderer = args[args.indexOf("--post-renderer") + 1];',
          '  const prefix = "--post-renderer-args=";',
          '  const rendererArgs = args.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));',
          '  execFileSync(renderer, rendererArgs, { input: data.ordinary, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });',
          '  if (data.removeProjectionAfterProof) {',
          '    readFileSync(process.env.COMMANDER_FAKE_KUBECTL_STATE, "utf8");',
          '    rmSync(process.env.COMMANDER_FAKE_KUBECTL_STATE, { force: true });',
          '  }',
          '  if (data.failAfterPostRenderer) process.exit(3);',
          '}',
          'else if (args[0] === "history") process.stdout.write("[{\\"revision\\":\\"8\\"}]");',
          'else if (args[0] === "get" && args[1] === "values") {',
          '  if (args.includes("--all")) process.exit(5);',
          '  process.stdout.write(data.values);',
          '}',
          'else if (args[0] === "get" && args[1] === "manifest") process.stdout.write(data.ordinary);',
          'else if (args[0] === "get" && args[1] === "hooks") process.stdout.write(data.storedHooks);',
          'else process.exit(2);',
        ].join('\n'),
      );
      writeFileSync(
        kubectlPath,
        [
          '#!/usr/bin/env node',
          "const { readFileSync } = require('node:fs');",
          'process.stdout.write(readFileSync(process.env.COMMANDER_FAKE_KUBECTL_STATE, "utf8"));',
        ].join('\n'),
      );
      chmodSync(helmPath, 0o755);
      chmodSync(kubectlPath, 0o755);
      process.env.PATH = temporary + ':' + originalPath;
      process.env.COMMANDER_FAKE_HELM_DATA = dataPath;
      process.env.COMMANDER_FAKE_KUBECTL_STATE = statePath;
      process.argv[1] = resolve(root, 'scripts/helm-tenant-cutover.ts');
      const ports = createNodePorts({
        command: async (program, args, stdin) => {
          if (program === 'helm') {
            return execFileSync(helmPath, args, {
              encoding: 'utf8',
              input: stdin,
              maxBuffer: 64 * 1024 * 1024,
            });
          }
          if (program !== 'kubectl') throw new Error('unexpected program');
          if (args[0] === 'delete') {
            rmSync(statePath, { force: true });
            return '';
          }
          if (
            args[0] === 'get' &&
            (JSON.parse(readFileSync(dataPath, 'utf8')) as { failReadAfterCreate?: boolean })
              .failReadAfterCreate &&
            existsSync(statePath)
          ) {
            throw new Error('TENANT_CUTOVER_KUBECTL_GET_FAILED');
          }
          if (args[0] === 'get')
            return existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
          if (args[0] === 'create' && stdin) {
            if (
              (JSON.parse(readFileSync(dataPath, 'utf8')) as { failCreate?: boolean }).failCreate
            ) {
              return '';
            }
            writeFileSync(statePath, stdin);
            return 'configmap/commander-proof-projection-v7-r8';
          }
          throw new Error('unexpected kubectl command');
        },
      });

      const projection = await ports.helm.runProjectedRevision({
        namespace: 'commander',
        release: 'commander',
        revision: '8',
        projectionConfigMapName: 'commander-proof-projection-v7-r8',
        args: [
          'upgrade',
          '--install',
          'commander',
          chartPath,
          '--namespace',
          'commander',
          '--values',
          '-',
          '--set',
          'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
          '--atomic',
          '--wait',
          '--wait-for-jobs',
          '--timeout',
          '10m',
        ],
        rendererValues: values,
      });

      assert.deepEqual(
        projection.hooks.map((hook) => hook.identity.name),
        ['commander-migration-r8', 'commander-tenant-cutover-prove-r8'],
      );
      const projectedValues = projection.rendererInput.values as Record<string, unknown>;
      assert.deepEqual(projectedValues.migration, chartDefaults.migration);
      assert.deepEqual(projectedValues.podSecurityContext, chartDefaults.podSecurityContext);
      assert.deepEqual(projectedValues.api, { terminationGracePeriodSeconds: null });
      assert.equal(Object.hasOwn(projectedValues, 'web'), false);
      const projectedTenantAuthority = projectedValues.tenantAuthority as Record<string, unknown>;
      const defaultTenantAuthority = chartDefaults.tenantAuthority as Record<string, unknown>;
      assert.deepEqual(projectedTenantAuthority.allowedTenants, ['tenant-a']);
      assert.deepEqual(projectedTenantAuthority.apiProof, defaultTenantAuthority.apiProof);
      assert.equal(existsSync(statePath), false);
      assert.deepEqual(
        await ports.helm.projectRevision('commander', 'commander', '8', chartPath),
        projection,
      );

      writeFileSync(
        dataPath,
        JSON.stringify({
          ordinary,
          renderedHooks: renderedHooks(),
          storedHooks,
          values,
          removeProjectionAfterProof: true,
        }),
      );
      const projectionAfterProofCleanup = await ports.helm.runProjectedRevision({
        namespace: 'commander',
        release: 'commander',
        revision: '8',
        projectionConfigMapName: 'commander-proof-projection-v7-r8',
        args: [
          'upgrade',
          '--install',
          'commander',
          chartPath,
          '--namespace',
          'commander',
          '--values',
          '-',
          '--set',
          'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
          '--atomic',
          '--wait',
          '--wait-for-jobs',
          '--timeout',
          '10m',
        ],
        rendererValues: values,
      });
      assert.deepEqual(projectionAfterProofCleanup, projection);

      for (const [failAt, code] of [
        ['template', 'TENANT_CUTOVER_HELM_POST_RENDER_COMMAND_FAILED'],
        ['upgrade', 'TENANT_CUTOVER_HELM_POST_RENDER_COMMAND_FAILED'],
        ['history', 'TENANT_CUTOVER_HELM_PROJECTION_COMMAND_FAILED'],
        ['get', 'TENANT_CUTOVER_HELM_PROJECTION_COMMAND_FAILED'],
      ]) {
        writeFileSync(
          dataPath,
          JSON.stringify({
            ordinary,
            renderedHooks: renderedHooks(),
            storedHooks,
            values,
            failAt,
          }),
        );
        await assert.rejects(
          () =>
            ports.helm.runProjectedRevision({
              namespace: 'commander',
              release: 'commander',
              revision: '8',
              projectionConfigMapName: 'commander-proof-projection-v7-r8',
              args: [
                'upgrade',
                '--install',
                'commander',
                chartPath,
                '--namespace',
                'commander',
                '--values',
                '-',
                '--set',
                'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
                '--atomic',
                '--wait',
                '--wait-for-jobs',
                '--timeout',
                '10m',
              ],
              rendererValues: values,
            }),
          new RegExp(code),
        );
        assert.equal(existsSync(statePath), false);
      }

      writeFileSync(
        dataPath,
        JSON.stringify({
          ordinary,
          renderedHooks: renderedHooks(),
          storedHooks,
          values,
          failAfterPostRenderer: true,
        }),
      );
      await assert.rejects(
        () =>
          ports.helm.runProjectedRevision({
            namespace: 'commander',
            release: 'commander',
            revision: '8',
            projectionConfigMapName: 'commander-proof-projection-v7-r8',
            args: [
              'upgrade',
              '--install',
              'commander',
              chartPath,
              '--namespace',
              'commander',
              '--values',
              '-',
              '--set',
              'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
              '--atomic',
              '--wait',
              '--wait-for-jobs',
              '--timeout',
              '10m',
            ],
            rendererValues: values,
          }),
        /TENANT_CUTOVER_HELM_COMMAND_FAILED/,
      );
      assert.equal(existsSync(statePath), false);

      writeFileSync(
        dataPath,
        JSON.stringify({
          ordinary,
          renderedHooks: renderedHooks(),
          storedHooks,
          values,
          failReadAfterCreate: true,
        }),
      );
      await assert.rejects(
        () =>
          ports.helm.runProjectedRevision({
            namespace: 'commander',
            release: 'commander',
            revision: '8',
            projectionConfigMapName: 'commander-proof-projection-v7-r8',
            args: [
              'upgrade',
              '--install',
              'commander',
              chartPath,
              '--namespace',
              'commander',
              '--values',
              '-',
              '--set',
              'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
              '--atomic',
              '--wait',
              '--wait-for-jobs',
              '--timeout',
              '10m',
            ],
            rendererValues: values,
          }),
        /TENANT_CUTOVER_KUBECTL_GET_FAILED/,
      );
      assert.equal(existsSync(statePath), false);

      writeFileSync(
        dataPath,
        JSON.stringify({
          ordinary,
          renderedHooks: renderedHooks(),
          storedHooks,
          values,
          failCreate: true,
        }),
      );
      await assert.rejects(
        () =>
          ports.helm.runProjectedRevision({
            namespace: 'commander',
            release: 'commander',
            revision: '8',
            projectionConfigMapName: 'commander-proof-projection-v7-r8',
            args: [
              'upgrade',
              '--install',
              'commander',
              chartPath,
              '--namespace',
              'commander',
              '--values',
              '-',
              '--set',
              'tenantAuthority.releaseProjectionConfigMap=commander-proof-projection-v7-r8',
              '--atomic',
              '--wait',
              '--wait-for-jobs',
              '--timeout',
              '10m',
            ],
            rendererValues: values,
          }),
        /TENANT_CUTOVER_RELEASE_PROJECTION_CREATE_FAILED/,
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalData === undefined) delete process.env.COMMANDER_FAKE_HELM_DATA;
      else process.env.COMMANDER_FAKE_HELM_DATA = originalData;
      if (originalState === undefined) delete process.env.COMMANDER_FAKE_KUBECTL_STATE;
      else process.env.COMMANDER_FAKE_KUBECTL_STATE = originalState;
      process.argv[1] = originalEntry;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('reconstructs hooks outside the real Helm 3 post-renderer input', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'commander-helm-post-render-'));
    try {
      const chart = load(
        readFileSync(resolve(root, 'deploy/helm/commander/Chart.yaml'), 'utf8'),
      ) as { annotations: Record<string, string> };
      const values = load(
        readFileSync(resolve(root, 'deploy/helm/commander/values-demo.yaml'), 'utf8'),
      ) as Record<string, unknown>;
      const image = values.image as Record<string, unknown>;
      const databaseTls = values.databaseTls as Record<string, unknown>;
      const tenantAuthority = values.tenantAuthority as Record<string, unknown>;
      const apiProof = tenantAuthority.apiProof as Record<string, unknown>;
      image.digest = 'sha256:' + 'a'.repeat(64);
      databaseTls.existingSecret = 'database-server-tls';
      databaseTls.expectedServerSpkiSha256 = 'c'.repeat(64);
      tenantAuthority.configurationSha256 = chartDigest;
      tenantAuthority.chartContentSha256 = chart.annotations['commander.io/content-sha256'];
      tenantAuthority.proofOwnerSecret = ['boundary', 'proof', 'owner', 'r1'].join('-');
      tenantAuthority.releaseProjectionConfigMap = 'boundary-projection-r1';
      apiProof.publicSecret = 'api-proof-public';
      apiProof.privateSecret = 'api-proof-private';
      const valuesPath = join(temporary, 'values.yaml');
      const captureScript = join(temporary, 'capture.cjs');
      const capturedManifest = join(temporary, 'post-rendered.yaml');
      writeFileSync(valuesPath, dump(values, { noRefs: true, sortKeys: true }));
      writeFileSync(
        captureScript,
        [
          "const { writeFileSync } = require('node:fs');",
          'const chunks = [];',
          "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));",
          "process.stdin.on('end', () => {",
          '  const body = Buffer.concat(chunks);',
          '  writeFileSync(process.argv[2], body);',
          '  process.stdout.write(body);',
          '});',
        ].join('\n'),
      );
      const baseArgs = [
        'template',
        'boundary',
        'deploy/helm/commander',
        '--namespace',
        'default',
        '--values',
        valuesPath,
      ];
      execFileSync(
        'helm',
        [
          ...baseArgs,
          '--post-renderer',
          process.execPath,
          '--post-renderer-args=' + captureScript,
          '--post-renderer-args=' + capturedManifest,
        ],
        { cwd: root, stdio: 'ignore' },
      );
      const captured = readFileSync(capturedManifest, 'utf8');
      const regularManifest = loadAll(captured)
        .filter((document): document is Manifest => {
          if (!document || typeof document !== 'object') return false;
          const candidate = document as Manifest;
          return (
            (candidate.kind === 'ServiceAccount' &&
              candidate.metadata?.name?.startsWith('commander-proof-reader-')) ||
            (candidate.kind === 'Job' && candidate.metadata?.name === 'boundary-migration-r1')
          );
        })
        .map((document) => dump(document, { noRefs: true, lineWidth: -1 }))
        .join('---\n');
      const hooks = execFileSync(
        'helm',
        [
          ...baseArgs,
          '--show-only',
          'templates/migration-job.yaml',
          '--show-only',
          'templates/tenant-cutover-prove-job.yaml',
        ],
        { cwd: root, encoding: 'utf8' },
      );

      assert.doesNotMatch(captured, /helm\.sh\/hook: post-install,post-upgrade/);
      const projection = projectPostRenderedHelmReleaseRevision({
        namespace: 'default',
        releaseName: 'boundary',
        revision: '1',
        projectionConfigMapName: 'boundary-projection-r1',
        manifest: regularManifest,
        hookManifest: hooks,
        values:
          'tenantAuthority:\n  chartContentSha256: ' +
          chart.annotations['commander.io/content-sha256'] +
          '\n',
      });
      assert.deepEqual(
        projection.hooks.map((hook) => hook.identity.name),
        ['boundary-tenant-cutover-prove-r1'],
      );
      assert.equal(
        projection.objects.some((object) => object.identity.name === 'boundary-migration-r1'),
        true,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
