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
  it('Anthropic uses the current Sonnet model when none is requested', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = new AnthropicProvider({ apiKey: 'anthropic-test-api-key' });
    try {
      await provider.call({ messages: [{ role: 'user', content: 'review' }] });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal((requestBody as { model?: unknown }).model, 'claude-sonnet-4-6');
  });

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

  for (const testCase of cases) {
    it(`${testCase.name} rejects and cancels an oversized successful response before parsing it`, async () => {
      const originalFetch = global.fetch;
      const encoder = new TextEncoder();
      let cancelled = false;
      const oversizedBody = JSON.stringify({
        choices: [
          {
            message: { content: 'x'.repeat(8 * 1024 * 1024) },
            finish_reason: 'stop',
          },
        ],
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(oversizedBody));
        },
        cancel() {
          cancelled = true;
        },
      });
      global.fetch = (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      try {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            assert.rejects(() => testCase.provider.call(request), /PAYLOAD_TOO_LARGE:.*8388608/),
            new Promise<void>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('oversized response was not stopped')),
                50,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        assert.strictEqual(cancelled, true);
      } finally {
        global.fetch = originalFetch;
      }
    });
  }
});
