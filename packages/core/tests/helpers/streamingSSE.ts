/**
 * Streaming SSE Server — gated, per-chunk delivery for testing.
 *
 * Inspired by Codex CLI's StreamingSseServer: a raw TCP HTTP server that
 * gives tests precise control over when each SSE chunk is delivered.
 *
 * Each chunk can have an optional gate (a Promise) that must resolve before
 * the chunk is sent. This allows tests to:
 * - Verify partial rendering mid-stream
 * - Test backpressure handling
 * - Simulate slow network conditions
 * - Test timeout behavior during streaming
 *
 * Usage:
 *   const server = new StreamingSSEServer();
 *   const gate1 = createGate();
 *   const gate2 = createGate();
 *
 *   server.enqueueResponse([
 *     { event: 'delta', data: { content: 'Hello' }, gate: gate1.promise },
 *     { event: 'delta', data: { content: ' world' }, gate: gate2.promise },
 *     { event: 'done', data: { finish_reason: 'stop' } },
 *   ]);
 *
 *   await server.start();
 *   // ... start agent code ...
 *   gate1.resolve(); // First chunk delivered
 *   // ... verify partial state ...
 *   gate2.resolve(); // Second chunk delivered
 *   await server.stop();
 */
import * as http from 'http';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SSEChunk {
  /** Event type (maps to SSE 'event:' field) */
  event?: string;
  /** Data payload (will be JSON.stringify'd) */
  data: Record<string, unknown> | string;
  /** Optional gate — chunk waits for this promise before sending */
  gate?: Promise<void>;
  /** Optional delay in ms before sending (after gate resolves) */
  delayMs?: number;
}

export interface StreamingResponse {
  /** Chunks to send in order */
  chunks: SSEChunk[];
  /** Optional HTTP status code (default 200) */
  statusCode?: number;
  /** Optional headers */
  headers?: Record<string, string>;
}

