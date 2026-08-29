import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { dump, load } from 'js-yaml';
import { SupplyChainScanner } from '../packages/core/src/security/supplyChainScanner.js';
import * as helmTenantCutover from './helm-tenant-cutover.js';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
} from '../packages/kernel/src/canonicalBootstrap.js';
import {
  KERNEL_TASK1_BASELINE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATIONS,
} from '../packages/kernel/src/migrations.js';
import {
  buildHelmOwnerJobBundle,
  buildHelmRolloutArgs,
  buildHelmTransportBootstrapArgs,
  assertManagedFieldsMatch,
  createNodePorts,
  extractRetainedSecretPayloads,
  parsePostRendererInvocation,
  postRenderRetainedSecrets,
  streamHelmRevisionRestore,
  validateFreshBundledDatabaseSecret,
  parseHelmTenantCutoverArgs,
  runHelmTenantCutover,
  type HelmCutoverPorts,
  type HelmOperation,
} from './helm-tenant-cutover.js';
import type {
  HelmReleaseObjectIdentity,
  HelmReleaseProjection,
} from './helm-recover-tenant-authority.js';

const commandOutputLimit = 1024 * 1024;

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const image = `sha256:${digest('a')}`;
const chart = digest('b');
const nonce = 'n'.repeat(43);

