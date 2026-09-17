import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type RunResult = { status: number; output: string };

/**
 * Run a command and capture its output **and** exit status.
 *
 * `execFileSync` throws on a non-zero exit, which would hide the gate's own
 * failure report — and that report is the useful part, so capture it.
 */
function capture(command: string, args: string[]): RunResult {
  try {
    const output = execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    const combined = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      output: combined.trim().length > 0 ? combined : (e.message ?? ''),
    };
  }
}

/**
 * These gates used to be invoked as `pnpm arch:gate` / `pnpm arch:guard`.
 *
 * `pnpm` is not guaranteed to be on `PATH` (it is absent in this repository's
 * development sandbox), so `execFileSync('pnpm', …)` threw `ENOENT` and the test
 * failed with "spawnSync pnpm ENOENT" — which meant **the gate's actual verdict
 * was never observed**. That masked a red constitution guard. The npm scripts
 * are thin wrappers around plain node/bash commands:
 *
 *   arch:gate  -> pnpm exec node --import tsx scripts/architecture-gate.ts
 *   arch:guard -> bash scripts/arch-guard.sh
 *
 * Invoke the underlying command directly: no `pnpm` dependency, no shell
 * wrapper, and the failure report is captured for the assertion message.
 */
describe('legacy authority architecture gates', () => {
  it('passes the Architecture V2 source gate', () => {
    const { status, output } = capture(process.execPath, [
      '--import',
      'tsx',
      'scripts/architecture-gate.ts',
    ]);
    assert.equal(status, 0, `architecture gate must exit 0; got:\n${output}`);
    assert.match(output, /Architecture V2 gate passed/);
  });

  it('passes the package constitution guard', () => {
    const { status, output } = capture('bash', ['scripts/arch-guard.sh']);
    assert.equal(status, 0, `constitution guard must exit 0; got:\n${output}`);
    assert.match(output, /Architecture constitution guard passed/);
  });
});
