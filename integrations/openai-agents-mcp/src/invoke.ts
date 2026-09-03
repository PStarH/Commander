import { Agent, MCPServerStdio, OpenAIProvider, Runner } from '@openai/agents';
import {
  invokeCommanderToolInputSchema,
  type InvokeCommanderToolInput,
  type InvokeCommanderToolResult,
} from './contracts';
import { DeterministicToolModel } from './deterministicModel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseGatewayPayload(output: unknown): unknown {
  if (Array.isArray(output)) {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const item = output[index];
      if (isRecord(item) && typeof item.text === 'string') {
        return parseGatewayPayload(item.text);
      }
    }
    throw new Error('AGENT_FINAL_OUTPUT_INVALID');
  }
  if (typeof output !== 'string') throw new Error('AGENT_FINAL_OUTPUT_INVALID');
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parseGatewayPayload(parsed);
    if (isRecord(parsed) && parsed.type === 'text' && typeof parsed.text === 'string') {
      return parseGatewayPayload(parsed.text);
    }
    return parsed;
  } catch {
    throw new Error('MCP_TOOL_RESULT_JSON_INVALID');
  }
}

export async function invokeCommanderTool(
  rawInput: InvokeCommanderToolInput,
): Promise<InvokeCommanderToolResult> {
  const input = invokeCommanderToolInputSchema.parse(rawInput);
  const server = new MCPServerStdio({
    command: input.mcpCommand,
    args: input.mcpArgs,
    cwd: input.mcpCwd,
    env: input.mcpEnv,
    cacheToolsList: true,
    clientSessionTimeoutSeconds: Math.ceil(input.timeoutMs / 1_000),
    timeout: input.timeoutMs,
    name: 'commander',
    errorFunction: null,
  });

  await server.connect();
  try {
    const tools = await server.listTools();
    const discoveredTools = tools.map(({ name }) => name).sort();
    if (!discoveredTools.includes(input.toolName)) {
      throw new Error('MCP_TOOL_NOT_DISCOVERED:' + input.toolName);
    }

    if (input.mode === 'live' && !input.model) throw new Error('LIVE_MODEL_REQUIRED');
    const model =
      input.mode === 'deterministic'
        ? new DeterministicToolModel(input.toolName, input.args)
        : await new OpenAIProvider({
            ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
            ...(input.modelBaseUrl ? { baseURL: input.modelBaseUrl } : {}),
            useResponses: input.modelApi !== 'chat_completions',
          }).getModel(input.model);
    const agent = new Agent({
      name: 'Commander external integration agent',
      instructions: 'Call ' + input.toolName + ' exactly once with the supplied arguments.',
      model,
      mcpServers: [server],
      modelSettings: {
        parallelToolCalls: false,
        ...(input.mode === 'live' ? { toolChoice: input.toolName } : {}),
      },
      ...(input.mode === 'live' ? { toolUseBehavior: 'stop_on_first_tool' } : {}),
    });
    const runner = new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
    const result = await runner.run(
      agent,
      input.mode === 'live'
        ? 'Call ' + input.toolName + ' with exactly these arguments: ' + JSON.stringify(input.args)
        : 'Execute the requested governed Commander operation.',
      { maxTurns: 2 },
    );
    const openaiIdentity = result.rawResponses
      .map((response) => response.requestId ?? response.responseId)
      .find((value): value is string => typeof value === 'string' && value.length > 0);

    return {
      schema: 'commander-openai-agents-mcp-invocation/v1',
      transport: 'mcp-stdio',
      runtime: 'openai-agents-sdk',
      agentPid: process.pid,
      toolName: input.toolName,
      discoveredTools,
      gatewayPayload: parseGatewayPayload(result.finalOutput),
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode === 'live' && openaiIdentity
        ? { openaiRequestOrTraceId: openaiIdentity }
        : {}),
    };
  } finally {
    await server.close();
  }
}
