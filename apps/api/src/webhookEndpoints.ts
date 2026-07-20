/**
 * webhookEndpoints — IM (DingTalk / Feishu / WeCom) webhook integration router.
 *
 * Chinese enterprises overwhelmingly use DingTalk, Feishu, and WeCom for daily
 * communication. This router lets an Agent be embedded directly into those IM
 * workflows: users @mention the bot in a group chat, the IM platform forwards
 * the message to Commander via a webhook URL, Commander dispatches it to the
 * target Agent via the shared AgentRuntime, and the Agent's reply is returned
 * in the platform-specific response format.
 *
 * Endpoints:
 *   POST /api/webhook/dingtalk/:id?  — DingTalk robot callback
 *   POST /api/webhook/feishu/:id?    — Feishu bot callback
 *   POST /api/webhook/wecom/:id?     — WeCom app callback
 *   GET  /api/webhook/config         — list configured IM webhooks
 *   POST /api/webhook/config         — create a new IM webhook config
 *   DELETE /api/webhook/config/:id   — delete an IM webhook config
 *
 * Config persistence: `.commander/webhooks.json` (IM configs carry a `platform`
 * field so they coexist with any pre-existing outgoing-webhook entries).
 */
import { reportSilentFailure } from '@commander/core';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getSharedRuntime } from './sharedRuntime';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import {
  timingSafeEqualString,
  verifyDingTalkSignature,
  verifyWeComSignature,
} from './webhookCrypto';

// ── Types ─────────────────────────────────────────────────────────────────

export type WebhookPlatform = 'dingtalk' | 'feishu' | 'wecom';

