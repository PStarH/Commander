/**
 * GitSnapshot — Automatic git snapshot for full-workspace reversibility.
 *
 * Problem: The existing `.atr-snapshot.<actionId>` file-level snapshots are
 * best-effort and can be lost on crash. They also only cover individual file
 * mutations, not newly created files or multi-file operations.
 *
 * Solution: Before an agent run begins, create a git stash or commit on a
 * temporary branch. If compensation fails or a catastrophic error occurs,
 * the workspace can be restored to the pre-run state via `git checkout`.
 *
 * This is a safety net that complements (not replaces) the per-file
 * `.atr-snapshot` mechanism.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

export interface GitSnapshotResult {
  /** Whether the snapshot was successfully created */
  created: boolean;
  /** The git ref (stash hash or branch name) that can be used to restore */
  ref: string | null;
  /** The commit SHA before the run, for diff/restore */
  baseCommitSha: string | null;
  /** Whether the working tree was clean before the snapshot */
  wasClean: boolean;
  /** Error message if snapshot creation failed */
  error?: string;
}

export interface GitSnapshotStore {
  /** Map of runId → snapshot result */
  snapshots: Map<string, GitSnapshotResult>;
}

const store: GitSnapshotStore = {
  snapshots: new Map(),
};

// ── P2: Disk persistence for GitSnapshot index ──────────────────────────
// The in-memory Map is lost on process crash, breaking the full-workspace
// rollback safety net. This persists snapshot refs to a JSON file so
// restoreGitSnapshot() works across restarts.

import { existsSync, mkdirSync } from 'node:fs';

const PERSIST_PATH =
  typeof process !== 'undefined'
    ? path.join(process.cwd(), '.commander_state', 'git-snapshots.json')
    : null;

function persistSnapshots(): void {
  if (!PERSIST_PATH) return;
  try {
    const dir = path.dirname(PERSIST_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fs = require('node:fs');
    const data = Object.fromEntries(store.snapshots);
    const tmp = PERSIST_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, PERSIST_PATH);
  } catch {
    // Best-effort — don't crash the runtime
  }
}

function loadSnapshots(): void {
  if (!PERSIST_PATH || !existsSync(PERSIST_PATH)) return;
  try {
    const fs = require('node:fs');
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [runId, result] of Object.entries(data)) {
      store.snapshots.set(runId, result as GitSnapshotResult);
    }
  } catch {
    // Corrupt or missing — start fresh
  }
}

// Load on module init
loadSnapshots();

/**
 * Check if the current directory is inside a git repository.
 */
function isGitRepo(cwd: string = process.cwd()): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      stdio: 'pipe',
      timeout: 5000,
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git snapshot before an agent run begins.
 *
 * Strategy:
 * 1. If working tree is clean → record the current HEAD as baseline
 * 2. If working tree is dirty → create a stash (without applying) to capture
 *    the current state, then record HEAD as baseline
 *
 * The snapshot is stored in-memory keyed by runId. On compensation failure,
 * `restoreGitSnapshot(runId)` can reset the workspace to this baseline.
 */
