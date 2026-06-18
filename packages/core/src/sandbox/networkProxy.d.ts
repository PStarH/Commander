/**
 * NetworkProxy — HTTP CONNECT proxy with domain allowlist for sandbox network isolation.
 *
 * Architecture:
 *   Agent Container
 *     ├── HTTP_PROXY=http://127.0.0.1:1999
 *     ├── HTTPS_PROXY=http://127.0.0.1:1999
 *     │
 *     └── Network Proxy (localhost:1999)
 *         ├── api.openai.com:443     → CONNECT → 放行
 *         ├── api.anthropic.com:443  → CONNECT → 放行
 *         ├── internal.corp:8080     → CONNECT → 403 Forbidden
 *         └── 任意域名:80            → CONNECT → 403 Forbidden
 *
 * The proxy script runs INSIDE the Docker container. It's mounted as a volume
 * and started as a background process before the actual command executes.
 *
 * Domain allowlist is auto-derived from the LLM provider environment variables
 * the user already configured — zero additional configuration.
 */
/**
 * Auto-detect LLM API domains from the environment variables the user has set.
 * Returns a deduplicated list of domain hostnames.
 *
 * Logic:
 * 1. For each provider whose API key env var is set, add its default domain.
 * 2. If the provider also has a custom base URL env var, parse the host from
 *    that URL and use it INSTEAD of the default (covers self-hosted proxies).
 * 3. Special cases: OLLAMA_HOST, VLLM_BASE_URL (user-specified endpoints).
 * 4. PLUS: always include the defaults for providers the user hasn't configured,
 *    in case the user sets the key at runtime via the tool rather than env vars.
 *    (This is a reasonable default since an unset key means no API calls anyway.)
 */
export declare function getLLMAPIDomains(): string[];
/**
 * Generate the JavaScript source code for the HTTP CONNECT proxy.
 * This script runs INSIDE the Docker container.
 *
 * The proxy:
 * 1. Listens on 127.0.0.1:1999 for HTTP CONNECT requests
 * 2. Validates the target host against the allowlist
 * 3. Creates a TCP tunnel for allowed hosts, returns 403 for denied ones
 * 4. Also handles regular HTTP requests (returns 403 unless HTTP CONNECT)
 *
 * @param allowDomains — comma-separated list of allowed domains
 * @returns JavaScript source code as a string
 */
export declare function generateProxyScript(allowDomains: string): string;
/** Configuration for starting a network proxy sandbox */
export interface ProxySandboxConfig {
    /** List of allowed domain hostnames */
    allowDomains: string[];
    /** Port for the proxy server (default: 1999) */
    proxyPort?: number;
}
/**
 * Write the proxy script to a temporary file and return the file path.
 * The caller is responsible for cleanup.
 *
 * @returns Path to the proxy script file
 */
export declare function writeProxyScript(allowDomains: string[]): string;
/**
 * Build the wrapped shell command that starts the proxy before the actual command.
 * Used by the Docker sandbox backend to ensure the proxy is running before
 * any tool executes.
 *
 * @param scriptPath — path to proxy.js inside the container (e.g. /proxy.js)
 * @param command — the actual command to run
 * @param proxyPort — proxy listen port
 * @returns Wrapped shell command string
 */
export declare function wrapCommandWithProxy(command: string, scriptPath?: string, proxyPort?: number): string;
//# sourceMappingURL=networkProxy.d.ts.map