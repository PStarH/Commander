import { execFileSync } from 'node:child_process';
import type { Tool, ToolDefinition } from '../runtime/types';

// Git subcommands that do NOT mutate repository state in dangerous ways.
// Commands are grouped by safety profile so we can match precisely.
const READ_COMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'stash',
  'tag',
  'remote',
  'shortlog',
  'rev-list',
  'describe',
  'blame',
  'ls-files',
  'ls-remote',
]);
const WRITE_COMMANDS = new Set([
  'add',
  'commit',
  'push',
  'pull',
  'fetch',
  'merge',
  'rebase',
  'checkout',
  'reset',
  'rm',
  'mv',
  'config',
]);
const SAFE_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS]);

function assertValidSubcommand(subcommand: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(subcommand)) {
    throw new Error(`Invalid git subcommand: ${subcommand}`);
  }
}

export class GitTool implements Tool {
  definition: ToolDefinition = {
    name: 'git',
    description:
      'Execute git operations. Supports status, log, diff, branch, shortlog, blame, add, commit, push, pull, and other git commands. Do NOT use shell pipes (|) — use git flags like -n 20 instead of "| head -20".',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Git subcommand and args (e.g. "status", "log --oneline -5", "diff --stat")',
        },
        workdir: {
          type: 'string',
          description: 'Working directory (default: workspace root)',
          default: '.',
        },
      },
      required: ['command'],
    },
    examples: [
      { name: 'git', arguments: { command: 'status' } },
      { name: 'git', arguments: { command: 'log --oneline -5' } },
      { name: 'git', arguments: { command: 'diff --stat' } },
    ],
    category: 'development',
    costTier: 'medium', // git commands — read/write, up to ~5K output tokens
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    // Strip shell pipes — agents sometimes write `git log | head -20` but we run
    // git directly via execFileSync (no shell). Convert common patterns to git flags.
    let cleanCommand = command;
    const pipeIdx = cleanCommand.indexOf('|');
    if (pipeIdx !== -1) {
      const afterPipe = cleanCommand.slice(pipeIdx + 1).trim();
      cleanCommand = cleanCommand.slice(0, pipeIdx).trim();
      // Convert `head -N` / `head --lines=N` to git's `-n N`
      const headMatch = afterPipe.match(/head\s+(?:--lines=|-n?\s*)(\d+)/);
      if (headMatch && !cleanCommand.includes('-n ') && !cleanCommand.includes('--max-count')) {
        cleanCommand += ` -n ${headMatch[1]}`;
      }
      // Convert `tail -N` to `--skip` (approximate: get more then tail)
      const tailMatch = afterPipe.match(/tail\s+(?:--lines=|-n?\s*)(\d+)/);
      if (tailMatch && !cleanCommand.includes('-n ') && !cleanCommand.includes('--max-count')) {
        cleanCommand += ` -n ${tailMatch[1]}`;
      }
    }
    // Normalize `--key=value` to `--key value` (git accepts both but agents sometimes mix)
    // But preserve --format=VALUE since git handles that fine and quoting gets messy
    cleanCommand = cleanCommand.replace(/--(\w[\w-]*)=(\S+)/g, (match, key, val) => {
      // Keep --format= as-is since git format strings contain special chars
      if (key === 'format') return match;
      return `--${key} ${val}`;
    });

    // Parse the command into subcommand + arguments, stripping quotes
    // (execFileSync doesn't use a shell, so quotes are literal — strip them)
    const tokens = cleanCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        tokens[i] = t.slice(1, -1);
      }
    }
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
      if (err instanceof Error && 'stderr' in err)
        return `[Error]\n${(err as { stderr: string }).stderr as string}`;
      return `[Error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