export interface CapturedStreamingRequest {
  timestamp: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Create a gate that can be resolved externally.
 * Returns { promise, resolve, reject }.
 */
export function createGate(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Streaming SSE Server ────────────────────────────────────────────────────

export interface StreamingSSEServerOptions {
  /** Default response when queue is empty */
  defaultResponse?: StreamingResponse;
  /** Whether to record requests */
  captureRequests?: boolean;
}

export class StreamingSSEServer {
  private server: http.Server | null = null;
  private port = 0;
  private responseQueue: StreamingResponse[] = [];
  private _requests: CapturedStreamingRequest[] = [];
  private _completionCallbacks: Array<{ resolve: () => void; promise: Promise<void> }> = [];
  private _activeStreams = 0;
  private _defaultResponse: StreamingResponse;
  private captureRequests: boolean;

  constructor(options?: StreamingSSEServerOptions) {
    this._defaultResponse = options?.defaultResponse ?? {
      chunks: [{ data: { content: '' } }],
    };
    this.captureRequests = options?.captureRequests ?? true;
  }

  async start(port = 0): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port;
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

      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }

      server.close(() => resolve());

      // Force resolve after timeout
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        resolve();
      }, 200);
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Number of currently active (in-progress) streams */
  get activeStreams(): number {
    return this._activeStreams;
  }

  /**
   * Enqueue a streaming response.
   * Each response is consumed FIFO.
   */
  enqueueResponse(response: StreamingResponse): void {
    this.responseQueue.push(response);
  }

  /**
   * Enqueue a simple SSE response with text content split into chunks.
   */
  enqueueTextChunks(text: string, chunkSize = 5): void {
    const words = text.split(' ');
    const chunks: SSEChunk[] = [];

    for (let i = 0; i < words.length; i += chunkSize) {
      const slice = words.slice(i, i + chunkSize).join(' ') + ' ';
      chunks.push({
        data: {
          id: `chatcmpl-stream-${Date.now()}`,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: { content: slice },
              finish_reason: null,
            },
          ],
        },
      });
    }

    // Final chunk
    chunks.push({
      data: {
        id: `chatcmpl-stream-${Date.now()}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    });

    // Usage chunk
    chunks.push({
      data: {
        id: `chatcmpl-stream-${Date.now()}`,
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
    });

    this.enqueueResponse({ chunks });
  }

  /**
   * Enqueue a tool call streaming response.
   */
  enqueueToolCallChunks(toolCalls: Array<{ id: string; name: string; arguments: string }>): void {
    const chunks: SSEChunk[] = [];

    for (const tc of toolCalls) {
      chunks.push({
        data: {
          id: `chatcmpl-stream-${Date.now()}`,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      });
    }

    // Finish chunk
    chunks.push({
      data: {
        id: `chatcmpl-stream-${Date.now()}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    });

    this.enqueueResponse({ chunks });
  }

  /**
   * Get all captured requests.
   */
  getRequests(): CapturedStreamingRequest[] {
    return [...this._requests];
  }

  /**
   * Get the last captured request.
   */
  lastRequest(): CapturedStreamingRequest | undefined {
    return this._requests[this._requests.length - 1];
  }

  /**
   * Wait for all active streams to complete.
   */
  async waitForAllStreams(timeoutMs = 5000): Promise<void> {
    if (this._activeStreams === 0) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for streams after ${timeoutMs}ms`));
      }, timeoutMs);

      const check = () => {
        if (this._activeStreams === 0) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  /**
   * Create a completion callback that resolves when the next stream finishes.
   */
  createCompletionCallback(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this._completionCallbacks.push({ resolve, promise });
    return { promise, resolve };
  }

  /**
   * Clear captured requests and response queue.
   */
  reset(): void {
    this._requests = [];
    this.responseQueue = [];
    this._completionCallbacks = [];
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(body);
    } catch {
      /* ignore */
    }

    if (this.captureRequests) {
      this._requests.push({
        timestamp: Date.now(),
        body: parsedBody,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      });
    }

    // Handle /v1/models
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
        }),
      );
      return;
    }

    const response =
      this.responseQueue.length > 0 ? this.responseQueue.shift()! : this._defaultResponse;

    await this.handleStreamingResponse(res, response);
  }

  private async handleStreamingResponse(
    res: http.ServerResponse,
    response: StreamingResponse,
  ): Promise<void> {
    this._activeStreams++;

    res.writeHead(response.statusCode ?? 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...response.headers,
    });

    try {
      for (const chunk of response.chunks) {
        // Wait for gate if provided
        if (chunk.gate) {
          await chunk.gate;
        }

        // Apply delay if specified
        if (chunk.delayMs) {
          await new Promise((r) => setTimeout(r, chunk.delayMs));
        }

        // Format and send SSE event
        const eventType = chunk.event ?? 'message';
        const data = typeof chunk.data === 'string' ? chunk.data : JSON.stringify(chunk.data);

        res.write(`event: ${eventType}\ndata: ${data}\n\n`);
      }

      // Send final [DONE] marker
      res.write('data: [DONE]\n\n');
    } catch (err) {
      // Stream was interrupted
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
      res.end();
      this._activeStreams--;

      // Notify completion callbacks
      if (this._completionCallbacks.length > 0) {
        const cb = this._completionCallbacks.shift();
        cb?.resolve();
      }
    }
  }
}

// ── Streaming Test Helpers ──────────────────────────────────────────────────

/**
 * Helper to create OpenAI-compatible SSE chunks for text content.
 */
export function makeTextSSEChunks(content: string): SSEChunk[] {
  const words = content.split(' ');
  const chunks: SSEChunk[] = words.map((word) => ({
    data: {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { content: word + ' ' },
          finish_reason: null,
        },
      ],
    },
  }));

  // Stop chunk
  chunks.push({
    data: {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  });

  return chunks;
}

/**
 * Helper to create OpenAI-compatible SSE chunks for tool calls.
 */
export function makeToolCallSSEChunks(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): SSEChunk[] {
  const chunks: SSEChunk[] = toolCalls.map((tc) => ({
    data: {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  }));

  chunks.push({
    data: {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  });

  return chunks;
}
