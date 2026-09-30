// LM-12 promotion-integrity verifier.
//
// `cd.yml` runs this module as a CLI (see the "Verify manifest ..." steps) and
// `scripts/cd-staging-contract.test.ts` imports the two exported functions and drives them
// with a fake transport. That keeps ONE fail-closed implementation behind both the real
// pipeline and the table-driven contract test: there is no parallel "test policy" that can
// drift away from what the workflow actually executes.
//
// Failure semantics are fail-closed by construction: a missing path, a missing field, a
// non-`success` status, an unexecuted check, an unknown service, a mutable tag, a
// mismatched hash/SHA/attempt/environment, and any parse error all BLOCK.
//
// Run: pnpm exec tsx scripts/cd-manifest-verify.ts manifest \
//        --path <manifest.json> --expected-hash <sha256> --candidate <40-hex>
//        [--require-service <name> ...]
//      pnpm exec tsx scripts/cd-manifest-verify.ts staging-marker \
//        --path <marker.json> --expected-hash <sha256> --candidate <40-hex> \
//        --manifest-hash <sha256> --verification-run <id>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The complete promoted-service inventory. Every name here is an image the producer job
 * builds and pushes by digest; `docker-compose.prod.yml` consumes each of them.
 */
export const REQUIRED_SERVICES = [
  'api',
  'kernel-migrate',
  'kernel-ops',
  'worker',
  'adapter-ops',
  'web',
] as const;

/** Upstream base images the production compose file also requires, pinned by digest. */
export const REQUIRED_EXTERNAL_IMAGES = ['postgres', 'migrator'] as const;

/** The required checks that must have genuinely executed and succeeded for `validated: true`. */
export const REQUIRED_CHECKS = [
  'quality',
  'kernel-postgres-integration',
  'l4-b-deploy-gates',
] as const;

export const MANIFEST_SCHEMA = 'commander.cd.candidate-manifest.v1';
export const STAGING_MARKER_SCHEMA = 'commander.cd.staging-validation.v1';
export const STAGING_ENVIRONMENT = 'staging';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMMUTABLE_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export type ServiceDigestMap = Record<string, string>;

export type ProducerInfo = { runId: string; runAttempt: number };

/** Versioned candidate manifest emitted by the trusted producer job. */
export type CandidateManifest = {
  schema: string;
  candidate: { sha: string };
  lockfileHash: string;
  artifact: { id: string; sha256: string };
  producer: ProducerInfo;
  requiredChecks: string[];
  checks: Record<string, { status: string; executed: boolean }>;
  services: ServiceDigestMap;
  provenance: { attestationId: string; subjectSha256: string };
};

/** Staging success marker: the only artifact that can authorise production. */
export type StagingValidationMarker = {
  schema: string;
  validated: true;
  manifestHash: string;
  candidate: string;
  environment: string;
  verificationRun: string;
  verificationAttempt: number;
  services: ServiceDigestMap;
};

