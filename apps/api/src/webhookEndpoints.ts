/**
 * webhookEndpoints — IM webhook integration router.
 *
 * This router is provider-driven: each supported IM platform is implemented as
 * an `IMProvider` plugin. The host only handles routing, config management,
 * authentication/authorization, secret encryption, conversation context, and
 * delegating platform specifics to the registered provider.
 *
 * Endpoints:
 *   POST /api/webhook/:platform/:id?  — Generic IM platform callback
 *   GET  /api/webhook/config          — list configured IM webhooks
 *   POST /api/webhook/config          — create a new IM webhook config
 *   DELETE /api/webhook/config/:id    — delete an IM webhook config
 *
 * Config persistence: `.commander/webhooks.json` (IM configs carry a `platform`
 * field so they coexist with any pre-existing outgoing-webhook entries).
 */
import {
  reportSilentFailure,
  UniversalSanitizer,
  getIMProviderRegistry,
  getIMContextStore,
  getIMOutboundDispatcher,
  resetIMOutboundDispatcher,
  type IMProvider,
  type IMIncomingRequest,
  type IMReply,
} from '@commander/core';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getSharedRuntime } from './sharedRuntime';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import { hasRole, type UserRole } from './userStore';

const sanitizer = new UniversalSanitizer();

// ── Types ─────────────────────────────────────────────────────────────────

export interface IMWebhookConfig {
  id: string;
  /** Provider ID, must match a registered IMProvider. */
  platform: string;
  name: string;
  /** Shared secret used for signature verification. */
  secret: string;
  /** Target agent that will process incoming messages. */
  agentId: string;
  enabled: boolean;
  createdAt: string;
  /** Optional credentials for proactive outbound messages. */
  outbound?: Record<string, unknown>;
}

// ── Persistence ───────────────────────────────────────────────────────────

function getWebhookFile(): string {
  return process.env.COMMANDER_WEBHOOKS_FILE
    ? path.resolve(process.env.COMMANDER_WEBHOOKS_FILE)
    : path.join(process.cwd(), '.commander', 'webhooks.json');
}

function readAllWebhooks(): unknown[] {
  const file = getWebhookFile();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    reportSilentFailure(err, 'webhookEndpoints:readAllWebhooks');
    return [];
  }
}

function writeAllWebhooks(entries: unknown[]): void {
  const file = getWebhookFile();
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
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
      const cfg = entry as IMWebhookConfig;
      if (cfg.secret) {
        cfg.secret = decryptSecret(cfg.secret);
      }
      result.push(cfg);
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
  const encrypted = imConfigs.map((cfg) => ({
    ...cfg,
    secret: cfg.secret ? encryptSecret(cfg.secret) : cfg.secret,
  }));
  writeAllWebhooks([...nonIM, ...encrypted]);
}

function findIMWebhook(id: string): IMWebhookConfig | undefined {
  return readIMWebhooks().find((w) => w.id === id);
}

function findActiveIMWebhook(id: string): IMWebhookConfig | undefined {
  return readIMWebhooks().find((w) => w.id === id && w.enabled);
}

function generateId(): string {
  return `imwh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ── Authentication / authorization for management endpoints ───────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

// ── At-rest encryption for IM webhook secrets ─────────────────────────────
// Reuses the same AES-256-GCM scheme as WebhookManager so secrets are not
// stored in plaintext. When no COMMANDER_MASTER_KEY is set, falls back to
// plaintext with a warning (development mode only).

const WEBHOOK_ENC_PREFIX = 'enc:v1:';

function getMasterKey(): Buffer | null {
  const envKey = process.env.COMMANDER_MASTER_KEY;
  if (!envKey || envKey.length < 32) return null;
  return crypto.createHash('sha256').update(envKey).digest();
}

function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    WEBHOOK_ENC_PREFIX +
    iv.toString('hex') +
    ':' +
    tag.toString('hex') +
    ':' +
    encrypted.toString('hex')
  );
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith(WEBHOOK_ENC_PREFIX)) return stored;
  const key = getMasterKey();
  if (!key) {
    reportSilentFailure(
      new Error('Encrypted IM webhook secret found but COMMANDER_MASTER_KEY not set'),
      'webhookEndpoints:decryptSecret',
    );
    return '';
  }
  try {
    const parts = stored.slice(WEBHOOK_ENC_PREFIX.length).split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (err) {
    reportSilentFailure(err, 'webhookEndpoints:decryptSecret');
    return '';
  }
}

// ── Agent execution helper ────────────────────────────────────────────────

async function executeAgentMessage(
  configId: string,
  agentId: string,
  message: string,
  platform: string,
  conversationId: string,
  senderId: string,
): Promise<string> {
  const runtime = getSharedRuntime();
  const store = getIMContextStore();
  const dispatcher = getIMOutboundDispatcher();

  await store.appendUserMessage(platform, conversationId, senderId, message);
  const ctx = await store.getContext(platform, conversationId, senderId);

  const runId = `im-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.setPendingRunId(platform, conversationId, senderId, runId);

  runtime
    .execute({
      agentId,
      projectId: 'project-war-room',
      goal: message,
      contextData: {
        agentState: {
          imContext: ctx?.messages ?? [],
        },
      },
      availableTools: [],
      tokenBudget: 50000,
      maxSteps: 20,
    })
    .then(async (result) => {
      const raw =
        result.summary ||
        (result.status === 'success' ? 'Task completed.' : `Task ${result.status}.`);
      const replyText = sanitizer.sanitize(raw, 'output').sanitized;
      await store.appendAssistantMessage(platform, conversationId, senderId, replyText);
      await store.clearPendingRunId(platform, conversationId, senderId);
      await dispatcher.send(configId, { text: replyText, conversationId });
    })
    .catch(async (err: unknown) => {
      reportSilentFailure(err, 'webhookEndpoints:executeAgentMessage');
      await store.clearPendingRunId(platform, conversationId, senderId);
    });

  // Return an immediate acknowledgment; the final reply is pushed proactively.
  return 'Received, processing...';
}

