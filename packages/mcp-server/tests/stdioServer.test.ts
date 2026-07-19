import { describe, it, expect } from 'vitest';
import {
  MCPServer,
  createFetchActionGatewayExecutor,
  type Tool,
} from '@commander/core';
import {
  assertActionGatewayConfigured,
  createStdioMcpServer,
  isEnterpriseOrProductionMcpMode,
  startStdioServer,
} from '../src/stdioServer';
import { run } from '../src/cli';
import { MCP_PROTOCOL_VERSION } from '@commander/core';

describe('createStdioMcpServer', () => {
  it('advertises Commander tools and model-router tools by default', () => {
    const { server, status } = createStdioMcpServer();
    const tools = server.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(status.tools.length).toBe(tools.length);
    expect(tools.some((t) => t.name === 'execute_agent')).toBe(true);
    expect(tools.some((t) => t.name === 'list_models')).toBe(true);
    expect(tools.some((t) => t.name === 'route_task')).toBe(true);
  });

  it('modelRouterOnly mode only registers the three model-router tools', () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true });
    const tools = server.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['execute_agent', 'list_models', 'route_task']);
  });

  it('initialize returns the shared MCP protocol version', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'commander-mcp-server', version: '0.2.0' },
      capabilities: { tools: {} },
    });
  });

  it('tools/list returns the registered tools', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'execute_agent',
      'list_models',
      'route_task',
    ]);
  });

  it('tools/call invokes execute_agent', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'execute_agent',
        arguments: { goal: 'test goal', agentId: 'test-agent' },
      },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('test-agent');
    expect(result.content[0].text).toContain('test goal');
  });

  it('status reflects server metadata', () => {
    const { status } = createStdioMcpServer({ name: 'custom-mcp', version: '1.2.3' });
    expect(status.name).toBe('custom-mcp');
    expect(status.version).toBe('1.2.3');
    expect(status.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(status.capabilities.tools).toEqual({});
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('routes external commander tools through the action gateway without local execution', async () => {
    const localExecutions: string[] = [];
    const gatewayCalls: Array<Record<string, unknown>> = [];
    const writeTool: Tool = {
      definition: {
        name: 'demo_external_write',
        description: 'External write tool',
        inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
      },
      isReadOnly: false,
      execute: async () => {
        localExecutions.push('called');
        return 'local-result';
      },
    };
    const server = new MCPServer('gateway-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', writeTool]]), undefined, {
      actionGatewayExecutor: {
        proposeAction: async (input) => {
          gatewayCalls.push(input);
          return {
            action: { runId: 'run-gateway-1', state: 'PENDING' },
            idempotentReplay: false,
          };
        },
      },
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: { payload: 'hello' } },
    });

    expect(response.error).toBeUndefined();
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({
      source: 'mcp',
      tool: 'demo_external_write',
      args: { payload: 'hello' },
    });
    expect(localExecutions).toHaveLength(0);
  });

  it('keeps list_models local when an action gateway executor is configured', async () => {
    const { server } = createStdioMcpServer({
      modelRouterOnly: true,
      actionGatewayExecutor: {
        proposeAction: async () => {
          throw new Error('action gateway should not be called for list_models');
        },
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'list_models', arguments: {} },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('[');
  });

  it('createFetchActionGatewayExecutor posts to /v1/actions', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const executor = createFetchActionGatewayExecutor({
      baseUrl: 'https://gateway.example',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            action: { runId: 'run-1', state: 'PENDING' },
            idempotentReplay: false,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await executor.proposeAction({
      source: 'mcp',
      package: 'commander.mcp',
      model: 'mcp-default',
      tool: 'demo_external_write',
      destination: 'mcp://commander/demo_external_write',
      effectType: 'mcp.tool.demo_external_write',
      args: { payload: 'x' },
      idempotencyKey: 'mcp-12345678',
    });
    expect(capturedUrl).toBe('https://gateway.example/v1/actions');
    expect(new Headers(capturedInit?.headers).get('idempotency-key')).toBe('mcp-12345678');
    expect(result.action.runId).toBe('run-1');
  });
});

describe('startStdioServer', () => {
  it('returns a stop function', () => {
    const { stop, server } = startStdioServer({ modelRouterOnly: true });
    expect(typeof stop).toBe('function');
    expect(server.listTools().length).toBe(3);
    stop();
  });
});

describe('cli', () => {
  it('prints help and exits', () => {
    let output = '';
    let exited = false;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExit = process.exit.bind(process.exit);

    process.stdout.write = ((chunk: string | Uint8Array, cb?: (err?: Error) => void) => {
      output += String(chunk);
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;

    process.exit = ((code?: number | string | null | undefined) => {
      exited = true;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      run(['node', 'cli.js', '--help']);
    } catch (err) {
      // expected
    } finally {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    }

    expect(exited).toBe(true);
    expect(output).toContain('commander-mcp-server');
    expect(output).toContain('--model-router-only');
  });

  it('refuses enterprise startup without COMMANDER_ACTION_GATEWAY_URL', () => {
    let stderr = '';
    let exited = false;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExit = process.exit.bind(process.exit);
    const originalProfile = process.env.COMMANDER_PROFILE;
    const originalGateway = process.env.COMMANDER_ACTION_GATEWAY_URL;

    process.stderr.write = ((chunk: string | Uint8Array, cb?: (err?: Error) => void) => {
      stderr += String(chunk);
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number | string | null | undefined) => {
      exited = true;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    process.env.COMMANDER_PROFILE = 'enterprise';
    delete process.env.COMMANDER_ACTION_GATEWAY_URL;

    try {
      run(['node', 'cli.js']);
    } catch {
      // expected
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
      if (originalProfile === undefined) delete process.env.COMMANDER_PROFILE;
      else process.env.COMMANDER_PROFILE = originalProfile;
      if (originalGateway === undefined) delete process.env.COMMANDER_ACTION_GATEWAY_URL;
      else process.env.COMMANDER_ACTION_GATEWAY_URL = originalGateway;
    }

    expect(exited).toBe(true);
    expect(stderr).toContain('COMMANDER_ACTION_GATEWAY_URL');
  });
});

describe('action gateway guards', () => {
  it('detects enterprise/production MCP mode', () => {
    expect(isEnterpriseOrProductionMcpMode({ COMMANDER_PROFILE: 'enterprise' })).toBe(true);
    expect(isEnterpriseOrProductionMcpMode({ NODE_ENV: 'production' })).toBe(true);
    expect(isEnterpriseOrProductionMcpMode({ NODE_ENV: 'test' })).toBe(false);
  });

  it('allows non-enterprise startup without gateway url', () => {
    expect(() =>
      assertActionGatewayConfigured({ NODE_ENV: 'test', COMMANDER_ACTION_GATEWAY_URL: undefined }),
    ).not.toThrow();
  });

  it('refuses --allow-dangerous-tools without COMMANDER_ACTION_GATEWAY_URL', () => {
    expect(() =>
      assertActionGatewayConfigured(
        { NODE_ENV: 'test', COMMANDER_ACTION_GATEWAY_URL: undefined },
        { allowDangerousTools: true },
      ),
    ).toThrow(/COMMANDER_ACTION_GATEWAY_URL/);
  });
});

describe('action gateway MCP routing', () => {
  it('maps ticket.create to demo.ticket.create in the action envelope', async () => {
    const { buildMcpActionEnvelope } = await import('@commander/core');
    const tool = {
      definition: { name: 'ticket.create', description: 'create', inputSchema: { type: 'object' } },
      isReadOnly: false,
      execute: async () => 'local',
    };
    const envelope = buildMcpActionEnvelope(tool as any, { title: 'x' });
    expect(envelope.effectType).toBe('demo.ticket.create');
    expect(envelope.destination).toBe('demo://tickets');
    expect(envelope.tool).toBe('ticket.create');
  });

  it('surfaces ActionGatewayPolicyError as MCP text', async () => {
    const { MCPServer, ActionGatewayPolicyError } = await import('@commander/core');
    const tool = {
      definition: { name: 'demo_external_write', description: 'w', inputSchema: { type: 'object' } },
      isReadOnly: false,
      execute: async () => 'local',
    };
    const server = new MCPServer('policy-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', tool as any]]), undefined, {
      actionGatewayExecutor: {
        proposeAction: async () => {
          throw new ActionGatewayPolicyError('ACTION_POLICY_DENIED', 'denied by policy', {});
        },
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 200,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: {} },
    });
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('ACTION_POLICY_DENIED');
    expect(text).toContain('denied by policy');
  });

  it('refuses non-read-only tools without a gateway executor (no local execute)', async () => {
    const localExecutions: string[] = [];
    const writeTool: Tool = {
      definition: {
        name: 'demo_external_write',
        description: 'External write tool',
        inputSchema: { type: 'object', properties: {} },
      },
      isReadOnly: false,
      execute: async () => {
        localExecutions.push('called');
        return 'local-result';
      },
    };
    const server = new MCPServer('fail-closed-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', writeTool]]));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('ACTION_GATEWAY_REQUIRED');
    expect(localExecutions).toHaveLength(0);
  });
});
