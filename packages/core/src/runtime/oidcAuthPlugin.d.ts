/**
 * OIDC Authentication Plugin — JWT-based SSO for Commander.
 *
 * Validates OIDC ID tokens (RS256 JWTs) from Okta, Auth0, Google Workspace,
 * or any standard OIDC provider. Maps OIDC claims to Commander AuthRole.
 *
 * Works alongside the existing API key auth (CommanderHttpServer.authenticate).
 * When OIDC is configured, the Authorization: Bearer <token> flow accepts both
 * Commander API keys and OIDC JWTs — the server tries API key auth first,
 * then falls back to OIDC JWT validation.
 *
 * Usage:
 *   const oidc = new OIDCAuthPlugin({
 *     issuer: 'https://your-tenant.okta.com/oauth2/default',
 *     clientId: '0abc123...',
 *     roleClaim: 'commander_role',     // optional, default 'roles'
 *     adminRoles: ['admin', 'commander-admin'],
 *     operatorRoles: ['developer', 'commander-operator'],
 *   });
 *   httpServer.registerAuthPlugin(oidc);
 *
 * Environment variable fallback:
 *   OIDC_ISSUER=https://...
 *   OIDC_CLIENT_ID=...
 *   OIDC_ROLE_CLAIM=commander_role
 */
import type { AuthRole } from './authManager';
/** JWK with optional kid — Node.js types omit it but OIDC requires it */
export interface JWKWithKid extends JsonWebKey {
    kid?: string;
    alg?: string;
    use?: string;
}
export interface OIDCPluginConfig {
    /** OIDC issuer URL (e.g. https://your-tenant.okta.com/oauth2/default) */
    issuer: string;
    /** OIDC client ID (audience claim must match) */
    clientId: string;
    /** JWT claim containing role information (default: 'roles') */
    roleClaim?: string;
    /** Claim values that map to admin role (default: ['admin']) */
    adminRoles?: string[];
    /** Claim values that map to operator role (default: ['operator', 'developer']) */
    operatorRoles?: string[];
    /** JWKS cache TTL in ms (default: 3600000 = 1 hour) */
    jwksCacheTtlMs?: number;
    /** Max clock skew in seconds for JWT validation (default: 60) */
    clockSkewSeconds?: number;
    /** Optional: explicitly trust these JWK keys instead of fetching from JWKS URI */
    trustedJwks?: JWKWithKid[];
    /**
     * Allowed JWT algorithms. Prevents algorithm confusion attacks.
     * Default: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']
     */
    allowedAlgorithms?: string[];
}
export interface AuthPlugin {
    /** Unique name for this plugin */
    readonly name: string;
    /** Authenticate a Bearer token. Returns user info + role on success, null on failure. */
    authenticate(bearerToken: string): Promise<AuthPluginResult | null>;
}
export interface AuthPluginResult {
    /** Stable user identifier from the OIDC provider */
    userId: string;
    /** Human-readable username/email */
    username: string;
    /** Commander role mapped from OIDC claims */
    role: AuthRole;
    /** Optional tenant ID for multi-tenant mapping */
    tenantId?: string;
    /** Raw claims from the JWT (for audit) */
    claims?: Record<string, unknown>;
}
/**
 * Validates OIDC JWTs using JWKS (JSON Web Key Set) from the issuer's
 * well-known endpoint. Supports RS256, RS384, RS512, ES256, ES384, ES512.
 *
 * No external dependencies — uses Node.js built-in crypto for JWT verification.
 */
export declare class OIDCAuthPlugin implements AuthPlugin {
    readonly name = "oidc";
    private config;
    private jwksCache;
    private jwksFetchPromise;
    private static readonly SUPPORTED_ALGORITHMS;
    constructor(config: Partial<OIDCPluginConfig> & {
        issuer: string;
        clientId: string;
    });
    /**
     * Authenticate a Bearer token by validating it as an OIDC JWT.
     * Returns null if the token is not a valid JWT or validation fails.
     */
    authenticate(bearerToken: string): Promise<AuthPluginResult | null>;
    /**
     * Refresh JWKS cache. Useful for testing or forcing cache refresh.
     */
    refreshJWKS(): Promise<void>;
    private findKey;
    private fetchJWKS;
    private fetchJWKSFromIssuer;
    private fetchJWKSFromUrl;
    /**
     * Verify JWT signature using the JWK.
     * Supports RS256, RS384, RS512, ES256, ES384, ES512.
     */
    private verifySignature;
    private jwtAlgToCrypto;
    /**
     * Resolve tenant ID from JWT claims.
     * Override this method to implement custom tenant mapping.
     */
    protected resolveTenant(payload: Record<string, unknown>): string | undefined;
}
/**
 * Create OIDCAuthPlugin from environment variables.
 * Returns null if OIDC_ISSUER or OIDC_CLIENT_ID is not set.
 */
export declare function createOIDCPluginFromEnv(): OIDCAuthPlugin | null;
//# sourceMappingURL=oidcAuthPlugin.d.ts.map