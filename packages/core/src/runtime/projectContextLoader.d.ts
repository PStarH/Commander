/**
 * Project Context Loader
 *
 * Loads project-specific instructions from well-known markdown files and
 * injects them into the stable system prompt. This is the Commander
 * equivalent of Claude Code's CLAUDE.md / Codex CLI's AGENTS.md mechanism.
 *
 * Supported files (highest precedence last):
 *   1. PROJECT.md  — project overview, conventions, standards
 *   2. CLAUDE.md   — Claude-style project context
 *   3. AGENTS.md   — agent-specific instructions (most specific)
 *
 * Higher-precedence files appear later in the injected block so their
 * instructions have stronger recency in the model's attention.
 */
export interface ProjectContext {
    /** Absolute paths of files that were read, in precedence order. */
    filesRead: string[];
    /** Combined markdown content of all read files. */
    content: string;
    /** Cache key derived from file mtimes. Changes when any file changes. */
    cacheKey: string;
}
interface FileSnapshot {
    filePath: string;
    mtimeMs: number;
    content: string;
}
/**
 * Load project context from the given directory.
 *
 * @param projectPath Directory to scan. Defaults to process.cwd() for CLI usage.
 * @returns ProjectContext. If no files exist, content is empty and cacheKey is stable.
 */
export declare function loadProjectContext(projectPath?: string): ProjectContext;
/**
 * Build the `<project_context>` block for injection into the system prompt.
 * Returns an empty string if no project context files were found.
 */
export declare function buildProjectContextBlock(ctx: ProjectContext): string;
/**
 * Compute a deterministic cache key from file snapshots.
 * Key changes when any file is added, removed, or modified.
 */
export declare function computeProjectContextCacheKey(snapshots: FileSnapshot[]): string;
export {};
//# sourceMappingURL=projectContextLoader.d.ts.map