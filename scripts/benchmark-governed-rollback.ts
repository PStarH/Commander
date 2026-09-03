import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DESIGN_PARTNER_SCENARIOS,
  validateCampaignObservation,
  type DesignPartnerCampaignObservation,
} from './design-partner-faults.js';

export interface GovernedRollbackBenchmarkArgs {
  environment: 'kind';
  repetitions: number;
  output: string;
}

export interface GovernedRollbackRepetition {
  repetition: number;
  environmentRebuild: number;
}

export interface GovernedRollbackScenarioMetrics {
  expectedExternalWrites: number;
  trials: number;
  passedTrials: number;
  externalWrites: number;
  outcomeQueries: number;
  duplicateWrites: number;
  receiptFailures: number;
  evidenceFailures: number;
  maxReconciliationLatencyMs: number;
}

export interface GovernedRollbackAggregateResult {
  verdict: 'PROVEN' | 'NOT_READY';
  failures: string[];
  metrics: {
    repetitions: number;
    totalTrials: number;
    duplicateWrites: number;
    deniedScenarioExternalWrites: number;
    staleLeaseWrites: number;
    killSwitchBypasses: number;
    crossScopeWrites: number;
    unverifiedTerminalReceipts: number;
    terminalCasesMissingEvidence: number;
    scenarios: Record<string, GovernedRollbackScenarioMetrics>;
  };
}

export interface GovernedRollbackSource {
  commit: string;
  dirty: boolean;
  dependencyLockSha256: string;
}

export interface GovernedRollbackTrialInput {
  repetition: number;
  environmentRebuild: number;
  outputDirectory: string;
}

export interface GovernedRollbackTrialResult {
  observation: DesignPartnerCampaignObservation;
  artifacts: Record<string, string>;
}

export interface GovernedRollbackBenchmarkPorts {
  captureSource(): Promise<GovernedRollbackSource>;
  runTrial(input: GovernedRollbackTrialInput): Promise<GovernedRollbackTrialResult>;
  now?: () => string;
}

export interface GovernedRollbackBenchmarkResult extends GovernedRollbackAggregateResult {
  schema: 'commander-governed-rollback-benchmark/v1';
  passed: boolean;
  environment: 'kind';
  source: GovernedRollbackSource | null;
  freshEnvironmentRebuilds: number;
  artifacts: Record<string, string>;
}

const REQUIRED_ARTIFACT_NAMES = new Set([
  'events.ndjson',
  'receipt.json',
  'verification.json',
  'metrics.json',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value), null, 2);
}

function stableJsonLine(value: unknown): string {
  return JSON.stringify(JSON.parse(stableJson(value)));
}

function sourceFailure(source: GovernedRollbackSource | null): string[] {
  if (!source) return ['SOURCE_METADATA_UNAVAILABLE'];
  const failures: string[] = [];
  if (source.dirty) failures.push('SOURCE_DIRTY');
  if (!/^[a-f0-9]{40,64}$/.test(source.commit)) failures.push('SOURCE_COMMIT_INVALID');
  if (!/^[a-f0-9]{64}$/.test(source.dependencyLockSha256)) {
    failures.push('DEPENDENCY_LOCK_HASH_INVALID');
  }
  return failures;
}

function emptyAggregate(repetitions: number): GovernedRollbackAggregateResult {
  const scenarios = Object.fromEntries(
    DESIGN_PARTNER_SCENARIOS.map((definition) => [
      definition.id,
      {
        expectedExternalWrites: definition.expectedExternalWrites,
        trials: 0,
        passedTrials: 0,
        externalWrites: 0,
        outcomeQueries: 0,
        duplicateWrites: 0,
        receiptFailures: 0,
        evidenceFailures: 0,
        maxReconciliationLatencyMs: 0,
      },
    ]),
  ) as Record<string, GovernedRollbackScenarioMetrics>;
  return {
    verdict: 'NOT_READY',
    failures: ['BENCHMARK_TRIALS_NOT_RUN'],
    metrics: {
      repetitions,
      totalTrials: 0,
      duplicateWrites: 0,
      deniedScenarioExternalWrites: 0,
      staleLeaseWrites: 0,
      killSwitchBypasses: 0,
      crossScopeWrites: 0,
      unverifiedTerminalReceipts: 0,
      terminalCasesMissingEvidence: 0,
      scenarios,
    },
  };
}

