import { execSync } from 'child_process';
import type { ExecutionBackend, SandboxExecutionResult } from '../types';
import { getSandboxManager } from '../manager';

/**
 * Local execution backend — runs commands through the OS sandbox (Seatbelt/Bwrap/Docker)
 * or falls back to direct execSync.
 */
export class LocalBackend implements ExecutionBackend {
  readonly type = 'local' as const;
  readonly available = true;

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

    try {
      const stdout = execSync(command, {
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
