/**
 * Walk-up .env loader.
 *
 * Walks from `cwd` to filesystem root (depth-capped) calling
 * `process.loadEnvFile(path)` on each `.env` found. Loading order is
 * shallowest-first so the root-most `.env` is loaded LAST and its
 * overrides win — matches dotenv's standard behaviour.
 *
 * Requires Node ≥ 20.6 (process.loadEnvFile is stable). On older Node
 * or any I/O error, logs a single yellow warning to stderr and returns
 * cleanly. Never throws.
 */
import * as fs from 'fs';
import * as path from 'path';

const MAX_DEPTH = 8;

/** Cached result from the most recent loadEnvUp call (for REPL banner). */
let _lastResult: LoadEnvResult | undefined;

export interface LoadEnvResult {
  /** Files actually loaded (in walk order — shallowest first). */
  loaded: string[];
  /** Files we tried but skipped (missing, unreadable, parse error). */
  skipped: string[];
  /** True if process.loadEnvFile was unavailable at runtime. */
  featureMissing: boolean;
}

export function walkUpDotenvPaths(cwd: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i <= MAX_DEPTH; i++) {
    out.push(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function loadEnvUp(
  cwd: string = process.cwd(),
  stderr: (msg: string) => void = (m) => console.error(m),
): LoadEnvResult {
  const result: LoadEnvResult = {
    loaded: [],
    skipped: [],
    featureMissing: false,
  };

  if (typeof process.loadEnvFile !== 'function') {
    result.featureMissing = true;
    stderr(
      `  ⚠ commander: process.loadEnvFile requires Node ≥20.6; present=${process.versions.node}. Skipping .env auto-load.\n`,
    );
    return result;
  }

  for (const candidate of walkUpDotenvPaths(cwd)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      result.loaded.push(candidate);
    } catch (err) {
      result.skipped.push(candidate);
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`  ⚠ commander: failed to parse ${candidate} (${msg}). Continuing without it.\n`);
    }
  }
  _lastResult = result;
  return result;
}

/**
 * Retrieve the result of the last `loadEnvUp()` call.
 * Used by the REPL to display \`.env loaded from …\` on startup.
 */
export function getLastLoadResult(): LoadEnvResult | undefined {
  return _lastResult;
}

/**
 * Inverse-lookup: which `.env` would win for a given key in a given cwd?
 * Walks up in the same order as `loadEnvUp`, returns the deepest .env path
 * that declares `key`, or undefined. Useful for docs / dry-run output.
 */
export function findDotenvDefining(
  key: string,
  cwd: string = process.cwd(),
): string | undefined {
  const order = walkUpDotenvPaths(cwd).filter((p) => fs.existsSync(p)).reverse();
  for (const p of order) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const re = new RegExp(`^\\s*${key}\\s*=`, 'm');
      if (re.test(content)) return p;
    } catch {
      /* unreadable — skip */
    }
  }
  return undefined;
}
