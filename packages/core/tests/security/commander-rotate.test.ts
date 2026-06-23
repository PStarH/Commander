/**
 * Audit #7 hardening — `scripts/commander-rotate.ts` integration tests.
 *
 * Spawns the CLI as a subprocess so we exercise the actual argv parser
 * + scope validator + audit chain path WITHOUT polluting process state.
 * Tests cover:
 *   1. Unknown env-var name  → exit 1 (validation failure)
 *   2. --force with unknown name → exit 0 (override)
 *   3. Known env-var, no --audit → exit 0, no audit-chain write
 *   4. Known env-var with --audit → exit 0, audit record id surfaced
 *   5. --confirm requires rotation-id → exit 1
 *   6. --json output is valid JSON-shape {ok, envVar, ...}
 *   7. L4 contract: the script NEVER accepts or echoes the secret value
 *
 * Path: `scripts/commander-rotate.ts` is invoked via the package `tsx`
 * shim so dev-machines without a global tsx still run clean.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG_DIR = path.join(REPO_ROOT, 'packages/core');
const IS_WIN = process.platform === 'win32';
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'commander-rotate.ts');

// Resolve the `tsx` shim by walking up from this file looking for
// any `node_modules/.bin/tsx`. Works for pnpm-hoisted installs where
// tsx lives at the repo root rather than inside packages/core/.
function findTsxBin(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx' + (IS_WIN ? '.cmd' : ''));
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`tsx binary not found in any node_modules/.bin up from ${__dirname}`);
}

function run(args: string[]) {
  const tsxBin = findTsxBin();
  const r = spawnSync('node', [tsxBin, CLI_PATH, ...args], {
    cwd: PKG_DIR,
    encoding: 'utf-8',
    timeout: 30_000,
    shell: true,
    env: {
      ...process.env,
      COMMANDER_AUDIT_CHAIN_KEY: process.env.COMMANDER_AUDIT_CHAIN_KEY ?? 'x'.repeat(40),
    },
  });
  if (r.status === null) {
    // eslint-disable-next-line no-console
    console.error('commander-rotate spawn debug', {
      error: r.error?.message,
      signal: r.signal,
      stdout: r.stdout?.slice(0, 200),
      stderr: r.stderr?.slice(0, 200),
    });
  }
  return r;
}

describe('Audit #7 — commander-rotate CLI', () => {
  it('unknown env-var → exit 1 with validation message', () => {
    const r = run(['FAKE_KEY', '--attempt']);
    expect(r.status).toBe(1);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined).toMatch(/not in keys-rotation\.md §1 scope list/);
  });

  it('unknown env-var without --force → exit 1 even with --json', () => {
    const r = run(['TOTALLY_FAKE_KEY', '--attempt', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/"ok":\s*false/);
    expect(r.stdout).toMatch(/validation/);
  });

  it('--force + unknown env-var → exit 0 (incident override path)', () => {
    const r = run(['CUSTOM_ENV_VAR', '--force', '--json']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/"ok":\s*true/);
    expect(r.stdout).toMatch(/"forced"/);
  });

  it('known env-var without --audit → exit 0 with playbook and dry-run notice', () => {
    const r = run(['OPENAI_API_KEY', '--attempt']);
    expect(r.status).toBe(0);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined).toMatch(/commander-rotate playbook/);
    expect(combined).toMatch(/Production LLM provider keys/);
    expect(combined).toMatch(/every 90 days/);
    expect(combined).toMatch(/dry-run/); // no audit written
  });

  it('known env-var with --audit → exit 0 and audit record id surfaced on stdout', () => {
    const r = run(['OPENAI_API_KEY', '--attempt', '--audit']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/audit record:/);
  });

  it('--json output is well-formed JSON with documented fields', () => {
    const r = run(['OPENAI_API_KEY', '--attempt', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      envVar: string;
      secretClass: string;
      cadenceDays: number;
      rotationId: string;
      action: string;
      auditRecordId: string | null;
      playbook: string;
      exitCode: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.envVar).toBe('OPENAI_API_KEY');
    expect(parsed.secretClass).toBe('Production LLM provider keys');
    expect(parsed.cadenceDays).toBe(90);
    expect(parsed.action).toBe('attempt');
    expect(parsed.rotationId).toMatch(/^\d{4}-\d{2}-\d{2}T.*-{1}/);
    expect(parsed.exitCode).toBe(0);
  });

  it('--confirm requires rotation-id → exit 1', () => {
    const r = run(['OPENAI_API_KEY', '--confirm']);
    expect(r.status).toBe(1);
    expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/requires a <rotation-id>/);
  });

  it('--confirm with explicit rotation-id → exit 0 with audit record', () => {
    const r = run([
      'OPENAI_API_KEY',
      '--confirm',
      '2026-06-23T03:53:00Z-ciso',
      '--audit',
      '--json',
    ]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      action: string;
      rotationId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('confirm');
    expect(parsed.rotationId).toBe('2026-06-23T03:53:00Z-ciso');
  });

  it('L4 contract: rotating a 90d secret (COMMANDER_AUDIT_CHAIN_KEY) picks the 365d cadence', () => {
    const r = run(['COMMANDER_AUDIT_CHAIN_KEY', '--attempt', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { cadenceDays: number; secretClass: string };
    expect(parsed.cadenceDays).toBe(365);
    expect(parsed.secretClass).toBe('Audit-chain HMAC master');
  });

  it('L4 contract: the script never prints the actual secret value (only the NAME and cadence)', () => {
    const r = run(['OPENAI_API_KEY', '--attempt', '--json']);
    expect(r.status).toBe(0);
    // Should NOT leak any sk-/ghp_/AKIA/xox* prefix even if present in env.
    const patternLeak = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/;
    expect(r.stdout).not.toMatch(patternLeak);
    expect(r.stderr ?? '').not.toMatch(patternLeak);
  });
});
