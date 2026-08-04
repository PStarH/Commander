import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import {
  artifactPassedSemantics,
  assertInImageProbePayload,
  parseImageBootSmokeArtifact,
  parseInImageProbeStdout,
  probePayloadExitCode,
} from './l4-b-image-boot-smoke.js';

describe('l4-b-image-boot-smoke', () => {
  const happyPayload = {
    snapshotSchemaCount: 12,
    resourcesCount: 15,
    schemasDirEntryCount: 4,
    distIndexExists: true,
  };

  it('parses probe stdout JSON line', () => {
    const stdout =
      'noise\n{"snapshotSchemaCount":3,"resourcesCount":2,"schemasDirEntryCount":1,"distIndexExists":true}\n';
    const payload = parseInImageProbeStdout(stdout);
    assert.equal(payload.snapshotSchemaCount, 3);
  });

  it('happy probe payload validates with exit 0', () => {
    assert.doesNotThrow(() => assertInImageProbePayload(happyPayload));
    assert.equal(probePayloadExitCode(happyPayload), 0);
  });

  it('missing-schemas payload fails closed (non-zero exit)', () => {
    const missingSchemas = {
      ...happyPayload,
      schemasDirEntryCount: 0,
      snapshotSchemaCount: 0,
    };
    assert.throws(() => assertInImageProbePayload(missingSchemas), /schemas/);
    assert.notEqual(probePayloadExitCode(missingSchemas), 0);
  });

  it('artifact passed semantics require probe=in-image and snapshotSchemaCount > 0', () => {
    const raw = JSON.stringify({
      passed: true,
      imageTag: 'test',
      snapshotSchemaCount: 5,
      elapsedMs: 1,
      gitSha: 'abc',
      probe: 'in-image',
      usedBindMount: false,
      artifactPath: 'artifacts/x.json',
    });
    const artifact = parseImageBootSmokeArtifact(raw);
    assert.equal(artifactPassedSemantics(artifact), true);

    const bad = { ...artifact, usedBindMount: true as false };
    assert.equal(artifactPassedSemantics(bad), false);
  });

  it('includes postgres-runtime in every cell image dependency closure', () => {
    const images = [
      ['apps/api/Dockerfile', 'core'],
      ['packages/worker-plane/Dockerfile', 'core'],
      ['packages/kernel/Dockerfile.ops', 'kernel'],
      ['packages/adapter-ops/Dockerfile.ops', 'kernel'],
    ] as const;

    for (const [dockerfilePath, dependentPackage] of images) {
      const dockerfile = readFileSync(resolve(dockerfilePath), 'utf8');
      const message = (requirement: string): string => `${dockerfilePath}: ${requirement}`;

      assert.equal(
        dockerfile.match(
          /COPY packages\/postgres-runtime\/package\.json \.\/packages\/postgres-runtime\/package\.json/g,
        )?.length,
        2,
        message('manifest must exist in dependency and production stages'),
      );
      assert.match(
        dockerfile,
        /--filter @commander\/postgres-runtime/,
        message('install filter missing'),
      );
      assert.equal(
        dockerfile.match(
          /COPY --from=deps \/app\/packages\/postgres-runtime\/node_modules \.\/packages\/postgres-runtime\/node_modules/g,
        )?.length,
        2,
        message('dependencies must exist in build and production stages'),
      );
      assert.match(
        dockerfile,
        /COPY packages\/postgres-runtime \.\/packages\/postgres-runtime/,
        message('build source missing'),
      );
      assert.match(
        dockerfile,
        new RegExp(`RUN cd packages/postgres-runtime[\\s\\S]*RUN cd packages/${dependentPackage}`),
        message(`postgres-runtime declarations must be built before ${dependentPackage}`),
      );
      assert.match(
        dockerfile,
        /COPY --from=build \/app\/packages\/postgres-runtime\/dist \.\/packages\/postgres-runtime\/dist/,
        message('production dist missing'),
      );
    }
  });
});
