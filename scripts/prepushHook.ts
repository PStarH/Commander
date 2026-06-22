/**
 * scripts/prepushHook.ts — D3 hardening-sprint pre-push format gate.
 *
 * Closes the dual-classifier refactor style-violation gap (commit 765b41430,
 * extracted normalizeForMatch primitives). Previously a lone `}export interface`
 * concatenation shipped to remote CI because no local gate enforced Prettier
 * before push. This hook is the belt-and-suspenders check.
 *
 * Behaviour:
 *   1. Run `pnpm exec prettier --check` against PUSH_BASELINE_PATHS (every
 *      directory in the development surface where a style violation could
 *      ride along to remote CI). When invoked in CI replay mode
 *      (CORE_PREPUSH_HOOK=1, GIT_DIR undefined), bypass-git files come from
 *      `process.argv.slice(2)` so the same script can be driven from a
 *      pipeline without a git context.
 *   2. Exit 0 on clean, 1 on any violation. Output streams Prettier's
 *      native CLI reporting (the same shape users see when running
 *      `pnpm exec prettier --check` manually) — keeps the message format
 *      familiar so push failures map to known-fix actions.
 *
 * Why shell out to `pnpm exec prettier --check` instead of using the
 * prettier Node API directly?
 *   • Same resolver as the root `format:check` script — keeps the failure
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
import * as path from 'node:path';

// ── Configuration ────────────────────────────────────────────────────────

// Resolve REPO_ROOT from GIT_DIR if present (git hook context) — same
// convention used by scripts/precommitHook.ts so the two hooks share dir-
// resolution semantics. Falls back to process.cwd() for CI replay.
const REPO_ROOT = process.env.GIT_DIR
  ? path.dirname(path.dirname(process.env.GIT_DIR))
  : process.cwd();

// PUSH_BASELINE_PATHS — the development surface where Prettier violations
// matter. Belt-and-suspenders scope: every directory a refactor's style
// drift could reach.
//
// DC11/forward-compat: GLOBS use a single-component wildcard `*` for the
// package/app name rather than hard-coded package names. Future contributors
// adding `packages/<new>/src/` or `apps/<new>/src/` silently inherit this
// gate without needing to update this list — closing the per-package
// exclusion regression the original hardcoded list could regress into.
//
// Coverage rationale (each pattern tied to a specific incident or risk):
//   • packages/*/src/   — primary development surface; the dual-
//     classifier refactor extracted normalizeForMatch primitives here
//     (commit 765b41430) and missed a blank-line insertion. THIS was the
//     immediate gap.
//   • packages/*/tests/ — observability test files touched in commit
//     1cbfb1c95 (traceContextBridge.test.ts cascade, autoScorer.test.ts,
//     evalHttpEndpoints.test.ts) had their own latent style drift.
//   • apps/*/src/      — backend API + web UI code. Covered by root
//     format:check; included here so the hook matches the user's "or
//     broader" intent and surfaces drift before remote CI rejects it.
//   • scripts/         — benchmark-gaia.ts (the dual-classifier
//     scenario file) lives at the repo root, separate from packages.
//     Including it prevents scripts/ drift while the refactor lands.
const PUSH_BASELINE_PATHS: readonly string[] = [
  'packages/*/src/**/*.{ts,tsx}',
  'packages/*/tests/**/*.ts',
  'apps/*/src/**/*.{ts,tsx}',
  'scripts/**/*.ts',
];

// ── Helpers ──────────────────────────────────────────────────────────────

interface PrettierResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run `pnpm exec prettier --check <paths...>`. Captures stdout/stderr/exit
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
      stderr: e.stderr?.toString?.() ?? `prettier exited: ${e.message ?? 'unknown error'}`,
      exitCode: e.status ?? null,
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

(function main(): void {
  console.log(`[D3 pre-push] Prettier baseline check on ${PUSH_BASELINE_PATHS.length} path(s):`);
  for (const p of PUSH_BASELINE_PATHS) console.log(`  • ${p}`);

  const result = runPrettierCheck(PUSH_BASELINE_PATHS);

  if (result.ok) {
    console.log('[D3 pre-push] Prettier clean across baseline ✅');
    process.exit(0);
  }

  // Failure path — surface Prettier's native output verbatim so users
  // see EXACTLY the file:line Prettier rejects, plus our remediation hint.
  console.error('\n❌ [D3 pre-push] Prettier check FAILED on baseline.\n');
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.error('To fix:');
  console.error(`  1. Auto-fix:  pnpm exec prettier --write ${PUSH_BASELINE_PATHS.join(' ')}`);
  console.error('  2. Manual:   open the listed files and adjust formatting, then re-push.');
  console.error('  3. Bypass:   COMMANDER_SKIP_PREPUSH=1 git push ...   (logged warning)');
  console.error('');
  // Use the captured exit code if available — preserves prettier's own
  // exit semantics (1 = some files need formatting; 2 = something broke)
  // for any downstream tooling that wants to distinguish them.
  process.exit(result.exitCode ?? 1);
})();
