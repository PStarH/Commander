// LM-12 contract — production may only promote the candidate staging proved.
//
// Two independent layers, on purpose:
//
//   1. A table-driven contract over the REAL verifier module
//      (`scripts/cd-manifest-verify.ts`), which is exactly what `.github/workflows/cd.yml`
//      executes via `pnpm exec tsx`. There is no parallel "test-only policy" here: the table
//      drives the shipped implementation and proves the CLI refuses the same inputs.
//   2. A structural contract over the real `cd.yml` proving the workflow wires those
//      verifications in the right order, that production never builds, and that production
//      never receives staging credentials.
//
// Run: node --import tsx --test scripts/cd-staging-contract.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  REQUIRED_CHECKS,
  REQUIRED_EXTERNAL_IMAGES,
  REQUIRED_SERVICES,
  hashManifestBytes,
  verifyCandidateManifest,
  verifyStagingMarker,
  type CandidateManifest,
  type ServiceDigestMap,
  type StagingValidationMarker,
} from './cd-manifest-verify.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so a pre-fix snapshot of cd.yml can be audited without touching the shared
// working tree (used to capture red-before evidence).
const CD_WORKFLOW = resolve(process.env.CD_WORKFLOW_PATH ?? join(root, '.github/workflows/cd.yml'));
const cdSource = readFileSync(CD_WORKFLOW, 'utf8');
const cd = loadYaml(cdSource) as {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      needs?: string[];
      if?: string;
      environment?: string;
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
        env?: Record<string, string>;
      }>;
    }
  >;
};

const CANDIDATE = 'a'.repeat(40);
const OTHER_CANDIDATE = 'b'.repeat(40);
const RUN_ID = '1234567890';
const ATTEMPT = 2;
const digest = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const SERVICE_IMAGE: Record<string, string> = {
  api: `ghcr.io/commander/candidate-api@sha256:${digest('api')}`,
  'kernel-migrate': `ghcr.io/commander/candidate-kernel-migrate@sha256:${digest('kernel-migrate')}`,
  'kernel-ops': `ghcr.io/commander/candidate-kernel-ops@sha256:${digest('kernel-ops')}`,
  worker: `ghcr.io/commander/candidate-worker@sha256:${digest('worker')}`,
  'adapter-ops': `ghcr.io/commander/candidate-adapter-ops@sha256:${digest('adapter-ops')}`,
  web: `ghcr.io/commander/candidate-web@sha256:${digest('web')}`,
  postgres: `postgres@sha256:${digest('postgres')}`,
  migrator: `ghcr.io/commander/migrator@sha256:${digest('migrator')}`,
};

/** Every service the manifest must declare for the promotion to be complete. */
const FULL_MAP: ServiceDigestMap = { ...SERVICE_IMAGE };

/** Built services plus the external base images the production compose file also pins. */
const ALL_REQUIRED_SERVICES: readonly string[] = [
  ...REQUIRED_SERVICES,
  ...REQUIRED_EXTERNAL_IMAGES,
];

/** The producer run/attempt every verification in a scenario binds to. */
const EXPECTED_PRODUCER = { runId: RUN_ID, runAttempt: ATTEMPT };

function makeManifest(overrides: Partial<CandidateManifest> = {}): CandidateManifest {
  const base: CandidateManifest = {
    schema: 'commander.cd.candidate-manifest.v1',
    candidate: { sha: CANDIDATE },
    lockfile: { path: 'pnpm-lock.yaml', sha256: digest('lockfile') },
    artifact: { id: `${RUN_ID}-1`, sha256: digest('artifact-bytes') },
    producer: { runId: EXPECTED_PRODUCER.runId, runAttempt: EXPECTED_PRODUCER.runAttempt },
    requiredChecks: [...REQUIRED_CHECKS],
    checks: Object.fromEntries(
      REQUIRED_CHECKS.map((name) => [name, { status: 'success', executed: true }]),
    ),
    services: { ...FULL_MAP },
    provenance: { attestationId: 'attestation-1', subjectSha256: digest('provenance-subject') },
  };
  return { ...base, ...overrides };
}

function makeMarker(overrides: Partial<StagingValidationMarker> = {}): StagingValidationMarker {
  const base: StagingValidationMarker = {
    schema: 'commander.cd.staging-validation.v1',
    validated: true,
    manifestHash: '',
    candidate: CANDIDATE,
    environment: 'staging',
    verificationRun: RUN_ID,
    verificationAttempt: ATTEMPT,
    services: { ...FULL_MAP },
  };
  return { ...base, ...overrides };
}

