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
    return formatExecResult(await execSandboxed(command, timeout, resolvedWorkdir));
  }
}
