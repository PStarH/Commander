import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';

const TEMP_DIR = path.join(process.cwd(), '.commander_exec');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
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

      const start = Date.now();
      const stdout = execSync(`python3 "${filePath}"`, {
        timeout: timeout * 1000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const elapsed = Date.now() - start;

      return `[Exit: 0 | ${elapsed}ms]\n${stdout}`.trim();
    } catch (err: any) {
      const elapsed = Date.now() - (err as any).startTime || 0;
      if (err.stderr) return `[Exit: ${err.status ?? 1} | ${elapsed}ms]\nSTDERR:\n${err.stderr}`;
      if (err.killed) return `[Exit: SIGTERM | ${timeout}s timeout exceeded]`;
      return `[Error] ${err.message}`;
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

    try {
      const start = Date.now();
      const stdout = execSync(command, {
        timeout: timeout * 1000,
        encoding: 'utf-8',
        cwd: path.resolve(process.cwd(), workdir),
        maxBuffer: 10 * 1024 * 1024,
      });
      const elapsed = Date.now() - start;
      return `[Exit: 0 | ${elapsed}ms]\n${stdout}`.trim();
    } catch (err: any) {
      const elapsed = Date.now() - (err as any).startTime || 0;
      if (err.stderr) return `[Exit: ${err.status ?? 1} | ${elapsed}ms]\nSTDERR:\n${err.stderr}`;
      if (err.killed) return `[Exit: SIGTERM | ${timeout}s timeout exceeded]`;
      return `[Error] ${err.message}`;
    }
  }
}
