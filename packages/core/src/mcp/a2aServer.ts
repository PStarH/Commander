/**
 * A2AServer — Agent-to-Agent protocol HTTP server.
 *
 * Serves an Agent Card at /.well-known/agent-card.json and handles
 * A2A JSON-RPC methods: message/send, tasks/get, tasks/list, tasks/cancel.
 *
 * Flow:
 *   Remote Agent → HTTP POST / → A2A JSON-RPC → A2AServer → AgentRuntimeInterface → Response
 */
/**
 * SECURITY LIMITATION (Devil Detail A): Node.js only verifies the client
 * certificate during the TLS handshake. Once an HTTP Keep-Alive connection
 * is established, certificate revocation (CRL/OCSP) does NOT affect the
 * live socket — the client can keep sending requests until the socket
 * closes. For high-sensitivity sessions, combine mTLS with the mandatory
 * bearer authToken (defense-in-depth) and consider a shorter
 * shutdownTimeoutMs or disabling Keep-Alive at the reverse-proxy layer.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, ServerOptions as HttpsServerOptions } from 'node:https';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import type { AgentRuntimeInterface } from '../runtime';
import type {
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2ASendMessageParams,
  A2ATaskQueryParams,
  A2AListTasksParams,
  A2AListTasksResult,
  A2ATaskIdParams,
} from './a2aCompliance';
import {
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  A2A_ERROR,
  A2A_METHODS,
  A2A_TERMINAL_STATES,
} from './a2aCompliance';
import { getGlobalLogger } from '../logging';
import { createContentScanner } from '../contentScanner';
import { getEnterpriseSecurityGateway } from '../security/enterpriseSecurityGateway';

// ============================================================================
// Server Configuration
// ============================================================================

export interface A2AServerConfig {
  port: number;
  host: string;
  agentCard: A2AAgentCard;
  /** JSON-RPC endpoint path (default: /) */
  endpoint?: string;
  /** Graceful shutdown timeout in ms (default: 5000) */
  shutdownTimeoutMs?: number;
  /** Max time in ms to wait for a task to complete (default: 120000). 0 = no limit. */
  taskTimeoutMs?: number;
  /** Allowed CORS origins. Empty means no browser origins are allowed. */
  corsAllowedOrigins?: string[];
  /** Maximum JSON request body size in bytes. Default: 1 MiB. */
  maxBodyBytes?: number;
  /** Required bearer token for authenticating non-GET (JSON-RPC) requests.
   * POST requests must include `Authorization: Bearer <token>`.
   * Security: Per OWASP — authentication is mandatory for A2A servers to
   * prevent agentjacking (unauthorized agents joining the swarm). */
  authToken: string;
  /** Optional mTLS / TLS configuration. When omitted, server runs plain HTTP
   * (development only; production deployments MUST supply tls). */
  tls?: {
    /** PEM-encoded server certificate (content or file path) */
    cert: string;
    /** PEM-encoded server private key (content or file path) */
    key: string;
    /** PEM-encoded CA bundle for verifying client certificates.
     * Required when requestCert is true. */
    ca?: string;
    /** If true, server requests client certificate (enables mTLS). */
    requestCert: boolean;
    /** If true, rejects clients without a valid verified certificate. */
    rejectUnauthorized: boolean;
  };
}

const DEFAULT_CONFIG: Partial<A2AServerConfig> = {
  endpoint: '/',
  shutdownTimeoutMs: 5000,
  taskTimeoutMs: 120000,
  corsAllowedOrigins: [],
  maxBodyBytes: 1024 * 1024,
};

// ============================================================================
// A2AServer
// ============================================================================

export class A2AServer {
  private config: A2AServerConfig;
  private runtime: AgentRuntimeInterface;
  private server: ReturnType<typeof createHttpServer> | null = null;
  private tasks: Map<string, A2ATask> = new Map();
  private connections: Set<import('net').Socket> = new Set();
  private logger = getGlobalLogger();
  private nextTaskId = 1;
  private static readonly MAX_TASKS = 500;

  constructor(config: A2AServerConfig, runtime: AgentRuntimeInterface) {
    // SECURITY: A2A server authentication is mandatory. Anonymous A2A endpoints
    // allow any remote agent to submit tasks to the local runtime.
    if (!config.authToken || config.authToken.length < 16) {
      throw new Error('A2AServer requires an authToken of at least 16 characters.');
    }
    this.config = { ...DEFAULT_CONFIG, ...config } as A2AServerConfig;
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
        const socket = req.socket;
        this.connections.add(socket);
        res.on('finish', () => {
          this.connections.delete(socket);
        });
        this.handleRequest(req, res);
      };

