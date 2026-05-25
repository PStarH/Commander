import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { execSandboxed } from './sandboxedExec';
import { getGlobalLogger } from '../logging';

const TEMP_DIR = path.join(process.cwd(), '.commander_exec');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function formatExecResult(r: { stdout: string; stderr: string; exitCode: number; durationMs: number; killed: boolean }): string {
  if (r.exitCode === 0) {
    return `[Exit: 0 | ${r.durationMs}ms]\n${r.stdout}`.trim();
  }
  if (r.stderr) return `[Exit: ${r.exitCode} | ${r.durationMs}ms]\nSTDERR:\n${r.stderr}`;
  if (r.killed) return `[Exit: SIGTERM | timeout exceeded]`;
  return `[Error] Exit code ${r.exitCode}`;
}

export class PythonExecuteTool implements Tool {
  definition: ToolDefinition = {
    name: 'python_execute',
    description: 'Execute Python code in a sandboxed environment. Returns stdout, stderr, and execution time. Use for calculations, data analysis, and scripting.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 },
      },
      required: ['code'],
    },
    examples: [
      { name: 'python_execute', arguments: { code: 'print(sum(range(100)))' } },
      { name: 'python_execute', arguments: { code: 'import json; print(json.dumps({"key": "value"}))', timeout: 10 } },
    ],
    category: 'code',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const code = String(args.code ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);

    if (!code) return 'Error: code is required';

    ensureTempDir();
    const filePath = path.join(TEMP_DIR, `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);

    try {
      fs.writeFileSync(filePath, code, 'utf-8');
      return formatExecResult(await execSandboxed(`python3 "${filePath}"`, timeout));
    } finally {
      try { fs.unlinkSync(filePath); } catch (e) { getGlobalLogger().warn('PythonExecuteTool', 'Temp file cleanup failed', { error: (e as Error)?.message }); }
    }
  }
}

/**
 * Build a user-facing description of the available backends based on environment.
 * This is shown in the tool definition so the LLM knows what's available.
 */
function buildBackendDescriptions(): string {
  const parts: string[] = [];
  parts.push('local — run on the local machine through sandbox (default)');
  if (process.env.COMMANDER_SSH_HOST) parts.push('ssh — run on a remote host (configured via env, or override with ssh_host/ssh_user/ssh_key args)');
  if (process.env.COMMANDER_DOCKER_CONTAINER) parts.push('docker — run inside a running Docker container (container configured via env, or override with container/container_id args)');
  if (parts.length === 1) parts.push('ssh — run on a remote host (set ssh_host argument)');
  if (parts.length <= 2) parts.push('docker — run inside a running container (set container argument)');
  return parts.join('; ');
}

export class ShellExecuteTool implements Tool {
  definition: ToolDefinition = {
    name: 'shell_execute',
    description: 'Execute a shell command. Returns stdout and stderr. Use for git operations, npm/pip commands, and system tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 },
        workdir: { type: 'string', description: 'Working directory (default: workspace root)', default: '.' },
        backend: { type: 'string', description: `Execution backend. Options: ${buildBackendDescriptions()}`, default: 'local' },
        ssh_host: { type: 'string', description: 'SSH host for remote execution (also set via COMMANDER_SSH_HOST env)' },
        ssh_user: { type: 'string', description: 'SSH user (default: current user, or COMMANDER_SSH_USER env)' },
        ssh_port: { type: 'number', description: 'SSH port (default: 22, or COMMANDER_SSH_PORT env)', default: 22 },
        ssh_key: { type: 'string', description: 'SSH identity file path (default: ~/.ssh/id_rsa, or COMMANDER_SSH_KEY env)' },
        container: { type: 'string', description: 'Docker container name or ID for docker exec (also set via COMMANDER_DOCKER_CONTAINER env)' },
        container_id: { type: 'string', description: 'Alias for container' },
        docker_user: { type: 'string', description: 'User to run as inside the container (or COMMANDER_DOCKER_USER env)' },
        backend_name: { type: 'string', description: 'Name of a pre-registered backend (set programmatically via ExecutionRouter.registerBackend())' },
      },
      required: ['command'],
    },
    examples: [
      { name: 'shell_execute', arguments: { command: 'ls -la' } },
      { name: 'shell_execute', arguments: { command: 'npm test', timeout: 60 } },
      { name: 'shell_execute', arguments: { command: 'uname -a', backend: 'ssh', ssh_host: 'prod-server-01' } },
      { name: 'shell_execute', arguments: { command: 'ls /data', container: 'my-container', backend: 'docker' } },
    ],
    category: 'code',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    const resolvedWorkdir = path.resolve(process.cwd(), workdir);
    // Pass full args as backendArgs so the router can pick the right backend
    return formatExecResult(await execSandboxed(command, timeout, resolvedWorkdir, args));
  }
}
