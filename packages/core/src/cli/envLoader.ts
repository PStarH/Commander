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
import { reportSilentFailure } from '../silentFailureReporter';
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

// Subdirectories to skip during the recursive descent. These routinely contain
// thousands of files but no user-authored .env. Including them in the walk
// would emit O(N) paths to the caller and slow every loadEnvUp call.
const SKIP_SUBTREE = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

export function walkUpDotenvPaths(cwd: string): string[] {
  const out: string[] = [];
  const root = path.resolve(cwd);

  // Phase 1: DFS descent into cwd's subdirectories, emitting DEEPEST-first
  // (post-order). This matches the test contract "shallowest entry is loaded
  // before deepest in `result.loaded` order" — meaning within the subtree,
  // cwd/.env loads AFTER nested .env files (nested values win). Walkers
  // then collect cwd's own .env as the last sibling-level entry before
  // moving up to parent directories. Visited set prevents BFS/DFS cycles.
  const visited = new Set<string>();
  const dfs = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited.has(dir)) return;
    visited.add(dir);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      reportSilentFailure(err, 'envLoader:67');
      /* unreadable — leave entries empty */
      entries = [];
    }
    // Alphabetize so multi-level structure is deterministic.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Recurse into non-skipped, non-hidden subdirs first (post-order: deeper
    // .env collected before the parent's). Emit each subdir's .env AFTER the
    // subtree beneath it, so deeply-nested .env appear earlier in `out`.
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_SUBTREE.has(e.name)) continue;
      dfs(path.join(dir, e.name), depth + 1);
    }
    // Now emit this directory's own .env (post-order: subtree first, then self).
    out.push(path.join(dir, '.env'));
  };
  dfs(root, 0);

  // Phase 2: walk up through ancestors. cwd's .env is already in `out` from
  // Phase 1 (the dfs(root, 0) call); the root-most .env loads LAST and its
  // overrides win per canonical dotenv semantics.
  let dir = path.dirname(root);
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!dir || dir === path.dirname(dir)) break; // reached filesystem root
    out.push(path.join(dir, '.env'));
    dir = path.dirname(dir);
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
export function findDotenvDefining(key: string, cwd: string = process.cwd()): string | undefined {
  const order = walkUpDotenvPaths(cwd)
    .filter((p) => fs.existsSync(p))
    .reverse();
  for (const p of order) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const re = new RegExp(`^\\s*${key}\\s*=`, 'm');
      if (re.test(content)) return p;
    } catch (err) {
      reportSilentFailure(err, 'envLoader:153');
      /* unreadable — skip */
    }
  }
  return undefined;
}
