#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTION_OPERATIONS_FAULT_POINTS = [
  'forward_commit_response_loss',
  'reconciliation_claim_owner_kill',
  'forward_outcome_query_after_restart',
  'compensation_commit_response_loss',
  'compensation_outcome_query_after_restart',
  'atomic_compensation_disposition',
  'stale_drain_readiness_denial',
  'evidence_persistence_failure',
] as const;

export type ActionOperationsProvider = 'github' | 'servicenow';

export interface ActionOperationsProofArgs {
  provider: ActionOperationsProvider;
  faultCampaign: 'full';
  output: string;
}

export interface ActionOperationsProofEnvironment extends NodeJS.ProcessEnv {
  GITHUB_TOKEN?: string;
  SERVICENOW_USERNAME?: string;
  SERVICENOW_PASSWORD?: string;
  SERVICENOW_INSTANCE?: string;
  COMMANDER_ACTION_PROOF_TENANT?: string;
  COMMANDER_ACTION_PROOF_DESTINATION?: string;
  COMMANDER_ACTION_PROOF_GATEWAY_URL?: string;
  COMMANDER_ACTION_PROOF_GATEWAY_PID?: string;
  COMMANDER_ACTION_PROOF_KERNEL_OPS_PID?: string;
  COMMANDER_ACTION_PROOF_ADAPTER_OPS_PID?: string;
  COMMANDER_ACTION_PROOF_APP_DATABASE_URL?: string;
  COMMANDER_ACTION_PROOF_ADAPTER_OPS_DATABASE_URL?: string;
  COMMANDER_ACTION_PROOF_OWNER_DATABASE_URL?: string;
  COMMANDER_ACTION_PROOF_IMAGE?: string;
  COMMANDER_ACTION_PROOF_PROTOCOL_VERSION?: string;
  COMMANDER_ACTION_PROOF_CONTRACT_VERSION?: string;
  COMMANDER_ACTION_PROOF_POLICY_VERSION?: string;
  COMMANDER_ACTION_PROOF_ADAPTER_VERSION?: string;
  COMMANDER_SIGNED_EVIDENCE?: string;
}

export interface ActionOperationsSource {
  commit: string;
  dirty: boolean;
  trackedDiffSha256: string;
  untrackedFiles: string[];
}

export interface ActionOperationsCampaignObservation {
  faultPoints: string[];
  counters: {
    forwardWrites: number;
    forwardQueries: number;
    compensationWrites: number;
    compensationQueries: number;
    duplicateWrites: number;
    unresolvedUnknowns: number;
    explicitEscalations: number;
  };
  compensationAuthorizedSeparately: boolean;
  compensationDispositionAtomic: boolean;
  staleDrainReadinessDenied: boolean;
  evidenceVerified: boolean;
  log: unknown;
  evidence: unknown;
}

export interface ActionOperationsPreflight {
  provider: ActionOperationsProvider;
  tenantId: string;
  destinationSha256: string;
  gatewayUrl: string;
  topology: {
    gateway: string;
    kernelOps: string;
    adapterOps: string;
  };
  versions: {
    image: string;
    protocol: string;
    contract: string;
    policy: string;
    adapter: string;
  };
  databaseRoles: ['commander_app', 'commander_adapter_ops', 'commander_owner'];
  signedEvidence: true;
}

export interface ActionOperationsProofMetadata {
  workflowId: string;
  source: ActionOperationsSource;
  versions: {
    dependencies: string;
    image: string;
    protocol: string;
    contract: string;
    policy: string;
    adapter: string;
  };
  environment: {
    topology: string;
    backend: 'postgresql';
    tenants: string[];
    databaseRoles: string[];
    processIdentities: string[];
  };
  provider: {
    externalSystemReality: 'real-sandbox';
    name: ActionOperationsProvider;
    destinationSha256: string;
  };
  fault: { description: string; injectionPoints: string[] };
  outcomes: { expected: string[]; observed: string[] };
  timing: { startedAt: string; endedAt: string; durationMs: number };
  generatingCommand: string;
  hashes: { logs: string[]; evidence: string[]; artifacts: string[] };
  limitations: string[];
  untestedBranches: string[];
}

interface RetainedArtifact {
  path: string;
  body: string;
  sha256: string;
}

export interface ActionOperationsProofResult {
  schema: 'commander-action-operations-proof/v1';
  passed: true;
  evidenceLevel: 'PROVEN';
  provider: ActionOperationsProvider;
  metadata: ActionOperationsProofMetadata;
  counters: ActionOperationsCampaignObservation['counters'];
  checks: {
    compensationAuthorizedSeparately: true;
    compensationDispositionAtomic: true;
    staleDrainReadinessDenied: true;
    evidenceVerified: true;
  };
  artifacts: { log: RetainedArtifact; evidence: RetainedArtifact };
}

