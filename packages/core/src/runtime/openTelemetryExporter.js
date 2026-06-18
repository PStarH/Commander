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
exports.OpenTelemetryExporter = void 0;
exports.executionTraceToOtlpSpans = executionTraceToOtlpSpans;
exports.getOTelExporter = getOTelExporter;
exports.resetOTelExporter = resetOTelExporter;
/**
 * OpenTelemetry Trace Exporter (OTLP HTTP JSON)
 *
 * Exports execution traces to any OpenTelemetry-compatible backend
 * (Jaeger, Grafana Tempo, SigNoz, etc.) via OTLP HTTP JSON protocol.
 *
 * No external dependencies — uses built-in http/https and crypto.
 * Falls back to file-based queue if endpoint is unreachable.
 *
 * Usage:
 *   const exporter = new OpenTelemetryExporter({
 *     endpoint: 'http://localhost:4318/v1/traces',
 *     serviceName: 'commander',
 *   });
 *   await exporter.start();
 *   exporter.exportSpan(executionSpan);
 *   await exporter.stop();
 */
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const otelSemConv_1 = require("../observability/otelSemConv");
// ── OTLP Protocol Helpers ──────────────────────────────────────────
function isoToNanos(iso) {
    const d = new Date(iso);
    return String(d.getTime() * 1000000);
}
function toOtlpSpan(span) {
    var _a, _b;
    const attrs = [];
    for (const [key, value] of Object.entries(span.attributes || {})) {
        const attr = { key, value: {} };
        if (typeof value === 'string')
            attr.value = { stringValue: value };
        else if (typeof value === 'boolean')
            attr.value = { boolValue: value };
        else
            attr.value = { intValue: String(value) };
        attrs.push(attr);
    }
    // Add resource attributes if present
    if (span.resource) {
        for (const [key, value] of Object.entries(span.resource)) {
            attrs.push({ key: `resource.${key}`, value: { stringValue: String(value) } });
        }
    }
    return {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: (_a = span.parentSpanId) !== null && _a !== void 0 ? _a : undefined,
        name: span.name,
        kind: span.kind,
        startTimeUnixNano: isoToNanos(span.startTime),
        endTimeUnixNano: isoToNanos(span.endTime),
        attributes: attrs,
        status: (_b = span.status) !== null && _b !== void 0 ? _b : { code: 0 },
    };
}
function toOtlpTraceRequest(spans, serviceName) {
    return {
        resourceSpans: [
            {
                resource: {
                    attributes: [
                        { key: 'service.name', value: { stringValue: serviceName } },
                        { key: 'telemetry.sdk.name', value: { stringValue: 'commander' } },
                        { key: 'telemetry.sdk.language', value: { stringValue: 'typescript' } },
                        { key: 'telemetry.sdk.version', value: { stringValue: '0.2.0' } },
                    ],
                },
                scopeSpans: [
                    {
                        scope: { name: 'commander.execution' },
                        spans: spans.map((s) => toOtlpSpan(s)),
                    },
                ],
            },
        ],
    };
}
// ── Exporter ───────────────────────────────────────────────────────
class OpenTelemetryExporter {
    constructor(config = {}) {
        var _a;
        this.queue = [];
        this.flushTimer = null;
        this.running = false;
        this.totalExported = 0;
        this.totalFailed = 0;
        this.config = {
            endpoint: config.endpoint || 'http://localhost:4318/v1/traces',
            serviceName: config.serviceName || 'commander',
            headers: config.headers || {},
            batchSize: config.batchSize || 64,
            batchIntervalMs: config.batchIntervalMs || 5000,
            fallbackDir: config.fallbackDir || path.join(process.cwd(), '.commander', 'otel_queue'),
        };
        // Try env var override
        const envEndpoint = typeof process !== 'undefined' ? (_a = process.env) === null || _a === void 0 ? void 0 : _a.OTEL_EXPORTER_OTLP_ENDPOINT : undefined;
        if (envEndpoint) {
            this.config.endpoint = envEndpoint;
        }
    }
    // ── Lifecycle ────────────────────────────────────────────────────
    async start() {
        if (this.running)
            return;
        this.running = true;
        // Recover queued spans from filesystem
        await this.recoverFromDisk();
        // Start batch flush timer
        this.flushTimer = setInterval(() => this.flush(), this.config.batchIntervalMs);
        this.flushTimer.unref();
        (0, logging_1.getGlobalLogger)().info('OTelExporter', 'Started', {
            endpoint: this.config.endpoint,
            batchSize: this.config.batchSize,
            batchIntervalMs: this.config.batchIntervalMs,
        });
    }
    async stop() {
        this.running = false;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        // Final flush
        await this.flush();
        (0, logging_1.getGlobalLogger)().info('OTelExporter', 'Stopped', {
            totalExported: this.totalExported,
            totalFailed: this.totalFailed,
        });
    }
    async forceFlush() {
        await this.flush();
    }
    // ── Export ───────────────────────────────────────────────────────
    /**
     * Queue a span for export. Non-blocking — spans are batched and sent periodically.
     */
    exportSpan(span) {
        if (!this.running) {
            (0, logging_1.getGlobalLogger)().warn('OTelExporter', 'Exporter not started — queuing span');
        }
        if (this.queue.length >= OpenTelemetryExporter.MAX_QUEUE_SIZE) {
            this.queue.shift(); // drop oldest to prevent unbounded memory growth
        }
        this.queue.push(span);
        // Send immediately if batch size reached
        if (this.queue.length >= this.config.batchSize) {
            this.flush().catch((err) => {
                (0, logging_1.getGlobalLogger)().error('OTelExporter', 'Batch flush failed', err);
            });
        }
    }
    getStats() {
        return {
            queued: this.queue.length,
            totalExported: this.totalExported,
            totalFailed: this.totalFailed,
        };
    }
    // ── Internal ─────────────────────────────────────────────────────
    async flush() {
        if (this.queue.length === 0)
            return;
        const batch = this.queue.splice(0, this.config.batchSize);
        try {
            await this.sendBatch(batch);
            this.totalExported += batch.length;
        }
        catch (err) {
            this.totalFailed += batch.length;
            (0, logging_1.getGlobalLogger)().error('OTelExporter', 'Failed to send batch, saving to disk', err);
            this.saveToDisk(batch);
        }
    }
    sendBatch(spans) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(toOtlpTraceRequest(spans, this.config.serviceName));
            const url = new URL(this.config.endpoint);
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;
            const headers = {
                'Content-Type': 'application/json',
                ...this.config.headers,
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
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk.toString();
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    }
                    else {
                        reject(new Error(`OTLP endpoint returned ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('OTLP request timeout'));
            });
            req.write(body);
            req.end();
        });
    }
    // ── Disk Fallback ────────────────────────────────────────────────
    saveToDisk(spans) {
        try {
            const dir = this.config.fallbackDir;
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const filename = path.join(dir, `spans_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
            fs.writeFileSync(filename, JSON.stringify(spans));
            (0, logging_1.getGlobalLogger)().info('OTelExporter', 'Saved spans to disk', {
                filename,
                count: spans.length,
            });
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('OTelExporter', 'Failed to save spans to disk', err);
        }
    }
    async recoverFromDisk() {
        const dir = this.config.fallbackDir;
        try {
            if (!fs.existsSync(dir))
                return;
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                    if (Array.isArray(data)) {
                        for (const span of data) {
                            if (this.queue.length < OpenTelemetryExporter.MAX_QUEUE_SIZE) {
                                this.queue.push(span);
                            }
                        }
                    }
                    fs.unlinkSync(path.join(dir, file));
                }
                catch {
                    // Delete corrupted files to prevent retry loop on every restart
                    try {
                        fs.unlinkSync(path.join(dir, file));
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('OTelExporter', 'Failed to delete corrupted file', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                            file,
                        });
                    }
                }
            }
            if (files.length > 0) {
                (0, logging_1.getGlobalLogger)().info('OTelExporter', 'Recovered spans from disk', {
                    files: files.length,
                    spans: this.queue.length,
                });
            }
        }
        catch {
            // Directory may not exist yet
        }
    }
}
exports.OpenTelemetryExporter = OpenTelemetryExporter;
OpenTelemetryExporter.MAX_QUEUE_SIZE = 10000;
// ── ExecutionTrace → OTelSpan Bridge ───────────────────────────────
/**
 * Convert an ExecutionTrace into an array of OTelSpan objects for export.
 * Each TraceEvent becomes one OTelSpan. OTel GenAI attributes are produced
 * via the shared `eventToOtelAttrs` mapping so HTTP and OTLP exports stay
 * in sync (P1: OTel GenAI 1.36+ compliance).
 */
