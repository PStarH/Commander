import { CommanderAgentLoop } from '../agentLoop';
export type ChannelStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type MessageRole = 'user' | 'assistant' | 'system';
export interface ChannelMessage {
    id: string;
    role: MessageRole;
    content: string;
    channelId: string;
    userId: string;
    username?: string;
    timestamp: string;
    threadId?: string;
    attachments?: ChannelAttachment[];
    metadata?: Record<string, unknown>;
}
export interface ChannelAttachment {
    type: 'text' | 'image' | 'file' | 'audio';
    url?: string;
    content?: string;
    mimeType?: string;
    filename?: string;
}
export interface ChannelConfig {
    channelId: string;
    name: string;
    enabled: boolean;
    autoResponse: boolean;
    maxConcurrentSessions: number;
    sessionTimeoutMs: number;
    allowedUsers?: string[];
    blockedUsers?: string[];
    adminUsers?: string[];
}
export interface SendOptions {
    replyTo?: string;
    threadId?: string;
    parseMode?: 'plain' | 'markdown' | 'html';
    typing?: boolean;
}
export interface ChannelAdapter {
    readonly platform: string;
    readonly defaultConfig: ChannelConfig;
    initialize(config: ChannelConfig, agentLoop: CommanderAgentLoop): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    sendMessage(channelMessage: ChannelMessage, text: string, options?: SendOptions): Promise<void>;
    getStatus(): ChannelStatus;
    onEvent(event: string, handler: (data: unknown) => void): void;
}
export declare abstract class BaseChannelAdapter implements ChannelAdapter {
    abstract readonly platform: string;
    abstract readonly defaultConfig: ChannelConfig;
    protected config: ChannelConfig;
    protected agentLoop: CommanderAgentLoop;
    protected bus: import("./messageBus").MessageBus;
    protected status: ChannelStatus;
    protected eventHandlers: Map<string, Set<(data: unknown) => void>>;
    protected sessions: Map<string, {
        userId: string;
        lastMessage: number;
        threadId?: string;
    }>;
    private busUnsubscribers;
    initialize(config: ChannelConfig, agentLoop: CommanderAgentLoop): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): ChannelStatus;
    onEvent(event: string, handler: (data: unknown) => void): void;
    protected emitEvent(event: string, data: unknown): void;
    protected isUserAllowed(userId: string): boolean;
    protected isAdmin(userId: string): boolean;
    protected manageSession(userId: string, threadId?: string): {
        isNew: boolean;
        sessionId: string;
    };
    protected cleanupStaleSessions(): void;
    protected handleIncomingMessage(msg: ChannelMessage): Promise<void>;
    protected normalizeMessage(msg: ChannelMessage): ChannelMessage;
    protected onAgentEvent(_type: 'started' | 'completed' | 'failed', _data: unknown): void;
    protected abstract connectPlatform(): Promise<void>;
    protected abstract disconnectPlatform(): Promise<void>;
    abstract sendMessage(channelMessage: ChannelMessage, text: string, options?: SendOptions): Promise<void>;
}
//# sourceMappingURL=channelAdapter.d.ts.map