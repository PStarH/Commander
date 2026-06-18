"use strict";
/**
 * PrivacyRouter — Sensitive content detection and local model routing.
 *
 * When sensitive data flows through the tool chain (API keys, secrets,
 * internal IPs, PII, private keys), the PrivacyRouter automatically
 * reroutes the LLM call to a local model (Ollama, vLLM) instead of
 * sending it to a cloud provider.
 *
 * This is the "Local-First Fallback" pattern: enterprise compliance
 * demands that sensitive data never leaves the premises. By hooking
 * into the existing ModelRouter pipeline, we provide this guarantee
 * transparently to the user.
 *
 * Sensitivity checks (zero LLM cost):
 *   - API key patterns (sk-, ghp_, etc.)
 *   - Internal/private IP addresses (10.x, 172.16-31.x, 192.168.x)
 *   - Credentials in code (password=, secret=, token=)
 *   - Private key blocks (-----BEGIN PRIVATE KEY-----)
 *   - Email addresses and phone numbers (PII leaks)
 *
 * Usage:
 *   const privacy = new PrivacyRouter();
 *   const decision = privacy.checkContent(ctx.goal);
 *   if (decision.route === 'local') {
 *     // Override modelId to local provider
 *   }
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
exports.PrivacyRouter = void 0;
exports.getPrivacyRouter = getPrivacyRouter;
exports.resetPrivacyRouter = resetPrivacyRouter;
const logging_1 = require("../logging");
const securityAuditLogger_1 = require("../security/securityAuditLogger");
// ============================================================================
// Sensitivity Patterns (zero-cost regex, no LLM calls)
// ============================================================================
const SENSITIVITY_PATTERNS = [
    // ── API Keys (critical) ────────────────────────────────────────────────
    {
        category: 'api_key',
        severity: 'critical',
        regex: /sk-[A-Za-z0-9]{20,}/g,
        label: 'OpenAI API key',
    },
    {
        category: 'api_key',
        severity: 'critical',
        regex: /sk-ant-[A-Za-z0-9]{20,}/g,
        label: 'Anthropic API key',
    },
    {
        category: 'api_key',
        severity: 'critical',
        regex: /AIza[0-9A-Za-z_-]{35}/g,
        label: 'Google API key',
    },
    {
        category: 'api_key',
        severity: 'critical',
        regex: /ghp_[A-Za-z0-9]{36}/g,
        label: 'GitHub personal access token',
    },
    {
        category: 'api_key',
        severity: 'critical',
        regex: /ghs_[A-Za-z0-9]{36}/g,
        label: 'GitHub server-to-server token',
    },
    {
        category: 'api_key',
        severity: 'high',
        regex: /hf_[A-Za-z0-9]{32,}/g,
        label: 'HuggingFace API key',
    },
    { category: 'api_key', severity: 'high', regex: /xai-[A-Za-z0-9]{32,}/g, label: 'xAI API key' },
    { category: 'api_key', severity: 'high', regex: /glm-[A-Za-z0-9]{20,}/g, label: 'GLM API key' },
    // ── Internal IPs (high) ────────────────────────────────────────────────
    {
        category: 'internal_ip',
        severity: 'high',
        regex: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        label: 'Class A private IP (10.x)',
    },
    {
        category: 'internal_ip',
        severity: 'high',
        regex: /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
        label: 'Class B private IP (172.16-31.x)',
    },
    {
        category: 'internal_ip',
        severity: 'high',
        regex: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
        label: 'Class C private IP (192.168.x)',
    },
    {
        category: 'internal_ip',
        severity: 'medium',
        regex: /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        label: 'Loopback IP (127.x)',
    },
    {
        category: 'internal_ip',
        severity: 'medium',
        regex: /\b(0\.0\.0\.0|localhost)\b/g,
        label: 'Localhost reference',
    },
    // ── Credential Exposure (critical) ─────────────────────────────────────
    {
        category: 'credential_exposure',
        severity: 'critical',
        regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{3,}['"]/gi,
        label: 'Password assignment',
    },
    {
        category: 'credential_exposure',
        severity: 'critical',
        regex: /(?:secret|SECRET)\s*[:=]\s*['"][A-Za-z0-9_\-+=/]{8,}['"]/g,
        label: 'Secret key assignment',
    },
    {
        category: 'credential_exposure',
        severity: 'high',
        regex: /(?:token|TOKEN)\s*[:=]\s*['"][A-Za-z0-9_.\-]{8,}['"]/g,
        label: 'Token assignment',
    },
    {
        category: 'credential_exposure',
        severity: 'high',
        regex: /DATABASE_URL\s*=\s*['"][^'"]+['"]/g,
        label: 'Database connection string',
    },
    {
        category: 'credential_exposure',
        severity: 'high',
        regex: /(?:mongodb|postgres|mysql|redis):\/\/[^'"\s]+/gi,
        label: 'Database connection URI',
    },
    // ── Private Keys (critical) ────────────────────────────────────────────
    {
        category: 'private_key',
        severity: 'critical',
        regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
        label: 'Private key block',
    },
    {
        category: 'private_key',
        severity: 'high',
        regex: /-----BEGIN\s+CERTIFICATE-----/g,
        label: 'Certificate block',
    },
    {
        category: 'private_key',
        severity: 'high',
        regex: /ssh-[a-z0-9]+\s+[A-Za-z0-9+/=]{100,}/g,
        label: 'SSH public key',
    },
    // ── PII (medium) ───────────────────────────────────────────────────────
    {
        category: 'pii',
        severity: 'medium',
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        label: 'Email address',
    },
    {
        category: 'pii',
        severity: 'low',
        regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
        label: 'Phone number (US)',
    },
    // ── Cloud Credentials (critical) ───────────────────────────────────────
    {
        category: 'cloud_credential',
        severity: 'critical',
        regex: /AKIA[0-9A-Z]{16}/g,
        label: 'AWS Access Key ID',
    },
    {
        category: 'cloud_credential',
        severity: 'critical',
        regex: /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*\S+/gi,
        label: 'AWS credential config',
    },
    {
        category: 'cloud_credential',
        severity: 'high',
        regex: /service_account.*\.json/gi,
        label: 'GCP service account',
    },
    {
        category: 'cloud_credential',
        severity: 'high',
        regex: /AZURE_CLIENT_SECRET\s*[:=]\s*\S+/gi,
        label: 'Azure client secret',
    },
    // ── Config Secrets (medium) ────────────────────────────────────────────
    {
        category: 'config_secret',
        severity: 'medium',
        regex: /\.env\b.{0,20}?(?:KEY|SECRET|TOKEN|PASSWORD)/gi,
        label: '.env file secret reference',
    },
    {
        category: 'config_secret',
        severity: 'low',
        regex: /process\.env\.[A-Z_]{3,}/g,
        label: 'process.env reference',
    },
];
// ============================================================================
// PrivacyRouter
// ============================================================================
class PrivacyRouter {
    constructor(config = {}) {
        this.localAvailable = { ollama: false, vllm: false };
        this.checkedLocal = false;
        this.config = {
            enabled: true,
            routeThreshold: 'medium',
            blockOnCritical: true,
            auditLog: true,
            ...config,
        };
    }
    /**
     * Check if the provided content contains sensitive data and determine
     * the appropriate routing decision.
     *
     * @param content - The content to scan (agent goal, user prompt, tool args)
     * @param context - Optional execution context for enhanced detection
     */
    async checkContent(content, context) {
        if (!this.config.enabled) {
            return {
                route: 'cloud',
                reason: 'Privacy routing disabled',
                matches: [],
                suggestedProvider: null,
                suggestedModel: null,
                blocked: false,
            };
        }
        const matches = this.detectSensitivePatterns(content);
        // Filter by threshold
        const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
        const threshold = severityOrder[this.config.routeThreshold];
        const significant = matches.filter((m) => severityOrder[m.severity] >= threshold);
        if (significant.length === 0) {
            return {
                route: 'cloud',
                reason: 'No sensitive patterns detected',
                matches,
                suggestedProvider: null,
                suggestedModel: null,
                blocked: false,
            };
        }
        const criticalMatches = significant.filter((m) => m.severity === 'critical');
        const highestSeverity = criticalMatches.length > 0
            ? 'critical'
            : significant.some((m) => m.severity === 'high')
                ? 'high'
                : 'medium';
        if (criticalMatches.length > 0 && this.config.blockOnCritical) {
            // Block execution entirely — live keys/secrets in content is a red flag
            this.logPrivacyEvent('blocked', criticalMatches, context);
            return {
                route: 'blocked',
                reason: `Blocked: ${criticalMatches.length} critical secret(s) detected. Remove sensitive data before sending to AI.`,
                matches: significant,
                suggestedProvider: null,
                suggestedModel: null,
                blocked: true,
            };
        }
        // Route to local model
        const local = await this.getLocalProvider();
        if (!local) {
            // No local model available — log warning and still route to cloud (best-effort)
            this.logPrivacyEvent('fallback_cloud', significant, context);
            return {
                route: 'cloud',
                reason: 'Sensitive content detected but no local model available. Routing to cloud (fallback).',
                matches: significant,
                suggestedProvider: null,
                suggestedModel: null,
                blocked: false,
            };
        }
        this.logPrivacyEvent('routed_local', significant, context);
        return {
            route: 'local',
            reason: `Routed to local model: ${significant.length} sensitive pattern(s) detected (highest: ${highestSeverity})`,
            matches: significant,
            suggestedProvider: local.provider,
            suggestedModel: local.model,
            blocked: false,
        };
    }
    /**
     * Apply a privacy decision to a routing decision, overriding the model
     * if the decision says to use a local model.
     */
    applyRouting(original, decision) {
        var _a;
        if (decision.route !== 'local' || !decision.suggestedProvider) {
            return original;
        }
        return {
            modelId: (_a = decision.suggestedModel) !== null && _a !== void 0 ? _a : 'llama3.2',
            tier: 'eco',
            provider: decision.suggestedProvider,
            reasoning: [
                ...original.reasoning,
                `privacy_routing: ${decision.reason}`,
                `sensitive_patterns: ${decision.matches.map((m) => m.category).join(', ')}`,
            ],
            estimatedCost: 0, // Local = free
            maxTokens: original.maxTokens,
        };
    }
    /**
     * Convenience: check content and apply routing in one call.
     */
    async routeWithPrivacy(ctx, originalRoute) {
        const decision = await this.checkContent(ctx.goal, {
            agentId: ctx.agentId,
            runId: ctx.runId,
        });
        if (decision.blocked) {
            return {
                routing: {
                    ...originalRoute,
                    modelId: 'blocked:privacy',
                    tier: 'eco',
                    provider: 'privacy',
                    reasoning: [...originalRoute.reasoning, `BLOCKED: ${decision.reason}`],
                },
                decision,
            };
        }
        const routing = this.applyRouting(originalRoute, decision);
        return { routing, decision };
    }
    /**
     * Quick synchronous check: is there any sensitive content?
     * Does NOT check local model availability. For pre-flight use.
     */
    checkSync(content) {
        var _a, _b;
        const matches = this.detectSensitivePatterns(content);
        const critical = matches.filter((m) => m.severity === 'critical');
        if (critical.length > 0 && this.config.blockOnCritical) {
            return {
                route: 'blocked',
                reason: 'Critical secrets detected',
                matches: critical,
                suggestedProvider: null,
                suggestedModel: null,
                blocked: true,
            };
        }
        const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
        const threshold = severityOrder[this.config.routeThreshold];
        const significant = matches.filter((m) => severityOrder[m.severity] >= threshold);
        if (significant.length > 0) {
            return {
                route: 'local',
                reason: 'Sensitive content detected',
                matches: significant,
                suggestedProvider: (_a = this.config.preferredLocalProvider) !== null && _a !== void 0 ? _a : 'ollama',
                suggestedModel: (_b = this.config.preferredLocalModel) !== null && _b !== void 0 ? _b : 'llama3.2',
                blocked: false,
            };
        }
        return {
            route: 'cloud',
            reason: 'No sensitive patterns',
            matches,
            suggestedProvider: null,
            suggestedModel: null,
            blocked: false,
        };
    }
    // ========================================================================
    // Internal
    // ========================================================================
    /**
     * Scan content against all sensitivity patterns.
     * Zero-cost: pure regex, no LLM calls.
     */
    detectSensitivePatterns(content) {
        const matches = [];
        const seenPositions = new Set();
        for (const { category, severity, regex, label } of SENSITIVITY_PATTERNS) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(content)) !== null) {
                // Avoid duplicate matches at the same position (overlapping patterns)
                if (seenPositions.has(match.index))
                    continue;
                seenPositions.add(match.index);
                // Redact the matched value — never log raw secrets
                const redacted = this.redact(category, match[0]);
                matches.push({
                    category,
                    severity,
                    pattern: label,
                    match: redacted,
                    position: match.index,
                });
            }
        }
        return matches;
    }
    /**
     * Redact sensitive values for safe logging.
     */
    redact(category, value) {
        if (value.length <= 6)
            return '***';
        const show = Math.min(4, Math.floor(value.length / 3));
        return value.slice(0, show) + '***' + value.slice(-show);
    }
    /**
     * Log privacy routing decision to the security audit trail.
     */
    logPrivacyEvent(action, matches, context) {
        if (!this.config.auditLog)
            return;
        try {
            const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
            const categories = [...new Set(matches.map((m) => m.category))];
            const highestSeverity = matches.some((m) => m.severity === 'critical')
                ? 'critical'
                : matches.some((m) => m.severity === 'high')
                    ? 'high'
                    : 'medium';
            const event = {
                type: 'content_threat',
                severity: action === 'blocked' ? 'critical' : highestSeverity,
                source: 'PrivacyRouter',
                message: `Privacy routing: ${action} — ${matches.length} sensitive pattern(s): ${categories.join(', ')}`,
                details: {
                    action,
                    matchCount: matches.length,
                    categories,
                    highestSeverity,
                },
                context: {
                    agentId: context === null || context === void 0 ? void 0 : context.agentId,
                    runId: context === null || context === void 0 ? void 0 : context.runId,
                },
            };
            audit.logEvent(event);
        }
        catch {
            // Security audit logging is best-effort
        }
        try {
            const logger = (0, logging_1.getGlobalLogger)();
            if (action === 'blocked') {
                logger.warn('PrivacyRouter', `🚫 Blocked execution: ${matches.length} sensitive pattern(s) detected`);
            }
            else if (action === 'routed_local') {
                logger.info('PrivacyRouter', `🔒 Routed to local model: ${matches.length} sensitive pattern(s) detected`);
            }
        }
        catch {
            // Logging is best-effort
        }
    }
    /**
     * Check if a local model provider is available.
     * Caches the result for the lifetime of the router.
     */
    async getLocalProvider() {
        var _a, _b, _c, _d, _e;
        if (this.config.preferredLocalProvider) {
            // User explicitly set a local provider — trust it
            return {
                provider: this.config.preferredLocalProvider,
                model: (_a = this.config.preferredLocalModel) !== null && _a !== void 0 ? _a : 'llama3.2',
            };
        }
        // Auto-detect: try Ollama first, then vLLM
        if (this.checkedLocal) {
            if (this.localAvailable.ollama) {
                return { provider: 'ollama', model: (_b = this.config.preferredLocalModel) !== null && _b !== void 0 ? _b : 'llama3.2' };
            }
            if (this.localAvailable.vllm) {
                return {
                    provider: 'vllm',
                    model: (_c = this.config.preferredLocalModel) !== null && _c !== void 0 ? _c : 'meta-llama/Llama-3.2-3B-Instruct',
                };
            }
            return null;
        }
        this.checkedLocal = true;
        // Try Ollama
        try {
            const { OllamaProvider } = await Promise.resolve().then(() => __importStar(require('./providers/ollamaProvider')));
            const running = await OllamaProvider.isRunning();
            if (running) {
                this.localAvailable.ollama = true;
                const model = (_d = this.config.preferredLocalModel) !== null && _d !== void 0 ? _d : 'llama3.2';
                return { provider: 'ollama', model };
            }
        }
        catch {
            /* Ollama not available */
        }
        // Try vLLM
        try {
            const baseUrl = process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
            const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                this.localAvailable.vllm = true;
                const model = (_e = this.config.preferredLocalModel) !== null && _e !== void 0 ? _e : 'meta-llama/Llama-3.2-3B-Instruct';
                return { provider: 'vllm', model };
            }
        }
        catch {
            /* vLLM not available */
        }
        return null;
    }
}
exports.PrivacyRouter = PrivacyRouter;
// ============================================================================
// Factory
// ============================================================================
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const privacyRouterSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new PrivacyRouter());
function getPrivacyRouter() {
    return privacyRouterSingleton.get();
}
function resetPrivacyRouter() {
    privacyRouterSingleton.reset();
}
