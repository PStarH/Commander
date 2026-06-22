import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  TokenUsage,
  CacheConfig,
  ReasoningConfig,
} from '../types';
import { FormatBridge } from '../formatBridge';
import { getGlobalLogger } from '../../logging';

interface OpenAICompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type: string;
        function: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAICompletionUsage;
}

/**
 * MiMo Provider — Xiaomi's reasoning model API.
 * Endpoint: https://token-plan-sgp.xiaomimimo.com/v1
 * Models: mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni
 *
 * MiMo-specific behavior:
 * - Reasoning models return `reasoning_content` field that MUST be passed back
 *   on follow-up calls to maintain chain-of-thought continuity.
 * - Uses OpenAI-compatible chat completions format.
 */
export class MiMoProvider implements LLMProvider {
  readonly name = 'mimo';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://token-plan-sgp.xiaomimimo.com/v1';
    this.defaultModel = config.defaultModel ?? 'mimo-v2.5';
  }

  private static readonly MAX_RETRIES = 4;
  private static readonly BASE_DELAY_MS = 2000;

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = this.defaultModel || request.model;
    const body = this.buildBody(request, model);

    // MiMo: pass back reasoning_content from previous responses
    const lastAssistant = [...request.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant?.tool_calls) {
      body.tool_calls = lastAssistant.tool_calls;
    }

    const useStreaming = request.cacheConfig?.useCacheControl ?? true;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MiMoProvider.MAX_RETRIES; attempt++) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ ...body, stream: useStreaming }),
      });

      if (response.ok) {
        if (useStreaming) {
          return this.handleStreamingResponse(response, model);
        }
        const data = await response.json();
        return this.parseResponse(data, model);
      }

      const err = await response.text();
      lastError = new Error(`MiMo API error ${response.status}: ${err}`);

      // Only retry on 429 (rate limit) and 503 (service unavailable)
      if (response.status !== 429 && response.status !== 503) {
        throw lastError;
      }

      if (attempt < MiMoProvider.MAX_RETRIES) {
        // Exponential backoff with jitter: 2s, 4s, 8s, 16s + random 0-1s
        const delay = MiMoProvider.BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
        getGlobalLogger().warn(
          'MiMoProvider',
          `Rate limited (${response.status}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MiMoProvider.MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  private buildBody(request: LLMRequest, model: string): Record<string, unknown> {
    const messages = request.messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      // Critical: pass reasoning_content for MiMo chain-of-thought continuity
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      if (m.name) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      return msg;
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    // Apply reasoning/thinking configuration
    // MiMo reasoning API supports enable_thinking + reasoning_effort for
    // models that have thinking capability.
    const rc = request.reasoningConfig;
    if (rc?.enabled) {
      body.enable_thinking = true;
      if (rc.effort) body.reasoning_effort = rc.effort;
      if (rc.budget && rc.budget > 0) body.max_thinking_tokens = rc.budget;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = FormatBridge.adaptToolsForProvider(request.tools, 'mimo');
      body.parallel_tool_calls = true;
    }

    return body;
  }

  private async handleStreamingResponse(response: Response, model: string): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('MiMo: No response body from streaming endpoint');

    let content = '';
    let reasoningContent = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentTool: { id: string; name: string; arguments: string } | null = null;
    let usage: OpenAICompletionUsage | null = null;
    let finishReason: string | null = null;
    let buffer = '';

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') break;

        try {
          const chunk: OpenAIStreamChunk = JSON.parse(jsonStr);
          if (chunk.usage) usage = chunk.usage;

          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (delta.content) content += delta.content;
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  currentTool = { id: tc.id, name: tc.function?.name ?? '', arguments: '' };
                  toolCalls.push(currentTool);
                }
                if (currentTool && tc.function?.arguments) {
                  currentTool.arguments += tc.function.arguments;
                }
              }
            }
          }
        } catch (e) {
          getGlobalLogger().debug('MiMoProvider', 'Skipping malformed stream chunk', {
            error: (e as Error)?.message,
          });
        }
      }
    }

    const tokenUsage: TokenUsage = usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // MiMo streaming may also return text-format tool calls
    if ((!toolCalls || toolCalls.length === 0) && content.includes('<tool_call>')) {
      const parsed = parseMiMoTextToolCalls(content);
      if (parsed.length > 0) {
        toolCalls = parsed.map((p) => ({
          id: p.id,
          name: p.name,
          arguments: JSON.stringify(p.arguments),
        }));
        content = '';
      }
    }

    // MiMo reasoning model sometimes puts everything in reasoning_content
    // leaving content empty. Merge so AgentRuntime can read it.
    if (!content && reasoningContent) {
      content = reasoningContent;
    }

    return {
      content,
      model,
      usage: tokenUsage,
      finishReason:
        finishReason === 'stop'
          ? 'stop'
          : finishReason === 'tool_calls'
            ? 'tool_calls'
            : finishReason === 'length'
              ? 'length'
              : 'stop',
      toolCalls:
        toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.arguments || '{}'),
            }))
          : undefined,
      reasoning_content: reasoningContent || undefined,
    };
  }

  private parseResponse(
    data: {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          reasoning_content?: string;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    },
    model: string,
  ): LLMResponse {
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};

    const tokenUsage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    let content = message.content ?? '';
    let toolCalls = message.tool_calls?.map(
      (tc: { id: string; function: { name: string; arguments: string } }) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
      }),
    );

    // MiMo sometimes returns tool calls as text: <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
    if ((!toolCalls || toolCalls.length === 0) && content.includes('<tool_call>')) {
      const parsed = parseMiMoTextToolCalls(content);
      if (parsed.length > 0) {
        toolCalls = parsed;
        content = ''; // tool calls consumed, no text response
      }
    }

    // Same merge as in streaming handler: MiMo reasoning model puts
    // output in reasoning_content leaving content empty.
    if (!content && message.reasoning_content) {
      content = message.reasoning_content;
    }

    return {
      content,
      model,
      usage: tokenUsage,
      finishReason:
        choice?.finish_reason === 'stop'
          ? 'stop'
          : choice?.finish_reason === 'tool_calls'
            ? 'tool_calls'
            : choice?.finish_reason === 'length'
              ? 'length'
              : 'stop',
      toolCalls,
      reasoning_content: message.reasoning_content,
    };
  }
}

/**
 * Parse MiMo's text-format tool calls into structured format.
 *
 * Input:  "<tool_call>\n<function=web_search>\n<parameter=query>AI news</parameter>\n</function>\n</tool_call>"
 * Output: [{ id: "call_xxx", name: "web_search", arguments: { query: "AI news" } }]
 */
export function parseMiMoTextToolCalls(
  content: string,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  // Split by <tool_call> blocks
  const blocks = content.split('<tool_call>').slice(1);
  for (const block of blocks) {
    const endTag = '</tool_call>';
    const blockContent = block.includes(endTag) ? block.split(endTag)[0] : block;

    // Extract function name: <function=name> or <function_name>
    const funcMatch = blockContent.match(/<function[=_]([^>]+)>/);
    if (!funcMatch) continue;
    const name = funcMatch[1].trim();

    // Extract parameters: <parameter=key>value</parameter>
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(blockContent)) !== null) {
      args[paramMatch[1].trim()] = paramMatch[2].trim();
    }

    results.push({
      id: `call_mimo_${Date.now()}_${results.length}`,
      name,
      arguments: args,
    });
  }
  return results;
}
