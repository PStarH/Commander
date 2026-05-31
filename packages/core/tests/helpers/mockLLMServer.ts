/**
 * Mock LLM Server — OpenAI-compatible HTTP server for integration testing.
 *
 * Inspired by Codex CLI's wiremock pattern: spin up a real HTTP server that
 * simulates the LLM API, allowing end-to-end agent loop testing without
 * real API keys or network calls.
 *
 * Features:
 * - Configurable response queue (FIFO)
 * - SSE streaming support
 * - Tool call responses
 * - Request capture with deep introspection (by role, call_id, tool name)
 * - Invariant validation (tool call/output symmetry)
 * - Delay and error simulation
 *
 * Usage:
 *   const server = new MockLLMServer();
 *   await server.start();
 *   server.enqueueResponse({ content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
 *   // ... run agent code pointing at server.baseUrl ...
 *   const requests = server.getRequests();
 *   await server.stop();
 */
import * as http from 'http';

// ── Types ───────────────────────────────────────────────────────────────────

export interface MockLLMResponse {
  /** Text content to return */
  content?: string;
  /** Tool calls to return (mutually exclusive with content) */
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  /** Token usage */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** HTTP status code (default 200) */
  statusCode?: number;
  /** Simulated delay in ms */
  delayMs?: number;
  /** Error to throw instead of responding */
  error?: string;
}

/** Parsed message from the request body */
export interface ParsedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** Invariant violation found during request validation */
export interface InvariantViolation {
  type: 'orphaned_output' | 'missing_output';
  message: string;
  callId: string;
  details: string;
}

/**
 * Rich request wrapper with deep introspection methods.
 * Mirrors Codex CLI's ResponsesRequest for precise test assertions.
 */
export class CapturedRequest {
  public readonly timestamp: number;
  public readonly headers: Record<string, string>;

  private readonly _body: Record<string, unknown>;
  private readonly _messages: ParsedMessage[];

  constructor(timestamp: number, body: Record<string, unknown>, headers: Record<string, string>) {
    this.timestamp = timestamp;
    this._body = body;
    this.headers = headers;
    this._messages = (body.messages as ParsedMessage[] | undefined) ?? [];
  }

  /** Raw request body */
  get body(): Record<string, unknown> {
    return this._body;
  }

  /** Model requested */
  get model(): string | undefined {
    return this._body.model as string | undefined;
  }

  /** Whether streaming was requested */
  get stream(): boolean {
    return this._body.stream === true;
  }

  /** Temperature setting */
  get temperature(): number | undefined {
    return this._body.temperature as number | undefined;
  }

  /** Tool definitions sent in request */
  get tools(): Array<{ function: { name: string } }> | undefined {
    return this._body.tools as Array<{ function: { name: string } }> | undefined;
  }

  // ── Message introspection ─────────────────────────────────────────────────

  /** All messages in the request */
  get messages(): ParsedMessage[] {
    return [...this._messages];
  }

  /** Messages filtered by role */
  messagesByRole(role: ParsedMessage['role']): ParsedMessage[] {
    return this._messages.filter(m => m.role === role);
  }

  /** System prompt text (all system messages joined) */
  systemPrompt(): string {
    return this._messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n');
  }

  /** User message texts */
  userMessages(): string[] {
    return this._messages
      .filter(m => m.role === 'user')
      .map(m => m.content);
  }

