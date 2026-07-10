import * as crypto from 'node:crypto';
import type { CommanderPlugin, PluginLoadContext } from '../../../pluginTypes';
import type { IMIncomingRequest, IMMessage, IMReply, IMProvider } from '../../../im';

function verifyDingTalkSignature(timestamp: string, sign: string, secret: string): boolean {
  const raw = `${timestamp}\n${secret}`;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(sign), Buffer.from(expected));
  } catch {
    return false;
  }
}

const dingtalkProvider: IMProvider = {
  id: 'dingtalk',
  name: 'DingTalk',
  verify(req: IMIncomingRequest, secret: string): boolean {
    const timestamp = req.query.timestamp as string | undefined;
    const sign = req.query.sign as string | undefined;
    if (!timestamp || !sign) return false;
    return verifyDingTalkSignature(timestamp, sign, secret);
  },
  parseMessage(req: IMIncomingRequest): IMMessage {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const msgtype = typeof body.msgtype === 'string' ? body.msgtype : 'text';
    let text = '';
    if (msgtype === 'text') {
      const textObj = body.text as Record<string, unknown> | undefined;
      text = typeof textObj?.content === 'string' ? textObj.content : '';
    } else if (msgtype === 'markdown') {
      const mdObj = body.markdown as Record<string, unknown> | undefined;
      text = typeof mdObj?.text === 'string' ? mdObj.text : '';
    }
    return {
      text,
      senderId: String((body.senderStaffId as string) ?? 'unknown'),
      conversationId: String((body.conversationId as string) ?? 'unknown'),
      metadata: { msgtype },
    };
  },
  formatReply(reply: IMReply) {
    return {
      body: { msgtype: 'text', text: { content: reply.text } },
    };
  },
  stripMention(text: string): string {
    return text.replace(/^\s*@\S+\s*/, '').trim();
  },
};

const dingtalkPlugin: CommanderPlugin = {
  name: 'im-dingtalk',
  version: '1.0.0',
  description: 'DingTalk IM provider',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: dingtalkProvider }],
  async onLoad(_ctx: PluginLoadContext) {
    // Provider is registered by the host via provides.
  },
};

export default dingtalkPlugin;
export { dingtalkProvider };
