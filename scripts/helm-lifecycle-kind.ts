#!/usr/bin/env tsx
/**
 * Task 1 — Kind Lifecycle Harness
 *
 * Creates a pinned Kubernetes 1.33.2 Kind cluster, installs Calico for
 * NetworkPolicy enforcement, and runs real Helm lifecycle scenarios against
 * the Commander chart. Produces sanitized evidence JSON.
 */

import { execFile, execFileSync, ExecFileOptions } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CLUSTER_NAME = 'commander-helm-lifecycle';
export const KIND_NODE_IMAGE =
  'kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121';
export const CALICO_URL =
  'https://raw.githubusercontent.com/projectcalico/calico/v3.29.0/manifests/calico.yaml';
export const NOOP_IMAGE = 'commander-lifecycle-noop:latest';
export const NAMESPACE = 'commander-lifecycle';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScenarioEvidence {
  name: string;
  passed: boolean;
  durationMs: number;
  events: Record<string, unknown>[];
  assertions: AssertionResult[];
  rbac?: AssertionResult[];
  networkPolicy?: AssertionResult[];
  error?: string;
}

export interface AssertionResult {
  description: string;
  passed: boolean;
  detail?: string;
}

export interface HarnessEvidence {
  generatedAt: string;
  cluster: string;
  kindNodeImage: string;
  chartPath: string;
  calicoUrl: string;
  scenarios: ScenarioEvidence[];
  rbac?: AssertionResult[];
  networkPolicy?: AssertionResult[];
  rolloutRecovery?: ScenarioEvidence;
  sanitized: boolean;
}

interface HarnessOptions {
  chart: string;
  keepCluster: boolean;
  scenarioFilter?: string;
}

function rootDir(): string {
  return resolve(__dirname, '..');
}

function fixturePath(name: string): string {
  return resolve(__dirname, 'fixtures', 'helm-lifecycle', name);
}

export function sanitizeEvidence(evidence: HarnessEvidence): HarnessEvidence {
  const secretPatterns = [
    // Postgres DSNs and URLs
    [/postgres(?:ql)?:\/\/[^\s"']+/, 'postgres://***@***'],
    // Generic password/token/key values
    [/"password"\s*:\s*"[^"]*"/, '"password": "***"'],
    [/"token"\s*:\s*"[^"]*"/, '"token": "***"'],
    // PEM blocks
    [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/, '[PEM_REDACTED]'],
  ];
  const text = JSON.stringify(evidence);
  const sanitized = secretPatterns.reduce((acc, [pattern, replacement]) => {
    return acc.replace(new RegExp(pattern, 'g'), String(replacement));
  }, text);
  const out = JSON.parse(sanitized) as HarnessEvidence;
  out.sanitized = true;
  return out;
}

function runCmd(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, encoding: 'utf8' as const }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error?.code ?? 0,
      });
    });
  });
}

function runCmdSync(file: string, args: string[], options: ExecFileOptions = {}): CommandResult {
  try {
    const result = execFileSync(file, args, { ...options, encoding: 'utf8' });
    return { stdout: result ?? '', stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: Number(error.status ?? 1),
    };
  }
}

export function kindClusterExists(cluster: string): boolean {
  const result = runCmdSync('kind', ['get', 'clusters']);
  return result.stdout.split(/\n/).some((line) => line.trim() === cluster);
}

export async function createKindCluster(cluster: string): Promise<void> {
  if (kindClusterExists(cluster)) {
    await runCmd('kind', ['delete', 'cluster', '--name', cluster]);
  }
  const result = await runCmd('kind', [
    'create',
    'cluster',
    '--name',
    cluster,
    '--config',
    fixturePath('kind-config.yaml'),
    '--image',
    KIND_NODE_IMAGE,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`kind create cluster failed: ${result.stderr}`);
  }
}

export async function deleteKindCluster(cluster: string): Promise<void> {
  await runCmd('kind', ['delete', 'cluster', '--name', cluster]);
}

