export interface IMThreadContext {
  /** Composite key: `${platform}:${conversationId}:${senderId}` */
  threadId: string;
  platform: string;
  conversationId: string;
  senderId: string;
  /** Last N sanitized user/assistant message pairs. */
  messages: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>;
  /** Runtime runId of any in-flight task. */
  pendingRunId?: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface IMContextStore {
  getContext(
    platform: string,
    conversationId: string,
    senderId: string,
  ): Promise<IMThreadContext | undefined>;
  appendUserMessage(
    platform: string,
    conversationId: string,
    senderId: string,
    text: string,
  ): Promise<IMThreadContext>;
  appendAssistantMessage(
    platform: string,
    conversationId: string,
    senderId: string,
    text: string,
  ): Promise<void>;
  setPendingRunId(
    platform: string,
    conversationId: string,
    senderId: string,
    runId: string,
  ): Promise<void>;
  clearPendingRunId(
    platform: string,
    conversationId: string,
    senderId: string,
  ): Promise<void>;
  resetContext(platform: string, conversationId: string, senderId: string): Promise<void>;
}

export class InMemoryIMContextStore implements IMContextStore {
  private contexts = new Map<string, IMThreadContext>();
  private maxMessages = 20;

  private key(platform: string, conversationId: string, senderId: string): string {
    return `${platform}:${conversationId}:${senderId}`;
  }

  async getContext(
    platform: string,
    conversationId: string,
    senderId: string,
  ): Promise<IMThreadContext | undefined> {
    return this.contexts.get(this.key(platform, conversationId, senderId));
  }

  async appendUserMessage(
    platform: string,
    conversationId: string,
    senderId: string,
    text: string,
  ): Promise<IMThreadContext> {
    const now = new Date().toISOString();
    const ctx = await this.getContext(platform, conversationId, senderId);
    const updated: IMThreadContext = ctx
      ? {
          ...ctx,
          messages: [...ctx.messages, { role: 'user' as const, text, ts: now }].slice(-this.maxMessages),
          updatedAt: now,
        }
      : {
          threadId: this.key(platform, conversationId, senderId),
          platform,
          conversationId,
          senderId,
          messages: [{ role: 'user' as const, text, ts: now }],
          updatedAt: now,
          createdAt: now,
        };
    this.contexts.set(updated.threadId, updated);
    return updated;
  }

  async appendAssistantMessage(
    platform: string,
    conversationId: string,
    senderId: string,
    text: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const ctx = await this.getContext(platform, conversationId, senderId);
    if (!ctx) return;
    ctx.messages = [...ctx.messages, { role: 'assistant' as const, text, ts: now }].slice(-this.maxMessages);
    ctx.updatedAt = now;
  }

  async setPendingRunId(
    platform: string,
    conversationId: string,
    senderId: string,
    runId: string,
  ): Promise<void> {
    const ctx = await this.getContext(platform, conversationId, senderId);
    if (!ctx) return;
    ctx.pendingRunId = runId;
    ctx.updatedAt = new Date().toISOString();
  }

  async clearPendingRunId(
    platform: string,
    conversationId: string,
    senderId: string,
  ): Promise<void> {
    const ctx = await this.getContext(platform, conversationId, senderId);
    if (!ctx) return;
    delete ctx.pendingRunId;
    ctx.updatedAt = new Date().toISOString();
  }

  async resetContext(
    platform: string,
    conversationId: string,
    senderId: string,
  ): Promise<void> {
    this.contexts.delete(this.key(platform, conversationId, senderId));
  }
}

let store: IMContextStore | undefined;

export function getIMContextStore(): IMContextStore {
  if (!store) store = new InMemoryIMContextStore();
  return store;
}

export function resetIMContextStore(): IMContextStore {
  store = new InMemoryIMContextStore();
  return store;
}
