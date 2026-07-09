import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadSettings, updateSettings, type AppSettings } from './settingsStore';
import { toErrorMessage } from './routeHelpers';
import { hasRole, type UserRole } from './userStore';

/**
 * Global settings management endpoints.
 *
 * Provides read/update access to runtime configuration: default model,
 * feature flags (meta-tools, tool retrieval, entropy gating, speculative
 * execution) and notification preferences.
 */

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Returns middleware that requires the authenticated user to meet or exceed
 * `requiredRole` in the role hierarchy (defaults to 'admin', so both
 * 'super_admin' and 'admin' satisfy an unparameterised check). Must be
 * mounted after requireAuth.
 */
function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidEmail(value: string): boolean {
  // Simple, permissive RFC 5322 subset — enough for UI validation.
  return /^[^\s@]+@[^\s@\.]+\.[^\s@]+$/.test(value);
}

function validateSettings(body: unknown): { settings: AppSettings } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be an object' };
  }
  const input = body as Record<string, unknown>;
  const settings: AppSettings = {};

  if ('model' in input) {
    if (
      input.model !== undefined &&
      (typeof input.model !== 'string' || input.model.length > 256)
    ) {
      return { error: 'model must be a string of at most 256 characters' };
    }
    settings.model = input.model || undefined;
  }

  for (const key of ['enableMetaTools', 'toolRetrieval', 'entropyGating', 'speculativeExecution']) {
    if (key in input) {
      const value = input[key];
      if (value !== undefined && typeof value !== 'boolean') {
        return { error: `${key} must be a boolean` };
      }
      (settings as Record<string, boolean | undefined>)[key] = value || undefined;
    }
  }

  if ('notifications' in input) {
    const raw = input.notifications;
    if (raw !== undefined) {
      if (!raw || typeof raw !== 'object') {
        return { error: 'notifications must be an object' };
      }
      const n = raw as Record<string, unknown>;
      const notifications: AppSettings['notifications'] = {};

      if (n.emailEnabled !== undefined) {
        if (typeof n.emailEnabled !== 'boolean')
          return { error: 'notifications.emailEnabled must be a boolean' };
        notifications.emailEnabled = n.emailEnabled;
      }
      if (n.alertsEnabled !== undefined) {
        if (typeof n.alertsEnabled !== 'boolean')
          return { error: 'notifications.alertsEnabled must be a boolean' };
        notifications.alertsEnabled = n.alertsEnabled;
      }
      if (n.email !== undefined) {
        if (typeof n.email !== 'string') return { error: 'notifications.email must be a string' };
        if (n.email && !isValidEmail(n.email))
          return { error: 'notifications.email is not a valid email' };
        notifications.email = n.email || undefined;
      }
      if (n.webhookUrl !== undefined) {
        if (typeof n.webhookUrl !== 'string')
          return { error: 'notifications.webhookUrl must be a string' };
        if (n.webhookUrl && !isValidUrl(n.webhookUrl))
          return { error: 'notifications.webhookUrl is not a valid URL' };
        notifications.webhookUrl = n.webhookUrl || undefined;
      }
      if (n.slackWebhook !== undefined) {
        if (typeof n.slackWebhook !== 'string')
          return { error: 'notifications.slackWebhook must be a string' };
        if (n.slackWebhook && !isValidUrl(n.slackWebhook)) {
          return { error: 'notifications.slackWebhook is not a valid URL' };
        }
        notifications.slackWebhook = n.slackWebhook || undefined;
      }

      settings.notifications = notifications;
    }
  }

  return { settings };
}

export function createSettingsRouter(): Router {
  const router = Router();

  // GET /api/settings — read current global settings
  router.get('/api/settings', requireAuth, (_req: Request, res: Response) => {
    try {
      res.json({ settings: loadSettings() });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // PUT /api/settings — update global settings (admin only)
  router.put('/api/settings', requireAuth, requireRole(), (req: Request, res: Response) => {
    const validation = validateSettings(req.body);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }

    try {
      const settings = updateSettings(validation.settings);
      res.json({ settings });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
