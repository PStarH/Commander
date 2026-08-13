import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workerDockerfile = readFileSync(
  new URL('../packages/worker-plane/Dockerfile', import.meta.url),
  'utf8',
);
const apiDockerfile = readFileSync(new URL('../apps/api/Dockerfile', import.meta.url), 'utf8');
const kernelOpsDockerfile = readFileSync(
  new URL('../packages/kernel/Dockerfile.ops', import.meta.url),
  'utf8',
);
const adapterOpsDockerfile = readFileSync(
  new URL('../packages/adapter-ops/Dockerfile.ops', import.meta.url),
  'utf8',
);

function assertBuildsRuntimeBeforeConsumer(dockerfile: string, consumer: string): void {
  const runtimeBuild = dockerfile.indexOf('RUN cd packages/postgres-runtime');
  const consumerBuild = dockerfile.indexOf(`RUN cd ${consumer}`);
  assert.ok(runtimeBuild >= 0, 'postgres-runtime must be built in the image');
  assert.ok(consumerBuild >= 0, `${consumer} must be built in the image`);
  assert.ok(runtimeBuild < consumerBuild, 'postgres-runtime must build before its consumer');
}

function assertRuntimeClosure(dockerfile: string, consumer: string): void {
  assert.match(dockerfile, /COPY packages\/postgres-runtime\/package\.json/);
  assert.match(dockerfile, /--filter @commander\/postgres-runtime/);
  assert.match(dockerfile, /COPY packages\/postgres-runtime \.\/packages\/postgres-runtime/);
  assert.match(dockerfile, /COPY --from=deps \/app\/packages\/postgres-runtime\/node_modules/);
  assert.match(dockerfile, /COPY --from=build \/app\/packages\/postgres-runtime\/dist/);
  assertBuildsRuntimeBeforeConsumer(dockerfile, consumer);
}

describe('verified PostgreSQL runtime Docker closure', () => {
  it('includes postgres-runtime in the worker install, build, and production closure', () => {
    assert.match(workerDockerfile, /COPY packages\/postgres-runtime\/package\.json/);
    assert.match(workerDockerfile, /--filter @commander\/postgres-runtime/);
    assert.match(
      workerDockerfile,
      /COPY packages\/postgres-runtime \.\/packages\/postgres-runtime/,
    );
    assert.match(workerDockerfile, /COPY --from=build \/app\/packages\/postgres-runtime\/dist/);
    assertBuildsRuntimeBeforeConsumer(workerDockerfile, 'packages/kernel');
  });

  it('builds postgres-runtime before the API kernel dependency', () => {
    assertBuildsRuntimeBeforeConsumer(apiDockerfile, 'packages/kernel');
  });

  it('includes postgres-runtime in the kernel ops closure', () => {
    assertRuntimeClosure(kernelOpsDockerfile, 'packages/kernel');
  });

  it('includes postgres-runtime in the adapter ops closure', () => {
    assertRuntimeClosure(adapterOpsDockerfile, 'packages/kernel');
  });
});
