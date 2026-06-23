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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Known LLM Provider → API Domain mapping
// ============================================================================

interface ProviderDomainEntry {
  /** Env var that, if set, enables this provider's domain */
  envVar: string;
  /** The default API domain for this provider */
  defaultDomain: string;
  /** Optional custom base URL env var that overrides the default domain */
  baseUrlEnv?: string;
}

const PROVIDER_DOMAINS: ProviderDomainEntry[] = [
  { envVar: 'OPENAI_API_KEY', defaultDomain: 'api.openai.com', baseUrlEnv: 'OPENAI_BASE_URL' },
  {
    envVar: 'ANTHROPIC_API_KEY',
    defaultDomain: 'api.anthropic.com',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
  },
  {
    envVar: 'DEEPSEEK_API_KEY',
    defaultDomain: 'api.deepseek.com',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
  },
  { envVar: 'GROQ_API_KEY', defaultDomain: 'api.groq.com', baseUrlEnv: 'GROQ_BASE_URL' },
  {
    envVar: 'TOGETHER_API_KEY',
    defaultDomain: 'api.together.xyz',
    baseUrlEnv: 'TOGETHER_BASE_URL',
  },
  {
    envVar: 'PERPLEXITY_API_KEY',
    defaultDomain: 'api.perplexity.ai',
    baseUrlEnv: 'PERPLEXITY_BASE_URL',
  },
  {
    envVar: 'FIREWORKS_API_KEY',
    defaultDomain: 'api.fireworks.ai',
    baseUrlEnv: 'FIREWORKS_BASE_URL',
  },
  { envVar: 'MISTRAL_API_KEY', defaultDomain: 'api.mistral.ai', baseUrlEnv: 'MISTRAL_BASE_URL' },
  { envVar: 'CO_API_KEY', defaultDomain: 'api.cohere.ai' },
  {
    envVar: 'OPENROUTER_API_KEY',
    defaultDomain: 'openrouter.ai',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
  },
  { envVar: 'REPLICATE_API_TOKEN', defaultDomain: 'api.replicate.com' },
  { envVar: 'MIMO_API_KEY', defaultDomain: 'api.mimo.ai' },
  { envVar: 'XAI_API_KEY', defaultDomain: 'api.x.ai' },
  { envVar: 'ANYSCALE_API_KEY', defaultDomain: 'api.anyscale.com' },
  { envVar: 'DEEPINFRA_API_KEY', defaultDomain: 'api.deepinfra.com' },
  { envVar: 'ZHIPU_API_KEY', defaultDomain: 'open.bigmodel.cn' },
  { envVar: 'XIAOMI_API_KEY', defaultDomain: 'api.minimax.chat' },
  { envVar: 'GOOGLE_API_KEY', defaultDomain: 'generativelanguage.googleapis.com' },
  { envVar: 'AWS_ACCESS_KEY_ID', defaultDomain: 'bedrock-runtime.us-east-1.amazonaws.com' },
];

// ============================================================================
// Domain auto-detection
// ============================================================================

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
export function getLLMAPIDomains(): string[] {
  const domains = new Set<string>();

  // Phase 1: Default domains for configured providers
  for (const entry of PROVIDER_DOMAINS) {
    if (process.env[entry.envVar]) {
      // Check for custom base URL override
      if (entry.baseUrlEnv && process.env[entry.baseUrlEnv]) {
        try {
          const host = new URL(process.env[entry.baseUrlEnv]!).hostname;
          if (host) domains.add(host.toLowerCase());
          continue; // Skip default domain since we have a custom one
        } catch {
          // Invalid URL — fall through to default domain
        }
      }
      domains.add(entry.defaultDomain);
    }
  }

  // Phase 2: Also check base URL env vars for providers that might use
  // custom endpoints without the standard API key env var
  const baseUrlOnlyEnvs = ['VLLM_BASE_URL'];
  for (const envVar of baseUrlOnlyEnvs) {
    const url = process.env[envVar];
    if (url) {
      try {
        const host = new URL(url).hostname;
        if (host) domains.add(host.toLowerCase());
      } catch {
        // Ignore invalid URLs
      }
    }
  }

  // Phase 3: OLLAMA_HOST (special case — can be host:port or full URL)
  if (process.env.OLLAMA_HOST) {
    let hostStr = process.env.OLLAMA_HOST;
    // Strip protocol if present
    if (hostStr.startsWith('http://') || hostStr.startsWith('https://')) {
      try {
        hostStr = new URL(hostStr).host;
      } catch {
        /* keep original */
      }
    }
    // Strip port
    const hostOnly = hostStr.split(':')[0];
    if (hostOnly && hostOnly !== 'localhost' && hostOnly !== '127.0.0.1') {
      domains.add(hostOnly.toLowerCase());
    }
  }

  return [...domains].sort();
}

