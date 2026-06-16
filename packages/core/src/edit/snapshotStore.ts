/**
 * File Snapshot Store — tracks file content hashes and lines for hashline edit recovery.
 *
 * Inspired by oh-my-pi's file-snapshot-store. Each file_read mints a snapshot
 * that the edit tool later validates against. If the file changed between read
 * and edit, the stale hash is detected BEFORE corruption occurs.
 *
 * Hash: 4-hex xxHash32 fingerprint of normalized file content.
 * Lines: stored for stale-anchor recovery (recomputing line numbers after drift).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface FileSnapshot {
  /** 4-hex uppercase content hash */
  hash: string;
  /** File lines at snapshot time (for recovery) */
  lines: string[];
  /** Timestamp of snapshot */
  timestamp: number;
}

// ============================================================================
// Hash computation
// ============================================================================

/** Number of hex characters in the content hash */
const HASH_LENGTH = 4;

/**
 * Normalize text before hashing: trim trailing whitespace from every line
 * so CRLF endings and display-trimmed lines do not invalidate a tag.
 */
function normalizeForHash(text: string): string {
  return text.replace(/[ \t\r]+(?=\n|$)/g, '');
}

/**
 * Compute a 4-hex content hash for a file.
 * Uses Node.js crypto (xxHash not available natively, so we use SHA-256 truncated).
 * The hash is deterministic for identical normalized content.
 */
export function computeFileHash(text: string): string {
  const normalized = normalizeForHash(text);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  // Take first 4 hex chars, uppercase
  return hash.slice(0, HASH_LENGTH).toUpperCase();
}

// ============================================================================
// Snapshot Store
// ============================================================================

/**
 * Per-session file snapshot store.
 * Keyed by resolved file path. Each read mints a fresh snapshot.
 */
export class SnapshotStore {
  private snapshots = new Map<string, FileSnapshot>();

  /**
   * Record a snapshot for a file. Called after every successful file_read.
   */
  record(filePath: string, content: string): void {
    const lines = content.split('\n');
    const hash = computeFileHash(content);
    this.snapshots.set(filePath, { hash, lines, timestamp: Date.now() });
  }

  /**
   * Get the snapshot for a file, if one exists.
   */
  get(filePath: string): FileSnapshot | undefined {
    return this.snapshots.get(filePath);
  }

  /**
   * Get the hash for a file, or undefined if not read yet.
   */
  getHash(filePath: string): string | undefined {
    return this.snapshots.get(filePath)?.hash;
  }

  /**
   * Validate that a file's current content matches the expected hash.
   * Returns true if the hash matches (file unchanged since read).
   */
  validateHash(filePath: string, expectedHash: string): boolean {
    const snapshot = this.snapshots.get(filePath);
    if (!snapshot) return false;
    return snapshot.hash === expectedHash;
  }

  /**
   * Read a file and compute its current hash.
   * Used for validation when the snapshot might be stale.
   */
  computeCurrentHash(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return computeFileHash(content);
    } catch {
      return null;
    }
  }

  /**
   * Validate a hashline edit against the current file state.
   * Returns { valid, currentHash, message }.
   */
  validateEdit(
    filePath: string,
    expectedHash: string,
  ): {
    valid: boolean;
    currentHash: string | null;
    message?: string;
  } {
    const currentHash = this.computeCurrentHash(filePath);
    if (currentHash === null) {
      return { valid: false, currentHash: null, message: `File not found: ${filePath}` };
    }
    if (currentHash === expectedHash) {
      return { valid: true, currentHash };
    }
    return {
      valid: false,
      currentHash,
      message: `Stale hash for ${filePath}: expected ${expectedHash}, got ${currentHash}. File changed since last read. Re-read the file before editing.`,
    };
  }

  /**
   * Clear all snapshots (e.g., on session reset).
   */
  clear(): void {
    this.snapshots.clear();
  }

  /**
   * Get snapshot count (for diagnostics).
   */
  get size(): number {
    return this.snapshots.size;
  }
}

// ============================================================================
// Global singleton
// ============================================================================

let globalSnapshotStore: SnapshotStore | null = null;

export function getSnapshotStore(): SnapshotStore {
  if (!globalSnapshotStore) {
    globalSnapshotStore = new SnapshotStore();
  }
  return globalSnapshotStore;
}

export function resetSnapshotStore(): void {
  globalSnapshotStore = null;
}
