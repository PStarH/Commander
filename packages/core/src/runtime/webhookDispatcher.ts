/**
 * Outbound Webhook Dispatcher
 *
 * Register webhook URLs for system events and get notified via HTTP POST.
 * Uses HMAC-SHA256 signing for payload authenticity.
 * Integrates with MessageBus for event-driven dispatch.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getMessageBus } from './messageBus';

// ── Types ──────────────────────────────────────────────────────────

export interface WebhookConfig {
  id: string;
  url: string;
  /** Event topic patterns to subscribe to (e.g. ['agent.started', 'agent.completed']). '*' for all. */
  events: string[];
  /** HMAC secret for signing payloads. Auto-generated if omitted. */
  secret?: string;
  /** Max retries on failure (default: 3) */
  retryMax?: number;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  /** Optional friendly name */
  name?: string;
  /** Optional description */
  description?: string;
}

export interface WebhookEvent {
  event: string;
  timestamp: string;
  source: string;
  payload: unknown;
}

export interface WebhookDelivery {
  webhookId: string;
  event: string;
  status: 'success' | 'failed' | 'retrying';
  statusCode?: number;
  attempts: number;
  error?: string;
  deliveredAt: string;
}

// ── Constants ──────────────────────────────────────────────────────

const WEBHOOKS_FILE = path.join(process.cwd(), '.commander', 'webhooks.json');
const DEFAULT_RETRY_MAX = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000]; // exponential backoff

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Block requests to private/internal IP ranges and cloud metadata endpoints.
// Per OWASP SSRF Prevention Cheat Sheet: validate scheme, reject private IPs.
const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC 1918
  /^192\.168\./, // RFC 1918
  /^169\.254\./, // Link-local / cloud metadata (AWS/GCP)
  /^0\./, // Current network
  /^::1$/, // IPv6 loopback
  /^fc00:/, // IPv6 ULA
  /^fe80:/, // IPv6 link-local
];

/**
 * Validate a webhook URL to prevent SSRF attacks.
 * Only allows http/https schemes and rejects private/internal IP ranges.
 * Security: Based on OWASP SSRF Prevention Cheat Sheet.
 */
function isSafeWebhookUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Only allow http and https schemes — block file:, javascript:, data:, etc.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    // Reject private/internal IP ranges and cloud metadata endpoints
    const hostname = parsed.hostname;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────

export class WebhookDispatcher {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private deliveryLog: WebhookDelivery[] = [];
  private maxDeliveryLog = 1000;

  constructor() {
    this.load();
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Start listening to MessageBus events. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const bus = getMessageBus();
    // Subscribe to ALL topics — filter at dispatch time
    const unsub = bus.subscribe('*', (msg) => {
      const topic = typeof msg.topic === 'string' ? msg.topic : String(msg.topic);
      this.dispatch(topic, msg.payload ?? {}, msg.source ?? 'system');
    });
    this.unsubscribers.push(unsub);
    getGlobalLogger().info('WebhookDispatcher', 'Started', { webhookCount: this.webhooks.size });
  }

