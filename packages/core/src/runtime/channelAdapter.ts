import { CommanderAgentLoop } from '../agentLoop';
import { getMessageBus } from './messageBus';

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

export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly platform: string;
  abstract readonly defaultConfig: ChannelConfig;

  protected config!: ChannelConfig;
  protected agentLoop!: CommanderAgentLoop;
  protected bus = getMessageBus();
  protected status: ChannelStatus = 'disconnected';
  protected eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  protected sessions: Map<string, { userId: string; lastMessage: number; threadId?: string }> = new Map();

  async initialize(config: ChannelConfig, agentLoop: CommanderAgentLoop): Promise<void> {
    this.config = { ...this.defaultConfig, ...config };
    this.agentLoop = agentLoop;

    this.bus.subscribe('agent.started', () => {
      this.onAgentEvent('started', { source: this.config.channelId });
    });
    this.bus.subscribe('agent.completed', () => {
      this.onAgentEvent('completed', { source: this.config.channelId });
    });
    this.bus.subscribe('agent.failed', () => {
      this.onAgentEvent('failed', { source: this.config.channelId });
    });
  }

  async start(): Promise<void> {
    this.status = 'connecting';
    await this.connectPlatform();
    this.status = 'connected';
    this.bus.publish('channel.connected', this.config.channelId, { platform: this.platform });
  }

  async stop(): Promise<void> {
    this.status = 'disconnected';
    await this.disconnectPlatform();
    this.bus.publish('channel.disconnected', this.config.channelId, { platform: this.platform });
  }

  getStatus(): ChannelStatus { return this.status; }

  onEvent(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event)!.add(handler);
  }

  protected emitEvent(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach(h => h(data));
  }

  protected isUserAllowed(userId: string): boolean {
    if (this.config.blockedUsers?.includes(userId)) return false;
    if (this.config.allowedUsers?.length && !this.config.allowedUsers.includes(userId)) return false;
    return true;
  }

  protected isAdmin(userId: string): boolean {
    return this.config.adminUsers?.includes(userId) ?? false;
  }

  protected manageSession(userId: string, threadId?: string): { isNew: boolean; sessionId: string } {
    const sessionKey = `${userId}:${threadId ?? 'default'}`;
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastMessage = Date.now();
      return { isNew: false, sessionId: sessionKey };
    }
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      const oldest = Array.from(this.sessions.entries()).sort((a, b) => a[1].lastMessage - b[1].lastMessage)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    this.sessions.set(sessionKey, { userId, lastMessage: Date.now(), threadId });
    return { isNew: true, sessionId: sessionKey };
  }

  protected cleanupStaleSessions(): void {
    const timeout = this.config.sessionTimeoutMs;
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastMessage > timeout) this.sessions.delete(key);
    }
  }

  protected async handleIncomingMessage(msg: ChannelMessage): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.isUserAllowed(msg.userId)) return;
    this.manageSession(msg.userId, msg.threadId);
    this.cleanupStaleSessions();
    const normalized = this.normalizeMessage(msg);
    this.bus.publish('channel.message', this.config.channelId, normalized);
    if (this.config.autoResponse) {
      this.agentLoop.addTask(normalized.content, this.isAdmin(msg.userId) ? 10 : 0);
    }
    this.emitEvent('message', normalized);
  }

  protected normalizeMessage(msg: ChannelMessage): ChannelMessage {
    return { ...msg, channelId: this.config.channelId, timestamp: msg.timestamp || new Date().toISOString() };
  }

  protected onAgentEvent(_type: 'started' | 'completed' | 'failed', _data: unknown): void {
    this.emitEvent(_type, {});
  }

  protected abstract connectPlatform(): Promise<void>;
  protected abstract disconnectPlatform(): Promise<void>;
  abstract sendMessage(channelMessage: ChannelMessage, text: string, options?: SendOptions): Promise<void>;
}
