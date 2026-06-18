/**
 * Thrown by tools to request human input mid-execution.
 * The runtime catches this and returns an 'interrupted' status.
 * On resume, the human's input becomes the tool's return value.
 */
export declare class InterruptError extends Error {
    readonly reason: string;
    readonly value: unknown;
    constructor(reason: string, value?: unknown);
}
//# sourceMappingURL=interruptError.d.ts.map