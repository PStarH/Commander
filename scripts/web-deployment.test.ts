// Deployment contract tests for the web console and the production deploy path.
//
// Two layers:
//   * static contracts — the web image must build with a same-origin API base,
//     nginx must proxy every API prefix the client actually calls, and the
//     production deploy path must never merge the development compose base.
//   * executable contracts — deploy.sh's production stage is run with a fake
//     `docker` on PATH (no Docker, no network, no real secrets).
//
// No package.json wiring is required: run with
//   node --import tsx --test scripts/web-deployment.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const dockerfile = read('apps/web/Dockerfile');
const nginx = read('apps/web/nginx.conf');
const deployShPath = resolve(root, 'scripts/deploy.sh');
const deploySh = read('scripts/deploy.sh');
const deployVmSh = read('scripts/deploy-vm.sh');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `docker compose` subcommands a script invokes (pull/up/build/version…). */
function composeSubcommands(text: string): string[] {
  const subcommands: string[] = [];
  for (const match of text.matchAll(/docker compose ([^\n]+)/g)) {
    const parts = match[1].split(/\s+/).filter((part) => part.length > 0);
    const positional: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index] === '-f') {
        index += 1;
        continue;
      }
      if (parts[index].startsWith('-')) continue;
      positional.push(parts[index]);
    }
    if (positional[0]) subcommands.push(positional[0]);
  }
  return subcommands;
}

// ── nginx location parsing ────────────────────────────────────────────────────

interface Location {
  exact: boolean;
  path: string;
  body: string;
}

const LOCATION_PATTERN = /location\s+(=)?\s*(\S+)\s*\{([\s\S]*?)\n {4}\}/g;

function locations(): Location[] {
  const found: Location[] = [];
  for (const match of nginx.matchAll(LOCATION_PATTERN)) {
    found.push({ exact: match[1] === '=', path: match[2], body: match[3] });
  }
  return found;
}

function locationFor(header: string): Location {
  const match = locations().find(
    (entry) => `location ${entry.exact ? '= ' : ''}${entry.path} {` === header,
  );
  assert.ok(match, `nginx.conf has no "${header}" block`);
  return match;
}

const API_UPSTREAM = 'proxy_pass http://api:4000;';

/** Every prefix the client calls through `${API_BASE}`. */
function clientApiPrefixes(): Map<string, string[]> {
  const sources = readdirSync(resolve(root, 'apps/web/src'), { recursive: true })
    .map((entry) => String(entry))
    .filter(
      (entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry),
    );
  const prefixes = new Map<string, string[]>();
  for (const source of sources) {
    const text = readFileSync(resolve(root, 'apps/web/src', source), 'utf8');
    for (const match of text.matchAll(/\$\{API_BASE\}(\/[A-Za-z0-9_./${}-]*)/g)) {
      const segment = match[1].split('/').filter((part) => part.length > 0)[0];
      if (!segment || segment.startsWith('$')) continue;
      const prefix = `/${segment}`;
      const files = prefixes.get(prefix) ?? [];
      if (!files.includes(source)) files.push(source);
      prefixes.set(prefix, files);
    }
  }
  return prefixes;
}

// ── deploy.sh executable harness ──────────────────────────────────────────────

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ -n "\${FAKE_DOCKER_FAIL_PATTERN:-}" ]; then
  case "$*" in
    *"\$FAKE_DOCKER_FAIL_PATTERN"*) exit 1 ;;
  esac