export function parseGovernedRollbackBenchmarkArgs(
  argv: readonly string[],
): GovernedRollbackBenchmarkArgs {
  const normalized = argv[0] === '--' ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  const allowed = new Set(['--environment', '--repetitions', '--output']);

  for (let index = 0; index < normalized.length; index += 1) {
    const token = normalized[index];
    if (!token?.startsWith('--')) throw new Error(`unexpected argument: ${token ?? ''}`);
    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (!allowed.has(name)) throw new Error(`unknown argument: ${name}`);
    if (values.has(name)) throw new Error(`${name} may be supplied only once`);
    let value = equals >= 0 ? token.slice(equals + 1) : normalized[index + 1];
    if (equals < 0) {
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      index += 1;
    }
    if (!value?.trim()) throw new Error(`${name} requires a value`);
    values.set(name, value.trim());
  }

  if (values.get('--environment') !== 'kind') {
    throw new Error('--environment must be kind');
  }
  const repetitionsValue = values.get('--repetitions');
  if (!repetitionsValue || !/^[1-9][0-9]*$/.test(repetitionsValue)) {
    throw new Error('--repetitions must be a positive integer');
  }
  const repetitions = Number(repetitionsValue);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error('--repetitions must be a positive integer');
  }
  const output = values.get('--output');
  if (!output) throw new Error('--output is required');
  return { environment: 'kind', repetitions, output };
}

export function buildGovernedRollbackRepetitionPlan(
  repetitions: number,
): GovernedRollbackRepetition[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 3) {
    throw new Error('at least three repetitions are required for fresh environments');
  }
  return Array.from({ length: repetitions }, (_, repetition) => ({
    repetition: repetition + 1,
    environmentRebuild: Math.floor((repetition * 3) / repetitions),
  }));
}

