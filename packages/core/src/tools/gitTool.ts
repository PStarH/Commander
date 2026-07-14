import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
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

    // Enforce tenant workspace boundary on the working directory.
    let resolvedWorkdir: string;
    try {
      // safePath is async; gitTool uses execFileSync (sync). We resolve via
      // the synchronous path resolution + isWithinRoot check to avoid mixing
      // async/sync. getSafeRoot() is tenant-aware.
      const { getSafeRoot, isWithinRoot } = await import('./fileSystemTool');
      resolvedWorkdir = path.resolve(getSafeRoot(), workdir);
      if (!isWithinRoot(resolvedWorkdir, getSafeRoot())) {
        return `Error: Access denied: workdir "${workdir}" is outside workspace`;
      }
    } catch {
      resolvedWorkdir = path.resolve(process.cwd(), workdir);
    }

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

    // SBX-1: block remote-helper RCE and config/exec injection. `git fetch
    // "ext::sh -c id"` (and fext::) invoke an arbitrary command through git's
    // remote-helper protocol; `-c`/`--config` can set core.sshCommand or
    // alias.*=!cmd; `--upload-pack`/`--receive-pack`/`--exec` run commands.
    for (const tok of gitArgs.slice(1)) {
      const lower = tok.toLowerCase();
      if (/^(ext|fext):/i.test(tok)) {
        return `Error: git remote helpers (ext::/fext::) are not allowed — they execute arbitrary commands.`;
      }
      if (lower === '-c' || lower === '--config' || lower.startsWith('--config=')) {
        return `Error: git -c/--config overrides are not allowed.`;
      }
      if (
        lower.startsWith('--upload-pack') ||
        lower.startsWith('--receive-pack') ||
        lower.startsWith('--exec')
      ) {
        return `Error: git --upload-pack/--receive-pack/--exec are not allowed (arbitrary command execution).`;
      }
    }
    // Harden transports regardless of subcommand: disable the ext helper entirely
    // and restrict file:// to user config. These tool-supplied flags precede the
    // subcommand and cannot be overridden by later user args.
    const hardenedArgs = [
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'protocol.file.allow=user',
      ...gitArgs,
    ];
    try {
      const start = Date.now();
      const stdout = execFileSync('git', hardenedArgs, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: resolvedWorkdir,
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