export interface IMWebhookConfig {
  id: string;
  platform: WebhookPlatform;
  name: string;
  /** Shared secret used for signature verification. */
  secret: string;
  /** Target agent that will process incoming messages. */
  agentId: string;
  enabled: boolean;
  createdAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────

const WEBHOOK_FILE = path.join(process.cwd(), '.commander', 'webhooks.json');

function readAllWebhooks(): unknown[] {
  try {
    const raw = fs.readFileSync(WEBHOOK_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    reportSilentFailure(err, 'webhookEndpoints:readAllWebhooks');
    return [];
  }
}

function writeAllWebhooks(entries: unknown[]): void {
  const dir = path.dirname(WEBHOOK_FILE);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (err) {
    reportSilentFailure(err, 'webhookEndpoints:writeAllWebhooks');
  }
}

function readIMWebhooks(): IMWebhookConfig[] {
  const all = readAllWebhooks();
  const result: IMWebhookConfig[] = [];
  for (const entry of all) {
    if (
      entry &&
      typeof entry === 'object' &&
      'platform' in entry &&
      typeof (entry as Record<string, unknown>).platform === 'string'
    ) {
      result.push(entry as IMWebhookConfig);
    }
  }
  return result;
}

function writeIMWebhooks(imConfigs: IMWebhookConfig[]): void {
  const all = readAllWebhooks();
  // Preserve non-IM entries (legacy outgoing webhooks without a `platform` field)
  const nonIM = all.filter(
    (e) =>
      !e || typeof e !== 'object' || typeof (e as Record<string, unknown>).platform !== 'string',
  );
  writeAllWebhooks([...nonIM, ...imConfigs]);
}

function findIMWebhook(id: string): IMWebhookConfig | undefined {
  return readIMWebhooks().find((w) => w.id === id);
}

function generateId(): string {
  return `imwh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Extract <Tag>content</Tag> from a WeCom XML payload. */
function extractXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (match) return match[1] ?? null;
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain ? (plain[1] ?? null) : null;
}

// ── Agent execution helper ────────────────────────────────────────────────

async function executeAgentMessage(agentId: string, message: string): Promise<string> {
  const runtime = getSharedRuntime();
  const result = await runtime.execute({
    agentId,
    projectId: 'project-war-room',
    goal: message,
    contextData: {},
    availableTools: [],
    tokenBudget: 50000,
    maxSteps: 20,
  });

  return (
    result.summary || (result.status === 'success' ? 'Task completed.' : `Task ${result.status}.`)
  );
}

// ── Validation schemas ────────────────────────────────────────────────────

const createWebhookSchema = z.object({
  platform: z.enum(['dingtalk', 'feishu', 'wecom']),
  name: z.string().min(1).max(128),
  secret: z.string().max(256).optional(),
  agentId: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
});

// ── Router ────────────────────────────────────────────────────────────────

export function createWebhookRouter(): Router {
  const router = Router();

  // ── POST /api/webhook/dingtalk/:id? — DingTalk robot callback ─────────
  // Express 5 / path-to-regexp v8 drops :param? optional syntax. Register
  // both paths explicitly so either /dingtalk and /dingtalk/:id match.
  async function dingtalkHandler(req: Request, res: Response): Promise<void> {
    try {
      const id = typeof req.params.id === 'string' ? req.params.id : undefined;
      const config = id ? findIMWebhook(id) : undefined;

      // A valid webhook config is required for all DingTalk callbacks.
      if (!config) {
        res.status(401).json({ error: 'Webhook config required' });
        return;
      }

      // Signature verification is mandatory when a config exists.
      const timestamp = req.query.timestamp as string | undefined;
      const sign = req.query.sign as string | undefined;
      if (!timestamp || !sign || !verifyDingTalkSignature(timestamp, sign, config.secret)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Parse DingTalk message body
      const body = req.body as Record<string, unknown>;
      const msgtype = typeof body.msgtype === 'string' ? body.msgtype : 'text';

      let messageText = '';
      if (msgtype === 'text') {
        const textObj = body.text as Record<string, unknown> | undefined;
        messageText = typeof textObj?.content === 'string' ? textObj.content : '';
      } else if (msgtype === 'markdown') {
        const mdObj = body.markdown as Record<string, unknown> | undefined;
        messageText = typeof mdObj?.text === 'string' ? mdObj.text : '';
      }

      // Strip @bot prefix (DingTalk sends "@botName message")
      messageText = messageText.replace(/^\s*@\S+\s*/, '').trim();
      if (!messageText) {
        res.json({ msgtype: 'text', text: { content: 'Please send a message.' } });
        return;
      }

      const reply = await executeAgentMessage(config.agentId, messageText);

      res.json({ msgtype: 'text', text: { content: reply } });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  }
  router.post('/api/webhook/dingtalk', dingtalkHandler);
  router.post('/api/webhook/dingtalk/:id', dingtalkHandler);

  // ── POST /api/webhook/feishu/:id? — Feishu bot callback ───────────────
  async function feishuHandler(req: Request, res: Response): Promise<void> {
    try {
      const id = typeof req.params.id === 'string' ? req.params.id : undefined;
      const config = id ? findIMWebhook(id) : undefined;

      const body = req.body as Record<string, unknown>;
      const header = (body.header ?? {}) as Record<string, unknown>;
      const eventType =
        typeof header.event_type === 'string'
          ? header.event_type
          : typeof body.type === 'string'
            ? body.type
            : '';

      // Handle url_verification challenge — allowed without config because the
      // platform needs to confirm the callback URL during setup.
      if (eventType === 'url_verification' || body.challenge !== undefined) {
        const challenge = typeof body.challenge === 'string' ? body.challenge : '';
        res.json({ challenge });
        return;
      }

      // A valid webhook config is required for all other Feishu callbacks.
      if (!config) {
        res.status(401).json({ error: 'Webhook config required' });
        return;
      }

      // Token verification is mandatory when a config exists (constant-time).
      const token = typeof header.token === 'string' ? header.token : '';
      if (!token || !timingSafeEqualString(token, config.secret)) {
        res.status(401).json({ error: 'Invalid verification token' });
        return;
      }

      // Handle message.receive_v1 event
      if (eventType === 'im.message.receive_v1' || eventType === 'message.receive_v1') {
        const event = (body.event ?? {}) as Record<string, unknown>;
        const message = (event.message ?? {}) as Record<string, unknown>;
        const content = typeof message.content === 'string' ? message.content : '{}';

        let messageText = '';
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          messageText = typeof parsed.text === 'string' ? parsed.text : '';
        } catch {
          messageText = content;
        }

        // Strip @bot mention
        messageText = messageText.replace(/@_user_\d+/g, '').trim();
        if (!messageText) {
          res.json({ code: 0, msg: 'success' });
          return;
        }

        const reply = await executeAgentMessage(config.agentId, messageText);

        // Feishu expects a 200 with code 0 for acknowledgment.
        // The reply is posted back via the Feishu API (if configured).
        res.json({ code: 0, msg: 'success', reply });
      } else {
        // Unknown event — acknowledge
        res.json({ code: 0, msg: 'success' });
      }
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  }
  router.post('/api/webhook/feishu', feishuHandler);
  router.post('/api/webhook/feishu/:id', feishuHandler);

  // ── POST /api/webhook/wecom/:id? — WeCom app callback ─────────────────
  async function wecomHandler(req: Request, res: Response): Promise<void> {
    try {
      const id = typeof req.params.id === 'string' ? req.params.id : undefined;
      const config = id ? findIMWebhook(id) : undefined;

      const msgSignature = req.query.msg_signature as string | undefined;
      const timestamp = req.query.timestamp as string | undefined;
      const nonce = req.query.nonce as string | undefined;

      // WeCom sends XML in the body; express.json() may have already parsed it
      // if Content-Type was JSON, but for XML we need the raw body.
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

      // Extract encrypted content for signature verification
      const encrypt = extractXmlField(rawBody, 'Encrypt');

      // Extract text content from XML
      const msgType = extractXmlField(rawBody, 'MsgType');
      const content = extractXmlField(rawBody, 'Content');

      // Timestamp freshness: WeCom timestamps are seconds; reject if skewed > 5 min.
      const tsNum = timestamp !== undefined ? Number(timestamp) : NaN;
      if (!timestamp || !Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
        res.status(401).json({ error: 'Invalid or stale timestamp' });
        return;
      }

      // Handle echostr verification (GET-style, but sometimes POSTed).
      // Signature params must be complete; echostr participates in the signature
      // when Encrypt is absent (WeCom URL verification).
      const echostr = req.query.echostr as string | undefined;
      if (echostr) {
        if (!msgSignature || !nonce) {
          res.status(401).json({ error: 'Missing signature parameters' });
          return;
        }
        if (!config) {
          res.status(401).json({ error: 'Webhook config required' });
          return;
        }
        const signPayload = encrypt ?? echostr;
        if (!verifyWeComSignature(config.secret, timestamp, nonce, signPayload, msgSignature)) {
          res.status(401).json({ error: 'Invalid msg_signature' });
          return;
        }
        res.send(echostr);
        return;
      }

      // A valid webhook config is required for all other WeCom callbacks.
      if (!config) {
        res.status(401).json({ error: 'Webhook config required' });
        return;
      }

      // All four signature elements are mandatory — missing any → 401 (no skip).
      if (!msgSignature || !nonce || !encrypt) {
        res.status(401).json({ error: 'Missing signature parameters' });
        return;
      }
      if (!verifyWeComSignature(config.secret, timestamp, nonce, encrypt, msgSignature)) {
        res.status(401).json({ error: 'Invalid msg_signature' });
        return;
      }

      if (msgType === 'text' && content) {
        // Strip @bot mention
        const messageText = content.replace(/^\s*@\S+\s*/, '').trim();
        if (messageText) {
          const reply = await executeAgentMessage(config.agentId, messageText);

          // Return plain XML response (unencrypted for simplicity)
          res.type('application/xml');
          res.send(
            `<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${reply}]]></Content></xml>`,
          );
          return;
        }
      }

      // Default acknowledgment
      res.type('application/xml');
      res.send('<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[OK]]></Content></xml>');
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  }
  router.post('/api/webhook/wecom', wecomHandler);
  router.post('/api/webhook/wecom/:id', wecomHandler);
  // WeCom URL verification typically arrives as GET with echostr.
  router.get('/api/webhook/wecom', wecomHandler);
  router.get('/api/webhook/wecom/:id', wecomHandler);

  // ── GET /api/webhook/config — list IM webhooks ────────────────────────
  router.get('/api/webhook/config', (_req: Request, res: Response) => {
    try {
      const configs = readIMWebhooks();
      res.json({ webhooks: configs, total: configs.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── POST /api/webhook/config — create IM webhook config ───────────────
  router.post(
    '/api/webhook/config',
    validateBody(createWebhookSchema),
    (req: Request, res: Response) => {
      try {
        const { platform, name, agentId, enabled } = req.body as z.infer<
          typeof createWebhookSchema
        >;

        const configs = readIMWebhooks();
        const newConfig: IMWebhookConfig = {
          id: generateId(),
          platform,
          name,
          secret: (req.body as { secret?: string }).secret?.trim() || generateSecret(),
          agentId,
          enabled: enabled ?? true,
          createdAt: new Date().toISOString(),
        };

        configs.push(newConfig);
        writeIMWebhooks(configs);

        res.status(201).json({ webhook: newConfig });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── DELETE /api/webhook/config/:id — delete IM webhook config ─────────
  router.delete('/api/webhook/config/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const configs = readIMWebhooks();
      const index = configs.findIndex((w) => w.id === id);
      if (index === -1) {
        return res.status(404).json({ error: 'Webhook config not found' });
      }

      configs.splice(index, 1);
      writeIMWebhooks(configs);

      res.json({ status: 'deleted', id });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
