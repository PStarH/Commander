/**
 * Crash-safe file persistence helpers (REL-3 / REL-4).
 *
 * `writeFileSync(path, data)` truncates the target and streams bytes in place, so
 * a crash mid-write leaves a half-written / truncated file that later fails to
 * parse — crash-looping boot paths (`WarRoomStore.load`) or silently losing all
 * state (`AgentStateStore`). These helpers make writes atomic and reads
 * corruption-tolerant.
 *
 * NOTE: kept in sync with `packages/core/src/runtime/atomicWrite.ts`; the two
 * copies avoid a cross-package build-order dependency. Dedupe when a shared
 * `@commander/*` fs utility exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Atomically write a file: write to a temp file in the same directory, fsync the
 * contents to disk, rename over the target (atomic on a POSIX same-filesystem
 * rename), then fsync the directory so the rename itself survives power loss.
 * A crash can never observe a half-written or truncated target.
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync is best-effort */
  }
}

/**
 * Read and JSON.parse a file, quarantining a corrupt file instead of letting the
 * parse throw (which can crash-loop a boot path) or silently discarding it (which
 * lets the next write overwrite recoverable state permanently). On parse failure
 * the corrupt file is moved aside to `<file>.corrupt-<ts>` and `fallback` is
 * returned so the caller can reseed. Returns `fallback` when the file is absent.
 */
export function readJsonFileSafe<T>(filePath: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      /* quarantine is best-effort — never throw from a load path */
    }
    return fallback;
  }
}
