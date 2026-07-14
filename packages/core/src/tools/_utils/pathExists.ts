import { reportSilentFailure } from '../../silentFailureReporter';
import { access, constants } from 'node:fs/promises';

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
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (err) {
    reportSilentFailure(err, 'pathExists');
    return false;
  }
}