  /** Last user message text */
  lastUserMessage(): string | undefined {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (this._messages[i].role === 'user') return this._messages[i].content;
    }
    return undefined;
  }

  /** Assistant message texts (excluding tool-call-only messages) */
  assistantTexts(): string[] {
    return this._messages
      .filter(m => m.role === 'assistant' && m.content)
      .map(m => m.content);
  }

  // ── Tool call introspection ───────────────────────────────────────────────

  /** All tool calls from assistant messages */
  allToolCalls(): Array<{ id: string; name: string; arguments: string }> {
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    for (const msg of this._messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          calls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    }
    return calls;
  }

  /** Check if a specific tool was called */
  hasToolCall(name: string): boolean {
    return this.allToolCalls().some(tc => tc.name === name);
  }

  /** Get all tool calls by name */
  toolCallsByName(name: string): Array<{ id: string; arguments: string }> {
    return this.allToolCalls()
      .filter(tc => tc.name === name)
      .map(tc => ({ id: tc.id, arguments: tc.arguments }));
  }

  /** Get a specific tool call by id */
  toolCallById(id: string): { name: string; arguments: string } | undefined {
    const tc = this.allToolCalls().find(tc => tc.id === id);
    return tc ? { name: tc.name, arguments: tc.arguments } : undefined;
  }

  // ── Tool output introspection ─────────────────────────────────────────────

  /** All tool result messages */
  allToolOutputs(): Array<{ tool_call_id: string; name: string; content: string }> {
    return this._messages
      .filter(m => m.role === 'tool')
      .map(m => ({
        tool_call_id: m.tool_call_id ?? '',
        name: m.name ?? '',
        content: m.content,
      }));
  }

  /** Get tool output by call_id */
  toolOutputByCallId(callId: string): string | undefined {
    const output = this._messages.find(
      m => m.role === 'tool' && m.tool_call_id === callId
    );
    return output?.content;
  }

  /** Get tool outputs by tool name */
  toolOutputsByName(name: string): string[] {
    return this._messages
      .filter(m => m.role === 'tool' && m.name === name)
      .map(m => m.content);
  }

  // ── Requested tools ───────────────────────────────────────────────────────

  /** Names of tools requested in the tools parameter */
  requestedToolNames(): string[] {
    return (this.tools ?? []).map(t => t.function.name);
  }

  /** Check if a tool was requested */
  hasRequestedTool(name: string): boolean {
    return this.requestedToolNames().includes(name);
  }
}

// ── Invariant Validation ────────────────────────────────────────────────────

/**
 * Validates tool call/output symmetry in a request.
 * Mirrors Codex CLI's validate_request_body_invariants().
 *
 * Rules:
 * 1. Every tool result (role=tool) must have a matching tool call with the same call_id
 * 2. Every tool call should have a corresponding tool result (warn if missing)
 */
export function validateRequestInvariants(request: CapturedRequest): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const toolCalls = request.allToolCalls();
  const toolOutputs = request.allToolOutputs();

  const callIds = new Set(toolCalls.map(tc => tc.id));
  const outputCallIds = new Set(toolOutputs.map(o => o.tool_call_id));

  // Rule 1: Every output must have a matching call
  for (const output of toolOutputs) {
    if (!callIds.has(output.tool_call_id)) {
      violations.push({
        type: 'orphaned_output',
        message: `Tool output for call_id="${output.tool_call_id}" has no matching tool call`,
        callId: output.tool_call_id,
        details: `Tool: ${output.name}, Content: ${output.content.slice(0, 100)}`,
      });
    }
  }

  // Rule 2: Every call should have a matching output (only for multi-message requests)
  if (request.messages.length > 1) {
    for (const call of toolCalls) {
      if (!outputCallIds.has(call.id)) {
        violations.push({
          type: 'missing_output',
          message: `Tool call id="${call.id}" (${call.name}) has no matching output`,
          callId: call.id,
          details: `Tool: ${call.name}, Args: ${call.arguments.slice(0, 100)}`,
        });
      }
    }
  }

  return violations;
}

// ── Mock LLM Server ─────────────────────────────────────────────────────────

export interface MockLLMServerOptions {
  /** Whether to validate invariants on every request (default: true) */
  validateInvariants?: boolean;
  /** Callback when invariant violations are found */
  onInvariantViolation?: (violations: InvariantViolation[], request: CapturedRequest) => void;
}

