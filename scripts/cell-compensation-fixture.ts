import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CELL_COMPOSE_ENV, CELL_E2E_TENANT, COMPOSE_CMD } from './l4-b-cell-compose.js';

export const COMPENSATION_COMPOSE_CMD = `${COMPOSE_CMD} -f docker-compose.cell-e2e.yml`;

export function prepareCompensationFixture(): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'commander-cell-github-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-subj',
      '/CN=api.github.com',
      '-addext',
      'subjectAltName=DNS:api.github.com',
    ],
    { stdio: 'pipe' },
  );
  chmodSync(join(directory, 'key.pem'), 0o600);
  chmodSync(join(directory, 'cert.pem'), 0o644);
  return {
    CELL_GITHUB_TLS_DIR: directory,
    CELL_GITHUB_TOKEN: randomBytes(32).toString('hex'),
    CELL_GITHUB_ORACLE_TOKEN: randomBytes(32).toString('hex'),
  };
}

export function fixtureCompose(
  fixtureEnv: Record<string, string>,
  args: string[],
  input?: string,
): string {
  // The command prefix contains only repository-owned, space-free file names.
  return execFileSync('docker', [...COMPENSATION_COMPOSE_CMD.split(' ').slice(1), ...args], {
    env: { ...process.env, ...CELL_COMPOSE_ENV, ...fixtureEnv },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/** Owner-side fixture provisioning; runtime roles cannot invent allowlist policy. */
export function seedCompensationFixturePolicy(fixtureEnv: Record<string, string>): void {
  fixtureCompose(
    fixtureEnv,
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '--username',
      'commander_owner',
      '--dbname',
      'commander',
      '--set',
      'ON_ERROR_STOP=1',
      '--set',
      `tenant=${CELL_E2E_TENANT}`,
    ],
    `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed)
      VALUES (:'tenant', 'connector.github.pull-request.create', true),
             (:'tenant', 'compensate.github.pull-request.create', true)
      ON CONFLICT (tenant_id, action_pattern) DO UPDATE SET allowed = true;`,
  );
}

/** The independent provider must see exactly one creation and one closure. */
export function verifyCompensationFixture(fixtureEnv: Record<string, string>): boolean {
  const script = `fetch('https://api.github.com/__cell__/state', {
    headers: { Authorization: 'Bearer ' + process.env.CELL_GITHUB_ORACLE_TOKEN }
  }).then(async response => {
    if (!response.ok) throw new Error('fixture evidence unavailable');
    process.stdout.write(JSON.stringify(await response.json()));
  }).catch(() => process.exit(1));`;
  const state: unknown = JSON.parse(
    fixtureCompose(fixtureEnv, ['exec', '-T', 'github-fixture', 'node', '-e', script]),
  );
  if (!state || typeof state !== 'object') return false;
  const evidence = state as { createCalls?: unknown; closeCalls?: unknown; pulls?: unknown };
  return (
    evidence.createCalls === 1 &&
    evidence.closeCalls === 1 &&
    Array.isArray(evidence.pulls) &&
    evidence.pulls.length === 1 &&
    evidence.pulls[0]?.state === 'closed'
  );
}
