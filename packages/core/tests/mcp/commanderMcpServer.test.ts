import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HarnessServices } from '../../src/harness/harnessTypes';
import { CommanderMcpServer } from '../../src/mcp/commanderMcpServer';
import { runWithTenant } from '../../src/runtime/tenantContext';
import type {
  LLMRequest,
  LLMResponse,
  Tool,
  ToolDefinition,
  ToolResult,
} from '../../src/runtime/types';

type TrackedCall<TArgs extends unknown[], TResult> = ((...args: TArgs) => TResult) & {
  calls: TArgs[];
};

function tracked<TArgs extends unknown[], TResult>(
  implementation: (...args: TArgs) => TResult,
): TrackedCall<TArgs, TResult> {
  const calls: TArgs[] = [];
  const fn = (...args: TArgs): TResult => {
    calls.push(args);
    return implementation(...args);
  };
  return Object.assign(fn, { calls });
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
  };
}

function createTool(name: string): Tool & {
  execute: TrackedCall<[Record<string, unknown>], Promise<string>>;
} {
  return {
    definition: toolDefinition(name),
    execute: tracked(async () => `${name} result`),
  };
}

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: 'Done',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
    model: 'test-model',
    provider: 'test-provider',
    ...overrides,
  };
}

function createServices(
  tools: Tool[],
  responses: LLMResponse[] = [response()],
): {
  services: HarnessServices;
  providerCall: TrackedCall<[LLMRequest], Promise<LLMResponse>>;
  beforeToolCall: TrackedCall<
    [Parameters<HarnessServices['fireBeforeToolCall']>[0]],
    Promise<{ blocked: boolean; error?: string }>
  >;
  afterToolCall: TrackedCall<
    [Parameters<HarnessServices['fireAfterToolCall']>[0]],
    Promise<ToolResult>
  >;
} {
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  let responseIndex = 0;
  const providerCall = tracked(async (_request: LLMRequest) => {
    const next = responses[responseIndex] ?? responses.at(-1);
    responseIndex += 1;
    assert.ok(next, 'A mock provider response must be configured');
    return next;
  });
  const beforeToolCall = tracked(async () => ({ blocked: false }));
  const afterToolCall = tracked(async (ctx) => ctx.result);

  const services = {
    getProvider: tracked(() => ({ name: 'test-provider', call: providerCall })),
    getTool: tracked((name: string) => toolsByName.get(name)),
    getToolDefinition: tracked((name: string) => toolsByName.get(name)?.definition),
    listTools: tracked(() => [...toolsByName.keys()]),
    fireBeforeLLMCall: tracked(async (ctx) => ctx.request),
    fireAfterLLMCall: tracked(async () => undefined),
    fireBeforeToolCall: beforeToolCall,
    fireAfterToolCall: afterToolCall,
  } as unknown as HarnessServices;

  return { services, providerCall, beforeToolCall, afterToolCall };
}

function createServer(services: HarnessServices, allowedTools: readonly string[]) {
  return new CommanderMcpServer({
    services,
    tenantId: 'tenant-a',
    allowedTools,
    maxSteps: 2,
  });
}

describe('CommanderMcpServer nested tool capability boundary', () => {
  it('rejects a registry tool outside the configured allowlist before provider or tool execution', async () => {
    const privileged = createTool('privileged');
    const { services, providerCall } = createServices(
      [privileged],
      [
        response({
          toolCalls: [{ id: 'call-1', name: 'privileged', arguments: {} }],
          finishReason: 'tool_use',
        }),
      ],
    );
    const server = createServer(services, []);

    await assert.rejects(
      runWithTenant('tenant-a', () =>
        server.executeGoal({ goal: 'Escalate', availableTools: ['privileged'] }),
      ),
      /not allowed/i,
    );
    assert.equal(providerCall.calls.length, 0);
    assert.equal(privileged.execute.calls.length, 0);
  });

  it('rejects an unknown configured tool before the provider loop', async () => {
    const { services, providerCall } = createServices([]);
    const server = createServer(services, ['missing']);

    await assert.rejects(
      runWithTenant('tenant-a', () =>
        server.executeGoal({ goal: 'Use missing tool', availableTools: ['missing'] }),
      ),
      /unknown tool/i,
    );
    assert.equal(providerCall.calls.length, 0);
  });

  it('rejects a tenant mismatch before provider or tool execution', async () => {
    const allowed = createTool('allowed');
    const { services, providerCall } = createServices([allowed]);
    const server = createServer(services, ['allowed']);

    await assert.rejects(
      runWithTenant('tenant-b', () => server.executeGoal({ goal: 'Cross tenant' })),
      /tenant/i,
    );
    assert.equal(providerCall.calls.length, 0);
    assert.equal(allowed.execute.calls.length, 0);
  });

  it('defaults to configured tools and preserves tool hooks for allowed execution', async () => {
    const allowed = createTool('allowed');
    const privileged = createTool('privileged');
    const { services, providerCall, beforeToolCall, afterToolCall } = createServices(
      [allowed, privileged],
      [
        response({
          content: 'Calling allowed tool',
          toolCalls: [{ id: 'call-1', name: 'allowed', arguments: { input: 'ok' } }],
          finishReason: 'tool_use',
        }),
        response(),
      ],
    );
    const server = createServer(services, ['allowed']);

    const result = await runWithTenant('tenant-a', () =>
      server.executeGoal({ goal: 'Use the allowed tool' }),
    );

    assert.equal(result.status, 'success');
    assert.deepEqual(
      providerCall.calls[0][0].tools?.map((definition) => definition.name),
      ['allowed'],
    );
    assert.equal(allowed.execute.calls.length, 1);
    assert.equal(privileged.execute.calls.length, 0);
    assert.equal(beforeToolCall.calls.length, 1);
    assert.equal(afterToolCall.calls.length, 1);
  });
});
