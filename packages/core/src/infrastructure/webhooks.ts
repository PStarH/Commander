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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { getBackgroundTaskManager } from './background';

// ============================================================================
// At-rest encryption for webhook secrets
// ============================================================================
// Webhook signing secrets are sensitive — anyone who can read the webhooks
// JSON file can forge payloads. We encrypt the `secret` field at rest using
// AES-256-GCM with a key derived from COMMANDER_MASTER_KEY (same env var
// used by EncryptedSecretsVault). When no master key is set, we fall back
// to plaintext with a warning (development mode only).

const WEBHOOK_ENC_PREFIX = 'enc:v1:';

function getMasterKey(): Buffer | null {
  const envKey = process.env.COMMANDER_MASTER_KEY;
  if (!envKey || envKey.length < 32) return null;
  return crypto.createHash('sha256').update(envKey).digest();
}

function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  if (!key) {
    // No master key — store plaintext (development mode)
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return WEBHOOK_ENC_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith(WEBHOOK_ENC_PREFIX)) {
    // Plaintext (legacy or development mode)
    return stored;
  }
  const key = getMasterKey();
  if (!key) {
    // Encrypted but no master key available — can't decrypt
    getGlobalLogger().warn('WebhookManager', 'Encrypted webhook secret found but COMMANDER_MASTER_KEY not set');
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
    reportSilentFailure(err, 'webhooks:decryptSecret');
    return '';
  }
}

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
  /** Original raw request body string, used for accurate HMAC signature verification. */
  rawBody?: string;
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
          // Decrypt the secret field if it was encrypted at rest
          if (rule.secret) {
            rule.secret = decryptSecret(rule.secret);
          }
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
    // Encrypt the secret field before writing to disk
    const encryptedRules = Array.from(this.rules.values()).map((rule) => ({
      ...rule,
      secret: rule.secret ? encryptSecret(rule.secret) : undefined,
    }));
    fs.writeFileSync(indexFile, JSON.stringify(encryptedRules, null, 2));
  }

  /**
   * Add a webhook rule.
   * SECURITY: A signing secret is mandatory. Unsigned webhooks allow anyone who
   * discovers the endpoint to forge payloads and trigger arbitrary tasks.
   */
  add(rule: Omit<WebhookRule, 'id' | 'createdAt' | 'triggerCount'>): WebhookRule {
    if (!rule.secret || rule.secret.length < 16) {
      throw new Error(
        'Webhook rules must configure a signing secret of at least 16 characters.',
      );
    }

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

      // Verify signature. Rules without a secret are rejected at add() time;
      // this guard prevents legacy/loaded rules from being processed unsigned.
      if (!rule.secret) {
        getGlobalLogger().warn(
          'WebhookManager',
          `Skipping unsigned rule: ${rule.name}. Webhook rules must have a secret.`,
        );
        continue;
      }
      if (!this.verifySignature(event, rule.secret)) {
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

  private verifySignature(event: WebhookEvent, secret: string, rawBody?: string): boolean {
    // GitHub-style HMAC-SHA256 verification
    const signature = event.headers['x-hub-signature-256'] ?? event.headers['x-signature-256'];
    if (!signature) return false;

    try {
      const hmac = crypto.createHmac('sha256', secret);
      // Prefer the original raw request body for signature computation to avoid
      // mismatches caused by JSON re-serialization (key ordering, whitespace, etc.).
      const body = rawBody ?? event.rawBody ?? JSON.stringify(event.payload);
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
   * SECURITY: authToken is mandatory. Anonymous webhook servers allow anyone who
   * can reach the port to submit payloads and trigger background tasks.
   */
  async startServer(port: number = 9876, authToken?: string): Promise<void> {
    if (!authToken || authToken.length < 16) {
      throw new Error(
        'Webhook server requires an authToken of at least 16 characters.',
      );
    }

    const http = await import('http');

    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      // Authentication check (timing-safe comparison)
      if (authToken) {
        const providedAuth = req.headers['authorization'] ?? '';
        const expectedAuth = `Bearer ${authToken}`;
        const providedBuf = Buffer.from(providedAuth);
        const expectedBuf = Buffer.from(expectedAuth);
        // Length check before timingSafeEqual to avoid RangeError, then
        // timing-safe comparison to prevent timing attacks.
        if (
          providedBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(providedBuf, expectedBuf)
        ) {
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
            rawBody: body,
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
