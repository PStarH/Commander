import { pathToFileURL } from 'node:url';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';

export type MigrationGateMode = 'preflight' | 'await';
export type MigrationGateTarget = { name: string; connectionString: string };
export type MigrationGateDescriptors = Record<string, string>;
export type MigrationGateProbe = (
  target: MigrationGateTarget,
  descriptors: MigrationGateDescriptors,
) => Promise<void>;

const PREFLIGHT_ROLES = ['OWNER', 'APP', 'TENANT_AUTHORITY', 'SCHEDULER', 'WORKER', 'ADAPTER_OPS'];
const CHECKSUM = /^[a-f0-9]{64}$/;
const DESCRIPTOR = /^[A-Za-z0-9._-]+$/;

export function parseMigrationGateMode(args: readonly string[]): MigrationGateMode {
  if (args.length !== 1 || (args[0] !== 'preflight' && args[0] !== 'await')) {
    throw new Error('MIGRATION_GATE_MODE_INVALID');
  }
  return args[0];
}

export function migrationGateTargets(
  mode: MigrationGateMode,
  env: NodeJS.ProcessEnv = process.env,
): MigrationGateTarget[] {
  if (mode === 'await') {
    const connectionString = env.COMMANDER_KERNEL_DATABASE_URL;
    if (!connectionString) throw new Error('MIGRATION_GATE_DATABASE_URL_MISSING');
    return [{ name: 'RUNTIME', connectionString }];
  }
  return PREFLIGHT_ROLES.map((role) => {
    const connectionString = env['COMMANDER_PREFLIGHT_' + role + '_DATABASE_URL'];
    if (!connectionString) throw new Error('MIGRATION_GATE_DATABASE_URL_MISSING');
    return { name: role, connectionString };
  });
}

export function parseExpectedMigrationDescriptors(
  raw: string | undefined,
): MigrationGateDescriptors {
  const source = raw ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
  }
  const result: MigrationGateDescriptors = {};
  for (const [id, checksum] of Object.entries(parsed)) {
    if (!DESCRIPTOR.test(id) || typeof checksum !== 'string' || !CHECKSUM.test(checksum)) {
      throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
    }
    result[id] = checksum;
  }
  return result;
}

async function probeDatabase(
  target: MigrationGateTarget,
  descriptors: MigrationGateDescriptors,
): Promise<void> {
  const pool = createVerifiedPostgresPool({ connectionString: target.connectionString, max: 1 });
  try {
    await pool.query('SELECT 1');
    const ids = Object.keys(descriptors);
    if (ids.length === 0) return;
    const result = await pool.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM public.commander_kernel_migrations WHERE id = ANY($1::text[])',
      [ids],
    );
    const actual = Object.fromEntries(result.rows.map(({ id, checksum }) => [id, checksum]));
    if (ids.some((id) => actual[id] !== descriptors[id])) {
      throw new Error('MIGRATION_GATE_DESCRIPTORS_NOT_READY');
    }
  } finally {
    await pool.end();
  }
}

export async function runMigrationGateAttempt(
  mode: MigrationGateMode,
  env: NodeJS.ProcessEnv = process.env,
  probe: MigrationGateProbe = probeDatabase,
): Promise<void> {
  const descriptors = parseExpectedMigrationDescriptors(
    env.COMMANDER_MIGRATION_EXPECTED_DESCRIPTORS,
  );
  await Promise.all(migrationGateTargets(mode, env).map((target) => probe(target, descriptors)));
}

function timeoutSeconds(mode: MigrationGateMode, env: NodeJS.ProcessEnv): number {
  const raw = env.COMMANDER_DATABASE_WAIT_TIMEOUT_SECONDS;
  if (raw === undefined && mode === 'await') return 120;
  const seconds = Number(raw ?? 120);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error('MIGRATION_GATE_TIMEOUT_INVALID');
  }
  return seconds;
}

function diagnostic(mode: MigrationGateMode, error: unknown): string {
  const code =
    error instanceof Error && /^[A-Z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : 'MIGRATION_GATE_DATABASE_UNAVAILABLE';
  return 'COMMANDER_MIGRATION_FAILED stage=' + mode + ' code=' + code;
}

async function main(): Promise<void> {
  const mode = parseMigrationGateMode(process.argv.slice(2));
  const deadline = Date.now() + timeoutSeconds(mode, process.env) * 1000;
  let lastError: unknown;
  do {
    try {
      await runMigrationGateAttempt(mode);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (Date.now() < deadline);
  throw new Error(diagnostic(mode, lastError));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'COMMANDER_MIGRATION_FAILED') + '\n',
    );
    process.exitCode = 1;
  });
}