// ============================================================================
// Proxy script generation
// ============================================================================

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
export function generateProxyScript(allowDomains: string): string {
  // Sanitize: ensure domains are safe to embed in JS string
  const sanitized = allowDomains
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0 && /^[a-z0-9._-]+$/.test(d))
    .join(',');

  return `
// Network Proxy — domain allowlist gate
// Generated by Commander. Only allows specified LLM API domains.
const http = require('http');
const net = require('net');

const ALLOWLIST = new Set((${JSON.stringify(sanitized)} || '').split(',').map(d => d.trim()).filter(Boolean));
const PORT = 1999;
const HOST = '127.0.0.1';

const server = http.createServer();

// Handle CONNECT (HTTPS) requests
server.on('connect', (req, clientSocket, head) => {
  const hostPort = req.url || '';
  const colonIdx = hostPort.lastIndexOf(':');
  const host = colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
  const port = colonIdx >= 0 ? parseInt(hostPort.slice(colonIdx + 1)) || 443 : 443;
  const hostLower = host.toLowerCase();

  if (!ALLOWLIST.has(hostLower)) {
    const msg = JSON.stringify({ error: 'domain_blocked', host: hostLower, policy: 'sandbox_network_allowlist' });
    clientSocket.write('HTTP/1.1 403 Forbidden\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(msg) + '\\r\\n\\r\\n' + msg);
    clientSocket.end();
    return;
  }

  const serverSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', () => { try { clientSocket.end(); } catch {} });
  clientSocket.on('error', () => { try { serverSocket.end(); } catch {} });
});

// Handle plain HTTP requests (block — we only allow CONNECT)
server.on('request', (req, res) => {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'http_not_allowed', detail: 'Only HTTPS CONNECT is allowed through sandbox proxy' }));
});

server.listen(PORT, HOST, () => {
  // Signal readiness by writing to a known fd (used by the launcher)
  if (process.send) process.send('ready');
});
`;
}

// ============================================================================
// Proxy lifecycle management
// ============================================================================

const PROXY_PORT = 1999;

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
export function writeProxyScript(allowDomains: string[]): string {
  const domains = allowDomains.length > 0 ? allowDomains : getLLMAPIDomains();
  const script = generateProxyScript(domains.join(','));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-proxy-'));
  const scriptPath = path.join(tmpDir, 'proxy.js');
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return scriptPath;
}

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
export function shquote(s: string): string {
  if (/^[a-zA-Z0-9_/.:=,@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function wrapCommandWithProxy(
  command: string,
  scriptPath: string = '/proxy.js',
  proxyPort: number = PROXY_PORT,
): string {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  // Wrap the user command with sh -c and proper quoting so shell
  // metacharacters cannot break out of the proxy wrapper.
  return [
    `node ${scriptPath} &`,
    `PROXY_PID=$!`,
    `sleep 0.3`,
    `export HTTP_PROXY=${proxyUrl}`,
    `export HTTPS_PROXY=${proxyUrl}`,
    `export NO_PROXY=''`,
    `sh -c ${shquote(command)}`,
    `EXIT_CODE=$?`,
    `kill $PROXY_PID 2>/dev/null`,
    `exit $EXIT_CODE`,
  ].join('; ');
}
