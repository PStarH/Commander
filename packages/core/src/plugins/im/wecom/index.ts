import * as crypto from 'node:crypto';
import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type { IMIncomingRequest, IMMessage, IMReply, IMProvider } from '../../../im';

function extractXmlField(xml: string, field: string): string | undefined {
  const cdata = xml.match(new RegExp(`<${field}><!\\\[CDATA\\\[([\\s\\S]*?)\\\]\\\]></${field}>`));
  if (cdata) return cdata[1] ?? undefined;
  const plain = xml.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`));
  return plain ? (plain[1] ?? undefined) : undefined;
}

function verifyWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  signature: string,
): boolean {
  const raw = [token, timestamp, nonce, encrypt].sort().join('');
  const expected = crypto.createHash('sha1').update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

const wecomProvider: IMProvider = {
  id: 'wecom',
  name: 'WeCom',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const msgSignature = req.query.msg_signature as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;
    const nonce = req.query.nonce as string | undefined;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const encrypt = extractXmlField(rawBody, 'Encrypt');
    if (!msgSignature || !timestamp || !nonce || !encrypt) return false;
    return verifyWeComSignature(secret, timestamp, nonce, encrypt, msgSignature);
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const content = extractXmlField(rawBody, 'Content') ?? '';
    const fromUser = extractXmlField(rawBody, 'FromUserName') ?? 'unknown';
    const toUser = extractXmlField(rawBody, 'ToUserName') ?? 'unknown';
    return {
      senderId: fromUser,
      conversationId: toUser,
      text: content,
      metadata: { msgType: extractXmlField(rawBody, 'MsgType') },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: `<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${reply.text}]]></Content></xml>`,
      headers: { 'Content-Type': 'application/xml' },
    };
  },
  stripMention(text: string): string {
    return text.replace(/^\s*@\S+\s*/, '').trim();
  },
};

const wecomPlugin: CommanderPlugin = {
  name: 'im-wecom',
  version: '1.0.0',
  description: 'WeCom IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: wecomProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default wecomPlugin;
export { wecomProvider };
