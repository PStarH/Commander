"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2AServer = void 0;
exports.createA2AServer = createA2AServer;
/**
 * A2AServer — Agent-to-Agent protocol HTTP server.
 *
 * Serves an Agent Card at /.well-known/agent-card.json and handles
 * A2A JSON-RPC methods: message/send, tasks/get, tasks/list, tasks/cancel.
 *
 * Flow:
 *   Remote Agent → HTTP POST / → A2A JSON-RPC → A2AServer → AgentRuntimeInterface → Response
 */
const http_1 = require("http");
const a2aCompliance_1 = require("./a2aCompliance");
const logging_1 = require("../logging");
const DEFAULT_CONFIG = {
    endpoint: '/',
    shutdownTimeoutMs: 5000,
    taskTimeoutMs: 120000,
    corsAllowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
};
// ============================================================================
// A2AServer
// ============================================================================
class A2AServer {
    constructor(config, runtime) {
        this.server = null;
        this.tasks = new Map();
        this.connections = new Set();
        this.logger = (0, logging_1.getGlobalLogger)();
        this.nextTaskId = 1;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.runtime = runtime;
    }
    async start() {
        return new Promise((resolve) => {
            this.server = (0, http_1.createServer)((req, res) => {
                const socket = req.socket;
                this.connections.add(socket);
                res.on('finish', () => {
                    this.connections.delete(socket);
                });
                this.handleRequest(req, res);
            });
            this.server.listen(this.config.port, this.config.host, () => {
                this.logger.info('A2AServer', `A2A server listening on ${this.config.host}:${this.config.port}`);
                resolve();
            });
        });
    }
    getPort() {
        var _a;
        const addr = (_a = this.server) === null || _a === void 0 ? void 0 : _a.address();
        return addr && typeof addr === 'object' ? addr.port : this.config.port;
    }
    async stop() {
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
                    for (const socket of this.connections)
                        socket.destroy();
                    this.connections.clear();
                }, this.config.shutdownTimeoutMs).unref();
            }
        });
    }
    getTaskCount() {
        return this.tasks.size;
    }
    // ========================================================================
    // Request Handling
    // ========================================================================
    async handleRequest(req, res) {
        var _a;
        this.applyCommonHeaders(req, res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = (_a = req.url) !== null && _a !== void 0 ? _a : '/';
        const [pathPart] = url.split('?');
        if (pathPart === a2aCompliance_1.AGENT_CARD_WELL_KNOWN_PATH && req.method === 'GET') {
            this.sendJson(res, 200, this.config.agentCard);
            return;
        }
        const a2aVersion = req.headers[a2aCompliance_1.A2A_VERSION_HEADER.toLowerCase()];
        if (a2aVersion && a2aVersion !== a2aCompliance_1.A2A_PROTOCOL_VERSION) {
            this.sendJson(res, 400, this.makeErrorResponse(null, -32004, `Unsupported A2A version: ${a2aVersion}`));
            return;
        }
        if (pathPart === this.config.endpoint && req.method === 'POST') {
            try {
                const body = await this.parseBody(req);
                const response = await this.handleJsonRpc(body);
                this.sendJson(res, response.error ? 400 : 200, response);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const status = msg.includes('Request body too large') ? 413 : 500;
                this.sendJson(res, status, this.makeErrorResponse(null, -32603, `Internal error: ${msg}`));
            }
            return;
        }
        this.sendJson(res, 404, { error: 'Not found' });
    }
    async handleJsonRpc(request) {
        const { jsonrpc, id, method, params } = request;
        if (jsonrpc !== '2.0') {
            return this.makeErrorResponse(id, -32600, 'Invalid JSON-RPC: must use "2.0"');
        }
        try {
            switch (method) {
                case a2aCompliance_1.A2A_METHODS.SEND_MESSAGE:
                    return this.makeSuccessResponse(id, await this.handleSendMessage(params));
                case a2aCompliance_1.A2A_METHODS.SEND_MESSAGE_STREAM:
                    return this.makeSuccessResponse(id, {
                        warning: 'Streaming not supported, use message/send',
                    });
                case a2aCompliance_1.A2A_METHODS.GET_TASK:
                    return this.makeSuccessResponse(id, await this.handleGetTask(params));
                case a2aCompliance_1.A2A_METHODS.LIST_TASKS:
                    return this.makeSuccessResponse(id, await this.handleListTasks(params));
                case a2aCompliance_1.A2A_METHODS.CANCEL_TASK:
                    return this.makeSuccessResponse(id, await this.handleCancelTask(params));
                case a2aCompliance_1.A2A_METHODS.GET_AGENT_CARD:
                    return this.makeSuccessResponse(id, this.config.agentCard);
                default:
                    return this.makeErrorResponse(id, -32601, `Method not found: ${method}`);
            }
        }
        catch (err) {
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
    async handleSendMessage(params) {
        var _a;
        const { message, configuration } = params;
        const returnImmediately = (configuration === null || configuration === void 0 ? void 0 : configuration.returnImmediately) === true;
        const taskId = `a2a_${Date.now()}_${this.nextTaskId++}`;
        const contextId = (_a = message.contextId) !== null && _a !== void 0 ? _a : `ctx_${taskId}`;
        const task = {
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
            if (p.type === 'text')
                return p.text;
            if (p.type === 'data')
                return JSON.stringify(p.data);
            return '';
        })
            .filter(Boolean)
            .join('\n');
        const executeTask = async () => {
            var _a, _b, _c, _d;
            try {
                const timeoutMs = (_a = this.config.taskTimeoutMs) !== null && _a !== void 0 ? _a : 120000;
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
                            acceptedOutputModes: configuration === null || configuration === void 0 ? void 0 : configuration.acceptedOutputModes,
                        },
                        governanceProfile: { riskLevel: 'LOW' },
                    },
                });
                let result;
                if (timeoutMs > 0) {
                    let timeoutTimer;
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutTimer = setTimeout(() => reject(new Error(`Task execution timed out after ${timeoutMs}ms`)), timeoutMs);
                        timeoutTimer.unref();
                    });
                    result = await Promise.race([
                        execPromise.finally(() => clearTimeout(timeoutTimer)),
                        timeoutPromise,
                    ]);
                }
                else {
                    result = await execPromise;
                }
                const responseMessage = {
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
                (_b = task.history) === null || _b === void 0 ? void 0 : _b.push(responseMessage);
                task.artifacts = [
                    {
                        artifactId: `art_${taskId}_1`,
                        parts: [{ type: 'text', text: result.summary || `Status: ${result.status}` }],
                        metadata: {
                            status: result.status,
                            steps: (_d = (_c = result.steps) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0,
                            totalTokens: result.totalTokenUsage,
                            durationMs: result.totalDurationMs,
                        },
                    },
                ];
                const finalState = result.status === 'success' ? 'COMPLETED' : 'FAILED';
                this.updateTaskState(taskId, finalState, result.status === 'success' ? undefined : result.error);
                this.logger.info('A2AServer', `Task ${taskId} ${finalState}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.updateTaskState(taskId, 'FAILED', msg);
                this.logger.error('A2AServer', `Task ${taskId} failed`, err instanceof Error ? err : new Error(String(err)));
            }
        };
        if (returnImmediately) {
            executeTask().catch((err) => this.logger.error('A2AServer', `Background task ${taskId} error`, err instanceof Error ? err : new Error(String(err))));
            return this.tasks.get(taskId);
        }
        await executeTask();
        return this.tasks.get(taskId);
    }
    async handleGetTask(params) {
        const task = this.tasks.get(params.id);
        if (!task) {
            throw new A2AError(a2aCompliance_1.A2A_ERROR.TASK_NOT_FOUND, `Task not found: ${params.id}`);
        }
        return task;
    }
    async handleListTasks(params) {
        var _a;
        let filtered = Array.from(this.tasks.values());
        if (params.contextId) {
            filtered = filtered.filter((t) => t.contextId === params.contextId);
        }
        if (params.status) {
            filtered = filtered.filter((t) => t.status.state === params.status);
        }
        const totalSize = filtered.length;
        const pageSize = (_a = params.pageSize) !== null && _a !== void 0 ? _a : 50;
        const pageToken = params.pageToken ? parseInt(params.pageToken, 10) : 0;
        const paged = filtered.slice(pageToken, pageToken + pageSize);
        return {
            tasks: paged,
            pageSize,
            totalSize,
            nextPageToken: pageToken + pageSize < totalSize ? String(pageToken + pageSize) : undefined,
        };
    }
    async handleCancelTask(params) {
        const task = this.tasks.get(params.id);
        if (!task) {
            throw new A2AError(a2aCompliance_1.A2A_ERROR.TASK_NOT_FOUND, `Task not found: ${params.id}`);
        }
        if (a2aCompliance_1.A2A_TERMINAL_STATES.has(task.status.state)) {
            throw new A2AError(a2aCompliance_1.A2A_ERROR.TASK_NOT_CANCELABLE, `Task ${params.id} already in terminal state: ${task.status.state}`);
        }
        this.updateTaskState(params.id, 'CANCELED', 'Canceled by client');
        return { status: 'canceled' };
    }
    // ========================================================================
    // Helpers
    // ========================================================================
    updateTaskState(taskId, newState, message) {
        const task = this.tasks.get(taskId);
        if (!task)
            return;
        const current = task.status.state;
        if (!(0, a2aCompliance_1.canTransition)(current, newState)) {
            this.logger.warn('A2AServer', `Invalid state transition: ${current} → ${newState} for task ${taskId}`);
            return;
        }
        task.status = {
            state: newState,
            timestamp: new Date().toISOString(),
            message,
        };
    }
    pruneCompletedTasks() {
        if (this.tasks.size < A2AServer.MAX_TASKS)
            return;
        for (const [id, task] of this.tasks) {
            if (A2AServer.TERMINAL_STATES.has(task.status.state)) {
                this.tasks.delete(id);
                if (this.tasks.size < A2AServer.MAX_TASKS * 0.8)
                    break;
            }
        }
    }
    parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            let size = 0;
            let rejected = false;
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
                var _a;
                if (rejected)
                    return;
                size += Buffer.byteLength(chunk);
                if (size > ((_a = this.config.maxBodyBytes) !== null && _a !== void 0 ? _a : 1024 * 1024)) {
                    rejected = true;
                    body = '';
                    reject(new Error(`Request body too large. Limit is ${this.config.maxBodyBytes} bytes.`));
                    return;
                }
                body += chunk;
            });
            req.on('end', () => {
                if (rejected)
                    return;
                try {
                    resolve(body ? JSON.parse(body) : {});
                }
                catch {
                    reject(new Error('Invalid JSON'));
                }
            });
            req.on('error', reject);
        });
    }
    sendJson(res, status, data) {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            [a2aCompliance_1.A2A_VERSION_HEADER]: a2aCompliance_1.A2A_PROTOCOL_VERSION,
        });
        res.end(JSON.stringify(data));
    }
    applyCommonHeaders(req, res) {
        var _a;
        const origin = req.headers.origin;
        const allowedOrigins = (_a = this.config.corsAllowedOrigins) !== null && _a !== void 0 ? _a : [];
        const allowAll = allowedOrigins.includes('*');
        if (origin && (allowAll || allowedOrigins.includes(origin))) {
            res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
            if (!allowAll)
                res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    makeSuccessResponse(id, result) {
        return { jsonrpc: '2.0', id, result };
    }
    makeErrorResponse(id, code, message, data) {
        return {
            jsonrpc: '2.0',
            id,
            error: { code, message, ...(data !== undefined ? { data } : {}) },
        };
    }
}
exports.A2AServer = A2AServer;
A2AServer.MAX_TASKS = 500;
A2AServer.TERMINAL_STATES = new Set([
    'COMPLETED',
    'FAILED',
    'CANCELED',
]);
// ============================================================================
// Custom Error
// ============================================================================
class A2AError extends Error {
    constructor(code, message, data) {
        super(message);
        this.name = 'A2AError';
        this.code = code;
        this.data = data;
    }
}
// ============================================================================
// Factory
// ============================================================================
function createA2AServer(config, runtime) {
    return new A2AServer(config, runtime);
}
