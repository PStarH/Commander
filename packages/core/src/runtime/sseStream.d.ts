import type { MessageBusTopic } from './types';
export type StructuredSSEEventType = 'agent.status' | 'agent.thinking' | 'reasoning.delta' | 'tool_call.delta' | 'tool_call.started' | 'tool_call.completed' | 'tool_call.timeout' | 'tool_call.retry' | 'tool_call.blocked' | 'output.delta' | 'output.completed' | 'diff.available' | 'error.occurred' | 'cost.update' | 'compensation.update' | 'sop.update' | 'state.sync';
export interface StructuredSSEEvent {
    event: StructuredSSEEventType;
    data: Record<string, unknown>;
    timestamp: string;
    seq: number;
}
export interface EntityState {
    id: string;
    type: 'agent' | 'tool' | 'mission' | 'subtask';
    status: 'idle' | 'running' | 'completed' | 'failed' | 'blocked';
    parentId?: string;
    metadata: Record<string, unknown>;
    updatedAt: string;
}
export interface EntityStateTree {
    entities: Map<string, EntityState>;
    rootIds: string[];
}
export declare class SSEStream {
    private subscribers;
    private unsubscribers;
    private closed;
    private seqCounter;
    private heartbeatTimer;
    private readonly heartbeatIntervalMs;
    private readonly retryMs;
    private eventBuffer;
    private readonly maxBufferSize;
    private entityStateTree;
    constructor(topics?: MessageBusTopic[], heartbeatIntervalMs?: number, options?: {
        retryMs?: number;
        maxBufferSize?: number;
    });
    private updateEntityState;
    getStateTree(): EntityStateTree;
    getEntity(id: string): EntityState | undefined;
    emitStateSync(): void;
    emitStructured(eventType: StructuredSSEEventType, data: Record<string, unknown>): void;
    private emitRaw;
    private dispatch;
    emitReasoning(content: string): void;
    emitToolCall(toolName: string, status: 'started' | 'completed' | 'delta', detail?: Record<string, unknown>): void;
    emitToolTimeout(toolName: string, detail?: Record<string, unknown>): void;
    emitToolRetry(toolName: string, attempt: number, detail?: Record<string, unknown>): void;
    emitToolBlocked(toolName: string, reason: string, detail?: Record<string, unknown>): void;
    /**
     * Emit an abort event with reason.
     * Follows Vercel AI SDK pattern for stream abortion.
     */
    emitAbort(reason: string): void;
    emitStatus(status: string, detail?: string): void;
    emitOutput(content: string, done?: boolean): void;
    /**
     * Replay events since a given Last-Event-ID.
     * Used for SSE reconnection — client sends Last-Event-ID header,
     * server replays missed events to close the gap.
     */
    replaySince(lastEventId: number): void;
    onEvent(callback: (event: string) => void): () => void;
    pipe(writable: {
        write(data: string): void;
    }): void;
    close(): void;
    get isClosed(): boolean;
}
//# sourceMappingURL=sseStream.d.ts.map