export class MockLLMServer {
  private server: http.Server | null = null;
  private port = 0;
  private responseQueue: MockLLMResponse[] = [];
  private _requests: CapturedRequest[] = [];
  private defaultResponse: MockLLMResponse = {
    content: 'I understand your request.',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  private validateInvariants: boolean;
  private onInvariantViolation?: (violations: InvariantViolation[], request: CapturedRequest) => void;
  private _invariantViolations: InvariantViolation[] = [];

  constructor(options?: MockLLMServerOptions) {
    this.validateInvariants = options?.validateInvariants ?? true;
    this.onInvariantViolation = options?.onInvariantViolation;
  }

  async start(port = 0): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port;
        // Unref the server so it doesn't prevent process exit
        this.server?.unref();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      const server = this.server!;
      this.server = null;

      // Force close all connections
      try {
        server.closeAllConnections?.();
      } catch { /* ignore */ }

      // Close the server
      server.close(() => {
        resolve();
      });

      // Force resolve after timeout to prevent hanging
      setTimeout(() => {
        try { server.close(); } catch { /* ignore */ }
        resolve();
      }, 200);
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Enqueue a response to be returned for the next request.
   * Responses are consumed FIFO. Once the queue is empty, defaultResponse is used.
   */
  enqueueResponse(response: MockLLMResponse): void {
    this.responseQueue.push(response);
  }

  /**
   * Set the default response used when the queue is empty.
   */
  setDefaultResponse(response: MockLLMResponse): void {
    this.defaultResponse = response;
  }

  /**
   * Get all captured requests for assertions.
   */
  getRequests(): CapturedRequest[] {
    return [...this._requests];
  }

  /**
   * Get the last N captured requests.
   */
  getLastRequests(n: number): CapturedRequest[] {
    return this._requests.slice(-n);
  }

  /**
   * Get the most recent request.
   */
  lastRequest(): CapturedRequest | undefined {
    return this._requests[this._requests.length - 1];
  }

  /**
   * Get all invariant violations found during the session.
   */
  getInvariantViolations(): InvariantViolation[] {
    return [...this._invariantViolations];
  }

  /**
   * Clear captured requests, response queue, and violations.
   */
  reset(): void {
    this._requests = [];
    this.responseQueue = [];
    this._invariantViolations = [];
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(body);
    } catch { /* ignore */ }

    const captured = new CapturedRequest(
      Date.now(),
      parsedBody,
      Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
    );
    this._requests.push(captured);

    // Invariant validation
    if (this.validateInvariants) {
      const violations = validateRequestInvariants(captured);
      if (violations.length > 0) {
        this._invariantViolations.push(...violations);
        if (this.onInvariantViolation) {
          this.onInvariantViolation(violations, captured);
        }
      }
    }

    const response = this.responseQueue.length > 0
      ? this.responseQueue.shift()!
      : this.defaultResponse;

    if (response.error) {
      res.writeHead(response.statusCode ?? 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: response.error, type: 'server_error' } }));
      return;
    }

    if (response.delayMs) {
      await new Promise(r => setTimeout(r, response.delayMs));
    }

    const isStreaming = parsedBody.stream === true;

    if (isStreaming) {
      await this.handleStreamingResponse(res, response);
    } else {
      await this.handleSyncResponse(res, response);
    }
  }

  private async handleSyncResponse(res: http.ServerResponse, response: MockLLMResponse): Promise<void> {
    const message: Record<string, unknown> = { role: 'assistant' };

    if (response.toolCalls && response.toolCalls.length > 0) {
      message.content = null;
      message.tool_calls = response.toolCalls.map((tc, i) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
        index: i,
      }));
    } else {
      message.content = response.content ?? '';
    }

    const responseBody = {
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{
        index: 0,
        message,
        finish_reason: response.toolCalls ? 'tool_calls' : 'stop',
      }],
      usage: response.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    res.writeHead(response.statusCode ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  }

  private async handleStreamingResponse(res: http.ServerResponse, response: MockLLMResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendChunk = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const chunkBase = {
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
    };

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        sendChunk({
          ...chunkBase,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        });
        await new Promise(r => setTimeout(r, 5));
      }
      sendChunk({
        ...chunkBase,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
    } else {
      const content = response.content ?? '';
      const words = content.split(' ');
      for (const word of words) {
        sendChunk({
          ...chunkBase,
          choices: [{
            index: 0,
            delta: { content: word + ' ' },
            finish_reason: null,
          }],
        });
        await new Promise(r => setTimeout(r, 2));
      }
      sendChunk({
        ...chunkBase,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    }

    sendChunk({
      ...chunkBase,
      choices: [],
      usage: response.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    res.write('data: [DONE]\n\n');
    res.end();
  }
}
