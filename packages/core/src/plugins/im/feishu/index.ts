import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type { IMIncomingRequest, IMMessage, IMReply, IMProvider } from '../../../im';

const feishuProvider: IMProvider = {
  id: 'feishu',
  name: 'Feishu',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const header = (body.header ?? {}) as Record<string, unknown>;
    const token = typeof header.token === 'string' ? header.token : '';
    return token === secret;
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = (body.event ?? {}) as Record<string, unknown>;
    const message = (event.message ?? {}) as Record<string, unknown>;
    const sender = (event.sender ?? {}) as Record<string, unknown>;
    const senderId = (sender.sender_id as Record<string, unknown> | undefined ?? {}) as Record<string, unknown>;
    const content = typeof message.content === 'string' ? message.content : '{}';

    let text = '';
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      text = typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      text = content;
    }

    return {
      messageId: String(message.message_id ?? ''),
      senderId: String(senderId.open_id ?? 'unknown'),
      conversationId: String(message.chat_id ?? 'unknown'),
      text,
      mentionIds: Array.isArray(message.mentions)
        ? (message.mentions as Array<Record<string, unknown>>)
            .map((m) => String(m.key ?? ''))
            .filter(Boolean)
        : undefined,
      metadata: { message_type: message.message_type },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: { code: 0, msg: 'success', reply: reply.text },
    };
  },
  stripMention(text: string): string {
    return text.replace(/@_user_\d+/g, '').trim();
  },
};

const feishuPlugin: CommanderPlugin = {
  name: 'im-feishu',
  version: '1.0.0',
  description: 'Feishu IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: feishuProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default feishuPlugin;
export { feishuProvider };
