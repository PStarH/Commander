"use strict";
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
exports.OIDCAuthPlugin = void 0;
exports.createOIDCPluginFromEnv = createOIDCPluginFromEnv;
const crypto = __importStar(require("crypto"));
const https = __importStar(require("https"));
const logging_1 = require("../logging");
const securityAuditLogger_1 = require("../security/securityAuditLogger");
// ============================================================================
// OIDC Auth Plugin
// ============================================================================
/**
 * Validates OIDC JWTs using JWKS (JSON Web Key Set) from the issuer's
 * well-known endpoint. Supports RS256, RS384, RS512, ES256, ES384, ES512.
 *
 * No external dependencies — uses Node.js built-in crypto for JWT verification.
 */
class OIDCAuthPlugin {
    constructor(config) {
        this.name = 'oidc';
        this.jwksCache = null;
        this.jwksFetchPromise = null;
        this.config = {
            roleClaim: 'roles',
            adminRoles: ['admin'],
            operatorRoles: ['operator', 'developer'],
            jwksCacheTtlMs: 3600000, // 1 hour
            clockSkewSeconds: 60,
            allowedAlgorithms: OIDCAuthPlugin.SUPPORTED_ALGORITHMS,
            ...config,
        };
    }
    /**
     * Authenticate a Bearer token by validating it as an OIDC JWT.
     * Returns null if the token is not a valid JWT or validation fails.
     */
    async authenticate(bearerToken) {
        var _a, _b, _c, _d;
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        // Parse the JWT
        const parts = bearerToken.split('.');
        if (parts.length !== 3) {
            return null; // Not a JWT
        }
        let header;
        let payload;
        try {
            header = JSON.parse(base64UrlDecode(parts[0]));
            payload = JSON.parse(base64UrlDecode(parts[1]));
        }
        catch {
            return null; // Malformed JWT
        }
        // Validate required claims
        const iss = payload.iss;
        const aud = payload.aud;
        const exp = payload.exp;
        const iat = payload.iat;
        const sub = payload.sub;
        if (!iss || !aud || !exp || !sub) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT missing required claims (iss, aud, exp, sub)', {
                missingClaims: ['iss', 'aud', 'exp', 'sub'].filter((c) => !payload[c]),
            });
            return null;
        }
        // Validate issuer
        if (iss !== this.config.issuer) {
            return null; // Silent fail — not our issuer
        }
        // Validate audience
        const audiences = Array.isArray(aud) ? aud : [aud];
        if (!audiences.includes(this.config.clientId)) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT audience does not match client ID', {
                expected: this.config.clientId,
                actual: audiences,
            });
            return null;
        }
        // Validate expiration with clock skew
        const now = Math.floor(Date.now() / 1000);
        if (exp + ((_a = this.config.clockSkewSeconds) !== null && _a !== void 0 ? _a : 60) < now) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT expired', {
                exp,
                now,
                clockSkew: this.config.clockSkewSeconds,
            });
            return null;
        }
        // Validate not-before with clock skew
        if (iat && iat - ((_b = this.config.clockSkewSeconds) !== null && _b !== void 0 ? _b : 60) > now) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT used before iat', { iat, now });
            return null;
        }
        // Get the key ID from header
        const kid = header.kid;
        const alg = header.alg;
        if (!kid || !alg) {
            return null;
        }
        // Algorithm whitelist: prevent algorithm confusion attacks
        const allowedAlgorithms = (_c = this.config.allowedAlgorithms) !== null && _c !== void 0 ? _c : OIDCAuthPlugin.SUPPORTED_ALGORITHMS;
        if (!allowedAlgorithms.includes(alg)) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT algorithm not in allowlist', {
                alg,
                allowedAlgorithms,
            });
            return null;
        }
        // Fetch JWKS and find matching key
        let jwk;
        try {
            jwk = await this.findKey(kid);
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('OIDCAuthPlugin', 'Failed to fetch JWKS', err);
            return null;
        }
        if (!jwk) {
            audit.logAuthFailure('OIDCAuthPlugin', 'No matching JWK found for key ID', { kid });
            return null;
        }
        // Verify signature
        const signature = base64UrlDecodeToBuffer(parts[2]);
        const data = `${parts[0]}.${parts[1]}`;
        try {
            const verified = this.verifySignature(alg, data, signature, jwk);
            if (!verified) {
                audit.logAuthFailure('OIDCAuthPlugin', 'JWT signature verification failed', { kid, alg });
                return null;
            }
        }
        catch (err) {
            audit.logAuthFailure('OIDCAuthPlugin', 'JWT signature verification threw', {
                kid,
                alg,
                error: err === null || err === void 0 ? void 0 : err.message,
            });
            return null;
        }
        // Map roles from claims
        const roleClaimName = (_d = this.config.roleClaim) !== null && _d !== void 0 ? _d : 'roles';
        const rawRoles = payload[roleClaimName];
        const roles = rawRoles ? (Array.isArray(rawRoles) ? rawRoles : [rawRoles]) : [];
        let role = 'viewer'; // default
        if (roles.some((r) => { var _a; return (_a = this.config.adminRoles) === null || _a === void 0 ? void 0 : _a.includes(r); })) {
            role = 'admin';
        }
        else if (roles.some((r) => { var _a; return (_a = this.config.operatorRoles) === null || _a === void 0 ? void 0 : _a.includes(r); })) {
            role = 'operator';
        }
        // Extract tenant mapping (optional — from claim or sub issuer)
        const tenantId = this.resolveTenant(payload);
        audit.logAuthSuccess('OIDCAuthPlugin', `OIDC user authenticated: ${payload.sub}`, {
            sub: payload.sub,
            issuer: iss,
            role,
            tenantId,
        });
        return {
            userId: payload.sub,
            username: payload.email ||
                payload.preferred_username ||
                payload.sub,
            role,
            tenantId,
            claims: payload,
        };
    }
    /**
     * Refresh JWKS cache. Useful for testing or forcing cache refresh.
     */
    async refreshJWKS() {
        this.jwksCache = null;
        this.jwksFetchPromise = null;
        await this.fetchJWKS();
    }
    // ── Private ──────────────────────────────────────────────────────
    async findKey(kid) {
        var _a;
        // Check cache
        if (this.jwksCache) {
            const age = Date.now() - this.jwksCache.fetchedAt;
            if (age < ((_a = this.config.jwksCacheTtlMs) !== null && _a !== void 0 ? _a : 3600000)) {
                return this.jwksCache.keys.find((k) => k.kid === kid);
            }
        }
        // Fetch fresh JWKS
        const keys = await this.fetchJWKS();
        return keys.find((k) => k.kid === kid);
    }
    async fetchJWKS() {
        // Deduplicate concurrent fetches
        if (this.jwksFetchPromise) {
            return this.jwksFetchPromise;
        }
        // Use trusted keys if provided (no network call)
        if (this.config.trustedJwks && this.config.trustedJwks.length > 0) {
            this.jwksCache = { keys: this.config.trustedJwks, fetchedAt: Date.now() };
            return this.config.trustedJwks;
        }
        this.jwksFetchPromise = this.fetchJWKSFromIssuer();
        try {
            const keys = await this.jwksFetchPromise;
            this.jwksCache = { keys, fetchedAt: Date.now() };
            return keys;
        }
        finally {
            this.jwksFetchPromise = null;
        }
    }
    fetchJWKSFromIssuer() {
        return new Promise((resolve, reject) => {
            const issuer = this.config.issuer.replace(/\/$/, '');
            const jwksUri = `${issuer}/.well-known/openid-configuration`;
            // First fetch OIDC discovery document to get jwks_uri
            https
                .get(jwksUri, { timeout: 10000 }, (discoveryRes) => {
                let body = '';
                discoveryRes.on('data', (chunk) => {
                    body += chunk;
                });
                discoveryRes.on('end', () => {
                    if (discoveryRes.statusCode !== 200) {
                        // Fallback: try common JWKS URI
                        this.fetchJWKSFromUrl(`${issuer}/.well-known/jwks.json`).then(resolve).catch(reject);
                        return;
                    }
                    try {
                        const discovery = JSON.parse(body);
                        const jwksUrl = discovery.jwks_uri;
                        if (!jwksUrl) {
                            reject(new Error('No jwks_uri in OIDC discovery document'));
                            return;
                        }
                        this.fetchJWKSFromUrl(jwksUrl).then(resolve).catch(reject);
                    }
                    catch {
                        reject(new Error('Failed to parse OIDC discovery document'));
                    }
                });
            })
                .on('error', reject)
                .on('timeout', function () {
                this.destroy();
                reject(new Error('OIDC discovery timeout'));
            });
        });
    }
    fetchJWKSFromUrl(url) {
        return new Promise((resolve, reject) => {
            https
                .get(url, { timeout: 10000 }, (res) => {
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`JWKS fetch failed: ${res.statusCode}`));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(body);
                        const keys = parsed.keys;
                        if (!keys || !Array.isArray(keys)) {
                            reject(new Error('Invalid JWKS response'));
                            return;
                        }
                        resolve(keys);
                    }
                    catch {
                        reject(new Error('Failed to parse JWKS response'));
                    }
                });
            })
                .on('error', reject)
                .on('timeout', function () {
                this.destroy();
                reject(new Error('JWKS fetch timeout'));
            });
        });
    }
    /**
     * Verify JWT signature using the JWK.
     * Supports RS256, RS384, RS512, ES256, ES384, ES512.
     */
    verifySignature(alg, data, signature, jwk) {
        // Import the JWK as a public key
        const keyObject = crypto.createPublicKey({
            key: jwk,
            format: 'jwk',
        });
        // Map JWT algorithm to crypto algorithm name
        const cryptoAlg = this.jwtAlgToCrypto(alg);
        if (!cryptoAlg) {
            throw new Error(`Unsupported algorithm: ${alg}`);
        }
        return crypto.verify(cryptoAlg, Buffer.from(data, 'utf-8'), keyObject, signature);
    }
    jwtAlgToCrypto(alg) {
        switch (alg) {
            case 'RS256':
                return 'sha256';
            case 'RS384':
                return 'sha384';
            case 'RS512':
                return 'sha512';
            case 'ES256':
                return 'sha256';
            case 'ES384':
                return 'sha384';
            case 'ES512':
                return 'sha512';
            default:
                return null;
        }
    }
    /**
     * Resolve tenant ID from JWT claims.
     * Override this method to implement custom tenant mapping.
     */
    resolveTenant(payload) {
        // Check for a custom tenant claim
        const tenantClaim = payload.tenant_id;
        if (tenantClaim)
            return tenantClaim;
        // Check the issuer URL for tenant hints (Okta: {tenant}.okta.com)
        const iss = payload.iss;
        if (iss) {
            const match = iss.match(/https:\/\/([^.]+)\.okta\.com/);
            if (match)
                return match[1];
        }
        return undefined;
    }
}
exports.OIDCAuthPlugin = OIDCAuthPlugin;
OIDCAuthPlugin.SUPPORTED_ALGORITHMS = [
    'RS256',
    'RS384',
    'RS512',
    'ES256',
    'ES384',
    'ES512',
];
// ============================================================================
// Base64 URL decoding (no external dependencies)
// ============================================================================
function base64UrlDecode(input) {
    // Replace URL-safe characters and add padding
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0)
        base64 += '=';
    return Buffer.from(base64, 'base64').toString('utf-8');
}
/** Base64URL decode returning a Buffer (for JWT signature verification). */
function base64UrlDecodeToBuffer(input) {
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0)
        base64 += '=';
    return Buffer.from(base64, 'base64');
}
// ============================================================================
// Helper: create from env vars
// ============================================================================
/**
 * Create OIDCAuthPlugin from environment variables.
 * Returns null if OIDC_ISSUER or OIDC_CLIENT_ID is not set.
 */
function createOIDCPluginFromEnv() {
    var _a, _b, _c, _d, _e;
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuer || !clientId)
        return null;
    return new OIDCAuthPlugin({
        issuer,
        clientId,
        roleClaim: (_a = process.env.OIDC_ROLE_CLAIM) !== null && _a !== void 0 ? _a : 'roles',
        adminRoles: ((_c = (_b = process.env.OIDC_ADMIN_ROLES) === null || _b === void 0 ? void 0 : _b.split(',')) !== null && _c !== void 0 ? _c : ['admin']).map((s) => s.trim()),
        operatorRoles: ((_e = (_d = process.env.OIDC_OPERATOR_ROLES) === null || _d === void 0 ? void 0 : _d.split(',')) !== null && _e !== void 0 ? _e : ['operator', 'developer']).map((s) => s.trim()),
    });
}
