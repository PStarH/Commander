import { execSync } from 'child_process';
import { getSandboxManager } from '../sandbox/manager';
import type { SandboxProfile } from '../sandbox/types';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  killed: boolean;
}

/**
 * Execute a command through the sandbox if available, falling back to execSync.
 * Returns structured result with stdout, stderr, exit code, and timing.
 */
export async function execSandboxed(
  command: string,
  timeoutSec: number,
  workdir?: string,
): Promise<ExecResult> {
  const sandbox = getSandboxManager();
  const start = Date.now();

  if (sandbox.hasSandbox()) {
    const profile: SandboxProfile = { ...sandbox.getProfile('workspace-write'), timeout: timeoutSec * 1000 };
    const result = await sandbox.execute(command, profile, workdir);
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      killed: false,
    };
  }

  try {
    const stdout = execSync(command, {
      timeout: timeoutSec * 1000,
      encoding: 'utf-8',
      cwd: workdir ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: stdout ?? '',
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - start,
      killed: false,
    };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
      durationMs: Date.now() - start,
      killed: !!err.killed,
    };
  }
}