export interface ActionOperationsProofPorts {
  environment?: ActionOperationsProofEnvironment;
  source: () => Promise<ActionOperationsSource>;
  runCampaign: (
    preflight: ActionOperationsPreflight,
  ) => Promise<ActionOperationsCampaignObservation>;
  now?: () => string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function required(
  environment: ActionOperationsProofEnvironment,
  name: keyof ActionOperationsProofEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${String(name)} is required`);
  }
  return value.trim();
}

function postgresRole(value: string, field: string, role: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${field} must be a PostgreSQL URL`);
  }
  if (decodeURIComponent(url.username) !== role) {
    throw new Error(`${field} must authenticate as ${role}`);
  }
  if (!url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error(`${field} must identify a PostgreSQL destination`);
  }
}

function assertRealDestination(provider: ActionOperationsProvider, destination: string): void {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new Error('provider destination must be an absolute provider URL');
  }
  const normalized = `${url.hostname}${url.pathname}`.toLowerCase();
  if (/(^|[./_-])(mock|local|localhost|example|octo|test)([./_-]|$)/.test(normalized)) {
    throw new Error('provider destination must identify a real external sandbox destination');
  }
  if (provider === 'github') {
    if (url.protocol !== 'github:' || !url.pathname.endsWith('/pulls')) {
      throw new Error('GitHub destination must use github://<owner>/<repo>/pulls');
    }
    return;
  }
  if (url.protocol !== 'servicenow:' || !url.pathname.endsWith('/incident')) {
    throw new Error('ServiceNow destination must use servicenow://<instance>/incident');
  }
}