export type ManifestVerification = {
  ok: boolean;
  reasons: string[];
  manifestHash: string;
  candidate: string;
  services: ServiceDigestMap;
  artifactId: string;
  producer: ProducerInfo;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`${label} is not a JSON object`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** SHA-256 over the exact manifest bytes the producer published. */
export function hashManifestBytes(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function readJsonFile(path: string, label: string): string {
  if (!path) throw new Error(`${label} path is required`);
  return readFileSync(path, 'utf8');
}

/**
 * Verify a producer manifest. Returns every reason it cannot authorise a deploy; does not
 * throw for policy violations (only for unreadable/unparseable input), so callers can report
 * all defects at once.
 */
/**
 * Verify a producer manifest. Returns every reason it cannot authorise a deploy; does not
 * throw for policy violations (only for unreadable/unparseable input), so callers can report
 * all defects at once.
 */
export function verifyCandidateManifest(
  raw: string,
  expected: {
    manifestHash: string;
    candidate: string;
    requiredServices?: readonly string[];
    /**
     * The digest map the manifest must equal EXACTLY. Production takes this from the staging
     * evidence it verified independently, so a single substituted service is refused.
     */
    expectedServices?: ServiceDigestMap;
    /** When supplied, the manifest must have been produced by exactly this attempt. */
    producerAttempt?: number;
  },
): ManifestVerification {
  const reasons: string[] = [];
  const fail = (reason: string): void => {
    reasons.push(reason);
  };
  let doc: Record<string, unknown>;
  try {
    doc = parseJson(raw, 'manifest');
  } catch (error) {
    return {
      ok: false,
      reasons: [`manifest is not parseable JSON: ${(error as Error).message}`],
      manifestHash: '',
      candidate: '',
      services: {},
      artifactId: '',
      producer: { runId: '', runAttempt: -1 },
    };
  }
  const manifestHash = hashManifestBytes(raw);
  if (!SHA256.test(expected.manifestHash)) {
    fail(`expected manifest hash is not a sha256 digest: ${expected.manifestHash || '(empty)'}`);
  } else if (manifestHash !== expected.manifestHash) {
    fail(`tampered manifest: hash ${manifestHash} != expected ${expected.manifestHash}`);
  }
  if (doc.schema !== MANIFEST_SCHEMA) fail(`unexpected manifest schema: ${String(doc.schema)}`);

  const candidate = isRecord(doc.candidate) ? doc.candidate.sha : undefined;
  if (typeof candidate !== 'string' || !COMMIT_SHA.test(candidate)) {
    fail(`manifest candidate is not a 40-hex commit SHA: ${String(candidate)}`);
  } else if (candidate !== expected.candidate) {
    fail(`stale candidate: manifest ${candidate} != ${expected.candidate}`);
  }

  const lockfile = isRecord(doc.lockfile) ? doc.lockfile.sha256 : undefined;
  if (typeof lockfile !== 'string' || !SHA256.test(lockfile)) {
    fail(`manifest lockfile hash is missing or not a sha256 digest: ${String(lockfile)}`);
  }

  const artifact = isRecord(doc.artifact) ? doc.artifact : undefined;
  const artifactId = typeof artifact?.id === 'string' ? artifact.id : '';
  const artifactHash = typeof artifact?.sha256 === 'string' ? artifact.sha256 : '';
  if (!artifactId) fail('manifest artifact identity is missing');
  if (!SHA256.test(artifactHash))
    fail(`manifest artifact content hash is invalid: ${artifactHash}`);

  const producer = isRecord(doc.producer) ? doc.producer : undefined;
  const runId = producer?.runId;
  const runAttempt = producer?.runAttempt;
  if (typeof runId !== 'string' || !runId) fail('manifest producer run id is missing');
  if (typeof runAttempt !== 'number' || !Number.isInteger(runAttempt) || runAttempt < 1) {
    fail(`manifest producer run attempt is invalid: ${String(runAttempt)}`);
  } else if (expected.producerAttempt !== undefined && runAttempt !== expected.producerAttempt) {
    fail(
      `producer attempt mismatch: manifest ${runAttempt} != expected ${expected.producerAttempt}`,
    );
  }

  const requiredChecks = Array.isArray(doc.requiredChecks) ? doc.requiredChecks : undefined;
  if (!requiredChecks || requiredChecks.length === 0) {
    fail('manifest declares no required successful checks');
  } else {
    for (const required of REQUIRED_CHECKS) {
      if (!requiredChecks.includes(required)) fail(`manifest does not require check ${required}`);
    }
  }
  const checks = isRecord(doc.checks) ? doc.checks : {};
  for (const required of requiredChecks ?? []) {
    const entry = checks[required];
    if (!isRecord(entry)) {
      fail(`required check ${required} has no recorded result`);
      continue;
    }
    if (entry.executed !== true) {
      fail(`required check ${required} was not executed`);
      continue;
    }
    if (entry.status !== 'success') {
      fail(`required check ${required} did not succeed (status=${String(entry.status)})`);
    }
  }

  const services: ServiceDigestMap = {};
  const rawServices = isRecord(doc.services) ? doc.services : undefined;
  if (!rawServices) {
    fail('manifest service digest map is missing');
  } else {
    for (const [name, value] of Object.entries(rawServices)) {
      if (typeof value !== 'string' || !IMMUTABLE_IMAGE.test(value)) {
        fail(`service ${name} is not pinned by immutable digest: ${String(value)}`);
        continue;
      }
      services[name] = value;
    }
    const required = expected.requiredServices ?? REQUIRED_SERVICES;
    for (const name of required) {
      if (!(name in services)) fail(`manifest is missing required service ${name}`);
    }
    for (const name of Object.keys(services)) {
      if (!required.includes(name)) fail(`manifest declares unknown service ${name}`);
    }
  }

  if (expected.expectedServices) {
    const expectedMap = expected.expectedServices;
    for (const [name, image] of Object.entries(expectedMap)) {
      const actual = services[name];
      if (actual === undefined)
        fail(`manifest is missing service ${name} present in the expected map`);
      else if (actual !== image) fail(`service ${name} digest ${actual} != expected ${image}`);
    }
    for (const name of Object.keys(services)) {
      if (!(name in expectedMap))
        fail(`manifest declares service ${name} absent from the expected map`);
    }
  }

  const provenance = isRecord(doc.provenance) ? doc.provenance : undefined;
  if (!provenance || typeof provenance.attestationId !== 'string' || !provenance.attestationId) {
    fail('manifest provenance/attestation id is missing');
  }
  if (
    !provenance ||
    typeof provenance.subjectSha256 !== 'string' ||
    !SHA256.test(provenance.subjectSha256)
  ) {
    fail('manifest provenance subject hash is invalid');
  }

  const verification: ManifestVerification = {
    ok: reasons.length === 0,
    reasons,
    manifestHash,
    candidate: typeof candidate === 'string' ? candidate : '',
    services,
    artifactId,
    producer: {
      runId: typeof runId === 'string' ? runId : '',
      runAttempt: typeof runAttempt === 'number' ? runAttempt : -1,
    },
  };
  return verification;
}

/**
 * Verify the staging success marker that authorises production. A `validated: true` is only
 * ever produced by the final step of the staging validation job after every required check
 * really executed and succeeded, so production must additionally prove the marker is bound
 * to this manifest hash, candidate, environment and verification run.
 */
export function verifyStagingMarker(
  raw: string,
  expected: {
    manifestHash: string;
    candidate: string;
    verificationRun: string;
    environment?: string;
    requiredServices?: readonly string[];
  },
): { ok: boolean; reasons: string[]; services: ServiceDigestMap; manifestHash: string } {
  const reasons: string[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseJson(raw, 'staging marker');
  } catch (error) {
    return {
      ok: false,
      reasons: [`staging marker is not parseable JSON: ${(error as Error).message}`],
      services: {},
      manifestHash: '',
    };
  }
  if (doc.schema !== STAGING_MARKER_SCHEMA) {
    reasons.push(`unexpected staging marker schema: ${String(doc.schema)}`);
  }
  if (doc.validated !== true) {
    reasons.push(`staging marker is not validated: ${String(doc.validated)}`);
  }
  const environment = expected.environment ?? STAGING_ENVIRONMENT;
  if (doc.environment !== environment) {
    reasons.push(
      `staging credential/environment reuse: marker environment ${String(doc.environment)} != ${environment}`,
    );
  }
  if (expected.manifestHash && doc.manifestHash !== expected.manifestHash) {
    reasons.push(
      `staging marker manifest hash ${String(doc.manifestHash)} != ${expected.manifestHash}`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(String(doc.candidate ?? ''))) {
    reasons.push(`staging marker candidate is not a 40-hex commit SHA: ${String(doc.candidate)}`);
  } else if (doc.candidate !== expected.candidate) {
    reasons.push(`staging marker candidate ${String(doc.candidate)} != ${expected.candidate}`);
  }
  if (!expected.verificationRun) {
    reasons.push('staging marker verification run is required');
  } else if (String(doc.verificationRun) !== expected.verificationRun) {
    reasons.push(
      `staging marker verification run ${String(doc.verificationRun)} != ${expected.verificationRun} (rerun reuse)`,
    );
  }
  if (
    typeof doc.verificationAttempt !== 'number' ||
    !Number.isInteger(doc.verificationAttempt) ||
    doc.verificationAttempt < 1
  ) {
    reasons.push(
      `staging marker verification attempt is invalid: ${String(doc.verificationAttempt)}`,
    );
  }

  const services: ServiceDigestMap = {};
  const rawServices = isRecord(doc.services) ? doc.services : undefined;
  if (!rawServices) {
    reasons.push('staging marker service digest map is missing');
  } else {
    for (const [name, value] of Object.entries(rawServices)) {
      if (typeof value !== 'string' || !IMMUTABLE_IMAGE.test(value)) {
        reasons.push(
          `staging marker service ${name} is not pinned by immutable digest: ${String(value)}`,
        );
        continue;
      }
      services[name] = value;
    }
    const required = expected.requiredServices ?? REQUIRED_SERVICES;
    for (const name of required) {
      if (!(name in services)) reasons.push(`staging marker is missing required service ${name}`);
    }
    for (const name of Object.keys(services)) {
      if (!required.includes(name)) reasons.push(`staging marker declares unknown service ${name}`);
    }
  }
  return { ok: reasons.length === 0, reasons, services, manifestHash: hashManifestBytes(raw) };
}

/** The promotion contract: production must consume exactly the verified candidate. */
export function verifyPromotion(input: {
  manifest: ManifestVerification;
  staging: { ok: boolean; reasons: string[]; services: ServiceDigestMap };
  expectedCandidate: string;
  expectedEnvironment: string;
  stagingEnvironmentCredentialsUsedByProduction?: boolean;
}): { ok: boolean; reasons: string[]; services: ServiceDigestMap } {
  const reasons: string[] = [];
  if (!input.manifest.ok) reasons.push(...input.manifest.reasons.map((r) => `manifest: ${r}`));
  if (!input.staging.ok) reasons.push(...input.staging.reasons.map((r) => `staging: ${r}`));
  if (input.expectedEnvironment !== 'production') {
    reasons.push(`production verification ran with environment ${input.expectedEnvironment}`);
  }
  if (input.stagingEnvironmentCredentialsUsedByProduction === true) {
    reasons.push('production reuse of staging environment credentials is forbidden');
  }
  if (input.manifest.candidate !== input.expectedCandidate) {
    reasons.push(
      `manifest candidate ${input.manifest.candidate} != expected ${input.expectedCandidate}`,
    );
  }
  const services = input.staging.services;
  const manifestServices = input.manifest.services;
  const keys = new Set([...Object.keys(services), ...Object.keys(manifestServices)]);
  if (keys.size === 0) reasons.push('no service digest map was verified');
  for (const key of keys) {
    if (services[key] !== manifestServices[key]) {
      reasons.push(
        `service ${key} digest differs between staging (${String(services[key])}) and production (${String(manifestServices[key])})`,
      );
    }
  }
  for (const key of REQUIRED_SERVICES) {
    if (!(key in services)) reasons.push(`promotion is missing service ${key}`);
  }
  return { ok: reasons.length === 0, reasons, services };
}

function parseArgs(argv: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

function requireArg(args: Record<string, string | string[]>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`--${key} is required`);
  return value;
}

/** Parse repeated `--expect-service name=image` flags into a digest map. */
function parseExpectedServices(
  args: Record<string, string | string[]>,
): ServiceDigestMap | undefined {
  const raw = args['expect-service'];
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw) ? raw : [raw];
  const map: ServiceDigestMap = {};
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at <= 0) throw new Error(`--expect-service must be name=image, got: ${entry}`);
    const name = entry.slice(0, at);
    const image = entry.slice(at + 1);
    if (!IMMUTABLE_IMAGE.test(image))
      throw new Error(`--expect-service ${name} is not an immutable digest: ${image}`);
    if (name in map) throw new Error(`--expect-service ${name} was supplied twice`);
    map[name] = image;
  }
  return map;
}