fi
exit 0
`;

interface DeployFixture {
  root: string;
  dockerLog: string;
  envFile: string;
  cleanup: () => void;
}

const fixtures: string[] = [];

function deployFixture(): DeployFixture {
  const base = mkdtempSync(join(tmpdir(), 'commander-deploy-sh-'));
  fixtures.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  writeFileSync(join(base, 'docker-compose.prod.yml'), 'services: {}\n');
  writeFileSync(join(base, '.env.example'), 'COMMANDER_API_KEY=change-me-to-a-random-secret\n');
  return {
    root: base,
    dockerLog: join(base, 'docker.log'),
    envFile: join(base, '.env'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

interface DeployRun {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLines: string[];
}

/**
 * Sources scripts/deploy.sh in library mode and runs `deploy_production` with a
 * fake `docker` on PATH. PROJECT_ROOT/LOG_FILE are repointed at the fixture so
 * the run leaves no trace in the repository.
 */
function runDeployProduction(fx: DeployFixture, env: NodeJS.ProcessEnv = {}): DeployRun {
  const harness = [
    'set -euo pipefail',
    'export COMMANDER_DEPLOY_LIB_ONLY=1',
    `source '${deployShPath}'`,
    `PROJECT_ROOT='${fx.root}'`,
    `LOG_FILE='${fx.root}/logs/deploy.log'`,
    `mkdir -p '${fx.root}/logs'`,
    'CONFIRM_PRODUCTION=true',
    'sleep() { :; }',
    'deploy_production',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(fx.root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_DOCKER_LOG: fx.dockerLog,
      ...env,
    },
  });
  const log = existsSync(fx.dockerLog) ? readFileSync(fx.dockerLog, 'utf8') : '';
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    dockerLines: log.split('\n').filter((line) => line.length > 0),
  };
}

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  // deploy.sh creates <PROJECT_ROOT>/logs at source time; the harness repoints
  // PROJECT_ROOT, but remove the repository directory if this run created it.
  const logs = resolve(root, 'logs');
  if (existsSync(logs) && readdirSync(logs).length === 0) rmdirSync(logs);
});

// ── apps/web/Dockerfile ───────────────────────────────────────────────────────

describe('web image build contract', () => {
  it('builds the bundle with an empty, same-origin API base', () => {
    assert.match(dockerfile, /^ARG VITE_API_BASE_URL=""$/m, 'the build arg must default to empty');
    assert.match(
      dockerfile,
      /^ENV VITE_API_BASE_URL="\$\{VITE_API_BASE_URL\}"$/m,
      'the build arg must be exported to the vite build',
    );
    assert.match(
      dockerfile,
      /RUN if \[ -n "\$VITE_API_BASE_URL" \]/,
      'a non-empty API base must fail the build instead of producing a CSP-blocked bundle',
    );
    assert.doesNotMatch(
      dockerfile,
      /VITE_API_BASE_URL=["']?https?:\/\//,
      'an absolute API origin would be cross-origin and blocked by CSP connect-src self',
    );
  });

  it('fixes the API base in the build stage, before the bundle is produced', () => {
    const buildStage = dockerfile.indexOf('FROM base AS build');
    const envLine = dockerfile.search(/^ENV VITE_API_BASE_URL=/m);
    const viteBuild = dockerfile.indexOf('pnpm exec vite build');
    const productionStage = dockerfile.indexOf('FROM nginx');
    assert.ok(buildStage !== -1, 'build stage missing');
    assert.ok(viteBuild !== -1, 'vite build missing');
    assert.ok(productionStage !== -1, 'production stage missing');
    assert.ok(buildStage < envLine, 'the API base must be set in the build stage');
    assert.ok(envLine < viteBuild, 'the API base must be set before `vite build`');
    assert.ok(
      envLine < productionStage,
      'inlining happens at build time, not in the runtime stage',
    );
  });

  it('ships the nginx config it proxies with', () => {
    assert.match(dockerfile, /COPY apps\/web\/nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  });
});

// ── apps/web/nginx.conf ───────────────────────────────────────────────────────

describe('web server proxy contract', () => {
  it('proxies every API prefix the client calls through API_BASE', () => {
    const prefixes = clientApiPrefixes();
    for (const expected of ['/api', '/projects', '/runtime']) {
      assert.ok(prefixes.has(expected), `expected the client to call ${expected}`);
    }
    const proxied = locations().filter((entry) => entry.body.includes(API_UPSTREAM));
    for (const [prefix, files] of prefixes) {
      const covered = proxied.some((entry) => {
        if (entry.path === '/') return false; // SPA fallback, not an API route
        const normalised = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
        return normalised === prefix;
      });
      assert.ok(covered, `${prefix} (used by ${files.join(', ')}) is not proxied to the API`);
    }
  });

  it('proxies the ops and versioned endpoints the API mounts at its root', () => {
    for (const header of [
      'location /health {',
      'location = /ready {',
      'location = /metrics {',
      'location /system/ {',
      'location /v1/ {',
    ]) {
      assert.match(locationFor(header).body, /proxy_pass http:\/\/api:4000;/);
    }
  });

  it('disables proxy buffering for the streaming endpoints', () => {
    for (const header of ['location /api/ {', 'location /projects/ {']) {
      const body = locationFor(header).body;
      assert.match(body, /proxy_buffering off;/, `${header} must not buffer a streamed response`);
      assert.match(body, /proxy_read_timeout/, `${header} must outlive a long-lived stream`);
    }
  });

  it('keeps the SPA fallback and the client-side page routes', () => {
    assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/);
    assert.match(locationFor('location / {').body, /try_files/);
    // /missions is a page route (`<Route path="/missions">`); proxying it would
    // break a hard reload of that page.
    assert.doesNotMatch(nginx, /location\s+(=\s*)?\/missions\/?\s*\{/);
  });

  it('keeps the production CSP same-origin', () => {
    assert.match(nginx, /connect-src 'self'/);
    assert.doesNotMatch(nginx, /connect-src[^;]*localhost:4000/);
    assert.doesNotMatch(nginx, /connect-src[^;]*\*/);
  });

  it('upgrades only websocket requests and closes plain connections', () => {
    assert.match(nginx, /map \$http_upgrade \$connection_upgrade/);
    assert.match(nginx, /proxy_set_header Connection \$connection_upgrade;/);
  });
});

// ── scripts/deploy.sh: production path ────────────────────────────────────────

describe('deploy.sh production contract', () => {
  it('runs on the system bash (no bash-4-only constructs)', () => {
    const result = spawnSync(
      'bash',
      ['-c', 'export COMMANDER_DEPLOY_LIB_ONLY=1; source scripts/deploy.sh; printf "sourced"'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sourced/);
  });

  it('deploys the standalone production compose file with pull + up --no-build', () => {
    assert.match(deploySh, /PROD_COMPOSE_FILE="docker-compose\.prod\.yml"/);
    assert.match(deploySh, /docker compose -f "\$PROD_COMPOSE_FILE" pull/);
    assert.match(
      deploySh,
      /docker compose -f "\$PROD_COMPOSE_FILE" up -d --no-build --remove-orphans/,
    );
    assert.doesNotMatch(
      deploySh,
      /docker compose -f docker-compose\.yml/,
      'the development base carries build: stanzas and must never be merged in',
    );
    const subcommands = composeSubcommands(deploySh);
    assert.ok(subcommands.includes('pull'), `expected a pull, got ${subcommands.join(', ')}`);
    assert.ok(subcommands.includes('up'), `expected an up, got ${subcommands.join(', ')}`);
    assert.ok(!subcommands.includes('build'), 'no image may be built on the deploy host');
  });

  it('probes /ready inside the api container instead of a host-side /health', () => {
    assert.match(deploySh, /exec -T api node -e/);
    assert.match(deploySh, /127\.0\.0\.1:4000\/ready/);
    assert.match(deploySh, /AbortController/);
    assert.doesNotMatch(deploySh, /^\s*curl\s/m, 'readiness must not depend on a host port');
    assert.doesNotMatch(deploySh, /status\s*==\s*"ok"/, 'liveness is not readiness');
  });

  it('never advises deploying the .env.example placeholder secrets', () => {
    assert.doesNotMatch(deploySh, /copy \.env\.example/i);
    assert.match(deploySh, /WEAK_SECRET_PATTERNS/);
    assert.match(deploySh, /env_file_secret_problem/);
  });

  it('refuses a production deploy without --confirm-production', () => {
    const fx = deployFixture();
    writeFileSync(fx.envFile, 'COMMANDER_API_KEY=contract-test-value-not-a-secret\n');
    const harness = [
      'set -euo pipefail',
      'export COMMANDER_DEPLOY_LIB_ONLY=1',
      `source '${deployShPath}'`,
      `PROJECT_ROOT='${fx.root}'`,
      `LOG_FILE='${fx.root}/logs/deploy.log'`,
      `mkdir -p '${fx.root}/logs'`,
      'deploy_production',
    ].join('\n');
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(fx.root, 'bin')}:${process.env.PATH ?? ''}`,
        FAKE_DOCKER_LOG: fx.dockerLog,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /requires --confirm-production/);
    assert.ok(!existsSync(fx.dockerLog), 'nothing may be deployed without confirmation');
  });

  it('refuses a .env that is a copy of .env.example', () => {
    const fx = deployFixture();
    writeFileSync(fx.envFile, readFileSync(join(fx.root, '.env.example'), 'utf8'));
    const result = runDeployProduction(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Refusing to deploy/);
    assert.match(result.stdout, /copy of \.env\.example/);
    assert.ok(
      !result.dockerLines.some((line) => line.includes('pull') || line.includes('up -d')),
      `nothing may be deployed, got:\n${result.dockerLines.join('\n')}`,
    );
  });

  it('refuses a .env that still carries the example placeholder secret', () => {
    const fx = deployFixture();
    writeFileSync(
      fx.envFile,
      'COMMANDER_API_KEY=change-me-to-a-random-secret\nDATABASE_URL=postgres://example\n',
    );
    const result = runDeployProduction(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /placeholder/);
    assert.ok(
      !result.dockerLines.some((line) => line.includes('pull') || line.includes('up -d')),
      `nothing may be deployed, got:\n${result.dockerLines.join('\n')}`,
    );
  });

  it('pulls and starts the pinned images, then verifies readiness in-container', () => {
    const fx = deployFixture();
    writeFileSync(fx.envFile, 'COMMANDER_API_KEY=2f8c4b1e9a7d6c5f0e3b8a1d4c7f2e9b\n');
    const result = runDeployProduction(fx);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assert.ok(
      result.dockerLines.some((line) => line === 'compose -f docker-compose.prod.yml pull'),
      `expected a pull of the pinned images, got:\n${result.dockerLines.join('\n')}`,
    );
    assert.ok(
      result.dockerLines.some(
        (line) => line === 'compose -f docker-compose.prod.yml up -d --no-build --remove-orphans',
      ),
      `expected a --no-build start, got:\n${result.dockerLines.join('\n')}`,
    );
    const pullIndex = result.dockerLines.indexOf('compose -f docker-compose.prod.yml pull');
    const upIndex = result.dockerLines.findIndex((line) => line.includes('up -d --no-build'));
    assert.ok(pullIndex < upIndex, 'images are pulled before services start');

    for (const line of result.dockerLines) {
      assert.doesNotMatch(line, /-f docker-compose\.yml/, 'the dev base must never be merged in');
      const tokens = line.split(/\s+/);
      assert.ok(!tokens.includes('build'), `nothing may be built on the deploy host: ${line}`);
      assert.ok(!tokens.includes('--build'), `nothing may be built on the deploy host: ${line}`);
    }
    const probe = result.dockerLines.find((line) => line.includes('exec -T api node -e'));
    assert.ok(
      probe,
      `expected an in-container readiness probe, got:\n${result.dockerLines.join('\n')}`,
    );
    assert.match(probe, /\/ready/);
    assert.match(result.stdout, /Production deployment complete/);
  });

  it('fails the health stage and reports no success when readiness never passes', () => {
    const fx = deployFixture();
    writeFileSync(fx.envFile, 'COMMANDER_API_KEY=2f8c4b1e9a7d6c5f0e3b8a1d4c7f2e9b\n');
    const result = runDeployProduction(fx, { FAKE_DOCKER_FAIL_PATTERN: '/ready' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Readiness FAILED/);
    assert.doesNotMatch(result.stdout, /Production deployment complete/);
    assert.ok(
      result.dockerLines.some((line) => line.includes('exec -T api node -e')),
      'the failure must come from the in-container readiness probe',
    );
  });
});

// ── scripts/deploy-vm.sh: static guards ───────────────────────────────────────

describe('deploy-vm.sh static contract', () => {
  it('never merges the development compose base and never builds remotely', () => {
    assert.doesNotMatch(deployVmSh, /docker-compose\.yml/);
    assert.match(deployVmSh, /up -d --no-build --remove-orphans/);
    assert.doesNotMatch(deployVmSh, /\s--build\b/);
  });

  it('resolves the default transport through PATH but validates overrides', () => {
    assert.match(deployVmSh, /resolve_transport\(\)/);
    assert.match(deployVmSh, /command -v "\$name"/);
    assert.match(deployVmSh, /override must be an absolute path/);
    assert.doesNotMatch(deployVmSh, /SSH_BIN="\$\{COMMANDER_DEPLOY_SSH_BIN:-ssh\}"/);
  });
});
