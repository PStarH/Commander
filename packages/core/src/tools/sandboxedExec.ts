import { getExecutionRouter } from '../sandbox/executionRouter';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  killed: boolean;
}

function formatResult(r: { stdout: string; stderr: string; exitCode: number; durationMs: number }): ExecResult {
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    killed: false,
  };
}

/**
 * Execute a command through the ExecutionRouter.
 * The router picks the right backend (local/ssh/docker_exec) based on args.
 *
 * @param command  Shell command to execute
 * @param timeoutSec  Timeout in seconds
 * @param workdir  Working directory
 * @param backendArgs  Tool call arguments for backend selection (backend, ssh_host, container, etc.)
 */
export async function execSandboxed(
  command: string,
  timeoutSec: number,
  workdir?: string,
  backendArgs?: Record<string, unknown>,
): Promise<ExecResult> {
  const router = getExecutionRouter();
  const args = { timeout: timeoutSec, ...backendArgs };
  const result = await router.execute(command, args, workdir);
  return formatResult(result);
}
