import { reportSilentFailure } from '../../silentFailureReporter';
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from '../types';
import { FormatBridge } from '../formatBridge';

/**
 * Optional Google Gemini cachedContent wiring.
 * When `cachedContentName` is present in `request.cacheConfig`, the provider references
 * the server-side cached content resource (created via POST /v1beta/cachedContents) in the
 * generateContent body, achieving 90% cost reduction on cached tokens (>4K token payloads).
 * See geminiCacheManager.ts for the lifecycle manager that creates these names.
 */
export interface GeminiCacheConfig {
  /** Server-side cached content resource name (e.g. "cachedContents/abc123"). */
  cachedContentName?: string;
}

interface GeminiContent {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: unknown;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: unknown };
  }>;
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GoogleProvider implements LLMProvider {
  readonly name = 'google';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.defaultModel = config.defaultModel ?? 'gemini-2.0-flash';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const contents = this.buildContents(request);
    const systemInstruction = this.buildSystemInstruction(request);

    const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
        temperature: request.temperature ?? 0.7,
      },
    };
    if (systemInstruction) {
      body.system_instruction = { parts: [{ text: systemInstruction }] };
    }

    // Provider-native structured output (Gemini responseSchema)
    if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
      (body.generationConfig as Record<string, unknown>).responseSchema =
        request.responseFormat.schema;
    } else if (request.responseFormat?.type === 'json_object') {
      (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
    }

    // Gemini cachedContent wiring: when a server-side cached content name is provided in
    // cacheConfig, reference it instead of inline contents. This is a >4K token optimization;
    // cached tokens are billed at 90% discount. The system instruction and tools can stay
    // inline as well — Gemini deduplicates them against the cached content.
    const cachedContentName = request.cacheConfig?.geminiCachedContentName;
    if (cachedContentName) {
      body.cachedContent = cachedContentName;
    }

    // Tools: Gemini uses function_declarations wrapped in an outer tools array
    if (request.tools && request.tools.length > 0) {
      body.tools = FormatBridge.adaptToolsForProvider(request.tools, 'google');
      // Gemini requires tool_config for parallel function calling
      body.tool_config = { function_calling_config: { mode: 'auto' } };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${err}`);
    }

    const data: GeminiResponse = await response.json();
    return this.parseResponse(data, model, request.responseFormat);
  }

  private buildContents(request: LLMRequest): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      const role = msg.role === 'assistant' ? 'model' : msg.role === 'tool' ? 'user' : msg.role;
      const parts: GeminiContent['parts'] = [];

      if (msg.role === 'tool') {
        // Tool results: Gemini expects functionResponse parts with role 'user'
        const toolName = msg.name ?? 'unknown_tool';
        let responsePayload: unknown;
        try {
          responsePayload = JSON.parse(msg.content);
        } catch (err) {
          reportSilentFailure(err, 'googleProvider:126');
          responsePayload = { result: msg.content };
        }
        parts.push({
          functionResponse: {
            name: toolName,
            response: responsePayload,
          },
        });
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant tool calls: convert to functionCall parts
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (err) {
            reportSilentFailure(err, 'googleProvider:142');
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
      } else {
        parts.push({ text: msg.content });
      }

      contents.push({ role, parts });
    }

    return contents;
  }

  private buildSystemInstruction(request: LLMRequest): string | undefined {
    const sysMsg = request.messages.find((m) => m.role === 'system');
    return sysMsg?.content;
  }

  private parseResponse(
    data: GeminiResponse,
    model: string,
    responseFormat?: LLMRequest['responseFormat'],
  ): LLMResponse {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.find((p) => p.text)?.text ?? '';
    const finishReason = candidate?.finishReason ?? 'STOP';

    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: `call_google_${Date.now()}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    const usage = data.usageMetadata ?? {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    const parsed = tryParseGeminiResponse(text, responseFormat);

    return {
      content: text,
      model,
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      },
      finishReason:
        finishReason === 'STOP'
          ? toolCalls.length > 0
            ? 'tool_calls'
            : 'stop'
          : finishReason === 'MAX_TOKENS'
            ? 'length'
            : finishReason === 'TOOL_CALLS'
              ? 'tool_calls'
              : finishReason === 'SAFETY' ||
                  finishReason === 'RECITATION' ||
                  finishReason === 'OTHER'
                ? 'error'
                : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      parsed,
    };
  }
}

function tryParseGeminiResponse(
  content: string,
  responseFormat?: LLMRequest['responseFormat'],
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === 'text' || !content.trim()) return undefined;

  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    reportSilentFailure(err, 'googleProvider:236');
    return undefined;
  }
}
