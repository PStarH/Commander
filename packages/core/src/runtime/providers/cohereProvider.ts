import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage } from '../types';
import { getGlobalLogger } from '../../logging';

interface CohereContent {
  type: 'text';
  text: string;
}

interface CohereMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | CohereContent[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface CohereToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

interface CohereUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Cohere Provider — Cohere's native API.
 *
 * Endpoint (chat): https://api.cohere.com/v2/chat
 * Models: command-a-plus-05-2026, command-a-03-2025, command-r-08-2024, command-r-plus-08-2024
 *
 * Cohere uses a multi-turn chat format with tool support.
 * This adapter maps Commander's LLMRequest to Cohere's API.
 *
 * Env: CO_API_KEY (primary, official Python SDK default)
 *       COHERE_API_KEY (fallback)
 *       COHERE_BASE_URL (optional)
 *       COHERE_MODEL (optional)
 */
export class CohereProvider implements LLMProvider {
  readonly name = 'cohere';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = config.apiKey || process.env.CO_API_KEY || process.env.COHERE_API_KEY || '';
    this.baseUrl = config.baseUrl ?? process.env.COHERE_BASE_URL ?? 'https://api.cohere.com';
    this.defaultModel = config.defaultModel ?? process.env.COHERE_MODEL ?? 'command-a-plus-05-2026';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const body = this.buildBody(request, model);

    const response = await fetch(`${this.baseUrl}/v2/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(request.cacheConfig?.useCacheControl ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return this.parseResponse(data, model);
  }

  private buildBody(request: LLMRequest, model: string): Record<string, unknown> {
    // Cohere v2 chat format: separate system message, then messages array
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const otherMessages = request.messages.filter((m) => m.role !== 'system');

    const messages: CohereMessage[] = otherMessages.map((m) => {
      const msg: CohereMessage = {
        role: m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user',
        content: m.content,
      };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      return msg;
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;

    // Map tools to Cohere's tool format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameter_definitions: this.cohereParameterDefs(t.inputSchema),
      }));
    }

    return body;
  }

  private cohereParameterDefs(schema: Record<string, unknown>): Record<string, unknown> {
    // Cohere expects flat parameter_definitions
    const props = (schema.properties as Record<string, unknown>) || {};
    const defs: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      const prop = val as Record<string, unknown>;
      defs[key] = {
        description: prop.description || '',
        type: prop.type || 'string',
        required: (schema.required as string[])?.includes(key) || false,
      };
    }
    return defs;
  }

  private parseResponse(
    data: {
      finish_reason?: string;
      message?: {
        content?: Array<{ text?: string }> | string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
          name?: string;
          parameters?: unknown;
        }>;
      };
      usage?: { input_tokens?: number; output_tokens?: number };
      input_tokens?: number;
      output_tokens?: number;
      meta?: { billed_units?: { input_tokens?: number; output_tokens?: number } };
    },
    model: string,
  ): LLMResponse {
    const message = data.message || {};
    const content = Array.isArray(message.content)
      ? (message.content[0]?.text ?? '')
      : typeof message.content === 'string'
        ? message.content
        : '';

    // Parse tool calls
    const toolCalls: CohereToolCall[] = (message.tool_calls || []).map(
      (tc: {
        id?: string;
        function?: { name?: string; arguments?: unknown };
        name?: string;
        parameters?: unknown;
      }) => ({
        id: tc.id || `call_${Date.now()}`,
        type: 'function' as const,
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: (tc.function?.arguments || tc.parameters || {}) as Record<string, unknown>,
        },
      }),
    );

    const usage: TokenUsage = {
      promptTokens:
        data.usage?.input_tokens ?? data.input_tokens ?? data.meta?.billed_units?.input_tokens ?? 0,
      completionTokens:
        data.usage?.output_tokens ??
        data.output_tokens ??
        data.meta?.billed_units?.output_tokens ??
        0,
      totalTokens: 0,
    };
    usage.totalTokens = usage.promptTokens + usage.completionTokens;

    return {
      content,
      model,
      usage,
      finishReason:
        data.finish_reason === 'COMPLETE'
          ? 'stop'
          : data.finish_reason === 'MAX_TOKENS'
            ? 'length'
            : data.finish_reason === 'ERROR'
              ? 'error'
              : 'stop',
      toolCalls:
        toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            }))
          : undefined,
    };
  }
}