export function parseActionOperationsProofArgs(argv: string[]): ActionOperationsProofArgs {
  // pnpm forwards the separator used by `pnpm run <script> -- <args>`.
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const key = normalized[index];
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key ?? ''}`);
    if (!['--provider', '--fault-campaign', '--output'].includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = normalized[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (values.has(key)) throw new Error(`${key} may be supplied only once`);
    values.set(key, value);
    index += 1;
  }
  const provider = values.get('--provider');
  if (provider !== 'github' && provider !== 'servicenow') {
    throw new Error('--provider must be github|servicenow');
  }
  if (values.get('--fault-campaign') !== 'full') {
    throw new Error('--fault-campaign full is required');
  }
  const output = values.get('--output')?.trim();
  if (!output) throw new Error('--output is required');
  return { provider, faultCampaign: 'full', output };
}

export function buildActionOperationsPreflight(
  args: ActionOperationsProofArgs,
  environment: ActionOperationsProofEnvironment = process.env,
): ActionOperationsPreflight {
  if (args.faultCampaign !== 'full') throw new Error('--fault-campaign full is required');
  const destination = required(environment, 'COMMANDER_ACTION_PROOF_DESTINATION');
  assertRealDestination(args.provider, destination);
  if (args.provider === 'github') {
    required(environment, 'GITHUB_TOKEN');
  } else {
    required(environment, 'SERVICENOW_USERNAME');
    required(environment, 'SERVICENOW_PASSWORD');
    const instance = required(environment, 'SERVICENOW_INSTANCE');
    if (!/^https:\/\//.test(instance) || /(mock|local|example|test)/i.test(instance)) {
      throw new Error('SERVICENOW_INSTANCE must identify a real HTTPS sandbox');
    }
  }

  postgresRole(
    required(environment, 'COMMANDER_ACTION_PROOF_APP_DATABASE_URL'),
    'COMMANDER_ACTION_PROOF_APP_DATABASE_URL',
    'commander_app',
  );
  postgresRole(
    required(environment, 'COMMANDER_ACTION_PROOF_ADAPTER_OPS_DATABASE_URL'),
    'COMMANDER_ACTION_PROOF_ADAPTER_OPS_DATABASE_URL',
    'commander_adapter_ops',
  );
  postgresRole(
    required(environment, 'COMMANDER_ACTION_PROOF_OWNER_DATABASE_URL'),
    'COMMANDER_ACTION_PROOF_OWNER_DATABASE_URL',
    'commander_owner',
  );

  const topology = {
    gateway: required(environment, 'COMMANDER_ACTION_PROOF_GATEWAY_PID'),
    kernelOps: required(environment, 'COMMANDER_ACTION_PROOF_KERNEL_OPS_PID'),
    adapterOps: required(environment, 'COMMANDER_ACTION_PROOF_ADAPTER_OPS_PID'),
  };
  if (new Set(Object.values(topology)).size !== 3) {
    throw new Error(
      'gateway, kernel-ops, and adapter-ops must have distinct process or container identities',
    );
  }
  const image = required(environment, 'COMMANDER_ACTION_PROOF_IMAGE');
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('COMMANDER_ACTION_PROOF_IMAGE must be digest-pinned');
  }
  if (environment.COMMANDER_SIGNED_EVIDENCE?.trim() !== '1') {
    throw new Error('signed evidence capability is required');
  }
  const gatewayUrl = required(environment, 'COMMANDER_ACTION_PROOF_GATEWAY_URL');
  if (!/^https?:\/\//.test(gatewayUrl)) {
    throw new Error('COMMANDER_ACTION_PROOF_GATEWAY_URL must be HTTP(S)');
  }

  return {
    provider: args.provider,
    tenantId: required(environment, 'COMMANDER_ACTION_PROOF_TENANT'),
    destinationSha256: sha256(destination),
    gatewayUrl,
    topology,
    versions: {
      image,
      protocol: required(environment, 'COMMANDER_ACTION_PROOF_PROTOCOL_VERSION'),
      contract: required(environment, 'COMMANDER_ACTION_PROOF_CONTRACT_VERSION'),
      policy: required(environment, 'COMMANDER_ACTION_PROOF_POLICY_VERSION'),
      adapter: required(environment, 'COMMANDER_ACTION_PROOF_ADAPTER_VERSION'),
    },
    databaseRoles: ['commander_app', 'commander_adapter_ops', 'commander_owner'],
    signedEvidence: true,
  };
}

function validateSource(source: ActionOperationsSource): void {
  if (!/^[a-f0-9]{40,64}$/.test(source.commit)) throw new Error('source commit is invalid');
  if (source.dirty) throw new Error('PROVEN requires a clean source commit');
  if (!/^[a-f0-9]{64}$/.test(source.trackedDiffSha256)) {
    throw new Error('source trackedDiffSha256 is invalid');
  }
  if (source.untrackedFiles.length !== 0)
    throw new Error('PROVEN requires no untracked source files');
}

function validateObservation(observation: ActionOperationsCampaignObservation): void {
  const observed = new Set(observation.faultPoints);
  for (const point of ACTION_OPERATIONS_FAULT_POINTS) {
    if (!observed.has(point)) throw new Error(`required fault point was not observed: ${point}`);
  }
  if (observed.size !== ACTION_OPERATIONS_FAULT_POINTS.length) {
    throw new Error('fault point set contains undeclared entries');
  }
  const counters = observation.counters;
  if (counters.forwardWrites !== 1) throw new Error('proof requires forwardWrites=1');
  if (counters.forwardQueries < 1) throw new Error('proof requires forwardQueries>=1');
  if (counters.compensationWrites !== 1) throw new Error('proof requires compensationWrites=1');
  if (counters.compensationQueries < 1) throw new Error('proof requires compensationQueries>=1');
  if (counters.duplicateWrites !== 0) throw new Error('proof requires duplicateWrites=0');
  if (counters.unresolvedUnknowns !== 0 && counters.explicitEscalations < 1) {
    throw new Error('proof requires no unresolved unknown or an explicit escalation');
  }
  if (!observation.compensationAuthorizedSeparately) {
    throw new Error('proof requires separately authorized compensation');
  }
  if (!observation.compensationDispositionAtomic) {
    throw new Error('proof requires an atomic compensation disposition');
  }
  if (!observation.staleDrainReadinessDenied) {
    throw new Error('proof requires stale-drain readiness denial');
  }
  if (!observation.evidenceVerified) {
    throw new Error('proof requires independent evidence verification');
  }
}

function artifact(path: string, value: unknown): RetainedArtifact {
  const body = `${canonical(value)}\n`;
  return { path, body, sha256: sha256(body) };
}

export async function runActionOperationsProof(
  args: ActionOperationsProofArgs,
  ports: ActionOperationsProofPorts,
): Promise<ActionOperationsProofResult> {
  const preflight = buildActionOperationsPreflight(args, ports.environment ?? process.env);
  const source = await ports.source();
  validateSource(source);
  const now = ports.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const observation = await ports.runCampaign(preflight);
  validateObservation(observation);
  const endedAt = now();

  const checks = {
    compensationAuthorizedSeparately: true,
    compensationDispositionAtomic: true,
    staleDrainReadinessDenied: true,
    evidenceVerified: true,
  } as const;
  const log = artifact('action-operations-proof.log.json', {
    schema: 'commander-action-operations-log/v1',
    counters: observation.counters,
    faultPoints: observation.faultPoints,
    checks,
  });
  const evidence = artifact('action-operations-proof.evidence.json', {
    schema: 'commander-action-operations-evidence/v1',
    verification: 'valid',
    evidenceVerified: observation.evidenceVerified,
  });
  const harnessBody = readFileSync(fileURLToPath(import.meta.url));
  const metadata: ActionOperationsProofMetadata = {
    workflowId: 'commander-wave2-action-operations-full-fault-campaign',
    source,
    versions: {
      dependencies: `pnpm-lock.yaml:sha256:${sha256(readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml')))}`,
      ...preflight.versions,
    },
    environment: {
      topology: 'distinct-gateway-kernel-ops-adapter-ops-processes',
      backend: 'postgresql',
      tenants: [preflight.tenantId],
      databaseRoles: [...preflight.databaseRoles],
      processIdentities: Object.values(preflight.topology),
    },
    provider: {
      externalSystemReality: 'real-sandbox',
      name: preflight.provider,
      destinationSha256: preflight.destinationSha256,
    },
    fault: {
      description:
        'full Action Operations forward, recovery, compensation, readiness, and evidence campaign',
      injectionPoints: [...observation.faultPoints],
    },
    outcomes: {
      expected: [
        'one forward write and query-first recovery',
        'one separately authorized compensation write and query-first recovery',
        'atomic terminal compensation disposition',
        'stale drains deny readiness',
        'independently verified evidence',
      ],
      observed: [
        `forwardWrites=${observation.counters.forwardWrites}`,
        `forwardQueries=${observation.counters.forwardQueries}`,
        `compensationWrites=${observation.counters.compensationWrites}`,
        `compensationQueries=${observation.counters.compensationQueries}`,
        `duplicateWrites=${observation.counters.duplicateWrites}`,
      ],
    },
    timing: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    },
    generatingCommand: `pnpm proof:action-operations -- --provider ${preflight.provider} --fault-campaign full --output <dir>`,
    hashes: {
      logs: [`${log.path}:sha256:${log.sha256}`],
      evidence: [`${evidence.path}:sha256:${evidence.sha256}`],
      artifacts: [`scripts/action-operations-proof.ts:sha256:${sha256(harnessBody)}`],
    },
    limitations: ['real sandbox provider; not design-partner field evidence'],
    untestedBranches: ['design-partner field use'],
  };

  return {
    schema: 'commander-action-operations-proof/v1',
    passed: true,
    evidenceLevel: 'PROVEN',
    provider: preflight.provider,
    metadata,
    counters: { ...observation.counters },
    checks,
    artifacts: { log, evidence },
  };
}