describe('Helm owner Job diagnostics', () => {
  it('converts command stdout failures into controlled termination', () => {
    const stdout = new EventEmitter();
    let terminations = 0;

    helmTenantCutover.observeCommandStreamFailures({ stdout }, () => {
      terminations += 1;
    });

    assert.doesNotThrow(() => stdout.emit('error', new Error('stdout failed')));
    assert.equal(terminations, 1);
  });

  it('continues to contain command stream failures after termination starts', () => {
    const stdout = new EventEmitter();
    let terminations = 0;

    helmTenantCutover.observeCommandStreamFailures({ stdout }, () => {
      terminations += 1;
    });

    stdout.emit('error', new Error('first stdout failure'));
    assert.doesNotThrow(() => stdout.emit('error', new Error('subsequent stdout failure')));
    assert.equal(terminations, 2);
  });

  it('continues to contain command process failures after rejection starts', () => {
    const child = new EventEmitter();
    let failures = 0;

    helmTenantCutover.observeCommandProcessFailures(child, () => {
      failures += 1;
    });

    child.emit('error', new Error('first child failure'));
    assert.doesNotThrow(() => child.emit('error', new Error('subsequent child failure')));
    assert.equal(failures, 2);
  });

  it('classifies kubectl failures by fixed subcommand without retaining arguments', () => {
    assert.deepEqual(
      [
        ['apply', 'TENANT_CUTOVER_KUBECTL_APPLY_FAILED'],
        ['create', 'TENANT_CUTOVER_KUBECTL_CREATE_FAILED'],
        ['delete', 'TENANT_CUTOVER_KUBECTL_DELETE_FAILED'],
        ['get', 'TENANT_CUTOVER_KUBECTL_GET_FAILED'],
        ['logs', 'TENANT_CUTOVER_KUBECTL_LOGS_COMMAND_FAILED'],
        ['version', 'TENANT_CUTOVER_KUBECTL_VERSION_FAILED'],
        ['wait', 'TENANT_CUTOVER_KUBECTL_WAIT_FAILED'],
        ['unknown', 'TENANT_CUTOVER_KUBECTL_COMMAND_FAILED'],
      ].map(([subcommand]) =>
        helmTenantCutover.commandFailureCode('kubectl', [subcommand!, 'sensitive-name']),
      ),
      [
        'TENANT_CUTOVER_KUBECTL_APPLY_FAILED',
        'TENANT_CUTOVER_KUBECTL_CREATE_FAILED',
        'TENANT_CUTOVER_KUBECTL_DELETE_FAILED',
        'TENANT_CUTOVER_KUBECTL_GET_FAILED',
        'TENANT_CUTOVER_KUBECTL_LOGS_COMMAND_FAILED',
        'TENANT_CUTOVER_KUBECTL_VERSION_FAILED',
        'TENANT_CUTOVER_KUBECTL_WAIT_FAILED',
        'TENANT_CUTOVER_KUBECTL_COMMAND_FAILED',
      ],
    );
    assert.equal(
      helmTenantCutover.commandFailureCode('kubectl', ['auth', 'can-i', 'get', 'secret/name']),
      'TENANT_CUTOVER_KUBECTL_AUTH_CAN_I_FAILED',
    );
    assert.deepEqual(
      [
        { kind: 'ConfigMap', metadata: {} },
        {
          kind: 'Job',
          metadata: { labels: { 'commander.io/tenant-cutover-owner-execution': 'opaque' } },
        },
        {
          kind: 'Job',
          metadata: { labels: { 'commander.io/tenant-authority-proof-reader': 'true' } },
        },
      ].map((object) =>
        helmTenantCutover.commandFailureCode(
          'kubectl',
          ['create', '--filename', '-'],
          JSON.stringify(object),
        ),
      ),
      [
        'TENANT_CUTOVER_KUBECTL_CREATE_CONFIGMAP_FAILED',
        'TENANT_CUTOVER_KUBECTL_CREATE_OWNER_JOB_FAILED',
        'TENANT_CUTOVER_KUBECTL_CREATE_PROOF_JOB_FAILED',
      ],
    );
    assert.equal(
      helmTenantCutover.commandFailureCode(
        'kubectl',
        ['create', '--filename', '-'],
        [
          'apiVersion: batch/v1',
          'kind: Job',
          'metadata:',
          '  labels:',
          '    commander.io/tenant-authority-proof-reader: "true"',
        ].join('\n'),
      ),
      'TENANT_CUTOVER_KUBECTL_CREATE_PROOF_JOB_FAILED',
    );
    assert.deepEqual(
      [
        'Error from server (AlreadyExists)',
        'Error from server (Forbidden): forbidden',
        'The Job is invalid',
        'Error from server (NotFound): not found',
      ].map((stderr) =>
        helmTenantCutover.commandFailureCode(
          'kubectl',
          ['create', '--filename', '-'],
          '{}',
          stderr,
        ),
      ),
      [
        'TENANT_CUTOVER_KUBECTL_CREATE_ALREADY_EXISTS',
        'TENANT_CUTOVER_KUBECTL_CREATE_FORBIDDEN',
        'TENANT_CUTOVER_KUBECTL_CREATE_INVALID',
        'TENANT_CUTOVER_KUBECTL_CREATE_NOT_FOUND',
      ],
    );
    assert.equal(
      helmTenantCutover.commandFailureCode(
        'kubectl',
        ['create', '--filename', '-'],
        JSON.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {} }),
        'The NetworkPolicy is invalid',
      ),
      'TENANT_CUTOVER_KUBECTL_CREATE_NETWORK_POLICY_INVALID',
    );
  });

  it('classifies Helm failures from bounded stderr without retaining its contents', () => {
    assert.equal(
      helmTenantCutover.commandFailureCode(
        'helm',
        ['upgrade', 'commander', 'chart'],
        undefined,
        'Error: UPGRADE FAILED: post-renderer failed: sensitive-resource-name',
      ),
      'TENANT_CUTOVER_HELM_COMMAND_FAILED:HELM_POST_RENDERER_FAILED',
    );
    assert.equal(
      helmTenantCutover.commandFailureCode(
        'helm',
        ['upgrade', 'commander', 'chart'],
        undefined,
        'Error: UPGRADE FAILED: timed out waiting for the condition',
      ),
      'TENANT_CUTOVER_HELM_COMMAND_FAILED:HELM_UPGRADE_TIMEOUT',
    );
    assert.equal(
      helmTenantCutover.commandFailureCode(
        'helm',
        ['upgrade', 'commander', 'chart'],
        undefined,
        'unrecognized sensitive Helm failure',
      ),
      'TENANT_CUTOVER_HELM_COMMAND_FAILED',
    );
  });

  it('carries only the fixed Helm failure category across the command boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-failure-category-'));
    const helm = join(root, 'helm');
    const previousPath = process.env.PATH;
    await writeFile(
      helm,
      [
        '#!/usr/bin/env node',
        "process.stderr.write('post-renderer failed: private-resource-name\\n');",
        'process.exitCode = 1;',
      ].join('\n'),
      { mode: 0o700 },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      await assert.rejects(
        () => helmTenantCutover.defaultCommand('helm', ['upgrade', 'commander', 'chart']),
        (error: unknown) => {
          assert.match(
            error instanceof Error ? error.message : '',
            /^TENANT_CUTOVER_HELM_COMMAND_FAILED:HELM_POST_RENDERER_FAILED$/,
          );
          assert.doesNotMatch(String(error), /private-resource-name/);
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses delete wait completion for proof-resource cleanup without a second get', async () => {
    const calls: Array<{ program: string; args: readonly string[] }> = [];
    const ports = createNodePorts({
      command: async (program, args) => {
        calls.push({ program, args });
        return '';
      },
    });

    await ports.kubectl.cleanupProofResources('commander', 'release');
    await ports.kubectl.deleteAndVerifySecret('commander', 'proof-owner');

    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.args[0] === 'delete'));
    assert.ok(calls.every((call) => call.args.includes('--wait=true')));
  });

  it('uses owner Job delete wait completion without a second resource query', async () => {
    const ports = createNodePorts({
      command: async (_program, args, stdin) => {
        if (args[0] === 'create') {
          const object = JSON.parse(stdin!) as { kind: string; metadata: { name: string } };
          return object.kind === 'ConfigMap'
            ? 'configmap/' + object.metadata.name
            : 'job.batch/' + object.metadata.name;
        }
        if (args[0] === 'wait' || args[0] === 'delete') return '';
        if (args[0] === 'logs') return JSON.stringify({ action: 'append' });
        if (args[0] === 'get') throw new Error('unexpected owner cleanup query');
        throw new Error('unexpected command: ' + args.join(' '));
      },
    });

    await assert.doesNotReject(() =>
      ports.owner.plan(
        {},
        {
          namespace: 'commander',
          release: 'commander',
          image: 'registry.example/commander@' + image,
          databaseSecretName: 'commander-database',
          databaseSecretKeys: {
            owner: 'owner-url',
            app: 'app-url',
            tenantAuthority: 'tenant-authority-url',
            scheduler: 'scheduler-url',
            worker: 'worker-url',
            adapterOps: 'adapter-ops-url',
          },
          databaseTls: {
            secretName: 'commander-database-tls',
            caKey: 'ca.crt',
            expectedServerSpkiSha256: digest('c'),
          },
          proofCertificate: {
            secretName: 'commander-api-proof',
            caKey: 'ca.crt',
            certKey: 'tls.crt',
          },
          bootstrap: { kind: 'none' },
        },
      ),
    );
  });

  it('classifies token-only kubectl create failures by their subcommand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-token-only-kubectl-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "process.stderr.write('Error from server (Forbidden): forbidden\\n');",
        'process.exitCode = 1;',
      ].join('\n'),
      { mode: 0o700 },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      await assert.rejects(
        helmTenantCutover.defaultCommand(
          'kubectl',
          [
            '--kubeconfig',
            '/tmp/operator-kubeconfig',
            '--token',
            'issued-service-account-token',
            'create',
            '--filename',
            '-',
          ],
          '{}',
        ),
        /TENANT_CUTOVER_KUBECTL_CREATE_FORBIDDEN/,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the safe prerequisite object type for forbidden creates', () => {
    assert.deepEqual(
      [
        { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview' },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
      ].map((object) =>
        helmTenantCutover.commandFailureCode(
          'kubectl',
          ['create', '--filename', '-'],
          JSON.stringify(object),
          'Error from server (Forbidden): forbidden',
        ),
      ),
      [
        'TENANT_CUTOVER_KUBECTL_CREATE_SELF_SUBJECT_ACCESS_REVIEW_FORBIDDEN',
        'TENANT_CUTOVER_KUBECTL_CREATE_NETWORK_POLICY_FORBIDDEN',
      ],
    );
  });

  it('accepts kubectl auth can-i denial as a structured negative result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-can-i-denial-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      ['#!/usr/bin/env node', "process.stdout.write('no\\n');", 'process.exitCode = 1;'].join('\n'),
      { mode: 0o700 },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      assert.equal(
        await helmTenantCutover.defaultCommand('kubectl', ['auth', 'can-i', 'get', 'pods']),
        'no\n',
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an auth can-i warning when the authorization result is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-can-i-warning-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "process.stdout.write('no\\n');",
        "process.stderr.write('Warning: using configured namespace\\n');",
        'process.exitCode = 1;',
      ].join('\n'),
      { mode: 0o700 },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      assert.equal(
        await helmTenantCutover.defaultCommand('kubectl', ['auth', 'can-i', 'get', 'pods']),
        'no\n',
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed kubectl auth can-i output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-can-i-invalid-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      ['#!/usr/bin/env node', "process.stdout.write('maybe\\n');"].join('\n'),
      {
        mode: 0o700,
      },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      await assert.rejects(
        () => helmTenantCutover.defaultCommand('kubectl', ['auth', 'can-i', 'get', 'pods']),
        /TENANT_CUTOVER_KUBECTL_AUTH_CAN_I_FAILED/,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses bounded trusted timeout policies for long-running Helm operations', () => {
    const timeout = (
      helmTenantCutover as typeof helmTenantCutover & {
        commandExecutionTimeoutMs?: (policy: string) => number;
      }
    ).commandExecutionTimeoutMs;
    assert.equal(typeof timeout, 'function');
    assert.equal(timeout!('standard'), 60_000);
    assert.ok(timeout!('owner_job_wait') > 5 * 60_000);
    assert.ok(timeout!('helm_rollout') > 10 * 60_000);
    assert.ok(timeout!('proof_job_wait') > 10 * 60_000);
    assert.ok(timeout!('helm_rollout') <= 11 * 60_000);
    assert.throws(
      () => timeout!('caller-supplied'),
      /TENANT_CUTOVER_COMMAND_TIMEOUT_POLICY_INVALID/,
    );
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    it(
      'fails closed when kubectl logs ' + stream + ' exceeds the command output limit',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'commander-helm-command-output-'));
        const kubectl = join(root, 'kubectl');
        const previousPath = process.env.PATH;
        const writer = stream === 'stdout' ? 'process.stdout.write' : 'process.stderr.write';
        await writeFile(
          kubectl,
          ['#!/usr/bin/env node', writer + "('x'.repeat(" + (commandOutputLimit + 1) + '));'].join(
            '\n',
          ),
          { mode: 0o700 },
        );
        await chmod(kubectl, 0o700);
        process.env.PATH = root + (previousPath ? ':' + previousPath : '');
        try {
          const command = (
            helmTenantCutover as typeof helmTenantCutover & {
              defaultCommand?: (program: string, args: readonly string[]) => Promise<string>;
            }
          ).defaultCommand;
          assert.equal(typeof command, 'function');
          await assert.rejects(
            () => command!('kubectl', ['logs', 'owner-job']),
            /TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT/,
          );
        } finally {
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }

  it('terminates the process group before rejecting an output overflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-command-group-'));
    const kubectl = join(root, 'kubectl');
    const descendantPidPath = join(root, 'descendant.pid');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "const { spawn: launch } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = launch(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
        'writeFileSync(' + JSON.stringify(descendantPidPath) + ', String(child.pid));',
        "child.stdout.once('data', () => process.stdout.write('x'.repeat(" +
          (commandOutputLimit + 1) +
          ')));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(kubectl, 0o700);
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    let descendantPid: number | undefined;
    try {
      await assert.rejects(
        () => helmTenantCutover.defaultCommand('kubectl', ['get', 'pods']),
        /TENANT_CUTOVER_COMMAND_OUTPUT_LIMIT/,
      );
      descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid!, 0), /ESRCH/);
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The expected path already terminated the descendant.
        }
      }
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed with a bounded code when process-group confirmation is EPERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-command-eperm-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    const originalKill = process.kill;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "process.stdout.write('x'.repeat(" + (commandOutputLimit + 1) + '));',
      ].join('\n'),
      { mode: 0o700 },
    );
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      await assert.rejects(
        () => helmTenantCutover.defaultCommand('kubectl', ['get', 'pods']),
        /TENANT_CUTOVER_COMMAND_TERMINATION_UNCONFIRMED/,
      );
    } finally {
      process.kill = originalKill;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains a sanitized error code and hash without reflecting owner Job logs', () => {
    const diagnostic = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobFailureDiagnostic?: (logs: string) => string;
      }
    ).ownerJobFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const logs = [
      'Migration failed: COMMANDER_MIGRATION_FAILED',
      'owner-job-opaque-marker-4820',
      'second-opaque-marker-9157',
    ].join('\n');
    const result = diagnostic!(logs);

    assert.match(
      result,
      /^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /opaque-marker-4820|opaque-marker-9157/);
  });

  it('retains only the canonical migration identifier, phase, and SQLSTATE', () => {
    const diagnostic = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobFailureDiagnostic?: (logs: string) => string;
      }
    ).ownerJobFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const result = diagnostic!(
      [
        'postgres://owner:secret@postgres/commander SELECT private_value',
        'Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;catalog_step=functions;migration=2026-07-27.3.task1_authenticated_tenant_authority_enforce;phase=enforce;sqlstate=42P01',
        'owner-job-opaque-marker-4820',
      ].join('\n'),
    );

    assert.match(
      result,
      /^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;catalog_step=functions;migration=2026-07-27\.3\.task1_authenticated_tenant_authority_enforce;phase=enforce;sqlstate=42P01;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value|opaque-marker-4820/i);
  });

  it('retains only the canonical rollout proof failure location', () => {
    const diagnostic = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobFailureDiagnostic?: (logs: string) => string;
      }
    ).ownerJobFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const result = diagnostic!(
      [
        'postgres://owner:secret@postgres/commander private proof detail',
        'COMMANDER_MIGRATION_FAILED;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver.ts:1012:7',
      ].join('\n'),
    );

    assert.match(
      result,
      /^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver\.ts:1012:7;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /postgres:|secret|private proof detail/i);
  });

  it('does not retain malformed rollout proof diagnostics', () => {
    const diagnostic = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobFailureDiagnostic?: (logs: string) => string;
      }
    ).ownerJobFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const result = diagnostic!(
      'COMMANDER_MIGRATION_FAILED;owner_stage=rollout_proof;proof_code=PRIVATE_PROOF_CODE;proof_invariant=task1KubernetesProofObserver.ts:0:0',
    );

    assert.match(
      result,
      /^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /PRIVATE_PROOF_CODE|proof_invariant/);
  });

  for (const ownerStage of [
    'lifecycle_pinned_manifest_validation',
    'lifecycle_prepared_request_validation',
    'lifecycle_table_discovery',
    'lifecycle_initialization_planning',
    'lifecycle_descriptor_transaction',
    'lifecycle_peer_reobservation',
    'lifecycle_peer_reobservation_input_consistency',
    'lifecycle_peer_reobservation_candidate_binding_validation',
    'lifecycle_peer_reobservation_observed_binding_validation',
    'lifecycle_peer_reobservation_binding_consistency',
  ] as const) {
    it(`retains the fixed ${ownerStage} boundary without owner Job logs`, () => {
      const diagnostic = (
        helmTenantCutover as typeof helmTenantCutover & {
          ownerJobFailureDiagnostic?: (logs: string) => string;
        }
      ).ownerJobFailureDiagnostic;
      assert.equal(typeof diagnostic, 'function');

      const result = diagnostic!(
        [
          'postgres://owner:secret@postgres/commander SELECT private_value',
          'Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=' + ownerStage,
          'owner-job-opaque-marker-4820',
        ].join('\n'),
      );

      assert.match(
        result,
        new RegExp(
          '^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=' +
            ownerStage +
            ';log_sha256=[a-f0-9]{64}$',
        ),
      );
      assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value|opaque-marker-4820/i);
    });
  }

  for (const snapshotTransaction of ['begin', 'commit'] as const) {
    it(`retains only the fixed ${snapshotTransaction} snapshot transaction discriminator`, () => {
      const diagnostic = (
        helmTenantCutover as typeof helmTenantCutover & {
          ownerJobFailureDiagnostic?: (logs: string) => string;
        }
      ).ownerJobFailureDiagnostic;
      assert.equal(typeof diagnostic, 'function');

      const result = diagnostic!(
        [
          'postgres://owner:secret@postgres/commander SELECT private_value',
          'Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_transaction=' +
            snapshotTransaction,
          'owner-job-opaque-marker-4820',
        ].join('\n'),
      );

      assert.match(
        result,
        new RegExp(
          '^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_transaction=' +
            snapshotTransaction +
            ';log_sha256=[a-f0-9]{64}$',
        ),
      );
      assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value|opaque-marker-4820/i);
    });
  }

  for (const snapshotValidation of [
    'bootstrap_validation',
    'identity_validation',
    'product_source_validation',
    'catalog_version_validation',
    'origin_classification',
  ] as const) {
    it(`retains only the fixed ${snapshotValidation} snapshot validation`, () => {
      const diagnostic = (
        helmTenantCutover as typeof helmTenantCutover & {
          ownerJobFailureDiagnostic?: (logs: string) => string;
        }
      ).ownerJobFailureDiagnostic;
      assert.equal(typeof diagnostic, 'function');

      const result = diagnostic!(
        [
          'postgres://owner:secret@postgres/commander SELECT private_value',
          'Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=' +
            snapshotValidation,
          'owner-job-opaque-marker-4820',
        ].join('\n'),
      );

      assert.match(
        result,
        new RegExp(
          '^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=' +
            snapshotValidation +
            ';log_sha256=[a-f0-9]{64}$',
        ),
      );
      assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value|opaque-marker-4820/i);
    });
  }

  for (const originClassificationStep of [
    'fresh_catalog_shape',
    'role_envelope',
    'role_attributes',
    'memberships',
    'public_acl',
  ] as const) {
    it(`retains only the fixed ${originClassificationStep} origin classification step`, () => {
      const diagnostic = (
        helmTenantCutover as typeof helmTenantCutover & {
          ownerJobFailureDiagnostic?: (logs: string) => string;
        }
      ).ownerJobFailureDiagnostic;
      assert.equal(typeof diagnostic, 'function');

      const result = diagnostic!(
        [
          'postgres://owner:secret@postgres/commander SELECT private_value',
          'Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=origin_classification;origin_classification_step=' +
            originClassificationStep,
          'owner-job-opaque-marker-4820',
        ].join('\n'),
      );

      assert.match(
        result,
        new RegExp(
          '^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=origin_classification;origin_classification_step=' +
            originClassificationStep +
            ';log_sha256=[a-f0-9]{64}$',
        ),
      );
      assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value|opaque-marker-4820/i);
    });
  }

  it('marks unavailable owner Job logs with a fixed transport discriminator', () => {
    const diagnostic = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobFailureDiagnostic?: (
          logs: string,
          transport?: 'kubectl_logs' | 'kubectl_logs_unavailable',
        ) => string;
      }
    ).ownerJobFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');
    assert.match(
      diagnostic!('TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE', 'kubectl_logs_unavailable'),
      /^code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=[a-f0-9]{64}$/,
    );
  });

  it('classifies an owner Job that created no Pod without retaining Pod output', () => {
    const classify = (
      helmTenantCutover as typeof helmTenantCutover & {
        ownerJobPodFailureCode?: (value: string) => string;
      }
    ).ownerJobPodFailureCode;
    assert.equal(typeof classify, 'function');

    const result = classify!(
      JSON.stringify({
        items: [],
        privateDiagnostic: 'postgres://owner:secret@postgres/commander',
      }),
    );

    assert.equal(result, 'TENANT_CUTOVER_OWNER_JOB_POD_UNAVAILABLE');
    assert.doesNotMatch(result, /postgres|secret|private/i);
  });

  it('carries a safe owner diagnostic from kubectl stderr through the real command boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-owner-transport-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const input = fs.readFileSync(0, 'utf8');",
        'const action = process.argv[2];',
        "if (action === 'create') {",
        '  const object = JSON.parse(input);',
        "  process.stdout.write((object.kind === 'ConfigMap' ? 'configmap/' : 'job.batch/') + object.metadata.name);",
        "} else if (action === 'wait') {",
        '  process.exitCode = 1;',
        "} else if (action === 'logs') {",
        "  process.stderr.write('Migration failed: COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_initialize;migration=2026-07-27.3.task1_authenticated_tenant_authority_enforce;phase=enforce;sqlstate=42P01\\n');",
        '}',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(kubectl, 0o700);
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      const ports = helmTenantCutover.createNodePorts();
      await assert.rejects(
        () =>
          ports.owner.plan(
            {},
            {
              namespace: 'commander',
              release: 'commander',
              image: 'registry.example/commander@' + image,
              databaseSecretName: 'commander-database',
              databaseSecretKeys: {
                owner: 'owner-url',
                app: 'app-url',
                tenantAuthority: 'tenant-authority-url',
                scheduler: 'scheduler-url',
                worker: 'worker-url',
                adapterOps: 'adapter-ops-url',
              },
              databaseTls: {
                secretName: 'commander-database-tls',
                caKey: 'ca.crt',
                expectedServerSpkiSha256: digest('c'),
              },
              proofCertificate: {
                secretName: 'commander-api-proof',
                caKey: 'ca.crt',
                certKey: 'tls.crt',
              },
              bootstrap: { kind: 'none' },
            },
          ),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(
            message,
            /TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;migration=2026-07-27\.3\.task1_authenticated_tenant_authority_enforce;phase=enforce;sqlstate=42P01;log_sha256=[a-f0-9]{64}/,
          );
          assert.doesNotMatch(message, /postgres:|secret|SELECT/i);
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures an unavailable owner Pod when owner Job logs cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-owner-pod-'));
    const kubectl = join(root, 'kubectl');
    const previousPath = process.env.PATH;
    await writeFile(
      kubectl,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const input = fs.readFileSync(0, 'utf8');",
        'const action = process.argv[2];',
        "if (action === 'create') {",
        '  const object = JSON.parse(input);',
        "  process.stdout.write((object.kind === 'ConfigMap' ? 'configmap/' : 'job.batch/') + object.metadata.name);",
        "} else if (action === 'wait' || action === 'logs') {",
        '  process.exitCode = 1;',
        "} else if (action === 'get' && process.argv[3] === 'pods') {",
        '  process.stdout.write(JSON.stringify({ items: [] }));',
        '}',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(kubectl, 0o700);
    process.env.PATH = root + (previousPath ? ':' + previousPath : '');
    try {
      const ports = helmTenantCutover.createNodePorts();
      await assert.rejects(
        () =>
          ports.owner.plan(
            {},
            {
              namespace: 'commander',
              release: 'commander',
              image: 'registry.example/commander@' + image,
              databaseSecretName: 'commander-database',
              databaseSecretKeys: {
                owner: 'owner-url',
                app: 'app-url',
                tenantAuthority: 'tenant-authority-url',
                scheduler: 'scheduler-url',
                worker: 'worker-url',
                adapterOps: 'adapter-ops-url',
              },
              databaseTls: {
                secretName: 'commander-database-tls',
                caKey: 'ca.crt',
                expectedServerSpkiSha256: digest('c'),
              },
              proofCertificate: {
                secretName: 'commander-api-proof',
                caKey: 'ca.crt',
                certKey: 'tls.crt',
              },
              bootstrap: { kind: 'none' },
            },
          ),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(
            message,
            /TENANT_CUTOVER_OWNER_JOB_FAILED:code=TENANT_CUTOVER_OWNER_JOB_POD_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=[a-f0-9]{64}/,
          );
          assert.doesNotMatch(message, /items|pods|secret|private/i);
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps owner Job failure diagnostics free of new scanner high findings', async () => {
    const source = await readFile(new URL('./helm-tenant-cutover.ts', import.meta.url), 'utf8');
    const diagnosticStart = source.indexOf('export function ownerJobFailureDiagnostic');
    const diagnosticEnd = source.indexOf('function phase', diagnosticStart);
    const waitStart = source.indexOf('try {', source.indexOf('if (createdJob !=='));
    const waitEnd = source.indexOf('const output =', waitStart);
    assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart);
    assert.ok(waitStart >= 0 && waitEnd > waitStart);

    const warnings = new SupplyChainScanner({ auditAllScans: false })
      .scan({
        name: 'scripts/helm-tenant-cutover.ts',
        content: source.slice(diagnosticStart, diagnosticEnd) + source.slice(waitStart, waitEnd),
        tools: [],
      })
      .warnings.filter((warning) => warning.severity === 'high');

    assert.deepEqual(warnings, []);
  });
});

