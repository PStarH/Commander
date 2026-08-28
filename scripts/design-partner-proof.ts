#!/usr/bin/env tsx

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DESIGN_PARTNER_FAULT_POINTS,
  DESIGN_PARTNER_SCENARIOS,
  validateCampaignObservation,
  type DesignPartnerCampaignObservation,
} from './design-partner-faults.js';
import {
  deriveTechnicalVerdict,
  sha256,
  stableJson,
  verifyCustomerAcceptance,
  type CustomerAcceptance,
  type TechnicalProofAttestation,
} from './proof-metadata.js';

const REQUIRED_DRIVER_ARTIFACTS = [
  'events.ndjson',
  'receipt.json',
  'verification.json',
  'metrics.json',
  'rotation-evidence.json',
] as const;

type DriverArtifactName = (typeof REQUIRED_DRIVER_ARTIFACTS)[number];
type DriverArtifacts = Record<DriverArtifactName, string>;
type DisasterRecoveryGate = TechnicalProofAttestation['gates']['disasterRecovery'];
type SigningRotationGate = TechnicalProofAttestation['gates']['signingRotation'];

export interface DesignPartnerProofConfig {
  schema: 'commander-design-partner-proof-config/v1';
  workflowId: string;
  tenantId: string;
  scope: {
    clusterIdentitySha256: string;
    namespace: string;
    deployment: string;
    targetRevisionRange: [string, string];
    escalationOwner: string;
  };
  versions: TechnicalProofAttestation['versions'];
  driver: {
    command: string;
    args: string[];
  };
  limitations: string[];
  untestedBranches: string[];
}

export interface DesignPartnerCampaignResult {
  observation: DesignPartnerCampaignObservation;
  artifacts: DriverArtifacts;
}

export interface DesignPartnerProofPorts {
  captureSource(): Promise<TechnicalProofAttestation['source']>;
  runCampaign(config: DesignPartnerProofConfig): Promise<DesignPartnerCampaignResult>;
  runDisasterRecoveryGate(input: { outputDirectory: string }): Promise<DisasterRecoveryGate>;
  runSigningRotationGate(input: {
    rotationEvidence: string;
    outputDirectory: string;
  }): Promise<SigningRotationGate>;
  now?: () => string;
  outputDirectory?: string;
}

export interface DesignPartnerTechnicalManifest {
  schema: 'commander-design-partner-proof/v1';
  verdict: 'NOT_READY' | 'PROVEN';
  passed: boolean;
  workflowId: string;
  metadata: {
    source: TechnicalProofAttestation['source'];
    versions: TechnicalProofAttestation['versions'];
    scope: DesignPartnerProofConfig['scope'];
    topology: DesignPartnerCampaignObservation['topology'] | null;
    tenantId: string;
    databaseRoles: string[];
    externalSystemMode: string;
    faultPoints: string[];
    expectedOutcomes: string[];
    observedOutcomes: string[];
    timing: { startedAt: string; endedAt: string; durationMs: number };
    generatingCommand: string;
    limitations: string[];
    untestedBranches: string[];
  };
  gates: {
    disasterRecovery: DisasterRecoveryGate | null;
    signingRotation: SigningRotationGate | null;
  };
  failures: string[];
  artifacts: Array<{ path: string; sha256: string }>;
}

export interface DesignPartnerTechnicalResult {
  manifest: DesignPartnerTechnicalManifest;
  artifacts: Record<string, string>;
}

export interface DesignPartnerFieldManifest {
  schema: 'commander-design-partner-field-review/v1';
  verdict: 'NOT_READY' | 'FIELD-PROVEN';
  passed: boolean;
  workflowId: string;
  technicalManifestSha256: string;
  acceptanceSha256: string;
  reviewer: { organization: string; role: string; keyId: string };
  observationWindow: CustomerAcceptance['observationWindow'];
  workflowCount: number;
  criticalBypasses: number;
  failures: string[];
}

