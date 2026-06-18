import { type ServerOptions as HttpsServerOptions } from 'https';
import type { Tool } from './types';
import type { AuthPlugin } from './oidcAuthPlugin';
import type { SIEMForwarder } from './siemForwarder';
export interface HttpServerConfig {
    port: number;
    host: string;
    cors: boolean;
    /** Allowed CORS origins. Use ['*'] only for trusted internal/dev deployments. */
    corsAllowedOrigins: string[];
    /** Maximum JSON request body size in bytes. Default: 1 MiB. */
    maxBodyBytes: number;
    /** Optional TLS options. When set, Commander serves HTTPS directly. */
    https?: HttpsServerOptions;
    /** API key for Bearer auth. If undefined, a random key is generated at startup. Set to '' to explicitly disable auth (NOT recommended). */
    apiKey?: string;
    /** SHA-256 hash of the API key. Prefer this over apiKey in production config. */
    apiKeyHash?: string;
    /** Max requests per minute per IP. 0 = no limit. Default: 120 */
    rateLimitPerMinute: number;
    /** Optional mapping of API key → tenant ID for multi-tenant deployments.
     *  Raw keys are hashed at startup and then discarded. Prefer tenantApiKeyHashes in production config. */
    tenantApiKeys?: Record<string, string>;
    /** Optional mapping of SHA-256 API key hash → tenant ID for multi-tenant deployments. */
    tenantApiKeyHashes?: Record<string, string>;
    /** OIDC authentication plugin config (loaded from env if available) */
    oidcEnabled?: boolean;
    /** SIEM forwarder instance for log forwarding (loaded from env if available) */
    siemForwarder?: SIEMForwarder;
}
export declare class CommanderHttpServer {
    private config;
    private server;
    private runtimes;
    private bus;
    private mcpServer;
    private rateLimitMap;
    private static readonly SESSION_TTL_MS;
    private static readonly MAX_SESSIONS;
    private sessionCleanupTimer;
    private connections;
    private isShuttingDown;
    private authDisabled;
    private apiKeyHash;
    private tenantApiKeyHashes;
    private authPlugins;
    private siemForwarder;
    private securityEventUnsub;
    constructor(config?: Partial<HttpServerConfig>);
    private initializeAuth;
    start(): Promise<void>;
    /** Return the port the server is actually listening on (useful when port=0). */
    getPort(): number;
    private evictStaleSessions;
    stop(forceTimeoutMs?: number): Promise<void>;
    private handleRequest;
    private applyCommonHeaders;
    private getRequestId;
    private handleApiRequest;
    private handleStreamRequest;
    private handleCompensationStreamRequest;
    private handleSOPStreamRequest;
    private handleCostStreamRequest;
    /**
     * Register Commander tools as MCP tools on an internal MCPServer.
     * External clients can call these tools via POST /api/v1/mcp with JSON-RPC 2.0 requests.
     */
    registerMCPServer(name: string, tools: Map<string, Tool>): void;
    private handleMCPRequest;
    /**
     * Register an authentication plugin (e.g. OIDC, SAML).
     * Plugins are tried after the built-in API key auth.
     */
    registerAuthPlugin(plugin: AuthPlugin): void;
    /**
     * Register a SIEM forwarder for security log forwarding.
     * Wire security audit events from the bus to the forwarder.
     */
    registerSIEMForwarder(forwarder: SIEMForwarder): void;
    /** Resolve tenant ID from the Authorization header using configured API key mapping. */
    private resolveTenantFromAuth;
    private checkRateLimit;
    private getDefaultProvider;
}
export declare function createHttpServer(config?: Partial<HttpServerConfig>): CommanderHttpServer;
//# sourceMappingURL=httpServer.d.ts.map