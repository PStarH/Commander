import { spawn } from 'child_process';
import { execSync } from 'child_process';
import type { ExecutionBackend, DockerExecConfig, SandboxExecutionResult } from '../types';

/**
 * Docker exec backend — executes commands inside running Docker containers
 * using the `docker exec` CLI. Supports user, workdir, and full environment control.
 */
export class DockerExecBackend implements ExecutionBackend {
  readonly type = 'docker_exec' as const;
  private config: DockerExecConfig;
  private _available: boolean;

  constructor(config: DockerExecConfig) {
    this.config = config;
    this._available = false;
    try {
      execSync('docker info 2>/dev/null', { timeout: 5000 });
      this._available = true;
    } catch {
      this._available = false;
    }
  }

  get available(): boolean {
    return this._available;
  }

  async execute(
    command: string,
    workdir?: string,
    timeout?: number,
  ): Promise<SandboxExecutionResult> {
    const start = Date.now();
    const args: string[] = ['exec', '-i'];

    // Attach env from current process (filtered)
    for (const [k, v] of Object.entries(process.env)) {
      if (v && !k.startsWith('DOCKER_') && !k.startsWith('SSH_')) {
        args.push('-e', `${k}=${v}`);
      }
    }

    if (this.config.user) {
      args.push('-u', this.config.user);
    }

    const wd = workdir ?? this.config.workdir;
    if (wd) {
      args.push('-w', wd);
    }

    args.push(this.config.container, '/bin/sh', '-c', command);

    return new Promise((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (timeout ?? 60) * 1000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          durationMs: Date.now() - start,
          sandboxMechanism: 'docker',
        });
      });

      child.on('error', (err) => {
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: -1,
          durationMs: Date.now() - start,
          sandboxMechanism: 'docker',
        });
      });
    });
  }
}

// ============================================================================
// Docker Exec Config Resolution
// ============================================================================

/**
 * Resolve Docker exec configuration from tool arguments and environment.
 * 
 * Priority: explicit args > env vars
 */
export function resolveDockerExecConfig(args: Record<string, unknown>): DockerExecConfig | null {
  const container = String(args.container ?? args.container_id ?? process.env.COMMANDER_DOCKER_CONTAINER ?? '');
  if (!container) return null;

  return {
    container,
    workdir: String(args.workdir ?? process.env.COMMANDER_DOCKER_WORKDIR ?? ''),
    user: String(args.docker_user ?? process.env.COMMANDER_DOCKER_USER ?? ''),
  };
}