const manifestText = (manifest: CandidateManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
const markerText = (marker: StagingValidationMarker): string =>
  `${JSON.stringify(marker, null, 2)}\n`;

/** Run the shipped CLI exactly as `cd.yml` does and report exit status. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'node',
      ['--import', 'tsx', join(root, 'scripts/cd-manifest-verify.ts'), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

type Scenario = {
  name: string;
  /** A build of the scenario, so an identical table can drive either the API or the CLI. */
  build: () => {
    manifest: string;
    expectedHash: string;
    candidate: string;
    /** A differing attempt that must be used for the manifest to be acceptable. */
    expectedAttempt?: number;
    /** A digest map the manifest must equal (defaults to the complete fixture map). */
    expectServices?: ServiceDigestMap;
  };
  deploy: boolean;
  reason: RegExp;
};

const scenarios: Scenario[] = [
  {
    name: 'valid candidate with identical staging and production evidence',
    build: () => {
      const manifest = manifestText(makeManifest());
      return { manifest, expectedHash: hashManifestBytes(manifest), candidate: CANDIDATE };
    },
    deploy: true,
    reason: /^$/,
  },
  {
    name: 'success but never executed (check present with executed=false)',
    build: () => {
      const manifest = makeManifest({
        checks: {
          quality: { status: 'success', executed: false },
          'kernel-postgres-integration': { status: 'success', executed: true },
          'l4-b-deploy-gates': { status: 'success', executed: true },
        },
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /not executed/,
  },
  {
    name: 'required check skipped',
    build: () => {
      const manifest = makeManifest({
        checks: {
          quality: { status: 'skipped', executed: true },
          'kernel-postgres-integration': { status: 'success', executed: true },
          'l4-deploy-gates': { status: 'success', executed: true },
          'l4-b-deploy-gates': { status: 'success', executed: true },
        },
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /quality did not succeed \(status=skipped\)/,
  },
  {
    name: 'required check failed',
    build: () => {
      const manifest = makeManifest({
        checks: {
          quality: { status: 'failure', executed: true },
          'kernel-postgres-integration': { status: 'success', executed: true },
          'l4-b-deploy-gates': { status: 'success', executed: true },
        },
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /quality did not succeed \(status=failure\)/,
  },
  {
    name: 'required check cancelled',
    build: () => {
      const manifest = makeManifest({
        checks: {
          quality: { status: 'cancelled', executed: true },
          'kernel-postgres-integration': { status: 'success', executed: true },
          'l4-b-deploy-gates': { status: 'success', executed: true },
        },
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /quality did not succeed \(status=cancelled\)/,
  },
  {
    name: 'required check has empty output',
    build: () => {
      const manifest = makeManifest({
        checks: {
          quality: { status: '', executed: true },
          'kernel-postgres-integration': { status: 'success', executed: true },
          'l4-b-deploy-gates': { status: 'success', executed: true },
        },
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /quality did not succeed \(status=\)/,
  },
  {
    name: 'stale SHA (manifest belongs to an older candidate)',
    build: () => {
      const manifest = makeManifest({ candidate: { sha: OTHER_CANDIDATE } });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /stale candidate/,
  },
  {
    name: 'single-service digest substitution',
    build: () => {
      const services = {
        ...FULL_MAP,
        worker: `ghcr.io/commander/candidate-worker@sha256:${digest('substituted')}`,
      };
      const manifest = makeManifest({ services });
      const text = manifestText(manifest);
      // Production holds the digest map staging proved; the manifest must match it exactly.
      return {
        manifest: text,
        expectedHash: hashManifestBytes(text),
        candidate: CANDIDATE,
        expectServices: FULL_MAP,
      };
    },
    deploy: false,
    reason: /service worker digest .* != expected/,
  },
  {
    name: 'producer attempt mismatch',
    build: () => {
      const manifest = makeManifest({ producer: { runId: RUN_ID, runAttempt: ATTEMPT } });
      const text = manifestText(manifest);
      return {
        manifest: text,
        expectedHash: hashManifestBytes(text),
        candidate: CANDIDATE,
        expectedAttempt: ATTEMPT + 1,
      };
    },
    deploy: false,
    reason: /producer attempt mismatch/,
  },
  {
    name: 'tampered manifest (bytes changed after the hash was taken)',
    build: () => {
      const manifest = makeManifest();
      const hash = hashManifestBytes(manifestText(manifest));
      const tampered = {
        ...manifest,
        artifact: { ...manifest.artifact, sha256: digest('tampered-artifact') },
      };
      return { manifest: manifestText(tampered), expectedHash: hash, candidate: CANDIDATE };
    },
    deploy: false,
    reason: /tampered manifest/,
  },
  {
    name: 'missing production configuration',
    build: () => {
      const manifest = makeManifest({
        services: Object.fromEntries(Object.entries(FULL_MAP).filter(([name]) => name !== 'api')),
      });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /missing required service api/,
  },
  {
    name: 'unknown service in the promoted set',
    build: () => {
      const services = {
        ...FULL_MAP,
        'rogue-service': `ghcr.io/commander/rogue@sha256:${digest('rogue')}`,
      };
      const manifest = makeManifest({ services });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /unknown service rogue-service/,
  },
  {
    name: 'mutable tag instead of an immutable digest',
    build: () => {
      const services = { ...FULL_MAP, api: 'ghcr.io/commander/candidate-api:latest' };
      const manifest = makeManifest({ services });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /api is not pinned by immutable digest/,
  },
  {
    name: 'required check missing from the manifest entirely',
    build: () => {
      const manifest = makeManifest({ requiredChecks: ['quality'] });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /does not require check l4-b-deploy-gates/,
  },
  {
    name: 'no required checks declared at all',
    build: () => {
      const manifest = makeManifest({ requiredChecks: [] });
      const text = manifestText(manifest);
      return { manifest: text, expectedHash: hashManifestBytes(text), candidate: CANDIDATE };
    },
    deploy: false,
    reason: /declares no required successful checks/,
  },
];

describe('LM-12 candidate manifest + promotion contract (table-driven)', () => {
  for (const scenario of scenarios) {
    it(`${scenario.deploy ? 'deploys' : 'refuses to deploy'}: ${scenario.name}`, () => {
      const { manifest, expectedHash, candidate, expectedAttempt, expectServices } =
        scenario.build();
      const result = verifyCandidateManifest(manifest, {
        manifestHash: expectedHash,
        candidate,
        requiredServices: ALL_REQUIRED_SERVICES,
        expectedServices: expectServices ?? FULL_MAP,
        producerAttempt: expectedAttempt ?? EXPECTED_PRODUCER.runAttempt,
      });
      if (scenario.deploy) {
        assert.deepEqual(result.reasons, []);
        assert.equal(result.ok, true);
        // staging and production consume the same COMPLETE map
        assert.deepEqual(Object.keys(result.services).sort(), Object.keys(FULL_MAP).sort());
        assert.deepEqual(result.services, FULL_MAP);
        return;
      }
      assert.equal(result.ok, false);
      assert.ok(
        result.reasons.some((reason) => scenario.reason.test(reason)),
        `expected a reason matching ${scenario.reason} in ${JSON.stringify(result.reasons)}`,
      );
    });
  }

  it('drives the shipped CLI with the same table (red paths exit non-zero)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-manifest-'));
    const results: Array<{ name: string; code: number }> = [];
    for (const scenario of scenarios) {
      const { manifest, expectedHash, candidate, expectedAttempt, expectServices } =
        scenario.build();
      const expectedMap = expectServices ?? FULL_MAP;
      const path = join(dir, `${scenario.name.replace(/[^a-z0-9]+/gi, '-')}.json`);
      writeFileSync(path, manifest);
      const cli = runCli([
        'manifest',
        '--path',
        path,
        '--expected-hash',
        expectedHash,
        '--candidate',
        candidate,
        '--expected-attempt',
        String(expectedAttempt ?? EXPECTED_PRODUCER.runAttempt),
        ...ALL_REQUIRED_SERVICES.flatMap((service) => ['--require-service', service]),
        ...ALL_REQUIRED_SERVICES.flatMap((service) => [
          '--expect-service',
          `${service}=${expectedMap[service]}`,
        ]),
      ]);
      results.push({ name: scenario.name, code: cli.code });
      assert.equal(
        cli.code,
        scenario.deploy ? 0 : 1,
        `${scenario.name}: exit ${cli.code} (${cli.stderr})`,
      );
    }
    assert.equal(results.filter((r) => r.code === 0).length, 1);
  });

  it('refuses a manifest whose artifact identity is absent', () => {
    const manifest = makeManifest({ artifact: { id: '', sha256: digest('x') } });
    const text = manifestText(manifest);
    const result = verifyCandidateManifest(text, {
      manifestHash: hashManifestBytes(text),
      candidate: CANDIDATE,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /artifact identity is missing/.test(r)));
  });

  it('refuses a manifest with no provenance/attestation binding', () => {
    const manifest = makeManifest({ provenance: { attestationId: '', subjectSha256: '' } });
    const text = manifestText(manifest);
    const result = verifyCandidateManifest(text, {
      manifestHash: hashManifestBytes(text),
      candidate: CANDIDATE,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /attestation id is missing/.test(r)));
    assert.ok(result.reasons.some((r) => /subject hash is invalid/.test(r)));
  });

  it('refuses unparseable input instead of treating it as absent-but-fine', () => {
    const result = verifyCandidateManifest('{ not json', {
      manifestHash: digest('h'),
      candidate: CANDIDATE,
    });
    assert.equal(result.ok, false);
    assert.match(result.reasons[0], /not parseable JSON/);
  });
});

const stagingMarker = (manifestTextValue: string, overrides: Partial<StagingValidationMarker>) =>
  makeMarker({ manifestHash: hashManifestBytes(manifestTextValue), ...overrides });

describe('LM-12 staging success evidence binding', () => {
  const manifestTextValue = manifestText(makeManifest());

  it('accepts a marker bound to the verified manifest, candidate, environment and run', () => {
    const result = verifyStagingMarker(markerText(stagingMarker(manifestTextValue, {})), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ok, true);
    // staging evidence carries the SAME complete map that production will consume
    assert.deepEqual(result.services, FULL_MAP);
  });

  it('refuses skipped/cancelled/empty staging evidence (validated must be exactly true)', () => {
    for (const validated of [false, undefined, 'true', '']) {
      const marker = {
        ...stagingMarker(manifestTextValue, {}),
        validated,
      } as unknown as StagingValidationMarker;
      const result = verifyStagingMarker(markerText(marker), {
        manifestHash: hashManifestBytes(manifestTextValue),
        candidate: CANDIDATE,
        verificationRun: RUN_ID,
      });
      assert.equal(result.ok, false, `validated=${String(validated)} must be refused`);
      assert.ok(result.reasons.some((r) => /not validated/.test(r)));
    }
  });

  it('refuses an empty marker file', () => {
    const result = verifyStagingMarker('', {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.match(result.reasons[0], /not parseable JSON/);
  });

  it('refuses a marker bound to a different manifest hash', () => {
    const marker = stagingMarker(manifestTextValue, { manifestHash: digest('other-manifest') });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /manifest hash/.test(r)));
  });

  it('refuses a stale artifact (marker bound to an older candidate)', () => {
    const marker = stagingMarker(manifestTextValue, { candidate: OTHER_CANDIDATE });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /candidate/.test(r)));
  });

  it('refuses reuse of staging evidence from a different run (rerun-attempt reuse)', () => {
    const marker = stagingMarker(manifestTextValue, { verificationRun: '999' });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /rerun reuse/.test(r)));
  });

  it('refuses reuse of staging environment credentials for production', () => {
    const marker = stagingMarker(manifestTextValue, { environment: 'production' });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /environment reuse/.test(r)));
  });

  it('refuses staging evidence with an incomplete service digest map', () => {
    const services = Object.fromEntries(
      Object.entries(FULL_MAP).filter(([name]) => name !== 'web'),
    );
    const marker = stagingMarker(manifestTextValue, { services });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /missing required service web/.test(r)));
  });

  it('refuses a marker with a mutable image tag', () => {
    const marker = stagingMarker(manifestTextValue, {
      services: { ...FULL_MAP, api: 'ghcr.io/commander/candidate-api:latest' },
    });
    const result = verifyStagingMarker(markerText(marker), {
      manifestHash: hashManifestBytes(manifestTextValue),
      candidate: CANDIDATE,
      verificationRun: RUN_ID,
      requiredServices: ALL_REQUIRED_SERVICES,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => /api is not pinned by immutable digest/.test(r)));
  });

  it('refuses the shipped CLI for a marker from another run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-marker-'));
    const path = join(dir, 'marker.json');
    writeFileSync(path, markerText(stagingMarker(manifestTextValue, { verificationRun: '999' })));
    const cli = runCli([
      'staging-marker',
      '--path',
      path,
      '--manifest-hash',
      hashManifestBytes(manifestTextValue),
      '--candidate',
      CANDIDATE,
      '--verification-run',
      RUN_ID,
    ]);
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /rerun reuse/);
  });
});

describe('LM-12 cd.yml structural contract', () => {
  const jobs = cd.jobs;
  const staging = jobs['deploy-staging'];
  const producer = jobs['build-candidate'];
  const verification = jobs['verify-manifest'];
  const validation = jobs['validate-staging'];
  const production = jobs['deploy-production'];
  const runText = (job: typeof staging): string =>
    (job.steps ?? []).map((s) => s.run ?? '').join('\n');
  /** `run:` bodies plus the remote `with.script` of SSH steps — that is where deployment happens. */
  const execText = (job: typeof staging): string =>
    (job.steps ?? [])
      .map((s) => `${s.run ?? ''}\n${(s as { with?: Record<string, string> }).with?.script ?? ''}`)
      .join('\n');
  const allText = (job: typeof staging): string => JSON.stringify(job);

  it('declares the trusted producer, verifier, staging, validation and production jobs', () => {
    for (const name of [
      'build-candidate',
      'verify-manifest',
      'deploy-staging',
      'validate-staging',
      'deploy-production',
    ]) {
      assert.ok(jobs[name], `cd.yml must declare job ${name}`);
    }
  });

  it('builds the candidate exactly once and never in production', () => {
    assert.match(runText(producer), /docker build /);
    assert.match(runText(producer), /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(allText(production), /docker build|--build|dockerfile:|context:/);
    assert.doesNotMatch(allText(staging), /docker build|--build|dockerfile:|context:/);
    for (const job of [staging, production]) {
      assert.match(execText(job), /docker compose[^\n]*pull/);
      assert.match(execText(job), /up -d --no-build/);
    }
  });

  it('makes the producer the only remote-image-writing job', () => {
    assert.deepEqual(producer.permissions, {
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
    });
    assert.deepEqual(staging.permissions, { contents: 'read' });
    assert.deepEqual(production.permissions, { contents: 'read' });
    assert.deepEqual(cd.permissions, { contents: 'read' });
  });

  it('gates production on the staging validation job and never on a skipped/success-only path', () => {
    assert.deepEqual(validateStagingNeeds(), ['verify-manifest', 'deploy-staging']);
    assert.equal(validation?.if, "needs.deploy-staging.result == 'success'");
    assert.deepEqual(production?.needs, ['verify-manifest', 'deploy-staging', 'validate-staging']);
    assert.equal(production?.if, "needs.validate-staging.result == 'success'");
    for (const job of [production, staging]) {
      assert.ok(!/always\(\)/.test(String(job.if ?? '')), 'gating jobs must not use always()');
    }
  });

  function validateStagingNeeds(): string[] | undefined {
    return validation?.needs;
  }

  it('uses always() only for failure reporting or owned cleanup', () => {
    const offenders: string[] = [];
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (!/always\(\)/.test(String(step.if ?? ''))) continue;
        const reporting =
          /failure\(\)/.test(String(step.if ?? '')) ||
          /report|clean ?up|notice/i.test(step.name ?? '');
        if (!reporting) offenders.push(`${jobName}: ${step.name ?? step.uses ?? '(unnamed)'}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('turns missing staging or production configuration into an explicit NOT_RUN', () => {
    for (const [jobName, secrets] of [
      ['deploy-staging', ['STAGING_HOST', 'STAGING_USER', 'STAGING_KEY']],
      ['deploy-production', ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_KEY']],
    ] as const) {
      const text = runText(jobs[jobName]);
      assert.match(text, /NOT_RUN/, `${jobName} must fail closed with NOT_RUN`);
      for (const secret of secrets) {
        assert.match(
          allText(jobs[jobName]),
          new RegExp(`secrets\\.${secret}\\b`),
          `${jobName} must read ${secret}`,
        );
      }
      assert.doesNotMatch(
        text,
        /skip=true|::notice::.*skipping/i,
        `${jobName} must not skip instead of fail`,
      );
    }
  });

  it('never lets production reach staging credentials', () => {
    assert.equal(production?.environment, 'production');
    assert.equal(staging?.environment, 'staging');
    assert.doesNotMatch(allText(production), /STAGING_/);
    // and production independently verifies the staging evidence rather than trusting a plain boolean
    assert.match(runText(production), /staging-marker/);
    assert.match(runText(production), /manifest/);
    assert.match(runText(validation), /staging-validated\.json/);
  });

  it('verifies the manifest before every deploy and binds the verification run', () => {
    assert.match(runText(verification), /cd-manifest-verify\.ts manifest/);
    assert.match(runText(verification), /pnpm install --frozen-lockfile/);
    assert.match(runText(verification), /requiredChecks|required checks/);
    assert.match(runText(production), /--verification-run ['"]?\$GITHUB_RUN_ID/);
    // staging must re-verify before touching the staging host
    const stagingSteps = staging.steps ?? [];
    const stagingVerify = stagingSteps.findIndex((s) =>
      /cd-manifest-verify\.ts manifest/.test(s.run ?? ''),
    );
    const stagingDeploy = stagingSteps.findIndex((s) => /appleboy\/ssh-action/.test(s.uses ?? ''));
    assert.ok(stagingVerify >= 0, 'staging must verify the manifest');
    assert.ok(stagingDeploy > stagingVerify, 'staging must verify before it deploys');
    // production must verify before touching the production host
    const productionSteps = production.steps ?? [];
    const productionVerify = productionSteps.findIndex((s) =>
      /cd-manifest-verify\.ts staging-marker/.test(s.run ?? ''),
    );
    const productionDeploy = productionSteps.findIndex((s) =>
      /appleboy\/ssh-action/.test(s.uses ?? ''),
    );
    assert.ok(productionVerify >= 0, 'production must verify the staging evidence');
    assert.ok(productionDeploy > productionVerify, 'production must verify before it deploys');
  });

  it('promotes the same complete service set in staging and production (no subset, no rebuild)', () => {
    const serviceVariables = [
      'COMMANDER_API_IMAGE',
      'COMMANDER_MIGRATOR_IMAGE',
      'COMMANDER_KERNEL_OPS_IMAGE',
      'COMMANDER_WORKER_IMAGE',
      'COMMANDER_ADAPTER_OPS_IMAGE',
      'COMMANDER_WEB_IMAGE',
      'COMMANDER_POSTGRES_IMAGE',
      'COMMANDER_MIGRATOR_BASE_IMAGE',
      'COMMANDER_POSTGRES_IMAGE_DIGEST',
    ];
    const stagingVars = [...execText(staging).matchAll(/(COMMANDER_[A-Z_]*IMAGE[A-Z_]*)=/g)].map(
      (m) => m[1],
    );
    const productionVars = [
      ...execText(production).matchAll(/(COMMANDER_[A-Z_]*IMAGE[A-Z_]*)=/g),
    ].map((m) => m[1]);
    for (const variable of serviceVariables) {
      assert.ok(stagingVars.includes(variable), `staging must materialise ${variable}`);
      assert.ok(productionVars.includes(variable), `production must materialise ${variable}`);
    }
    assert.match(runText(producer), /build_and_push api\b/);
    assert.match(runText(producer), /build_and_push kernel-migrate\b/);
    assert.match(runText(producer), /build_and_push kernel-ops\b/);
    assert.match(runText(producer), /build_and_push worker\b/);
    assert.match(runText(producer), /build_and_push adapter-ops\b/);
    assert.match(runText(producer), /build_and_push web\b/);
    assert.equal(
      (runText(producer).match(/build_and_push /g) ?? []).length,
      6,
      'the producer must build six services exactly once each',
    );
  });

  it('emits validated:true only from the final staging validation step', () => {
    const steps = validation?.steps ?? [];
    const emitterIndex = steps.findIndex((s) => /staging-validated\.json/.test(s.run ?? ''));
    assert.ok(emitterIndex >= 0, 'validate-staging must emit the marker');
    const emitter = steps[emitterIndex];
    assert.equal(emitter.if, undefined, 'the marker emitter must not be conditional');
    assert.match(emitter.run ?? '', /validated: true/);
    assert.match(emitter.run ?? '', /manifestHash/);
    assert.match(emitter.run ?? '', /verificationRun/);
  });

  it('does not create a parallel release workflow (cd.yml remains the only deployer)', () => {
    assert.deepEqual(Object.keys(cd.on), ['push']);
    assert.deepEqual((cd.on.push as { branches: string[] }).branches, ['master', 'main']);
  });

  it('declares every required service as a production compose image variable', () => {
    const compose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');
    const variables = [
      'COMMANDER_API_IMAGE',
      'COMMANDER_MIGRATOR_IMAGE',
      'COMMANDER_KERNEL_OPS_IMAGE',
      'COMMANDER_WORKER_IMAGE',
      'COMMANDER_ADAPTER_OPS_IMAGE',
    ];
    for (const variable of variables) {
      assert.match(
        compose,
        new RegExp(`\\$\\{${variable}:\\?\\}`),
        `${variable} must be required by prod compose`,
      );
    }
    assert.equal(REQUIRED_SERVICES.length, 6);
  });
});
