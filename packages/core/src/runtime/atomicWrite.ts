/**
 * Crash-safe file persistence helpers (REL-3 / REL-4).
 *
 * `writeFileSync(path, data)` truncates the target and streams bytes in place, so
 * a crash mid-write leaves a half-written / truncated file that later fails to
 * parse — crash-looping boot paths or silently losing all state. These helpers
 * make writes atomic and make reads corruption-tolerant.
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
  // Best-effort directory fsync so the rename is durable. Not supported on every
  // platform (e.g. Windows / some FUSE mounts), so failures here are swallowed.
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
 * Async counterpart to {@link atomicWriteFileSync}, for callers already on the
 * fs/promises path (WAL compaction, memory-cache flush). Same durability: tmp →
 * fsync → rename → directory fsync.
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, filePath);
  try {
    const dh = await fs.promises.open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
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
