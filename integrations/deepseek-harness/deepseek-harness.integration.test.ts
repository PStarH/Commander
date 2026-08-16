import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { load as loadYaml } from 'js-yaml';
import { createStdioMcpServer } from '@commander/mcp-server';
import {
  InMemoryGateway,
  proveGatewayMcpLifecycle,
  withGateway,
} from '../helpers/gatewayHarness.js';

const GATEWAY_TOOLS = [
  'commander_action_evidence',
  'commander_action_get',
  'commander_action_propose',
  'commander_action_simulate',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cordisPatchPath = resolve(repoRoot, 'integrations', 'deepseek-harness', 'cordis.yml');
// `dsh` bin field: { "dsh": "lib/bin.js" }; spawned via process.execPath so
// the harness never depends on PATH or shell shims.
const dshBin = resolve(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const mcpCli = './packages/mcp-server/dist/cli.js';

const COMMANDER_CONFIG = {
  serverName: 'commander',
  transport: 'stdio',
  command: 'node',
  args: [mcpCli],
  cwd: '.',
  env: { COMMANDER_ACTION_GATEWAY_URL: 'http://127.0.0.1:4000' },
};

function expectCommanderEntry(entry: { name?: string; config?: unknown }) {
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
  assert.deepEqual(entry.config, COMMANDER_CONFIG);
}

describe('DeepSeek Harness (dsh) integration', () => {
  it('committed cordis.yml inserts the commander stdio MCP entry behind the gateway', () => {
    const patch = loadYaml(readFileSync(cordisPatchPath, 'utf8')) as unknown[];
    assert.ok(Array.isArray(patch), 'cordis.yml must be a top-level YAML array');
    const insert = patch.find((p) => Array.isArray((p as { insert?: unknown }).insert)) as
      | { insert: Array<{ id?: string; name?: string; config?: unknown }> }
      | undefined;
    assert.ok(insert, 'cordis.yml must carry a root - insert: patch list');
    const commander = insert.insert.find((e) => e.id === 'commander');
    assert.ok(commander, 'insert must declare the commander entry');
    expectCommanderEntry(commander);

    // Security: no credentials may be committed, and no executable YAML.
    assert.equal(
      (commander.config as { env?: Record<string, string> }).env?.COMMANDER_API_KEY,
      undefined,
    );
    const raw = readFileSync(cordisPatchPath, 'utf8');
    // The docs may mention the variable name in prose; a committed secret is
    // only a YAML key assignment, so match that precise form.
    assert.equal(raw.includes('COMMANDER_API_KEY:'), false);
    assert.equal(raw.includes('!!js'), false);
  });

  it('a real dsh subprocess composes the commander entry into the web profile tree (--dump-config --patch)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-integration-'));
    try {
      const child = spawn(
        process.execPath,
        [dshBin, '--profile', 'web', '--dump-config', '--patch', cordisPatchPath],
        {
          cwd: repoRoot,
          // Temp DSH_HOME keeps the run hermetic: the web profile is
          // auto-initialized inside it (and cleaned up below).
          env: { ...process.env, DSH_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ) as ChildProcessWithoutNullStreams;
      const [code, signal, stdout, stderr] = await collect(child as ChildProcessWithoutNullStreams);
      assert.equal(signal, null);
      assert.equal(code, 0, `dsh --dump-config failed (code ${code}): ${stderr}`);
      assert.equal(stderr, '');

      // The dump groups rows by source file + patch layers under `# ==`
      // comments; our overlay is the outermost patch, so the commander entry
      // lives in the final block, which carries only plain config (no `!!js`).
      const blocks = stdout.split(/\n(?=# == )/);
      const overlay = blocks[blocks.length - 1];
      assert.ok(
        overlay.includes(cordisPatchPath),
        'outermost overlay layer must be named after cordis.yml',
      );
      const rows = loadYaml(overlay) as Array<{ id?: string; name?: string; config?: unknown }>;
      const commander = rows.find((e) => e.id === 'commander');
      assert.ok(commander, 'composed tree must contain the commander entry');
      expectCommanderEntry(commander);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('the dsh-launched commander server advertises the four gateway tools over stdio', async () => {
    const child = spawnMcpServer({ COMMANDER_ACTION_GATEWAY_URL: 'http://127.0.0.1:4000' });
    try {
      const handleRequest = lineClient(child);
      await initializeDsh(handleRequest);
      const list = (await handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })) as { result?: { tools?: Array<{ name: string }> } };
      assert.deepEqual(
        list.result?.tools?.map((t) => t.name).sort(),
        [...GATEWAY_TOOLS].sort(),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a governed agent action from a real commander subprocess produces verified gateway evidence', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const child = spawnMcpServer({ COMMANDER_ACTION_GATEWAY_URL: baseUrl });
      try {
        const lineHandle = lineClient(child);
        await initializeDsh(lineHandle);
        // proveGatewayMcpLifecycle drives propose through the child's stdio,
        // then completes the human approval over the gateway HTTP API and
        // asserts the signed, anchored evidence receipt.
        const handleRequest = async (request: Record<string, unknown>) =>
          (await lineHandle(request)) as { error?: unknown; result?: unknown };
        const evidence = await proveGatewayMcpLifecycle(handleRequest, gateway, baseUrl);
        assert.equal(evidence.verification.ok, true);
        // DLP: sensitive payload never reaches the evidence receipt.
        const text = JSON.stringify(evidence);
        assert.equal(text.includes('SENSITIVE_TOOL_ARGUMENT'), false);
        assert.equal(text.includes('SENSITIVE_AUTH_TOKEN'), false);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  it('a dsh-launched commander server fails closed at boot without a configured gateway', async () => {
    // Enterprise mode makes cli.ts:65 assertActionGatewayConfigured throw at
    // boot when COMMANDER_ACTION_GATEWAY_URL is missing. Deliberately strip the
    // URL (even if the caller exported it) to prove the fail-closed contract.
    const env: Record<string, string | undefined> = {
      ...process.env,
      COMMANDER_PROFILE: 'enterprise',
    };
    delete env.COMMANDER_ACTION_GATEWAY_URL;
    const child = spawnMcpServer(env);
    const [code, stderr] = await collectExited(child);
    assert.equal(code, 1);
    assert.match(stderr, /COMMANDER_ACTION_GATEWAY_URL is required in enterprise\/production MCP mode/);
  });

  it('an in-process server mirrors the harness contract: discovery works, writes fail closed, enterpriseWrites is flagged', async () => {
    const { server, status } = createStdioMcpServer({});
    const list = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
    })) as { result?: { tools?: Array<{ name: string }> } };
    assert.deepEqual(
      list.result?.tools?.map((t) => t.name).sort(),
      [...GATEWAY_TOOLS].sort(),
    );
    assert.equal(status.enterpriseWrites, true);

    const call = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'commander_action_propose',
        arguments: { action: 'ticket.create', args: { title: 'x' } },
      },
    })) as { error?: { message?: string } };
    assert.ok(call.error);
    assert.match(call.error.message ?? '', /ACTION_GATEWAY_REQUIRED/);
  });
});

function spawnMcpServer(extraEnv: Record<string, string | undefined>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [mcpCli], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

async function initializeDsh(
  handleRequest: (request: unknown) => Promise<unknown>,
): Promise<void> {
  const init = (await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deepseek-harness-integration-test', version: '0.0.0' },
    },
  })) as {
    result?: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
  };
  assert.equal(init.result?.protocolVersion, '2024-11-05');
  assert.equal(init.result?.serverInfo?.name, 'commander-mcp-server');
  assert.equal(init.result?.serverInfo?.version, '0.2.0');
}

/**
 * Minimal line-delimited JSON-RPC client over the child's stdio: writes one
 * request, resolves with the next complete response line.
 */
function lineClient(child: ChildProcessWithoutNullStreams) {
  let buffer = '';
  const pending: Array<(line: string) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) pending.shift()?.(line);
    }
  });
  return (request: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP request timed out')), 10_000);
      pending.push((line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as unknown);
      });
      child.stdin.write(JSON.stringify(request) + '\n', (err) => {
        if (err) reject(err);
      });
    });
}

async function collect(
  child: ChildProcessWithoutNullStreams,
): Promise<[number | null, NodeJS.Signals | null, string, string]> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (stdout += c));
  child.stderr.on('data', (c: string) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  if (child.stdin.destroyed === false) child.stdin.end();
  return [code, child.signalCode, stdout, stderr];
}

/** For children expected to exit on their own (boot fail-closed): code + stderr. */
async function collectExited(child: ChildProcessWithoutNullStreams): Promise<[number | null, string]> {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return [code, stderr];
}