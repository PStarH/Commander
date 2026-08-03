import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

const FAILOVER_TOOLS = ['pg_ctl', 'initdb', 'createdb', 'psql', 'pg_basebackup'] as const;
const PITR_TOOLS = ['pg_ctl', 'initdb', 'createdb', 'psql', 'pg_basebackup'] as const;

function writeExecutable(path: string, source = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function fakePostgresBin(
  tools: readonly string[],
  overrides: Partial<Record<string, string>> = {},
): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'commander-pg-bin-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of tools) writeExecutable(join(bin, tool), overrides[tool]);
  return { root, bin };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function runDrill(script: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function migrationFixture(): {
  root: string;
  config: string;
  dataRoot: string;
  source: string;
  destination: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'commander-migrate-'));
  const dataRoot = join(root, 'data');
  const source = join(dataRoot, 'bridge', 'acme');
  const destination = join(dataRoot, 'tenants', 'acme');
  const config = join(root, 'tenants.json');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'caller-owned.txt'), 'preserve me\n');
  writeFileSync(
    config,
    `${JSON.stringify({ tenants: [{ tenantId: 'acme', isolation: 'bridge' }] }, null, 2)}\n`,
  );
  return { root, config, dataRoot, source, destination };
}

function runMigration(
  fixture: ReturnType<typeof migrationFixture>,
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['deploy/scripts/migrate-tenant.sh', 'acme', 'silo'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TENANT_CONFIG_PATH: fixture.config,
      COMMANDER_DATA_ROOT: fixture.dataRoot,
      ...env,
    },
    encoding: 'utf8',
  });
}

function isolation(config: string): string {
  return JSON.parse(readFileSync(config, 'utf8')).tenants[0].isolation;
}

