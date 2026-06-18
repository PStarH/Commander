import { BaseChannelAdapter, type ChannelMessage, type SendOptions, type ChannelConfig } from '../channelAdapter';
interface TelegramConfig {
    botToken?: string;
}
export declare class TelegramAdapter extends BaseChannelAdapter {
    readonly platform = "telegram";
    readonly defaultConfig: ChannelConfig;
    private telegramConfig;
    private offset;
    private longPollTimer;
    private apiBase;
    initialize(config: unknown, agentLoop: unknown): Promise<void>;
    protected connectPlatform(): Promise<void>;
    protected disconnectPlatform(): Promise<void>;
    sendMessage(msg: ChannelMessage, text: string, opts?: SendOptions): Promise<void>;
    private telegramRequest;
    private pollUpdates;
    private processUpdate;
    private handleMessage;
    private handleCallbackQuery;
    start(): Promise<void>;
}
export declare function createTelegramAdapter(config?: Partial<TelegramConfig>): TelegramAdapter;
export {};
//# sourceMappingURL=telegramAdapter.d.ts.map