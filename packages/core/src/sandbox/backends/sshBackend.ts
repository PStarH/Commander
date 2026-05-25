import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import type { ExecutionBackend, SSHConfig, SandboxExecutionResult } from '../types';

function buildSshArgs(config: SSHConfig): string[] {
  const args: string[] = [
    '-o', `Port=${config.port}`,
    '-o', `ConnectTimeout=${Math.ceil((config.connectTimeoutMs ?? 10000) / 1000)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
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
 * Uses BatchMode and StrictHostKeyChecking=accept-new for non-interactive auth.
 */
export class SSHBackend implements ExecutionBackend {
  readonly type = 'ssh' as const;
  private config: SSHConfig;

  constructor(config: SSHConfig) {
    this.config = { ...config, port: config.port ?? 22, connectTimeoutMs: config.connectTimeoutMs ?? 10000 };
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
    const fullCommand = workdir ? `cd "${workdir}" && ${command}` : command;
    const sshArgs = buildSshArgs(this.config);

    return new Promise((resolve) => {
      const child = spawn('ssh', [...sshArgs, fullCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (timeout ?? 60) * 1000,
      });

      let stdout = '';
      let stderr = '';
      const stdoutTimer = setTimeout(() => { child.stdout?.destroy(); }, (timeout ?? 60) * 1000);
      const stderrTimer = setTimeout(() => { child.stderr?.destroy(); }, (timeout ?? 60) * 1000);

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (exitCode) => {
        clearTimeout(stdoutTimer);
        clearTimeout(stderrTimer);
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          durationMs: Date.now() - start,
          sandboxMechanism: 'seatbelt', // SSH inherits local sandbox; remote is unconfined
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
          sandboxMechanism: 'seatbelt',
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
export function resolveSSHConfig(args: Record<string, unknown>): SSHConfig | null {
  const host = String(args.ssh_host ?? process.env.COMMANDER_SSH_HOST ?? '');
  if (!host) return null;

  return {
    host,
    port: Number(args.ssh_port ?? process.env.COMMANDER_SSH_PORT ?? 22),
    user: String(args.ssh_user ?? process.env.COMMANDER_SSH_USER ?? os.userInfo().username),
    identityFile: String(args.ssh_key ?? process.env.COMMANDER_SSH_KEY ?? path.join(os.homedir(), '.ssh', 'id_rsa')),
    connectTimeoutMs: Number(args.ssh_timeout ?? process.env.COMMANDER_SSH_CONNECT_TIMEOUT ?? 10000),
  };
}
