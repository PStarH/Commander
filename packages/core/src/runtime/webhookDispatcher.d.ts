export interface WebhookConfig {
    id: string;
    url: string;
    /** Event topic patterns to subscribe to (e.g. ['agent.started', 'agent.completed']). '*' for all. */
    events: string[];
    /** HMAC secret for signing payloads. Auto-generated if omitted. */
    secret?: string;
    /** Max retries on failure (default: 3) */
    retryMax?: number;
    /** Additional HTTP headers */
    headers?: Record<string, string>;
    enabled: boolean;
    createdAt: string;
    /** Optional friendly name */
    name?: string;
    /** Optional description */
    description?: string;
}
export interface WebhookEvent {
    event: string;
    timestamp: string;
    source: string;
    payload: unknown;
}
export interface WebhookDelivery {
    webhookId: string;
    event: string;
    status: 'success' | 'failed' | 'retrying';
    statusCode?: number;
    attempts: number;
    error?: string;
    deliveredAt: string;
}
export declare class WebhookDispatcher {
    private webhooks;
    private unsubscribers;
    private started;
    private deliveryLog;
    private maxDeliveryLog;
    constructor();
    /** Start listening to MessageBus events. */
    start(): void;
    /** Stop listening and clean up. */
    stop(): void;
    registerWebhook(config: Omit<WebhookConfig, 'id' | 'createdAt'>): WebhookConfig;
    deregisterWebhook(id: string): boolean;
    getWebhook(id: string): WebhookConfig | undefined;
    listWebhooks(): WebhookConfig[];
    /** Dispatch an event to all matching webhooks. Non-blocking — fires and forgets. */
    dispatch(event: string, payload: unknown, source?: string): void;
    getDeliveryLog(limit?: number): WebhookDelivery[];
    getStats(): {
        total: number;
        enabled: number;
        deliveries: number;
    };
    private sendWithRetry;
    private logDelivery;
    private save;
    private load;
}
export declare function getWebhookDispatcher(): WebhookDispatcher;
export declare function resetWebhookDispatcher(): void;
//# sourceMappingURL=webhookDispatcher.d.ts.map