export function verifyActionOperationsArtifactHashes(
  result: ActionOperationsProofResult,
): string[] {
  const failures: string[] = [];
  for (const [name, retained, references] of [
    ['log', result.artifacts.log, result.metadata.hashes.logs],
    ['evidence', result.artifacts.evidence, result.metadata.hashes.evidence],
  ] as const) {
    const actual = sha256(retained.body);
    if (retained.sha256 !== actual) failures.push(`${name} retained hash mismatch`);
    const expectedReference = `${retained.path}:sha256:${actual}`;
    if (!references.includes(expectedReference)) failures.push(`${name} metadata hash mismatch`);
  }
  return failures;
}

function captureSource(): ActionOperationsSource {
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((path) => `${path}:sha256:${sha256(readFileSync(resolve(root, path)))}`);
  return {
    commit,
    dirty: status.trim().length > 0,
    trackedDiffSha256: sha256(diff),
    untrackedFiles: untracked,
  };
}

async function writeProofArtifacts(
  outputDirectory: string,
  result: ActionOperationsProofResult,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, result.artifacts.log.path),
      result.artifacts.log.body,
      'utf8',
    ),
    writeFile(
      resolve(outputDirectory, result.artifacts.evidence.path),
      result.artifacts.evidence.body,
      'utf8',
    ),
    writeFile(
      resolve(outputDirectory, 'action-operations-proof.json'),
      `${canonical(result)}\n`,
      'utf8',
    ),
  ]);
}

async function main(): Promise<void> {
  const args = parseActionOperationsProofArgs(process.argv.slice(2));
  const result = await runActionOperationsProof(args, {
    environment: process.env,
    source: async () => captureSource(),
    runCampaign: async () => {
      throw new Error(
        'ACTION_OPERATIONS_CAMPAIGN_DRIVER_UNAVAILABLE: no production fault-injection driver is wired',
      );
    },
  });
  const failures = verifyActionOperationsArtifactHashes(result);
  if (failures.length > 0) throw new Error(failures.join('; '));
  await writeProofArtifacts(resolve(args.output), result);
  console.log(`Action Operations ${result.evidenceLevel} -> ${resolve(args.output)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
