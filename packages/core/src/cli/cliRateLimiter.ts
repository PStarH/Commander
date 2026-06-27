import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

interface RateLimitFile {
  timestamps: number[];
}

const RATE_LIMIT_FILE = path.join(os.tmpdir(), '.commander-cli-ratelimit.json');
const RATE_LIMIT_LOCK = path.join(os.tmpdir(), '.commander-cli-ratelimit.lock');
const MAX_RUNS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const LOCK_MAX_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;

function readRateLimitFile(): RateLimitFile {
  try {
    const raw = fs.readFileSync(RATE_LIMIT_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    reportSilentFailure(err, 'cliRateLimiter:18');
    return { timestamps: [] };
  }
}

/**
 * Atomically write the rate-limit file by writing to a temporary file first
 * and then renaming it. `fs.renameSync` is atomic on POSIX systems, which
 * prevents concurrent readers from observing a partially-written file.
 */
function writeRateLimitFile(data: RateLimitFile): void {
  const tmpFile = `${RATE_LIMIT_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpFile, RATE_LIMIT_FILE);
  } catch (err) {
    reportSilentFailure(err, 'cliRateLimiter:27');
    // best-effort: if we can't write, allow the request
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Acquire an exclusive cross-process file lock using `flag: 'wx'` (fails if
 * the file already exists). Retries with a short backoff to handle contention.
 * Returns a release function that removes the lock file.
 *
 * This closes the TOCTOU race where two concurrent CLI invocations both read
 * the same stale counter before either has written its update.
 */
function acquireRateLimitLock(): () => void {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      fs.writeFileSync(RATE_LIMIT_LOCK, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          fs.unlinkSync(RATE_LIMIT_LOCK);
        } catch {
          // ignore — lock may have already been removed
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Lock is held by another process — check for a stale lock and retry.
        // If the lock file is older than the window, assume the holder crashed
        // and remove it so we can proceed.
        try {
          const stat = fs.statSync(RATE_LIMIT_LOCK);
          if (Date.now() - stat.mtimeMs > WINDOW_MS) {
            fs.unlinkSync(RATE_LIMIT_LOCK);
          }
        } catch {
          // ignore stat/unlink errors
        }
        // Busy-wait briefly (synchronous CLI context)
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_DELAY_MS) {
          // spin
        }
        continue;
      }
      // Unexpected error — fail open (allow the request)
      reportSilentFailure(err, 'cliRateLimiter:acquireLock');
      return () => {};
    }
  }
  // Exhausted retries — fail open to avoid blocking the CLI indefinitely
  return () => {};
}

/**
 * Check if the CLI is being invoked too frequently across processes.
 * Returns true if the request should be allowed, false if rate-limited.
 *
 * The read-modify-write cycle is protected by an exclusive file lock to
 * prevent the TOCTOU race where concurrent processes read stale counters.
 */
export function checkCliRateLimit(command: string): boolean {
  const costlyCommands = new Set(['run', 'company', 'swarm', 'drive', 'review', 'fix']);
  if (!costlyCommands.has(command)) return true;

  const releaseLock = acquireRateLimitLock();
  try {
    const data = readRateLimitFile();
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    data.timestamps = data.timestamps.filter((t) => t > cutoff);

    if (data.timestamps.length >= MAX_RUNS_PER_MINUTE) {
      return false;
    }

    data.timestamps.push(now);
    writeRateLimitFile(data);
    return true;
  } finally {
    releaseLock();
  }
}
