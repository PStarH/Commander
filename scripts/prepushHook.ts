/**
 * scripts/prepushHook.ts — D3 hardening-sprint pre-push format gate.
 *
 * Closes the dual-classifier refactor style-violation gap (commit 765b41430,
 * extracted normalizeForMatch primitives). Previously a lone }export interface
 * concatenation shipped to remote CI because no local gate enforced Prettier
 * before push. This hook is the belt-and-suspenders check.
 *
 * Behaviour:
 *   1. Run the Prettier check against the files introduced by the
 *      pending ref updates. Existing baseline formatting debt must not block
 *      an unrelated, formatted change from reaching CI. CI replay mode accepts
 *      explicit paths in process.argv.slice(2).
 *   2. Exit 0 on clean, 1 on any violation. Output streams Prettier's
 *      native CLI reporting (the same shape users see when running
 *      pnpm exec prettier --check manually) — keeps the message format
 *      familiar so push failures map to known-fix actions.
 *
 * Why shell out to pnpm exec prettier --check instead of using the
 * prettier Node API directly?
 *   • Same resolver as the root format:check script — keeps the failure
 *     mode (exit code, output format) consistent with what users see when
 *     they run it manually, so the hook output feels familiar.
 *   • Avoids depending on a specific prettier version pinned in TS code —
 *     uses whatever the workspace has installed via pnpm-lock.yaml,
 *     matching the project's packageManagement intent.
 *   • Lets the .githooks/pre-push PATH-export fix from commit 4fd97dea7
 *     carry over verbatim — pnpm-resolved binaries resolve directly.
 *
 * Halt switch: COMMANDER_SKIP_PREPUSH=1 (handled in .githooks/pre-push).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── Configuration ────────────────────────────────────────────────────────

// `GIT_DIR` points into the common repository when this runs from a linked
// worktree, so deriving a parent path from it resolves to `.git`, not the
// checked-out source tree. Ask Git for the worktree root directly.
// `git rev-parse` handles that correctly in every context, including linked
// worktrees, so derive the worktree root through Git and fall back to cwd if
// Git is unavailable (e.g. CI argv replay with no git context).
function resolveRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

const REPO_ROOT = resolveRepoRoot();

const PRETTIER_FILE = /\.(?:ts|tsx)$/;
const NULL_OBJECT_ID = /^0+$/;

// ── Helpers ──────────────────────────────────────────────────────────────

interface PrettierResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run pnpm exec prettier --check <paths...>. Captures stdout/stderr/exit
 * code without throwing on non-zero exit — prettier's failure messages
 * are the warning the user needs to see, so we capture and forward them.
 *
 * The shell-level escape hatch handles shell metacharacters inside the
 * path args; since these are repo-relative literal strings (no globs at
 * the shell level — prettier handles glob expansion), we can use
 * { shell: false } for safety.
 */
function runPrettierCheck(targetPaths: readonly string[]): PrettierResult {
  const cmdArgs = ['exec', 'prettier', '--check', ...targetPaths];
  try {
    const out = execFileSync('pnpm', cmdArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: out, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    // execFileSync only throws on non-zero exit. err has stdout/stderr/
    // status properties populated; treat undefined as "not provided".
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      message?: string;
    };
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? 'prettier exited: ' + (e.message ?? 'unknown error'),
      exitCode: e.status ?? null,
    };
  }
}

function gitOutput(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function changedPathsFromRefUpdates(input: string): string[] {
  const changed = new Set<string>();
  for (const line of input.split('\n')) {
    const [localRef, local, remoteRef, remote] = line.trim().split(/\s+/);
    if (!localRef || !local || !remoteRef || !remote || NULL_OBJECT_ID.test(local)) continue;
    const args = NULL_OBJECT_ID.test(remote)
      ? ['diff-tree', '--no-commit-id', '--name-only', '--root', '-r', '--diff-filter=ACMR', local]
      : ['diff', '--name-only', '--diff-filter=ACMR', remote, local];
    for (const path of gitOutput(args).split('\n')) {
      if (PRETTIER_FILE.test(path)) changed.add(path);
    }
  }
  return [...changed].sort();
}

function changedPaths(): string[] {
  const replayPaths =
    process.env.CORE_PREPUSH_HOOK === '1'
      ? process.argv.slice(2).filter((path) => PRETTIER_FILE.test(path))
      : [];
  if (replayPaths.length > 0) return [...new Set(replayPaths)].sort();
  return changedPathsFromRefUpdates(readFileSync(0, 'utf8'));
}

// ── Main ─────────────────────────────────────────────────────────────────

(function main(): void {
  let paths: string[];
  try {
    paths = changedPaths();
  } catch (error) {
    console.error('[D3 pre-push] Cannot determine changed paths: ' + (error as Error).message);
    process.exit(1);
  }

  if (paths.length === 0) {
    console.log('[D3 pre-push] No changed TypeScript paths to format-check.');
    process.exit(0);
  }

  console.log('[D3 pre-push] Prettier check on ' + paths.length + ' changed path(s):');
  for (const path of paths) console.log('  • ' + path);

  const result = runPrettierCheck(paths);

  if (result.ok) {
    console.log('[D3 pre-push] Prettier clean for changed paths ✅');
    process.exit(0);
  }

  // Failure path — surface Prettier's native output verbatim so users
  // see EXACTLY the file:line Prettier rejects, plus our remediation hint.
  console.error('\n❌ [D3 pre-push] Prettier check FAILED on changed paths.\n');
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.error('To fix:');
  console.error('  1. Auto-fix:  pnpm exec prettier --write ' + paths.join(' '));
  console.error('  2. Manual:   open the listed files and adjust formatting, then re-push.');
  console.error('  3. Bypass:   COMMANDER_SKIP_PREPUSH=1 git push ...   (logged warning)');
  console.error('');
  // Use the captured exit code if available — preserves prettier's own
  // exit semantics (1 = some files need formatting; 2 = something broke)
  // for any downstream tooling that wants to distinguish them.
  process.exit(result.exitCode ?? 1);
})();
