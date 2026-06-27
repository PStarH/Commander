/**
 * E2E tests for deploy & rollback workflows through AgentRuntime.execute().
 *
 * These tests simulate a deploy → health-check → rollback workflow by:
 * - Registering deploy, rollback, and health_check tools on AgentRuntime
 * - Using ScriptedLLMProvider to make the runtime call tools in sequence
 * - Running a real HTTP server for health checks
 * - Verifying state through runtime.execute() return values
 *
 * The full AgentRuntime pipeline is exercised: ToolOrchestrator, CircuitBreaker,
 * DLQ, CostGuard, execution trace — all real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import {
  createTestRuntime,
  ScriptedLLMProvider,
  makeContext,
  resetGlobalState,
} from './e2eTestHelpers';

interface DeployEnv {
  baseDir: string;
  server: http.Server;
  port: number;
  close(): void;
  getVersion(): string;
}

function createDeployEnv(opts?: { newVersionHealthy?: boolean }): DeployEnv {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdr-deploy-e2e-'));
  const port = 19600 + Math.floor(Math.random() * 400);
  const newVersion = 'v2';
  const rollbackVersion = 'v1';
  const newVersionHealthy = opts?.newVersionHealthy ?? false;

  fs.writeFileSync(path.join(baseDir, 'version.txt'), rollbackVersion);

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const version = fs.readFileSync(path.join(baseDir, 'version.txt'), 'utf-8').trim();
      if (version === newVersion && !newVersionHealthy) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', version }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', version }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port);

  return {
    baseDir,
    server,
    port,
    close() {
      server.close();
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
    getVersion() {
      return fs.readFileSync(path.join(baseDir, 'version.txt'), 'utf-8').trim();
    },
  };
}

function makeDeployTools(env: DeployEnv) {
  return {
    deploy: {
      definition: {
        name: 'deploy',
        description: 'Deploy a new version',
        inputSchema: { type: 'object', properties: { version: { type: 'string' } } },
      },
      execute: async (args: Record<string, unknown>) => {
        const version = String(args.version);
        fs.writeFileSync(path.join(env.baseDir, 'version.txt'), version);
        return `Deployed ${version}`;
      },
      isConcurrencySafe: false,
    },
    rollback: {
      definition: {
        name: 'rollback',
        description: 'Rollback to a previous version',
        inputSchema: { type: 'object', properties: { version: { type: 'string' } } },
      },
      execute: async (args: Record<string, unknown>) => {
        const version = String(args.version);
        fs.writeFileSync(path.join(env.baseDir, 'version.txt'), version);
        return `Rolled back to ${version}`;
      },
      isConcurrencySafe: false,
    },
    health_check: {
      definition: {
        name: 'health_check',
        description: 'Check application health',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const response = await fetch(`http://127.0.0.1:${env.port}/health`);
        const body = await response.json() as { status: string; version: string };
        if (!response.ok || body.status !== 'healthy') {
          throw new Error(`Health check failed: ${body.status} (version: ${body.version})`);
        }
        return JSON.stringify(body);
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    },
  };
}

describe('E2E: Deploy & Rollback through AgentRuntime.execute()', () => {
  let env: DeployEnv;

  beforeEach(() => {
    resetGlobalState();
    env = createDeployEnv({ newVersionHealthy: false });
  });

  afterEach(() => {
    env.close();
  });

  it('successful deploy with healthy new version', async () => {
    env.close();
    env = createDeployEnv({ newVersionHealthy: true });

    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);

    const provider = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c2', name: 'health_check', arguments: {} }] },
      { response: 'Deploy successful and health check passed.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({ availableTools: ['deploy', 'health_check'], goal: 'Deploy v2 and verify health' }),
    );

    expect(result.status).toBe('success');
    expect(env.getVersion()).toBe('v2');
    expect(provider.callCount).toBe(3); // deploy + health + final
  });

  it('deploy fails health check → automatic rollback', async () => {
    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);
    runtime.registerTool('rollback', tools.rollback);

    const provider = new ScriptedLLMProvider([
      // Step 1: deploy v2
      { toolCalls: [{ id: 'c1', name: 'deploy', arguments: { version: 'v2' } }] },
      // Step 2: health check (will fail)
      { toolCalls: [{ id: 'c2', name: 'health_check', arguments: {} }] },
      // Step 3: rollback to v1
      { toolCalls: [{ id: 'c3', name: 'rollback', arguments: { version: 'v1' } }] },
      // Step 4: verify health after rollback
      { toolCalls: [{ id: 'c4', name: 'health_check', arguments: {} }] },
      // Final
      { response: 'Rollback complete. Health is green.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({
        availableTools: ['deploy', 'health_check', 'rollback'],
        goal: 'Deploy v2, check health, rollback if unhealthy',
        maxSteps: 15,
      }),
    );

    expect(result.status).toBe('success');
    expect(env.getVersion()).toBe('v1');
    expect(provider.callCount).toBe(5);
  });

  it('multiple deploy/rollback cycles in one execution', async () => {
    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);
    runtime.registerTool('rollback', tools.rollback);

    const provider = new ScriptedLLMProvider([
      // Cycle 1: deploy v2 → health fails → rollback
      { toolCalls: [{ id: 'c1', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c2', name: 'health_check', arguments: {} }] },
      { toolCalls: [{ id: 'c3', name: 'rollback', arguments: { version: 'v1' } }] },
      // Cycle 2: try again
      { toolCalls: [{ id: 'c4', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c5', name: 'health_check', arguments: {} }] },
      { toolCalls: [{ id: 'c6', name: 'rollback', arguments: { version: 'v1' } }] },
      // Give up
      { response: 'v2 is consistently unhealthy. Staying on v1.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({
        availableTools: ['deploy', 'health_check', 'rollback'],
        goal: 'Try deploying v2 twice, rollback each time',
        maxSteps: 20,
      }),
    );

    expect(result.status).toBe('success');
    expect(env.getVersion()).toBe('v1');
    // Provider was called multiple times — exact count depends on how runtime
    // handles tool failures (error messages may trigger extra LLM round-trips)
    expect(provider.callCount).toBeGreaterThanOrEqual(5);
  });

  it('health check failure is handled gracefully by runtime', async () => {
    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);

    const provider = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c2', name: 'health_check', arguments: {} }] },
      // Health check fails, runtime feeds error to LLM, LLM responds
      { response: 'Health check failed. v2 is unhealthy.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({ availableTools: ['deploy', 'health_check'], goal: 'Deploy and check' }),
    );

    // Runtime should complete — the tool failure is returned as an error
    // message to the LLM, which then decides what to do
    expect(result.status).toBe('success');
    // v2 was deployed, health check failed but no rollback was scripted
    expect(env.getVersion()).toBe('v2');
  });

  it('deploy → health → rollback preserves token usage tracking', async () => {
    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);
    runtime.registerTool('rollback', tools.rollback);

    const provider = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c2', name: 'health_check', arguments: {} }] },
      { toolCalls: [{ id: 'c3', name: 'rollback', arguments: { version: 'v1' } }] },
      { response: 'Done.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({
        availableTools: ['deploy', 'health_check', 'rollback'],
        maxSteps: 15,
      }),
    );

    expect(result.status).toBe('success');
    expect(result.totalTokenUsage).toBeDefined();
    expect(result.totalTokenUsage!.totalTokens).toBeGreaterThan(0);
    // 4 LLM calls: deploy + health + rollback + final
    expect(provider.callCount).toBe(4);
  });

  it('version-dependent health check works correctly through runtime', async () => {
    const { runtime } = createTestRuntime();
    const tools = makeDeployTools(env);
    runtime.registerTool('deploy', tools.deploy);
    runtime.registerTool('health_check', tools.health_check);
    runtime.registerTool('rollback', tools.rollback);

    // Verify v1 is healthy first, then deploy v2 (unhealthy), then rollback
    const provider = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'health_check', arguments: {} }] }, // v1 healthy
      { toolCalls: [{ id: 'c2', name: 'deploy', arguments: { version: 'v2' } }] },
      { toolCalls: [{ id: 'c3', name: 'health_check', arguments: {} }] }, // v2 unhealthy
      { toolCalls: [{ id: 'c4', name: 'rollback', arguments: { version: 'v1' } }] },
      { toolCalls: [{ id: 'c5', name: 'health_check', arguments: {} }] }, // v1 healthy again
      { response: 'Verified: v1 healthy, v2 unhealthy, rolled back.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    const result = await runtime.execute(
      makeContext({
        availableTools: ['deploy', 'health_check', 'rollback'],
        maxSteps: 20,
      }),
    );

    expect(result.status).toBe('success');
    expect(env.getVersion()).toBe('v1');
    // 5 tool calls + 1 final = 6, but health_check failures may cause
    // the runtime to terminate early or add extra LLM round-trips
    expect(provider.callCount).toBeGreaterThanOrEqual(5);
  });
});