export function aggregateGovernedRollbackObservations(
  observations: readonly DesignPartnerCampaignObservation[],
  repetitions: number,
): GovernedRollbackAggregateResult {
  const failures = new Set<string>();
  const scenarios = Object.fromEntries(
    DESIGN_PARTNER_SCENARIOS.map((definition) => [
      definition.id,
      {
        expectedExternalWrites: definition.expectedExternalWrites,
        trials: 0,
        passedTrials: 0,
        externalWrites: 0,
        outcomeQueries: 0,
        duplicateWrites: 0,
        receiptFailures: 0,
        evidenceFailures: 0,
        maxReconciliationLatencyMs: 0,
      },
    ]),
  ) as Record<string, GovernedRollbackScenarioMetrics>;

  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    failures.add('REPETITIONS_INVALID');
  }
  if (observations.length !== repetitions) failures.add('REPETITION_COUNT_MISMATCH');

  let deniedScenarioExternalWrites = 0;
  for (const [trialIndex, observation] of observations.entries()) {
    let observationFailures: string[];
    try {
      observationFailures = validateCampaignObservation(observation);
    } catch {
      observationFailures = ['CAMPAIGN_OBSERVATION_INVALID'];
    }
    for (const failure of observationFailures) failures.add(`TRIAL_${trialIndex + 1}:${failure}`);

    const driver =
      isRecord(observation) && isRecord(observation.driver) ? observation.driver : null;
    if (
      driver?.boundary !== 'external-process' ||
      typeof driver.identity !== 'string' ||
      !driver.identity.trim()
    ) {
      failures.add(`TRIAL_${trialIndex + 1}:EXTERNAL_DRIVER_REQUIRED`);
    }
    const topology =
      isRecord(observation) && isRecord(observation.topology) ? observation.topology : null;
    const externalSystem =
      topology && isRecord(topology.externalSystem) ? topology.externalSystem : null;
    if (
      topology?.backend !== 'postgresql' ||
      externalSystem?.mode !== 'real' ||
      topology.standardClientPath !== true
    ) {
      failures.add(`TRIAL_${trialIndex + 1}:REAL_KIND_TOPOLOGY_REQUIRED`);
    }
    const roles = new Set(
      topology && Array.isArray(topology.databaseRoles)
        ? topology.databaseRoles.filter((role): role is string => typeof role === 'string')
        : [],
    );
    for (const role of ['commander_app', 'commander_adapter_ops', 'commander_owner']) {
      if (!roles.has(role)) failures.add(`TRIAL_${trialIndex + 1}:DATABASE_ROLE_MISSING:${role}`);
    }
    const processIdentities =
      topology && isRecord(topology.processIdentities) ? topology.processIdentities : null;
    const requiredProcesses = ['gateway', 'kernelOps', 'adapterOps', 'worker', 'verifier'];
    const identityValues = requiredProcesses.map((name) => processIdentities?.[name]);
    if (
      identityValues.some((identity) => typeof identity !== 'string' || !identity.trim()) ||
      new Set(identityValues).size !== identityValues.length
    ) {
      failures.add(`TRIAL_${trialIndex + 1}:PROCESS_IDENTITIES_INVALID`);
    }

    const seen = new Set<string>();
    const trialScenarios =
      isRecord(observation) && Array.isArray(observation.scenarios) ? observation.scenarios : [];
    for (const scenarioValue of trialScenarios) {
      if (!isRecord(scenarioValue) || typeof scenarioValue.id !== 'string') {
        failures.add('SCENARIO_OBSERVATION_INVALID');
        continue;
      }
      const scenario = scenarioValue;
      if (seen.has(scenario.id)) failures.add(`SCENARIO_DUPLICATE:${scenario.id}`);
      seen.add(scenario.id);
      const metrics = scenarios[scenario.id];
      if (!metrics) {
        failures.add(`SCENARIO_UNDECLARED:${scenario.id}`);
        continue;
      }
      if (
        typeof scenario.passed !== 'boolean' ||
        !Number.isSafeInteger(scenario.expectedExternalWrites) ||
        !Number.isSafeInteger(scenario.observedExternalWrites) ||
        !Number.isSafeInteger(scenario.observedOutcomeQueries) ||
        typeof scenario.receiptVerified !== 'boolean' ||
        typeof scenario.evidencePersisted !== 'boolean' ||
        typeof scenario.reconciliationLatencyMs !== 'number' ||
        !Number.isFinite(scenario.reconciliationLatencyMs)
      ) {
        failures.add(`SCENARIO_OBSERVATION_INVALID:${scenario.id}`);
        continue;
      }
      metrics.trials += 1;
      metrics.passedTrials += scenario.passed ? 1 : 0;
      metrics.externalWrites += scenario.observedExternalWrites;
      metrics.outcomeQueries += scenario.observedOutcomeQueries;
      metrics.duplicateWrites += Math.max(
        0,
        scenario.observedExternalWrites - metrics.expectedExternalWrites,
      );
      metrics.receiptFailures += scenario.receiptVerified ? 0 : 1;
      metrics.evidenceFailures += scenario.evidencePersisted ? 0 : 1;
      metrics.maxReconciliationLatencyMs = Math.max(
        metrics.maxReconciliationLatencyMs,
        scenario.reconciliationLatencyMs,
      );
      if (!scenario.passed) failures.add(`SCENARIO_FAILED:${scenario.id}`);
      if (scenario.observedExternalWrites !== metrics.expectedExternalWrites) {
        failures.add(`SCENARIO_EXTERNAL_WRITE_COUNT_INVALID:${scenario.id}`);
      }
      if (metrics.expectedExternalWrites === 0 && scenario.observedExternalWrites !== 0) {
        deniedScenarioExternalWrites += scenario.observedExternalWrites;
        failures.add(`DENIED_SCENARIO_EXTERNAL_WRITES:${scenario.id}`);
      }
      if (!scenario.receiptVerified) failures.add(`SCENARIO_RECEIPT_UNVERIFIED:${scenario.id}`);
      if (!scenario.evidencePersisted)
        failures.add(`SCENARIO_EVIDENCE_NOT_PERSISTED:${scenario.id}`);
    }
  }

  for (const definition of DESIGN_PARTNER_SCENARIOS) {
    const metrics = scenarios[definition.id]!;
    if (metrics.trials !== repetitions) {
      failures.add(`SCENARIO_REPETITION_COUNT_INVALID:${definition.id}`);
    }
    if (metrics.duplicateWrites > 0) {
      failures.add(`SCENARIO_DUPLICATE_WRITES:${definition.id}`);
    }
    if (metrics.receiptFailures > 0) {
      failures.add(`SCENARIO_RECEIPT_UNVERIFIED:${definition.id}`);
    }
    if (metrics.evidenceFailures > 0) {
      failures.add(`SCENARIO_EVIDENCE_NOT_PERSISTED:${definition.id}`);
    }
    if (definition.requiresOutcomeQuery && metrics.outcomeQueries < metrics.trials) {
      failures.add(`SCENARIO_OUTCOME_QUERY_REQUIRED:${definition.id}`);
    }
  }

  const duplicateWrites = Object.values(scenarios).reduce(
    (total, scenario) => total + scenario.duplicateWrites,
    0,
  );
  const unverifiedTerminalReceipts = Object.values(scenarios).reduce(
    (total, scenario) => total + scenario.receiptFailures,
    0,
  );
  const terminalCasesMissingEvidence = Object.values(scenarios).reduce(
    (total, scenario) => total + scenario.evidenceFailures,
    0,
  );
  return {
    verdict: failures.size === 0 ? 'PROVEN' : 'NOT_READY',
    failures: [...failures],
    metrics: {
      repetitions,
      totalTrials: observations.length * DESIGN_PARTNER_SCENARIOS.length,
      duplicateWrites,
      deniedScenarioExternalWrites,
      staleLeaseWrites: scenarios.lease_fencing?.duplicateWrites ?? 0,
      killSwitchBypasses: scenarios.kill_switch?.externalWrites ?? 0,
      crossScopeWrites: scenarios.tenant_isolation?.externalWrites ?? 0,
      unverifiedTerminalReceipts,
      terminalCasesMissingEvidence,
      scenarios,
    },
  };
}

