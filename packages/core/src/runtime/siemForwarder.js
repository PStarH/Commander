"use strict";
/**
 * SIEM Log Forwarder — enterprise log forwarding for Commander.
 *
 * Forwards security audit events and execution traces to external SIEM systems:
 *   - Syslog (RFC 5424) over UDP or TCP → Splunk, ELK, rsyslog, syslog-ng
 *   - Splunk HTTP Event Collector (HEC) → Splunk Enterprise / Cloud
 *   - Datadog Logs HTTP API → Datadog
 *
 * Configuration via env vars:
 *   SIEM_TYPE=syslog|splunk-hec|datadog
 *   SIEM_ENDPOINT=host:port (for syslog) or full URL (for HEC/DataDog)
 *   SIEM_TOKEN=... (Splunk HEC token or Datadog API key)
 *   SIEM_SOURCE=commander (default source name)
 *
 * Wire-in: call siemForwarder.forward(event) wherever security events are logged.
 * The forwarder is non-blocking (fire-and-forget with internal queue + retry).
 */
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
exports.SIEMForwarder = void 0;
exports.createSIEMForwarderFromEnv = createSIEMForwarderFromEnv;
const dgram = __importStar(require("dgram"));
const net = __importStar(require("net"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const logging_1 = require("../logging");
// ============================================================================
// Default Config
// ============================================================================
const DEFAULT_CONFIG = {
    protocol: 'udp',
    sourceName: 'commander',
    maxQueueSize: 1000,
    retryIntervalMs: 5000,
    verbose: false,
};
// ============================================================================
// SIEM Forwarder
// ============================================================================
class SIEMForwarder {
    constructor(config) {
        this.queue = [];
        this.processing = false;
        this.retryTimer = null;
        this.totalForwarded = 0;
        this.totalFailed = 0;
        this.totalDropped = 0;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.hostname = os.hostname();
    }
    /** Get forwarder stats */
    getStats() {
        return {
            totalForwarded: this.totalForwarded,
            totalFailed: this.totalFailed,
            totalDropped: this.totalDropped,
            queueSize: this.queue.length,
        };
    }
    /**
     * Forward a SIEM event. Non-blocking — events are queued and processed
     * in batches. Returns immediately.
     */
    forward(event) {
        var _a;
        if (this.queue.length >= ((_a = this.config.maxQueueSize) !== null && _a !== void 0 ? _a : 1000)) {
            this.queue.shift(); // Drop oldest
            this.totalDropped++;
        }
        this.queue.push(event);
        if (!this.processing) {
            this.processing = true;
            this.processQueue().catch(() => {
                this.processing = false;
            });
        }
    }
    /**
     * Forward multiple events at once. More efficient than calling forward() in a loop.
     */
    forwardBatch(events) {
        for (const event of events) {
            this.forward(event);
        }
    }
    /**
     * Flush the queue immediately. Returns when the queue is empty.
     * Useful before shutdown.
     */
    async flush(timeoutMs = 5000) {
        const start = Date.now();
        while (this.queue.length > 0 && Date.now() - start < timeoutMs) {
            if (!this.processing) {
                this.processing = true;
                await this.processQueue();
                this.processing = false;
            }
            else {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
    }
    // ── Private ──────────────────────────────────────────────────────
    async processQueue() {
        var _a, _b;
        while (this.queue.length > 0) {
            const batch = this.queue.splice(0, 10); // Process in batches of 10
            try {
                await this.sendBatch(batch);
                this.totalForwarded += batch.length;
                if (this.config.verbose) {
                    (0, logging_1.getGlobalLogger)().debug('SIEMForwarder', `Forwarded ${batch.length} events`, {
                        type: this.config.type,
                        totalForwarded: this.totalForwarded,
                    });
                }
            }
            catch (err) {
                this.totalFailed += batch.length;
                // Re-queue failed events to the FRONT to preserve ordering.
                // Use splice to insert at position 0 without creating a new array.
                const reQueueCount = Math.min(batch.length, ((_a = this.config.maxQueueSize) !== null && _a !== void 0 ? _a : 1000) - this.queue.length);
                if (reQueueCount > 0) {
                    const toRequeue = batch.slice(0, reQueueCount);
                    this.queue.splice(0, 0, ...toRequeue);
                }
                (0, logging_1.getGlobalLogger)().warn('SIEMForwarder', 'Failed to forward events, will retry', {
                    type: this.config.type,
                    failed: batch.length,
                    reQueued: reQueueCount,
                    error: err === null || err === void 0 ? void 0 : err.message,
                });
                // Schedule retry
                if (!this.retryTimer) {
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        if (this.queue.length > 0 && !this.processing) {
                            this.processing = true;
                            this.processQueue().catch(() => {
                                this.processing = false;
                            });
                        }
                    }, (_b = this.config.retryIntervalMs) !== null && _b !== void 0 ? _b : 5000);
                    if (typeof this.retryTimer.unref === 'function') {
                        this.retryTimer.unref();
                    }
                }
                return; // Stop processing until retry
            }
        }
        this.processing = false;
    }
    async sendBatch(events) {
        switch (this.config.type) {
            case 'syslog':
                await this.sendSyslog(events);
                break;
            case 'splunk-hec':
                await this.sendSplunkHEC(events);
                break;
            case 'datadog':
                await this.sendDatadog(events);
                break;
        }
    }
    // ── Syslog (RFC 5424) ─────────────────────────────────────────────
    /**
     * Format event as RFC 5424 syslog message and send via UDP or TCP.
     *
     * RFC 5424 format:
     *   <PRI>VERSION TIMESTAMP HOSTNAME APPNAME PROCID MSGID STRUCTURED-DATA MSG
     *
     * Facility: 1 (user-level). Severity maps to syslog severity (0-7).
     */
    async sendSyslog(events) {
        var _a;
        const [host, portStr] = this.config.endpoint.split(':');
        const port = parseInt(portStr !== null && portStr !== void 0 ? portStr : '514', 10);
        const appName = (_a = this.config.sourceName) !== null && _a !== void 0 ? _a : 'commander';
        const messages = events.map((event) => this.formatSyslogMessage(event, appName, this.hostname));
        const payload = messages.join('\n');
        if (this.config.protocol === 'tcp') {
            await this.sendTCP(host, port, payload);
        }
        else {
            await this.sendUDP(host, port, payload);
        }
    }
    formatSyslogMessage(event, appName, hostname) {
        const pri = this.severityToSyslogPriority(event.severity);
        const timestamp = new Date(event.timestamp).toISOString();
        const msgId = event.type.replace(/[^a-zA-Z0-9_-]/g, '_');
        const structuredData = event.eventId
            ? `[eventId@commander id="${event.eventId}" severity="${event.severity}"]`
            : '-';
        const msg = event.message.replace(/[\n\r]/g, ' ').slice(0, 1000);
        // RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APPNAME PROCID MSGID STRUCTURED-DATA MSG
        return `<${pri}>1 ${timestamp} ${hostname} ${appName} - ${msgId} ${structuredData} ${msg}`;
    }
    severityToSyslogPriority(severity) {
        const facility = 1; // user-level
        const sev = (sev) => {
            switch (sev) {
                case 'critical':
                    return 2; // Critical
                case 'high':
                    return 3; // Error
                case 'medium':
                    return 4; // Warning
                case 'low':
                    return 6; // Informational
                default:
                    return 6;
            }
        };
        return facility * 8 + sev(severity);
    }
    sendUDP(host, port, payload) {
        return new Promise((resolve, reject) => {
            const client = dgram.createSocket('udp4');
            const buffer = Buffer.from(payload, 'utf-8');
            client.send(buffer, 0, buffer.length, port, host, (err) => {
                client.close();
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    sendTCP(host, port, payload) {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            client.connect(port, host, () => {
                client.write(payload, 'utf-8', (err) => {
                    client.destroy();
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
            });
            client.on('error', (err) => {
                client.destroy();
                reject(err);
            });
            client.setTimeout(10000, () => {
                client.destroy();
                reject(new Error('TCP connection timeout'));
            });
        });
    }
    // ── Splunk HEC ────────────────────────────────────────────────────
    /**
     * Send events to Splunk HTTP Event Collector.
     * Endpoint format: https://your-instance.splunkcloud.com:8088
     * Token: Splunk HEC token (configured in Splunk)
     */
    async sendSplunkHEC(events) {
        var _a, _b;
        const url = new URL(this.config.endpoint);
        const token = (_a = this.config.token) !== null && _a !== void 0 ? _a : '';
        const source = (_b = this.config.sourceName) !== null && _b !== void 0 ? _b : 'commander';
        const payload = events.map((event) => ({
            time: new Date(event.timestamp).getTime() / 1000,
            host: this.hostname,
            source,
            sourcetype: 'commander:event',
            event: {
                type: event.type,
                severity: event.severity,
                source: event.source,
                message: event.message,
                ...(event.details ? { details: event.details } : {}),
                ...(event.context ? { context: event.context } : {}),
                event_id: event.eventId,
            },
        }));
        await this.httpPost(url, payload, {
            Authorization: `Splunk ${token}`,
            'Content-Type': 'application/json',
        });
    }
    // ── Datadog ───────────────────────────────────────────────────────
    /**
     * Send events to Datadog Logs HTTP API.
     * Endpoint: https://http-intake.logs.datadoghq.com/api/v2/logs
     * Token: Datadog API key
     */
    async sendDatadog(events) {
        var _a;
        const url = new URL(this.config.endpoint);
        const apiKey = (_a = this.config.token) !== null && _a !== void 0 ? _a : '';
        const payload = events.map((event) => {
            var _a;
            return ({
                ddsource: (_a = this.config.sourceName) !== null && _a !== void 0 ? _a : 'commander',
                ddtags: `severity:${event.severity},type:${event.type}`,
                hostname: this.hostname,
                service: 'commander',
                message: JSON.stringify({
                    type: event.type,
                    severity: event.severity,
                    source: event.source,
                    message: event.message,
                    details: event.details,
                    context: event.context,
                    event_id: event.eventId,
                }),
                date: new Date(event.timestamp).getTime(),
            });
        });
        await this.httpPost(url, payload, {
            'DD-API-KEY': apiKey,
            'Content-Type': 'application/json',
        });
    }
    // ── HTTP helper ───────────────────────────────────────────────────
    httpPost(url, body, headers) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    ...headers,
                },
                timeout: 10000,
            };
            const mod = url.protocol === 'https:' ? https : http;
            const req = mod.request(options, (res) => {
                let responseBody = '';
                res.on('data', (chunk) => {
                    responseBody += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('HTTP request timeout'));
            });
            req.write(data);
            req.end();
        });
    }
}
exports.SIEMForwarder = SIEMForwarder;
// ============================================================================
// Factory
// ============================================================================
/**
 * Create a SIEMForwarder from environment variables.
 * Returns null if SIEM_TYPE is not set or unsupported.
 *
 * Expected env vars:
 *   SIEM_TYPE=syslog|splunk-hec|datadog
 *   SIEM_ENDPOINT=host:port (syslog) or https://... (HEC/Datadog)
 *   SIEM_TOKEN=... (HEC token or Datadog API key)
 *   SIEM_PROTOCOL=udp|tcp (syslog, default: udp)
 *   SIEM_SOURCE=commander (default source name)
 *   SIEM_VERBOSE=true (enable verbose logging)
 */
function createSIEMForwarderFromEnv() {
    var _a, _b;
    const type = process.env.SIEM_TYPE;
    if (!type)
        return null;
    const endpoint = process.env.SIEM_ENDPOINT;
    if (!endpoint) {
        (0, logging_1.getGlobalLogger)().warn('SIEMForwarder', 'SIEM_TYPE set but SIEM_ENDPOINT missing');
        return null;
    }
    if (!['syslog', 'splunk-hec', 'datadog'].includes(type)) {
        (0, logging_1.getGlobalLogger)().warn('SIEMForwarder', `Unsupported SIEM_TYPE: ${type}. Use syslog, splunk-hec, or datadog.`);
        return null;
    }
    return new SIEMForwarder({
        type: type,
        endpoint,
        token: process.env.SIEM_TOKEN,
        protocol: (_a = process.env.SIEM_PROTOCOL) !== null && _a !== void 0 ? _a : 'udp',
        sourceName: (_b = process.env.SIEM_SOURCE) !== null && _b !== void 0 ? _b : 'commander',
        verbose: process.env.SIEM_VERBOSE === 'true',
    });
}