function executionTraceToOtlpSpans(trace) {
    var _a;
    const spans = [];
    const baseAttrs = {
        'commander.run_id': trace.runId,
        'commander.agent_id': trace.agentId,
    };
    if (trace.missionId)
        baseAttrs['commander.mission_id'] = trace.missionId;
    for (const event of trace.events) {
        const otelAttrs = (0, otelSemConv_1.eventToOtelAttrs)(event, {});
        const attrs = { ...baseAttrs };
        for (const [k, v] of Object.entries(otelAttrs)) {
            if (v === undefined)
                continue;
            attrs[k] = typeof v === 'boolean' ? v : v;
        }
        if (event.data.stateTransition) {
            attrs['state.from'] = event.data.stateTransition.from;
            attrs['state.to'] = event.data.stateTransition.to;
        }
        const span = {
            traceId: event.traceId,
            spanId: event.spanId,
            parentSpanId: event.parentSpanId,
            name: (0, otelSemConv_1.spanNameForEvent)(event),
            kind: 0,
            startTime: event.timestamp,
            endTime: new Date(new Date(event.timestamp).getTime() + event.durationMs).toISOString(),
            attributes: attrs,
            status: event.type === 'error' ? { code: 2, message: String((_a = event.data.error) !== null && _a !== void 0 ? _a : '') } : { code: 1 },
        };
        spans.push(span);
    }
    return spans;
}
function eventDataToSpanName(input, output, type) {
    var _a;
    if (type === 'llm_call') {
        const model = typeof input === 'object' && input && 'model' in input
            ? ((_a = String(input.model)
                .split('/')
                .pop()) !== null && _a !== void 0 ? _a : 'llm')
            : 'llm';
        return `llm.${model}`;
    }
    if (type === 'tool_execution')
        return `tool.${String(input !== null && input !== void 0 ? input : 'unknown')}`;
    if (type === 'error')
        return `error.${String(output !== null && output !== void 0 ? output : 'unknown').slice(0, 60)}`;
    if (type === 'state_change')
        return `state.${String(input !== null && input !== void 0 ? input : 'transition')}`;
    return `decision.${String(output !== null && output !== void 0 ? output : 'unknown').slice(0, 60)}`;
}
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let _otelConfig;
const otelExporterSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new OpenTelemetryExporter(_otelConfig));
function getOTelExporter(config) {
    if (config)
        _otelConfig = config;
    return otelExporterSingleton.get();
}
function resetOTelExporter() {
    otelExporterSingleton.reset();
}
