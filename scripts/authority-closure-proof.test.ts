import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  canonicalJson,
  createArtifactManifest,
  ed25519Material,
  finalizeResult,
  mergeJwksJson,
  resolveOwnerDsn,
  sha256Hex,
  validateProofMetadata,
  type AuthorityProofMetadata,
  type AuthorityProofFlags,
} from './authority-closure-proof.js';

const allTrueFlags = (): AuthorityProofFlags => ({
  database: {
    rlsEnabled: true,
    rolesSeparated: true,
    workerDirectInsertRejected: true,
    workerDirectUpdateRejected: true,
    workerCrossTenantRegisterRejected: true,
    peerClaimWithoutSecretRejected: true,
    workerIdentityTakeoverRejected: true,
    workerRevocationDeleteRejected: true,
    claimExecuteRequiresSecret: true,
    workerOutsideAllowlistWriteRejected: true,
    adapterOpsRoleSeparated: true,
    adapterOpsRpcOnly: true,
    classAAdmissionRpcOnly: true,
    schedulerRawEffectInsertRejected: true,
    runtimeCrossTenantAdmissionRejected: true,
    invalidAdapterOpsWorkerIdRejected: true,
  },
  effect: { policyBound: true, actionDigestBound: true, actionDigestRequired: true, fenced: true },
  capability: {
    replayRejected: true,
    revocationObserved: true,
    rotationObserved: true,
    enterpriseRefusesGenerate: true,
  },
});

