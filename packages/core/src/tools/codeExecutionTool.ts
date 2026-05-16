import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getSandboxManager } from '../sandbox/manager';

const TEMP_DIR = path.join(process.cwd(), '.commander_exec');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Execute a command through the sandbox if available, falling back to execSync.
 * This ensures code execution is confined when an OS-level sandbox (Seatbelt/Bubblewrap/Docker) is present.
 */
async function execSandboxed(command: string, timeoutSec: number, workdir?: string): Promise<string> {
  const sandbox = getSandboxManager();
  const timeout = timeoutSec * 1000;

  if (sandbox.hasSandbox()) {
    const profile = sandbox.getProfile('workspace-write');
    const result = await sandbox.execute(command, { ...profile, timeout }, workdir);
    const elapsed = result.durationMs;
    if (result.exitCode === 0) {
      return `[Exit: 0 | ${elapsed}ms]\n${result.stdout}`.trim();
    }
    if (result.stderr) return `[Exit: ${result.exitCode} | ${elapsed}ms]\nSTDERR:\n${result.stderr}`;
    return `[Exit: ${result.exitCode} | ${elapsed}ms]`;
  }

  // Fallback: direct execSync (no sandbox available on this platform)
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      timeout,
      encoding: 'utf-8',
      cwd: workdir ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return `[Exit: 0 | ${Date.now() - start}ms]\n${stdout}`.trim();
  } catch (err: any) {
    const elapsed = Date.now() - start;
    if (err.stderr) return `[Exit: ${err.status ?? 1} | ${elapsed}ms]\nSTDERR:\n${err.stderr}`;
    if (err.killed) return `[Exit: SIGTERM | ${timeoutSec}s timeout exceeded]`;
    return `[Error] ${err.message}`;
  }
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
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const code = String(args.code ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);

    if (!code) return 'Error: code is required';

    ensureTempDir();
    const filePath = path.join(TEMP_DIR, `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);

    try {
      fs.writeFileSync(filePath, code, 'utf-8');
      return await execSandboxed(`python3 "${filePath}"`, timeout);
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
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
      },
      required: ['command'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    const resolvedWorkdir = path.resolve(process.cwd(), workdir);
    return execSandboxed(command, timeout, resolvedWorkdir);
  }
}