describe('deployment gate portability', () => {
  it('bootstraps the CI deploy-gate database with a separate owner closure session', () => {
    const workflow = load(
      readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
    ) as {
      jobs?: Record<
        string,
        {
          env?: Record<string, string>;
          steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
        }
      >;
    };
    const job = workflow.jobs?.['l4-b-deploy-gates'];
    assert.ok(job, 'CI must define the l4-b deploy-gates job');
    assert.match(job.env?.OWNER_DSN ?? '', /postgres:\/\/commander_owner:/);
    assert.match(job.env?.COMMANDER_OWNER_DATABASE_URL ?? '', /postgres:\/\/commander_owner:/);
    assert.match(job.env?.DATABASE_URL ?? '', /postgres:\/\/commander:/);
    assert.match(job.env?.COMMANDER_KERNEL_DATABASE_URL ?? '', /postgres:\/\/commander:/);
    assert.match(job.env?.COMMANDER_TASK1_PG_URL ?? '', /postgres:\/\/commander_ci_admin:/);
    assert.doesNotMatch(job.env?.OWNER_DSN ?? '', /postgres:\/\/commander:/);

    const steps = job.steps ?? [];
    const bootstrapIndex = steps.findIndex(
      (step) => step.name === 'Bootstrap deploy-gate authority',
    );
    const migrationIndex = steps.findIndex(
      (step) => step.name === 'Apply enforced Task 1 closure migrations',
    );
    const postClosureIndex = steps.findIndex(
      (step) => step.name === 'Apply post-closure kernel migrations',
    );
    const gateIndex = steps.findIndex(
      (step) => step.name === 'Deploy gates (pnpm test:deploy-gates)',
    );
    assert.ok(bootstrapIndex >= 0, 'CI must bootstrap the deploy-gate authority topology');
    assert.ok(migrationIndex > bootstrapIndex, 'closure migrations must follow bootstrap');
    assert.ok(postClosureIndex > migrationIndex, 'full migrations must follow closure migrations');
    assert.ok(
      gateIndex > postClosureIndex,
      'deploy gates must follow full post-closure migrations',
    );

    const bootstrap = steps[bootstrapIndex]?.run ?? '';
    assert.match(bootstrap, /CREATE ROLE commander_ci_admin WITH LOGIN SUPERUSER/);
    assert.match(bootstrap, /CREATE ROLE commander_owner WITH LOGIN/);
    assert.match(
      bootstrap,
      /CREATE ROLE commander_scheduler WITH LOGIN PASSWORD 'commander_scheduler' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;/,
    );
    assert.match(bootstrap, /ALTER DATABASE commander OWNER TO commander_owner/);
    for (const role of [
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      assert.match(bootstrap, new RegExp(`GRANT ${role} TO commander_owner WITH ADMIN OPTION`));
    }

    const migration = steps[migrationIndex];
    assert.match(migration?.run ?? '', /ci-bootstrap-deploy-gates\.ts closure/);
    assert.equal(migration?.env, undefined);
    assert.match(steps[postClosureIndex]?.run ?? '', /ci-bootstrap-deploy-gates\.ts full/);
  });

  it('persists the authorized rotation keyring into the deploy-gate verifier step', () => {
    const workflow = load(
      readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
    ) as {
      jobs?: Record<
        string,
        { steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
      >;
    };
    const steps = workflow.jobs?.['l4-b-deploy-gates']?.steps ?? [];
    const importIndex = steps.findIndex(
      (step) => step.name === 'Import authorized rotation sign-off key',
    );
    const gateIndex = steps.findIndex(
      (step) => step.name === 'Deploy gates (pnpm test:deploy-gates)',
    );
    assert.ok(importIndex >= 0, 'CI must import the authorized rotation public key');
    assert.ok(gateIndex > importIndex, 'rotation verification must run after key import');
    assert.match(
      steps[importIndex]?.run ?? '',
      /GNUPGHOME=.*commander-gnupg[\s\S]*>>\s*"\$GITHUB_ENV"/,
      'the imported keyring must persist into later GitHub Actions steps',
    );
    assert.match(
      steps[gateIndex]?.run ?? '',
      /pnpm test:deploy-gates/,
      'the persisted keyring is consumed by test:deploy-gates -> rotate:verify',
    );
  });

  it('exposes DR live proof only through a protected, fail-closed CI handoff', () => {
    const workflow = load(
      readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
    ) as {
      jobs?: Record<
        string,
        {
          environment?: string;
          'runs-on'?: unknown;
          steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
        }
      >;
    };
    const job = workflow.jobs?.['l4-b-dr-live-proof'];
    assert.ok(job, 'CI must expose an explicit G4 DR live-proof handoff job');
    assert.equal(job.environment, 'cd-live-proof');
    assert.deepEqual(job['runs-on'], ['self-hosted', 'linux', 'x64', 'commander-dr']);

    const inputStep = job.steps?.find((step) => step.name === 'Materialize protected DR inputs');
    const proofStep = job.steps?.find((step) => step.name === 'Run G4 rotation and DR proof');
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_SOURCE_DATABASE_URL/);
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_RESTORE_DATABASE_URL/);
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_DATABASE_TLS_CA_PEM/);
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_DATABASE_TLS_SPKI_SHA256/);
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_DATABASE_TLS_CA_MOUNT_IDENTITY/);
    assert.match(inputStep?.run ?? '', /COMMANDER_DR_EVIDENCE_JWKS_JSON/);
    assert.match(inputStep?.run ?? '', /sslmode/);
    assert.match(inputStep?.run ?? '', /PGSSLMODE=verify-full/);
    assert.match(inputStep?.run ?? '', /PGSSLROOTCERT/);
    assert.match(inputStep?.run ?? '', /must not contain private key material/);
    assert.match(proofStep?.run ?? '', /pnpm rotate:verify/);
    assert.match(proofStep?.run ?? '', /pnpm dr:verify/);
  });

  it('pins every CI Helm installation to the supported 3.17.3 runtime', () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/helm-lifecycle.yml']) {
      const parsed = load(readFileSync(join(process.cwd(), workflow), 'utf8')) as {
        jobs?: Record<string, { steps?: Array<{ uses?: string; with?: { version?: string } }> }>;
      };
      const helmSteps = Object.values(parsed.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses === 'azure/setup-helm@v4');
      assert.notEqual(helmSteps.length, 0, `${workflow} must install Helm`);
      for (const step of helmSteps) assert.equal(step.with?.version, 'v3.17.3', workflow);
    }
  });

  it('discovers PostgreSQL binaries from PATH', () => {
    for (const [script, tools, env] of [
      [
        'scripts/failover-drill.sh',
        FAILOVER_TOOLS,
        { FAILOVER_PG_BIN: '', FAILOVER_PRIMARY_PORT: '0', FAILOVER_STANDBY_PORT: '15434' },
      ],
      ['scripts/pitr-drill.sh', PITR_TOOLS, { PITR_PG_BIN: '', PITR_PORT: '0' }],
    ] as const) {
      const fixture = fakePostgresBin(tools);
      try {
        const result = runDrill(script, {
          PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
          ...env,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /port.*1\.\.65535/i);
        assert.doesNotMatch(result.stderr, /PostgreSQL binaries not found/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('preflights every PostgreSQL executable before either drill mutates state', () => {
    for (const [script, tools, binEnv, baseEnv] of [
      ['scripts/failover-drill.sh', FAILOVER_TOOLS, 'FAILOVER_PG_BIN', 'FAILOVER_BASE_DIR'],
      ['scripts/pitr-drill.sh', PITR_TOOLS, 'PITR_PG_BIN', 'PITR_BASE_DIR'],
    ] as const) {
      const fixture = fakePostgresBin(tools.filter((tool) => tool !== 'pg_basebackup'));
      const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
      try {
        const result = runDrill(script, {
          [binEnv]: fixture.bin,
          [baseEnv]: base,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /required PostgreSQL executable.*pg_basebackup/i);
        assert.deepEqual(readdirSync(base), []);
      } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('rejects invalid and duplicate failover ports before creating drill data', () => {
    const fixture = fakePostgresBin(FAILOVER_TOOLS);
    const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
    writeFileSync(join(base, 'caller-owned.txt'), 'preserve\n');
    try {
      for (const ports of [
        { FAILOVER_PRIMARY_PORT: 'not-a-port', FAILOVER_STANDBY_PORT: '15434' },
        { FAILOVER_PRIMARY_PORT: '65536', FAILOVER_STANDBY_PORT: '15434' },
        { FAILOVER_PRIMARY_PORT: '15434', FAILOVER_STANDBY_PORT: '15434' },
      ]) {
        const result = runDrill('scripts/failover-drill.sh', {
          FAILOVER_PG_BIN: fixture.bin,
          FAILOVER_BASE_DIR: base,
          ...ports,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /port/i);
        assert.equal(readFileSync(join(base, 'caller-owned.txt'), 'utf8'), 'preserve\n');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects invalid PITR ports before creating drill data', () => {
    const fixture = fakePostgresBin(PITR_TOOLS);
    const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
    writeFileSync(join(base, 'caller-owned.txt'), 'preserve\n');
    try {
      const result = runDrill('scripts/pitr-drill.sh', {
        PITR_PG_BIN: fixture.bin,
        PITR_BASE_DIR: base,
        PITR_PORT: '-1',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /port.*1\.\.65535/i);
      assert.equal(readFileSync(join(base, 'caller-owned.txt'), 'utf8'), 'preserve\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('detects an occupied port without lsof', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const fixture = fakePostgresBin(PITR_TOOLS);
    const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
    try {
      const result = runDrill('scripts/pitr-drill.sh', {
        PATH: `${fixture.bin}:/usr/local/bin:/usr/bin:/bin`,
        PITR_PG_BIN: fixture.bin,
        PITR_BASE_DIR: base,
        PITR_PORT: String(address.port),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /port.*already in use/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves caller-provided failover and PITR base directories during cleanup', async () => {
    for (const [script, tools, env] of [
      ['scripts/failover-drill.sh', FAILOVER_TOOLS, 'FAILOVER'],
      ['scripts/pitr-drill.sh', PITR_TOOLS, 'PITR'],
    ] as const) {
      const fixture = fakePostgresBin(tools, { initdb: '#!/bin/sh\nexit 23\n' });
      const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
      const marker = join(base, 'caller-owned.txt');
      writeFileSync(marker, 'preserve\n');
      const port = await unusedPort();
      try {
        const drillEnv: NodeJS.ProcessEnv = {
          [`${env}_PG_BIN`]: fixture.bin,
          [`${env}_BASE_DIR`]: base,
          [`${env === 'FAILOVER' ? 'FAILOVER_PRIMARY' : 'PITR'}_PORT`]: String(port),
        };
        if (env === 'FAILOVER') drillEnv.FAILOVER_STANDBY_PORT = String(await unusedPort());
        const result = runDrill(script, drillEnv);
        assert.equal(result.status, 23);
        assert.equal(readFileSync(marker, 'utf8'), 'preserve\n');
        assert.deepEqual(readdirSync(base), ['caller-owned.txt']);
      } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('removes owned drill state when TLS generation fails', async () => {
    for (const [script, tools, envPrefix] of [
      ['scripts/failover-drill.sh', FAILOVER_TOOLS, 'FAILOVER'],
      ['scripts/pitr-drill.sh', PITR_TOOLS, 'PITR'],
    ] as const) {
      const fixture = fakePostgresBin(tools);
      const failingOpenSsl = join(fixture.root, 'openssl');
      writeExecutable(failingOpenSsl, '#!/bin/sh\nexit 82\n');
      const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
      const primaryPort = await unusedPort();
      const standbyPort = await unusedPort();
      try {
        const drillEnv: NodeJS.ProcessEnv = {
          [`${envPrefix}_PG_BIN`]: fixture.bin,
          [`${envPrefix}_OPENSSL_BIN`]: failingOpenSsl,
          [`${envPrefix}_BASE_DIR`]: base,
          [`${envPrefix === 'FAILOVER' ? 'FAILOVER_PRIMARY' : 'PITR'}_PORT`]: String(primaryPort),
        };
        if (envPrefix === 'FAILOVER') {
          drillEnv.FAILOVER_STANDBY_PORT = String(standbyPort);
        }

        const result = runDrill(script, drillEnv);
        assert.equal(result.status, 82, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(readdirSync(base), []);
      } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('starts both drill databases with portable initdb settings and verified P-256 TLS', async () => {
    const openSslProbe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    assert.equal(openSslProbe.status, 0, 'openssl is required for the deployment drills');

    for (const [script, tools, envPrefix] of [
      ['scripts/failover-drill.sh', FAILOVER_TOOLS, 'FAILOVER'],
      ['scripts/pitr-drill.sh', PITR_TOOLS, 'PITR'],
    ] as const) {
      const logs = mkdtempSync(join(tmpdir(), 'commander-drill-tls-'));
      const initdbLog = join(logs, 'initdb.log');
      const postgresConfigLog = join(logs, 'postgresql.conf');
      const certificateLog = join(logs, 'certificate.txt');
      const workloadLog = join(logs, 'workload.log');
      const initdb = `#!/bin/bash
printf '%s\n' "$*" > "$INITDB_LOG"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-D" ]]; then data="$2"; shift 2; else shift; fi
done
mkdir -p "$data"
: > "$data/postgresql.conf"
: > "$data/pg_hba.conf"
`;
      const pgCtl = `#!/bin/bash
if [[ "$*" == *" start "* ]] && [[ ! -f "$POSTGRES_CONFIG_LOG" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-D" ]]; then data="$2"; shift 2; else shift; fi
  done
  cp "$data/postgresql.conf" "$POSTGRES_CONFIG_LOG"
  "$REAL_OPENSSL" x509 -in "$data/server.crt" -noout -text > "$CERTIFICATE_LOG"
fi
`;
      const basebackup = `#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-D" ]]; then data="$2"; shift 2; else shift; fi
done
mkdir -p "$data"
: > "$data/postgresql.conf"
`;
      const fixture = fakePostgresBin(tools, {
        initdb,
        pg_ctl: pgCtl,
        pg_basebackup: basebackup,
      });
      const fakePath = join(fixture.root, 'path');
      mkdirSync(fakePath);
      writeExecutable(
        join(fakePath, 'pnpm'),
        `#!/bin/bash
if [[ "$*" == *"drillWorkload.ts"* ]]; then
  printf 'args=%s\nca=%s\nspki=%s\n' "$*" "$COMMANDER_DATABASE_TLS_CA_FILE" "$COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256" > "$WORKLOAD_LOG"
  exit 81
fi
exit 0
`,
      );
      const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
      const primaryPort = await unusedPort();
      const standbyPort = await unusedPort();
      try {
        const drillEnv: NodeJS.ProcessEnv = {
          PATH: `${fakePath}:${process.env.PATH ?? ''}`,
          [`${envPrefix}_PG_BIN`]: fixture.bin,
          [`${envPrefix}_BASE_DIR`]: base,
          [`${envPrefix === 'FAILOVER' ? 'FAILOVER_PRIMARY' : 'PITR'}_PORT`]: String(primaryPort),
          INITDB_LOG: initdbLog,
          POSTGRES_CONFIG_LOG: postgresConfigLog,
          CERTIFICATE_LOG: certificateLog,
          WORKLOAD_LOG: workloadLog,
          REAL_OPENSSL: 'openssl',
        };
        if (envPrefix === 'FAILOVER') {
          drillEnv.FAILOVER_STANDBY_PORT = String(standbyPort);
        }

        const result = runDrill(script, drillEnv);
        assert.equal(result.status, 81, `${result.stdout}\n${result.stderr}`);
        assert.match(readFileSync(initdbLog, 'utf8'), /--locale=C/);
        assert.match(readFileSync(initdbLog, 'utf8'), /--encoding=UTF8/);

        const postgresConfig = readFileSync(postgresConfigLog, 'utf8');
        assert.match(postgresConfig, /^ssl = on$/m);
        assert.match(postgresConfig, /^ssl_cert_file = 'server\.crt'$/m);
        assert.match(postgresConfig, /^ssl_key_file = 'server\.key'$/m);

        const certificate = readFileSync(certificateLog, 'utf8');
        assert.match(certificate, /Public-Key: \(256 bit\)/);
        assert.match(certificate, /ASN1 OID: prime256v1|NIST CURVE: P-256/);
        assert.match(certificate, /IP Address:127\.0\.0\.1/);

        const workload = readFileSync(workloadLog, 'utf8');
        assert.match(workload, /sslmode=verify-full/);
        assert.match(workload, /ca=.+\/tls\/ca\.crt/);
        assert.match(workload, /spki=[a-f0-9]{64}/);
      } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(logs, { recursive: true, force: true });
      }
    }
  });

  it('fails closed when the standby does not reach the primary LSN', async () => {
    const psqlLog = join(mkdtempSync(join(tmpdir(), 'commander-psql-log-')), 'calls.log');
    const initdb = `#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-D" ]]; then data="$2"; shift 2; else shift; fi
done
mkdir -p "$data"
: > "$data/postgresql.conf"
: > "$data/pg_hba.conf"
`;
    const basebackup = `#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-D" ]]; then data="$2"; shift 2; else shift; fi
done
mkdir -p "$data"
: > "$data/postgresql.conf"
`;
    const psql = `#!/bin/bash
echo "$*" >> "$PSQL_LOG"
case "$*" in
  *pg_current_wal_lsn*) echo '0/100' ;;
  *pg_last_wal_replay_lsn*'::pg_lsn'*) echo 'f' ;;
  *pg_last_wal_replay_lsn*) echo '0/FF' ;;
esac
`;
    const fixture = fakePostgresBin(FAILOVER_TOOLS, { initdb, pg_basebackup: basebackup, psql });
    const fakePath = join(fixture.root, 'path');
    mkdirSync(fakePath);
    writeExecutable(
      join(fakePath, 'pnpm'),
      `#!/bin/bash
case "$*" in
  *drillWorkload*) echo '{"id":"run-1","tenantId":"tenant-1"}' ;;
  *'.tenantId'*) cat >/dev/null; echo 'tenant-1' ;;
  *'.id'*) cat >/dev/null; echo 'run-1' ;;
  *) cat >/dev/null 2>&1 || true ;;
esac
`,
    );
    const base = mkdtempSync(join(tmpdir(), 'commander-caller-base-'));
    const primaryPort = await unusedPort();
    const standbyPort = await unusedPort();
    try {
      const result = runDrill('scripts/failover-drill.sh', {
        PATH: `${fakePath}:${process.env.PATH ?? ''}`,
        FAILOVER_PG_BIN: fixture.bin,
        FAILOVER_BASE_DIR: base,
        FAILOVER_PRIMARY_PORT: String(primaryPort),
        FAILOVER_STANDBY_PORT: String(standbyPort),
        FAILOVER_CATCHUP_ATTEMPTS: '2',
        FAILOVER_CATCHUP_DELAY: '0',
        PSQL_LOG: psqlLog,
      });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /standby.*catch up/i);
      const psqlCalls = readFileSync(psqlLog, 'utf8');
      assert.match(psqlCalls, /pg_last_wal_replay_lsn.*'0\/100'::pg_lsn/);
      const source = readFileSync('scripts/failover-drill.sh', 'utf8');
      assert.doesNotMatch(source, /awk\s+-v/);
      assert.doesNotMatch(source, /:'target_lsn'/);
    } finally {
      rmSync(join(psqlLog, '..'), { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves the migration source and unpublished destination when copying fails', () => {
    const fixture = migrationFixture();
    const fakeBin = join(fixture.root, 'bin');
    mkdirSync(fakeBin);
    writeExecutable(join(fakeBin, 'cp'), '#!/bin/sh\nexit 71\n');
    try {
      const result = runMigration(fixture, { PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
      assert.equal(result.status, 71);
      assert.equal(existsSync(join(fixture.source, 'caller-owned.txt')), true);
      assert.equal(existsSync(fixture.destination), false);
      assert.equal(isolation(fixture.config), 'bridge');
      assert.deepEqual(
        readdirSync(join(fixture.dataRoot, 'tenants')).filter((name) =>
          name.startsWith('acme.tmp.'),
        ),
        [],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses and preserves a caller-owned migration destination', () => {
    const fixture = migrationFixture();
    mkdirSync(fixture.destination, { recursive: true });
    const marker = join(fixture.destination, 'caller-owned.txt');
    writeFileSync(marker, 'do not delete\n');
    try {
      const result = runMigration(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /destination already exists/i);
      assert.equal(readFileSync(marker, 'utf8'), 'do not delete\n');
      assert.equal(existsSync(join(fixture.source, 'caller-owned.txt')), true);
      assert.equal(isolation(fixture.config), 'bridge');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('removes only its destination when the migration config update fails', () => {
    const fixture = migrationFixture();
    const fakeBin = join(fixture.root, 'bin');
    const countFile = join(fixture.root, 'python-count');
    mkdirSync(fakeBin);
    writeExecutable(
      join(fakeBin, 'python3'),
      `#!/bin/bash
count=0
[[ -f "$PYTHON_COUNT_FILE" ]] && count=$(cat "$PYTHON_COUNT_FILE")
echo $((count + 1)) > "$PYTHON_COUNT_FILE"
if [[ $count -ge 1 ]]; then exit 72; fi
exec "$REAL_PYTHON" "$@"
`,
    );
    const realPython = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
    assert(realPython);
    try {
      const result = runMigration(fixture, {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PYTHON_COUNT_FILE: countFile,
        REAL_PYTHON: realPython,
      });
      assert.equal(result.status, 1);
      assert.equal(existsSync(join(fixture.source, 'caller-owned.txt')), true);
      assert.equal(existsSync(fixture.destination), false);
      assert.equal(isolation(fixture.config), 'bridge');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('leaves a recoverable active destination when migration source deletion fails', () => {
    const fixture = migrationFixture();
    const fakeBin = join(fixture.root, 'bin');
    mkdirSync(fakeBin);
    writeExecutable(
      join(fakeBin, 'rm'),
      `#!/bin/bash
for argument in "$@"; do
  [[ "$argument" == "$FAIL_RM_TARGET" ]] && exit 73
done
exec /bin/rm "$@"
`,
    );
    try {
      const result = runMigration(fixture, {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAIL_RM_TARGET: fixture.source,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /failed to remove source.*destination remains active.*retained/i);
      assert.equal(isolation(fixture.config), 'silo');
      assert.equal(existsSync(join(fixture.source, 'caller-owned.txt')), true);
      assert.equal(
        readFileSync(join(fixture.destination, 'caller-owned.txt'), 'utf8'),
        'preserve me\n',
      );
      assert.equal(existsSync(join(fixture.destination, '.commander-migrate-tenant-owned')), true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses BSD and GNU stat syntax for the host docker socket fallback', async () => {
    const previous = process.env.DOCKER_GID;
    process.env.DOCKER_GID = '0';
    const { resolveDockerGid } = await import('./l4-b-cell-compose.js');
    if (previous === undefined) delete process.env.DOCKER_GID;
    else process.env.DOCKER_GID = previous;

    for (const [platform, expected] of [
      ['darwin', 'stat -f %g'],
      ['linux', 'stat -c %g'],
    ] as const) {
      const commands: string[] = [];
      const gid = resolveDockerGid({
        env: {},
        platform,
        execute(command: string): string {
          commands.push(command);
          if (command.startsWith('docker run')) throw new Error('docker unavailable');
          return '991';
        },
      });
      assert.equal(gid, '991');
      assert.equal(
        commands.some((command) => command.startsWith(expected)),
        true,
      );
    }
  });

  it('prevents the live TLS fixture from silently connecting to an occupied host port', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts/task1-postgres-tls-fixture-run.sh'),
      'utf8',
    );
    assert.match(source, /allocate_fixture_ports/);
    assert.match(source, /assert_port_available/);
    assert.match(source, /cat \/proc\/1\/comm/);
    assert.match(source, /commander_adapter_ops/);
  });
});
