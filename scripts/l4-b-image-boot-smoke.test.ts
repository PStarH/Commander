import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
    const stdout = 'noise\n{"snapshotSchemaCount":3,"resourcesCount":2,"schemasDirEntryCount":1,"distIndexExists":true}\n';
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
});
