import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import type { ExecutionBackend, SSHConfig, SandboxExecutionResult } from '../types';
import { getSecurityAuditLogger } from '../../security/securityAuditLogger';

/** Validate that a path contains no shell metacharacters (prevents command injection via workdir). */
export function isValidShellPath(p: string): boolean {
  // Allow only safe path characters: alphanumeric, /, -, _, ., ~, spaces
  // Reject anything that could break out of quotes or chain commands
  return /^[a-zA-Z0-9/_. ~@:-]+$/.test(p) && !p.includes('..');
}

function buildSshArgs(config: SSHConfig): string[] {
  const args: string[] = [
    '-o',
    `Port=${config.port}`,
    '-o',
    `ConnectTimeout=${Math.ceil((config.connectTimeoutMs ?? 10000) / 1000)}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'BatchMode=yes',
  ];
  if (config.identityFile) {
    args.push('-o', `IdentityFile=${config.identityFile}`);
  }
  if (config.extraOptions) {
    for (const [k, v] of Object.entries(config.extraOptions)) {
      args.push('-o', `${k}=${v}`);
    }
  }
  args.push(`${config.user}@${config.host}`);
  return args;
}

/**
 * SSH execution backend — runs commands on a remote host via the `ssh` CLI.
 * Uses StrictHostKeyChecking=yes and BatchMode for non-interactive auth.
 * Note: the remote host runs unconfined; sandboxing depends on the local OS.
 */
export class SSHBackend implements ExecutionBackend {
  readonly type = 'ssh' as const;
  private config: SSHConfig;

  constructor(config: SSHConfig) {
    this.config = {
      ...config,
      port: config.port ?? 22,
      connectTimeoutMs: config.connectTimeoutMs ?? 10000,
    };
  }

  get available(): boolean {
    return true; // ssh CLI is available on most systems; we detect at execute time
  }

  async execute(
    command: string,
    workdir?: string,
    timeout?: number,
  ): Promise<SandboxExecutionResult> {
    const start = Date.now();

    // Security: validate workdir to prevent command injection via path
    if (workdir && !isValidShellPath(workdir)) {
      getSecurityAuditLogger().logCommandInjectionAttempt(
        'SSHBackend',
        'Rejected workdir with unsafe characters',
        { workdir },
      );
      return {
        stdout: '',
        stderr: `Rejected: workdir contains unsafe characters: ${workdir}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        sandboxMechanism: 'ssh',
      };
    }

    // SECURITY FIX: use single quotes for workdir to prevent $() and backtick expansion
    // Double quotes in bash still interpret $(), backticks, and ! — single quotes are literal
    const escapedWorkdir = workdir ? workdir.replace(/'/g, "'\\''") : '';
    const fullCommand = workdir ? `cd '${escapedWorkdir}' && ${command}` : command;
    const sshArgs = buildSshArgs(this.config);

    return new Promise((resolve) => {
      const child = spawn('ssh', [...sshArgs, fullCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (timeout ?? 60) * 1000,
      });

      let stdout = '';
      let stderr = '';
      const MAX_OUTPUT = 10 * 1024 * 1024;
      const stdoutTimer = setTimeout(
        () => {
          child.stdout?.destroy();
        },
        (timeout ?? 60) * 1000,
      );
      stdoutTimer.unref();
      const stderrTimer = setTimeout(
        () => {
          child.stderr?.destroy();
        },
        (timeout ?? 60) * 1000,
      );
      stderrTimer.unref();

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(stdoutTimer);
        clearTimeout(stderrTimer);
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          durationMs: Date.now() - start,
          sandboxMechanism: 'ssh',
        });
      });

      child.on('error', (err) => {
        clearTimeout(stdoutTimer);
        clearTimeout(stderrTimer);
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: -1,
          durationMs: Date.now() - start,
          sandboxMechanism: 'ssh',
        });
      });
    });
  }
}

// ============================================================================
// SSH Config Resolution
// ============================================================================

/**
 * Resolve SSH configuration from a combination of explicit args and environment.
 * Environment variables take precedence over defaults but explicit args win over env.
 *
 * Priority: explicit args > env vars > defaults
 */
/** Validate SSH host — must be a hostname or IP, no shell metacharacters. */
function isValidSshHost(host: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(host);
}

export function resolveSSHConfig(args: Record<string, unknown>): SSHConfig | null {
  const host = String(args.ssh_host ?? process.env.COMMANDER_SSH_HOST ?? '');
  if (!host) return null;

  // Security: reject hosts with shell metacharacters
  if (!isValidSshHost(host)) {
    return null;
  }

  const port = Number(args.ssh_port ?? process.env.COMMANDER_SSH_PORT ?? 22);
  if (port < 1 || port > 65535 || !Number.isFinite(port)) return null;

  return {
    host,
    port,
    user: String(args.ssh_user ?? process.env.COMMANDER_SSH_USER ?? os.userInfo().username),
    identityFile: String(
      args.ssh_key ?? process.env.COMMANDER_SSH_KEY ?? path.join(os.homedir(), '.ssh', 'id_rsa'),
    ),
    connectTimeoutMs: Number(
      args.ssh_timeout ?? process.env.COMMANDER_SSH_CONNECT_TIMEOUT ?? 10000,
    ),
  };
}