export function sanitizeGovernedRollbackArtifact(name: string, body: string): string {
  const forbiddenKeys = new Set([
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
    'dsn',
    'databaseurl',
    'connectionstring',
  ]);
  const safeValue = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(safeValue);
    if (value === null || typeof value !== 'object') return true;
    return Object.entries(value).every(([key, child]) => {
      return !forbiddenKeys.has(key.replaceAll('_', '').toLowerCase()) && safeValue(child);
    });
  };
  if (
    /postgres(?:ql)?:\/\//i.test(body) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body) ||
    /authorization\s*:\s*bearer\s+/i.test(body)
  ) {
    throw new Error(`RETAINED_ARTIFACT_UNSAFE:${name}`);
  }
  if (
    name.startsWith('/') ||
    name.split(/[\\/]/u).some((segment) => segment === '..' || segment.length === 0)
  ) {
    throw new Error(`RETAINED_ARTIFACT_UNSAFE:${name}`);
  }
  try {
    if (name.endsWith('.ndjson')) {
      const valid = body
        .split(/\r?\n/)
        .filter(Boolean)
        .every((line) => safeValue(JSON.parse(line)));
      if (!valid) throw new Error('invalid artifact');
    } else if (!safeValue(JSON.parse(body))) {
      throw new Error('unsafe artifact');
    }
  } catch {
    throw new Error(`RETAINED_ARTIFACT_UNSAFE:${name}`);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return message.match(/^[A-Z][A-Z0-9_]+/)?.[0] ?? fallback;
}

