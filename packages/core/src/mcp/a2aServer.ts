/**
 * A2AServer — Agent-to-Agent protocol HTTP server.
 *
 * Serves an Agent Card at /.well-known/agent-card.json and handles
 * A2A JSON-RPC methods: message/send, tasks/get, tasks/list, tasks/cancel.
 *
 * Flow:
 *   Remote Agent → HTTP POST / → A2A JSON-RPC → A2AServer → AgentRuntimeInterface → Response
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
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
  private server: ReturnType<typeof createServer> | null = null;
  private tasks: Map<string, A2ATask> = new Map();
  private connections: Set<import('net').Socket> = new Set();
  private logger = getGlobalLogger();
  private nextTaskId = 1;
  private static readonly MAX_TASKS = 500;

  constructor(config: A2AServerConfig, runtime: AgentRuntimeInterface) {
    this.config = { ...DEFAULT_CONFIG, ...config } as A2AServerConfig;
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const socket = req.socket;
        this.connections.add(socket);
        res.on('finish', () => { this.connections.delete(socket); });
        this.handleRequest(req, res);
      });
      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info('A2AServer', `A2A server listening on ${this.config.host}:${this.config.port}`);
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
      if (!this.server) { resolve(); return; }
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
      this.sendJson(res, 400, this.makeErrorResponse(null, -32004, `Unsupported A2A version: ${a2aVersion}`));
      return;
    }

    if (pathPart === this.config.endpoint && req.method === 'POST') {
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
          return this.makeSuccessResponse(id, await this.handleSendMessage(params as A2ASendMessageParams));

        case A2A_METHODS.SEND_MESSAGE_STREAM:
          return this.makeSuccessResponse(id, { warning: 'Streaming not supported, use message/send' });

        case A2A_METHODS.GET_TASK:
          return this.makeSuccessResponse(id, await this.handleGetTask(params as A2ATaskQueryParams));

        case A2A_METHODS.LIST_TASKS:
          return this.makeSuccessResponse(id, await this.handleListTasks(params as A2AListTasksParams));

        case A2A_METHODS.CANCEL_TASK:
          return this.makeSuccessResponse(id, await this.handleCancelTask(params as A2ATaskIdParams));

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

    const taskId = `a2a_${Date.now()}_${this.nextTaskId++}`;
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

    const userMessage = message.parts.map(p => {
      if (p.type === 'text') return p.text;
      if (p.type === 'data') return JSON.stringify(p.data);
      return '';
    }).filter(Boolean).join('\n');

    const executeTask = async () => {
      try {
        const timeoutMs = this.config.taskTimeoutMs ?? 120000;
        const execPromise = this.runtime.execute({
          agentId: `a2a-${taskId}`,
          projectId: 'a2a-server',
          goal: userMessage || '(empty message)',
          availableTools: [],
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
            timeoutTimer = setTimeout(() => reject(new Error(`Task execution timed out after ${timeoutMs}ms`)), timeoutMs);
            timeoutTimer.unref();
          });
          result = await Promise.race([execPromise.finally(() => clearTimeout(timeoutTimer)), timeoutPromise]);
        } else {
          result = await execPromise;
        }

        const responseMessage: A2AMessage = {
          messageId: `msg_${taskId}_resp`,
          role: 'agent',
          parts: [{ type: 'text', text: result.summary || `Task completed with status: ${result.status}` }],
          taskId,
          contextId,
        };

        task.history?.push(responseMessage);
        task.artifacts = [{
          artifactId: `art_${taskId}_1`,
          parts: [{ type: 'text', text: result.summary || `Status: ${result.status}` }],
          metadata: {
            status: result.status,
            steps: result.steps?.length ?? 0,
            totalTokens: result.totalTokenUsage,
            durationMs: result.totalDurationMs,
          },
        }];

        const finalState: A2ATaskState = result.status === 'success' ? 'COMPLETED' : 'FAILED';
        this.updateTaskState(taskId, finalState, result.status === 'success' ? undefined : result.error);
        this.logger.info('A2AServer', `Task ${taskId} ${finalState}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.updateTaskState(taskId, 'FAILED', msg);
        this.logger.error('A2AServer', `Task ${taskId} failed`, err instanceof Error ? err : new Error(String(err)));
      }
    };

    if (returnImmediately) {
      executeTask().catch(err => this.logger.error('A2AServer', `Background task ${taskId} error`, err instanceof Error ? err : new Error(String(err))));
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
      filtered = filtered.filter(t => t.contextId === params.contextId);
    }
    if (params.status) {
      filtered = filtered.filter(t => t.status.state === params.status);
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
      throw new A2AError(A2A_ERROR.TASK_NOT_CANCELABLE, `Task ${params.id} already in terminal state: ${task.status.state}`);
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
      this.logger.warn('A2AServer', `Invalid state transition: ${current} → ${newState} for task ${taskId}`);
      return;
    }

    task.status = {
      state: newState,
      timestamp: new Date().toISOString(),
      message,
    };
  }

  private static readonly TERMINAL_STATES: Set<A2ATaskState> = new Set(['COMPLETED', 'FAILED', 'CANCELED']);

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
        } catch {
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

  private makeErrorResponse(id: string | number | null, code: number, message: string, data?: unknown): A2AJsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
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

// ============================================================================
// Factory
// ============================================================================

export function createA2AServer(config: A2AServerConfig, runtime: AgentRuntimeInterface): A2AServer {
  return new A2AServer(config, runtime);
}
