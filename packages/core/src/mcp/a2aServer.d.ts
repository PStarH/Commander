import type { AgentRuntimeInterface } from '../runtime';
import type { A2AAgentCard } from './a2aCompliance';
export interface A2AServerConfig {
    port: number;
    host: string;
    agentCard: A2AAgentCard;
    /** JSON-RPC endpoint path (default: /) */
    endpoint?: string;
    /** Graceful shutdown timeout in ms (default: 5000) */
    shutdownTimeoutMs?: number;
    /** Max time in ms to wait for a task to complete (default: 120000). 0 = no limit. */
    taskTimeoutMs?: number;
    /** Allowed CORS origins. Empty means no browser origins are allowed. */
    corsAllowedOrigins?: string[];
    /** Maximum JSON request body size in bytes. Default: 1 MiB. */
    maxBodyBytes?: number;
}
export declare class A2AServer {
    private config;
    private runtime;
    private server;
    private tasks;
    private connections;
    private logger;
    private nextTaskId;
    private static readonly MAX_TASKS;
    constructor(config: A2AServerConfig, runtime: AgentRuntimeInterface);
    start(): Promise<void>;
    getPort(): number;
    stop(): Promise<void>;
    getTaskCount(): number;
    private handleRequest;
    private handleJsonRpc;
    private handleSendMessage;
    private handleGetTask;
    private handleListTasks;
    private handleCancelTask;
    private updateTaskState;
    private static readonly TERMINAL_STATES;
    private pruneCompletedTasks;
    private parseBody;
    private sendJson;
    private applyCommonHeaders;
    private makeSuccessResponse;
    private makeErrorResponse;
}
export declare function createA2AServer(config: A2AServerConfig, runtime: AgentRuntimeInterface): A2AServer;
//# sourceMappingURL=a2aServer.d.ts.map