/**
 * The expected digest map for a manifest, taken from the independently verified staging
 * evidence (`--staging-marker`) merged with the external base images the production compose
 * file also requires (`--expect-external-service`). Any service present in one map but not the
 * other is a divergence and will be refused.
 */
function expectedServicesFrom(
  args: Record<string, string | string[]>,
): ServiceDigestMap | undefined {
  const fromFlags = parseExpectedServices(args);
  const markerPath = args['staging-marker'];
  const external = args['expect-external-service'];
  if (markerPath === undefined && external === undefined && fromFlags === undefined)
    return undefined;
  const map: ServiceDigestMap = { ...(fromFlags ?? {}) };
  if (typeof markerPath === 'string' && markerPath) {
    const marker = parseJson(readJsonFile(markerPath, 'staging marker'), 'staging marker');
    if (marker.validated !== true) throw new Error('staging marker is not validated');
    const services = isRecord(marker.services) ? marker.services : undefined;
    if (!services) throw new Error('staging marker has no service digest map');
    for (const [name, image] of Object.entries(services)) {
      if (typeof image !== 'string' || !IMMUTABLE_IMAGE.test(image)) {
        throw new Error(`staging marker service ${name} is not an immutable digest`);
      }
      map[name] = image;
    }
  }
  if (external !== undefined) {
    for (const entry of Array.isArray(external) ? external : [external]) {
      const at = entry.indexOf('=');
      if (at <= 0) throw new Error(`--expect-external-service must be name=image, got: ${entry}`);
      const name = entry.slice(0, at);
      const image = entry.slice(at + 1);
      if (!IMMUTABLE_IMAGE.test(image))
        throw new Error(`external service ${name} is not an immutable digest`);
      map[name] = image;
    }
  }
  return map;
}

