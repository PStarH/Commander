/**
 * A2AClient — Agent-to-Agent protocol HTTP client.
 *
 * Discovers remote A2A agents via their Agent Card, sends tasks via JSON-RPC,
 * and polls for completion. Supports Bearer token authentication.
 *
 * Flow:
 *   Commander Agent → A2AClient → HTTP POST → Remote A2A Server → Remote Agent
 */
import type {
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2AMessage,
  A2ASendMessageParams,
  A2ATaskQueryParams,
  A2AListTasksParams,
  A2AListTasksResult,
  A2ATaskIdParams,
} from './a2aCompliance';
import {
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  A2A_METHODS,
  A2A_TERMINAL_STATES,
  A2A_INTERRUPTED_STATES,
} from './a2aCompliance';
import { getGlobalLogger } from '../logging';
import { getOutboundNetworkPolicy } from '../security/outboundNetworkPolicy';

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Per OWASP SSRF Prevention Cheat Sheet: validate scheme, reject private IPs.
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function isSafeA2AUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(parsed.hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// A2AClient — connect to a single remote A2A agent
// ============================================================================

export class A2AClient {
  private baseUrl: string;
  private authToken?: string;
  private logger = getGlobalLogger();
  private requestTimeoutMs: number;
  // Security: mTLS (mutual TLS) for transport-level authentication.
  // Per OWASP — bearer tokens alone are vulnerable to interception/replay.
  // mTLS provides channel binding and prevents MITM even if token is leaked.
  private mtlsAgent?: unknown;

  constructor(
    baseUrl: string,
    authToken: string,
    timeoutMs = 30000,
    mTLSConfig?: {
      cert: string;
      key: string;
      ca: string;
    },
  ) {
    // Security: SSRF prevention — validate URL at construction time.
    // Per OWASP SSRF Prevention Cheat Sheet: reject private/internal hosts.
    if (!isSafeA2AUrl(baseUrl)) {
      throw new Error(
        'A2A client URL must use http/https and must not point to private/internal IP ranges',
      );
    }
    // SECURITY: A2A client authentication is mandatory. Unauthenticated outbound
    // A2A connections trust any remote agent that responds on the URL.
    if (!authToken || authToken.length < 16) {
      throw new Error('A2AClient requires an authToken of at least 16 characters.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = authToken;
    this.requestTimeoutMs = timeoutMs;

    // Security: Configure mTLS if certificates are provided.
    if (mTLSConfig) {
      try {
        const https = require('node:https');
        this.mtlsAgent = new https.Agent({
          cert: mTLSConfig.cert,
          key: mTLSConfig.key,
          ca: mTLSConfig.ca,
          rejectUnauthorized: true, // Reject if server cert is invalid
        });
      } catch {
        this.logger.warn('A2AClient', 'Failed to create mTLS agent — falling back to standard TLS');
      }
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Fetch Agent Card from the remote agent's well-known endpoint.
   */
  async getAgentCard(): Promise<A2AAgentCard> {
    const url = `${this.baseUrl}${AGENT_CARD_WELL_KNOWN_PATH}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    const response = await this.fetchWithTimeout(url, { method: 'GET', headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch Agent Card from ${url}: HTTP ${response.status}`);
    }

    const card = (await response.json()) as A2AAgentCard;
    return card;
  }

  /**
   * Send a message to the remote agent and get back a task.
   */
  async sendMessage(
    message: A2AMessage,
    configuration?: A2ASendMessageParams['configuration'],
    metadata?: Record<string, unknown>,
  ): Promise<A2ATask> {
    const params: A2ASendMessageParams = { message, configuration, metadata };
    const response = await this.jsonRpcCall(A2A_METHODS.SEND_MESSAGE, params);
    return response as A2ATask;
  }

  /**
   * Poll for task status by ID.
   */
  async getTask(taskId: string, historyLength?: number): Promise<A2ATask> {
    const params: A2ATaskQueryParams = { id: taskId, historyLength };
    const response = await this.jsonRpcCall(A2A_METHODS.GET_TASK, params);
    return response as A2ATask;
  }

  /**
   * Wait for a task to reach a terminal state.
   * Polls at the specified interval.
   */
  async waitForTask(taskId: string, pollIntervalMs = 1000, maxWaitMs = 120000): Promise<A2ATask> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const task = await this.getTask(taskId);
      if (A2A_TERMINAL_STATES.has(task.status.state)) {
        return task;
      }
      if (A2A_INTERRUPTED_STATES.has(task.status.state)) {
        throw new Error(
          `Task ${taskId} requires intervention (state: ${task.status.state}): ${task.status.message ?? 'no details'}`,
        );
      }
      await new Promise((r) => {
        const t = setTimeout(r, pollIntervalMs);
        t.unref();
      });
    }
    throw new Error(
      `Task ${taskId} did not complete within ${maxWaitMs}ms (last state: ${(await this.getTask(taskId)).status.state})`,
    );
  }

  /**
   * List tasks with optional filters.
   */
  async listTasks(params?: A2AListTasksParams): Promise<A2AListTasksResult> {
    const response = await this.jsonRpcCall(A2A_METHODS.LIST_TASKS, params ?? {});
    return response as A2AListTasksResult;
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(taskId: string): Promise<void> {
    const params: A2ATaskIdParams = { id: taskId };
    await this.jsonRpcCall(A2A_METHODS.CANCEL_TASK, params);
  }

  // ========================================================================
  // Internal
  // ========================================================================

  private async jsonRpcCall(method: string, params: unknown): Promise<unknown> {
    const request: A2AJsonRpcRequest = {
      jsonrpc: '2.0',
      id: `a2ac_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    };

    const url = `${this.baseUrl}/`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
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
      throw new Error(
        `A2A RPC call ${method} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      );
    }

    const json = (await response.json()) as A2AJsonRpcResponse;

    if (json.error) {
      throw new A2ARpcError(
        json.error.code,
        json.error.message,
        json.error.data as Record<string, unknown> | undefined,
      );
    }

    return json.result;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref();
    try {
      // Security: Apply mTLS agent if configured for transport-level authentication.
      const fetchOptions: RequestInit & { agent?: unknown } = {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (this.mtlsAgent) {
        (fetchOptions as Record<string, unknown>).agent = this.mtlsAgent;
      }
      const response = await getOutboundNetworkPolicy().ssrfCheckedFetch(url, fetchOptions);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new Error('A2A redirects are not allowed');
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// A2ADiscoveryManager — manages connections to multiple remote A2A agents
// ============================================================================

export interface A2ADiscoveredAgent {
  label: string;
  url: string;
  client: A2AClient;
  card: A2AAgentCard;
  discoveredAt: string;
}

export class A2ADiscoveryManager {
  private agents: Map<string, A2ADiscoveredAgent> = new Map();
  private logger = getGlobalLogger();

  /**
   * Discover and register a remote A2A agent.
   * Fetches the Agent Card to verify it's a valid A2A endpoint.
   */
  async discoverAgent(label: string, url: string, authToken: string): Promise<A2ADiscoveredAgent> {
    if (!authToken || authToken.length < 16) {
      throw new Error(
        `A2A discovery for "${label}" requires an authToken of at least 16 characters.`,
      );
    }
    const client = new A2AClient(url, authToken);
    const card = await client.getAgentCard();
    const agent: A2ADiscoveredAgent = {
      label,
      url,
      client,
      card,
      discoveredAt: new Date().toISOString(),
    };
    this.agents.set(label, agent);
    this.logger.info(
      'A2ADiscovery',
      `Discovered A2A agent "${label}" at ${url} — ${card.name} v${card.version}`,
    );
    return agent;
  }

  getAgent(label: string): A2ADiscoveredAgent | undefined {
    return this.agents.get(label);
  }

  getAllAgents(): A2ADiscoveredAgent[] {
    return Array.from(this.agents.values());
  }

  removeAgent(label: string): boolean {
    return this.agents.delete(label);
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Discover multiple agents from config.
   * Each entry is { label: string, url: string, authToken?: string }.
   */
  async discoverFromConfig(
    configs: Array<{ label: string; url: string; authToken?: string }>,
  ): Promise<void> {
    const validConfigs = configs.filter(
      (cfg): cfg is { label: string; url: string; authToken: string } =>
        typeof cfg.authToken === 'string' && cfg.authToken.length >= 16,
    );
    const results = await Promise.allSettled(
      validConfigs.map((cfg) => this.discoverAgent(cfg.label, cfg.url, cfg.authToken)),
    );
    let succeeded = 0,
      failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++;
      else failed++;
    }
    if (failed > 0) {
      this.logger.warn('A2ADiscovery', `${failed}/${configs.length} A2A agents failed to connect`);
    }
    if (succeeded > 0) {
      this.logger.info('A2ADiscovery', `Connected to ${succeeded} A2A agents`);
    }
  }
}

// ============================================================================
// A2ARpcError
// ============================================================================

export class A2ARpcError extends Error {
  code: number;
  data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(`A2A RPC error [${code}]: ${message}`);
    this.name = 'A2ARpcError';
    this.code = code;
    this.data = data;
  }
}

// ============================================================================
// Factory helpers
// ============================================================================

export function createA2AClient(baseUrl: string, authToken: string): A2AClient {
  return new A2AClient(baseUrl, authToken);
}

export function createA2ADiscoveryManager(): A2ADiscoveryManager {
  return new A2ADiscoveryManager();
}
