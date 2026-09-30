import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeFileSync,
  chownSync,
  chmodSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROLE_SOURCES = [
  ['COMMANDER_OWNER_DATABASE_URL', 'commander_owner', '__COMMANDER_OWNER_PASSWORD__'],
  ['COMMANDER_APP_DATABASE_URL', 'commander_app', '__COMMANDER_APP_PASSWORD__'],
  [
    'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
    'commander_tenant_authority',
    '__COMMANDER_TENANT_AUTHORITY_PASSWORD__',
  ],
  ['COMMANDER_SCHEDULER_DATABASE_URL', 'commander_scheduler', '__COMMANDER_SCHEDULER_PASSWORD__'],
  ['COMMANDER_WORKER_DATABASE_URL', 'commander_worker', '__COMMANDER_WORKER_PASSWORD__'],
  [
    'COMMANDER_ADAPTER_OPS_DATABASE_URL',
    'commander_adapter_ops',
    '__COMMANDER_ADAPTER_OPS_PASSWORD__',
  ],
] as const;

function rolePassword(env: NodeJS.ProcessEnv, source: readonly [string, string, string]): string {
  const [name, expectedUser] = source;
  const raw = env[name]?.trim();
  if (!raw) throw new Error('TASK1_POSTGRES_INIT_CREDENTIAL_REQUIRED');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TASK1_POSTGRES_INIT_CREDENTIAL_INVALID');
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error('TASK1_POSTGRES_INIT_CREDENTIAL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    username !== expectedUser ||
    !password ||
    password.includes('\0')
  ) {
    throw new Error('TASK1_POSTGRES_INIT_CREDENTIAL_INVALID');
  }
  return password;
}

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function renderTask1PostgresInit(template: string, env: NodeJS.ProcessEnv): string {
  let rendered = template;
  for (const source of ROLE_SOURCES) {
    if (!rendered.includes(source[2])) {
      throw new Error('TASK1_POSTGRES_INIT_TEMPLATE_INVALID');
    }
  }
  const credentials = ROLE_SOURCES.map((source) => ({
    name: source[0],
    marker: source[2],
    password: rolePassword(env, source),
  }));
  const passwordFor = (name: (typeof ROLE_SOURCES)[number][0]): string =>
    credentials.find((credential) => credential.name === name)!.password;
  const inherited = [
    passwordFor('COMMANDER_OWNER_DATABASE_URL'),
    passwordFor('COMMANDER_APP_DATABASE_URL'),
    passwordFor('COMMANDER_SCHEDULER_DATABASE_URL'),
    passwordFor('COMMANDER_WORKER_DATABASE_URL'),
  ];
  const adapterOps = passwordFor('COMMANDER_ADAPTER_OPS_DATABASE_URL');
  const tenantAuthority = passwordFor('COMMANDER_TENANT_AUTHORITY_DATABASE_URL');
  if (
    adapterOps === tenantAuthority ||
    inherited.includes(adapterOps) ||
    inherited.includes(tenantAuthority)
  ) {
    throw new Error('TASK1_POSTGRES_INIT_CREDENTIAL_INVALID');
  }
  for (const { marker, password } of credentials) {
    rendered = rendered.replaceAll(marker, sqlLiteral(password));
  }
  if (/__COMMANDER_[A-Z_]+__/.test(rendered)) {
    throw new Error('TASK1_POSTGRES_INIT_TEMPLATE_INVALID');
  }
  return rendered;
}

export function materializeTask1PostgresInit(
  sourceFile: string,
  targetFile: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const rendered = renderTask1PostgresInit(readFileSync(sourceFile, 'utf8'), env);
  const descriptor = openSync(
    targetFile,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    writeFileSync(descriptor, rendered, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  chownSync(targetFile, 70, 70);
  chmodSync(targetFile, 0o400);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    materializeTask1PostgresInit(
      process.env.COMMANDER_POSTGRES_INIT_TEMPLATE_FILE ?? '/source/postgres-init.sql',
      process.env.COMMANDER_POSTGRES_INIT_TARGET_FILE ?? '/runtime/postgres-init.sql',
    );
    process.stdout.write('TASK1_POSTGRES_INIT_MATERIALIZED\n');
  } catch {
    process.stderr.write('TASK1_POSTGRES_INIT_MATERIALIZATION_FAILED\n');
    process.exitCode = 1;
  }
}
