import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

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
  parts: Array<{ text?: string; inlineData?: unknown }>;
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
      const role = msg.role === 'assistant' ? 'model' : msg.role;
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const finishReason = data.candidates?.[0]?.finishReason ?? 'stop';

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
        finishReason === 'STOP' ? 'stop' : finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
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
  } catch {
    return undefined;
  }
}
