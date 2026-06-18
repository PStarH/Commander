/**
 * Snapshot Testing Framework — stable output regression testing.
 *
 * Inspired by Jest's toMatchSnapshot() and Rust's `insta` crate:
 * - First run: saves actual output to a .snap file
 * - Subsequent runs: compares against saved snapshot
 * - Update mode: regenerate snapshots with COMMANDER_UPDATE_SNAPSHOTS=1
 *
 * Usage:
 *   import { toMatchSnapshot, snapshotDir } from './helpers/snapshot';
 *
 *   it('output format', () => {
 *     const output = formatResult(data);
 *     toMatchSnapshot('test-name', output);
 *   });
 */
import * as fs from 'fs';
import * as path from 'path';

/** Directory where snapshots are stored */
const SNAPSHOT_DIR = path.join(__dirname, '..', '__snapshots__');

/** Check if update mode is enabled (evaluated at runtime) */
function isUpdateMode(): boolean {
  return process.env.COMMANDER_UPDATE_SNAPSHOTS === '1';
}

/** Cache of loaded snapshots to avoid repeated disk reads */
const snapshotCache = new Map<string, string>();

/**
 * Assert that actual output matches a stored snapshot.
 *
 * @param name - Unique name for this snapshot (used as filename)
 * @param actual - The actual output to compare
 * @param options - Optional settings
 */
export function toMatchSnapshot(
  name: string,
  actual: string,
  options?: {
    /** Custom snapshot directory (default: tests/__snapshots__) */
    dir?: string;
    /** Whether to strip ANSI codes before comparing */
    stripAnsi?: boolean;
  },
): void {
  const snapDir = options?.dir ?? SNAPSHOT_DIR;
  const snapFile = path.join(snapDir, `${sanitizeName(name)}.snap`);

  let processedActual = actual;
  if (options?.stripAnsi !== false) {
    processedActual = stripAnsi(actual);
  }

  // Ensure snapshot directory exists
  if (!fs.existsSync(snapDir)) {
    fs.mkdirSync(snapDir, { recursive: true });
  }

  // Update mode: just write the snapshot
  if (isUpdateMode()) {
    fs.writeFileSync(snapFile, formatSnapshot(name, processedActual));
    return;
  }

  // Compare mode: load existing snapshot
  if (!fs.existsSync(snapFile)) {
    // First run: save the snapshot
    fs.writeFileSync(snapFile, formatSnapshot(name, processedActual));
    return;
  }

  // Load and compare
  const expected = loadSnapshot(snapFile);

  if (processedActual !== expected) {
    // Generate diff-like error message
    const diff = generateDiff(expected, processedActual);
    throw new Error(
      `Snapshot mismatch for "${name}"\n\n` +
        `Expected:\n${expected}\n\n` +
        `Actual:\n${processedActual}\n\n` +
        `Diff:\n${diff}\n\n` +
        `Run with COMMANDER_UPDATE_SNAPSHOTS=1 to update.`,
    );
  }
}

/**
 * Check if a snapshot exists.
 */
export function snapshotExists(name: string, dir?: string): boolean {
  const snapDir = dir ?? SNAPSHOT_DIR;
  const snapFile = path.join(snapDir, `${sanitizeName(name)}.snap`);
  return fs.existsSync(snapFile);
}

/**
 * Load a snapshot file.
 */
export function loadSnapshotFile(name: string, dir?: string): string | null {
  const snapDir = dir ?? SNAPSHOT_DIR;
  const snapFile = path.join(snapDir, `${sanitizeName(name)}.snap`);
  if (!fs.existsSync(snapFile)) return null;
  return loadSnapshot(snapFile);
}

/**
 * Delete a snapshot file.
 */
export function deleteSnapshot(name: string, dir?: string): void {
  const snapDir = dir ?? SNAPSHOT_DIR;
  const snapFile = path.join(snapDir, `${sanitizeName(name)}.snap`);
  try {
    fs.unlinkSync(snapFile);
  } catch {
    /* ignore */
  }
}

/**
 * Get the snapshot directory path.
 */
export function getSnapshotDir(): string {
  return SNAPSHOT_DIR;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function formatSnapshot(name: string, content: string): string {
  return `// Snapshot: ${name}\n// Generated: ${new Date().toISOString()}\n\n${content}\n`;
}

function loadSnapshot(filePath: string): string {
  const cached = snapshotCache.get(filePath);
  if (cached !== undefined) return cached;

  const raw = fs.readFileSync(filePath, 'utf-8');
  // Strip the header comments (lines starting with //)
  const lines = raw.split('\n');
  const contentLines: string[] = [];
  let headerEnded = false;

  for (const line of lines) {
    if (!headerEnded) {
      if (line.startsWith('//')) continue;
      if (line.trim() === '') continue;
      headerEnded = true;
    }
    contentLines.push(line);
  }

  const content = contentLines.join('\n').trim();
  snapshotCache.set(filePath, content);
  return content;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function generateDiff(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  const diff: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const exp = expectedLines[i] ?? '';
    const act = actualLines[i] ?? '';

    if (exp !== act) {
      diff.push(`  Line ${i + 1}:`);
      if (exp) diff.push(`    - ${exp}`);
      if (act) diff.push(`    + ${act}`);
    }
  }

  return diff.length > 0 ? diff.join('\n') : '(no line differences — may be trailing whitespace)';
}

/**
 * Clear the snapshot cache (useful for tests).
 */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
}
