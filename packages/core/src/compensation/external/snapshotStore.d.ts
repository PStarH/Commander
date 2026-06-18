/**
 * SnapshotStore — content-addressable, metadata-rich snapshot for the
 * filesystem compensation handler.
 *
 * Why a new snapshot store when defaultCompensation.ts already has one?
 *   The old `restoreFromSnapshot` is per-file and uses a flat
 *   `<path>.atr-snapshot.<actionId>` naming. It works for restore-after-
 *   write but is awkward for:
 *     - Multiple files modified in one logical action (transactional groups)
 *     - Non-file mutations (mode, owner, mtime)
 *     - Cross-volume / hard-link cases where a path can be a directory
 *     - Garbage collection (snapshots accumulate forever)
 *
 *   This store:
 *     - Stores each snapshot as a content-addressable blob (SHA-256)
 *     - Persists a JSON metadata sidecar with mode, mtime, owner, path
 *     - Uses a single SQLite table for fast GC and lookup
 *     - Supports grouping multiple files into one transaction
 *
 *   See: https://temporal.io/blog/compensating-actions-part-1
 *   (the part about "compensating actions must restore the state the
 *   forward action would have observed", which the old store handled
 *   incompletely for non-content metadata).
 */
export type SnapshotKind = 'file' | 'directory' | 'symlink' | 'meta';
export interface FileSnapshot {
    /** Stable id. */
    id: string;
    /** Group id: multiple files from one logical action share an id. */
    groupId: string;
    /** Run this snapshot belongs to. */
    runId: string;
    /** Action id that produced this snapshot. */
    actionId: string;
    /** Tool name (file_write, file_edit, mkdir, etc.). */
    toolName: string;
    /** Absolute path that was snapshotted. */
    path: string;
    /** What kind of artifact this is. */
    kind: SnapshotKind;
    /** Whether the path existed at snapshot time. */
    existed: boolean;
    /** Mode bits (octal) at snapshot time. */
    mode: number;
    /** mtime in ms epoch. */
    mtimeMs: number;
    /** Owner uid if known. */
    uid?: number;
    /** Owner gid if known. */
    gid?: number;
    /** Content hash (SHA-256, hex) for the content. */
    contentHash: string;
    /** Path to the content blob on disk. */
    blobPath: string;
    /** Created at ISO. */
    createdAt: string;
    /** Symlink target (only for symlinks). */
    symlinkTarget?: string;
    /** For directories: list of child names at snapshot time. */
    children?: string[];
}
export interface SnapshotGroup {
    groupId: string;
    runId: string;
    actionId: string;
    toolName: string;
    /** All paths captured. */
    paths: string[];
    createdAt: string;
}
export interface SnapshotStoreConfig {
    /** Root directory for the snapshot store. */
    rootDir: string;
    /** Max number of snapshots to retain (oldest evicted). 0 = unlimited. */
    maxSnapshots?: number;
}
export declare class SnapshotStore {
    private readonly rootDir;
    private readonly blobsDir;
    private readonly metaDir;
    private readonly config;
    /** In-memory index; in production this is also persisted (omitted for now). */
    private readonly index;
    private readonly groups;
    constructor(config: SnapshotStoreConfig);
    /**
     * Take a snapshot of a single path. No-op if the path doesn't exist
     * (records `existed=false` so the inverse can decide whether to delete
     * or create). Symlinks are followed for the snapshot content but the
     * link target is recorded for restoration.
     */
    take(input: {
        runId: string;
        actionId: string;
        toolName: string;
        path: string;
        groupId?: string;
    }): FileSnapshot;
    /**
     * Take a snapshot of a group of paths atomically (logical action).
     * If any snapshot fails, prior snapshots in the same group are still
     * retained so partial groups can be inspected (the inverse will
     * apply each surviving snapshot).
     */
    takeGroup(input: {
        runId: string;
        actionId: string;
        toolName: string;
        paths: string[];
    }): FileSnapshot[];
    /**
     * Restore a single snapshot. The inverse logic depends on `kind` and
     * `existed`:
     *   - file existed=true → writeFile back + chmod + utimes
     *   - file existed=false → unlink (file was created by the forward action)
     *   - directory existed=true → mkdir (no recursion into missing children)
     *   - directory existed=false → rmdir (only if empty)
     *   - symlink existed=true → re-symlink to original target
     *   - symlink existed=false → unlink
     * Returns true on success, false with `error` on failure.
     */
    restore(snapshotId: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Restore an entire group. Used for transactional actions that touched
     * multiple paths. Restores in REVERSE order of capture (the most
     * recently mutated file is restored first, mirroring the saga LIFO
     * convention).
     */
    restoreGroup(groupId: string): {
        succeeded: string[];
        failed: Array<{
            id: string;
            error: string;
        }>;
    };
    /**
     * Look up snapshots by (runId, actionId). Used by the compensation
     * handler to find all the snapshots it needs to roll back.
     */
    findByAction(actionId: string): FileSnapshot[];
    findByGroup(groupId: string): FileSnapshot[];
    /**
     * Garbage collect old snapshots. Eviction is LRU by `createdAt`; the
     * blob is removed when the last snapshot referencing its hash is gone.
     */
    gc(): number;
    size(): number;
    private applyOne;
    private upsertGroup;
    private writeMeta;
    private loadFromDisk;
    private maybeEvict;
}
export declare function getSnapshotStore(): SnapshotStore;
export declare function resetSnapshotStoreForTesting(): void;
//# sourceMappingURL=snapshotStore.d.ts.map