  /** Stop listening and clean up. */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch (e) {
        getGlobalLogger().debug('WebhookDispatcher', 'Failed to unsubscribe', {
          error: (e as Error)?.message,
        });
      }
    }
    this.unsubscribers = [];
    this.started = false;
    getGlobalLogger().info('WebhookDispatcher', 'Stopped');
  }

  // ── Webhook CRUD ─────────────────────────────────────────────────

  registerWebhook(config: Omit<WebhookConfig, 'id' | 'createdAt'>): WebhookConfig {
    // Security: SSRF prevention — reject private/internal URLs at registration time.
    // Per OWASP SSRF Prevention Cheat Sheet: validate before storing.
    if (!isSafeWebhookUrl(config.url)) {
      throw new Error(
        'Webhook URL must use http/https and must not point to private/internal IP ranges',
      );
    }
    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const webhook: WebhookConfig = {
      ...config,
      id,
      secret: config.secret || crypto.randomBytes(32).toString('hex'),
      retryMax: config.retryMax ?? DEFAULT_RETRY_MAX,
      enabled: config.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    this.webhooks.set(id, webhook);
    this.save();
    getGlobalLogger().info('WebhookDispatcher', 'Registered webhook', {
      id,
      url: config.url,
      events: config.events,
    });
    return webhook;
  }

  deregisterWebhook(id: string): boolean {
    const existed = this.webhooks.delete(id);
    if (existed) {
      this.save();
      getGlobalLogger().info('WebhookDispatcher', 'Deregistered webhook', { id });
    }
    return existed;
  }

  getWebhook(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  listWebhooks(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  // ── Dispatch ─────────────────────────────────────────────────────

  /** Dispatch an event to all matching webhooks. Non-blocking — fires and forgets. */
  dispatch(event: string, payload: unknown, source: string = 'system'): void {
    if (!this.started) return;
    const matching = Array.from(this.webhooks.values()).filter(
      (wh) => wh.enabled && (wh.events.includes('*') || wh.events.includes(event)),
    );

    if (matching.length === 0) return;

    const webhookEvent: WebhookEvent = {
      event,
      timestamp: new Date().toISOString(),
      source,
      payload,
    };

    for (const wh of matching) {
      this.sendWithRetry(wh, webhookEvent, 0);
    }
  }

  // ── Admin ────────────────────────────────────────────────────────

  getDeliveryLog(limit: number = 50): WebhookDelivery[] {
    return this.deliveryLog.slice(-limit);
  }

  getStats(): { total: number; enabled: number; deliveries: number } {
    let enabled = 0;
    for (const w of this.webhooks.values()) {
      if (w.enabled) enabled++;
    }
    return {
      total: this.webhooks.size,
      enabled,
      deliveries: this.deliveryLog.length,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private sendWithRetry(wh: WebhookConfig, event: WebhookEvent, attempt: number): void {
    // Security: SSRF prevention — re-validate URL at send time to catch any
    // stored webhook configs that predate the registration-time check.
    if (!isSafeWebhookUrl(wh.url)) {
      getGlobalLogger().warn('WebhookDispatcher', 'Blocked unsafe webhook URL', {
        id: wh.id,
        url: wh.url,
      });
      this.logDelivery(wh.id, event.event, 'failed', 0, attempt + 1);
      return;
    }
    const body = JSON.stringify(event);
    const signature = crypto.createHmac('sha256', wh.secret!).update(body).digest('hex');

    const url = new URL(wh.url);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
      'X-Webhook-Event': event.event,
      'User-Agent': 'Commander-Webhook/1.0',
      ...(wh.headers ?? {}),
    };

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        const success = statusCode >= 200 && statusCode < 300;
        this.logDelivery(
          wh.id,
          event.event,
          success ? 'success' : 'failed',
          statusCode,
          attempt + 1,
        );

        if (!success && attempt < (wh.retryMax ?? DEFAULT_RETRY_MAX)) {
          const delay = RETRY_DELAYS_MS[attempt] ?? 15000;
          getGlobalLogger().warn('WebhookDispatcher', 'Retrying webhook', {
            id: wh.id,
            statusCode,
            attempt: attempt + 1,
            nextDelay: delay,
          });
          const retryTimer = setTimeout(() => this.sendWithRetry(wh, event, attempt + 1), delay);
          if (typeof retryTimer.unref === 'function') retryTimer.unref();
        }
      });
    });

    // Prevent double-retry when timeout fires then req.destroy() triggers error event
    let timedOut = false;

    req.on('error', (err: Error) => {
      if (timedOut) return; // already handled by timeout handler
      this.logDelivery(wh.id, event.event, 'failed', undefined, attempt + 1, err.message);
      if (attempt < (wh.retryMax ?? DEFAULT_RETRY_MAX)) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 15000;
        getGlobalLogger().warn('WebhookDispatcher', 'Retrying webhook after error', {
          id: wh.id,
          error: err.message,
          attempt: attempt + 1,
          nextDelay: delay,
        });
        const retryTimer = setTimeout(() => this.sendWithRetry(wh, event, attempt + 1), delay);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
      } else {
        getGlobalLogger().error('WebhookDispatcher', 'Webhook max retries exceeded', err, {
          id: wh.id,
          url: wh.url,
          event: event.event,
          attempts: attempt + 1,
        });
      }
    });

    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      this.logDelivery(wh.id, event.event, 'failed', undefined, attempt + 1, 'timeout');
      if (attempt < (wh.retryMax ?? DEFAULT_RETRY_MAX)) {
        const retryTimer = setTimeout(
          () => this.sendWithRetry(wh, event, attempt + 1),
          RETRY_DELAYS_MS[attempt] ?? 15000,
        );
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
      }
    });

    req.write(body);
    req.end();
  }

  private logDelivery(
    webhookId: string,
    event: string,
    status: WebhookDelivery['status'],
    statusCode?: number,
    attempts: number = 1,
    error?: string,
  ): void {
    this.deliveryLog.push({
      webhookId,
      event,
      status,
      statusCode,
      attempts,
      error,
      deliveredAt: new Date().toISOString(),
    });
    if (this.deliveryLog.length > this.maxDeliveryLog) {
      this.deliveryLog.splice(0, this.deliveryLog.length - this.maxDeliveryLog);
    }
  }

  // ── Test fixture management ──────────────────────────────────────

  filterTestFixtures(): number {
    const fixturePatterns = [/^test-/, /^fixture-/, /localhost.*test/, /127\.0\.0\.1.*test/];
    let removed = 0;
    for (const [id, wh] of this.webhooks) {
      if (fixturePatterns.some((p) => p.test(id) || p.test(wh.url))) {
        this.webhooks.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  // ── Persistence ──────────────────────────────────────────────────

  private save(): void {
    try {
      const dir = path.dirname(WEBHOOKS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${WEBHOOKS_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.webhooks.values()), null, 2));
      fs.renameSync(tmpPath, WEBHOOKS_FILE);
    } catch (err) {
      getGlobalLogger().error('WebhookDispatcher', 'Failed to save webhooks', err as Error);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(WEBHOOKS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const wh of data) {
          this.webhooks.set(wh.id, wh);
        }
      }
    } catch (err) {
      getGlobalLogger().error('WebhookDispatcher', 'Failed to load webhooks', err as Error);
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const dispatcherSingleton = createTenantAwareSingleton(() => new WebhookDispatcher(), {
  allowGlobalFallback: true,
  dispose: (d) => d.stop(),
});

export function getWebhookDispatcher(): WebhookDispatcher {
  return dispatcherSingleton.get();
}

export function resetWebhookDispatcher(): void {
  dispatcherSingleton.reset();
  // Wipe persisted webhooks so the next constructed instance starts clean.
  // This prevents stale test fixtures from leaking between runs.
  try {
    if (fs.existsSync(WEBHOOKS_FILE)) {
      fs.unlinkSync(WEBHOOKS_FILE);
    }
  } catch {
    // Ignore permission/race errors — the next load() will simply see no file.
  }
}
