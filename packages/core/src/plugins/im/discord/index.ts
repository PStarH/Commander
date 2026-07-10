import * as crypto from 'node:crypto';
import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type {
  IMIncomingRequest,
  IMMessage,
  IMReply,
  IMProvider,
  IMOutboundCredentials,
} from '../../../im';

const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519RawToSpkiDer(rawHex: string): Buffer {
  const raw = Buffer.from(rawHex, 'hex');
  if (raw.length !== 32) throw new Error('Invalid Ed25519 public key length');
  return Buffer.concat([ED25519_SPKI_HEADER, raw]);
}

function verifyDiscordSignature(
  publicKey: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: ed25519RawToSpkiDer(publicKey),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody),
      key,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

const discordProvider: IMProvider = {
  id: 'discord',
  name: 'Discord',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const timestamp = req.headers['x-signature-timestamp'] as string | undefined;
    const signature = req.headers['x-signature-ed25519'] as string | undefined;
    if (!timestamp || !signature) return false;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    return verifyDiscordSignature(secret, timestamp, rawBody, signature);
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const data = (req.body ?? {}) as Record<string, unknown>;
    const member = (data.member ?? {}) as Record<string, unknown>;
    const user = (member.user ?? data.user ?? {}) as Record<string, unknown>;
    const text = typeof data.content === 'string' ? data.content : '';
    const channelId = typeof data.channel_id === 'string' ? data.channel_id : 'unknown';
    return {
      messageId: String(data.id ?? ''),
      senderId: String(user.id ?? 'unknown'),
      conversationId: channelId,
      text,
      metadata: { type: data.type },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: { content: reply.text, flags: 64 },
    };
  },
  stripMention(text: string): string {
    return text.replace(/<@!?\d+>\s*/, '').trim();
  },
  async sendMessage(conversationId: string, reply: IMReply, config: IMOutboundCredentials) {
    const token = config.token;
    if (!token) throw new Error('Discord bot token missing');
    const res = await fetch(`https://discord.com/api/v10/channels/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: reply.text }),
    });
    if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
  },
};

const discordPlugin: CommanderPlugin = {
  name: 'im-discord',
  version: '1.0.0',
  description: 'Discord IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: discordProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default discordPlugin;
export { discordProvider };
