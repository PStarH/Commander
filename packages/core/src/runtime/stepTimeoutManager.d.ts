/**
 * StepTimeoutManager — wrap a step's promise with a deadline.
 *
 * Closes the "hung step" gap from the reversibility audit. Without this, a
 * tool that hangs (infinite loop, network stuck) blocks the agent run forever
 * because AgentRuntime.execute has no step-level deadline.
 *
 * Behavior:
 *   - Per-call AbortController fired after `timeoutMs`
 *   - On timeout: rejects with StepTimeoutError (subclass of Error)
 *   - Caller can pass an `onTimeout` callback for cleanup (e.g. abort the underlying fetch)
 *   - clear() called on success releases resources
 */
export declare class StepTimeoutError extends Error {
    readonly stepId: string;
    readonly timeoutMs: number;
    constructor(stepId: string, timeoutMs: number);
}
export interface StepTimeoutOptions {
    timeoutMs: number;
    stepId: string;
    onTimeout?: (signal: AbortSignal) => void;
}
export declare class StepTimeoutManager {
    private active;
    wrap<T>(promise: Promise<T>, options: StepTimeoutOptions): Promise<T>;
    cancel(stepId: string): boolean;
    cancelAll(): number;
    activeCount(): number;
}
//# sourceMappingURL=stepTimeoutManager.d.ts.map