import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

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

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
  }) {
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
    return this.parseResponse(data, model);
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
    const sysMsg = request.messages.find(m => m.role === 'system');
    return sysMsg?.content;
  }

  private parseResponse(data: GeminiResponse, model: string): LLMResponse {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const finishReason = data.candidates?.[0]?.finishReason ?? 'stop';

    const usage = data.usageMetadata ?? { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

    return {
      content: text,
      model,
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      },
      finishReason: finishReason === 'STOP' ? 'stop' : finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    };
  }
}
