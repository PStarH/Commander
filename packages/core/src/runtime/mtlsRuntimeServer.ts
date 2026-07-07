/**
 * MtlsRuntimeServer — exposes an AgentRuntime over mutually-authenticated TLS.
 *
 * This closes the P0 gap "mTLS for inter-process traffic (HTTP server → AgentRuntime)"
 * by allowing the Commander HTTP server to live in a separate process from the
 * AgentRuntime execution engine. All traffic is carried over HTTPS with
 * requestCert + rejectUnauthorized, providing channel binding and preventing
 * MITM / unauthorized process access even if the internal network is reached.
 *
 * Protocol: JSON-RPC-like POST /rpc with body { method, args }.
 * Only methods declared on the allowlist are dispatched.
 */
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { getGlobalLogger } from '../logging';

export interface MtlsRuntimeServerConfig {
  port: number;
  host: string;
  /** PEM-encoded server certificate (content or file path) */
  cert: string;
  /** PEM-encoded server private key (content or file path) */
  key: string;
  /** PEM-encoded CA bundle for verifying client certificates */
  ca: string;
  /** Max JSON body size in bytes. Default: 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_CONFIG: Partial<MtlsRuntimeServerConfig> = {
  maxBodyBytes: 1024 * 1024,
};

/**
 * Methods allowed to be invoked over the mTLS RPC boundary.
 * We explicitly exclude subsystem accessors that return non-serializable
 * objects (e.g. MemoryStore, StateCheckpointer) and registration methods that
 * accept non-serializable implementations (LLMProvider, Tool).
 */
const ALLOWED_METHODS = new Set([
  'execute',
  'getConfig',
  'cancelAllSteps',
  'listUnfinishedRuns',
  'resume',
  'listResumableRuns',
  'pauseRun',
  'unpauseRun',
  'isPaused',
  'getActiveRuns',
  'getActiveRunCount',
  'isRunActive',
  'getSemanticCacheStats',
  'getSingleFlightStats',
  'getGeminiCacheStats',
  'getCostEstimatorHistory',
  'getProviderHealth',
  'listToolNames',
  'dispose',
]);

export class MtlsRuntimeServer {
  private runtime: AgentRuntimeInterface;
  private config: MtlsRuntimeServerConfig;
  private server: ReturnType<typeof createHttpsServer> | null = null;
  private logger = getGlobalLogger();

  constructor(runtime: AgentRuntimeInterface, config: MtlsRuntimeServerConfig) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    const tlsOpts: ServerOptions = {
      cert: maybeReadFile(this.config.cert),
      key: maybeReadFile(this.config.key),
      ca: maybeReadFile(this.config.ca),
      requestCert: true,
      rejectUnauthorized: true,
    };

    this.server = createHttpsServer(tlsOpts, (req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        this.logger.info(
          'MtlsRuntimeServer',
          `mTLS runtime server listening on ${this.config.host}:${this.config.port}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  getPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const body = await parseBody(req, this.config.maxBodyBytes ?? 1024 * 1024);
      const payload = body as { method?: unknown; args?: unknown };
      const method = typeof payload.method === 'string' ? payload.method : '';
      const args = Array.isArray(payload.args) ? payload.args : [];

      if (!ALLOWED_METHODS.has(method)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Method not allowed over mTLS RPC: ${method}` }));
        return;
      }

      // Wide-cast to Record<string, unknown> for reflect-style dispatch.
      // The ALLOWED_METHODS set above is the security gate: only the 19
      // methods enumerated there are reachable through this RPC, and the
      // excluded list (registerProvider/registerTool/MemoryStore/get*)
      // makes non-serializable accessors unreachable from this boundary.
      const fn = (this.runtime as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Runtime does not implement ${method}` }));
        return;
      }

      const result = await (fn as (...a: unknown[]) => unknown).apply(this.runtime, args);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('MtlsRuntimeServer', 'mTLS RPC error', { error: msg });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  }
}

function parseBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        rejected = true;
        body = '';
        reject(new Error(`Request body too large. Limit is ${maxBytes} bytes.`));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function maybeReadFile(s: string): string {
  if (s.startsWith('-----BEGIN')) return s;
  return readFileSync(s, 'utf8');
}
