import type { Tool, ToolDefinition } from '../runtime/types';
/** Get the safe root directory. Dynamic to support runtime COMMANDER_WORKSPACE changes. */
export declare function getSafeRoot(): string;
/** Check that a resolved path is within SAFE_ROOT (prevents prefix collision like workspace-evil). */
export declare function isWithinRoot(resolved: string, root: string): boolean;
/**
 * Resolve a user-provided path relative to the safe workspace root.
 * Rejects paths that resolve outside the workspace, including symlink-based traversal.
 * Re-exports for use by other tools (patchTool, multimodal tools).
 */
export declare function safePath(target: string): string;
export declare class FileReadTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class FileWriteTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class FileEditTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
    /**
     * Hashline mode: parse and apply hashline edits.
     */
    private executeHashline;
    /**
     * Legacy mode: exact string replacement (backward-compatible).
     */
    private executeLegacy;
}
export declare class FileSearchTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
    private globSearch;
    private globRecurse;
    /** Recursive version used when the pattern contains ** — recurses into all subdirectories */
    private globRecurseDeep;
    private matchGlob;
}
export declare class FileListTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class GlobTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
    private globFind;
    private recurse;
    private matchGlob;
}
//# sourceMappingURL=fileSystemTool.d.ts.map