      if (this.config.tls) {
        // Fail-closed: requestCert=true requires ca for client cert verification
        if (this.config.tls.requestCert && !this.config.tls.ca) {
          throw new Error(
            'A2AServer tls.requestCert=true requires tls.ca for client cert verification.',
          );
        }
        const tlsOpts: HttpsServerOptions = {
          cert: maybeReadFile(this.config.tls.cert),
          key: maybeReadFile(this.config.tls.key),
          requestCert: this.config.tls.requestCert,
          rejectUnauthorized: this.config.tls.rejectUnauthorized,
        };
        if (this.config.tls.ca) {
          tlsOpts.ca = maybeReadFile(this.config.tls.ca);
        }
        this.server = createHttpsServer(tlsOpts, requestHandler);
        this.logger.info('A2AServer', 'A2A server starting with mTLS enabled');
      } else {
        this.server = createHttpServer(requestHandler);
      }

      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info(
          'A2AServer',
          `A2A server listening on ${this.config.host}:${this.config.port}`,
        );
        resolve();
      });
    });
  }

  getPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.port;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.connections.clear();
        resolve();
      });
      const remaining = this.connections.size;
      if (remaining > 0) {
        setTimeout(() => {
          for (const socket of this.connections) socket.destroy();
          this.connections.clear();
        }, this.config.shutdownTimeoutMs).unref();
      }
    });
  }

  getTaskCount(): number {
    return this.tasks.size;
  }

  // ========================================================================
  // Request Handling
  // ========================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCommonHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const [pathPart] = url.split('?');

    if (pathPart === AGENT_CARD_WELL_KNOWN_PATH && req.method === 'GET') {
      this.sendJson(res, 200, this.config.agentCard);
      return;
    }

    const a2aVersion = req.headers[A2A_VERSION_HEADER.toLowerCase()];
    if (a2aVersion && a2aVersion !== A2A_PROTOCOL_VERSION) {
      this.sendJson(
        res,
        400,
        this.makeErrorResponse(null, -32004, `Unsupported A2A version: ${a2aVersion}`),
      );
      return;
    }

    if (pathPart === this.config.endpoint && req.method === 'POST') {
      // Security: Authentication is mandatory for all JSON-RPC requests.
      // Per OWASP — never allow unauthenticated A2A access to prevent agentjacking.
      if (!this.config.authToken) {
        this.sendJson(
          res,
          500,
          this.makeErrorResponse(
            null,
            -32005,
            'A2A server authToken is not configured. Refusing unauthenticated requests.',
          ),
        );
        return;
      }
      const providedAuth = req.headers['authorization'] ?? '';
      const expectedAuth = `Bearer ${this.config.authToken}`;
      const providedBuf = Buffer.from(providedAuth);
      const expectedBuf = Buffer.from(expectedAuth);
      // Length check before timingSafeEqual to avoid RangeError, then
      // timing-safe comparison to prevent timing attacks.
      if (
        providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      try {
        const body = await this.parseBody(req);
        const response = await this.handleJsonRpc(body as A2AJsonRpcRequest);
        this.sendJson(res, response.error ? 400 : 200, response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes('Request body too large') ? 413 : 500;
        this.sendJson(res, status, this.makeErrorResponse(null, -32603, `Internal error: ${msg}`));
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private async handleJsonRpc(request: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse> {
    const { jsonrpc, id, method, params } = request;

    if (jsonrpc !== '2.0') {
      return this.makeErrorResponse(id, -32600, 'Invalid JSON-RPC: must use "2.0"');
    }

    try {
      switch (method) {
        case A2A_METHODS.SEND_MESSAGE:
          return this.makeSuccessResponse(
            id,
            await this.handleSendMessage(params as A2ASendMessageParams),
          );

        case A2A_METHODS.SEND_MESSAGE_STREAM:
          return this.makeSuccessResponse(id, {
            warning: 'Streaming not supported, use message/send',
          });

        case A2A_METHODS.GET_TASK:
          return this.makeSuccessResponse(
            id,
            await this.handleGetTask(params as A2ATaskQueryParams),
          );

        case A2A_METHODS.LIST_TASKS:
          return this.makeSuccessResponse(
            id,
            await this.handleListTasks(params as A2AListTasksParams),
          );

        case A2A_METHODS.CANCEL_TASK:
          return this.makeSuccessResponse(
            id,
            await this.handleCancelTask(params as A2ATaskIdParams),
          );

        case A2A_METHODS.GET_AGENT_CARD:
          return this.makeSuccessResponse(id, this.config.agentCard);

        default:
          return this.makeErrorResponse(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (err instanceof A2AError) {
        return this.makeErrorResponse(id, err.code, err.message, err.data);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.makeErrorResponse(id, -32603, `Internal error: ${msg}`);
    }
  }

  // ========================================================================
  // A2A Method Handlers
  // ========================================================================

  private async handleSendMessage(params: A2ASendMessageParams): Promise<A2ATask> {
    const { message, configuration } = params;
    const returnImmediately = configuration?.returnImmediately === true;

    const taskId = `a2a_${crypto.randomUUID()}`;
    const contextId = message.contextId ?? `ctx_${taskId}`;

    const task: A2ATask = {
      id: taskId,
      contextId,
      status: { state: 'SUBMITTED', timestamp: new Date().toISOString() },
      history: [message],
      metadata: { receivedAt: new Date().toISOString() },
    };

    this.pruneCompletedTasks();
    this.tasks.set(taskId, task);
    this.updateTaskState(taskId, 'WORKING');
    this.logger.info('A2AServer', `Task ${taskId} submitted`);

    const userMessage = message.parts
      .map((p) => {
        if (p.type === 'text') return p.text;
        if (p.type === 'data') return JSON.stringify(p.data);
        return '';
      })
      .filter(Boolean)
      .join('\n');

    // SECURITY: scan inbound A2A message for injection / exfiltration patterns
    // before it becomes the agent's goal. Remote agents are untrusted input sources.
    let blockedReason: string | undefined;
    try {
      const scanner = createContentScanner();
      const scan = await scanner.scan(userMessage);
      if (!scan.isSafe) {
        blockedReason =
          scan.threats.map((t) => t.type).join(', ') || 'A2A content policy violation';
      }
      const gateway = getEnterpriseSecurityGateway();
      const inputCheck = gateway.preLLMCheck({
        model: 'a2a-inbound',
        estimatedTokens: userMessage.length / 4,
        source: 'a2a-server',
        input: userMessage,
      });
      if (!inputCheck.allowed) {
        blockedReason = inputCheck.reason ?? 'A2A security gateway violation';
      }
    } catch (err) {
      getGlobalLogger().warn('A2AServer', 'Inbound message scan failed', {
        error: (err as Error)?.message,
        taskId,
      });
    }

    if (blockedReason) {
      this.updateTaskState(taskId, 'FAILED', blockedReason);
      return this.tasks.get(taskId)!;
    }

    // SECURITY: A2A-triggered runs must not use the full tool set. Restrict to
    // a safe, read-only subset and explicitly forbid shell/code execution.
    const A2A_ALLOWED_TOOLS = [
      'web_search',
      'web_fetch',
      'browser_search',
      'file_read',
      'code_search',
    ];

    const executeTask = async () => {
      try {
        const timeoutMs = this.config.taskTimeoutMs ?? 120000;
        const execPromise = this.runtime.execute({
          agentId: `a2a-${taskId}`,
          projectId: 'a2a-server',
          goal: userMessage || '(empty message)',
          availableTools: A2A_ALLOWED_TOOLS,
          maxSteps: returnImmediately ? 1 : 25,
          tokenBudget: 50000,
          contextData: {
            agentState: {
              a2aTaskId: taskId,
              a2aContextId: contextId,
              acceptedOutputModes: configuration?.acceptedOutputModes,
            },
            governanceProfile: { riskLevel: 'LOW' },
          },
        });

        let result;
        if (timeoutMs > 0) {
          let timeoutTimer: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(
              () => reject(new Error(`Task execution timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            timeoutTimer.unref();
          });
          result = await Promise.race([
            execPromise.finally(() => clearTimeout(timeoutTimer)),
            timeoutPromise,
          ]);
        } else {
          result = await execPromise;
        }

        const responseMessage: A2AMessage = {
          messageId: `msg_${taskId}_resp`,
          role: 'agent',
          parts: [
            {
              type: 'text',
              text: result.summary || `Task completed with status: ${result.status}`,
            },
          ],
          taskId,
          contextId,
        };

        task.history?.push(responseMessage);
        task.artifacts = [
          {
            artifactId: `art_${taskId}_1`,
            parts: [{ type: 'text', text: result.summary || `Status: ${result.status}` }],
            metadata: {
              status: result.status,
              steps: result.steps?.length ?? 0,
              totalTokens: result.totalTokenUsage,
              durationMs: result.totalDurationMs,
            },
          },
        ];

        const finalState: A2ATaskState = result.status === 'success' ? 'COMPLETED' : 'FAILED';
        this.updateTaskState(
          taskId,
          finalState,
          result.status === 'success' ? undefined : result.error,
        );
        this.logger.info('A2AServer', `Task ${taskId} ${finalState}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.updateTaskState(taskId, 'FAILED', msg);
        this.logger.error(
          'A2AServer',
          `Task ${taskId} failed`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    };

    if (returnImmediately) {
      executeTask().catch((err) =>
        this.logger.error(
          'A2AServer',
          `Background task ${taskId} error`,
          err instanceof Error ? err : new Error(String(err)),
        ),
      );
      return this.tasks.get(taskId)!;
    }

    await executeTask();
    return this.tasks.get(taskId)!;
  }

  private async handleGetTask(params: A2ATaskQueryParams): Promise<A2ATask> {
    const task = this.tasks.get(params.id);
    if (!task) {
      throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `Task not found: ${params.id}`);
    }
    return task;
  }

  private async handleListTasks(params: A2AListTasksParams): Promise<A2AListTasksResult> {
    let filtered = Array.from(this.tasks.values());

    if (params.contextId) {
      filtered = filtered.filter((t) => t.contextId === params.contextId);
    }
    if (params.status) {
      filtered = filtered.filter((t) => t.status.state === params.status);
    }

    const totalSize = filtered.length;
    const pageSize = params.pageSize ?? 50;
    const pageToken = params.pageToken ? parseInt(params.pageToken, 10) : 0;
    const paged = filtered.slice(pageToken, pageToken + pageSize);

    return {
      tasks: paged,
      pageSize,
      totalSize,
      nextPageToken: pageToken + pageSize < totalSize ? String(pageToken + pageSize) : undefined,
    };
  }

  private async handleCancelTask(params: A2ATaskIdParams): Promise<{ status: string }> {
    const task = this.tasks.get(params.id);
    if (!task) {
      throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `Task not found: ${params.id}`);
    }
    if (A2A_TERMINAL_STATES.has(task.status.state)) {
      throw new A2AError(
        A2A_ERROR.TASK_NOT_CANCELABLE,
        `Task ${params.id} already in terminal state: ${task.status.state}`,
      );
    }
    this.updateTaskState(params.id, 'CANCELED', 'Canceled by client');
    return { status: 'canceled' };
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private updateTaskState(taskId: string, newState: A2ATaskState, message?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const current = task.status.state;
    if (!canTransition(current, newState)) {
      this.logger.warn(
        'A2AServer',
        `Invalid state transition: ${current} → ${newState} for task ${taskId}`,
      );
      return;
    }

    task.status = {
      state: newState,
      timestamp: new Date().toISOString(),
      message,
    };
  }

  private static readonly TERMINAL_STATES: Set<A2ATaskState> = new Set([
    'COMPLETED',
    'FAILED',
    'CANCELED',
  ]);

  private pruneCompletedTasks(): void {
    if (this.tasks.size < A2AServer.MAX_TASKS) return;
    for (const [id, task] of this.tasks) {
      if (A2AServer.TERMINAL_STATES.has(task.status.state)) {
        this.tasks.delete(id);
        if (this.tasks.size < A2AServer.MAX_TASKS * 0.8) break;
      }
    }
  }

  private parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      let rejected = false;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        if (rejected) return;
        size += Buffer.byteLength(chunk);
        if (size > (this.config.maxBodyBytes ?? 1024 * 1024)) {
          rejected = true;
          body = '';
          reject(new Error(`Request body too large. Limit is ${this.config.maxBodyBytes} bytes.`));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reportSilentFailure(err, 'a2aServer:470');
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    });
    res.end(JSON.stringify(data));
  }

  private applyCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const allowedOrigins = this.config.corsAllowedOrigins ?? [];
    const allowAll = allowedOrigins.includes('*');
    if (origin && (allowAll || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      if (!allowAll) res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private makeSuccessResponse(id: string | number | null, result: unknown): A2AJsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private makeErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): A2AJsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
  }
}

// ============================================================================
// Custom Error
// ============================================================================

class A2AError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'A2AError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Return PEM content as-is, or read from file path if the string doesn't
 * look like PEM content. Used for tls.cert / tls.key / tls.ca which may
 * be supplied as either inline content or a filesystem path.
 */
function maybeReadFile(s: string): string {
  if (s.startsWith('-----BEGIN')) return s;
  return readFileSync(s, 'utf8');
}

// ============================================================================
// Factory
// ============================================================================

export function createA2AServer(
  config: A2AServerConfig,
  runtime: AgentRuntimeInterface,
): A2AServer {
  return new A2AServer(config, runtime);
}
