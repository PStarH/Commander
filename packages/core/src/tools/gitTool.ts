import { execSync } from 'child_process';
import type { Tool, ToolDefinition } from '../runtime/types';

export class GitTool implements Tool {
  definition: ToolDefinition = {
    name: 'git',
    description: 'Execute git operations. Supports status, log, diff, branch, add, commit, push, pull, and other git commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Git subcommand and args (e.g. "status", "log --oneline -5", "diff --stat")',
        },
        workdir: { type: 'string', description: 'Working directory (default: workspace root)', default: '.' },
      },
      required: ['command'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    const safeCommands = ['status', 'log', 'diff', 'branch', 'show', 'stash', 'tag',
      'add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase',
      'checkout', 'reset', 'rm', 'mv', 'remote', 'config'];

    const cmdName = command.split(/\s+/)[0];
    if (!safeCommands.some(sc => cmdName === sc || command.startsWith(sc))) {
      return `Error: git ${cmdName} is not in the allowed commands list`;
    }

    try {
      const start = Date.now();
      const stdout = execSync(`git ${command}`, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: workdir,
        maxBuffer: 5 * 1024 * 1024,
      });
      const elapsed = Date.now() - start;
      const output = stdout.trim();
      return output || `[Empty output | ${elapsed}ms]`;
    } catch (err: any) {
      if (err.stderr) return `[Error]\n${err.stderr}`;
      return `[Error] ${err.message}`;
    }
  }
}