function aggregateFailures(
  aggregate: GovernedRollbackAggregateResult,
  failures: readonly string[],
): GovernedRollbackAggregateResult {
  const combined = [...new Set([...aggregate.failures, ...failures])];
  return {
    ...aggregate,
    verdict: combined.length === 0 ? 'PROVEN' : 'NOT_READY',
    failures: combined,
  };
}

export async function runGovernedRollbackBenchmark(
  args: GovernedRollbackBenchmarkArgs,
  ports: GovernedRollbackBenchmarkPorts,
): Promise<GovernedRollbackBenchmarkResult> {
  const outputDirectory = resolve(args.output);
  let source: GovernedRollbackSource | null = null;
  const failures: string[] = [];
  try {
    source = await ports.captureSource();
  } catch {
    failures.push('SOURCE_METADATA_UNAVAILABLE');
  }
  failures.push(...sourceFailure(source));

  let plan: GovernedRollbackRepetition[] = [];
  try {
    plan = buildGovernedRollbackRepetitionPlan(args.repetitions);
  } catch (error) {
    failures.push(errorCode(error, 'REPETITION_PLAN_INVALID'));
  }

  const observations: DesignPartnerCampaignObservation[] = [];
  const retainedArtifacts: Record<string, string> = {};
  if (failures.length === 0) {
    for (const repetition of plan) {
      const trialDirectory = join(
        outputDirectory,
        'raw',
        `rebuild-${repetition.environmentRebuild}`,
        `repetition-${repetition.repetition}`,
      );
      try {
        await mkdir(trialDirectory, { recursive: true });
        const trial = await ports.runTrial({
          ...repetition,
          outputDirectory: trialDirectory,
        });
        const observationBody = `${stableJson(trial.observation)}\n`;
        sanitizeGovernedRollbackArtifact('observation.json', observationBody);
        observations.push(trial.observation);
        retainedArtifacts[relative(outputDirectory, join(trialDirectory, 'observation.json'))] =
          observationBody;

        for (const [name, body] of Object.entries(trial.artifacts)) {
          if (name === 'observation.json') continue;
          try {
            sanitizeGovernedRollbackArtifact(name, body);
          } catch (error) {
            failures.push(`TRIAL_${repetition.repetition}:${errorCode(error, 'ARTIFACT_UNSAFE')}`);
            continue;
          }
          const artifactPath = relative(outputDirectory, join(trialDirectory, name));
          retainedArtifacts[artifactPath] = body;
        }
        for (const required of REQUIRED_ARTIFACT_NAMES) {
          if (typeof trial.artifacts[required] !== 'string') {
            failures.push(`TRIAL_ARTIFACT_MISSING:${required}`);
          }
        }
      } catch (error) {
        failures.push(
          `TRIAL_${repetition.repetition}:${errorCode(error, 'CAMPAIGN_DRIVER_FAILED')}`,
        );
      }
    }
  }

  let aggregate =
    observations.length > 0
      ? aggregateGovernedRollbackObservations(observations, args.repetitions)
      : emptyAggregate(args.repetitions);
  aggregate = aggregateFailures(aggregate, failures);

  const rawEvents = observations
    .map((observation, index) => {
      const repetition = plan[index];
      return stableJsonLine({
        repetition: repetition?.repetition ?? index + 1,
        environmentRebuild: repetition?.environmentRebuild ?? null,
        observation,
      });
    })
    .join('\n');
  if (rawEvents) retainedArtifacts['raw-events.ndjson'] = `${rawEvents}\n`;

  return {
    schema: 'commander-governed-rollback-benchmark/v1',
    ...aggregate,
    passed: aggregate.verdict === 'PROVEN',
    environment: 'kind',
    source,
    freshEnvironmentRebuilds:
      observations.length === 0
        ? 0
        : new Set(
            plan.slice(0, observations.length).map(({ environmentRebuild }) => environmentRebuild),
          ).size,
    artifacts: retainedArtifacts,
  };
}