describe('authority-closure-proof helpers', () => {
  const completeMetadata = (): AuthorityProofMetadata => ({
    workflowId: 'commander-wave2-task1-authority-closure',
    source: {
      commit: 'abc123', dirty: true, trackedDiffSha256: 'd'.repeat(64),
      untrackedFiles: [`packages/kernel/src/task1Authority.test.ts:sha256:${'e'.repeat(64)}`],
    },
    versions: {
      dependencies: 'pnpm-lock.yaml', image: 'local-source', protocol: 'v1',
      contract: 'v1', policy: 'v1', adapter: 'v1',
    },
    environment: {
      topology: 'single-process-local', backend: 'postgresql-16',
      tenants: ['tenant-a'], databaseRoles: ['commander_owner', 'commander_app'],
    },
    provider: { externalSystemReality: 'not-applicable' },
    fault: { description: 'none', injectionPoints: ['not-applicable'] },
    outcomes: { expected: ['all authority gates true'], observed: ['all authority gates true'] },
    timing: {
      startedAt: '2026-07-25T00:00:00.000Z', endedAt: '2026-07-25T00:00:01.000Z', durationMs: 1000,
    },
    generatingCommand: 'pnpm proof:authority',
    hashes: {
      logs: [`authority-proof.log.json:sha256:${'a'.repeat(64)}`],
      evidence: [`authority-proof.evidence.json:sha256:${'b'.repeat(64)}`],
      artifacts: [`scripts/authority-closure-proof.ts:sha256:${'c'.repeat(64)}`],
    },
    limitations: ['local PostgreSQL only'],
    untestedBranches: ['external providers'],
  });

  it('fails closed with the exact field name when any mandatory Product Proof metadata group is empty', () => {
    assert.deepEqual(validateProofMetadata(completeMetadata()), []);
    const mandatoryFields: Array<[string, (metadata: AuthorityProofMetadata) => void]> = [
      ['workflowId', (metadata) => { metadata.workflowId = ''; }],
      ['source.commit', (metadata) => { metadata.source.commit = ''; }],
      ['source.dirty', (metadata) => { delete (metadata.source as Partial<typeof metadata.source>).dirty; }],
      ['source.trackedDiffSha256', (metadata) => { metadata.source.trackedDiffSha256 = ''; }],
      ['versions.dependencies', (metadata) => { metadata.versions.dependencies = ''; }],
      ['versions.image', (metadata) => { metadata.versions.image = ''; }],
      ['versions.protocol', (metadata) => { metadata.versions.protocol = ''; }],
      ['versions.contract', (metadata) => { metadata.versions.contract = ''; }],
      ['versions.policy', (metadata) => { metadata.versions.policy = ''; }],
      ['versions.adapter', (metadata) => { metadata.versions.adapter = ''; }],
      ['environment.topology', (metadata) => { metadata.environment.topology = ''; }],
      ['environment.backend', (metadata) => { metadata.environment.backend = ''; }],
      ['environment.tenants', (metadata) => { metadata.environment.tenants = []; }],
      ['environment.databaseRoles', (metadata) => { metadata.environment.databaseRoles = []; }],
      ['provider.externalSystemReality', (metadata) => { metadata.provider.externalSystemReality = ''; }],
      ['fault.description', (metadata) => { metadata.fault.description = ''; }],
      ['fault.injectionPoints', (metadata) => { metadata.fault.injectionPoints = []; }],
      ['outcomes.expected', (metadata) => { metadata.outcomes.expected = []; }],
      ['outcomes.observed', (metadata) => { metadata.outcomes.observed = []; }],
      ['timing.startedAt', (metadata) => { metadata.timing.startedAt = ''; }],
      ['timing.endedAt', (metadata) => { metadata.timing.endedAt = ''; }],
      ['timing.durationMs', (metadata) => { metadata.timing.durationMs = -1; }],
      ['generatingCommand', (metadata) => { metadata.generatingCommand = ''; }],
      ['hashes.logs', (metadata) => { metadata.hashes.logs = []; }],
      ['hashes.evidence', (metadata) => { metadata.hashes.evidence = []; }],
      ['hashes.artifacts', (metadata) => { metadata.hashes.artifacts = []; }],
      ['limitations', (metadata) => { metadata.limitations = []; }],
      ['untestedBranches', (metadata) => { metadata.untestedBranches = []; }],
    ];

    for (const [field, makeEmpty] of mandatoryFields) {
      const incomplete = completeMetadata();
      makeEmpty(incomplete);
      assert.deepEqual(validateProofMetadata(incomplete), [`mandatory metadata empty: ${field}`]);
    }
  });

  it('rejects placeholder hashes that cannot be tied to retained bytes', () => {
    const metadata = completeMetadata();
    metadata.hashes.logs = ['sha256:log'];
    assert.match(validateProofMetadata(metadata).join('\n'), /hashes\.logs/i);
  });

  it('rejects malformed tracked-diff and untracked-source hashes', () => {
    const metadata = completeMetadata();
    metadata.source.trackedDiffSha256 = 'not-a-hash';
    metadata.source.untrackedFiles = ['packages/kernel/src/new.ts:sha256:not-a-hash'];
    assert.deepEqual(validateProofMetadata(metadata), [
      'invalid source hash: source.trackedDiffSha256',
      'invalid source hash reference: source.untrackedFiles',
    ]);
  });

  it('hashes real proof inputs and reports only fault points exercised by this command', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sha256Hex\('pnpm-lock\.yaml'\)/);
    assert.doesNotMatch(source, /sha256Hex\('authority-closure-proof-input'\)/);
    assert.doesNotMatch(source, /injectionPoints:\s*\[[^\]]*operations-worker-row-lock/);
    assert.match(source, /readFileSync\(resolve\(ROOT, 'pnpm-lock\.yaml'\)\)/);
  });

  it('loads current workspace sources instead of stale package build output', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from '@commander\/(?:kernel|effect-broker)'/);
    assert.match(source, /from '\.\.\/packages\/kernel\/src\/index\.js'/);
    assert.match(source, /from '\.\.\/packages\/effect-broker\/src\/index\.js'/);
  });

  it('uses one explicit instant for the outbox fixture and its claim', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    const block = source.match(/const outboxId =[\s\S]*?const outboxSecretOk =/)?.[0] ?? '';

    assert.match(block, /const claimNow = new Date\(\);/);
    assert.match(block, /available_at\)\s*VALUES \([^)]*\$6::timestamptz\)/);
    assert.match(block, /KERNEL_COMPENSATION_TOPIC[\s\S]*?claimNow\.toISOString\(\)/);
    assert.doesNotMatch(block, /clock_timestamp/);
  });

  it('records the timestamp-suffixed proof tenant IDs in metadata', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.match(
      source,
      /metadata: buildProofMetadata\(\s*\{\s*gitSha,\s*startedAt,\s*endedAt,\s*flags,\s*failures,\s*tenants:\s*\[tenantA,\s*tenantB,\s*tenantCap\],\s*source,?\s*\}\s*\)/,
    );
    assert.match(source, /tenants: input\.tenants/);
  });

  it('retains a source manifest that binds the tracked diff and every untracked source path', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.match(source, /authority-closure-proof-latest\.source\.json/);
    assert.match(source, /git', \['diff', '--binary', 'HEAD', '--'\]/);
    assert.match(source, /maxBuffer:\s*64 \* 1024 \* 1024/);
    assert.match(source, /git',\s*\['ls-files',\s*'--others',\s*'--exclude-standard',\s*'-z'\]/);
    assert.match(source, /trackedDiffSha256/);
    assert.match(source, /untrackedFiles/);
  });

  it('binds the retained source manifest hash into proof artifact metadata', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.match(source, /hashes:\s*\{[\s\S]*artifacts:[\s\S]*source\.json:sha256:/);
    assert.match(source, /writeFile\(SOURCE_MANIFEST_PATH, sourceManifestBody, 'utf8'\)/);
  });

  it('attacks scheduler insertion, cross-tenant admission RPCs, and invalid adapter-ops IDs', () => {
    const source = readFileSync(new URL('./authority-closure-proof.ts', import.meta.url), 'utf8');
    assert.match(source, /schedulerRawEffectInsertRejected/);
    assert.match(source, /runtimeCrossTenantAdmissionRejected/);
    assert.match(source, /invalidAdapterOpsWorkerIdRejected/);
    assert.match(source, /admit_class_a_effect/);
    assert.match(source, /admit_non_class_a_effect/);
    assert.match(source, /ADAPTER_OPS_INSTANCE_INVALID/);
  });

  it('retains complete metadata and fails closed when finalizeResult receives none', () => {
    const complete = finalizeResult({
      gitSha: 'abc123', flags: allTrueFlags(), failures: [], metadata: completeMetadata(),
    });
    assert.deepEqual(complete.metadata, completeMetadata());
    assert.equal(complete.evidenceLevel, 'ENFORCED');

    const missing = finalizeResult({ gitSha: 'abc123', flags: allTrueFlags(), failures: [] });
    assert.equal(missing.passed, false);
    assert.equal(missing.evidenceLevel, 'FAILED');
    assert.ok(missing.failures.some((failure) => /mandatory metadata/i.test(failure)));
  });

  it('emits the artifact hash in a sibling manifest without a self-hash cycle', () => {
    const artifactBody = `${canonicalJson({ evidenceLevel: 'ENFORCED' })}\n`;
    const manifest = createArtifactManifest('authority-closure-proof-latest.json', artifactBody);
    assert.equal(manifest.artifactSha256, sha256Hex(artifactBody));
    assert.equal(manifest.artifact, 'authority-closure-proof-latest.json');
  });

  it('resolveOwnerDsn prefers OWNER_DSN over kernel and DATABASE_URL', () => {
    assert.equal(
      resolveOwnerDsn({
        OWNER_DSN: 'postgres://owner:o@127.0.0.1:5433/commander',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel:k@127.0.0.1:5433/commander',
        DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander',
      }),
      'postgres://owner:o@127.0.0.1:5433/commander',
    );
  });

  it('resolveOwnerDsn falls back to COMMANDER_KERNEL_DATABASE_URL then DATABASE_URL then default', () => {
    assert.equal(
      resolveOwnerDsn({
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel:k@127.0.0.1:5433/commander',
        DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander',
      }),
      'postgres://kernel:k@127.0.0.1:5433/commander',
    );
    assert.equal(
      resolveOwnerDsn({ DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander' }),
      'postgres://db:d@127.0.0.1:5433/commander',
    );
    assert.equal(
      resolveOwnerDsn({}),
      'postgres://commander:commander@127.0.0.1:5433/commander',
    );
  });

  it('canonicalJson sorts object keys stably', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('sha256Hex is deterministic', () => {
    assert.equal(
      sha256Hex('hello'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('caps dirty single-process database proof at ENFORCED when every gate passes', () => {
    const proven = finalizeResult({
      gitSha: 'abc123',
      flags: allTrueFlags(),
      failures: [],
      metadata: completeMetadata(),
      checkedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(proven.passed, true);
    assert.equal(proven.evidenceLevel, 'ENFORCED');
    assert.deepEqual(proven.failures, []);
  });

  it('finalizeResult fail-closes on any false flag', () => {
    const flags = allTrueFlags();
    flags.effect.fenced = false;
    const failed = finalizeResult({
      gitSha: 'abc123',
      flags,
      failures: [],
      metadata: completeMetadata(),
      checkedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.ok(failed.failures.some((f) => f.includes('effect.fenced')));
  });

  it('finalizeResult fail-closes on unknown gitSha', () => {
    const failed = finalizeResult({
      gitSha: 'unknown',
      flags: allTrueFlags(),
      failures: [],
      metadata: completeMetadata(),
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.ok(failed.failures.some((f) => /gitSha/i.test(f)));
  });

  it('finalizeResult fail-closes when failures already present', () => {
    const failed = finalizeResult({
      gitSha: 'abc123',
      flags: allTrueFlags(),
      failures: ['connect refused'],
      metadata: completeMetadata(),
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.deepEqual(failed.failures, ['connect refused']);
  });

  it('mergeJwksJson builds dual JWKS with both kids for rotation proofs', () => {
    const a = ed25519Material('a');
    const b = ed25519Material('b');
    const dual = JSON.parse(mergeJwksJson(a, b)) as { keys: Array<{ kid: string; x: string }> };
    assert.equal(dual.keys.length, 2);
    const kids = dual.keys.map((k) => k.kid).sort();
    assert.deepEqual(kids, ['a', 'b']);
    assert.equal(dual.keys.find((k) => k.kid === 'a')?.x, a.publicJwk.x);
    assert.equal(dual.keys.find((k) => k.kid === 'b')?.x, b.publicJwk.x);
  });
});
