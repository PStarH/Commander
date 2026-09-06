import assert from 'node:assert';
import { describe, it } from 'node:test';
import { AnthropicProvider } from '../../src/runtime/providers/anthropicProvider';
import { OpenAIProvider } from '../../src/runtime/providers/openaiProvider';
import type { LLMProvider, LLMRequest } from '../../src/runtime/types';

const request: LLMRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'private system prompt' },
    { role: 'user', content: 'diff --git a/private.ts b/private.ts' },
  ],
  cacheConfig: { cacheSystemPrompt: false, cacheTools: false, useCacheControl: false },
};

describe('Provider error redaction', () => {
  const cases: Array<{
    name: string;
    provider: LLMProvider;
    apiKey: string;
    status: number;
    expectedMessage: string;
  }> = [
    {
      name: 'OpenAI',
      provider: new OpenAIProvider({ apiKey: 'openai-test-api-key' }),
      apiKey: 'openai-test-api-key',
      status: 401,
      expectedMessage: 'OpenAI API error 401',
    },
    {
      name: 'Anthropic',
      provider: new AnthropicProvider({ apiKey: 'anthropic-test-api-key' }),
      apiKey: 'anthropic-test-api-key',
      status: 429,
      expectedMessage: 'Anthropic API error 429',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} reports only the HTTP status for non-2xx responses`, async () => {
      const originalFetch = global.fetch;
      const responseBody = JSON.stringify({
        authorization: `Bearer ${testCase.apiKey}`,
        apiKey: testCase.apiKey,
        prompt: request.messages[0].content,
        diff: request.messages[1].content,
      });
      global.fetch = (async () =>
        new Response(responseBody, { status: testCase.status })) as typeof fetch;

      try {
        await assert.rejects(
          () => testCase.provider.call(request),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.strictEqual(error.message, testCase.expectedMessage);
            return true;
          },
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  }

  it('rejects an unsafe remote OpenAI base URL', () => {
    assert.throws(
      () =>
        new OpenAIProvider({
          apiKey: 'openai-test-api-key',
          baseUrl: 'http://provider.example.com/v1',
        }),
      /https/,
    );
  });

  for (const testCase of cases) {
    it(`${testCase.name} does not expose malformed success response content`, async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response(`malformed-${testCase.apiKey}-private-diff`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      try {
        await assert.rejects(
          () => testCase.provider.call(request),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.strictEqual(error.message, `${testCase.name} API returned invalid JSON (200)`);
            return true;
          },
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  }
});
