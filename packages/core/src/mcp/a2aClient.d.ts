/**
 * A2AClient — Agent-to-Agent protocol HTTP client.
 *
 * Discovers remote A2A agents via their Agent Card, sends tasks via JSON-RPC,
 * and polls for completion. Supports Bearer token authentication.
 *
 * Flow:
 *   Commander Agent → A2AClient → HTTP POST → Remote A2A Server → Remote Agent
 */
import type { A2AAgentCard, A2ATask, A2AMessage, A2ASendMessageParams, A2AListTasksParams, A2AListTasksResult } from './a2aCompliance';
export declare class A2AClient {
    private baseUrl;
    private authToken?;
    private logger;
    private requestTimeoutMs;
    constructor(baseUrl: string, authToken?: string, timeoutMs?: number);
    getBaseUrl(): string;
    /**
     * Fetch Agent Card from the remote agent's well-known endpoint.
     */
    getAgentCard(): Promise<A2AAgentCard>;
    /**
     * Send a message to the remote agent and get back a task.
     */
    sendMessage(message: A2AMessage, configuration?: A2ASendMessageParams['configuration'], metadata?: Record<string, unknown>): Promise<A2ATask>;
    /**
     * Poll for task status by ID.
     */
    getTask(taskId: string, historyLength?: number): Promise<A2ATask>;
    /**
     * Wait for a task to reach a terminal state.
     * Polls at the specified interval.
     */
    waitForTask(taskId: string, pollIntervalMs?: number, maxWaitMs?: number): Promise<A2ATask>;
    /**
     * List tasks with optional filters.
     */
    listTasks(params?: A2AListTasksParams): Promise<A2AListTasksResult>;
    /**
     * Cancel a running task.
     */
    cancelTask(taskId: string): Promise<void>;
    private jsonRpcCall;
    private fetchWithTimeout;
}
export interface A2ADiscoveredAgent {
    label: string;
    url: string;
    client: A2AClient;
    card: A2AAgentCard;
    discoveredAt: string;
}
export declare class A2ADiscoveryManager {
    private agents;
    private logger;
    /**
     * Discover and register a remote A2A agent.
     * Fetches the Agent Card to verify it's a valid A2A endpoint.
     */
    discoverAgent(label: string, url: string, authToken?: string): Promise<A2ADiscoveredAgent>;
    getAgent(label: string): A2ADiscoveredAgent | undefined;
    getAllAgents(): A2ADiscoveredAgent[];
    removeAgent(label: string): boolean;
    getAgentCount(): number;
    /**
     * Discover multiple agents from config.
     * Each entry is { label: string, url: string, authToken?: string }.
     */
    discoverFromConfig(configs: Array<{
        label: string;
        url: string;
        authToken?: string;
    }>): Promise<void>;
}
export declare class A2ARpcError extends Error {
    code: number;
    data?: Record<string, unknown>;
    constructor(code: number, message: string, data?: Record<string, unknown>);
}
export declare function createA2AClient(baseUrl: string, authToken?: string): A2AClient;
export declare function createA2ADiscoveryManager(): A2ADiscoveryManager;
//# sourceMappingURL=a2aClient.d.ts.map