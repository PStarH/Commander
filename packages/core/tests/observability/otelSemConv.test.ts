import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { eventToOtelAttrs, spanNameForEvent, SPAN_KIND_TO_OTEL_KIND, isGenAiSemConvOptIn } from '../../src/observability/otelSemConv';
import type { TraceEvent } from '../../src/runtime/types';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    spanId: 's1', parentSpanId: undefined, traceId: 't1', runId: 'r1', agentId: 'a1',
    type: 'llm_call', timestamp: '2026-06-05T00:00:00.000Z', durationMs: 100,
    data: { modelInfo: { provider: 'openai', model: 'gpt-4o' }, tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    ...overrides,
  };
}

describe('eventToOtelAttrs', () => {
  it('maps LLM call to gen_ai.operation.name=chat', () => {
    const attrs = eventToOtelAttrs(makeEvent(), { agentName: 'agent-1' });
    assert.strictEqual(attrs['gen_ai.operation.name'], 'chat');
    assert.strictEqual(attrs['gen_ai.provider.name'], 'openai');
    assert.strictEqual(attrs['gen_ai.request.model'], 'gpt-4o');
    assert.strictEqual(attrs['gen_ai.usage.input_tokens'], 100);
    assert.strictEqual(attrs['gen_ai.usage.output_tokens'], 50);
    assert.strictEqual(attrs['gen_ai.usage.total_tokens'], 150);
    assert.strictEqual(attrs['gen_ai.agent.id'], 'a1');
    assert.strictEqual(attrs['gen_ai.agent.name'], 'agent-1');
  });

  it('maps tool_execution to execute_tool', () => {
    const e = makeEvent({ type: 'tool_execution', data: { input: 'web_search' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.operation.name'], 'execute_tool');
    assert.strictEqual(attrs['gen_ai.tool.name'], 'web_search');
  });

  it('maps state_change to invoke_agent (as no specific gen_ai op)', () => {
    const e = makeEvent({ type: 'state_change' });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.operation.name'], 'invoke_agent');
  });

  it('includes error attributes for error events', () => {
    const e = makeEvent({ type: 'error', data: { error: 'rate limit' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['error.type'], 'error');
    assert.strictEqual(attrs['error.message'], 'rate limit');
  });

  it('includes conversation.id when provided', () => {
    const attrs = eventToOtelAttrs(makeEvent(), { conversationId: 'conv-1' });
    assert.strictEqual(attrs['gen_ai.conversation.id'], 'conv-1');
  });
});

describe('eventToOtelAttrs (OTel GenAI 1.36+ compliance)', () => {
  it('emits gen_ai.response.id when responseId is set', () => {
    const e = makeEvent({ data: { responseId: 'resp-abc-123', modelInfo: { provider: 'openai', model: 'gpt-4o', tier: 'premium' as any } } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.response.id'], 'resp-abc-123');
  });

  it('emits gen_ai.output.type when outputType is set', () => {
    const e = makeEvent({ data: { outputType: 'tool_call' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.output.type'], 'tool_call');
  });

  it('emits gen_ai.usage.reasoning.output_tokens when reasoningTokens is set', () => {
    const e = makeEvent({ data: { reasoningTokens: 2500 } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.usage.reasoning.output_tokens'], 2500);
  });

  it('emits gen_ai.response.finish_reasons when finishReason is set', () => {
    const e = makeEvent({ data: { finishReason: 'tool_calls' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.response.finish_reasons'], 'tool_calls');
  });

  it('emits server.address when serverAddress is set', () => {
    const e = makeEvent({ data: { serverAddress: 'api.openai.com' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['server.address'], 'api.openai.com');
  });

  it('emits gen_ai.tool.call.id for tool events when toolCallId is set', () => {
    const e = makeEvent({ type: 'tool_execution', data: { input: 'web_search', toolCallId: 'call_42' } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.tool.call.id'], 'call_42');
  });

  it('emits gen_ai.usage.cached_input_tokens when cacheReadTokens > 0', () => {
    const e = makeEvent({ data: { tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cacheReadTokens: 80 } as any } });
    const attrs = eventToOtelAttrs(e, {});
    assert.strictEqual(attrs['gen_ai.usage.cached_input_tokens'], 80);
  });

  it('omits cached_input_tokens when cacheReadTokens is 0 or missing', () => {
    const attrs = eventToOtelAttrs(makeEvent(), {});
    assert.strictEqual(attrs['gen_ai.usage.cached_input_tokens'], undefined);
  });
});

describe('isGenAiSemConvOptIn', () => {
  const original = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  before(() => { delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN; });
  after(() => { if (original !== undefined) process.env.OTEL_SEMCONV_STABILITY_OPT_IN = original; });

  it('defaults to enabled (true) when env var is unset', () => {
    delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    assert.strictEqual(isGenAiSemConvOptIn(), true);
  });

  it('returns true when env var contains "gen_ai"', () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai';
    assert.strictEqual(isGenAiSemConvOptIn(), true);
  });

  it('returns true when env var contains "all"', () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'all';
    assert.strictEqual(isGenAiSemConvOptIn(), true);
  });

  it('returns true when env var lists gen_ai among multiple', () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http,gen_ai,database';
    assert.strictEqual(isGenAiSemConvOptIn(), true);
  });

  it('returns false when env var is set to a non-matching value', () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http,database';
    assert.strictEqual(isGenAiSemConvOptIn(), false);
  });
});

describe('spanNameForEvent', () => {
  it('produces "chat <model>" for LLM events', () => {
    assert.strictEqual(spanNameForEvent(makeEvent()), 'chat gpt-4o');
  });
  it('produces "execute_tool <name>" for tool events', () => {
    assert.strictEqual(spanNameForEvent(makeEvent({ type: 'tool_execution', data: { input: 'shell' } })), 'execute_tool shell');
  });
  it('produces "invoke_agent <id>" for state change', () => {
    assert.strictEqual(spanNameForEvent(makeEvent({ type: 'state_change', agentId: 'a-1' })), 'invoke_agent a-1');
  });
});

describe('SPAN_KIND_TO_OTEL_KIND', () => {
  it('maps LLM/EMBEDDING/RETRIEVER to internal (3), others to span (1)', () => {
    assert.strictEqual(SPAN_KIND_TO_OTEL_KIND.LLM, 3);
    assert.strictEqual(SPAN_KIND_TO_OTEL_KIND.EMBEDDING, 3);
    assert.strictEqual(SPAN_KIND_TO_OTEL_KIND.RETRIEVER, 3);
    assert.strictEqual(SPAN_KIND_TO_OTEL_KIND.AGENT, 1);
    assert.strictEqual(SPAN_KIND_TO_OTEL_KIND.TOOL, 1);
  });
});
