"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookDispatcher = void 0;
exports.getWebhookDispatcher = getWebhookDispatcher;
exports.resetWebhookDispatcher = resetWebhookDispatcher;
/**
 * Outbound Webhook Dispatcher
 *
 * Register webhook URLs for system events and get notified via HTTP POST.
 * Uses HMAC-SHA256 signing for payload authenticity.
 * Integrates with MessageBus for event-driven dispatch.
 */
const crypto = __importStar(require("crypto"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const messageBus_1 = require("./messageBus");
// ── Constants ──────────────────────────────────────────────────────
const WEBHOOKS_FILE = path.join(process.cwd(), '.commander', 'webhooks.json');
const DEFAULT_RETRY_MAX = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000]; // exponential backoff
// ── Dispatcher ─────────────────────────────────────────────────────
class WebhookDispatcher {
    constructor() {
        this.webhooks = new Map();
        this.unsubscribers = [];
        this.started = false;
        this.deliveryLog = [];
        this.maxDeliveryLog = 1000;
        this.load();
    }
    // ── Lifecycle ────────────────────────────────────────────────────
    /** Start listening to MessageBus events. */
    start() {
        if (this.started)
            return;
        this.started = true;
        const bus = (0, messageBus_1.getMessageBus)();
        // Subscribe to ALL topics — filter at dispatch time
        const unsub = bus.subscribe('*', (msg) => {
            var _a, _b;
            const topic = typeof msg.topic === 'string' ? msg.topic : String(msg.topic);
            this.dispatch(topic, (_a = msg.payload) !== null && _a !== void 0 ? _a : {}, (_b = msg.source) !== null && _b !== void 0 ? _b : 'system');
        });
        this.unsubscribers.push(unsub);
        (0, logging_1.getGlobalLogger)().info('WebhookDispatcher', 'Started', { webhookCount: this.webhooks.size });
    }
    /** Stop listening and clean up. */
    stop() {
        for (const unsub of this.unsubscribers) {
            try {
                unsub();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('WebhookDispatcher', 'Failed to unsubscribe', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        this.unsubscribers = [];
        this.started = false;
        (0, logging_1.getGlobalLogger)().info('WebhookDispatcher', 'Stopped');
    }
    // ── Webhook CRUD ─────────────────────────────────────────────────
    registerWebhook(config) {
        var _a;
        const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const webhook = {
            ...config,
            id,
            secret: config.secret || crypto.randomBytes(32).toString('hex'),
            retryMax: (_a = config.retryMax) !== null && _a !== void 0 ? _a : DEFAULT_RETRY_MAX,
            enabled: config.enabled !== false,
            createdAt: new Date().toISOString(),
        };
        this.webhooks.set(id, webhook);
        this.save();
        (0, logging_1.getGlobalLogger)().info('WebhookDispatcher', 'Registered webhook', {
            id,
            url: config.url,
            events: config.events,
        });
        return webhook;
    }
    deregisterWebhook(id) {
        const existed = this.webhooks.delete(id);
        if (existed) {
            this.save();
            (0, logging_1.getGlobalLogger)().info('WebhookDispatcher', 'Deregistered webhook', { id });
        }
        return existed;
    }
    getWebhook(id) {
        return this.webhooks.get(id);
    }
    listWebhooks() {
        return Array.from(this.webhooks.values());
    }
    // ── Dispatch ─────────────────────────────────────────────────────
    /** Dispatch an event to all matching webhooks. Non-blocking — fires and forgets. */
    dispatch(event, payload, source = 'system') {
        if (!this.started)
            return;
        const matching = Array.from(this.webhooks.values()).filter((wh) => wh.enabled && (wh.events.includes('*') || wh.events.includes(event)));
        if (matching.length === 0)
            return;
        const webhookEvent = {
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
    getDeliveryLog(limit = 50) {
        return this.deliveryLog.slice(-limit);
    }
    getStats() {
        let enabled = 0;
        for (const w of this.webhooks.values()) {
            if (w.enabled)
                enabled++;
        }
        return {
            total: this.webhooks.size,
            enabled,
            deliveries: this.deliveryLog.length,
        };
    }
    // ── Internal ─────────────────────────────────────────────────────
    sendWithRetry(wh, event, attempt) {
        var _a;
        const body = JSON.stringify(event);
        const signature = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
        const url = new URL(wh.url);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;
        const headers = {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Event': event.event,
            'User-Agent': 'Commander-Webhook/1.0',
            ...((_a = wh.headers) !== null && _a !== void 0 ? _a : {}),
        };
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers,
            timeout: 10000,
        };
        const req = client.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => {
                responseBody += chunk.toString();
            });
            res.on('end', () => {
                var _a, _b, _c;
                const statusCode = (_a = res.statusCode) !== null && _a !== void 0 ? _a : 0;
                const success = statusCode >= 200 && statusCode < 300;
                this.logDelivery(wh.id, event.event, success ? 'success' : 'failed', statusCode, attempt + 1);
                if (!success && attempt < ((_b = wh.retryMax) !== null && _b !== void 0 ? _b : DEFAULT_RETRY_MAX)) {
                    const delay = (_c = RETRY_DELAYS_MS[attempt]) !== null && _c !== void 0 ? _c : 15000;
                    (0, logging_1.getGlobalLogger)().warn('WebhookDispatcher', 'Retrying webhook', {
                        id: wh.id,
                        statusCode,
                        attempt: attempt + 1,
                        nextDelay: delay,
                    });
                    const retryTimer = setTimeout(() => this.sendWithRetry(wh, event, attempt + 1), delay);
                    if (typeof retryTimer.unref === 'function')
                        retryTimer.unref();
                }
            });
        });
        // Prevent double-retry when timeout fires then req.destroy() triggers error event
        let timedOut = false;
        req.on('error', (err) => {
            var _a, _b;
            if (timedOut)
                return; // already handled by timeout handler
            this.logDelivery(wh.id, event.event, 'failed', undefined, attempt + 1, err.message);
            if (attempt < ((_a = wh.retryMax) !== null && _a !== void 0 ? _a : DEFAULT_RETRY_MAX)) {
                const delay = (_b = RETRY_DELAYS_MS[attempt]) !== null && _b !== void 0 ? _b : 15000;
                (0, logging_1.getGlobalLogger)().warn('WebhookDispatcher', 'Retrying webhook after error', {
                    id: wh.id,
                    error: err.message,
                    attempt: attempt + 1,
                    nextDelay: delay,
                });
                const retryTimer = setTimeout(() => this.sendWithRetry(wh, event, attempt + 1), delay);
                if (typeof retryTimer.unref === 'function')
                    retryTimer.unref();
            }
            else {
                (0, logging_1.getGlobalLogger)().error('WebhookDispatcher', 'Webhook max retries exceeded', err, {
                    id: wh.id,
                    url: wh.url,
                    event: event.event,
                    attempts: attempt + 1,
                });
            }
        });
        req.on('timeout', () => {
            var _a, _b;
            timedOut = true;
            req.destroy();
            this.logDelivery(wh.id, event.event, 'failed', undefined, attempt + 1, 'timeout');
            if (attempt < ((_a = wh.retryMax) !== null && _a !== void 0 ? _a : DEFAULT_RETRY_MAX)) {
                const retryTimer = setTimeout(() => this.sendWithRetry(wh, event, attempt + 1), (_b = RETRY_DELAYS_MS[attempt]) !== null && _b !== void 0 ? _b : 15000);
                if (typeof retryTimer.unref === 'function')
                    retryTimer.unref();
            }
        });
        req.write(body);
        req.end();
    }
    logDelivery(webhookId, event, status, statusCode, attempts = 1, error) {
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
    // ── Persistence ──────────────────────────────────────────────────
    save() {
        try {
            const dir = path.dirname(WEBHOOKS_FILE);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmpPath = `${WEBHOOKS_FILE}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.webhooks.values()), null, 2));
            fs.renameSync(tmpPath, WEBHOOKS_FILE);
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('WebhookDispatcher', 'Failed to save webhooks', err);
        }
    }
    load() {
        try {
            if (!fs.existsSync(WEBHOOKS_FILE))
                return;
            const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
            if (Array.isArray(data)) {
                for (const wh of data) {
                    this.webhooks.set(wh.id, wh);
                }
            }
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('WebhookDispatcher', 'Failed to load webhooks', err);
        }
    }
}
exports.WebhookDispatcher = WebhookDispatcher;
// ── Singleton ──────────────────────────────────────────────────────
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const dispatcherSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new WebhookDispatcher(), {
    dispose: (d) => d.stop(),
});
function getWebhookDispatcher() {
    return dispatcherSingleton.get();
}
function resetWebhookDispatcher() {
    dispatcherSingleton.reset();
}
