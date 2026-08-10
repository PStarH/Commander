#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const;
export type RequiredGate = (typeof REQUIRED_GATES)[number];
export type LaunchVerdict = 'PROVEN' | 'NOT_READY';

export interface GateStatus {
  [gate: string]: LaunchVerdict;
}

export interface LaunchVerificationResult {
  schema: 'commander-launch-verification/v1';
  release: string;
  evidence: string;
  verdict: LaunchVerdict;
  gates: GateStatus;
  failures: string[];
  checkedAt: string;
}

interface SourceAttestation {
  commit?: unknown;
  dirty?: unknown;
  lockfileSha256?: unknown;
  imageDigests?: unknown;
}

interface GateArtifact {
  path?: unknown;
  sha256?: unknown;
}

interface GateVerdict {
  schema?: unknown;
  gate?: unknown;
  verdict?: unknown;
  evidenceLevel?: unknown;
  artifacts?: unknown;
}

const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const SENSITIVE_PATTERNS: readonly [string, RegExp][] = [
  ['OPENAI_OR_PROVIDER_KEY', /(?:sk|key)-[A-Za-z0-9_-]{4,}/i],
  ['BEARER_TOKEN', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['PRIVATE_KEY', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i],
  ['DATABASE_CREDENTIAL', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/i],
  [
    'PROMPT_OR_RAW_RESPONSE',
    /(?:system|developer|user)\s+prompt\s*[:=]|raw\s+(?:prompt|response|payload)\s*[:=]/i,
  ],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function failure(failures: string[], code: string): void {
  if (!failures.includes(code)) failures.push(code);
}

function scanSensitive(value: unknown, location: string, failures: string[]): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return;
  for (const [name, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) failure(failures, `SECRET_DETECTED:${location}:${name}`);
  }
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath !== '' &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== '..' &&
    !isAbsolute(relativePath)
  );
}

async function verifyGate(
  evidence: string,
  gate: RequiredGate,
  failures: string[],
): Promise<LaunchVerdict> {
  const failureCountBeforeGate = failures.length;
  const gateDirectory = resolve(evidence, gate.toLowerCase());
  const verdictPath = resolve(gateDirectory, 'verdict.json');
  let raw: unknown;
  try {
    raw = await readJson(verdictPath);
  } catch {
    failure(failures, `GATE_ARTIFACT_MISSING:${gate}`);
    return 'NOT_READY';
  }
  scanSensitive(raw, `${gate}/verdict.json`, failures);
  if (!isRecord(raw)) {
    failure(failures, `GATE_VERDICT_INVALID:${gate}`);
    return 'NOT_READY';
  }
  const verdict = raw as GateVerdict;
  if (verdict.schema !== 'commander-enterprise-gate/v1') {
    failure(failures, `GATE_SCHEMA_INVALID:${gate}`);
  }
  if (verdict.gate !== gate) failure(failures, `GATE_ID_INVALID:${gate}`);
  if (verdict.verdict !== 'PROVEN' || verdict.evidenceLevel !== 'PROVEN') {
    failure(failures, `GATE_NOT_PROVEN:${gate}`);
  }
  if (!Array.isArray(verdict.artifacts) || verdict.artifacts.length === 0) {
    failure(failures, `GATE_ARTIFACTS_INVALID:${gate}`);
    return 'NOT_READY';
  }
  for (const [index, item] of verdict.artifacts.entries()) {
    if (!isRecord(item)) {
      failure(failures, `ARTIFACT_INVALID:${gate}:${index}`);
      continue;
    }
    const artifact = item as GateArtifact;
    if (
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256.test(artifact.sha256)
    ) {
      failure(failures, `ARTIFACT_METADATA_INVALID:${gate}:${index}`);
      continue;
    }
    const artifactPath = resolve(gateDirectory, artifact.path);
    if (!isInside(gateDirectory, artifactPath)) {
      failure(failures, `ARTIFACT_PATH_ESCAPE:${gate}:${index}`);
      continue;
    }
    try {
      const bytes = await readFile(artifactPath);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== artifact.sha256.toLowerCase())
        failure(failures, `ARTIFACT_HASH_MISMATCH:${gate}:${index}`);
      scanSensitive(bytes.toString('utf8'), `${gate}/${artifact.path}`, failures);
    } catch {
      failure(failures, `ARTIFACT_MISSING:${gate}:${artifact.path}`);
    }
  }
  return failures.length === failureCountBeforeGate ? 'PROVEN' : 'NOT_READY';
}