function objectIdentity(kind: string, name: string): HelmReleaseObjectIdentity {
  return { apiVersion: kind === 'Secret' ? 'v1' : 'apps/v1', kind, namespace: 'commander', name };
}

function releaseProjection(
  revision: string,
  objects: readonly HelmReleaseObjectIdentity[] = [objectIdentity('Deployment', 'commander-api')],
): HelmReleaseProjection {
  return {
    format: 'helm-release-projection/v1',
    namespace: 'commander',
    releaseName: 'commander',
    revision,
    chartContentSha256: chart,
    objects: objects.map((identity) => ({
      identity,
      comparator:
        identity.kind === 'Secret'
          ? {
              format: 'kubernetes-field-comparator/v1',
              metadata: { name: identity.name },
              type: 'Opaque',
              immutable: true,
              dataKeys: ['owner-url'],
            }
          : {
              format: 'kubernetes-field-comparator/v1',
              desired: { metadata: { name: identity.name } },
            },
      secretReferences: [],
    })),
    hooks: [
      {
        identity: {
          apiVersion: 'batch/v1',
          kind: 'Job',
          namespace: 'commander',
          name: `commander-tenant-cutover-prove-r${revision}`,
        },
        deletePolicies: ['before-hook-creation', 'hook-succeeded'],
      },
    ],
    rendererInput: {
      format: 'helm-renderer-input-projection/v1',
      values: {
        image: {
          repository: 'ghcr.io/commander/api',
          digest: image,
          pullPolicy: 'IfNotPresent',
        },
        database: {
          enabled: true,
          backend: 'postgres',
          postgres: {
            bundled: false,
            ownerSecretKey: 'owner-url',
          },
        },
        databaseTls: {
          existingSecret: '',
          caSecret: 'database-ca',
          caKey: 'ca.crt',
          expectedServerSpkiSha256: digest('d'),
        },
        migration: {
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 300,
          terminationGracePeriodSeconds: 30,
        },
        tenantAuthority: {
          chartContentSha256: chart,
          apiProof: {
            publicSecret: 'api-proof-public',
            caKey: 'ca.crt',
            certKey: 'tls.crt',
          },
        },
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
      },
      secretReferences: [],
    },
  };
}

function operation(overrides: Partial<HelmOperation> = {}): HelmOperation {
  const businessConfiguration = {
    valuesSha256: digest('c'),
    secretFileMappings: {
      databaseOwner: { secretName: 'commander-database', secretKey: 'owner-url' },
    },
  };
  const configuration = { ...businessConfiguration, operationAuditNonce: nonce };
  return {
    operationVersion: '7',
    operationKind: 'enforce',
    phase: 'enforce',
    platformBinding: {
      kind: 'helm',
      namespace: 'commander',
      releaseName: 'commander',
      chartContentSha256: chart,
      phase: 'enforce',
      apiImageDigest: image,
    },
    businessConfiguration,
    configuration,
    configurationSha256: canonicalBootstrapSha256(configuration),
    proven: false,
    ...overrides,
  };
}

function retainedProofJobManifest(revision: string): string {
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: commander-tenant-cutover-prove-r${revision}
  labels:
    app.kubernetes.io/name: commander
    app.kubernetes.io/instance: commander
    app.kubernetes.io/version: 0.2.0
    app.kubernetes.io/managed-by: Helm
    helm.sh/chart: commander-0.2.0
    commander.io/tenant-authority-proof-reader: "true"
    commander.io/tenant-authority-proof-release: commander
  annotations:
    helm.sh/hook: post-install,post-upgrade
    helm.sh/hook-weight: "10"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 600
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: commander
        app.kubernetes.io/instance: commander
        commander.io/tenant-authority-proof-reader: "true"
        commander.io/tenant-authority-proof-release: commander
    spec:
      serviceAccountName: commander-proof-reader-${createHash('sha256').update('commander/commander').digest('hex').slice(0, 16)}
      automountServiceAccountToken: false
      restartPolicy: Never
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: tenant-cutover-prove
          image: ghcr.io/commander/api@${image}
          imagePullPolicy: IfNotPresent
          command: ["node", "packages/kernel/dist/migrate.js", "tenant-cutover-prove"]
          env:
            - { name: COMMANDER_KUBERNETES_PROOF_RUNTIME, value: "1" }
            - name: COMMANDER_OWNER_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: commander-proof-owner-v7
                  key: owner-url
            - { name: COMMANDER_DATABASE_TLS_CA_FILE, value: /run/commander/database-tls/ca.crt }
            - { name: COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256, value: ${digest('d')} }
            - { name: COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE, value: /run/commander/api-proof-public/ca.crt }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: proof-api-token, mountPath: /var/run/secrets/commander.io/proof-api, readOnly: true }
            - { name: database-public-ca, mountPath: /run/commander/database-tls, readOnly: true }
            - { name: api-proof-public, mountPath: /run/commander/api-proof-public, readOnly: true }
            - { name: release-projection, mountPath: /run/commander/release-projection, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: proof-api-token
          projected:
            defaultMode: 256
            sources:
              - serviceAccountToken:
                  audience: commander-tenant-cutover-proof/v1
                  expirationSeconds: 600
                  path: identity-token
              - serviceAccountToken:
                  expirationSeconds: 600
                  path: api-token
              - configMap:
                  name: kube-root-ca.crt
                  items: [{ key: ca.crt, path: ca.crt }]
        - name: database-public-ca
          secret:
            secretName: database-ca
            items: [{ key: ca.crt, path: ca.crt }]
        - name: api-proof-public
          secret:
            secretName: api-proof-public
            items: [{ key: ca.crt, path: ca.crt }, { key: tls.crt, path: tls.crt }]
        - name: release-projection
          configMap:
            name: commander-proof-projection-v7-r${revision}
            defaultMode: 292
            items: [{ key: projection.json, path: projection.json }]
        - name: tmp
          emptyDir: {}
`;
}

function input(command: string = 'enforce') {
  return parseHelmTenantCutoverArgs(
    [
      command,
      '--namespace',
      'commander',
      '--release',
      'commander',
      '--values',
      '/state/values.yaml',
    ],
    '/repo',
  );
}

function ports(
  current: HelmOperation | undefined = undefined,
): HelmCutoverPorts & { calls: string[]; writes: Map<string, string> } {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  return {
    calls,
    writes,
    chartDigest: () => chart,
    readValues: async () => `
image:
  repository: ghcr.io/commander/api
  digest: ${image}
database:
  enabled: true
  backend: postgres
  postgres:
    bundled: false
    existingSecret: commander-database
    ownerSecretKey: owner-url
databaseTls:
  caSecret: database-ca
  caKey: ca.crt
  expectedServerSpkiSha256: ${digest('d')}
tenantAuthority:
  apiProof:
    publicSecret: api-proof-public
    certKey: tls.crt
`,
    createNonce: () => nonce,
    fs: {
      mkdir: async () => undefined,
      writeFileAtomic: async (path, contents) => {
        writes.set(path, contents);
      },
      readFile: async (path) =>
        writes.get(path) ??
        (() => {
          throw new Error('missing');
        })(),
      retainedChartPackage: async (_stateDirectory, _namespace, _release, digestValue) =>
        `/retained/charts/${digestValue}/commander`,
      retainChartPackage: async (_source, _stateDirectory, _namespace, _release, digestValue) =>
        `/retained/charts/${digestValue}/commander`,
    },
    owner: {
      plan: async () =>
        current
          ? { action: current.proven ? 'return_current' : 'retry_rollout', operation: current }
          : { action: 'append' },
      append: async (request) => {
        const prepared = request.prepared as {
          businessConfiguration: Record<string, unknown>;
          configuration: Record<string, unknown> & { operationAuditNonce: string };
          configurationSha256: string;
        };
        return operation({
          businessConfiguration: prepared.businessConfiguration,
          configuration: prepared.configuration,
          configurationSha256: prepared.configurationSha256,
        });
      },
      restore: async () => {
        const projection = releaseProjection('7');
        return operation({
          proven: true,
          restore: {
            revision: '7',
            releaseProjection: projection,
            releaseProjectionSha256: canonicalBootstrapSha256(projection),
          },
        });
      },
    },
    helm: {
      version: async () => {
        calls.push('helm:version --short');
        return 'v3.17.3+g123';
      },
      run: async (args, stdin) => {
        calls.push(`helm:${args.join(' ')}${stdin ? ':stdin' : ''}`);
        return '';
      },
      nextRevision: async () => '10',
      runProjectedRevision: async (request) => {
        calls.push(`helm:${request.args.join(' ')}:projection-r${request.revision}`);
        return releaseProjection(request.revision);
      },
      releaseExists: async () => {
        calls.push('helm:release-exists');
        return false;
      },
      currentRevision: async () => {
        calls.push('helm:current-revision');
        return '9';
      },
      projectRevision: async (_namespace, _release, revision) => {
        calls.push(`helm:project-revision:${revision}`);
        return revision === '7'
          ? releaseProjection('7')
          : releaseProjection('9', [
              objectIdentity('Deployment', 'commander-api'),
              objectIdentity('Secret', 'commander-old'),
            ]);
      },
      proofJobManifest: async (_namespace, _release, revision) => {
        calls.push(`helm:proof-job-manifest:${revision}`);
        return retainedProofJobManifest(revision);
      },
      restoreRevision: async (request) => {
        calls.push(
          `helm:restore-revision:${request.revision}:${request.chart}:${request.args.join(' ')}`,
        );
      },
    },
    kubectl: {
      readSecretValue: async (_namespace, name, key) => {
        if ((name === 'database-ca' || name === 'database-server-tls') && key === 'ca.crt') {
          return Buffer.from('helm-ca-bytes');
        }
        const loginByKey: Record<string, string> = {
          'owner-url': 'commander_owner',
          'app-url': 'commander_app',
          'tenant-authority-url': 'commander_tenant_authority',
          'scheduler-url': 'commander_scheduler',
          'worker-url': 'commander_worker',
          'adapter-ops-url': 'commander_adapter_ops',
        };
        const login = loginByKey[key];
        if (!login) throw new Error('unexpected secret key');
        return Buffer.from(
          `postgres://${login}:secret@db.example:5432/commander?sslmode=verify-full`,
        );
      },
      prepareFreshBundledDatabaseSecret: async (request) => {
        calls.push(
          `prepare-database:${request.namespace}/${request.name}/${request.hostname}/${request.database}`,
        );
      },
      prepareProofOwnerSecret: async (request: {
        namespace: string;
        sourceName: string;
        sourceKey: string;
        targetName: string;
      }) => {
        calls.push(
          `prepare-secret:${request.namespace}/${request.sourceName}/${request.sourceKey}->${request.targetName}`,
        );
      },
      cleanupProofResources: async (namespace: string, release: string) => {
        calls.push(`cleanup-proof:${namespace}/${release}`);
      },
      prepareReleaseProjectionConfigMap: async (request) => {
        calls.push(`prepare-projection:${request.name}:${request.revision}`);
      },
      runProofJob: async (request) => {
        calls.push(`run-proof-job:${request.name}:${request.revision}`);
        return {
          proven: true,
          operationVersion: '7',
          proofSequence: '2',
          proofAttemptId: '11111111-1111-4111-8111-111111111111',
          rolloutProofSha256: digest('9'),
        };
      },
      deleteAndVerifyConfigMap: async (namespace, name) => {
        calls.push(`cleanup-configmap:${namespace}/${name}`);
      },
      captureProofHookFailureDiagnostic: async () =>
        'code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=' +
        digest('f'),
      deleteAndVerifySecret: async (namespace: string, name: string) => {
        calls.push(`cleanup-secret:${namespace}/${name}`);
      },
      verifyCurrentObject: async (object) => {
        calls.push(`verify-current:${object.identity.kind}/${object.identity.name}`);
      },
      readObject: async (identity) => {
        calls.push(`read:${identity.kind}/${identity.name}`);
        if (identity.name !== 'commander-old') return undefined;
        if (calls.some((call) => call.startsWith('delete-object:'))) return undefined;
        return {
          uid: 'old-secret-uid',
          resourceVersion: '77',
          ownerNamespace: 'commander',
          ownerRelease: 'commander',
        };
      },
      deleteObject: async (identity, preconditions) => {
        calls.push(
          `delete-object:${identity.kind}/${identity.name}:${preconditions.uid}:${preconditions.resourceVersion}`,
        );
      },
    },
  };
}

