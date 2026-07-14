import { reportSilentFailure as defaultReportSilentFailure } from '../../silentFailureReporter';
import { access as defaultAccess, constants } from 'node:fs/promises';

export type PathExistsAccess = (path: string, mode?: number) => Promise<void> | void;
export type PathExistsReport = (error: unknown, context: string) => void;

/**
 * Async equivalent of `fs.existsSync`.
 *
 * Used throughout `packages/core/src/tools/` to replace sync `existsSync`
 * calls so the event loop is not blocked during filesystem probes.
 *
 * Errors (typically ENOENT) are swallowed via `reportSilentFailure` so the
 * behavior matches existsSync's boolean contract (no throw on missing file).
 * Any other error (EACCES on a directory we shouldn't traverse, for example)
 * is treated as "not accessible" and surfaced via the silent-failure channel
 * for audit/observability rather than propagated.
 *
 * Optional `access` / `report` inject implementations for unit tests — Vitest 4
 * + package `type:module` cannot reliably intercept Node builtin or local
 * named ESM bindings via `vi.mock`.
 */
export async function pathExists(
  p: string,
  access: PathExistsAccess = defaultAccess,
  report: PathExistsReport = defaultReportSilentFailure,
): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (err) {
    report(err, 'pathExists');
    return false;
  }
}
