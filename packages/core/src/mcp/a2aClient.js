"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2ARpcError = exports.A2ADiscoveryManager = exports.A2AClient = void 0;
exports.createA2AClient = createA2AClient;
exports.createA2ADiscoveryManager = createA2ADiscoveryManager;
const a2aCompliance_1 = require("./a2aCompliance");
const logging_1 = require("../logging");
// ============================================================================
// A2AClient — connect to a single remote A2A agent
// ============================================================================
class A2AClient {
    constructor(baseUrl, authToken, timeoutMs = 30000) {
        this.logger = (0, logging_1.getGlobalLogger)();
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.authToken = authToken;
        this.requestTimeoutMs = timeoutMs;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    /**
     * Fetch Agent Card from the remote agent's well-known endpoint.
     */
    async getAgentCard() {
        const url = `${this.baseUrl}${a2aCompliance_1.AGENT_CARD_WELL_KNOWN_PATH}`;
        const headers = {
            Accept: 'application/json',
            [a2aCompliance_1.A2A_VERSION_HEADER]: a2aCompliance_1.A2A_PROTOCOL_VERSION,
        };
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        const response = await this.fetchWithTimeout(url, { method: 'GET', headers });
        if (!response.ok) {
            throw new Error(`Failed to fetch Agent Card from ${url}: HTTP ${response.status}`);
        }
        const card = (await response.json());
        return card;
    }
    /**
     * Send a message to the remote agent and get back a task.
     */
    async sendMessage(message, configuration, metadata) {
        const params = { message, configuration, metadata };
        const response = await this.jsonRpcCall(a2aCompliance_1.A2A_METHODS.SEND_MESSAGE, params);
        return response;
    }
    /**
     * Poll for task status by ID.
     */
    async getTask(taskId, historyLength) {
        const params = { id: taskId, historyLength };
        const response = await this.jsonRpcCall(a2aCompliance_1.A2A_METHODS.GET_TASK, params);
        return response;
    }
    /**
     * Wait for a task to reach a terminal state.
     * Polls at the specified interval.
     */
    async waitForTask(taskId, pollIntervalMs = 1000, maxWaitMs = 120000) {
        var _a;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            const task = await this.getTask(taskId);
            if (a2aCompliance_1.A2A_TERMINAL_STATES.has(task.status.state)) {
                return task;
            }
            if (a2aCompliance_1.A2A_INTERRUPTED_STATES.has(task.status.state)) {
                throw new Error(`Task ${taskId} requires intervention (state: ${task.status.state}): ${(_a = task.status.message) !== null && _a !== void 0 ? _a : 'no details'}`);
            }
            await new Promise((r) => {
                const t = setTimeout(r, pollIntervalMs);
                t.unref();
            });
        }
        throw new Error(`Task ${taskId} did not complete within ${maxWaitMs}ms (last state: ${(await this.getTask(taskId)).status.state})`);
    }
    /**
     * List tasks with optional filters.
     */
    async listTasks(params) {
        const response = await this.jsonRpcCall(a2aCompliance_1.A2A_METHODS.LIST_TASKS, params !== null && params !== void 0 ? params : {});
        return response;
    }
    /**
     * Cancel a running task.
     */
    async cancelTask(taskId) {
        const params = { id: taskId };
        await this.jsonRpcCall(a2aCompliance_1.A2A_METHODS.CANCEL_TASK, params);
    }
    // ========================================================================
    // Internal
    // ========================================================================
    async jsonRpcCall(method, params) {
        const request = {
            jsonrpc: '2.0',
            id: `a2ac_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            method,
            params,
        };
        const url = `${this.baseUrl}/`;
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [a2aCompliance_1.A2A_VERSION_HEADER]: a2aCompliance_1.A2A_PROTOCOL_VERSION,
        };
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`A2A RPC call ${method} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
        }
        const json = (await response.json());
        if (json.error) {
            throw new A2ARpcError(json.error.code, json.error.message, json.error.data);
        }
        return json.result;
    }
    async fetchWithTimeout(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        timer.unref();
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            return response;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.A2AClient = A2AClient;
class A2ADiscoveryManager {
    constructor() {
        this.agents = new Map();
        this.logger = (0, logging_1.getGlobalLogger)();
    }
    /**
     * Discover and register a remote A2A agent.
     * Fetches the Agent Card to verify it's a valid A2A endpoint.
     */
    async discoverAgent(label, url, authToken) {
        const client = new A2AClient(url, authToken);
        const card = await client.getAgentCard();
        const agent = {
            label,
            url,
            client,
            card,
            discoveredAt: new Date().toISOString(),
        };
        this.agents.set(label, agent);
        this.logger.info('A2ADiscovery', `Discovered A2A agent "${label}" at ${url} — ${card.name} v${card.version}`);
        return agent;
    }
    getAgent(label) {
        return this.agents.get(label);
    }
    getAllAgents() {
        return Array.from(this.agents.values());
    }
    removeAgent(label) {
        return this.agents.delete(label);
    }
    getAgentCount() {
        return this.agents.size;
    }
    /**
     * Discover multiple agents from config.
     * Each entry is { label: string, url: string, authToken?: string }.
     */
    async discoverFromConfig(configs) {
        const results = await Promise.allSettled(configs.map((cfg) => this.discoverAgent(cfg.label, cfg.url, cfg.authToken)));
        let succeeded = 0, failed = 0;
        for (const r of results) {
            if (r.status === 'fulfilled')
                succeeded++;
            else
                failed++;
        }
        if (failed > 0) {
            this.logger.warn('A2ADiscovery', `${failed}/${configs.length} A2A agents failed to connect`);
        }
        if (succeeded > 0) {
            this.logger.info('A2ADiscovery', `Connected to ${succeeded} A2A agents`);
        }
    }
}
exports.A2ADiscoveryManager = A2ADiscoveryManager;
// ============================================================================
// A2ARpcError
// ============================================================================
class A2ARpcError extends Error {
    constructor(code, message, data) {
        super(`A2A RPC error [${code}]: ${message}`);
        this.name = 'A2ARpcError';
        this.code = code;
        this.data = data;
    }
}
exports.A2ARpcError = A2ARpcError;
// ============================================================================
// Factory helpers
// ============================================================================
function createA2AClient(baseUrl, authToken) {
    return new A2AClient(baseUrl, authToken);
}
function createA2ADiscoveryManager() {
    return new A2ADiscoveryManager();
}
