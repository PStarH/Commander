import { reportSilentFailure } from '../../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AtomicWriteResult {
  path: string;
  bytes: number;
  tmpPath: string;
}

/**
 * Write a file atomically: write to a uniquely-named temp file in the same
 * directory, fsync, then rename. A crash at any point leaves either the
 * old file intact or the new file complete — never a half-written file.
 *
 * Why same-directory: rename(2) is atomic only on the same filesystem.
 * Placing the temp file next to the target (not in /tmp) keeps the rename
 * atomic and lets the file inherit the target's directory permissions.
 *
 * Why randomUUID + pid: protects against collisions when multiple
 * processes / concurrent invocations write to the same directory at
 * the same millisecond.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  options: { encoding?: BufferEncoding; mode?: number } = {},
): Promise<AtomicWriteResult> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);

  const bytes =
    typeof content === 'string'
      ? Buffer.byteLength(content, options.encoding ?? 'utf8')
      : content.byteLength;

  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tmpPath, 'w', options.mode ?? 0o644);
    if (typeof content === 'string') {
      await handle.writeFile(content, options.encoding ?? 'utf8');
    } else {
      await handle.writeFile(content);
    }
    await handle.sync();
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }

  await fs.promises.rename(tmpPath, filePath);
  return { path: filePath, bytes, tmpPath };
}

/**
 * Register a cleanup hook so .tmp files in the target directory are
 * removed on process exit / SIGINT / SIGTERM. Best-effort: this is a
 * safety net for crashes, not a replacement for try/catch in callers.
 */
export function registerTmpCleanup(directory: string): () => void {
  const cleanup = (): void => {
    try {
      const entries = fs.readdirSync(directory);
      for (const entry of entries) {
        if (entry.includes('.tmp')) {
          try {
            fs.unlinkSync(path.join(directory, entry));
          } catch (_silentE_) {
            reportSilentFailure(_silentE_, 'atomicWrite:76');
          }
        }
      }
    } catch (_silentE_) {
      reportSilentFailure(_silentE_, 'atomicWrite:79');
    }
  };

  const onExit = (): void => cleanup();
  const onSignal = (_sig: NodeJS.Signals): void => {
    cleanup();
  };

  process.on('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}