export async function installCalico(): Promise<void> {
  const result = await runCmd('kubectl', ['apply', '-f', CALICO_URL]);
  if (result.exitCode !== 0) {
    throw new Error(`Calico apply failed: ${result.stderr}`);
  }
  // Wait for Calico pods.
  const wait = await runCmd('kubectl', [
    'wait',
    '--for=condition=ready',
    'pod',
    '-l',
    'k8s-app=calico-node',
    '-n',
    'kube-system',
    '--timeout=180s',
  ]);
  if (wait.exitCode !== 0) {
    throw new Error(`Calico did not become ready: ${wait.stderr}`);
  }
}

export async function buildAndLoadNoopImage(): Promise<void> {
  const build = await runCmd('docker', [
    'build',
    '-t',
    NOOP_IMAGE,
    '-f',
    fixturePath('noop/Dockerfile'),
    fixturePath('noop'),
  ]);
  if (build.exitCode !== 0) {
    throw new Error(`Noop image build failed: ${build.stderr}`);
  }
  const load = await runCmd('kind', ['load', 'docker-image', NOOP_IMAGE, '--name', CLUSTER_NAME]);
  if (load.exitCode !== 0) {
    throw new Error(`kind load docker-image failed: ${load.stderr}`);
  }
}

function kubectl(args: string[]): Promise<CommandResult> {
  return runCmd('kubectl', args);
}

function helm(args: string[]): Promise<CommandResult> {
  return runCmd('helm', args);
}

async function createNamespace(): Promise<void> {
  const result = await kubectl(['create', 'namespace', NAMESPACE]);
  if (result.exitCode !== 0 && !result.stderr.includes('AlreadyExists')) {
    throw new Error(`failed to create namespace: ${result.stderr}`);
  }
}

async function waitForDeployment(name: string, timeout = '300s'): Promise<CommandResult> {
  return runCmd('kubectl', [
    'wait',
    '--for=condition=available',
    'deployment',
    name,
    '-n',
    NAMESPACE,
    '--timeout',
    timeout,
  ]);
}

async function waitForJob(name: string, timeout = '300s'): Promise<CommandResult> {
  return runCmd('kubectl', [
    'wait',
    '--for=condition=complete',
    'job',
    name,
    '-n',
    NAMESPACE,
    '--timeout',
    timeout,
  ]);
}

async function resourceExists(kind: string, name: string, namespace: string): Promise<boolean> {
  const result = await runCmd('kubectl', ['get', kind, name, '-n', namespace]);
  return result.exitCode === 0;
}

async function getEvents(namespace: string): Promise<Record<string, unknown>[]> {
  const result = await runCmd('kubectl', ['get', 'events', '-n', namespace, '-o', 'json']);
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { items: Record<string, unknown>[] };
    return parsed.items ?? [];
  } catch {
    return [];
  }
}

async function jobHasEvent(namespace: string, jobName: string): Promise<boolean> {
  const events = await getEvents(namespace);
  return events.some((event) => {
    const involved = event.involvedObject as Record<string, string> | undefined;
    return involved?.name === jobName || involved?.name?.startsWith(`${jobName}-`);
  });
}

async function helmInstall(
  release: string,
  values: string,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  const args = [
    'install',
    release,
    resolve(options.chart),
    '-n',
    NAMESPACE,
    '-f',
    values,
    '--wait',
    '--timeout',
    '300s',
    ...extraArgs,
  ];
  return helm(args);
}

async function helmUpgrade(
  release: string,
  values: string,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  const args = [
    'upgrade',
    release,
    resolve(options.chart),
    '-n',
    NAMESPACE,
    '-f',
    values,
    '--wait',
    '--timeout',
    '300s',
    ...extraArgs,
  ];
  return helm(args);
}

let options: HarnessOptions = {
  chart: resolve(__dirname, '..', 'deploy', 'helm', 'commander'),
  keepCluster: false,
};

function setOptions(opts: HarnessOptions): void {
  options = opts;
}

