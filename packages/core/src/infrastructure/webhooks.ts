/**
 * Webhook Infrastructure
 *
 * Listens for incoming webhooks from external services (GitHub, GitLab, etc.)
 * and triggers Commander tasks automatically.
 *
 * Usage:
 *   commander webhook add github --events push,pr --task "run tests"
 *   commander webhook list
 *   commander webhook remove <id>
 *   commander webhook start --port 9876
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import { getBackgroundTaskManager } from './background';

// ============================================================================
// Types
// ============================================================================

export interface WebhookRule {
  id: string;
  name: string;
  source: 'github' | 'gitlab' | 'bitbucket' | 'custom';
  events: string[]; // ['push', 'pr.opened', 'pr.merged']
  task: string; // Task to run when triggered
  enabled: boolean;
  secret?: string; // Webhook secret for verification
  filters?: Record<string, unknown>; // Event payload filters
  createdAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}

export interface WebhookEvent {
  source: string;
  event: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  timestamp: string;
}

// ============================================================================
// Webhook Manager
// ============================================================================

export class WebhookManager {
  private rules: Map<string, WebhookRule> = new Map();
  private rulesDir: string;
  private server: ReturnType<typeof import('http').createServer> | null = null;

  constructor(baseDir?: string) {
    this.rulesDir = baseDir ?? path.join(process.cwd(), '.commander', 'webhooks');
    this.ensureDir();
    this.loadRules();
  }

  private ensureDir(): void {
    fs.mkdirSync(this.rulesDir, { recursive: true });
  }

  private loadRules(): void {
    try {
      const indexFile = path.join(this.rulesDir, 'index.json');
      if (fs.existsSync(indexFile)) {
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        for (const rule of data) {
          this.rules.set(rule.id, rule);
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'webhooks:74');
      /* ignore */
    }
  }

  private saveRules(): void {
    const indexFile = path.join(this.rulesDir, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify(Array.from(this.rules.values()), null, 2));
  }

  /**
   * Add a webhook rule.
   */
  add(rule: Omit<WebhookRule, 'id' | 'createdAt' | 'triggerCount'>): WebhookRule {
    const id = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRule: WebhookRule = {
      ...rule,
      id,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    this.rules.set(id, newRule);
    this.saveRules();
    return newRule;
  }

  /**
   * Remove a webhook rule.
   */
  remove(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) this.saveRules();
    return deleted;
  }

  /**
   * List all webhook rules.
   */
  list(): WebhookRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Process an incoming webhook event.
   */
  async processEvent(event: WebhookEvent): Promise<string[]> {
    const triggered: string[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.source !== event.source && rule.source !== 'custom') continue;
      if (!rule.events.includes(event.event) && !rule.events.includes('*')) continue;

      // Check filters
      if (rule.filters && !this.matchesFilters(event.payload, rule.filters)) continue;

      // Verify signature if secret is set
      if (rule.secret && !this.verifySignature(event, rule.secret)) {
        getGlobalLogger().warn(
          'WebhookManager',
          `Signature verification failed for rule: ${rule.name}`,
        );
        continue;
      }

      // Trigger the task
      getGlobalLogger().info('WebhookManager', `Triggering task for webhook: ${rule.name}`, {
        source: event.source,
        event: event.event,
      });

      try {
        const bgManager = getBackgroundTaskManager();
        await bgManager.launch({
          task: rule.task,
          metadata: {
            webhookRuleId: rule.id,
            webhookSource: event.source,
            webhookEvent: event.event,
            webhookPayload: event.payload,
          },
        });

        rule.triggerCount++;
        rule.lastTriggeredAt = new Date().toISOString();
        triggered.push(rule.id);
      } catch (err) {
        getGlobalLogger().error(
          'WebhookManager',
          `Failed to trigger task for webhook: ${rule.name}`,
          err as Error,
        );
      }
    }

    this.saveRules();
    return triggered;
  }

  private matchesFilters(
    payload: Record<string, unknown>,
    filters: Record<string, unknown>,
  ): boolean {
    for (const [key, expected] of Object.entries(filters)) {
      const actual = payload[key];
      if (actual !== expected) return false;
    }
    return true;
  }

  private verifySignature(event: WebhookEvent, secret: string): boolean {
    // GitHub-style HMAC-SHA256 verification
    const signature = event.headers['x-hub-signature-256'] ?? event.headers['x-signature-256'];
    if (!signature) return false;

    try {
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', secret);
      const body = JSON.stringify(event.payload);
      const expected = `sha256=${hmac.update(body).digest('hex')}`;
      // Length check before timingSafeEqual to avoid RangeError
      if (signature.length !== expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch (err) {
      reportSilentFailure(err, 'webhooks:199');
      return false;
    }
  }

  /**
   * Start a webhook listener server.
   */
  async startServer(port: number = 9876, authToken?: string): Promise<void> {
    const http = await import('http');

    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      // Authentication check
      if (authToken) {
        const providedAuth = req.headers['authorization'] ?? '';
        if (providedAuth !== `Bearer ${authToken}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Collect body with size limit (1MB)
      let body = '';
      let sizeExceeded = false;
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1_000_000) {
          sizeExceeded = true;
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (sizeExceeded) return;
        try {
          const payload = JSON.parse(body);
          const source = this.detectSource(req.headers);
          const event = this.detectEvent(req.headers, source);

          const webhookEvent: WebhookEvent = {
            source,
            event,
            payload,
            headers: req.headers as Record<string, string>,
            timestamp: new Date().toISOString(),
          };

          const triggered = await this.processEvent(webhookEvent);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ triggered: triggered.length }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    this.server.listen(port, () => {
      getGlobalLogger().info('WebhookManager', `Webhook server listening on port ${port}`);
    });
  }

  /**
   * Stop the webhook server.
   */
  stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private detectSource(headers: Record<string, string | string[] | undefined>): string {
    if (headers['x-github-event']) return 'github';
    if (headers['x-gitlab-event']) return 'gitlab';
    if (headers['x-event-key']) return 'bitbucket';
    return 'custom';
  }

  private detectEvent(
    headers: Record<string, string | string[] | undefined>,
    source: string,
  ): string {
    switch (source) {
      case 'github':
        return String(headers['x-github-event'] ?? 'unknown');
      case 'gitlab':
        return String(headers['x-gitlab-event'] ?? 'unknown');
      case 'bitbucket':
        return String(headers['x-event-key'] ?? 'unknown');
      default:
        return 'unknown';
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultManager: WebhookManager | null = null;

export function getWebhookManager(): WebhookManager {
  if (!defaultManager) {
    defaultManager = new WebhookManager();
  }
  return defaultManager;
}