export type DesignPartnerProofArgs =
  | { mode: 'technical'; config: string; output: string }
  | {
      mode: 'field-review';
      technicalManifest: string;
      customerAcceptance: string;
      customerPublicKey: string;
      output: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredArg(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseDesignPartnerProofArgs(argv: string[]): DesignPartnerProofArgs {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const allowed = new Set([
    '--config',
    '--output',
    '--technical-manifest',
    '--customer-acceptance',
    '--customer-public-key',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const name = normalizedArgv[index];
    if (!name || !allowed.has(name)) throw new Error(`unknown argument: ${name ?? ''}`);
    const value = normalizedArgv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be supplied only once`);
    values.set(name, value);
    index += 1;
  }

  const fieldMode = values.has('--technical-manifest');
  if (fieldMode) {
    if (values.has('--config')) throw new Error('--config is not valid in field-review mode');
    return {
      mode: 'field-review',
      technicalManifest: requiredArg(values, '--technical-manifest'),
      customerAcceptance: requiredArg(values, '--customer-acceptance'),
      customerPublicKey: requiredArg(values, '--customer-public-key'),
      output: requiredArg(values, '--output'),
    };
  }
  if (values.has('--customer-acceptance') || values.has('--customer-public-key')) {
    throw new Error('--technical-manifest is required for customer acceptance');
  }
  return {
    mode: 'technical',
    config: requiredArg(values, '--config'),
    output: requiredArg(values, '--output'),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function parseDesignPartnerProofConfig(value: unknown): DesignPartnerProofConfig {
  if (!isRecord(value)) throw new Error('proof config must be an object');
  if ('evidenceLevel' in value || 'verdict' in value) {
    throw new Error('proof config cannot declare an evidence level or verdict');
  }
  if (value.schema !== 'commander-design-partner-proof-config/v1') {
    throw new Error('proof config schema is invalid');
  }
  if (!isRecord(value.scope) || !isRecord(value.versions) || !isRecord(value.driver)) {
    throw new Error('proof config scope, versions, and driver are required');
  }
  const scope = value.scope;
  const revisions = stringArray(scope.targetRevisionRange, 'scope.targetRevisionRange');
  if (revisions.length !== 2) throw new Error('scope.targetRevisionRange must contain two values');
  const versions = value.versions;
  if (!isRecord(versions.images)) throw new Error('versions.images is required');
  const images = Object.fromEntries(
    Object.entries(versions.images).map(([name, image]) => {
      if (typeof image !== 'string') throw new Error(`versions.images.${name} must be a string`);
      return [name, image.trim()];
    }),
  );
  return {
    schema: value.schema,
    workflowId: requiredString(value, 'workflowId'),
    tenantId: requiredString(value, 'tenantId'),
    scope: {
      clusterIdentitySha256: requiredString(scope, 'clusterIdentitySha256'),
      namespace: requiredString(scope, 'namespace'),
      deployment: requiredString(scope, 'deployment'),
      targetRevisionRange: [revisions[0]!, revisions[1]!],
      escalationOwner: requiredString(scope, 'escalationOwner'),
    },
    versions: {
      images,
      protocol: requiredString(versions, 'protocol'),
      contract: requiredString(versions, 'contract'),
      policy: requiredString(versions, 'policy'),
      adapter: requiredString(versions, 'adapter'),
    },
    driver: {
      command: requiredString(value.driver, 'command'),
      args: stringArray(value.driver.args ?? [], 'driver.args'),
    },
    limitations: stringArray(value.limitations ?? [], 'limitations'),
    untestedBranches: stringArray(value.untestedBranches ?? [], 'untestedBranches'),
  };
}

const FORBIDDEN_RETAINED_KEYS = new Set([
  'credential',
  'credentials',
  'password',
  'payload',
  'privatekey',
  'prompt',
  'rawbody',
  'request',
  'response',
  'secret',
  'token',
]);

function retainedValueSafe(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(retainedValueSafe);
  if (!isRecord(value)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RETAINED_KEYS.has(key.replaceAll('_', '').toLowerCase())) return false;
    if (!retainedValueSafe(child)) return false;
  }
  return true;
}

function retainedArtifactSafe(name: string, body: string): boolean {
  if (
    /postgres(?:ql)?:\/\//i.test(body) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body) ||
    /authorization\s*:\s*bearer\s+/i.test(body)
  ) {
    return false;
  }
  try {
    if (name.endsWith('.ndjson')) {
      return body
        .split('\n')
        .filter(Boolean)
        .every((line) => retainedValueSafe(JSON.parse(line)));
    }
    return retainedValueSafe(JSON.parse(body));
  } catch {
    return false;
  }
}

function emptyManifest(
  config: DesignPartnerProofConfig,
  source: TechnicalProofAttestation['source'],
  startedAt: string,
  endedAt: string,
  failures: string[],
): DesignPartnerTechnicalManifest {
  return {
    schema: 'commander-design-partner-proof/v1',
    verdict: 'NOT_READY',
    passed: false,
    workflowId: config.workflowId,
    metadata: {
      source,
      versions: config.versions,
      scope: config.scope,
      topology: null,
      tenantId: config.tenantId,
      databaseRoles: [],
      externalSystemMode: 'unobserved',
      faultPoints: [],
      expectedOutcomes: DESIGN_PARTNER_SCENARIOS.map(({ id }) => `${id}:passed`),
      observedOutcomes: [],
      timing: {
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      },
      generatingCommand:
        'pnpm design-partner:proof -- --config <config> --output <output-directory>',
      limitations: config.limitations,
      untestedBranches: config.untestedBranches,
    },
    gates: { disasterRecovery: null, signingRotation: null },
    failures: [...new Set(failures)],
    artifacts: [],
  };
}

export async function runDesignPartnerTechnicalProof(
  config: DesignPartnerProofConfig,
  ports: DesignPartnerProofPorts,
): Promise<DesignPartnerTechnicalResult> {
  const now = ports.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const source = await ports.captureSource();
  const sourceFailures: string[] = [];
  if (source.dirty) sourceFailures.push('SOURCE_DIRTY');
  if (!/^[a-f0-9]{40,64}$/.test(source.commit)) sourceFailures.push('SOURCE_COMMIT_INVALID');
  if (!/^[a-f0-9]{64}$/.test(source.dependencyLockSha256)) {
    sourceFailures.push('DEPENDENCY_LOCK_HASH_INVALID');
  }
  if (sourceFailures.length > 0) {
    const endedAt = now();
    return {
      manifest: emptyManifest(config, source, startedAt, endedAt, sourceFailures),
      artifacts: {},
    };
  }

  let campaign: DesignPartnerCampaignResult;
  try {
    campaign = await ports.runCampaign(config);
  } catch {
    const endedAt = now();
    return {
      manifest: emptyManifest(config, source, startedAt, endedAt, ['CAMPAIGN_DRIVER_UNAVAILABLE']),
      artifacts: {},
    };
  }

  const failures = validateCampaignObservation(campaign.observation);
  const artifacts: Record<string, string> = {
    ...campaign.artifacts,
    'campaign-observation.json': `${stableJson(campaign.observation)}\n`,
  };
  for (const name of REQUIRED_DRIVER_ARTIFACTS) {
    if (typeof campaign.artifacts[name] !== 'string')
      failures.push(`DRIVER_ARTIFACT_MISSING:${name}`);
  }
  for (const [name, body] of Object.entries(artifacts)) {
    if (!retainedArtifactSafe(name, body)) failures.push(`RETAINED_ARTIFACT_UNSAFE:${name}`);
  }
  if (failures.length > 0) {
    const endedAt = now();
    const manifest = emptyManifest(config, source, startedAt, endedAt, failures);
    manifest.metadata.topology = campaign.observation.topology;
    manifest.metadata.databaseRoles = [...campaign.observation.topology.databaseRoles];
    manifest.metadata.externalSystemMode = campaign.observation.topology.externalSystem.mode;
    manifest.metadata.faultPoints = [...campaign.observation.faultPoints];
    return { manifest, artifacts: {} };
  }

  let disasterRecovery: DisasterRecoveryGate;
  let signingRotation: SigningRotationGate;
  try {
    disasterRecovery = await ports.runDisasterRecoveryGate({
      outputDirectory: ports.outputDirectory ?? 'artifacts/design-partner-proof',
    });
  } catch {
    disasterRecovery = {
      passed: false,
      honestyLevel: 'NOT_READY',
      reportSha256: '',
      evidenceReceiptsRestored: false,
      evidenceAnchorsRestored: false,
      identityOutcomeAccountingPreserved: false,
    };
  }
  try {
    signingRotation = await ports.runSigningRotationGate({
      rotationEvidence: campaign.artifacts['rotation-evidence.json'],
      outputDirectory: ports.outputDirectory ?? 'artifacts/design-partner-proof',
    });
  } catch {
    signingRotation = {
      passed: false,
      status: 'RED',
      reportSha256: '',
      retainedJwksSha256: '',
      preRotationReceiptsVerified: false,
      postRotationReceiptsVerified: false,
      revokedSignerRejected: false,
    };
  }

  const attestation: TechnicalProofAttestation = {
    tenantId: config.tenantId,
    source,
    versions: config.versions,
    topology: campaign.observation.topology,
    campaign: {
      driverBoundary: campaign.observation.driver.boundary,
      matrixComplete: true,
      allFaultPointsObserved: true,
      invariantsPassed: failures.length === 0,
      artifactsVerified: true,
    },
    gates: { disasterRecovery, signingRotation },
  };
  const derived = deriveTechnicalVerdict(attestation);
  failures.push(...derived.failures);
  const endedAt = now();
  const artifactHashes = Object.entries(artifacts)
    .map(([path, body]) => ({ path, sha256: sha256(body) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: DesignPartnerTechnicalManifest = {
    schema: 'commander-design-partner-proof/v1',
    verdict: failures.length === 0 ? 'PROVEN' : 'NOT_READY',
    passed: failures.length === 0,
    workflowId: config.workflowId,
    metadata: {
      source,
      versions: config.versions,
      scope: config.scope,
      topology: campaign.observation.topology,
      tenantId: config.tenantId,
      databaseRoles: [...campaign.observation.topology.databaseRoles],
      externalSystemMode: campaign.observation.topology.externalSystem.mode,
      faultPoints: [...campaign.observation.faultPoints],
      expectedOutcomes: DESIGN_PARTNER_SCENARIOS.map(
        ({ id, expectedExternalWrites }) => `${id}:writes=${expectedExternalWrites}`,
      ),
      observedOutcomes: campaign.observation.scenarios.map(
        ({ id, terminalDisposition, observedExternalWrites }) =>
          `${id}:${terminalDisposition}:writes=${observedExternalWrites}`,
      ),
      timing: {
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      },
      generatingCommand:
        'pnpm design-partner:proof -- --config <config> --output <output-directory>',
      limitations: config.limitations,
      untestedBranches: config.untestedBranches,
    },
    gates: { disasterRecovery, signingRotation },
    failures: [...new Set(failures)],
    artifacts: artifactHashes,
  };
  return { manifest, artifacts };
}

export function runDesignPartnerFieldReview(input: {
  technicalManifest: string;
  acceptance: CustomerAcceptance;
  publicKeyPem: string;
}): DesignPartnerFieldManifest {
  let workflowId = '';
  try {
    const parsed = JSON.parse(input.technicalManifest) as Record<string, unknown>;
    if (typeof parsed.workflowId === 'string') workflowId = parsed.workflowId;
  } catch {
    // The verifier returns the canonical NOT_READY reasons below.
  }
  const verified = verifyCustomerAcceptance({
    technicalManifest: input.technicalManifest,
    expectedWorkflowId: workflowId,
    acceptance: input.acceptance,
    publicKeyPem: input.publicKeyPem,
  });
  return {
    schema: 'commander-design-partner-field-review/v1',
    verdict: verified.verdict,
    passed: verified.verdict === 'FIELD-PROVEN',
    workflowId,
    technicalManifestSha256: sha256(input.technicalManifest),
    acceptanceSha256: sha256(`${stableJson(input.acceptance)}\n`),
    reviewer: {
      organization: input.acceptance.reviewer.organization,
      role: input.acceptance.reviewer.role,
      keyId: input.acceptance.signature.keyId,
    },
    observationWindow: input.acceptance.observationWindow,
    workflowCount: input.acceptance.workflowCount,
    criticalBypasses: input.acceptance.criticalBypasses,
    failures: verified.failures,
  };
}

function captureSource(): TechnicalProofAttestation['source'] {
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return {
    commit,
    dirty: status.trim().length > 0,
    dependencyLockSha256: sha256(readFileSync(resolve(root, 'pnpm-lock.yaml'))),
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolveResult({ status: -1, stdout: '', stderr: '' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ status: code ?? -1, stdout, stderr });
    });
  });
}

async function runExternalCampaign(
  config: DesignPartnerProofConfig,
  configPath: string,
  outputDirectory: string,
): Promise<DesignPartnerCampaignResult> {
  const driverOutput = resolve(outputDirectory, 'driver');
  await mkdir(driverOutput, { recursive: true });
  const result = await runCommand(
    config.driver.command,
    [...config.driver.args, '--config', resolve(configPath), '--output', driverOutput],
    { cwd: process.cwd(), timeoutMs: 30 * 60 * 1000 },
  );
  if (result.status !== 0) throw new Error('CAMPAIGN_DRIVER_UNAVAILABLE');
  const observation = JSON.parse(
    await readFile(join(driverOutput, 'observation.json'), 'utf8'),
  ) as DesignPartnerCampaignObservation;
  const artifacts = {} as DriverArtifacts;
  for (const name of REQUIRED_DRIVER_ARTIFACTS) {
    artifacts[name] = await readFile(join(driverOutput, name), 'utf8');
  }
  return { observation, artifacts };
}

async function findFiles(directory: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findFiles(path, name)));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

async function runDisasterRecoveryGate(outputDirectory: string): Promise<DisasterRecoveryGate> {
  const backupDirectory = resolve(outputDirectory, 'dr');
  const command = await runCommand(
    'pnpm',
    ['exec', 'tsx', 'scripts/dr-backup-verify.ts', '--full', '--backup-path', backupDirectory],
    { cwd: process.cwd(), timeoutMs: 30 * 60 * 1000 },
  );
  const reports = await findFiles(backupDirectory, 'drill-report.json');
  if (reports.length !== 1) throw new Error('DISASTER_RECOVERY_REPORT_REQUIRED');
  const body = await readFile(reports[0]!, 'utf8');
  const report = JSON.parse(body) as {
    honestyLevel?: string;
    overall?: string;
    validation?: Record<string, unknown>;
  };
  const validation = report.validation ?? {};
  return {
    passed: command.status === 0 && report.overall === 'PASS',
    honestyLevel: report.honestyLevel ?? 'NOT_READY',
    reportSha256: sha256(body),
    evidenceReceiptsRestored: validation.evidenceReceiptsRestored === true,
    evidenceAnchorsRestored: validation.evidenceAnchorsRestored === true,
    identityOutcomeAccountingPreserved: validation.identityOutcomeAccountingPreserved === true,
  };
}

async function runSigningRotationGate(rotationEvidence: string): Promise<SigningRotationGate> {
  const command = await runCommand(
    'pnpm',
    ['exec', 'tsx', 'scripts/verify-rotation-signoff.ts', '--json', '--quiet'],
    { cwd: process.cwd(), timeoutMs: 5 * 60 * 1000 },
  );
  let report: { status?: string } = {};
  try {
    report = JSON.parse(command.stdout.trim()) as { status?: string };
  } catch {
    report = {};
  }
  const evidence = JSON.parse(rotationEvidence) as Record<string, unknown>;
  return {
    passed: command.status === 0 && report.status === 'GREEN',
    status: report.status ?? 'RED',
    reportSha256: sha256(`${command.stdout}\n${command.stderr}`),
    retainedJwksSha256:
      typeof evidence.retainedJwksSha256 === 'string' ? evidence.retainedJwksSha256 : '',
    preRotationReceiptsVerified: evidence.preRotationReceiptsVerified === true,
    postRotationReceiptsVerified: evidence.postRotationReceiptsVerified === true,
    revokedSignerRejected: evidence.revokedSignerRejected === true,
  };
}

async function writeTechnicalResult(
  outputDirectory: string,
  result: DesignPartnerTechnicalResult,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    ...Object.entries(result.artifacts).map(([name, body]) =>
      writeFile(join(outputDirectory, name), body, 'utf8'),
    ),
    writeFile(join(outputDirectory, 'manifest.json'), `${stableJson(result.manifest)}\n`, 'utf8'),
  ]);
}

async function main(): Promise<void> {
  const args = parseDesignPartnerProofArgs(process.argv.slice(2));
  const outputDirectory = resolve(args.output);
  if (args.mode === 'field-review') {
    const technicalManifest = await readFile(resolve(args.technicalManifest), 'utf8');
    const acceptance = JSON.parse(
      await readFile(resolve(args.customerAcceptance), 'utf8'),
    ) as CustomerAcceptance;
    const publicKeyPem = await readFile(resolve(args.customerPublicKey), 'utf8');
    const field = runDesignPartnerFieldReview({ technicalManifest, acceptance, publicKeyPem });
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'field-manifest.json'), `${stableJson(field)}\n`, 'utf8');
    process.stdout.write(`Design Partner ${field.verdict} -> ${outputDirectory}\n`);
    if (!field.passed) process.exitCode = 1;
    return;
  }

  const config = parseDesignPartnerProofConfig(
    JSON.parse(await readFile(resolve(args.config), 'utf8')),
  );
  const result = await runDesignPartnerTechnicalProof(config, {
    captureSource: async () => captureSource(),
    runCampaign: (value) => runExternalCampaign(value, args.config, outputDirectory),
    runDisasterRecoveryGate: () => runDisasterRecoveryGate(outputDirectory),
    runSigningRotationGate: ({ rotationEvidence }) => runSigningRotationGate(rotationEvidence),
    outputDirectory,
  });
  await writeTechnicalResult(outputDirectory, result);
  process.stdout.write(`Design Partner ${result.manifest.verdict} -> ${outputDirectory}\n`);
  if (!result.manifest.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