export async function writeGovernedRollbackBenchmarkArtifacts(
  outputDirectory: string,
  args: GovernedRollbackBenchmarkArgs,
  result: GovernedRollbackBenchmarkResult,
): Promise<void> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const environmentManifest = {
    schema: 'commander-governed-rollback-environment/v1',
    environment: result.environment,
    freshEnvironmentRebuilds: result.freshEnvironmentRebuilds,
    source: result.source,
    topology: (() => {
      const first = Object.entries(result.artifacts).find(([path]) =>
        path.endsWith('/observation.json'),
      );
      if (!first) return null;
      try {
        const observation = JSON.parse(first[1]) as DesignPartnerCampaignObservation;
        return observation.topology;
      } catch {
        return null;
      }
    })(),
  };
  const metrics = {
    schema: 'commander-governed-rollback-metrics/v1',
    environment: result.environment,
    repetitions: result.metrics.repetitions,
    totalTrials: result.metrics.totalTrials,
    duplicateWrites: result.metrics.duplicateWrites,
    deniedScenarioExternalWrites: result.metrics.deniedScenarioExternalWrites,
    staleLeaseWrites: result.metrics.staleLeaseWrites,
    killSwitchBypasses: result.metrics.killSwitchBypasses,
    crossScopeWrites: result.metrics.crossScopeWrites,
    unverifiedTerminalReceipts: result.metrics.unverifiedTerminalReceipts,
    terminalCasesMissingEvidence: result.metrics.terminalCasesMissingEvidence,
    scenarios: result.metrics.scenarios,
  };
  const verification = {
    schema: 'commander-governed-rollback-verification/v1',
    verdict: result.verdict,
    passed: result.passed,
    failures: result.failures,
    checks: {
      allScenariosRepeated:
        result.metrics.totalTrials === args.repetitions * DESIGN_PARTNER_SCENARIOS.length &&
        result.failures.every(
          (failure) => !failure.startsWith('SCENARIO_REPETITION_COUNT_INVALID'),
        ),
      duplicateWritesZero: result.metrics.duplicateWrites === 0,
      deniedScenarioWritesZero: result.metrics.deniedScenarioExternalWrites === 0,
      staleLeaseWritesZero: result.metrics.staleLeaseWrites === 0,
      killSwitchBypassesZero: result.metrics.killSwitchBypasses === 0,
      crossScopeWritesZero: result.metrics.crossScopeWrites === 0,
      terminalReceiptsVerified: result.metrics.unverifiedTerminalReceipts === 0,
      terminalEvidenceComplete: result.metrics.terminalCasesMissingEvidence === 0,
      retainedArtifactsSanitized: true,
    },
  };

  const generated: Record<string, string> = {
    ...result.artifacts,
    'environment-manifest.json': `${stableJson(environmentManifest)}\n`,
    'metrics.json': `${stableJson(metrics)}\n`,
    'verification.json': `${stableJson(verification)}\n`,
  };
  for (const [name, body] of Object.entries(generated)) {
    sanitizeGovernedRollbackArtifact(name, body);
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), body, 'utf8');
  }

  const artifactHashes = Object.entries(generated)
    .map(([path, body]) => ({ path, sha256: sha256(body) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema: result.schema,
    verdict: result.verdict,
    passed: result.passed,
    environment: result.environment,
    repetitions: args.repetitions,
    totalTrials: result.metrics.totalTrials,
    freshEnvironmentRebuilds: result.freshEnvironmentRebuilds,
    source: result.source,
    thresholds: {
      duplicateWrites: 0,
      deniedScenarioExternalWrites: 0,
      staleLeaseWrites: result.metrics.staleLeaseWrites,
      killSwitchBypasses: result.metrics.killSwitchBypasses,
      crossScopeWrites: result.metrics.crossScopeWrites,
      unverifiedTerminalReceipts: result.metrics.unverifiedTerminalReceipts,
      terminalCasesMissingEvidence: result.metrics.terminalCasesMissingEvidence,
    },
    failures: result.failures,
    generatingCommand: `pnpm benchmark:governed-rollback -- --environment kind --repetitions ${args.repetitions} --output <output-directory>`,
    artifacts: artifactHashes,
  };
  const manifestBody = `${stableJson(manifest)}\n`;
  await writeFile(join(directory, 'manifest.json'), manifestBody, 'utf8');
  await writeFile(
    join(directory, 'hashes.json'),
    `${stableJson({ schema: 'commander-governed-rollback-hashes/v1', artifacts: artifactHashes })}\n`,
    'utf8',
  );
}

function captureSource(): GovernedRollbackSource {
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    commit,
    dirty: status.trim().length > 0,
    dependencyLockSha256: sha256(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')),
  };
}

function parseDriverArgs(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.COMMANDER_GOVERNED_ROLLBACK_DRIVER_ARGS?.trim();
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('CAMPAIGN_DRIVER_ARGS_INVALID');
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('CAMPAIGN_DRIVER_ARGS_INVALID');
  }
  return value;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', () => resolveResult({ status: -1, stdout: '', stderr: '' }));
    child.once('close', (status) => resolveResult({ status: status ?? -1, stdout, stderr }));
  });
}