export function proofTemplatesPresent(chart: string): boolean {
  return existsSync(resolve(chart, 'templates', 'tenant-cutover-prove-job.yaml'));
}

async function runScenarioFreshBundled(): Promise<ScenarioEvidence> {
  const start = Date.now();
  const assertions: AssertionResult[] = [];
  const release = 'cmdr-bundled';
  const events: Record<string, unknown>[] = [];

  try {
    await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found=true']);
    await createNamespace();
    await kubectl(['apply', '-f', fixturePath('bundled-public-secrets.yaml')]);

    const install = await helmInstall(release, fixturePath('values-bundled-ephemeral.yaml'));
    if (install.exitCode !== 0) {
      throw new Error(`fresh bundled install failed: ${install.stderr}`);
    }

    // Wait for cell deployments.
    for (const dep of [
      'cmdr-bundled-api',
      'cmdr-bundled-worker',
      'cmdr-bundled-kernel-ops',
      'cmdr-bundled-adapter-ops',
    ]) {
      const wait = await waitForDeployment(dep);
      assertions.push({
        description: `${dep} is available`,
        passed: wait.exitCode === 0,
        detail: wait.exitCode === 0 ? undefined : wait.stderr,
      });
    }

    // Migration job completes before we get here because of --wait, but verify it existed.
    const hasMigrationEvent = await jobHasEvent(NAMESPACE, `${release}-migration`);
    assertions.push({
      description: 'migration job creation event observed',
      passed: hasMigrationEvent,
      detail: hasMigrationEvent ? undefined : 'no event found for migration job',
    });

    if (proofTemplatesPresent(options.chart)) {
      const proofJobName = `${release}-tenant-cutover-prove`;
      const hasProofEvent = await jobHasEvent(NAMESPACE, proofJobName);
      assertions.push({
        description: 'proof job creation event observed',
        passed: hasProofEvent,
        detail: hasProofEvent
          ? undefined
          : 'tenant-cutover-prove-job template missing or job not created',
      });
      if (hasProofEvent) {
        const stillExists = await resourceExists('job', proofJobName, NAMESPACE);
        assertions.push({
          description: 'proof job was deleted after success',
          passed: !stillExists,
          detail: stillExists ? 'proof job still exists' : undefined,
        });
      }
    } else {
      assertions.push({
        description: 'proof job tests skipped (templates not present)',
        passed: true,
      });
    }

    // Run proof-reader RBAC/NetworkPolicy tests against the live release before
    // uninstalling it. These only apply when the chart contains the templates.
    let rbac: AssertionResult[] | undefined;
    let networkPolicy: AssertionResult[] | undefined;
    if (proofTemplatesPresent(options.chart)) {
      rbac = await runRbacTests();
      networkPolicy = await runNetworkPolicyTests();
    }

    events.push(...(await getEvents(NAMESPACE)));

    await helm(['uninstall', release, '-n', NAMESPACE, '--wait']);

    return {
      name: 'fresh-bundled',
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      events,
      assertions,
      rbac,
      networkPolicy,
    };
  } catch (error) {
    return {
      name: 'fresh-bundled',
      passed: false,
      durationMs: Date.now() - start,
      events,
      assertions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runScenarioExpandEnforce(): Promise<ScenarioEvidence> {
  const start = Date.now();
  const assertions: AssertionResult[] = [];
  const release = 'cmdr-expand';
  const events: Record<string, unknown>[] = [];

  try {
    await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found=true']);
    await createNamespace();
    await kubectl(['apply', '-f', fixturePath('bundled-public-secrets.yaml')]);
    await kubectl(['apply', '-f', fixturePath('bundled-persistent-database-secret.yaml')]);

    const install = await helmInstall(release, fixturePath('values-bundled-persistent.yaml'), [
      '--set',
      'tenantAuthority.cutoverPhase=expand',
    ]);
    if (install.exitCode !== 0) {
      throw new Error(`expand install failed: ${install.stderr}`);
    }

    assertions.push({
      description: 'expand install succeeded',
      passed: true,
    });

    const upgrade = await helmUpgrade(release, fixturePath('values-bundled-persistent.yaml'), [
      '--set',
      'tenantAuthority.cutoverPhase=enforce',
    ]);
    if (upgrade.exitCode !== 0) {
      throw new Error(`enforce upgrade failed: ${upgrade.stderr}`);
    }

    assertions.push({
      description: 'enforce upgrade succeeded',
      passed: true,
    });

    // Verify API deployment has the enforce phase label.
    const apiDep = await runCmd('kubectl', [
      'get',
      'deployment',
      `${release}-api`,
      '-n',
      NAMESPACE,
      '-o',
      'yaml',
    ]);
    const isEnforce =
      apiDep.exitCode === 0 && /tenant-authority-phase:\s*enforce/.test(apiDep.stdout);
    assertions.push({
      description: 'API deployment is in enforce phase after upgrade',
      passed: isEnforce,
    });

    events.push(...(await getEvents(NAMESPACE)));
    await helm(['uninstall', release, '-n', NAMESPACE, '--wait']);

    return {
      name: 'expand-enforce',
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      events,
      assertions,
    };
  } catch (error) {
    return {
      name: 'expand-enforce',
      passed: false,
      durationMs: Date.now() - start,
      events,
      assertions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runScenarioExternal(): Promise<ScenarioEvidence> {
  const start = Date.now();
  const assertions: AssertionResult[] = [];
  const release = 'cmdr-external';
  const events: Record<string, unknown>[] = [];

  try {
    await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found=true']);
    await kubectl(['delete', 'namespace', 'external-db', '--ignore-not-found=true']);
    await createNamespace();

    // Deploy external Postgres.
    const pgApply = await kubectl(['apply', '-f', fixturePath('external-postgres.yaml')]);
    if (pgApply.exitCode !== 0) {
      throw new Error(`external postgres apply failed: ${pgApply.stderr}`);
    }
    await runCmd('kubectl', [
      'wait',
      '--for=condition=available',
      'deployment',
      'external-postgres',
      '-n',
      'external-db',
      '--timeout=120s',
    ]);

    // Wait a moment for the service endpoint to be ready.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Create external secrets and public CA secrets.
    await kubectl(['apply', '-f', fixturePath('external-secrets.yaml')]);

    const install = await helmInstall(release, fixturePath('values-external.yaml'));
    if (install.exitCode !== 0) {
      throw new Error(`external install failed: ${install.stderr}`);
    }

    for (const dep of [
      'cmdr-external-api',
      'cmdr-external-worker',
      'cmdr-external-kernel-ops',
      'cmdr-external-adapter-ops',
    ]) {
      const wait = await waitForDeployment(dep);
      assertions.push({
        description: `${dep} is available`,
        passed: wait.exitCode === 0,
        detail: wait.exitCode === 0 ? undefined : wait.stderr,
      });
    }

    const hasPostgresSts = await resourceExists('statefulset', `${release}-postgres`, NAMESPACE);
    assertions.push({
      description: 'bundled Postgres StatefulSet is not rendered',
      passed: !hasPostgresSts,
    });

    events.push(...(await getEvents(NAMESPACE)));
    await helm(['uninstall', release, '-n', NAMESPACE, '--wait']);
    await kubectl(['delete', 'namespace', 'external-db', '--ignore-not-found=true']);

    return {
      name: 'external-postgres',
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      events,
      assertions,
    };
  } catch (error) {
    return {
      name: 'external-postgres',
      passed: false,
      durationMs: Date.now() - start,
      events,
      assertions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runScenarioRolloutRecovery(): Promise<ScenarioEvidence> {
  const start = Date.now();
  const assertions: AssertionResult[] = [];
  const release = 'cmdr-recovery';
  const events: Record<string, unknown>[] = [];

  try {
    await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found=true']);
    await createNamespace();
    await kubectl(['apply', '-f', fixturePath('bundled-public-secrets.yaml')]);

    // Install with a non-existent image.
    const badValues = fixturePath('values-bundled-ephemeral.yaml');
    const badInstall = await helmInstall(release, badValues, [
      '--set',
      'image.repository=nonexistent-repository.invalid/nonexistent',
      '--set',
      'image.tag=bad',
      '--set',
      'worker.image.repository=nonexistent-repository.invalid/nonexistent',
      '--set',
      'worker.image.tag=bad',
      '--set',
      'kernelOps.image.repository=nonexistent-repository.invalid/nonexistent',
      '--set',
      'kernelOps.image.tag=bad',
      '--set',
      'adapterOps.image.repository=nonexistent-repository.invalid/nonexistent',
      '--set',
      'adapterOps.image.tag=bad',
      '--timeout',
      '60s',
    ]);
    const failedAsExpected = badInstall.exitCode !== 0;
    assertions.push({
      description: 'rollout failure was detected (install timed out or failed)',
      passed: failedAsExpected,
      detail: failedAsExpected ? undefined : badInstall.stderr,
    });

    // Recover with the valid no-op image.
    const upgrade = await helmUpgrade(release, badValues);
    if (upgrade.exitCode !== 0) {
      throw new Error(`recovery upgrade failed: ${upgrade.stderr}`);
    }

    for (const dep of [
      'cmdr-recovery-api',
      'cmdr-recovery-worker',
      'cmdr-recovery-kernel-ops',
      'cmdr-recovery-adapter-ops',
    ]) {
      const wait = await waitForDeployment(dep);
      assertions.push({
        description: `${dep} recovered and is available`,
        passed: wait.exitCode === 0,
        detail: wait.exitCode === 0 ? undefined : wait.stderr,
      });
    }

    events.push(...(await getEvents(NAMESPACE)));
    await helm(['uninstall', release, '-n', NAMESPACE, '--wait']);

    return {
      name: 'rollout-recovery',
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      events,
      assertions,
    };
  } catch (error) {
    return {
      name: 'rollout-recovery',
      passed: false,
      durationMs: Date.now() - start,
      events,
      assertions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runRbacTests(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const sa = `system:serviceaccount:${NAMESPACE}:commander-tenant-authority-proof-reader`;

  const positiveChecks = [
    { verb: 'get', resource: 'deployments' },
    { verb: 'list', resource: 'deployments' },
    { verb: 'get', resource: 'replicasets' },
    { verb: 'list', resource: 'replicasets' },
    { verb: 'get', resource: 'pods' },
    { verb: 'list', resource: 'pods' },
    { verb: 'get', resource: 'services', name: 'cmdr-bundled-api-proof' },
  ];

  for (const check of positiveChecks) {
    const args = check.name
      ? ['auth', 'can-i', check.verb, check.resource, check.name, '--as', sa, '-n', NAMESPACE]
      : ['auth', 'can-i', check.verb, check.resource, '--as', sa, '-n', NAMESPACE];
    const result = await kubectl(args);
    results.push({
      description: `RBAC positive: ${check.verb} ${check.resource}${check.name ? `/${check.name}` : ''}`,
      passed: result.exitCode === 0 && result.stdout.trim().toLowerCase() === 'yes',
      detail: result.stderr || result.stdout,
    });
  }

  const negativeChecks = [
    { verb: 'list', resource: 'secrets' },
    { verb: 'create', resource: 'pods' },
    { verb: 'impersonate', resource: 'users' },
  ];

  for (const check of negativeChecks) {
    const result = await kubectl([
      'auth',
      'can-i',
      check.verb,
      check.resource,
      '--as',
      sa,
      '-n',
      NAMESPACE,
    ]);
    results.push({
      description: `RBAC negative: ${check.verb} ${check.resource}`,
      passed: result.exitCode === 0 && result.stdout.trim().toLowerCase() !== 'yes',
      detail: result.stderr || result.stdout,
    });
  }

  return results;
}

async function runNetworkPolicyTests(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  // Positive: a pod with proof-reader label can curl the API proof service.
  const positive = await runCmd('kubectl', [
    'run',
    'np-positive',
    '-n',
    NAMESPACE,
    '--rm',
    '-i',
    '--attach',
    '--restart=Never',
    '--image=alpine/curl',
    '--labels',
    'commander.io/tenant-authority-proof-reader=true',
    '--',
    'sh',
    '-c',
    'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://cmdr-bundled-api-proof:9443/ready/tenant-authority/v1',
  ]);
  results.push({
    description: 'NetworkPolicy positive: proof-reader pod reaches API proof service',
    passed: positive.exitCode === 0 && positive.stdout.trim() === '200',
    detail: positive.stderr || positive.stdout,
  });

  // Negative: an unlabeled pod cannot reach the API proof service.
  const negative = await runCmd('kubectl', [
    'run',
    'np-negative',
    '-n',
    NAMESPACE,
    '--rm',
    '-i',
    '--attach',
    '--restart=Never',
    '--image=alpine/curl',
    '--',
    'sh',
    '-c',
    'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://cmdr-bundled-api-proof:9443/ready/tenant-authority/v1',
  ]);
  results.push({
    description: 'NetworkPolicy negative: unlabeled pod blocked from API proof service',
    passed: negative.exitCode !== 0 || negative.stdout.trim() !== '200',
    detail: negative.stderr || negative.stdout,
  });

  return results;
}

async function runAll(opts: HarnessOptions): Promise<HarnessEvidence> {
  setOptions(opts);
  const start = Date.now();

  if (!kindClusterExists(CLUSTER_NAME)) {
    await createKindCluster(CLUSTER_NAME);
  }
  await installCalico();
  await buildAndLoadNoopImage();

  const scenarios: ScenarioEvidence[] = [];
  const filters = opts.scenarioFilter
    ? [opts.scenarioFilter]
    : ['fresh-bundled', 'expand-enforce', 'external-postgres', 'rollout-recovery'];

  if (filters.includes('fresh-bundled')) {
    scenarios.push(await runScenarioFreshBundled());
  }
  if (filters.includes('expand-enforce')) {
    scenarios.push(await runScenarioExpandEnforce());
  }
  if (filters.includes('external-postgres')) {
    scenarios.push(await runScenarioExternal());
  }
  if (filters.includes('rollout-recovery')) {
    scenarios.push(await runScenarioRolloutRecovery());
  }

  const freshBundled = scenarios.find((s) => s.name === 'fresh-bundled');
  const rbac = freshBundled?.rbac;
  const networkPolicy = freshBundled?.networkPolicy;

  if (!opts.keepCluster) {
    await deleteKindCluster(CLUSTER_NAME);
  }

  const rawEvidence: HarnessEvidence = {
    generatedAt: new Date().toISOString(),
    cluster: CLUSTER_NAME,
    kindNodeImage: KIND_NODE_IMAGE,
    chartPath: opts.chart,
    calicoUrl: CALICO_URL,
    scenarios,
    rbac,
    networkPolicy,
    sanitized: false,
  };

  const evidence = sanitizeEvidence(rawEvidence);
  evidence.sanitized = true;

  const evidencePath = resolve(rootDir(), 'kind-lifecycle-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(`Evidence written to ${evidencePath}\n`);

  return evidence;
}

function parseArgs(): HarnessOptions {
  const args = process.argv.slice(2);
  const chartIndex = args.indexOf('--chart');
  const keepIndex = args.indexOf('--keep-cluster');
  const scenarioIndex = args.indexOf('--scenario');
  return {
    chart:
      chartIndex >= 0 ? args[chartIndex + 1] : resolve(rootDir(), 'deploy', 'helm', 'commander'),
    keepCluster: keepIndex >= 0,
    scenarioFilter: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined,
  };
}

export { setOptions, runAll };

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const opts = parseArgs();
    const evidence = await runAll(opts);
    const passed = evidence.scenarios.every((s) => s.passed);
    process.exitCode = passed ? 0 : 1;
  })().catch((error) => {
    process.stderr.write(
      `harness failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
