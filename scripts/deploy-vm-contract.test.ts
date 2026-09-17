// Contract tests for scripts/deploy-vm.sh.
//
// The script is exercised end to end with FAKE ssh/scp executables: no SSH
// connection, no network, no real secrets. The fakes record every invocation so
// the assertions can inspect exactly what the script would have run on the
// deployment host.
//
// The contract under test (also documented in the script header):
//   * production-only compose file, never the development base
//   * `up -d --no-build` — nothing is built on the remote host
//   * strict host trust against an operator-provided known_hosts
//   * the env file is uploaded to a fixed staging path that is created 0600
//     before the secret arrives, then moved into place
//   * readiness is observed INSIDE the api container via /ready
//   * any failed stage exits non-zero and never prints the success banner

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/deploy-vm.sh');
const scriptSource = readFileSync(script, 'utf8');

const HOST = 'vm.example.invalid';
const SUCCESS_BANNER = 'Commander deployed and verified';
const REMOTE_DIR = '/opt/commander';

// A transport double: records "<binary> :: <args>" and optionally fails when the
// remote command contains a marker. It never opens a socket.
const FAKE_TRANSPORT = `#!/bin/sh
printf '%s :: %s\\n' "$0" "$*" >> "$FAKE_TRANSPORT_LOG"
if [ -n "\${FAKE_TRANSPORT_FAIL_PATTERN:-}" ]; then
  case "$*" in
    *"\$FAKE_TRANSPORT_FAIL_PATTERN"*) exit 1 ;;
  esac
fi
exit 0
`;

interface Fixture {
  root: string;
  bin: string;
  ssh: string;
  scp: string;
  log: string;
  knownHosts: string;
  envFile: string;
  envDir: string;
  cleanup: () => void;
}

