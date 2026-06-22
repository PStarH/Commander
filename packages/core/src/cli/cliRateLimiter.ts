import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface RateLimitFile {
  timestamps: number[];
}

const RATE_LIMIT_FILE = path.join(os.tmpdir(), '.commander-cli-ratelimit.json');
const MAX_RUNS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

function readRateLimitFile(): RateLimitFile {
  try {
    const raw = fs.readFileSync(RATE_LIMIT_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { timestamps: [] };
  }
}

function writeRateLimitFile(data: RateLimitFile): void {
  try {
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // best-effort: if we can't write, allow the request
  }
}

/**
 * Check if the CLI is being invoked too frequently across processes.
 * Returns true if the request should be allowed, false if rate-limited.
 */
export function checkCliRateLimit(command: string): boolean {
  const costlyCommands = new Set(['run', 'company', 'swarm', 'drive', 'review', 'fix']);
  if (!costlyCommands.has(command)) return true;

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
}
