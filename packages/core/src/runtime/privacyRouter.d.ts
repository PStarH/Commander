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
import type { RoutingDecision, AgentExecutionContext } from './types';
export type SensitivityCategory = 'api_key' | 'internal_ip' | 'credential_exposure' | 'private_key' | 'pii' | 'config_secret' | 'cloud_credential';
export type PrivacyRoute = 'cloud' | 'local' | 'blocked';
export interface SensitivityMatch {
    category: SensitivityCategory;
    severity: 'low' | 'medium' | 'high' | 'critical';
    pattern: string;
    match: string;
    position: number;
}
export interface PrivacyDecision {
    route: PrivacyRoute;
    reason: string;
    matches: SensitivityMatch[];
    suggestedProvider: 'ollama' | 'vllm' | null;
    suggestedModel: string | null;
    blocked: boolean;
}
export interface PrivacyRouterConfig {
    /** Whether privacy routing is active. Default: true. */
    enabled: boolean;
    /** Minimum severity to trigger local routing. Default: 'medium'. */
    routeThreshold: 'low' | 'medium' | 'high' | 'critical';
    /** Block execution entirely when critical secrets are detected (e.g., live API keys in code). Default: true. */
    blockOnCritical: boolean;
    /** Preferred local provider when rerouting. Default: auto-detect (ollama first, then vllm). */
    preferredLocalProvider?: 'ollama' | 'vllm';
    /** Preferred local model when rerouting. Default: auto-detect from available models. */
    preferredLocalModel?: string;
    /** Whether to log privacy routing decisions to the security audit trail. Default: true. */
    auditLog: boolean;
}
export declare class PrivacyRouter {
    private config;
    private localAvailable;
    private checkedLocal;
    constructor(config?: Partial<PrivacyRouterConfig>);
    /**
     * Check if the provided content contains sensitive data and determine
     * the appropriate routing decision.
     *
     * @param content - The content to scan (agent goal, user prompt, tool args)
     * @param context - Optional execution context for enhanced detection
     */
    checkContent(content: string, context?: {
        agentId?: string;
        runId?: string;
    }): Promise<PrivacyDecision>;
    /**
     * Apply a privacy decision to a routing decision, overriding the model
     * if the decision says to use a local model.
     */
    applyRouting(original: RoutingDecision, decision: PrivacyDecision): RoutingDecision;
    /**
     * Convenience: check content and apply routing in one call.
     */
    routeWithPrivacy(ctx: AgentExecutionContext, originalRoute: RoutingDecision): Promise<{
        routing: RoutingDecision;
        decision: PrivacyDecision;
    }>;
    /**
     * Quick synchronous check: is there any sensitive content?
     * Does NOT check local model availability. For pre-flight use.
     */
    checkSync(content: string): PrivacyDecision;
    /**
     * Scan content against all sensitivity patterns.
     * Zero-cost: pure regex, no LLM calls.
     */
    private detectSensitivePatterns;
    /**
     * Redact sensitive values for safe logging.
     */
    private redact;
    /**
     * Log privacy routing decision to the security audit trail.
     */
    private logPrivacyEvent;
    /**
     * Check if a local model provider is available.
     * Caches the result for the lifetime of the router.
     */
    private getLocalProvider;
}
export declare function getPrivacyRouter(): PrivacyRouter;
export declare function resetPrivacyRouter(): void;
//# sourceMappingURL=privacyRouter.d.ts.map