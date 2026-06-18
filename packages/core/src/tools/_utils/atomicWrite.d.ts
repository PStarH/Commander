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
export declare function atomicWriteFile(filePath: string, content: string | Buffer, options?: {
    encoding?: BufferEncoding;
    mode?: number;
}): Promise<AtomicWriteResult>;
/**
 * Register a cleanup hook so .tmp files in the target directory are
 * removed on process exit / SIGINT / SIGTERM. Best-effort: this is a
 * safety net for crashes, not a replacement for try/catch in callers.
 */
export declare function registerTmpCleanup(directory: string): () => void;
//# sourceMappingURL=atomicWrite.d.ts.map