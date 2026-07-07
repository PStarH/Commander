import { describe, it, expect } from 'vitest';
import { createStdioMcpServer, startStdioServer } from '../src/stdioServer';
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
});
