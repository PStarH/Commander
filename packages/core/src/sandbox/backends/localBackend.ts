import { execFileSync } from 'child_process';
import type { ExecutionBackend, SandboxExecutionResult } from '../types';
import { getSandboxManager } from '../manager';

/** Shell metacharacters that enable command injection — blocks fallback execSync. */
export const SHELL_UNSAFE_RE = /[;&|`$(){}[\]!#~<>*\n\t'"\\\x00-\x1f]/;

/**
 * Shell-aware split: splits on whitespace but preserves quoted substrings.
 * "C:\Program Files\node\node.exe" → ["C:\Program Files\node\node.exe"]
 * ls -la "/path/with spaces" → ["ls", "-la", "/path/with spaces"]
 */
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
        continue;
      }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export interface LocalBackendConfig {
  /** When true, reject execution if no sandbox is available instead of falling back to execSync. */
  rejectOnNoSandbox?: boolean;
}

/**
 * Local execution backend — runs commands through the OS sandbox (Seatbelt/Bwrap/Docker)
 * or falls back to direct execSync when sandbox is unavailable.
 */
export class LocalBackend implements ExecutionBackend {
  readonly type = 'local' as const;
  readonly available = true;
  private config: LocalBackendConfig;

  constructor(config?: LocalBackendConfig) {
    this.config = config ?? {};
  }

  async execute(
    command: string,
    workdir?: string,
    timeout?: number,
  ): Promise<SandboxExecutionResult> {
    const start = Date.now();
    const sandbox = getSandboxManager();

    if (sandbox.hasSandbox()) {
      const result = await sandbox.execute(command, 'workspace-write', workdir);
      return { ...result, durationMs: result.durationMs };
    }

    if (this.config.rejectOnNoSandbox) {
      return {
        stdout: '',
        stderr: `Rejected: no sandbox available and rejectOnNoSandbox is enabled`,
        exitCode: 1,
        durationMs: Date.now() - start,
        sandboxMechanism: 'none',
      };
    }

    if (SHELL_UNSAFE_RE.test(command)) {
      return {
        stdout: '',
        stderr: `Rejected: command contains shell-unsafe characters (no sandbox available)`,
        exitCode: 1,
        durationMs: Date.now() - start,
        sandboxMechanism: 'none',
      };
    }

    try {
      const parts = shellSplit(command.trim());
      const file = parts[0];
      const args = parts.slice(1);
      const stdout = execFileSync(file, args, {
        timeout: (timeout ?? 60) * 1000,
        encoding: 'utf-8',
        cwd: workdir ?? process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        stdout: stdout ?? '',
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - start,
        sandboxMechanism: 'none',
      };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number; killed?: boolean };
      return {
        stdout: e.stdout?.toString() ?? '',
        stderr: e.stderr?.toString() ?? '',
        exitCode: e.status ?? 1,
        durationMs: Date.now() - start,
        sandboxMechanism: 'none',
      };
    }
  }
}