// ── Command router ────────────────────────────────────────────────────────

async function handleCommand(
  text: string,
  platform: string,
  conversationId: string,
  senderId: string,
): Promise<{ handled: boolean; ack?: string }> {
  const store = getIMContextStore();
  if (text === '/reset') {
    await store.resetContext(platform, conversationId, senderId);
    return { handled: true, ack: '上下文已重置' };
  }
  if (text === '/status') {
    const ctx = await store.getContext(platform, conversationId, senderId);
    return { handled: true, ack: ctx?.pendingRunId ? '任务进行中...' : '就绪' };
  }
  return { handled: false };
}

// ── Request adapter ───────────────────────────────────────────────────────

function adaptExpressRequest(req: Request): IMIncomingRequest {
  const query: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.query)) {
    query[key] = value as string | string[] | undefined;
  }

  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = value;
  }

  return {
    method: req.method,
    query,
    body: req.body,
    headers,
  };
}

// ── Validation schemas ────────────────────────────────────────────────────

const createWebhookSchema = z.object({
  platform: z.string().min(1),
  name: z.string().min(1).max(128),
  secret: z.string().max(256).optional(),
  agentId: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  outbound: z.record(z.unknown()).optional(),
});

// ── Router ────────────────────────────────────────────────────────────────

export function createWebhookRouter(): Router {
  const router = Router();

  // Initialize the outbound dispatcher with access to the webhook config store.
  resetIMOutboundDispatcher({ findById: findIMWebhook });

  // ── POST /api/webhook/:platform/:id? — Generic IM platform callback ─────
  async function imCallbackHandler(req: Request, res: Response): Promise<void> {
    try {
      const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
      const id = typeof req.params.id === 'string' ? req.params.id : undefined;
      const provider = platform ? getIMProviderRegistry().resolve(platform) : undefined;

      if (!provider) {
        res.status(404).json({ error: 'IM provider not found' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const incomingReq = adaptExpressRequest(req);

      // Feishu url_verification challenge — allowed without config because the
      // platform needs to confirm the callback URL during setup.
      const challenge = typeof body.challenge === 'string' ? body.challenge : undefined;
      if (challenge !== undefined) {
        res.json({ challenge });
        return;
      }

      // WeCom echostr verification — also allowed without config.
      const echostr = req.query.echostr as string | undefined;
      if (echostr) {
        res.send(echostr);
        return;
      }

      const config = id ? findActiveIMWebhook(id) : undefined;
      if (!config) {
        res.status(401).json({ error: 'Webhook config required' });
        return;
      }

      const verified = await provider.verify(incomingReq, config.secret);
      if (!verified) {
        res.status(401).json({ error: 'Invalid signature/token' });
        return;
      }

      const incoming = await provider.parseMessage(incomingReq);
      const messageText = sanitizer.sanitize(
        provider.stripMention(incoming.text),
        'input',
      ).sanitized;
      if (!messageText) {
        const emptyReply = provider.formatReply({ text: 'Please send a message.' });
        res.status(emptyReply.status ?? 200);
        if (emptyReply.headers) {
          for (const [key, value] of Object.entries(emptyReply.headers)) {
            res.set(key, value);
          }
        }
        res.send(emptyReply.body);
        return;
      }

      const command = await handleCommand(
        messageText,
        platform,
        incoming.conversationId,
        incoming.senderId,
      );
      if (command.handled && command.ack) {
        const reply = provider.formatReply({ text: command.ack });
        res.status(reply.status ?? 200);
        if (reply.headers) {
          for (const [key, value] of Object.entries(reply.headers)) {
            res.set(key, value);
          }
        }
        res.send(reply.body);
        return;
      }

      const replyText = await executeAgentMessage(
        config.id,
        config.agentId,
        messageText,
        platform,
        incoming.conversationId,
        incoming.senderId,
      );
      const reply = provider.formatReply({ text: replyText });

      res.status(reply.status ?? 200);
      if (reply.headers) {
        for (const [key, value] of Object.entries(reply.headers)) {
          res.set(key, value);
        }
      }
      res.send(reply.body);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  }

  // ── GET /api/webhook/config — list IM webhooks ────────────────────────
  router.get('/api/webhook/config', requireAuth, (_req: Request, res: Response) => {
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
    requireAuth,
    requireRole(),
    validateBody(createWebhookSchema),
    (req: Request, res: Response) => {
      try {
        const { platform, name, agentId, enabled, outbound } = req.body as z.infer<
          typeof createWebhookSchema
        >;

        const configs = readIMWebhooks();
        const newConfig: IMWebhookConfig = {
          id: generateId(),
          platform,
          name: sanitizer.sanitize(name, 'description').sanitized,
          secret: (req.body as { secret?: string }).secret?.trim() || generateSecret(),
          agentId,
          enabled: enabled ?? true,
          outbound,
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
  router.delete('/api/webhook/config/:id', requireAuth, requireRole(), (req: Request, res: Response) => {
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

  // ── POST /api/webhook/:platform/:id? — Generic IM platform callback ─────
  // Registered after config routes so that /api/webhook/config is not shadowed
  // by the `:platform` parameter.
  router.post('/api/webhook/:platform', imCallbackHandler);
  router.post('/api/webhook/:platform/:id', imCallbackHandler);

  return router;
}
