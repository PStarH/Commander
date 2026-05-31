import { BaseChannelAdapter, type ChannelMessage, type SendOptions, type ChannelConfig } from '../channelAdapter';
import type { CommanderAgentLoop } from '../../agentLoop';
import { getGlobalLogger } from '../../logging';

interface TelegramConfig {
  botToken?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: TelegramMessage;
    data: string;
  };
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; title?: string };
  text?: string;
  document?: { file_id: string; file_name: string };
  photo?: Array<{ file_id: string; file_unique_id: string }>;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export class TelegramAdapter extends BaseChannelAdapter {
  readonly platform = 'telegram';
  readonly defaultConfig: ChannelConfig = {
    channelId: 'telegram',
    name: 'Telegram',
    enabled: true,
    autoResponse: true,
    maxConcurrentSessions: 5,
    sessionTimeoutMs: 3600000,
  };

  private telegramConfig: TelegramConfig = {};
  private offset = 0;
  private longPollTimer: ReturnType<typeof setTimeout> | null = null;
  private apiBase = 'https://api.telegram.org';

  async initialize(config: unknown, agentLoop: unknown): Promise<void> {
    this.telegramConfig = (config as TelegramConfig) || {};
    const cfg: ChannelConfig = { ...this.defaultConfig, ...((config || {}) as Record<string, unknown>) };
    await super.initialize(cfg, agentLoop as CommanderAgentLoop);
  }

  protected async connectPlatform(): Promise<void> {
    if (!this.telegramConfig.botToken) throw new Error('Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN env var.');
    await this.telegramRequest('getMe');
  }

  protected async disconnectPlatform(): Promise<void> {
    if (this.longPollTimer) clearTimeout(this.longPollTimer);
  }

  async sendMessage(msg: ChannelMessage, text: string, opts?: SendOptions): Promise<void> {
    const parseMode = opts?.parseMode === 'html' ? 'HTML' : opts?.parseMode === 'markdown' ? 'MarkdownV2' : undefined;
    await this.telegramRequest('sendMessage', {
      chat_id: msg.metadata?.chatId as number ?? 0,
      text,
      reply_to_message_id: opts?.replyTo ? Number(opts.replyTo) : undefined,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
  }

  private async telegramRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const token = this.telegramConfig.botToken;
    if (!token) return null;
    const url = `${this.apiBase}/bot${token}/${method}`;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await response.json() as { ok: boolean; result?: unknown; description?: string };
      if (!data.ok) this.bus.publish('channel.error', this.config.channelId, { platform: this.platform, error: data.description });
      return data.result;
    } catch (err) {
      getGlobalLogger().error('Telegram', `${method} failed`, err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  private async pollUpdates(): Promise<void> {
    try {
      const token = this.telegramConfig.botToken;
      if (!token) return;
      const response = await fetch(`${this.apiBase}/bot${token}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message', 'callback_query']))}`, { method: 'GET' });
      if (!response.ok) { this.longPollTimer = setTimeout(() => this.pollUpdates(), 5000); this.longPollTimer?.unref(); return; }
      const data: { ok: boolean; result?: TelegramUpdate[] } = await response.json() as { ok: boolean; result?: TelegramUpdate[] };
      if (data.result) {
        for (const update of data.result) {
          this.offset = update.update_id + 1;
          this.processUpdate(update);
        }
      }
    } catch (err) { getGlobalLogger().error('Telegram', 'Poll error', err instanceof Error ? err : new Error(String(err))); }
    this.longPollTimer = setTimeout(() => this.pollUpdates(), 1000);
    this.longPollTimer?.unref();
  }

  private processUpdate(update: TelegramUpdate): void {
    if (update.message) this.handleMessage(update.message);
    else if (update.edited_message) this.handleMessage(update.edited_message);
    else if (update.callback_query) this.handleCallbackQuery(update.callback_query);
  }

  private handleMessage(msg: TelegramMessage): void {
    const text = msg.text || msg.caption;
    if (!text) return;
    const userId = String(msg.from?.id ?? msg.chat.id);
    if (!this.isUserAllowed(userId)) {
      const denyMsg: ChannelMessage = { id: String(msg.message_id), role: 'user', content: '', channelId: '', userId, timestamp: new Date().toISOString() };
      this.sendMessage(denyMsg, 'Access denied.').catch(e => getGlobalLogger().warn('Telegram', 'Failed to send access denied message', { error: (e as Error)?.message }));
      return;
    }
    const channelMsg: ChannelMessage = {
      id: String(msg.message_id), role: 'user', content: text,
      channelId: this.config.channelId, userId,
      username: msg.from?.username,
      timestamp: new Date().toISOString(),
      threadId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      metadata: { chatId: msg.chat.id, chatType: msg.chat.type },
    };
    this.handleIncomingMessage(channelMsg);
  }

  private handleCallbackQuery(query: TelegramUpdate['callback_query']): void {
    if (!query?.message || !query?.data) return;
    this.bus.publish('channel.interaction', this.config.channelId, {
      queryId: query.id, userId: String(query.from.id), username: query.from.username,
      data: query.data, messageId: String(query.message.message_id),
    });
  }

  override async start(): Promise<void> {
    await super.start();
    await this.pollUpdates();
  }
}

export function createTelegramAdapter(config?: Partial<TelegramConfig>): TelegramAdapter {
  const adapter = new TelegramAdapter();
  if (config?.botToken) adapter.defaultConfig.channelId = `telegram:${config.botToken.slice(0, 8)}`;
  return adapter;
}