export async function verifyLaunchBundle(input: {
  release: string;
  evidence: string;
  checkedAt?: string;
}): Promise<LaunchVerificationResult> {
  const failures: string[] = [];
  const evidence = resolve(input.evidence);
  const gates: GateStatus = {};
  if (!input.release.trim()) failure(failures, 'RELEASE_REQUIRED');
  let source: unknown;
  try {
    source = await readJson(resolve(evidence, 'source.json'));
  } catch {
    failure(failures, 'SOURCE_ATTESTATION_MISSING');
  }
  scanSensitive(source, 'source.json', failures);
  if (!isRecord(source)) {
    failure(failures, 'SOURCE_ATTESTATION_INVALID');
  } else {
    const attestation = source as SourceAttestation;
    if (attestation.dirty === true) failure(failures, 'SOURCE_DIRTY');
    if (typeof attestation.commit !== 'string' || !COMMIT.test(attestation.commit)) {
      failure(failures, 'SOURCE_COMMIT_INVALID');
    }
    if (
      typeof attestation.lockfileSha256 !== 'string' ||
      !SHA256.test(attestation.lockfileSha256)
    ) {
      failure(failures, 'LOCKFILE_HASH_INVALID');
    }
    if (!Array.isArray(attestation.imageDigests) || attestation.imageDigests.length === 0) {
      failure(failures, 'IMAGE_DIGESTS_MISSING');
    } else if (
      attestation.imageDigests.some(
        (digest) => typeof digest !== 'string' || !digest.includes('@sha256:'),
      )
    ) {
      failure(failures, 'IMAGE_DIGEST_INVALID');
    }
  }

  try {
    const entries = await readdir(evidence, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'source.json') {
        try {
          scanSensitive(await readJson(resolve(evidence, entry.name)), entry.name, failures);
        } catch {
          failure(failures, `BUNDLE_JSON_INVALID:${entry.name}`);
        }
      }
    }
  } catch {
    failure(failures, 'EVIDENCE_DIRECTORY_MISSING');
  }

  for (const gate of REQUIRED_GATES) gates[gate] = await verifyGate(evidence, gate, failures);
  const verdict: LaunchVerdict =
    failures.length === 0 && REQUIRED_GATES.every((gate) => gates[gate] === 'PROVEN')
      ? 'PROVEN'
      : 'NOT_READY';
  return {
    schema: 'commander-launch-verification/v1',
    release: input.release,
    evidence,
    verdict,
    gates,
    failures,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

function parseArgs(argv: string[]): { release?: string; evidence?: string; output?: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return { release: values.release, evidence: values.evidence, output: values.output };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: launch:verify --release <tag> --evidence <directory> [--output <report.json>]\n',
    );
    return 0;
  }
  try {
    const args = parseArgs(argv);
    if (!args.release || !args.evidence) throw new Error('release and evidence are required');
    const result = await verifyLaunchBundle({ release: args.release, evidence: args.evidence });
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(serialized);
    if (args.output) {
      const output = resolve(args.output);
      const outputDirectory = resolve(output, '..');
      await stat(outputDirectory).catch(async () => {
        await mkdir(outputDirectory, { recursive: true });
      });
      await writeFile(output, serialized, 'utf8');
    }
    return result.verdict === 'PROVEN' ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'launch verification failed'}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
