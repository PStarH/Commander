export type MessageStatus = 'unread' | 'read' | 'acknowledged';
export interface InboxMessage {
    id: string;
    from: string;
    to: string;
    subject: string;
    body: string;
    priority: 'low' | 'normal' | 'high' | 'critical';
    status: MessageStatus;
    timestamp: string;
    readAt?: string;
    acknowledgedAt?: string;
    /** Optional payload for structured data (handoff, tool result, etc.) */
    payload?: Record<string, unknown>;
    /** Time-to-live in ms from timestamp. After expiry, message is auto-purged. */
    ttlMs?: number;
    /** Tags for filtering */
    tags: string[];
}
export declare class AgentInbox {
    private baseDir;
    private inboxes;
    private dirtyAgents;
    private flushTimer;
    constructor(baseDir?: string, flushIntervalMs?: number);
    dispose(): void;
    /** Send a message to an agent's inbox */
    send(msg: Omit<InboxMessage, 'status' | 'timestamp'>): void;
    /** Get all messages for an agent, optionally filtered by status */
    getMessages(agentId: string, status?: MessageStatus): InboxMessage[];
    /** Get unread messages for an agent */
    pollInbox(agentId: string): InboxMessage[];
    /** Mark a message as acknowledged (fully processed) */
    acknowledge(agentId: string, messageId: string): boolean;
    /** Delete a message from an agent's inbox */
    deleteMessage(agentId: string, messageId: string): boolean;
    /** Get inbox size for an agent */
    getInboxSize(agentId: string): number;
    /** Prune expired and acknowledged messages */
    prune(agentId?: string): number;
    /** List all agents that have inboxes */
    listAgents(): string[];
    private getOrCreateInbox;
    /** Auto-prune acknowledged/expired messages from an inbox if it exceeds the threshold */
    private autoPruneIfNeeded;
    private loadFromDisk;
    private flushDirty;
    private flushAgent;
}
//# sourceMappingURL=agentInbox.d.ts.map