async function collectArtifactFiles(directory: string): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else artifacts[relative(directory, path)] = await readFile(path, 'utf8');
    }
  }
  await visit(directory);
  return artifacts;
}

function createRepositoryBenchmarkPorts(
  environment: NodeJS.ProcessEnv = process.env,
): GovernedRollbackBenchmarkPorts {
  return {
    captureSource: async () => captureSource(),
    runTrial: async (input) => {
      const command = environment.COMMANDER_GOVERNED_ROLLBACK_DRIVER?.trim();
      if (!command) throw new Error('CAMPAIGN_DRIVER_COMMAND_REQUIRED');
      const args = [
        ...parseDriverArgs(environment),
        '--environment',
        'kind',
        '--repetition',
        String(input.repetition),
        '--environment-rebuild',
        String(input.environmentRebuild),
        '--output',
        input.outputDirectory,
      ];
      const result = await runCommand(command, args, process.cwd(), environment);
      if (result.status !== 0) throw new Error('CAMPAIGN_DRIVER_EXIT_NONZERO');
      const files = await collectArtifactFiles(input.outputDirectory);
      const observationBody = files['observation.json'];
      if (!observationBody) throw new Error('CAMPAIGN_OBSERVATION_REQUIRED');
      let observation: DesignPartnerCampaignObservation;
      try {
        const parsed: unknown = JSON.parse(observationBody);
        if (!isRecord(parsed)) throw new Error('invalid observation');
        observation = parsed as unknown as DesignPartnerCampaignObservation;
      } catch {
        throw new Error('CAMPAIGN_OBSERVATION_INVALID');
      }
      delete files['observation.json'];
      return { observation, artifacts: files };
    },
  };
}

async function main(): Promise<void> {
  let args: GovernedRollbackBenchmarkArgs;
  try {
    args = parseGovernedRollbackBenchmarkArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const outputDirectory = resolve(args.output);
  let result: GovernedRollbackBenchmarkResult;
  try {
    result = await runGovernedRollbackBenchmark(args, createRepositoryBenchmarkPorts());
  } catch (error) {
    const aggregate = emptyAggregate(args.repetitions);
    result = {
      schema: 'commander-governed-rollback-benchmark/v1',
      ...aggregateFailures(aggregate, [errorCode(error, 'BENCHMARK_RUNTIME_FAILED')]),
      passed: false,
      environment: 'kind',
      source: null,
      freshEnvironmentRebuilds: 0,
      artifacts: {},
    };
  }
  await writeGovernedRollbackBenchmarkArtifacts(outputDirectory, args, result);
  process.stdout.write(`${stableJson({ verdict: result.verdict, failures: result.failures })}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