export function createGitSnapshot(runId: string, cwd: string = process.cwd()): GitSnapshotResult {
  if (!isGitRepo(cwd)) {
    const result: GitSnapshotResult = {
      created: false,
      ref: null,
      baseCommitSha: null,
      wasClean: false,
      error: 'Not a git repository — git snapshot skipped',
    };
    store.snapshots.set(runId, result);
    return result;
  }

  try {
    // Get current HEAD commit SHA
    const baseSha = execSync('git rev-parse HEAD', {
      stdio: 'pipe',
      timeout: 5000,
      cwd,
    })
      .toString()
      .trim();

    // Check if working tree is clean
    const status = execSync('git status --porcelain', {
      stdio: 'pipe',
      timeout: 5000,
      cwd,
    })
      .toString()
      .trim();

    const wasClean = status.length === 0;

    let ref: string | null = baseSha;

    if (!wasClean) {
      // Working tree is dirty — create a stash to capture uncommitted changes
      // `git stash create` creates a stash commit without removing changes from
      // the working tree, and without adding to the stash list.
      // Use --include-untracked to capture newly created files too.
      const stashSha = execSync('git stash create --include-untracked', {
        stdio: 'pipe',
        timeout: 10000,
        cwd,
      })
        .toString()
        .trim();

      if (stashSha) {
        ref = stashSha;
        getGlobalLogger().info('GitSnapshot', `Created stash snapshot for run ${runId}`, {
          runId,
          baseCommitSha: baseSha,
          stashSha,
        });
      } else {
        // stash create returns empty if there's nothing to stash (shouldn't happen
        // if status was non-empty, but handle gracefully)
        ref = baseSha;
      }
    }

    const result: GitSnapshotResult = {
      created: true,
      ref,
      baseCommitSha: baseSha,
      wasClean,
    };

    store.snapshots.set(runId, result);
    return result;
  } catch (err) {
    const errorMsg = (err as Error)?.message ?? 'Unknown git error';
    reportSilentFailure(err, 'gitSnapshot:create');

    const result: GitSnapshotResult = {
      created: false,
      ref: null,
      baseCommitSha: null,
      wasClean: false,
      error: errorMsg,
    };
    store.snapshots.set(runId, result);
    persistSnapshots();
    return result;
  }
}

/**
 * Restore the workspace to the git snapshot taken before the run.
 *
 * This is a last-resort recovery mechanism — it will discard ALL changes
 * made during the agent run, including changes that were intentionally
 * committed. Use only when per-file compensation has failed or when
 * a catastrophic error requires a full rollback.
 *
 * @returns true if restoration succeeded, false otherwise
 */
export function restoreGitSnapshot(runId: string, cwd: string = process.cwd()): boolean {
  const snapshot = store.snapshots.get(runId);
  if (!snapshot || !snapshot.created || !snapshot.baseCommitSha) {
    getGlobalLogger().warn('GitSnapshot', `No snapshot found for run ${runId}`, { runId });
    return false;
  }

  try {
    // Hard reset to the base commit — this discards all changes made during the run
    execSync(`git reset --hard ${snapshot.baseCommitSha}`, {
      stdio: 'pipe',
      timeout: 15000,
      cwd,
    });

    // If there was a dirty working tree before the run, restore the stash
    if (!snapshot.wasClean && snapshot.ref && snapshot.ref !== snapshot.baseCommitSha) {
      try {
        execSync(`git stash apply ${snapshot.ref}`, {
          stdio: 'pipe',
          timeout: 10000,
          cwd,
        });
      } catch (err) {
        // Stash apply might fail if there are conflicts — log but don't fail
        getGlobalLogger().warn('GitSnapshot', `Failed to restore stash ${snapshot.ref}`, {
          runId,
          error: (err as Error)?.message,
        });
      }
    }

    getGlobalLogger().info('GitSnapshot', `Restored workspace to pre-run state for run ${runId}`, {
      runId,
      baseCommitSha: snapshot.baseCommitSha,
      wasClean: snapshot.wasClean,
    });

    return true;
  } catch (err) {
    reportSilentFailure(err, 'gitSnapshot:restore');
    getGlobalLogger().error('GitSnapshot', `Failed to restore snapshot for run ${runId}`, err as Error);
    return false;
  }
}

/**
 * Get the snapshot for a run (without restoring).
 */
export function getGitSnapshot(runId: string): GitSnapshotResult | undefined {
  return store.snapshots.get(runId);
}

/**
 * Clean up the snapshot for a completed run.
 */
export function clearGitSnapshot(runId: string): void {
  store.snapshots.delete(runId);
  persistSnapshots();
}

/**
 * Check if a git snapshot exists for a run.
 */
export function hasGitSnapshot(runId: string): boolean {
  return store.snapshots.has(runId);
}
