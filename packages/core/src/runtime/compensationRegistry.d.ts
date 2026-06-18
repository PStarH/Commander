export interface CompensableAction {
    /** Unique identifier for this specific action instance */
    actionId: string;
    /** Tool name that produced the side-effect */
    toolName: string;
    /** Arguments used for the action */
    args: Record<string, unknown>;
    /** Short description of what side-effect to undo */
    description: string;
    /** Tags for matching compensation handlers */
    tags: string[];
    /** Run ID for cross-process correlation (populated by agentRuntime) */
    runId?: string;
    /** Agent ID for cross-process correlation (populated by agentRuntime) */
    agentId?: string;
    reversibility?: 'fully_reversible' | 'partially_reversible' | 'non_reversible';
    riskLevel?: 'safe' | 'review' | 'destructive' | 'impossible';
}
export type CompensationHandler = (action: CompensableAction) => Promise<{
    success: boolean;
    error?: string;
}>;
import type { CompensationQueue } from '../atr/compensationQueue';
export declare class CompensationRegistry {
    private handlers;
    private pendingActions;
    private compensationAttempts;
    private compensated;
    private queue?;
    private observability?;
    register(toolName: string, handler: CompensationHandler): void;
    /** Wire the durable compensation queue for cross-process crash-safe retry.
     *  Without this, exhausted compensations are dropped after 3 in-memory attempts.
     *  With the queue, exhausted items are persisted to SQLite with exponential backoff
     *  and can be recovered by a new process after a crash. */
    setCompensationQueue(queue: CompensationQueue): void;
    setObservability(obs: {
        onSuccess?: (action: CompensableAction) => void;
        onFailed?: (action: CompensableAction, err: string) => void;
        onExhausted?: (action: CompensableAction, err: string) => void;
    }): void;
    recordAction(action: CompensableAction): void;
    assessReversibility(toolName: string): CompensableAction['reversibility'];
    /** Compensate a single action by its actionId */
    compensate(actionId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /** Compensate ALL pending actions (in reverse order, max 3 attempts each).
     *  Exhausted items are enqueued to the durable CompensationQueue if wired. */
    compensateAll(): Promise<{
        succeeded: number;
        failed: number;
        errors: string[];
    }>;
    /** Process due items from the durable compensation queue.
     *  Claims items one at a time and retries the registered handler.
     *  Call periodically (e.g., on process startup, or every N minutes).
     *  Returns the number of items processed. */
    processQueue(): Promise<number>;
    private addToCompensated;
    /** Look up a compensation handler by tool name. Returns undefined if not registered. */
    getHandler(toolName: string): CompensationHandler | undefined;
    getPendingCount(): number;
    getCompensatedCount(): number;
    clear(): void;
}
//# sourceMappingURL=compensationRegistry.d.ts.map