import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  private responseMap: Map<string, string>;
  private defaultResponse: string;
  public callCount = 0;
  public lastRequest: LLMRequest | null = null;

  constructor(
    name = 'mock',
    options?: {
      responses?: Record<string, string>;
      defaultResponse?: string;
    },
  ) {
    this.name = name;
    this.responseMap = new Map(Object.entries(options?.responses ?? {}));
    this.defaultResponse = options?.defaultResponse ?? 'Mock LLM response for: ' + name;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;

    const userMsg = request.messages.find(m => m.role === 'user');
    const key = userMsg?.content ?? '';
    const content = this.responseMap.get(key) ?? this.defaultResponse;

    const promptTokens = JSON.stringify(request.messages).length;
    const completionTokens = content.length;

    return {
      content,
      model: request.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: 'stop',
    };
  }

  setResponse(input: string, output: string): void {
    this.responseMap.set(input, output);
  }

  setDefaultResponse(output: string): void {
    this.defaultResponse = output;
  }

  reset(): void {
    this.callCount = 0;
    this.lastRequest = null;
  }
}

export function createMockProvider(
  name = 'mock',
  defaultResponse?: string,
): MockLLMProvider {
  return new MockLLMProvider(name, { defaultResponse });
}

export function createMockProviderWithTools(): MockLLMProvider {
  return new MockLLMProvider('mock-with-tools', {
    defaultResponse: 'I will use the available tools to complete this task.',
  });
}
