/**
 * Default compensation handlers for built-in mutation tools.
 *
 * Each handler implements the inverse of a single tool's side effect. The
 * handler is invoked by RunLedger.abortAndCompensate() in reverse execution
 * order.
 *
 * Snapshot pattern: file_write/file_edit/copy_etc use a snapshot-then-mutate
 * pattern via the snapshot tool. The compensation restores the pre-mutation
 * state. If the snapshot is missing (e.g. process crashed before snapshot
 * was taken), the compensation is best-effort and reports failure to the
 * dead-letter queue.
 */
import type { CompensableAction } from './types';
/**
 * Take a snapshot of a file before mutation. Called by tools that
 * register a `beforeExecute` snapshot hook. No-op if file does not exist.
 */
export declare function takeSnapshot(filePath: string, actionId: string): void;
export declare const defaultCompensationHandlers: Record<string, (action: CompensableAction) => Promise<{
    success: boolean;
    error?: string;
}>>;
/**
 * Register the default compensation handlers on a RunLedger instance.
 * Idempotent — safe to call multiple times.
 */
export declare function registerCompensationHandler(ledger: {
    registerCompensation: (toolName: string, handler: (action: CompensableAction) => Promise<{
        success: boolean;
        error?: string;
    }>) => void;
}, toolName?: string, handler?: (action: CompensableAction) => Promise<{
    success: boolean;
    error?: string;
}>): void;
export interface MutationDetectionResult {
    isMutation: boolean;
    /** Why we think so: 'declared' = tool.definition.mutation, 'heuristic' = substring fallback, 'default' = false */
    source: 'declared' | 'heuristic' | 'default';
    /** If compensable: name of the default handler that can undo this */
    handlerName?: string;
}
/**
 * Resolve whether a tool is a mutation, using the explicit `mutation` flag
 * from ToolDefinition when present, falling back to a substring heuristic
 * for legacy tools. This is the API the runtime should call instead of
 * the bare `isMutationTool()` heuristic.
 */
export declare function resolveMutationFlag(toolName: string, definition?: {
    mutation?: boolean;
}): MutationDetectionResult;
//# sourceMappingURL=defaultCompensation.d.ts.map