/** CLI: exit 0 only when the artifact authorises the requested promotion. */
function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    if (mode === 'manifest') {
      const raw = readJsonFile(requireArg(args, 'path'), 'manifest');
      const attempt = args['expected-attempt'];
      const requireServices = args['require-service'];
      const expectedServices = expectedServicesFrom(args);
      const result = verifyCandidateManifest(raw, {
        manifestHash: requireArg(args, 'expected-hash'),
        candidate: requireArg(args, 'candidate'),
        ...(requireServices === undefined
          ? {}
          : {
              requiredServices: Array.isArray(requireServices)
                ? requireServices
                : [requireServices],
            }),
        ...(expectedServices === undefined ? {} : { expectedServices }),
        ...(typeof attempt === 'string' && attempt ? { producerAttempt: Number(attempt) } : {}),
      });
      if (!result.ok)
        throw new Error(`manifest verification failed:\n  - ${result.reasons.join('\n  - ')}`);
      process.stdout.write(
        `manifest-ok hash=${result.manifestHash} candidate=${result.candidate}\n`,
      );
      return 0;
    }
    if (mode === 'staging-marker') {
      const raw = readJsonFile(requireArg(args, 'path'), 'staging marker');
      const requireServices = args['require-service'];
      const result = verifyStagingMarker(raw, {
        manifestHash: requireArg(args, 'manifest-hash'),
        candidate: requireArg(args, 'candidate'),
        verificationRun: requireArg(args, 'verification-run'),
        ...(requireServices === undefined
          ? {}
          : {
              requiredServices: Array.isArray(requireServices)
                ? requireServices
                : [requireServices],
            }),
      });
      if (!result.ok)
        throw new Error(
          `staging marker verification failed:\n  - ${result.reasons.join('\n  - ')}`,
        );
      process.stdout.write(`staging-marker-ok hash=${result.manifestHash}\n`);
      return 0;
    }
    throw new Error(`unknown mode: ${String(mode)}`);
  } catch (error) {
    process.stderr.write(`::error::${(error as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /cd-manifest-verify\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
