"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramAdapter = void 0;
exports.createTelegramAdapter = createTelegramAdapter;
const channelAdapter_1 = require("../channelAdapter");
const logging_1 = require("../../logging");
class TelegramAdapter extends channelAdapter_1.BaseChannelAdapter {
    constructor() {
        super(...arguments);
        this.platform = 'telegram';
        this.defaultConfig = {
            channelId: 'telegram',
            name: 'Telegram',
            enabled: true,
            autoResponse: true,
            maxConcurrentSessions: 5,
            sessionTimeoutMs: 3600000,
        };
        this.telegramConfig = {};
        this.offset = 0;
        this.longPollTimer = null;
        this.apiBase = 'https://api.telegram.org';
    }
    async initialize(config, agentLoop) {
        this.telegramConfig = config || {};
        const cfg = {
            ...this.defaultConfig,
            ...(config || {}),
        };
        await super.initialize(cfg, agentLoop);
    }
    async connectPlatform() {
        if (!this.telegramConfig.botToken)
            throw new Error('Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN env var.');
        await this.telegramRequest('getMe');
    }
    async disconnectPlatform() {
        if (this.longPollTimer)
            clearTimeout(this.longPollTimer);
    }
    async sendMessage(msg, text, opts) {
        var _a, _b;
        const parseMode = (opts === null || opts === void 0 ? void 0 : opts.parseMode) === 'html'
            ? 'HTML'
            : (opts === null || opts === void 0 ? void 0 : opts.parseMode) === 'markdown'
                ? 'MarkdownV2'
                : undefined;
        await this.telegramRequest('sendMessage', {
            chat_id: (_b = (_a = msg.metadata) === null || _a === void 0 ? void 0 : _a.chatId) !== null && _b !== void 0 ? _b : 0,
            text,
            reply_to_message_id: (opts === null || opts === void 0 ? void 0 : opts.replyTo) ? Number(opts.replyTo) : undefined,
            parse_mode: parseMode,
            disable_web_page_preview: true,
        });
    }
    async telegramRequest(method, params = {}) {
        const token = this.telegramConfig.botToken;
        if (!token)
            return null;
        const url = `${this.apiBase}/bot${token}/${method}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });
            const data = (await response.json());
            if (!data.ok)
                this.bus.publish('channel.error', this.config.channelId, {
                    platform: this.platform,
                    error: data.description,
                });
            return data.result;
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('Telegram', `${method} failed`, err instanceof Error ? err : new Error(String(err)));
            return null;
        }
    }
    async pollUpdates() {
        var _a, _b;
        try {
            const token = this.telegramConfig.botToken;
            if (!token)
                return;
            const response = await fetch(`${this.apiBase}/bot${token}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message', 'callback_query']))}`, { method: 'GET' });
            if (!response.ok) {
                this.longPollTimer = setTimeout(() => this.pollUpdates(), 5000);
                (_a = this.longPollTimer) === null || _a === void 0 ? void 0 : _a.unref();
                return;
            }
            const data = (await response.json());
            if (data.result) {
                for (const update of data.result) {
                    this.offset = update.update_id + 1;
                    this.processUpdate(update);
                }
            }
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('Telegram', 'Poll error', err instanceof Error ? err : new Error(String(err)));
        }
        this.longPollTimer = setTimeout(() => this.pollUpdates(), 1000);
        (_b = this.longPollTimer) === null || _b === void 0 ? void 0 : _b.unref();
    }
    processUpdate(update) {
        if (update.message)
            this.handleMessage(update.message);
        else if (update.edited_message)
            this.handleMessage(update.edited_message);
        else if (update.callback_query)
            this.handleCallbackQuery(update.callback_query);
    }
    handleMessage(msg) {
        var _a, _b, _c;
        const text = msg.text || msg.caption;
        if (!text)
            return;
        const userId = String((_b = (_a = msg.from) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : msg.chat.id);
        if (!this.isUserAllowed(userId)) {
            const denyMsg = {
                id: String(msg.message_id),
                role: 'user',
                content: '',
                channelId: '',
                userId,
                timestamp: new Date().toISOString(),
            };
            this.sendMessage(denyMsg, 'Access denied.').catch((e) => (0, logging_1.getGlobalLogger)().warn('Telegram', 'Failed to send access denied message', {
                error: e === null || e === void 0 ? void 0 : e.message,
            }));
            return;
        }
        const channelMsg = {
            id: String(msg.message_id),
            role: 'user',
            content: text,
            channelId: this.config.channelId,
            userId,
            username: (_c = msg.from) === null || _c === void 0 ? void 0 : _c.username,
            timestamp: new Date().toISOString(),
            threadId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
            metadata: { chatId: msg.chat.id, chatType: msg.chat.type },
        };
        this.handleIncomingMessage(channelMsg);
    }
    handleCallbackQuery(query) {
        if (!(query === null || query === void 0 ? void 0 : query.message) || !(query === null || query === void 0 ? void 0 : query.data))
            return;
        this.bus.publish('channel.interaction', this.config.channelId, {
            queryId: query.id,
            userId: String(query.from.id),
            username: query.from.username,
            data: query.data,
            messageId: String(query.message.message_id),
        });
    }
    async start() {
        await super.start();
        await this.pollUpdates();
    }
}
exports.TelegramAdapter = TelegramAdapter;
function createTelegramAdapter(config) {
    const adapter = new TelegramAdapter();
    if (config === null || config === void 0 ? void 0 : config.botToken)
        adapter.defaultConfig.channelId = `telegram:${config.botToken.slice(0, 8)}`;
    return adapter;
}
