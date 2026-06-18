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
export interface FileSnapshot {
    /** 4-hex uppercase content hash */
    hash: string;
    /** File lines at snapshot time (for recovery) */
    lines: string[];
    /** Timestamp of snapshot */
    timestamp: number;
}
/**
 * Compute a 4-hex content hash for a file.
 * Uses Node.js crypto (xxHash not available natively, so we use SHA-256 truncated).
 * The hash is deterministic for identical normalized content.
 */
export declare function computeFileHash(text: string): string;
/**
 * Per-session file snapshot store.
 * Keyed by resolved file path. Each read mints a fresh snapshot.
 */
export declare class SnapshotStore {
    private snapshots;
    /**
     * Record a snapshot for a file. Called after every successful file_read.
     */
    record(filePath: string, content: string): void;
    /**
     * Get the snapshot for a file, if one exists.
     */
    get(filePath: string): FileSnapshot | undefined;
    /**
     * Get the hash for a file, or undefined if not read yet.
     */
    getHash(filePath: string): string | undefined;
    /**
     * Validate that a file's current content matches the expected hash.
     * Returns true if the hash matches (file unchanged since read).
     */
    validateHash(filePath: string, expectedHash: string): boolean;
    /**
     * Read a file and compute its current hash.
     * Used for validation when the snapshot might be stale.
     */
    computeCurrentHash(filePath: string): string | null;
    /**
     * Validate a hashline edit against the current file state.
     * Returns { valid, currentHash, message }.
     */
    validateEdit(filePath: string, expectedHash: string): {
        valid: boolean;
        currentHash: string | null;
        message?: string;
    };
    /**
     * Clear all snapshots (e.g., on session reset).
     */
    clear(): void;
    /**
     * Get snapshot count (for diagnostics).
     */
    get size(): number;
}
export declare function getSnapshotStore(): SnapshotStore;
export declare function resetSnapshotStore(): void;
//# sourceMappingURL=snapshotStore.d.ts.map