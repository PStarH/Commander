import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getWebhookDispatcher, type WebhookConfig } from '@commander/core';
import { toErrorMessage } from './routeHelpers';

/**
 * Outgoing webhook management endpoints.
 *
 * Wraps the core WebhookDispatcher to expose CRUD for outbound HTTP
 * webhooks, plus delivery logs and stats. Created secrets are returned once
 * and then redacted from all list/get responses.
 */

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required' });
    return;
  }
  next();
}

function redact(webhook: WebhookConfig): Omit<WebhookConfig, 'secret'> {
  const { secret: _secret, ...rest } = webhook;
  return rest;
}

function parseLimit(value: unknown, fallback = 50, max = 1000): number {
  const parsed = parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function getStringParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function validateCreate(
  body: unknown,
): { config: Omit<WebhookConfig, 'id' | 'createdAt'> } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be an object' };
  }
  const input = body as Record<string, unknown>;

  if (typeof input.url !== 'string' || !input.url.trim()) {
    return { error: 'url is required' };
  }
  const url = input.url.trim();
  if (url.length > 2048) {
    return { error: 'url must be at most 2048 characters' };
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { error: 'url must use http or https' };
  }

  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { error: 'events must be a non-empty array' };
  }
  const events = input.events.filter((e): e is string => typeof e === 'string');
  if (events.length === 0) {
    return { error: 'events must contain strings' };
  }

  const config: Omit<WebhookConfig, 'id' | 'createdAt'> = {
    url,
    events,
    enabled: input.enabled !== false,
  };

  if (typeof input.name === 'string') config.name = input.name.trim().slice(0, 128);
  if (typeof input.description === 'string') {
    config.description = input.description.trim().slice(0, 512);
  }
  if (typeof input.secret === 'string') config.secret = input.secret;
  if (typeof input.retryMax === 'number') {
    config.retryMax = Math.max(0, Math.min(10, Math.floor(input.retryMax)));
  }
  if (input.headers && typeof input.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }

  return { config };
}

export function createOutgoingWebhookRouter(): Router {
  const router = Router();
  const dispatcher = getWebhookDispatcher();

  // GET /api/outgoing-webhooks — list configured outgoing webhooks
  router.get('/api/outgoing-webhooks', requireAuth, (_req: Request, res: Response) => {
    try {
      res.json({ webhooks: dispatcher.listWebhooks().map(redact) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // POST /api/outgoing-webhooks — create a new outgoing webhook
  router.post(
    '/api/outgoing-webhooks',
    requireAuth,
    requireAdmin,
    (req: Request, res: Response) => {
      const validation = validateCreate(req.body);
      if ('error' in validation) {
        res.status(400).json({ error: validation.error });
        return;
      }

      try {
        const webhook = dispatcher.registerWebhook(validation.config);
        res.status(201).json({ webhook: redact(webhook) });
      } catch (error) {
        res.status(400).json({ error: toErrorMessage(error) });
      }
    },
  );

  // GET /api/outgoing-webhooks/stats — dispatcher statistics
  router.get('/api/outgoing-webhooks/stats', requireAuth, (_req: Request, res: Response) => {
    try {
      res.json(dispatcher.getStats());
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/outgoing-webhooks/:id — get a single webhook
  router.get('/api/outgoing-webhooks/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      const webhook = id ? dispatcher.getWebhook(id) : undefined;
      if (!webhook) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      res.json({ webhook: redact(webhook) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // DELETE /api/outgoing-webhooks/:id — remove a webhook
  router.delete(
    '/api/outgoing-webhooks/:id',
    requireAuth,
    requireAdmin,
    (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);
        const removed = id ? dispatcher.deregisterWebhook(id) : false;
        if (!removed || !id) {
          res.status(404).json({ error: 'Webhook not found' });
          return;
        }
        res.json({ status: 'deleted', id });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // GET /api/outgoing-webhooks/:id/deliveries — delivery log for a webhook
  router.get(
    '/api/outgoing-webhooks/:id/deliveries',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);
        const webhook = id ? dispatcher.getWebhook(id) : undefined;
        if (!webhook) {
          res.status(404).json({ error: 'Webhook not found' });
          return;
        }
        const limit = parseLimit(req.query.limit, 50);
        const all = dispatcher.getDeliveryLog(1000);
        const deliveries = all.filter((d) => d.webhookId === id).slice(-limit);
        res.json({ deliveries, total: deliveries.length });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // GET /api/outgoing-webhooks/deliveries/recent — recent deliveries across all webhooks
  router.get(
    '/api/outgoing-webhooks/deliveries/recent',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const limit = parseLimit(req.query.limit, 50);
        res.json({ deliveries: dispatcher.getDeliveryLog(limit) });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  return router;
}
