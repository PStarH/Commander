export interface AgentLoopConfig {
    projectRoot: string;
    maxConcurrentTasks: number;
    sessionTimeoutMs: number;
    stateFile: string;
    tools: string[];
}
export declare class CommanderAgentLoop {
    private runtime;
    private telos;
    private orchestrator;
    private config;
    private taskQueue;
    private activeSessions;
    private isRunning;
    private mcpManager;
    private a2aServer;
    private a2aDiscoveryManager;
    private logger;
    constructor(config?: Partial<AgentLoopConfig>);
    /**
     * Register LLM providers from environment variables.
     * Uses dynamic imports to avoid loading all 21 provider modules at compile time.
     * Called from start() before the main loop begins.
     */
    registerProviders(): Promise<void>;
    private loadState;
    private saveState;
    private static readonly MAX_QUEUE_SIZE;
    addTask(goal: string, priority?: number): string;
    getQueueLength(): number;
    getActiveCount(): number;
    /**
     * Initialize MCP/A2A external integrations.
     * Called once at the start of start() since connections are async.
     */
    private initializeExternalIntegrations;
    start(): Promise<void>;
    private executeTask;
    stop(): Promise<void>;
    getStatus(): object;
    private sleep;
}
//# sourceMappingURL=agentLoop.d.ts.map