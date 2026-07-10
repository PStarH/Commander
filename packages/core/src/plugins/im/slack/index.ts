import * as crypto from 'node:crypto';
import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type {
  IMIncomingRequest,
  IMMessage,
  IMReply,
  IMProvider,
  IMOutboundCredentials,
} from '../../../im';

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

const slackProvider: IMProvider = {
  id: 'slack',
  name: 'Slack',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    const signature = req.headers['x-slack-signature'] as string | undefined;
    if (!timestamp || !signature) return false;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    return verifySlackSignature(secret, timestamp, rawBody, signature);
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = (body.event ?? {}) as Record<string, unknown>;
    const text = typeof event.text === 'string' ? event.text : '';
    return {
      messageId: String(event.ts ?? ''),
      senderId: String(event.user ?? 'unknown'),
      conversationId: String(event.channel ?? 'unknown'),
      text,
      metadata: { type: event.type, team: body.team_id },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: { text: reply.text },
    };
  },
  stripMention(text: string): string {
    return text.replace(/<@[^>]+>\s*/, '').trim();
  },
  async sendMessage(conversationId: string, reply: IMReply, config: IMOutboundCredentials) {
    const token = config.token;
    if (!token) throw new Error('Slack outbound token missing');
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: conversationId, text: reply.text }),
    });
    if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
  },
};

const slackPlugin: CommanderPlugin = {
  name: 'im-slack',
  version: '1.0.0',
  description: 'Slack IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: slackProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default slackPlugin;
export { slackProvider };
