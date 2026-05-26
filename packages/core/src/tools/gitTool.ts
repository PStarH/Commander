import { execFileSync } from 'child_process';
import type { Tool, ToolDefinition } from '../runtime/types';

// Git subcommands that do NOT mutate repository state in dangerous ways.
// Commands are grouped by safety profile so we can match precisely.
const READ_COMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'stash', 'tag', 'remote']);
const WRITE_COMMANDS = new Set(['add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'checkout', 'reset', 'rm', 'mv', 'config']);
const SAFE_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS]);

function assertValidSubcommand(subcommand: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(subcommand)) {
    throw new Error(`Invalid git subcommand: ${subcommand}`);
  }
}

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
    examples: [
      { name: 'git', arguments: { command: 'status' } },
      { name: 'git', arguments: { command: 'log --oneline -5' } },
      { name: 'git', arguments: { command: 'diff --stat' } },
    ],
    category: 'development',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    // Parse the command into subcommand + arguments
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const subcommand = tokens[0] ?? '';

    if (!SAFE_COMMANDS.has(subcommand)) {
      return `Error: git "${subcommand}" is not in the allowed commands list. Allowed: ${[...SAFE_COMMANDS].join(', ')}`;
    }

    try {
      assertValidSubcommand(subcommand);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const gitArgs = [subcommand, ...tokens.slice(1)];
    try {
      const start = Date.now();
      const stdout = execFileSync('git', gitArgs, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: workdir,
        maxBuffer: 5 * 1024 * 1024,
      });
      const elapsed = Date.now() - start;
      const output = (stdout as string).trim();
      return output || `[Empty output | ${elapsed}ms]`;
    } catch (err: unknown) {
      if (err instanceof Error && 'stderr' in err) return `[Error]\n${(err as { stderr: string }).stderr as string}`;
      return `[Error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