describe('Helm tenant-cutover orchestrator', () => {
  it('persists owner-only local state without requiring root privileges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commander-helm-cutover-state-'));
    const source = join(root, 'source-chart');
    const state = join(root, 'state');
    const ports = createNodePorts({ command: async () => '' });
    try {
      await mkdir(source);
      await writeFile(join(source, 'Chart.yaml'), 'apiVersion: v2\nname: commander\n');

      await ports.fs.mkdir(state);
      const request = join(state, 'request.json');
      await ports.fs.writeFileAtomic(request, '{"schema":"tenant-cutover-request/v1"}\n');
      const partial = join(state, 'commander', 'commander', 'charts', digest('c'), 'commander');
      await mkdir(partial, { recursive: true });
      await writeFile(join(partial, 'partial'), 'incomplete');
      const retained = await ports.fs.retainChartPackage(
        source,
        state,
        'commander',
        'commander',
        digest('c'),
      );

      assert.equal(
        await readFile(join(retained, 'Chart.yaml'), 'utf8'),
        'apiVersion: v2\nname: commander\n',
      );
      assert.equal((await stat(state)).mode & 0o777, 0o700);
      assert.equal((await stat(request)).mode & 0o777, 0o600);
      assert.equal((await stat(retained)).mode & 0o777, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches only the exact private post-renderer invocation', () => {
    assert.deepEqual(
      parsePostRendererInvocation([
        '--tenant-cutover-post-render',
        '/tmp/commander/post-render.sock',
        'a'.repeat(64),
      ]),
      { socketPath: '/tmp/commander/post-render.sock', token: 'a'.repeat(64) },
    );
    for (const args of [
      ['--tenant-cutover-post-render', '/tmp/socket'],
      ['--tenant-cutover-post-render', '/tmp/socket', 'secret'],
      ['--tenant-cutover-post-render', '/tmp/socket', 'a'.repeat(64), 'extra'],
    ]) {
      assert.throws(
        () => parsePostRendererInvocation(args),
        /TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID/,
      );
    }
  });

  it('streams the exact retained revision values and preserves retained Secret bytes', async () => {
    const secret = objectIdentity('Secret', 'commander-runtime');
    const retainedProjection = releaseProjection('7', [secret]);
    const original = Buffer.from('original-secret-bytes');
    const retainedManifest = `
apiVersion: v1
kind: Secret
metadata:
  name: commander-runtime
  namespace: commander
data:
  owner-url: ${original.toString('base64')}
`;
    let streamed = false;

    await streamHelmRevisionRestore(
      {
        namespace: 'commander',
        release: 'commander',
        revision: '7',
        chart: '/retained/chart',
        args: [
          'upgrade',
          'commander',
          '/retained/chart',
          '--namespace',
          'commander',
          '--values',
          '-',
        ],
        retainedProjection,
        targetRevision: '8',
        projectionConfigMapName: 'commander-proof-projection-v7-r8',
        rendererValues: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
      },
      {
        readHelmBounded: async (args, maximumBytes) => {
          assert.deepEqual(args, [
            'get',
            'manifest',
            'commander',
            '--namespace',
            'commander',
            '--revision',
            '7',
          ]);
          assert.equal(maximumBytes, 64 * 1024 * 1024);
          return retainedManifest;
        },
        streamValuesToHelm: async ({ values, helmArgs, postRender }) => {
          streamed = true;
          assert.equal(
            values,
            dump(retainedProjection.rendererInput.values, { noRefs: true, sortKeys: true }),
          );
          assert.deepEqual(helmArgs, [
            'upgrade',
            'commander',
            '/retained/chart',
            '--namespace',
            'commander',
            '--values',
            '-',
          ]);
          const rendered = postRender(`
apiVersion: v1
kind: Secret
metadata:
  name: commander-runtime
  namespace: commander
data:
  owner-url: ${Buffer.from('new-rendered-value').toString('base64')}
`);
          assert.match(rendered, new RegExp(original.toString('base64')));
          assert.doesNotMatch(rendered, /new-rendered-value/);
        },
      },
    );

    assert.equal(streamed, true);
    await assert.rejects(
      () =>
        streamHelmRevisionRestore(
          {
            namespace: 'commander',
            release: 'commander',
            revision: '8',
            chart: '/retained/chart',
            args: [
              'upgrade',
              'commander',
              '/retained/chart',
              '--namespace',
              'commander',
              '--values',
              '-',
            ],
            retainedProjection,
            targetRevision: '9',
            projectionConfigMapName: 'commander-proof-projection-v7-r9',
            rendererValues: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
          },
          {
            readHelmBounded: async () => retainedManifest,
            streamValuesToHelm: async () => undefined,
          },
        ),
      /TENANT_CUTOVER_RESTORE_REQUEST_INVALID/,
    );
  });

  it('rejects missing, extra, or non-Secret post-render substitutions', () => {
    const retainedProjection = releaseProjection('7', [
      objectIdentity('Secret', 'commander-runtime'),
    ]);
    const payloads = extractRetainedSecretPayloads(
      `apiVersion: v1
kind: Secret
metadata: { name: commander-runtime, namespace: commander }
data: { owner-url: c2VjcmV0 }
`,
      retainedProjection,
    );
    assert.throws(
      () =>
        extractRetainedSecretPayloads(
          `apiVersion: v1
kind: Secret
metadata:
  name: commander-runtime
  namespace: commander
  deletionTimestamp: 2026-07-29T00:00:00Z
data: { owner-url: c2VjcmV0 }
`,
          retainedProjection,
        ),
      /TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID/,
    );
    for (const manifest of [
      '',
      `apiVersion: v1
kind: Secret
metadata: { name: commander-runtime, namespace: commander }
data: { owner-url: c2VjcmV0, extra: ZXh0cmE= }
`,
      `apiVersion: v1
kind: Secret
metadata:
  name: commander-runtime
  namespace: commander
  deletionTimestamp: 2026-07-29T00:00:00Z
data: { owner-url: c2VjcmV0 }
`,
      `apiVersion: v1
kind: ConfigMap
metadata: { name: commander-runtime, namespace: commander }
data: { owner-url: c2VjcmV0 }
`,
      `apiVersion: v1
kind: Secret
metadata: { name: commander-runtime, namespace: commander }
data: { owner-url: c2VjcmV0 }
---
apiVersion: v1
kind: Secret
metadata: { name: unexpected, namespace: commander }
data: { owner-url: c2VjcmV0 }
`,
    ]) {
      assert.throws(
        () => postRenderRetainedSecrets(manifest, 'commander', payloads),
        /TENANT_CUTOVER_RESTORE_SECRET_RENDER_INVALID/,
      );
    }
  });

  it('compares every Kubernetes managedFields fieldsV1 selector exactly', () => {
    const desired = {
      metadata: { labels: { app: 'commander' } },
      spec: {
        items: [
          { name: 'api', value: 3 },
          { name: 'worker', value: 4 },
        ],
        tags: ['blue', 'green'],
        ordered: [{ value: 'first' }, { value: 'second' }],
      },
    };
    const fieldsV1 = {
      'f:metadata': { 'f:labels': { 'f:app': {} } },
      'f:spec': {
        'f:items': { 'k:{\"name\":\"api\"}': { '.': {}, 'f:value': {} } },
        'f:tags': { 'v:\"blue\"': {} },
        'f:ordered': { 'i:1': { 'f:value': {} } },
      },
    };
    assert.doesNotThrow(() =>
      assertManagedFieldsMatch(fieldsV1, desired, structuredClone(desired)),
    );
    const drifted = structuredClone(desired);
    drifted.spec.ordered[1]!.value = 'drifted';
    assert.throws(
      () => assertManagedFieldsMatch(fieldsV1, desired, drifted),
      /TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH/,
    );
  });

  it('uses strict forced SSA and UID/resourceVersion-preconditioned raw deletion', async () => {
    const commands: { args: readonly string[]; stdin?: string }[] = [];
    const nodePorts = createNodePorts({
      command: async (_program, args, stdin) => {
        commands.push({ args, stdin });
        if (args[0] === 'version') {
          return JSON.stringify({ serverVersion: { gitVersion: 'v1.33.2' } });
        }
        if (args[0] === 'get' && args[1] === '--filename') {
          return JSON.stringify({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
              name: 'commander-api',
              namespace: 'commander',
              uid: 'deployment-uid',
              resourceVersion: '77',
              annotations: {
                'meta.helm.sh/release-name': 'commander',
                'meta.helm.sh/release-namespace': 'commander',
              },
            },
            spec: { replicas: 1 },
          });
        }
        if (args[0] === 'apply') {
          const manager = args.find((arg) => arg.startsWith('--field-manager='))?.slice(16);
          assert.ok(manager);
          return JSON.stringify({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
              name: 'commander-api',
              namespace: 'commander',
              managedFields: [
                {
                  manager,
                  operation: 'Apply',
                  fieldsType: 'FieldsV1',
                  fieldsV1: { 'f:spec': { 'f:replicas': {} } },
                },
              ],
            },
            spec: { replicas: 1 },
          });
        }
        if (args[0] === 'get' && args[1] === '--raw') {
          return JSON.stringify({
            groupVersion: 'apps/v1',
            resources: [
              {
                name: 'deployments',
                kind: 'Deployment',
                namespaced: true,
                verbs: ['get', 'delete'],
              },
            ],
          });
        }
        if (args[0] === 'delete') return '{}';
        throw new Error('unexpected kubectl call');
      },
    });
    const deployment = releaseProjection('7').objects[0]!;
    await nodePorts.kubectl.verifyCurrentObject(deployment);
    const live = await nodePorts.kubectl.readObject(deployment.identity);
    assert.deepEqual(live, {
      uid: 'deployment-uid',
      resourceVersion: '77',
      ownerNamespace: 'commander',
      ownerRelease: 'commander',
    });
    await nodePorts.kubectl.deleteObject(deployment.identity, {
      uid: live!.uid,
      resourceVersion: live!.resourceVersion,
    });

    const apply = commands.find((call) => call.args[0] === 'apply')!;
    assert.equal(apply.args.includes('--server-side'), true);
    assert.equal(apply.args.includes('--dry-run=server'), true);
    assert.equal(apply.args.includes('--validate=strict'), true);
    assert.equal(apply.args.includes('--force-conflicts'), true);
    assert.equal(apply.args.includes('--show-managed-fields=true'), true);
    assert.equal(
      apply.args.some((arg) => arg.startsWith('--field-manager=commander-restore-')),
      true,
    );
    const deletion = commands.find((call) => call.args[0] === 'delete')!;
    assert.deepEqual(deletion.args, [
      'delete',
      '--raw',
      '/apis/apps/v1/namespaces/commander/deployments/commander-api',
      '--filename',
      '-',
    ]);
    assert.deepEqual(JSON.parse(deletion.stdin!), {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: 'deployment-uid', resourceVersion: '77' },
    });
    await assert.rejects(
      () =>
        nodePorts.kubectl.deleteObject(deployment.identity, {
          uid: '',
          resourceVersion: '77',
        }),
      /TENANT_CUTOVER_RESTORE_OBJECT_PRECONDITION_INVALID/,
    );
  });

  it('reads an exact retained proof hook and creates the proof-only Kubernetes resources', async () => {
    const commands: Array<{
      program: string;
      args: readonly string[];
      stdin?: string;
      executionPolicy?: string;
    }> = [];
    let configMap = '';
    const receipt = {
      proven: true,
      operationVersion: '7',
      proofSequence: '2',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      rolloutProofSha256: digest('9'),
    };
    const nodePorts = createNodePorts({
      command: async (program, args, stdin, executionPolicy) => {
        commands.push({ program, args, stdin, executionPolicy });
        if (program === 'helm') return retainedProofJobManifest('7');
        if (args[0] === 'create') {
          const object = JSON.parse(stdin!) as { kind: string; metadata: { name: string } };
          if (object.kind === 'ConfigMap') {
            configMap = stdin!;
            return `configmap/${object.metadata.name}`;
          }
          return `job.batch/${object.metadata.name}`;
        }
        if (args[0] === 'get' && args[1] === 'configmap') return configMap;
        if (args[0] === 'delete' && args[1] === 'configmap') {
          configMap = '';
          return '';
        }
        if (args[0] === 'wait') return '';
        if (args[0] === 'logs') return JSON.stringify(receipt);
        throw new Error(`unexpected command: ${program} ${args.join(' ')}`);
      },
    });
    const projection = releaseProjection('7');
    const name = 'commander-proof-projection-v7-r7';

    const manifest = await nodePorts.helm.proofJobManifest('commander', 'commander', '7');
    await nodePorts.kubectl.prepareReleaseProjectionConfigMap({
      namespace: 'commander',
      release: 'commander',
      revision: '7',
      name,
      projection,
    });
    assert.deepEqual(
      await nodePorts.kubectl.runProofJob({
        namespace: 'commander',
        name: 'commander-tenant-cutover-prove-r7',
        revision: '7',
        manifest: canonicalBootstrapJson(load(manifest)),
      }),
      receipt,
    );
    await nodePorts.kubectl.deleteAndVerifyConfigMap('commander', name);

    assert.deepEqual(commands[0], {
      program: 'helm',
      args: ['get', 'hooks', 'commander', '--namespace', 'commander', '--revision', '7'],
      stdin: undefined,
      executionPolicy: undefined,
    });
    assert.deepEqual(commands.find((call) => call.args[0] === 'wait')?.args, [
      'wait',
      '--for=condition=complete',
      'job/commander-tenant-cutover-prove-r7',
      '--namespace',
      'commander',
      '--timeout=10m',
    ]);
    assert.equal(
      commands.find((call) => call.args[0] === 'wait')?.executionPolicy,
      'proof_job_wait',
    );
    const jobCreate = commands.find(
      (call) => call.args[0] === 'create' && JSON.parse(call.stdin!).kind === 'Job',
    );
    assert.deepEqual(jobCreate?.args, [
      'create',
      '--filename',
      '-',
      '--namespace',
      'commander',
      '--output',
      'name',
    ]);
    assert.equal(
      commands.some(
        (call) =>
          call.program === 'helm' &&
          ['install', 'upgrade', 'rollback'].includes(call.args[0] ?? ''),
      ),
      false,
    );
  });

  it('carries a sanitized diagnostic when the proof Job fails', async () => {
    const commands: Array<{ args: readonly string[] }> = [];
    const nodePorts = createNodePorts({
      command: async (_program, args) => {
        commands.push({ args });
        if (args[0] === 'create') return 'job.batch/commander-tenant-cutover-prove-r7';
        if (args[0] === 'wait') throw new Error('TENANT_CUTOVER_KUBECTL_COMMAND_FAILED');
        if (args[0] === 'logs') {
          return [
            'postgres://owner:secret@postgres/commander private proof detail',
            'COMMANDER_MIGRATION_FAILED;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver.js:812:9',
          ].join('\n');
        }
        throw new Error('unexpected kubectl call');
      },
    });

    await assert.rejects(
      () =>
        nodePorts.kubectl.runProofJob({
          namespace: 'commander',
          name: 'commander-tenant-cutover-prove-r7',
          revision: '7',
          manifest: '{}',
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(
          message,
          /TENANT_CUTOVER_PROOF_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver\.js:812:9;log_sha256=[a-f0-9]{64}/,
        );
        assert.doesNotMatch(message, /postgres:|secret|private proof detail/i);
        return true;
      },
    );
    assert.deepEqual(commands.find((call) => call.args[0] === 'logs')?.args, [
      'logs',
      'job/commander-tenant-cutover-prove-r7',
      '--namespace',
      'commander',
      '--tail=40',
    ]);
  });

  it('captures a failed Helm proof hook through the release-scoped selector', async () => {
    const commands: Array<{ args: readonly string[] }> = [];
    const nodePorts = createNodePorts({
      command: async (_program, args) => {
        commands.push({ args });
        if (args[0] === 'get' && args[1] === 'jobs') {
          if (
            args[3] === 'app.kubernetes.io/instance=commander,app.kubernetes.io/component=migration'
          ) {
            return '';
          }
          if (
            args[3] ===
            'commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=commander'
          ) {
            return 'commander-tenant-cutover-prove-r10';
          }
          throw new Error(`unexpected selector: ${args[3]}`);
        }
        if (args[0] === 'logs') {
          return [
            'postgres://owner:secret@postgres/commander private proof detail',
            'COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_initialize',
          ].join('\n');
        }
        throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
      },
    });

    const result = await nodePorts.kubectl.captureProofHookFailureDiagnostic(
      'commander',
      'commander',
    );

    assert.match(
      result,
      /^code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /postgres:|secret|private proof detail/i);
    assert.deepEqual(commands[0]?.args, [
      'get',
      'jobs',
      '--selector',
      'app.kubernetes.io/instance=commander,app.kubernetes.io/component=migration',
      '--namespace',
      'commander',
      '--output',
      'jsonpath={.items[*].metadata.name}',
    ]);
    assert.deepEqual(commands[1]?.args, [
      'get',
      'jobs',
      '--selector',
      'commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=commander',
      '--namespace',
      'commander',
      '--output',
      'jsonpath={.items[*].metadata.name}',
    ]);
    assert.deepEqual(commands[2]?.args, [
      'logs',
      'job/commander-tenant-cutover-prove-r10',
      '--namespace',
      'commander',
      '--tail=40',
    ]);
  });

  it('classifies an unavailable Pod when a failed Helm proof hook has no readable logs', async () => {
    const commands: Array<{ args: readonly string[] }> = [];
    const nodePorts = createNodePorts({
      command: async (_program, args) => {
        commands.push({ args });
        if (args[0] === 'get' && args[1] === 'jobs') {
          if (
            args[3] === 'app.kubernetes.io/instance=commander,app.kubernetes.io/component=migration'
          ) {
            return '';
          }
          if (
            args[3] ===
            'commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=commander'
          ) {
            return 'commander-tenant-cutover-prove-r10';
          }
          throw new Error(`unexpected selector: ${args[3]}`);
        }
        if (args[0] === 'logs') {
          throw new Error('TENANT_CUTOVER_KUBECTL_COMMAND_FAILED');
        }
        if (args[0] === 'get' && args[1] === 'pods') {
          return JSON.stringify({
            items: [],
            privateDiagnostic: 'postgres://owner:secret@postgres/commander',
          });
        }
        throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
      },
    });

    const result = await nodePorts.kubectl.captureProofHookFailureDiagnostic(
      'commander',
      'commander',
    );

    assert.match(
      result,
      /^code=TENANT_CUTOVER_PROOF_HOOK_POD_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /items|pods|postgres:|secret|private/i);
    assert.deepEqual(commands[3]?.args, [
      'get',
      'pods',
      '--selector',
      'commander.io/tenant-authority-proof-reader=true,commander.io/tenant-authority-proof-release=commander',
      '--namespace',
      'commander',
      '--output',
      'json',
    ]);
  });

  it('classifies an unavailable Pod for a failed Helm migration hook before the proof hook', async () => {
    const commands: Array<{ args: readonly string[] }> = [];
    const nodePorts = createNodePorts({
      command: async (_program, args) => {
        commands.push({ args });
        if (args[0] === 'get' && args[1] === 'jobs') {
          if (
            args[3] === 'app.kubernetes.io/instance=commander,app.kubernetes.io/component=migration'
          ) {
            return 'commander-migration-r10';
          }
          throw new Error(`unexpected selector: ${args[3]}`);
        }
        if (args[0] === 'logs') {
          throw new Error('TENANT_CUTOVER_KUBECTL_COMMAND_FAILED');
        }
        if (args[0] === 'get' && args[1] === 'pods') {
          return JSON.stringify({
            items: [],
            privateDiagnostic: 'postgres://owner:secret@postgres/commander',
          });
        }
        throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
      },
    });

    const result = await nodePorts.kubectl.captureProofHookFailureDiagnostic(
      'commander',
      'commander',
    );

    assert.match(
      result,
      /^code=TENANT_CUTOVER_MIGRATION_HOOK_POD_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /items|pods|postgres:|secret|private/i);
    assert.deepEqual(commands[0]?.args, [
      'get',
      'jobs',
      '--selector',
      'app.kubernetes.io/instance=commander,app.kubernetes.io/component=migration',
      '--namespace',
      'commander',
      '--output',
      'jsonpath={.items[*].metadata.name}',
    ]);
    assert.deepEqual(commands[2]?.args, [
      'get',
      'pods',
      '--selector',
      'commander.io/migration-client-v2=true,commander.io/migration-release=commander',
      '--namespace',
      'commander',
      '--output',
      'json',
    ]);
  });

  it('compares live Secret payload bytes in memory', async () => {
    const identity = objectIdentity('Secret', 'commander-runtime');
    const retainedProjection = releaseProjection('7', [identity]);
    let livePayload = Buffer.from('retained-bytes').toString('base64');
    const manifest = (payload: string) => `apiVersion: v1
kind: Secret
metadata: { name: commander-runtime, namespace: commander }
type: Opaque
immutable: true
data: { owner-url: ${payload} }
`;
    const nodePorts = createNodePorts({
      command: async (_program, args) => {
        if (args[0] === 'version') {
          return JSON.stringify({ serverVersion: { gitVersion: 'v1.33.2' } });
        }
        if (args[0] === 'get' && args[1] === '--filename') {
          return JSON.stringify({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: identity.name,
              namespace: identity.namespace,
              uid: 'secret-uid',
              resourceVersion: '12',
              annotations: {
                'meta.helm.sh/release-name': 'commander',
                'meta.helm.sh/release-namespace': 'commander',
              },
            },
            type: 'Opaque',
            immutable: true,
            data: { 'owner-url': livePayload },
          });
        }
        throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
      },
      restoreRuntime: {
        readHelmBounded: async () => manifest(livePayload),
        streamValuesToHelm: async ({ postRender }) => {
          postRender(manifest(Buffer.from('new-render').toString('base64')));
        },
      },
    });
    await nodePorts.helm.restoreRevision({
      namespace: 'commander',
      release: 'commander',
      revision: '7',
      chart: '/retained/chart',
      args: [
        'upgrade',
        'commander',
        '/retained/chart',
        '--namespace',
        'commander',
        '--values',
        '-',
      ],
      retainedProjection,
      targetRevision: '8',
      projectionConfigMapName: 'commander-proof-projection-v7-r8',
      rendererValues: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
    });
    await nodePorts.kubectl.verifyCurrentObject(retainedProjection.objects[0]!);
    livePayload = Buffer.from('changed-bytes!').toString('base64');
    await assert.rejects(
      () => nodePorts.kubectl.verifyCurrentObject(retainedProjection.objects[0]!),
      /TENANT_CUTOVER_RESTORE_OBJECT_MISMATCH/,
    );
  });

  it('accepts only the exact immutable stable six-role database Secret', () => {
    const passwords = Object.fromEntries(
      ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops', 'postgres'].map(
        (role) => [role, `${role}-password-0123456789`],
      ),
    );
    const roleLogins = {
      owner: 'commander_owner',
      app: 'commander_app',
      'tenant-authority': 'commander_tenant_authority',
      scheduler: 'commander_scheduler',
      worker: 'commander_worker',
      'adapter-ops': 'commander_adapter_ops',
    } as const;
    const plain = Object.fromEntries([
      ...Object.entries(roleLogins).map(([role, login]) => [
        `${role}-url`,
        `postgres://${login}:${encodeURIComponent(passwords[role]!)}@commander-postgres:5432/commander?sslmode=verify-full`,
      ]),
      ...Object.entries(passwords).map(([role, password]) => [`${role}-password`, password]),
    ]);
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'commander-database-bootstrap',
        namespace: 'commander',
        labels: { 'app.kubernetes.io/managed-by': 'Commander' },
      },
      immutable: true,
      type: 'Opaque',
      data: Object.fromEntries(
        Object.entries(plain).map(([key, value]) => [
          key,
          Buffer.from(value, 'utf8').toString('base64'),
        ]),
      ),
    };
    assert.doesNotThrow(() =>
      validateFreshBundledDatabaseSecret(secret, {
        namespace: 'commander',
        name: 'commander-database-bootstrap',
        hostname: 'commander-postgres',
        port: 5432,
        database: 'commander',
      }),
    );

    for (const mutate of [
      (value: typeof secret) => {
        value.immutable = false;
      },
      (value: typeof secret) => {
        value.metadata.labels.extra = 'unsafe';
      },
      (value: typeof secret) => {
        value.data['owner-url'] = 'not-base64';
      },
      (value: typeof secret) => {
        value.data['app-password'] = value.data['owner-password']!;
        const ownerPassword = Buffer.from(value.data['owner-password']!, 'base64').toString('utf8');
        value.data['app-url'] = Buffer.from(
          `postgres://commander_app:${ownerPassword}@commander-postgres:5432/commander?sslmode=verify-full`,
        ).toString('base64');
      },
      (value: typeof secret) => {
        value.data['worker-url'] = Buffer.from(
          'postgres://commander_worker:worker-password-0123456789@other:5432/commander?sslmode=verify-full',
        ).toString('base64');
      },
    ]) {
      const invalid = structuredClone(secret);
      mutate(invalid);
      assert.throws(
        () =>
          validateFreshBundledDatabaseSecret(invalid, {
            namespace: 'commander',
            name: 'commander-database-bootstrap',
            hostname: 'commander-postgres',
            port: 5432,
            database: 'commander',
          }),
        /TENANT_CUTOVER_DATABASE_SECRET_INVALID/,
      );
    }
  });

  it('accepts only the exact normal and restore CLI grammars', () => {
    assert.equal(input().command, 'enforce');
    assert.deepEqual(
      parseHelmTenantCutoverArgs(
        ['restore-recorded-current', '--namespace', 'commander', '--release', 'commander'],
        '/repo',
      ),
      {
        command: 'restore-recorded-current',
        namespace: 'commander',
        release: 'commander',
        chart: 'deploy/helm/commander',
        stateDirectory: '/repo/.commander/tenant-cutover',
      },
    );
    assert.throws(
      () =>
        parseHelmTenantCutoverArgs(
          ['enforce', '--release', 'commander', '--namespace', 'commander'],
          '/repo',
        ),
      /TENANT_CUTOVER_CLI_ARGUMENT_INVALID/,
    );
    assert.throws(
      () =>
        parseHelmTenantCutoverArgs(
          [
            'restore-recorded-current',
            '--namespace',
            'commander',
            '--release',
            'commander',
            '--values',
            'x',
          ],
          '/repo',
        ),
      /TENANT_CUTOVER_CLI_ARGUMENT_INVALID/,
    );
  });

  it('returns an eligible freshly proven current operation without Helm mutation or artifact writes', async () => {
    const current = operation({ operationKind: 'enforce', proven: true });
    const fixture = ports(current);
    fixture.helm.currentRevision = async () => {
      fixture.calls.push('helm:current-revision');
      return '7';
    };
    const result = await runHelmTenantCutover(input(), fixture);
    assert.equal(result.action, 'returned_current');
    assert.ok(fixture.calls.includes('run-proof-job:commander-tenant-cutover-prove-r7:7'));
    assert.equal(
      fixture.calls.some(
        (call) => call.startsWith('helm:upgrade ') || call.startsWith('helm:restore-revision:'),
      ),
      false,
    );
    assert.equal(fixture.writes.size, 0);
  });

  it('provisions the current release only for a changed enforce append', async () => {
    const fixture = ports();
    const proofRuntimes: Array<{ caKey: string; releaseProjectionConfigMap: string } | undefined> =
      [];
    const plan = fixture.owner.plan;
    const append = fixture.owner.append;
    fixture.owner.plan = async (request, context) => {
      proofRuntimes.push(context.proofRuntime);
      return plan(request, context);
    };
    fixture.owner.append = async (request, context) => {
      proofRuntimes.push(context.proofRuntime);
      return append(request, context);
    };

    await runHelmTenantCutover(input(), fixture);

    assert.deepEqual(proofRuntimes, [
      undefined,
      { caKey: 'ca.crt', releaseProjectionConfigMap: 'commander-owner-proof-current-r9' },
    ]);
    assert.deepEqual(fixture.calls.slice(0, 3), [
      'helm:current-revision',
      'helm:project-revision:9',
      'prepare-projection:commander-owner-proof-current-r9:9',
    ]);
    assert.equal(
      fixture.calls.indexOf('cleanup-configmap:commander/commander-owner-proof-current-r9') <
        fixture.calls.indexOf('helm:version --short'),
      true,
    );
  });

  it('does not provision a current-release proof runtime for an install append', async () => {
    const fixture = ports();
    const readValues = fixture.readValues;
    fixture.readValues = async (path) =>
      (await readValues(path)).replace(
        'tenantAuthority:\n',
        'tenantAuthority:\n  bootstrapAuthoritySecret: commander-bootstrap-authority\n',
      );
    const proofRuntimes: Array<{ caKey: string; releaseProjectionConfigMap: string } | undefined> =
      [];
    const plan = fixture.owner.plan;
    fixture.owner.plan = async (request, context) => {
      proofRuntimes.push(context.proofRuntime);
      return plan(request, context);
    };
    fixture.owner.append = async (request, context) => {
      proofRuntimes.push(context.proofRuntime);
      const prepared = request.prepared as {
        businessConfiguration: Record<string, unknown>;
        configuration: Record<string, unknown> & { operationAuditNonce: string };
        configurationSha256: string;
      };
      return operation({
        operationKind: 'fresh_enforce',
        businessConfiguration: prepared.businessConfiguration,
        configuration: prepared.configuration,
        configurationSha256: prepared.configurationSha256,
      });
    };

    await runHelmTenantCutover(input('install'), fixture);

    assert.deepEqual(proofRuntimes, [undefined, undefined]);
    assert.equal(
      fixture.calls.some((call) => call.startsWith('helm:project-revision:')),
      false,
    );
    assert.equal(
      fixture.calls.some((call) => call.startsWith('prepare-projection:')),
      false,
    );
  });

  it('rejects an owner operation selected for another namespace or release', async () => {
    const current = operation({
      proven: true,
      platformBinding: {
        ...operation().platformBinding,
        namespace: 'other',
        releaseName: 'other',
      },
    });
    const fixture = ports(current);
    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_OWNER_RESPONSE_INVALID/,
    );
    assert.deepEqual(fixture.calls, []);
  });

  it('fails closed before owner planning when a sealed database role DSN is invalid', async () => {
    const fixture = ports();
    const readSecretValue = fixture.kubectl.readSecretValue;
    fixture.kubectl.readSecretValue = async (namespace, name, key) =>
      key === 'owner-url'
        ? Buffer.from('postgres://commander_app:secret@db.example/commander?sslmode=verify-full')
        : readSecretValue(namespace, name, key);
    fixture.owner.plan = async () => {
      throw new Error('invalid peer input must not reach owner planning');
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID/,
    );
  });

  it('persists the nonce-bearing request before fixed cluster-connected Helm rollout', async () => {
    const fixture = ports();
    const result = await runHelmTenantCutover(input(), fixture);
    assert.equal(result.action, 'deployed');
    assert.equal(fixture.writes.size, 1);
    const [path, bytes] = [...fixture.writes][0]!;
    assert.match(path, /\/requests\/7\.json$/);
    assert.match(bytes, /"operationAuditNonce":"n{43}"/);
    const artifact = JSON.parse(bytes) as {
      prepared: { businessConfiguration: Record<string, unknown> };
    };
    const { platformBinding, valuesSha256, ...businessConfiguration } =
      artifact.prepared.businessConfiguration;
    assert.deepEqual(platformBinding, result.operation.platformBinding);
    assert.match(String(valuesSha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(businessConfiguration, {
      secretFileMappings: {
        databaseOwner: { secretName: 'commander-database', secretKey: 'owner-url' },
      },
      databasePeerBindingInput: {
        format: 'database_peer_binding_input/v1',
        roles: [
          { role: 'adapter-ops', host: 'db.example', port: 5432 },
          { role: 'app', host: 'db.example', port: 5432 },
          { role: 'owner', host: 'db.example', port: 5432 },
          { role: 'scheduler', host: 'db.example', port: 5432 },
          { role: 'tenant-authority', host: 'db.example', port: 5432 },
          { role: 'worker', host: 'db.example', port: 5432 },
        ],
        expectedServerSpkiSha256: digest('d'),
        ca: {
          mountIdentity: 'secret/database-ca:ca.crt',
          path: '/run/commander/database-tls/ca.crt',
          publicBytesSha256: createHash('sha256').update('helm-ca-bytes').digest('hex'),
        },
      },
    });
    assert.deepEqual(fixture.calls.slice(0, 4), [
      'helm:current-revision',
      'helm:project-revision:9',
      'prepare-projection:commander-owner-proof-current-r9:9',
      'cleanup-configmap:commander/commander-owner-proof-current-r9',
    ]);
    assert.match(fixture.calls[4]!, /^helm:version --short$/);
    assert.equal(fixture.calls[5]!, 'cleanup-proof:commander/commander');
    assert.equal(
      fixture.calls[6]!,
      'prepare-secret:commander/commander-database/owner-url->commander-proof-owner-v7',
    );
    assert.match(
      fixture.calls[7]!,
      /helm:upgrade commander \/retained\/charts\/b{64}\/commander --namespace commander --values \/state\/values\.yaml --set tenantAuthority\.cutoverPhase=enforce --set tenantAuthority\.configurationSha256=/,
    );
    assert.match(fixture.calls[7]!, /--atomic --wait --wait-for-jobs --timeout 10m/);
    assert.match(
      fixture.calls[7]!,
      /--set tenantAuthority\.proofOwnerSecret=commander-proof-owner-v7/,
    );
    assert.match(
      fixture.calls[7]!,
      /--set tenantAuthority\.releaseProjectionConfigMap=commander-proof-projection-v7-r10/,
    );
    assert.match(fixture.calls[7]!, /:projection-r10$/);
    assert.doesNotMatch(fixture.calls[7]!, /template|dry-run|rollback/);
    assert.deepEqual(fixture.calls.slice(8), [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('captures a sanitized Helm proof hook failure before cleanup', async () => {
    const fixture = ports();
    fixture.helm.runProjectedRevision = async () => {
      fixture.calls.push('helm:projected-failed');
      throw new Error('unredacted Helm failure');
    };
    const kubectl = fixture.kubectl as typeof fixture.kubectl & {
      captureProofHookFailureDiagnostic?: (namespace: string, release: string) => Promise<string>;
    };
    kubectl.captureProofHookFailureDiagnostic = async (namespace, release) => {
      fixture.calls.push('capture-proof-hook:' + namespace + '/' + release);
      return (
        'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;' +
        'owner_stage=lifecycle_initialize;log_sha256=' +
        digest('f')
      );
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_HOOK_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=f{64}/,
    );
    assert.equal(
      fixture.calls.indexOf('capture-proof-hook:commander/commander') <
        fixture.calls.lastIndexOf('cleanup-proof:commander/commander'),
      true,
    );
  });

  it('retains a fixed Helm rollout failure when hook cleanup loses the Job logs', async () => {
    const fixture = ports();
    fixture.helm.runProjectedRevision = async () => {
      throw new Error('TENANT_CUTOVER_HELM_COMMAND_FAILED');
    };
    fixture.kubectl.captureProofHookFailureDiagnostic = async () =>
      'code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=' +
      digest('e');

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_HOOK_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=e{64}/,
    );
  });

  it('retains the sanitized Helm subtype when hook cleanup loses the Job logs', async () => {
    const fixture = ports();
    fixture.helm.runProjectedRevision = async () => {
      throw new Error('TENANT_CUTOVER_HELM_COMMAND_FAILED:HELM_POST_RENDERER_FAILED');
    };
    fixture.kubectl.captureProofHookFailureDiagnostic = async () =>
      'code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=' +
      digest('d');

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_HOOK_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:HELM_POST_RENDERER_FAILED:code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=d{64}/,
    );
  });

  it('preserves a hook failure captured while an atomic Helm rollout is still running', async () => {
    const fixture = ports();
    let rolloutRunning = true;
    fixture.helm.runProjectedRevision = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      rolloutRunning = false;
      throw new Error('unredacted Helm failure');
    };
    fixture.kubectl.captureProofHookFailureDiagnostic = async () =>
      rolloutRunning
        ? 'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=' +
          digest('f')
        : 'code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=' +
          digest('e');

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_HOOK_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=f{64}/,
    );
  });

  it('preserves a proof failure when ephemeral proof cleanup also fails', async () => {
    const fixture = ports();
    let cleanupCalls = 0;
    fixture.helm.runProjectedRevision = async () => {
      throw new Error('unredacted Helm failure');
    };
    fixture.kubectl.captureProofHookFailureDiagnostic = async () =>
      'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=' +
      digest('a');
    fixture.kubectl.cleanupProofResources = async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 2) throw new Error('TENANT_CUTOVER_KUBECTL_GET_FAILED');
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_HOOK_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=a{64}/,
    );
  });

  it('creates a stable fresh bundled database Secret before deriving the proof credential', async () => {
    const fixture = ports();
    fixture.owner.append = async () =>
      operation({
        operationKind: 'fresh_enforce',
        businessConfiguration: {
          valuesSha256: digest('c'),
          secretFileMappings: {
            databaseOwner: {
              secretName: 'commander-database-bootstrap',
              secretKey: 'owner-url',
            },
          },
        },
      });
    fixture.readValues = async () =>
      `image:\n  repository: ghcr.io/commander/api\n  digest: ${image}\ndatabase:\n  enabled: true\n  backend: postgres\n  postgres:\n    bundled: true\n    user: postgres\n    database: commander\n    port: 5432\ndatabaseTls:\n  existingSecret: database-server-tls\n  caKey: ca.crt\n  expectedServerSpkiSha256: ${digest('d')}\ntenantAuthority:\n  apiProof:\n    publicSecret: api-proof-public\n    certKey: tls.crt\n`;
    await runHelmTenantCutover(input('install'), fixture);
    assert.deepEqual(fixture.calls.slice(0, 6), [
      'prepare-database:commander/commander-database-bootstrap/commander-postgres/commander',
      'helm:release-exists',
      'helm:version --short',
      `helm:upgrade --install commander /retained/charts/${chart}/commander --namespace commander --values /state/values.yaml --set database.postgres.existingSecret=commander-database-bootstrap --set tenantAuthority.transportBootstrap=true --set-string tenantAuthority.chartContentSha256=${chart} --atomic --wait --timeout 10m`,
      'cleanup-proof:commander/commander',
      'prepare-secret:commander/commander-database-bootstrap/owner-url->commander-proof-owner-v7',
    ]);
    assert.match(
      fixture.calls[6]!,
      /--set database\.postgres\.existingSecret=commander-database-bootstrap/,
    );
    assert.match(fixture.calls[6]!, /--set tenantAuthority\.transportBootstrap=false/);
  });

  it('cleans deterministic return_current proof resources before restore and after restore failure', async () => {
    const fixture = ports(operation({ proven: true }));
    fixture.owner.restore = async () => {
      fixture.calls.push('owner:restore');
      throw new Error('restore failed');
    };

    await assert.rejects(() => runHelmTenantCutover(input(), fixture), /restore failed/);

    assert.deepEqual(fixture.calls, [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'owner:restore',
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('cleans deterministic return_current proof resources when the restored operation changed', async () => {
    const fixture = ports(operation({ proven: true }));
    const restore = fixture.owner.restore;
    fixture.owner.restore = async (request) => {
      fixture.calls.push('owner:restore');
      const restored = await restore(request);
      const configuration = { ...restored.configuration, unexpected: true };
      return {
        ...restored,
        configuration,
        configurationSha256: canonicalBootstrapSha256(configuration),
      };
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_CURRENT_CHANGED/,
    );

    assert.deepEqual(fixture.calls, [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'owner:restore',
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('cleans deterministic return_current proof resources when restore evidence is malformed', async () => {
    const fixture = ports(operation({ proven: true }));
    const restore = fixture.owner.restore;
    fixture.owner.restore = async (request) => {
      fixture.calls.push('owner:restore');
      const restored = await restore(request);
      return {
        ...restored,
        restore: { ...restored.restore!, revision: 'invalid' },
      };
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_RESTORE_EVIDENCE_INVALID/,
    );

    assert.deepEqual(fixture.calls, [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'owner:restore',
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('cleans the revision-scoped return_current projection when the retained chart drifts', async () => {
    const fixture = ports(operation({ proven: true }));
    const restore = fixture.owner.restore;
    fixture.owner.restore = async (request) => {
      fixture.calls.push('owner:restore');
      return restore(request);
    };
    let digestRead = 0;
    fixture.chartDigest = () => {
      digestRead += 1;
      return digestRead <= 2 ? chart : digest('f');
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_RETAINED_CHART_DRIFT/,
    );

    assert.deepEqual(fixture.calls, [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'owner:restore',
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('freshly proves return_current without creating a Helm revision and cleans all proof resources', async () => {
    const fixture = ports(operation({ proven: true }));
    Object.assign(fixture.helm, {
      currentRevision: async () => {
        fixture.calls.push('helm:current-revision');
        return '7';
      },
      proofJobManifest: async (_namespace: string, _release: string, revision: string) => {
        fixture.calls.push(`helm:proof-job-manifest:${revision}`);
        return retainedProofJobManifest(revision);
      },
    });
    Object.assign(fixture.kubectl, {
      prepareReleaseProjectionConfigMap: async (request: { name: string; revision: string }) => {
        fixture.calls.push(`prepare-projection:${request.name}:${request.revision}`);
      },
      runProofJob: async (request: { name: string; revision: string }) => {
        fixture.calls.push(`run-proof-job:${request.name}:${request.revision}`);
        return {
          proven: true,
          operationVersion: '7',
          proofSequence: '2',
          proofAttemptId: '11111111-1111-4111-8111-111111111111',
          rolloutProofSha256: digest('9'),
        };
      },
      deleteAndVerifyConfigMap: async (_namespace: string, name: string) => {
        fixture.calls.push(`cleanup-configmap:commander/${name}`);
      },
    });

    const result = await runHelmTenantCutover(input(), fixture);

    assert.equal(result.action, 'returned_current');
    assert.equal(fixture.calls.filter((call) => call === 'helm:current-revision').length, 2);
    assert.ok(fixture.calls.includes('helm:project-revision:7'));
    assert.ok(fixture.calls.includes('helm:proof-job-manifest:7'));
    assert.ok(fixture.calls.includes('prepare-projection:commander-proof-projection-v7-r7:7'));
    assert.ok(fixture.calls.includes('run-proof-job:commander-tenant-cutover-prove-r7:7'));
    assert.deepEqual(fixture.calls.slice(-4), [
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'helm:current-revision',
    ]);
    assert.equal(
      fixture.calls.some(
        (call) =>
          call.startsWith('helm:upgrade ') ||
          call.startsWith('helm:restore-revision:') ||
          call.includes(':projection-r'),
      ),
      false,
    );
  });

  it('cleans every ephemeral return_current proof resource when the fresh challenge fails', async () => {
    const fixture = ports(operation({ proven: true }));
    Object.assign(fixture.helm, {
      currentRevision: async () => {
        fixture.calls.push('helm:current-revision');
        return '7';
      },
      proofJobManifest: async (_namespace: string, _release: string, revision: string) =>
        retainedProofJobManifest(revision),
    });
    Object.assign(fixture.kubectl, {
      prepareReleaseProjectionConfigMap: async () => undefined,
      runProofJob: async () => {
        fixture.calls.push('run-proof-job:failed');
        throw new Error('fresh proof failed');
      },
      deleteAndVerifyConfigMap: async (_namespace: string, name: string) => {
        fixture.calls.push(`cleanup-configmap:commander/${name}`);
      },
    });

    await assert.rejects(() => runHelmTenantCutover(input(), fixture), /fresh proof failed/);
    assert.equal(fixture.calls.filter((call) => call === 'helm:current-revision').length, 2);
    assert.deepEqual(fixture.calls.slice(-4), [
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'helm:current-revision',
    ]);
  });

  it('fails closed after cleanup if a return_current proof changes the Helm revision', async () => {
    const fixture = ports(operation({ proven: true }));
    let revisionRead = 0;
    fixture.helm.currentRevision = async () => {
      fixture.calls.push('helm:current-revision');
      revisionRead += 1;
      return revisionRead < 2 ? '7' : '8';
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_CREATED_HELM_REVISION/,
    );
    assert.deepEqual(fixture.calls.slice(-4), [
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'helm:current-revision',
    ]);
  });

  it('cleans stale proof resources before a return_current revision preflight failure', async () => {
    const fixture = ports(operation({ proven: true }));
    fixture.helm.currentRevision = async () => {
      fixture.calls.push('helm:current-revision');
      return '8';
    };

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_REVISION_MISMATCH/,
    );

    assert.deepEqual(fixture.calls.slice(-4), [
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'helm:current-revision',
    ]);
    assert.equal(
      fixture.calls.lastIndexOf('cleanup-proof:commander/commander') <
        fixture.calls.lastIndexOf('helm:current-revision'),
      true,
    );
  });

  it('rejects an extra proof Job sidecar and cleans before returning', async () => {
    const fixture = ports(operation({ proven: true }));
    fixture.helm.currentRevision = async () => {
      fixture.calls.push('helm:current-revision');
      return '7';
    };
    fixture.helm.proofJobManifest = async (_namespace, _release, revision) =>
      retainedProofJobManifest(revision).replace(
        '      containers:\n',
        `      containers:\n        - name: credential-exfiltrator\n          image: example.invalid/sidecar@${image}\n`,
      );

    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_PROOF_JOB_INVALID/,
    );
    assert.equal(
      fixture.calls.some((call) => call.startsWith('run-proof-job:')),
      false,
    );
    assert.deepEqual(fixture.calls.slice(-4), [
      'cleanup-proof:commander/commander',
      'cleanup-configmap:commander/commander-proof-projection-v7-r7',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'helm:current-revision',
    ]);
  });

  it('reads only image.digest and rejects an unrelated YAML digest', async () => {
    const fixture = ports();
    fixture.readValues = async () => `unrelated:\n  digest: ${image}\nimage:\n  tag: mutable\n`;
    await assert.rejects(
      () => runHelmTenantCutover(input(), fixture),
      /TENANT_CUTOVER_IMAGE_NOT_DIGEST_PINNED/,
    );
    assert.equal(fixture.calls.length, 0);
  });

  it('reuses byte-identical persisted request material and deletes a stale failed proof hook before retry', async () => {
    const current = operation({ proven: false });
    const fixture = ports(current);
    const bytes = `${canonicalBootstrapJson({
      schema: 'tenant-cutover-request/v1',
      command: 'enforce',
      prepared: {
        platformBinding: current.platformBinding,
        businessConfiguration: current.businessConfiguration,
        configuration: current.configuration,
        configurationSha256: current.configurationSha256,
      },
    })}\n`;
    fixture.writes.set(
      '/repo/.commander/tenant-cutover/commander/commander/requests/7.json',
      bytes,
    );
    const result = await runHelmTenantCutover(input(), fixture);
    assert.equal(result.action, 'retried');
    assert.equal(fixture.writes.size, 1);
    assert.equal([...fixture.writes.values()][0], bytes);
    assert.equal(fixture.calls.includes('cleanup-proof:commander/commander'), true);
    assert.equal(fixture.calls.includes('cleanup-secret:commander/commander-proof-owner-v7'), true);
  });

  it('reconstructs a missing local request artifact after an owner append response is lost', async () => {
    const current = operation({ proven: false });
    const fixture = ports(current);

    const result = await runHelmTenantCutover(input(), fixture);

    assert.equal(result.action, 'retried');
    assert.equal(fixture.writes.size, 1);
    assert.equal(
      [...fixture.writes.values()][0],
      `${canonicalBootstrapJson({
        schema: 'tenant-cutover-request/v1',
        command: 'enforce',
        prepared: {
          platformBinding: current.platformBinding,
          businessConfiguration: current.businessConfiguration,
          configuration: current.configuration,
          configurationSha256: current.configurationSha256,
        },
      })}\n`,
    );
  });

  it('cleans proof resources and the target Secret after an ambiguous Secret-create failure', async () => {
    const fixture = ports();
    fixture.kubectl.prepareProofOwnerSecret = async (request) => {
      fixture.calls.push(
        `prepare-secret:${request.namespace}/${request.sourceName}/${request.sourceKey}->${request.targetName}`,
      );
      throw new Error('lost create response');
    };
    await assert.rejects(() => runHelmTenantCutover(input(), fixture), /lost create response/);
    assert.deepEqual(fixture.calls, [
      'helm:current-revision',
      'helm:project-revision:9',
      'prepare-projection:commander-owner-proof-current-r9:9',
      'cleanup-configmap:commander/commander-owner-proof-current-r9',
      'helm:version --short',
      'cleanup-proof:commander/commander',
      'prepare-secret:commander/commander-database/owner-url->commander-proof-owner-v7',
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
    ]);
  });

  it('restores the exact owner-proven revision and reconciles the failed-target union', async () => {
    const fixture = ports();
    const request = parseHelmTenantCutoverArgs(
      ['restore-recorded-current', '--namespace', 'commander', '--release', 'commander'],
      '/repo',
    );
    const result = await runHelmTenantCutover(request, fixture);
    assert.equal(result.action, 'restored');
    assert.deepEqual(fixture.calls.slice(0, 6), [
      'helm:current-revision',
      'helm:project-revision:7',
      'helm:project-revision:9',
      'read:Secret/commander-old',
      'delete-object:Secret/commander-old:old-secret-uid:77',
      'read:Secret/commander-old',
    ]);
    assert.equal(fixture.calls[6], 'helm:version --short');
    assert.equal(fixture.calls[7], 'cleanup-proof:commander/commander');
    assert.equal(
      fixture.calls[8],
      'prepare-secret:commander/commander-database/owner-url->commander-proof-owner-v7',
    );
    assert.match(
      fixture.calls[9]!,
      /^helm:restore-revision:7:\/retained\/charts\/b{64}\/commander:upgrade commander \/retained\/charts\/b{64}\/commander --namespace commander --values - --set tenantAuthority\.cutoverPhase=enforce/,
    );
    assert.match(fixture.calls[9]!, /--atomic --wait --wait-for-jobs --timeout 10m$/);
    assert.deepEqual(fixture.calls.slice(10), [
      'cleanup-proof:commander/commander',
      'cleanup-secret:commander/commander-proof-owner-v7',
      'verify-current:Deployment/commander-api',
      'read:Secret/commander-old',
      'read:Job/commander-tenant-cutover-prove-r9',
    ]);
    assert.equal(fixture.writes.size, 0);
  });

  it('fails before cleanup or Helm when the proven revision projection drifts', async () => {
    const fixture = ports();
    fixture.helm.projectRevision = async (_namespace, _release, revision) => {
      fixture.calls.push(`helm:project-revision:${revision}`);
      return releaseProjection(revision, []);
    };
    await assert.rejects(
      () =>
        runHelmTenantCutover(
          parseHelmTenantCutoverArgs(
            ['restore-recorded-current', '--namespace', 'commander', '--release', 'commander'],
            '/repo',
          ),
          fixture,
        ),
      /TENANT_CUTOVER_RESTORE_PROJECTION_DRIFT/,
    );
    assert.equal(
      fixture.calls.some((call) => call.startsWith('cleanup-proof:')),
      false,
    );
    assert.equal(
      fixture.calls.some((call) => call.startsWith('helm:restore-revision:')),
      false,
    );
  });

  it('builds a digest-pinned owner Job with the scoped current-proof runtime', () => {
    const bundle = buildHelmOwnerJobBundle({
      mode: 'tenant-cutover-append',
      payload: { schema: 'tenant-cutover-request/v1' },
      executionId: '1'.repeat(32),
      context: {
        namespace: 'commander',
        release: 'commander',
        image: `ghcr.io/commander/api@${image}`,
        databaseSecretName: 'commander-database-bootstrap',
        databaseSecretKeys: {
          owner: 'owner-url',
          app: 'app-url',
          tenantAuthority: 'tenant-authority-url',
          scheduler: 'scheduler-url',
          worker: 'worker-url',
          adapterOps: 'adapter-ops-url',
        },
        databaseTls: {
          secretName: 'database-server-tls',
          caKey: 'ca.crt',
          expectedServerSpkiSha256: digest('d'),
        },
        proofCertificate: { secretName: 'api-proof-public', caKey: 'ca.crt', certKey: 'tls.crt' },
        proofRuntime: {
          caKey: 'ca.crt',
          releaseProjectionConfigMap: 'commander-proof-projection-v1',
        },
        bootstrap: { kind: 'bundled', user: 'postgres', passwordSecretKey: 'postgres-password' },
      },
    });
    const serialized = canonicalBootstrapJson(bundle.job);
    assert.match(serialized, new RegExp(`ghcr\\.io/commander/api@${image}`));
    assert.match(serialized, /COMMANDER_TENANT_CUTOVER_INPUT_FILE/);
    assert.match(serialized, /\/run\/commander\/tenant-cutover\/request\.json/);
    assert.match(serialized, /COMMANDER_KUBERNETES_PROOF_RUNTIME/);
    assert.match(
      serialized,
      new RegExp(
        `"serviceAccountName":"commander-proof-reader-${createHash('sha256')
          .update('commander/commander')
          .digest('hex')
          .slice(0, 16)}"`,
      ),
    );
    assert.match(serialized, /\/var\/run\/secrets\/commander\.io\/proof-api/);
    assert.match(serialized, /"path":"identity-token"/);
    assert.match(serialized, /"name":"commander-proof-projection-v1"/);
    assert.match(serialized, /\/run\/commander\/release-projection/);
    assert.match(serialized, /"automountServiceAccountToken":false/);
    assert.match(serialized, /"commander\.io\/migration-client-v2":"true"/);
    assert.match(serialized, /"commander\.io\/migration-release":"commander"/);
    assert.doesNotMatch(serialized, /"app\.kubernetes\.io\/component":"migration"/);
    assert.match(
      serialized,
      /"secretKeyRef":\{"key":"owner-url","name":"commander-database-bootstrap"\}/,
    );
    assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//);
    assert.deepEqual(
      (bundle.configMap.data as Record<string, string>)['request.json'],
      '{"schema":"tenant-cutover-request/v1"}\n',
    );
  });

  it('pins Helm 3.17.3', () => {
    assert.throws(
      () =>
        buildHelmRolloutArgs(
          operation(),
          { namespace: 'commander', release: 'commander', values: '/v' },
          'v3.16.0',
        ),
      /TENANT_CUTOVER_HELM_VERSION_INVALID/,
    );
    assert.throws(
      () =>
        buildHelmTransportBootstrapArgs(
          {
            namespace: 'commander',
            release: 'commander',
            values: '/v',
            chart: '/chart',
            chartContentSha256: chart,
            databaseSecretName: 'commander-database-bootstrap',
          },
          'v4.0.0',
        ),
      /TENANT_CUTOVER_HELM_VERSION_INVALID/,
    );
  });

  it('records the chart-content digest in every Helm revision', () => {
    const rollout = buildHelmRolloutArgs(
      operation(),
      { namespace: 'commander', release: 'commander', values: '/v' },
      'v3.17.3',
    );
    assert.deepEqual(
      rollout.slice(rollout.indexOf('--set-string'), rollout.indexOf('--set-string') + 2),
      ['--set-string', `tenantAuthority.chartContentSha256=${chart}`],
    );

    const bootstrap = buildHelmTransportBootstrapArgs(
      {
        namespace: 'commander',
        release: 'commander',
        values: '/v',
        chart: '/chart',
        chartContentSha256: chart,
        databaseSecretName: 'commander-database-bootstrap',
      },
      'v3.17.3',
    );
    assert.deepEqual(
      bootstrap.slice(bootstrap.indexOf('--set-string'), bootstrap.indexOf('--set-string') + 2),
      ['--set-string', `tenantAuthority.chartContentSha256=${chart}`],
    );
  });

  it('makes API migration gates wait for the full tenant-cutover descriptor set', () => {
    const rollout = buildHelmRolloutArgs(
      operation(),
      { namespace: 'commander', release: 'commander', values: '/v' },
      'v3.17.3',
    );
    const expected = JSON.stringify(
      Object.fromEntries(
        [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...KERNEL_TASK1_CLOSURE_MIGRATIONS].map(
          ({ id, checksum }) => [id, checksum],
        ),
      ),
    );
    const index = rollout.indexOf('--set-string', rollout.indexOf('--set-string') + 1);
    const escapeHelmString = (value: string): string =>
      value
        .replaceAll('\\', '\\\\')
        .replaceAll('{', '\\{')
        .replaceAll('}', '\\}')
        .replaceAll(',', '\\,');

    assert.deepEqual(rollout.slice(index, index + 2), [
      '--set-string',
      `tenantAuthority.expectedMigrationDescriptors=${escapeHelmString(expected)}`,
    ]);

    const expandOperation = operation();
    const expand = buildHelmRolloutArgs(
      {
        ...expandOperation,
        phase: 'expand',
        platformBinding: { ...expandOperation.platformBinding, phase: 'expand' },
      },
      { namespace: 'commander', release: 'commander', values: '/v' },
      'v3.17.3',
    );
    const expandExpected = JSON.stringify(
      Object.fromEntries(
        [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(0, 2)].map(
          ({ id, checksum }) => [id, checksum],
        ),
      ),
    );
    const expandIndex = expand.indexOf('--set-string', expand.indexOf('--set-string') + 1);

    assert.deepEqual(expand.slice(expandIndex, expandIndex + 2), [
      '--set-string',
      `tenantAuthority.expectedMigrationDescriptors=${escapeHelmString(expandExpected)}`,
    ]);
  });
});
