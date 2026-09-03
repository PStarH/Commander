import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLaunchBundle } from './launch-verify.js';

const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const;

async function fixture(options: { missingGate?: string; secret?: boolean; dirty?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'commander-launch-verify-'));
  await mkdir(join(root, 'g8'), { recursive: true });
  await writeFile(
    join(root, 'source.json'),
    JSON.stringify({
      commit: 'a'.repeat(40),
      dirty: options.dirty ?? false,
      lockfileSha256: 'b'.repeat(64),
      imageDigests: ['commander@sha256:' + 'c'.repeat(64)],
    }),
  );
  for (const gate of GATES) {
    if (gate === options.missingGate) continue;
    const artifact = join(root, gate.toLowerCase(), 'proof.json');
    await mkdir(join(root, gate.toLowerCase()), { recursive: true });
    await writeFile(artifact, JSON.stringify({ gate, result: options.secret ? 'sk-live' : 'ok' }));
    const artifactSha256 = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex');
    await writeFile(
      join(root, gate.toLowerCase(), 'verdict.json'),
      JSON.stringify({
        schema: 'commander-enterprise-gate/v1',
        gate,
        verdict: 'PROVEN',
        evidenceLevel: 'PROVEN',
        artifacts: [{ path: 'proof.json', sha256: artifactSha256 }],
      }),
    );
  }
  return root;
}

describe('launch evidence verification', () => {
  it('rejects a bundle with a missing required gate', async () => {
    const evidence = await fixture({ missingGate: 'G5' });
    const result = await verifyLaunchBundle({ release: 'v0.2.0-test', evidence });
    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('GATE_ARTIFACT_MISSING:G5'));
  });

  it('accepts seven proven sanitized gates from a clean source', async () => {
    const evidence = await fixture();
    const result = await verifyLaunchBundle({ release: 'v0.2.0-test', evidence });
    assert.equal(result.verdict, 'PROVEN');
    assert.equal(result.failures.length, 0);
    assert.equal(result.gates.G7, 'PROVEN');
  });

  it('rejects dirty source and retained secrets', async () => {
    const evidence = await fixture({ secret: true, dirty: true });
    const result = await verifyLaunchBundle({ release: 'v0.2.0-test', evidence });
    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('SOURCE_DIRTY'));
    assert.ok(result.failures.some((failure) => failure.startsWith('SECRET_DETECTED:')));
  });
});
