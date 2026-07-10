import * as crypto from 'node:crypto';
import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type {
  IMIncomingRequest,
  IMMessage,
  IMReply,
  IMProvider,
  IMOutboundCredentials,
} from '../../../im';

function verifyTeamsSignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

const teamsProvider: IMProvider = {
  id: 'teams',
  name: 'Microsoft Teams',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const signature = req.headers['authorization'] as string | undefined;
    if (!signature) return false;
    return verifyTeamsSignature(rawBody, secret, signature);
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const activity = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof activity.text === 'string' ? activity.text : '';
    const from = (activity.from ?? {}) as Record<string, unknown>;
    const conversation = (activity.conversation ?? {}) as Record<string, unknown>;
    return {
      messageId: String(activity.id ?? ''),
      senderId: String(from.id ?? 'unknown'),
      conversationId: String(conversation.id ?? 'unknown'),
      text,
      metadata: { type: activity.type, serviceUrl: activity.serviceUrl },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: {
        type: 'message',
        text: reply.text,
        from: { id: 'commander-bot', name: 'Commander' },
        conversation: { id: reply.conversationId },
      },
    };
  },
  stripMention(text: string): string {
    return text.replace(/<at>[^<]+<\/at>\s*/, '').trim();
  },
  async sendMessage(conversationId: string, reply: IMReply, config: IMOutboundCredentials) {
    const endpoint = config.endpoint;
    if (!endpoint) throw new Error('Teams service URL missing');
    const res = await fetch(`${endpoint}/v3/conversations/${conversationId}/activities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        text: reply.text,
        conversation: { id: conversationId },
      }),
    });
    if (!res.ok) throw new Error(`Teams API error: ${res.status}`);
  },
};

const teamsPlugin: CommanderPlugin = {
  name: 'im-teams',
  version: '1.0.0',
  description: 'Microsoft Teams IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: teamsProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default teamsPlugin;
export { teamsProvider };