const fixtures: string[] = [];

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'commander-deploy-vm-'));
  fixtures.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const ssh = join(bin, 'ssh');
  const scp = join(bin, 'scp');
  for (const tool of [ssh, scp]) {
    writeFileSync(tool, FAKE_TRANSPORT);
    chmodSync(tool, 0o755);
  }
  const knownHosts = join(base, 'known_hosts');
  writeFileSync(
    knownHosts,
    `${HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEYFORCONTRACTTESTONLY\n`,
  );
  // A throwaway, non-secret environment file. Named `.env` on purpose: the old
  // `mv $REMOTE_DIR/.env $REMOTE_DIR/.env` failed on exactly this name.
  const envDir = join(base, 'env');
  mkdirSync(envDir);
  const envFile = join(envDir, '.env');
  writeFileSync(envFile, 'COMMANDER_API_KEY=contract-test-value-not-a-secret\n');
  return {
    root: base,
    bin,
    ssh,
    scp,
    log: join(base, 'transport.log'),
    knownHosts,
    envFile,
    envDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
  sshLines: string[];
  scpLines: string[];
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, fx?: Fixture): RunResult {
  const fixtureState = fx ?? fixture();
  const result = spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixtureState.bin}:${process.env.PATH ?? ''}`,
      FAKE_TRANSPORT_LOG: fixtureState.log,
      ...env,
    },
  });
  const log = existsSync(fixtureState.log) ? readFileSync(fixtureState.log, 'utf8') : '';
  const lines = log.split('\n').filter((line) => line.length > 0);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    log,
    sshLines: lines.filter((line) => line.startsWith(`${fixtureState.ssh} :: `)),
    scpLines: lines.filter((line) => line.startsWith(`${fixtureState.scp} :: `)),
  };
}

/** The full happy path: prerequisites, uploads, pull, up, readiness. */
function deploySuccessfully(fx: Fixture, extra: string[] = []): RunResult {
  return run([HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts, ...extra], {}, fx);
}

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe('deploy-vm.sh contract', () => {
  it('documents itself without leaking shell statements into --help', () => {
    const fx = fixture();
    const result = run(['--help'], {}, fx);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--env-file <path>/);
    assert.match(result.stdout, /--known-hosts <path>/);
    assert.doesNotMatch(result.stdout, /set -euo pipefail/);
    assert.doesNotMatch(result.stdout, /resolve_transport/);
  });

  it('rejects a deployment with no environment file', () => {
    const fx = fixture();
    const result = run([HOST, '--known-hosts', fx.knownHosts], {}, fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--env-file is required/);
    assert.equal(result.log, '', 'no transport call may happen before validation');
  });

  it('rejects .env.example as production configuration', () => {
    const fx = fixture();
    const example = join(fx.envDir, '.env.example');
    writeFileSync(example, 'COMMANDER_API_KEY=change-me-to-a-random-secret\n');
    const result = run([HOST, '--env-file', example, '--known-hosts', fx.knownHosts], {}, fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to deploy \.env\.example/);
    assert.equal(result.log, '');
  });

  it('rejects an empty environment file', () => {
    const fx = fixture();
    const empty = join(fx.envDir, 'empty.env');
    writeFileSync(empty, '');
    const result = run([HOST, '--env-file', empty, '--known-hosts', fx.knownHosts], {}, fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Env file is empty/);
    assert.equal(result.log, '');
  });

  it('rejects an unknown host key store instead of trusting on first use', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', join(fx.root, 'missing_known_hosts')],
      {},
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /known_hosts not found/);
    assert.equal(result.log, '');
    assert.doesNotMatch(scriptSource, /StrictHostKeyChecking=accept-new/);
  });

  it('rejects a relative transport override', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts],
      { COMMANDER_DEPLOY_SSH_BIN: 'ssh' },
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an absolute path: ssh/);
    assert.equal(result.log, '');
  });

  it('rejects a transport override that is not executable', () => {
    const fx = fixture();
    const notExecutable = join(fx.root, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(notExecutable, 0o644);
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts],
      { COMMANDER_DEPLOY_SCP_BIN: notExecutable },
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not executable/);
    assert.equal(result.log, '');
  });

  it('resolves the default ssh/scp through PATH instead of rejecting bare names', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.sshLines.length > 0, 'the default ssh must be resolved and used');
    assert.ok(result.scpLines.length > 0, 'the default scp must be resolved and used');
    assert.ok(
      result.sshLines.every((line) => line.startsWith(`${fx.ssh} :: `)),
      'the resolved default must be an absolute path to the ssh on PATH',
    );
  });

  it('honours an absolute transport override', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts],
      { COMMANDER_DEPLOY_SSH_BIN: fx.ssh, COMMANDER_DEPLOY_SCP_BIN: fx.scp },
      fx,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.sshLines.every((line) => line.startsWith(`${fx.ssh} :: `)));
    assert.ok(result.scpLines.every((line) => line.startsWith(`${fx.scp} :: `)));
  });

  it('pins host trust to the operator-provided known_hosts file', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);
    for (const line of result.sshLines) {
      assert.match(line, /-o StrictHostKeyChecking=yes/);
      assert.match(
        line,
        new RegExp(`-o UserKnownHostsFile=${fx.knownHosts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    }
    assert.doesNotMatch(result.log, /accept-new/);
  });

  it('deploys the production compose file only, with pull and up --no-build', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);

    const composeLines = result.sshLines.filter((line) => line.includes('-f docker-compose'));
    assert.ok(composeLines.length >= 4, `expected compose invocations, got:\n${result.log}`);
    for (const line of composeLines) {
      assert.match(line, /-f docker-compose\.prod\.yml/);
      assert.doesNotMatch(
        line,
        /-f docker-compose\.yml/,
        'the development base must never be merged in',
      );
    }
    assert.doesNotMatch(result.log, /\s--build\b/, 'nothing may be built on the remote host');
    assert.match(
      result.log,
      /docker compose -f docker-compose\.prod\.yml up -d --no-build --remove-orphans/,
    );
    assert.match(result.log, /docker compose -f docker-compose\.prod\.yml pull/);

    const pullIndex = result.log.indexOf(' -f docker-compose.prod.yml pull');
    const upIndex = result.log.indexOf('up -d --no-build');
    assert.ok(
      pullIndex !== -1 && upIndex !== -1 && pullIndex < upIndex,
      'images are pulled before start',
    );
  });

  it('uploads the environment file to a fixed staging path created 0600 first', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);

    const staging = `${REMOTE_DIR}/.env.incoming`;
    assert.match(result.log, new RegExp(`: > '${staging.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(result.log, /chmod 600/);
    assert.match(
      result.log,
      new RegExp(`mv -f '${staging.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' '${REMOTE_DIR}/.env'`),
    );
    assert.ok(
      result.scpLines.some((line) => line.endsWith(`:${staging}`)),
      `the env file must be uploaded to ${staging}, got:\n${result.scpLines.join('\n')}`,
    );
    // The permissions are applied BEFORE the secret is transferred.
    const prepareIndex = result.log.indexOf(`: > '${staging}'`);
    const uploadIndex = result.log.indexOf(`:${staging}`);
    assert.ok(prepareIndex !== -1 && uploadIndex !== -1 && prepareIndex < uploadIndex);

    // The operator's own filename/directory is never interpolated into a remote
    // shell command, and the same-file `mv` cannot happen.
    for (const line of result.sshLines) {
      assert.ok(
        !line.includes(fx.envDir),
        `the env file path leaked into a remote command: ${line}`,
      );
    }
    assert.doesNotMatch(result.log, new RegExp(`mv '${REMOTE_DIR}/\\.env' '${REMOTE_DIR}/\\.env'`));
  });

  it('probes /ready inside the api container and never a host-side /health', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);

    const probe = result.sshLines.find((line) => line.includes('exec -T api node -e'));
    assert.ok(probe, `no in-container readiness probe:\n${result.log}`);
    assert.match(probe, /127\.0\.0\.1:4000\/ready/);
    assert.match(probe, /AbortController/);
    assert.doesNotMatch(result.log, /curl[^\n]*\/health/);
    assert.doesNotMatch(result.log, /status\s*==\s*"ok"/);
  });

  it('prints the success banner only after every stage passes', () => {
    const fx = fixture();
    const result = deploySuccessfully(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(SUCCESS_BANNER));
    assert.match(result.stdout, /API readiness passed/);
    assert.doesNotMatch(result.stdout, /http:\/\/vm\.example\.invalid:4000/);
  });

  it('fails without the success banner when readiness never passes', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts, '--deadline', '1'],
      { FAKE_TRANSPORT_FAIL_PATTERN: '/ready' },
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Readiness FAILED/);
    assert.match(result.stderr, /\/ready/);
    assert.doesNotMatch(result.stdout, new RegExp(SUCCESS_BANNER));
    assert.doesNotMatch(result.stdout, /API readiness passed/);
  });

  it('fails without the success banner when the image pull fails', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts],
      { FAKE_TRANSPORT_FAIL_PATTERN: ' pull' },
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Image pull failed/);
    assert.doesNotMatch(result.stdout, new RegExp(SUCCESS_BANNER));
    assert.doesNotMatch(
      result.log,
      /up -d --no-build/,
      'services must not start after a failed pull',
    );
  });

  it('fails without the success banner when the remote prerequisites are missing', () => {
    const fx = fixture();
    const result = run(
      [HOST, '--env-file', fx.envFile, '--known-hosts', fx.knownHosts],
      { FAKE_TRANSPORT_FAIL_PATTERN: 'docker --version' },
      fx,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remote prerequisites missing/);
    assert.doesNotMatch(result.stdout, new RegExp(SUCCESS_BANNER));
  });
});
